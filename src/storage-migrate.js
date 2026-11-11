// src/storage-migrate.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
// ─── /api/storage/* (migration + backup) ───────────────────────────────────
// These endpoints deliberately work even when STORAGE_BACKEND points at a
// backend that is not usable yet: export only needs KV, and that is exactly the
// backup an operator needs before touching anything.

// Shared by export and restore: a backup that cannot be restored is worse than no
// backup, so both ends use the same ceiling instead of export silently producing a
// 20001-entry file that restore then rejects.
const STORAGE_MAX_ENTRIES = 20000;

function jsonPrivate(data, status = 200) {  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function storageSource(env, name) {
  const wanted = name === "current" ? storageBackendName(env) : name;
  if (name === "current" && wanted === "d1" && !hasD1(env) && hasKv(env)) {
    // A backup must still be possible when the configured backend is unusable;
    // KV is the only source left in that state.
    return { name: "kv", source: env.KV_STORE };
  }
  if (wanted === "kv") {
    if (!hasKv(env)) return null;
    return { name: "kv", source: env.KV_STORE };
  }
  if (wanted === "d1") {
    if (!hasD1(env)) return null;
    return { name: "d1", source: d1Store(env) };
  }
  return null;
}

async function handleStorageExport(request, env, url) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }  const requested = (url.searchParams.get("source") || "current").trim();
  const picked = storageSource(env, requested);
  if (!picked) {
    return jsonPrivate(
      { error: `source=${requested} 无法使用（绑定不存在或名称无效）` },
      400,
    );
  }

  const { entries, pages } = await listAllEntries(picked.source);

  // Keep the two sides symmetric: restore refuses more than 20000 entries, so an
  // export bigger than that would be a backup that can never be restored. Fail
  // here, where the operator can still act, instead of at restore time.
  if (entries.length > STORAGE_MAX_ENTRIES) {
    return jsonPrivate(
      {
        error:
          `资料过多：${entries.length} 笔（上限 ${STORAGE_MAX_ENTRIES}）；` +
          "这份备份无法被 /api/storage/restore 还原，请先清理数据或分批导出",
        entry_count: entries.length,
        limit: STORAGE_MAX_ENTRIES,
      },
      400,
    );
  }

  let keyState = [];
  if (hasD1(env)) {
    await ensureSchemaFor(env.DB);
    const result = await env.DB.prepare(
      "SELECT id, fp, api_key, last_used_at, fail_count, disabled, updated_at " +
        "FROM key_state ORDER BY id",
    ).all();
    keyState = result.results || [];
  }

  const bytes = entries.reduce((sum, e) => sum + e.k.length + e.v.length, 0);
  return jsonPrivate({
    ok: true,
    exported_at: new Date().toISOString(),
    source: picked.name,
    backend_setting: storageBackendName(env),
    kv_pages: pages,
    entry_count: entries.length,
    bytes,
    key_state_count: keyState.length,
    entries,
    key_state: keyState,
  });
}

async function seedKeyStateFromProviders(db, providers, now) {
  let inserted = 0;
  for (const p of providers || []) {
    if (
      !p ||
      typeof p.provider_type !== "string" ||
      typeof p.api_base !== "string"
    ) {
      continue;
    }
    const providerType = p.provider_type.trim();
    const apiBase = p.api_base.trim();
    if (!providerType || !apiBase) continue;
    const fp = await providerFingerprint(providerType, apiBase);
    for (const apiKey of providerKeys(p)) {
      const result = await db
        .prepare(
          "INSERT INTO key_state (fp, api_key, last_used_at, fail_count, disabled, updated_at) " +
            "VALUES (?, ?, NULL, 0, 0, ?) ON CONFLICT(fp, api_key) DO NOTHING",
        )
        .bind(fp, apiKey, now)
        .run();
      inserted += Number(result?.meta?.changes || 0);
    }
  }
  return inserted;
}

