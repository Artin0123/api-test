// src/proxy-handlers.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
async function handleGetProxyState(request, env, url, ctx) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const blocked = rejectIfProxyDisabled(env);
  if (blocked) return blocked;

  const snapshot = await getSnapshot(env, ctx);
  const dbState = getDbState(env.DB);

  const sinceRaw = url.searchParams.get("since_seq");
  if (sinceRaw !== null && sinceRaw !== "") {
    const sinceSeq = Number(sinceRaw);
    if (Number.isFinite(sinceSeq) && sinceSeq === dbState.stateSeq) {
      return json({
        ok: true,
        unchanged: true,
        state_seq: dbState.stateSeq,
      });
    }
  }

  const backend = storageBackendName(env);
  const configError = proxyConfigError(env, snapshot.settings);
  const list = [];

  for (const meta of snapshot.providerList) {
    if (!meta.alias) continue;
    const fpState = snapshot.providersByFp.get(meta.fp);
    const keys = meta.configuredKeys.map((apiKey) => {
      const entry = fpState ? fpState.byApiKey.get(apiKey) : null;
      return {
        id: entry ? entry.id : null,
        masked: maskKey(apiKey),
        disabled: entry ? !!entry.disabled : false,
        fail_count: entry ? entry.failCount : 0,
        last_used_at: entry ? entry.lastUsedAt : null,
        synced: !!entry,
      };
    });

    list.push({
      fp: meta.fp,
      alias: meta.alias,
      host: meta.host,
      provider_type: meta.providerType,
      enabled: meta.enabled,
      proxy_url: `/proxy/${meta.alias}`,
      test_model:
        typeof snapshot.testModels[meta.fp] === "string"
          ? snapshot.testModels[meta.fp]
          : "",
      // The proxy toolbar offers these as the probe-model menu. Keeping the
      // whole list (not just the first entry) is what lets 来源设定 stay the one
      // place where a provider's models are typed.
      models: meta.models,
      keys_total: keys.length,
      keys_available: keys.filter((k) => !k.disabled).length,
      keys,
    });
  }

  return json({
    ok: true,
    backend,
    state_seq: dbState.stateSeq,
    proxy_enabled: !configError,
    proxy_message: configError || "",
    providers: list,
  });
}

// ─── /api/proxy/test & /api/proxy/test-commit ──────────────────────────────

/** Minimal single-key non-streaming probe ("only reply 1.", max 8 tokens).
 *  Failed probes increment fail_count (possibly disabling the key); a
 *  successful probe resets fail_count = 0 and clears disabled = 0 immediately.
 *  Manual/batch probes NEVER touch `last_used_at` and NEVER write `proxy_logs`. */
function testRequestFor(provider, model) {
  if (!model) return null;
  let req;
  const customPath =
    typeof provider.test_path === "string" ? provider.test_path.trim() : "";
  switch (provider.provider_type) {
    case "google":
      req = {
        model,
        path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        body: {
          contents: [{ parts: [{ text: "only reply 1." }] }],
          generationConfig: { maxOutputTokens: 8 },
        },
      };
      break;
    case "anthropic": {
      if (!customPath) return null;
      const normalized = customPath.startsWith("/")
        ? customPath
        : "/" + customPath;
      req = {
        model,
        path: normalized.replace(/\{model\}/g, encodeURIComponent(model)),
        body: {
          model,
          max_tokens: 8,
          stream: false,
          messages: [{ role: "user", content: "only reply 1." }],
        },
      };
      break;
    }
    case "openai":
    default: {
      if (!customPath) return null;
      const normalized = customPath.startsWith("/")
        ? customPath
        : "/" + customPath;
      req = {
        model,
        path: normalized.replace(/\{model\}/g, encodeURIComponent(model)),
        body: {
          model,
          messages: [{ role: "user", content: "only reply 1." }],
          max_tokens: 8,
          stream: false,
        },
      };
      break;
    }
  }
  const extra = parseExtraBody(provider);
  if (extra) {
    req.body = { ...req.body, ...extra };
  }
  return req;
}

