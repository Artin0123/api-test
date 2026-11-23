// src/proxy-state.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
// ─── in-isolate snapshot, cursor rotation & stateSeq ─────────────────────────

const SNAPSHOT_SOFT_TTL_MS = 10_000;
const SNAPSHOT_HARD_TTL_MS = 60_000;
const INCREMENTAL_OVERLAP_MS = 2_000;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

let _clock = () => Date.now();
let _random = () => Math.random();
let _logCleanupEvery = 50;

function nowMs() {
  return _clock();
}

function randFloat() {
  return _random();
}

function getLogCleanupEvery() {
  return _logCleanupEvery;
}

function proxyTestHooks() {
  return {
    setClock(fn) {
      _clock = typeof fn === "function" ? fn : () => Date.now();
    },
    resetClock() {
      _clock = () => Date.now();
    },
    setRandom(fn) {
      _random = typeof fn === "function" ? fn : () => Math.random();
    },
    resetRandom() {
      _random = () => Math.random();
    },
    setLogCleanupEvery(n) {
      _logCleanupEvery = Math.max(1, Number(n) || 50);
    },
    resetLogCleanupEvery() {
      _logCleanupEvery = 50;
    },
    getDbState(db) {
      return getDbState(db);
    },
    invalidateSnapshot(db) {
      invalidateSnapshot(db);
    },
  };
}

// D1 schema creation is memoized per binding object. Pages Functions have no
// startup hook, and a missing table must not block the first request — this also
// makes a freshly bound empty D1 usable without a separate init step.
const schemaReady = new WeakMap();

function isSchemaReady(db) {
  return schemaReady.get(db) === true;
}

function markSchemaReady(db) {
  schemaReady.set(db, true);
}

function ensureSchemaFor(db) {
  const cur = schemaReady.get(db);
  if (cur === true) return Promise.resolve();
  if (cur) return cur;
  const pending = ensureSchema(db)
    .then(() => {
      schemaReady.set(db, true);
    })
    .catch((err) => {
      // Do not memoize a transient failure: the next request should retry.
      schemaReady.delete(db);
      throw err;
    });
  schemaReady.set(db, pending);
  return pending;
}

const snapshotsByDb = new WeakMap();

function getDbState(db) {
  let st = snapshotsByDb.get(db);
  if (!st) {
    st = {
      epoch: 0,
      snapshot: null,
      inflight: null,
      stateSeq: nowMs(),
      logWriteCounter: 0,
      logFacets: null,
    };
    snapshotsByDb.set(db, st);
  }
  return st;
}

function bumpStateSeq(dbState) {
  const now = nowMs();
  dbState.stateSeq = Math.max(dbState.stateSeq + 1, now);
  return dbState.stateSeq;
}

function invalidateSnapshot(db) {
  if (!db) return;
  const st = getDbState(db);
  st.epoch += 1;
  st.snapshot = null;
  st.inflight = null;
  bumpStateSeq(st);
}

function parseStoreBatchRows(rows) {
  let rawSettings = null;
  let rawTestModels = null;
  for (const r of rows || []) {
    if (r.k === SETTINGS_KEY) rawSettings = parseJsonObject(r.v);
    else if (r.k === PROXY_TEST_MODELS_KEY) rawTestModels = parseJsonObject(r.v);
  }
  const settings = withSettingsDefaults(rawSettings);
  const testModels = {
    ...normalizeProxyTestModels(rawSettings?.proxy_test_models),
    ...normalizeProxyTestModels(rawTestModels),
  };
  return { rawSettings, settings, testModels };
}