async function handleStorageMigrate(request, env) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  let body = {};
  try {
    body = await request.json();
  } catch {}
  if (body.confirm !== "migrate") {
    return json(
      { error: 'confirmation required: send {"confirm":"migrate"}' },
      400,
    );
  }
  if (!hasKv(env)) return json({ error: "KV_STORE binding required" }, 400);
  if (!hasD1(env)) return json({ error: "DB (D1) binding required" }, 400);

  const { entries, pages } = await listAllEntries(env.KV_STORE);
  const settingsEntry = entries.find((e) => e.k === SETTINGS_KEY);
  const settings = settingsEntry ? parseJsonObject(settingsEntry.v) : null;
  const providers = Array.isArray(settings?.providers) ? settings.providers : [];
  const keyCount = providers.reduce(
    (sum, p) => sum + providerKeys(p).length,
    0,
  );

  if (body.dryRun) {
    return json({
      ok: true,
      dry_run: true,
      kv_pages: pages,
      entries: entries.length,
      key_state_rows_to_seed: keyCount,
      providers: providers.length,
    });
  }

  await ensureSchemaFor(env.DB);
  let inserted = 0;
  let skipped = 0;
  for (const entry of entries) {
    const result = await env.DB.prepare(
      "INSERT INTO store (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING",
    )
      .bind(entry.k, entry.v)
      .run();
    const changes = Number(result?.meta?.changes || 0);
    if (changes > 0) inserted++;
    else skipped++;
  }
  const seeded = await seedKeyStateFromProviders(env.DB, providers, Date.now());

  return json({
    ok: true,
    kv_pages: pages,
    entries: entries.length,
    store_inserted: inserted,
    store_skipped_existing: skipped,
    key_state_seeded: seeded,
    providers: providers.length,
    keys: keyCount,
    migrated_at: new Date().toISOString(),
  });
}

async function handleStorageRestore(request, env) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!hasD1(env)) {
    return json({ error: "Restore requires the DB (D1) binding" }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (body.confirm !== "restore") {
    return json(
      { error: 'confirmation required: send {"confirm":"restore"}' },
      400,
    );
  }
  const entries = Array.isArray(body.entries) ? body.entries : null;
  if (!entries) return json({ error: "entries must be an array" }, 400);
  if (entries.length > STORAGE_MAX_ENTRIES) {
    return json({ error: "entries too large (max 20000)" }, 400);
  }
  for (const e of entries) {
    if (!e || typeof e.k !== "string" || !e.k || typeof e.v !== "string") {
      return json({ error: "each entry needs string k and v" }, 400);
    }
  }

  await ensureSchemaFor(env.DB);
  let restored = 0;
  for (const e of entries) {
    await env.DB.prepare(
      "INSERT INTO store (k, v) VALUES (?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    )
      .bind(e.k, e.v)
      .run();
    restored++;
  }

  let keyState = 0;
  const rows = Array.isArray(body.key_state) ? body.key_state : [];
  for (const row of rows) {
    if (!row || typeof row.fp !== "string" || typeof row.api_key !== "string") {
      continue;
    }
    await env.DB.prepare(
      "INSERT INTO key_state (fp, api_key, last_used_at, fail_count, disabled, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(fp, api_key) DO UPDATE SET " +
        "last_used_at = excluded.last_used_at, " +
        "fail_count = excluded.fail_count, " +
        "disabled = excluded.disabled, " +
        "updated_at = excluded.updated_at",
    )
      .bind(
        row.fp,
        row.api_key,
        row.last_used_at ?? null,
        Number(row.fail_count || 0),
        row.disabled ? 1 : 0,
        Number(row.updated_at || Date.now()),
      )
      .run();
    keyState++;
  }

  // Precise rollback: the backup defines the whole state, so anything that is not
  // in it is removed. Deletes run *after* the upserts on purpose — a failure in
  // the middle leaves a superset (safe) instead of a half-restored database.
  const keepStore = new Set(entries.map((e) => e.k));
  const existingStore = await env.DB.prepare("SELECT k FROM store").all();
  const staleStore = (existingStore.results || [])
    .map((r) => r.k)
    .filter((k) => !keepStore.has(k));
  for (let i = 0; i < staleStore.length; i += D1_IN_CHUNK_SIZE) {
    const chunk = staleStore.slice(i, i + D1_IN_CHUNK_SIZE);
    await env.DB.prepare(
      `DELETE FROM store WHERE k IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .run();
  }

  const identity = (fp, apiKey) => `${fp}\u0000${apiKey}`;
  const keepKeys = new Set(
    rows
      .filter((r) => r && typeof r.fp === "string" && typeof r.api_key === "string")
      .map((r) => identity(r.fp, r.api_key)),
  );
  const existingKeys = await env.DB.prepare(
    "SELECT id, fp, api_key FROM key_state",
  ).all();
  const staleKeys = (existingKeys.results || [])
    .filter((r) => !keepKeys.has(identity(r.fp, r.api_key)))
    .map((r) => r.id);
  for (let i = 0; i < staleKeys.length; i += D1_IN_CHUNK_SIZE) {
    const chunk = staleKeys.slice(i, i + D1_IN_CHUNK_SIZE);
    await env.DB.prepare(
      `DELETE FROM key_state WHERE id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .run();
  }

  return json({
    ok: true,
    store_restored: restored,
    key_state_restored: keyState,
    store_removed: staleStore.length,
    key_state_removed: staleKeys.length,
    restored_at: new Date().toISOString(),
  });
}