function proxyProviderActionError(meta) {
  if (!meta) return json({ error: "Not Found" }, 404);
  if (!meta.alias) {
    return json(
      {
        error: "请先在「来源设定」填写转发别名 (alias)，才能操作代理密钥",
      },
      400,
    );
  }
  return null;
}

async function handleProxyTest(request, env, _url, ctx) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const blocked = rejectIfProxyDisabled(env);
  if (blocked) return blocked;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const id = Number(body.id);
  const fp = typeof body.fp === "string" ? body.fp.trim() : "";
  const deferWrite = body.defer_write === true;
  if (!Number.isInteger(id) || !fp) {
    return json({ error: "id and fp required" }, 400);
  }

  const snapshot = await getSnapshot(env, ctx);
  const settings = snapshot.settings;
  const configError = proxyConfigError(env, settings);
  if (configError) return json({ error: configError }, 503);

  const meta = snapshot.providerList.find((m) => m.fp === fp) || null;
  const providerErr = proxyProviderActionError(meta);
  if (providerErr) return providerErr;

  const fpState = snapshot.providersByFp.get(fp);
  const entry = fpState ? fpState.byId.get(id) : null;
  if (!entry) return json({ error: "Not Found" }, 404);

  const requestedModel =
    typeof body.model === "string" ? body.model.trim() : "";
  const savedModel =
    typeof snapshot.testModels[fp] === "string"
      ? snapshot.testModels[fp].trim()
      : "";
  const testModel = requestedModel || savedModel;
  if (!testModel) {
    return json({ error: "尚未设定测试模型" }, 400);
  }

  if (meta.providerType !== "google" && !meta.testPath) {
    return json({ error: "请先在「来源设定」填写测试路径" }, 400);
  }
  const probe = testRequestFor(meta.provider, testModel);
  if (!probe) return json({ error: "无效的测试模型设定" }, 400);

  const db = env.DB;
  const dbState = getDbState(db);

  // Direct API callers that pass a new `model` without calling `/api/proxy/test-model`
  // still persist the standalone `proxy_test_models` map atomically via SQLite JSON1
  // (never touching `app_settings` and never clobbering concurrent provider edits).
  let modelSaveStmt = null;
  if (!deferWrite && requestedModel && requestedModel !== savedModel) {
    snapshot.testModels = { ...snapshot.testModels, [fp]: requestedModel };
    bumpStateSeq(dbState);
    modelSaveStmt = buildTestModelUpsertStmt(db, fp, requestedModel);
  }

  const headers = buildForwardHeaders(
    meta.providerType,
    meta.customHeaders,
    entry.apiKey,
    new Headers({ "Content-Type": "application/json" }),
  );
  headers.set("Content-Type", "application/json");

  const target = buildDirectUpstreamUrl(meta.apiBase, probe.path, "");
  const probeTimeoutMs = Math.min(proxyTimeoutMs(settings), 19000);
  const threshold = proxyFailThreshold(settings);

  const applyProbeOutcome = async (ok) => {
    if (deferWrite) {
      if (modelSaveStmt) {
        try {
          await db.batch([modelSaveStmt]);
        } catch (dbErr) {
          console.error("proxy_test_models write failed", dbErr);
        }
      }
      if (ok) {
        return { fail_count: 0, disabled: false };
      }
      if (!entry.disabled && entry.failCount < threshold) {
        const nextFail = Math.min(threshold, entry.failCount + 1);
        return { fail_count: nextFail, disabled: nextFail >= threshold };
      }
      return { fail_count: entry.failCount, disabled: entry.disabled };
    }

    const now = nowMs();
    const stmts = [];
    if (modelSaveStmt) stmts.push(modelSaveStmt);

    if (ok) {
      const wasDirty = entry.disabled || entry.failCount !== 0;
      if (wasDirty) {
        entry.failCount = 0;
        entry.disabled = false;
        entry.localMutatedAt = now;
        bumpStateSeq(dbState);
        stmts.push(
          db
            .prepare(
              "UPDATE key_state SET fail_count = 0, disabled = 0, updated_at = ? WHERE id = ?",
            )
            .bind(now, entry.id),
        );
      }
    } else if (!entry.disabled && entry.failCount < threshold) {
      entry.failCount = Math.min(threshold, entry.failCount + 1);
      if (entry.failCount >= threshold) entry.disabled = true;
      entry.localMutatedAt = now;
      bumpStateSeq(dbState);
      stmts.push(
        db
          .prepare(
            "UPDATE key_state " +
              "SET fail_count = MIN(?, fail_count + 1), " +
              "    disabled = CASE WHEN fail_count + 1 >= ? THEN 1 ELSE disabled END, " +
              "    updated_at = ? " +
              "WHERE id = ? AND disabled = 0 AND fail_count < ?",
          )
          .bind(threshold, threshold, now, entry.id, threshold),
      );
    }

    if (stmts.length) {
      try {
        await db.batch(stmts);
      } catch (dbErr) {
        console.error("key_state probe write failed", dbErr);
      }
    }
    return { fail_count: entry.failCount, disabled: entry.disabled };
  };

  const started = nowMs();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    let response;
    try {
      response = await fetch(target, {
        method: "POST",
        headers,
        body: JSON.stringify(probe.body),
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const ms = nowMs() - started;
    let detail = "";
    if (!response.ok) {
      const rawErr = await response.text();
      detail =
        summarizeErrorText(rawErr, [entry.apiKey]) ||
        `HTTP ${response.status}`;
    } else if (response.body) {
      await response.body.cancel();
    }
    const ledger = await applyProbeOutcome(response.ok);
    return json({
      ok: response.ok,
      status: response.status,
      ms,
      model: probe.model,
      error: detail || undefined,
      fail_count: ledger.fail_count,
      disabled: ledger.disabled,
      ...(deferWrite ? { deferred: true } : {}),
    });
  } catch (err) {
    const ledger = await applyProbeOutcome(false);
    const timedOut = err && err.name === "AbortError";
    const errText = timedOut
      ? `请求超时（${Math.round(probeTimeoutMs / 1000)} 秒）`
      : scrubSecrets(String((err && err.message) || err), [entry.apiKey]).slice(
          0,
          ERROR_SUMMARY_MAX_CHARS,
        );
    return json({
      ok: false,
      status: timedOut ? 499 : 502,
      ms: nowMs() - started,
      model: probe.model,
      error: errText,
      fail_count: ledger.fail_count,
      disabled: ledger.disabled,
      ...(deferWrite ? { deferred: true } : {}),
    });
  }
}

/** Persist deferred batch-probe results in a single `db.batch` after the
 *  frontend finishes running concurrent `defer_write: true` probes. */
async function handleProxyTestCommit(request, env, _url, ctx) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const blocked = rejectIfProxyDisabled(env);
  if (blocked) return blocked;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const fp = typeof body.fp === "string" ? body.fp.trim() : "";
  if (!fp || !Array.isArray(body.results)) {
    return json({ error: "fp and results[] required" }, 400);
  }

  const snapshot = await getSnapshot(env, ctx);
  const meta = snapshot.providerList.find((m) => m.fp === fp) || null;
  const providerErr = proxyProviderActionError(meta);
  if (providerErr) return providerErr;

  const fpState = snapshot.providersByFp.get(fp);
  const threshold = proxyFailThreshold(snapshot.settings);
  const okIds = [];
  const failIds = [];
  const seen = new Set();

  for (const item of body.results) {
    const id = Number(item?.id);
    if (!Number.isInteger(id) || seen.has(id)) continue;
    if (fpState && !fpState.byId.has(id)) continue;
    seen.add(id);
    if (item?.ok === true) okIds.push(id);
    else if (item?.ok === false) failIds.push(id);
  }

  const db = env.DB;
  const dbState = getDbState(db);
  await ensureSchemaFor(db);
  const now = nowMs();
  const stmts = [];
  let stateChanged = false;

  if (fpState) {
    for (const id of okIds) {
      const entry = fpState.byId.get(id);
      if (entry && (entry.disabled || entry.failCount !== 0)) {
        entry.failCount = 0;
        entry.disabled = false;
        entry.localMutatedAt = now;
        stateChanged = true;
      }
    }
    for (const id of failIds) {
      const entry = fpState.byId.get(id);
      if (entry && !entry.disabled && entry.failCount < threshold) {
        entry.failCount = Math.min(threshold, entry.failCount + 1);
        if (entry.failCount >= threshold) entry.disabled = true;
        entry.localMutatedAt = now;
        stateChanged = true;
      }
    }
  }
  if (stateChanged) {
    bumpStateSeq(dbState);
  }

  for (let i = 0; i < okIds.length; i += D1_IN_CHUNK_SIZE) {
    const chunk = okIds.slice(i, i + D1_IN_CHUNK_SIZE);
    stmts.push(
      db
        .prepare(
          "UPDATE key_state SET fail_count = 0, disabled = 0, updated_at = ? " +
            "WHERE fp = ? AND (disabled <> 0 OR fail_count <> 0) " +
            `AND id IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(now, fp, ...chunk),
    );
  }

  for (let i = 0; i < failIds.length; i += D1_IN_CHUNK_SIZE) {
    const chunk = failIds.slice(i, i + D1_IN_CHUNK_SIZE);
    stmts.push(
      db
        .prepare(
          "UPDATE key_state " +
            "SET fail_count = MIN(?, fail_count + 1), " +
            "    disabled = CASE WHEN fail_count + 1 >= ? THEN 1 ELSE disabled END, " +
            "    updated_at = ? " +
            "WHERE fp = ? AND disabled = 0 AND fail_count < ? " +
            `AND id IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(threshold, threshold, now, fp, threshold, ...chunk),
    );
  }

  if (stmts.length) {
    await db.batch(stmts);
  }

  return json({
    ok: true,
    committed: okIds.length + failIds.length,
  });
}

// ─── /api/proxy/recover ────────────────────────────────────────────────────

async function handleProxyRecover(request, env, _url, ctx) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const blocked = rejectIfProxyDisabled(env);
  if (blocked) return blocked;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const fp = typeof body.fp === "string" ? body.fp.trim() : "";
  const snapshot = await getSnapshot(env, ctx);
  const db = env.DB;
  const dbState = getDbState(db);

  if (body.all === true) {
    if (!fp) {
      return json({ error: "fp required" }, 400);
    }
    const meta = snapshot.providerList.find((m) => m.fp === fp) || null;
    const providerErr = proxyProviderActionError(meta);
    if (providerErr) return providerErr;

    const now = nowMs();
    const result = await db
      .prepare(
        "UPDATE key_state SET disabled = 0, fail_count = 0, updated_at = ? " +
          "WHERE fp = ? AND disabled = 1 RETURNING id",
      )
      .bind(now, fp)
      .all();
    const ids = (result.results || []).map((r) => r.id);
    const fpState = snapshot.providersByFp.get(fp);
    if (fpState && ids.length) {
      for (const recoveredId of ids) {
        const entry = fpState.byId.get(Number(recoveredId));
        if (entry) {
          entry.disabled = false;
          entry.failCount = 0;
          entry.localMutatedAt = now;
        }
      }
      bumpStateSeq(dbState);
    }
    return json({
      ok: true,
      recovered: ids.length,
      ids,
    });
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || !fp) {
    return json({ error: "id and fp required" }, 400);
  }
  const meta = snapshot.providerList.find((m) => m.fp === fp) || null;
  const providerErr = proxyProviderActionError(meta);
  if (providerErr) return providerErr;

  const now = nowMs();
  const result = await db
    .prepare(
      "UPDATE key_state SET disabled = 0, fail_count = 0, updated_at = ? " +
        "WHERE id = ? AND fp = ? RETURNING id, fail_count, disabled, last_used_at",
    )
    .bind(now, id, fp)
    .all();
  const row = (result.results || [])[0];
  if (!row) return json({ error: "Not Found" }, 404);

  const fpState = snapshot.providersByFp.get(fp);
  const entry = fpState ? fpState.byId.get(id) : null;
  if (entry) {
    entry.disabled = false;
    entry.failCount = 0;
    entry.localMutatedAt = now;
    bumpStateSeq(dbState);
  }

  return json({
    ok: true,
    key: {
      id: row.id,
      fail_count: row.fail_count,
      disabled: !!row.disabled,
      last_used_at: entry ? entry.lastUsedAt : row.last_used_at,
    },
  });
}