async function buildSnapshotFromFullRows(
  db,
  prevSnapshot,
  settings,
  testModels,
  keyRows,
) {
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  const entries = await providerFpEntries(providers);

  // If `store('app_settings')` was populated out-of-band without syncing
  // `key_state`, sync once so every configured key has a stable integer id.
  const syncStmts = buildKeyStateSyncStmts(db, entries, keyRows, nowMs());
  let finalRows = keyRows;
  if (syncStmts.length) {
    await db.batch(syncStmts);
    const reloaded = await db
      .prepare(
        "SELECT id, fp, api_key, last_used_at, fail_count, disabled, updated_at " +
          "FROM key_state ORDER BY id ASC",
      )
      .all();
    finalRows = reloaded.results || [];
  }

  let maxUpdatedAt = 0;
  const rowsByFpKey = new Map();
  for (const row of finalRows) {
    const updatedAt = Number(row.updated_at) || 0;
    if (updatedAt > maxUpdatedAt) maxUpdatedAt = updatedAt;
    if (!rowsByFpKey.has(row.fp)) rowsByFpKey.set(row.fp, new Map());
    rowsByFpKey.get(row.fp).set(row.api_key, row);
  }

  const providersByAlias = new Map();
  const providersByFp = new Map();
  const providerList = [];

  for (const { provider: p, providerType, apiBase, fp } of entries) {
    const alias = typeof p.alias === "string" ? p.alias.trim() : "";
    let host = apiBase;
    try {
      host = new URL(apiBase).hostname;
    } catch {}
    const configuredKeys = providerKeys(p);
    const fpRows = rowsByFpKey.get(fp) || new Map();
    const prevFp = prevSnapshot ? prevSnapshot.providersByFp.get(fp) : null;

    const list = [];
    const byId = new Map();
    const byApiKey = new Map();

    for (const apiKey of configuredKeys) {
      const row = fpRows.get(apiKey);
      if (!row) continue;
      const id = Number(row.id);
      const prevEntry = prevFp ? prevFp.byId.get(id) : null;
      const rowUpdatedAt = Number(row.updated_at) || 0;
      const rowLastUsed =
        row.last_used_at == null ? null : Number(row.last_used_at);

      let lastUsedAt = rowLastUsed;
      if (prevEntry && prevEntry.lastUsedAt !== null) {
        lastUsedAt =
          lastUsedAt === null
            ? prevEntry.lastUsedAt
            : Math.max(lastUsedAt, prevEntry.lastUsedAt);
      }

      let failCount = Number(row.fail_count) || 0;
      let disabled = !!row.disabled;
      let localMutatedAt = 0;
      let lastWritten = rowLastUsed;

      if (prevEntry) {
        lastWritten = prevEntry.lastWritten;
        localMutatedAt = prevEntry.localMutatedAt;
        if (rowUpdatedAt < prevEntry.localMutatedAt) {
          failCount = prevEntry.failCount;
          disabled = prevEntry.disabled;
        }
      }

      const entry = {
        id,
        fp,
        apiKey,
        disabled,
        failCount,
        lastUsedAt,
        lastWritten,
        localMutatedAt,
      };
      list.push(entry);
      byId.set(id, entry);
      byApiKey.set(apiKey, entry);
    }

    let cursor = 0;
    if (list.length > 0) {
      if (prevFp && Number.isInteger(prevFp.cursor)) {
        cursor = prevFp.cursor % list.length;
      } else {
        cursor = Math.floor(randFloat() * list.length) % list.length;
      }
    }

    const fpState = { cursor, list, byId, byApiKey };
    providersByFp.set(fp, fpState);

    const meta = {
      fp,
      alias,
      host,
      apiBase: apiBase.replace(/\/+$/, ""),
      providerType,
      enabled: p.enabled !== false,
      models: providerModels(p),
      configuredKeys,
      extraBody: parseExtraBody(p),
      customHeaders: Array.isArray(p.custom_headers) ? p.custom_headers : [],
      testPath: typeof p.test_path === "string" ? p.test_path.trim() : "",
      provider: p,
    };
    providerList.push(meta);
    if (alias) {
      providersByAlias.set(alias, meta);
    }
  }

  const now = nowMs();
  return {
    loadedAt: now,
    settingsVersion: settingsVersion(settings),
    settings,
    testModels,
    keyStateSeen: maxUpdatedAt || now,
    providersByAlias,
    providersByFp,
    providerList,
  };
}

async function loadSnapshotCold(db, dbState, expectedEpoch = dbState.epoch) {
  const needDdl = !isSchemaReady(db);
  const stmts = [];
  if (needDdl) {
    for (const sql of D1_SCHEMA) stmts.push(db.prepare(sql));
  }
  const offset = stmts.length;
  stmts.push(
    db
      .prepare("SELECT k, v FROM store WHERE k IN (?, ?)")
      .bind(SETTINGS_KEY, PROXY_TEST_MODELS_KEY),
    db.prepare(
      "SELECT id, fp, api_key, last_used_at, fail_count, disabled, updated_at " +
        "FROM key_state ORDER BY id ASC",
    ),
  );
  const batchRes = await db.batch(stmts);
  if (needDdl) markSchemaReady(db);
  if (dbState.epoch !== expectedEpoch) {
    return triggerSnapshotRefresh(db, dbState, true);
  }

  const storeRows = batchRes[offset]?.results || [];
  const keyRows = batchRes[offset + 1]?.results || [];
  const { settings, testModels } = parseStoreBatchRows(storeRows);
  const next = await buildSnapshotFromFullRows(
    db,
    dbState.snapshot,
    settings,
    testModels,
    keyRows,
  );
  if (dbState.epoch !== expectedEpoch) {
    return triggerSnapshotRefresh(db, dbState, true);
  }
  dbState.snapshot = next;
  bumpStateSeq(dbState);
  return next;
}