// ─── /api/proxy/disable ────────────────────────────────────────────────────

async function handleProxyDisable(request, env, _url, ctx) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const blocked = rejectIfProxyDisabled(env);
  if (blocked) return blocked;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const fp = typeof body.fp === "string" ? body.fp.trim() : "";
  const id = Number(body.id);
  if (!Number.isInteger(id) || !fp) {
    return json({ error: "id and fp required" }, 400);
  }

  const snapshot = await getSnapshot(env, ctx);
  const meta = snapshot.providerList.find((m) => m.fp === fp) || null;
  const providerErr = proxyProviderActionError(meta);
  if (providerErr) return providerErr;

  const db = env.DB;
  const dbState = getDbState(db);
  const now = nowMs();
  const result = await db
    .prepare(
      "UPDATE key_state SET disabled = 1, updated_at = ? " +
        "WHERE id = ? AND fp = ? RETURNING id, fail_count, disabled, last_used_at",
    )
    .bind(now, id, fp)
    .all();
  const row = (result.results || [])[0];
  if (!row) return json({ error: "Not Found" }, 404);

  const fpState = snapshot.providersByFp.get(fp);
  const entry = fpState ? fpState.byId.get(id) : null;
  if (entry) {
    entry.disabled = true;
    entry.localMutatedAt = now;
    bumpStateSeq(dbState);
  }

  return json({
    ok: true,
    key: {
      id: row.id,
      fail_count: row.fail_count,
      disabled: !!row.disabled,
      last_used_at: entry ? entry.lastUsedAt : row.last_used_at,
    },
  });
}