async function refreshSnapshotIncremental(
  db,
  dbState,
  expectedEpoch = dbState.epoch,
) {
  const prev = dbState.snapshot;
  if (!prev) return loadSnapshotCold(db, dbState, expectedEpoch);

  const since = Math.max(0, prev.keyStateSeen - INCREMENTAL_OVERLAP_MS);
  const batchRes = await db.batch([
    db
      .prepare("SELECT k, v FROM store WHERE k IN (?, ?)")
      .bind(SETTINGS_KEY, PROXY_TEST_MODELS_KEY),
    db
      .prepare(
        "SELECT id, fp, api_key, last_used_at, fail_count, disabled, updated_at " +
          "FROM key_state WHERE updated_at >= ? ORDER BY id ASC",
      )
      .bind(since),
  ]);
  if (dbState.epoch !== expectedEpoch) {
    return triggerSnapshotRefresh(db, dbState, true);
  }

  const storeRows = batchRes[0]?.results || [];
  const deltaRows = batchRes[1]?.results || [];
  const { settings, testModels } = parseStoreBatchRows(storeRows);
  const nextVer = settingsVersion(settings);

  if (nextVer !== prev.settingsVersion) {
    const fullRowsRes = await db
      .prepare(
        "SELECT id, fp, api_key, last_used_at, fail_count, disabled, updated_at " +
          "FROM key_state ORDER BY id ASC",
      )
      .all();
    if (dbState.epoch !== expectedEpoch) {
      return triggerSnapshotRefresh(db, dbState, true);
    }
    const rebuilt = await buildSnapshotFromFullRows(
      db,
      prev,
      settings,
      testModels,
      fullRowsRes.results || [],
    );
    if (dbState.epoch !== expectedEpoch) {
      return triggerSnapshotRefresh(db, dbState, true);
    }
    dbState.snapshot = rebuilt;
    bumpStateSeq(dbState);
    return rebuilt;
  }

  let changed = false;
  if (!deepEqual(prev.testModels, testModels)) {
    prev.testModels = testModels;
    changed = true;
  }

  let maxUpdatedAt = prev.keyStateSeen;
  for (const row of deltaRows) {
    const rowUpdatedAt = Number(row.updated_at) || 0;
    if (rowUpdatedAt > maxUpdatedAt) maxUpdatedAt = rowUpdatedAt;
    const fpState = prev.providersByFp.get(row.fp);
    if (!fpState) continue;
    const id = Number(row.id);
    const entry = fpState.byId.get(id);
    if (!entry) continue;

    const rowLastUsed =
      row.last_used_at == null ? null : Number(row.last_used_at);
    if (
      rowLastUsed !== null &&
      (entry.lastUsedAt === null || rowLastUsed > entry.lastUsedAt)
    ) {
      entry.lastUsedAt = rowLastUsed;
      changed = true;
    }

    if (rowUpdatedAt >= entry.localMutatedAt) {
      const nextFail = Number(row.fail_count) || 0;
      const nextDisabled = !!row.disabled;
      if (entry.failCount !== nextFail || entry.disabled !== nextDisabled) {
        entry.failCount = nextFail;
        entry.disabled = nextDisabled;
        changed = true;
      }
    }
  }

  prev.keyStateSeen = maxUpdatedAt;
  prev.loadedAt = nowMs();
  if (changed) bumpStateSeq(dbState);
  return prev;
}

function triggerSnapshotRefresh(db, dbState, forceFull) {
  if (dbState.inflight) return dbState.inflight;
  const startEpoch = dbState.epoch;
  const task = (
    forceFull || !dbState.snapshot
      ? loadSnapshotCold(db, dbState, startEpoch)
      : refreshSnapshotIncremental(db, dbState, startEpoch)
  ).finally(() => {
    if (dbState.inflight === task) {
      dbState.inflight = null;
    }
  });
  dbState.inflight = task;
  return task;
}

async function getSnapshot(env, ctx) {
  const db = env.DB;
  const dbState = getDbState(db);
  if (!dbState.snapshot) {
    return await triggerSnapshotRefresh(db, dbState, true);
  }
  const age = nowMs() - dbState.snapshot.loadedAt;
  if (age < SNAPSHOT_SOFT_TTL_MS) {
    return dbState.snapshot;
  }
  if (age < SNAPSHOT_HARD_TTL_MS) {
    if (!dbState.inflight) {
      runInBackground(ctx, triggerSnapshotRefresh(db, dbState, false));
    }
    return dbState.snapshot;
  }
  return await triggerSnapshotRefresh(db, dbState, false);
}

/** Pick the next available key in O(N) memory using per-provider cursor
 *  rotation. Stamps `lastUsedAt` in memory and advances `stateSeq` for
 *  external `/proxy/:alias/*` traffic only. */
function pickKeyFromSnapshot(dbState, fp, triedIds) {
  const fpState = dbState.snapshot?.providersByFp.get(fp);
  if (!fpState || !fpState.list.length) return null;
  const list = fpState.list;
  const n = list.length;
  for (let offset = 0; offset < n; offset++) {
    const idx = (fpState.cursor + offset) % n;
    const entry = list[idx];
    if (entry.disabled || triedIds.has(entry.id)) continue;
    fpState.cursor = (idx + 1) % n;
    entry.lastUsedAt = nowMs();
    bumpStateSeq(dbState);
    return entry;
  }
  return null;
}

/** Apply an upstream failure in memory and return a D1 statement builder if the
 *  key row needs to be updated in the background `flushWrites` batch. */
function stageProxyKeyFailure(db, dbState, entry, threshold, includeLastUsed) {
  const now = nowMs();
  if (!entry.disabled && entry.failCount < threshold) {
    entry.failCount = Math.min(threshold, entry.failCount + 1);
    if (entry.failCount >= threshold) entry.disabled = true;
    entry.localMutatedAt = now;
    bumpStateSeq(dbState);
    if (includeLastUsed && entry.lastUsedAt !== null) {
      entry.lastWritten = entry.lastUsedAt;
      const usedAt = entry.lastUsedAt;
      return () =>
        db
          .prepare(
            "UPDATE key_state " +
              "SET last_used_at = MAX(COALESCE(last_used_at, 0), ?), " +
              "    fail_count = MIN(?, fail_count + 1), " +
              "    disabled = CASE WHEN fail_count + 1 >= ? THEN 1 ELSE disabled END, " +
              "    updated_at = ? " +
              "WHERE id = ? AND disabled = 0 AND fail_count < ?",
          )
          .bind(usedAt, threshold, threshold, now, entry.id, threshold);
    }
    return () =>
      db
        .prepare(
          "UPDATE key_state " +
            "SET fail_count = MIN(?, fail_count + 1), " +
            "    disabled = CASE WHEN fail_count + 1 >= ? THEN 1 ELSE disabled END, " +
            "    updated_at = ? " +
            "WHERE id = ? AND disabled = 0 AND fail_count < ?",
        )
        .bind(threshold, threshold, now, entry.id, threshold);
  }
  return null;
}

/** Apply an upstream 2xx in memory and return a D1 statement builder only when
 *  `fail_count`/`disabled` must be cleared or the 60s `last_used_at` write
 *  throttle has elapsed. */
function stageProxyKeySuccess(db, dbState, entry) {
  const now = nowMs();
  const hadFail = !entry.disabled && entry.failCount > 0;
  if (hadFail) {
    entry.failCount = 0;
    entry.localMutatedAt = now;
    bumpStateSeq(dbState);
  }
  const usedAt = entry.lastUsedAt ?? now;
  const needLastUsedWrite =
    entry.lastWritten === null ||
    now - entry.lastWritten >= LAST_USED_WRITE_INTERVAL_MS;
  if (!hadFail && !needLastUsedWrite) return null;

  entry.lastWritten = usedAt;
  return () =>
    db
      .prepare(
        "UPDATE key_state " +
          "SET last_used_at = MAX(COALESCE(last_used_at, 0), ?), " +
          "    fail_count = CASE WHEN disabled = 0 THEN 0 ELSE fail_count END, " +
          "    updated_at = ? " +
          "WHERE id = ?",
      )
      .bind(usedAt, now, entry.id);
}