// ─── /api/proxy/test-model ─────────────────────────────────────────────────
function buildTestModelUpsertStmt(db, fp, model) {
  const jsonPath = `$.${fp}`;
  if (model) {
    return db
      .prepare(
        "INSERT INTO store (k, v) VALUES (?, json_object(?, ?)) " +
          "ON CONFLICT(k) DO UPDATE SET v = CASE " +
          "WHEN json_valid(store.v) THEN json_set(store.v, ?, ?) " +
          "ELSE json_object(?, ?) END",
      )
      .bind(PROXY_TEST_MODELS_KEY, fp, model, jsonPath, model, fp, model);
  }
  return db
    .prepare(
      "UPDATE store SET v = json_remove(v, ?) WHERE k = ? AND json_valid(v)",
    )
    .bind(jsonPath, PROXY_TEST_MODELS_KEY);
}

// Stores which model each provider should probe with, keyed by fingerprint, in
// its own `store('proxy_test_models')` entry so changing the probe model never
// increments `app_settings.version` or causes 409 conflicts with 来源设定.
async function handleProxyTestModel(request, env, _url, ctx) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const blocked = rejectIfProxyDisabled(env);
  if (blocked) return blocked;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const fp = typeof body.fp === "string" ? body.fp.trim() : "";
  if (!fp) return json({ error: "fp required" }, 400);

  const snapshot = await getSnapshot(env, ctx);
  if (!snapshot.providersByFp.has(fp)) {
    return json({ error: "Not Found" }, 404);
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  await buildTestModelUpsertStmt(env.DB, fp, model).run();

  const nextMap = { ...snapshot.testModels };
  if (model) nextMap[fp] = model;
  else delete nextMap[fp];
  snapshot.testModels = nextMap;
  bumpStateSeq(getDbState(env.DB));
  return json({ ok: true, test_model: model });
}
