// src/settings-handlers.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
async function handleGetSettings(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);
  const kv = store(env);
  const raw = await kv.get(SETTINGS_KEY);
  const settings = withSettingsDefaults(parseJsonOrNull(raw));
  delete settings.ai_gateway_logs_url;
  delete settings.ai_gateway_token;
  settings.version = settingsVersion(settings);
  return json({
    ok: true,
    settings,
    storage_backend: storageBackendName(env),
  });
}

async function handlePostSettings(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Full-replace: accept the entire settings object from client.
  // Validate top-level shape only; provider internals are trusted from authenticated clients.
  if (body.providers !== undefined && !Array.isArray(body.providers)) {
    return json({ error: "providers must be an array" }, 400);
  }

  const kv = store(env);
  const raw = await kv.get(SETTINGS_KEY);
  const existing = parseJsonOrNull(raw) || { ...DEFAULT_SETTINGS };
  const currentVersion = settingsVersion(existing);

  // Optimistic concurrency. The whole settings object lives in one KV value and
  // is written whole, so two tabs saving from the same starting point would
  // silently drop one of them — providers and their keys included. A client that
  // read version N has to still be at N to write. Omitting version skips the
  // check on purpose, so curl and manual repair still work.
  if (typeof body.version === "number" && body.version !== currentVersion) {
    return json(
      { error: "settings changed elsewhere", conflict: true },
      409,
    );
  }

  const sourceProviders = Array.isArray(body.providers)
    ? body.providers
    : Array.isArray(existing.providers)
      ? existing.providers
      : [];

  // Preserve legacy ai_gateway_* fields verbatim during Phase 2 rollback window
  // so rolling back to the previous deployment restores Gateway mode cleanly.
  const preservedGwLogsUrl =
    typeof body.ai_gateway_logs_url === "string"
      ? body.ai_gateway_logs_url.trim()
      : typeof existing.ai_gateway_logs_url === "string"
        ? existing.ai_gateway_logs_url
        : undefined;
  const preservedGwToken =
    typeof body.ai_gateway_token === "string"
      ? body.ai_gateway_token.trim()
      : typeof existing.ai_gateway_token === "string"
        ? existing.ai_gateway_token
        : undefined;

  const next = {
    providers: sourceProviders.map(normalizeProviderForStorage),
    github_url:
      typeof body.github_url === "string"
        ? body.github_url.trim()
        : typeof existing.github_url === "string"
          ? existing.github_url
          : "",
    discord_webhook_url:
      typeof body.discord_webhook_url === "string"
        ? body.discord_webhook_url.trim()
        : typeof existing.discord_webhook_url === "string"
          ? existing.discord_webhook_url
          : "",
    proxy_password:
      typeof body.proxy_password === "string"
        ? body.proxy_password.trim()
        : typeof existing.proxy_password === "string"
          ? existing.proxy_password
          : "",
    ...(preservedGwLogsUrl !== undefined
      ? { ai_gateway_logs_url: preservedGwLogsUrl }
      : {}),
    ...(preservedGwToken !== undefined
      ? { ai_gateway_token: preservedGwToken }
      : {}),
    version: currentVersion + 1,
  };

  for (const intField of Object.keys(PROXY_INT_LIMITS)) {
    const parsedInt = parseIntSetting(body[intField], existing[intField], intField);
    if (parsedInt.error) return json({ error: parsedInt.error }, 400);
    next[intField] = parsedInt.value;
  }

  const adminPassword = (env.ADMIN_PASSWORD || "").trim();
  if (
    next.proxy_password &&
    adminPassword &&
    timingSafeEqual(next.proxy_password, adminPassword)
  ) {
    return json({ error: "代理密码不能与 ADMIN_PASSWORD 相同" }, 400);
  }
  if (next.github_url && !isHttpUrl(next.github_url)) {
    return json(
      { error: "GitHub Actions URL 必须以 http:// 或 https:// 开头" },
      400,
    );
  }
  if (next.discord_webhook_url && !isHttpUrl(next.discord_webhook_url)) {
    return json(
      { error: "Discord Webhook URL 必须以 http:// 或 https:// 开头" },
      400,
    );
  }

  const typeError = validateProviderTypes(next.providers || []);
  if (typeError) return json({ error: typeError }, 400);

  let selfHost = "";
  try {
    selfHost = new URL(request.url).host;
  } catch {}
  const apiBaseError = validateProviderApiBases(next.providers || [], selfHost);
  if (apiBaseError) return json({ error: apiBaseError }, 400);

  const aliasError = validateProviderAliases(next.providers || []);
  if (aliasError) return json({ error: aliasError }, 400);

  const testPathError = validateProviderTestPaths(next.providers || []);
  if (testPathError) return json({ error: testPathError }, 400);

  const keyError = validateProviderKeys(next.providers || []);
  if (keyError) return json({ error: keyError }, 400);

  const modelError = validateProviderModels(next.providers || []);
  if (modelError) return json({ error: modelError }, 400);

  const dupError = validateProviderDuplicates(next.providers || []);
  if (dupError) return json({ error: dupError }, 400);

  const nextEntries = await providerFpEntries(next.providers || []);
  const liveFps = new Set(nextEntries.map((e) => e.fp));

  // Skip store / D1 writes when the stored settings already match the payload.
  if (raw !== null && settingsDataEqual(existing, next)) {
    return json({
      ok: true,
      version: currentVersion,
      storage_backend: storageBackendName(env),
      unchanged: true,
    });
  }

  // Clean up results belonging to removed or identity-changed providers, and
  // drop dead keys whose card or key is no longer configured.
  const oldEntries = await providerFpEntries(existing.providers || []);
  const staleFps = [...new Set(oldEntries.map((e) => e.fp))].filter(
    (fp) => !liveFps.has(fp),
  );
  const rawDeadKeys = await kv.get(DEAD_KEYS_KEY);
  const keptDeadKeys = await pruneDeadKeysForSettings(
    rawDeadKeys,
    next.providers || [],
  );

  // Prune removed providers from standalone `proxy_test_models` (and migrate any
  // legacy `existing.proxy_test_models` map out of `app_settings`).
  const rawTestModels = await kv.get(PROXY_TEST_MODELS_KEY);
  const mergedTestModels = {
    ...normalizeProxyTestModels(existing.proxy_test_models),
    ...normalizeProxyTestModels(parseJsonOrNull(rawTestModels)),
    ...(body.proxy_test_models !== undefined
      ? normalizeProxyTestModels(body.proxy_test_models)
      : {}),
  };
  const prunedTestModels = Object.fromEntries(
    Object.entries(mergedTestModels).filter(([fp]) => liveFps.has(fp)),
  );
  const shouldWriteTestModels =
    body.proxy_test_models !== undefined ||
    existing.proxy_test_models !== undefined ||
    (rawTestModels !== null &&
      !deepEqual(normalizeProxyTestModels(parseJsonOrNull(rawTestModels)), prunedTestModels));

  if (storageBackendName(env) === "d1") {
    const db = env.DB;
    await ensureSchemaFor(db);
    const current = await db
      .prepare("SELECT id, fp, api_key FROM key_state")
      .all();
    const stmts = [
      db
        .prepare(
          "INSERT INTO store (k, v) VALUES (?, ?) " +
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        )
        .bind(SETTINGS_KEY, JSON.stringify(next)),
    ];
    if (shouldWriteTestModels) {
      stmts.push(
        db
          .prepare(
            "INSERT INTO store (k, v) VALUES (?, ?) " +
              "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
          )
          .bind(PROXY_TEST_MODELS_KEY, JSON.stringify(prunedTestModels)),
      );
    }
    for (const staleFp of staleFps) {
      stmts.push(
        db.prepare("DELETE FROM store WHERE k = ?").bind(`results:${staleFp}`),
      );
    }
    if (keptDeadKeys !== null) {
      stmts.push(
        db
          .prepare(
            "INSERT INTO store (k, v) VALUES (?, ?) " +
              "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
          )
          .bind(DEAD_KEYS_KEY, JSON.stringify(keptDeadKeys)),
      );
    }
    stmts.push(
      ...buildKeyStateSyncStmts(
        db,
        nextEntries,
        current.results || [],
        nowMs(),
      ),
    );
    await db.batch(stmts);
    invalidateSnapshot(db);
  } else {
    await kv.put(SETTINGS_KEY, JSON.stringify(next));
    if (shouldWriteTestModels) {
      await kv.put(PROXY_TEST_MODELS_KEY, JSON.stringify(prunedTestModels));
    }
    if (staleFps.length) {
      await Promise.all(
        staleFps.map((staleFp) => kv.delete(`results:${staleFp}`)),
      );
    }
    if (keptDeadKeys !== null) {
      await kv.put(DEAD_KEYS_KEY, JSON.stringify(keptDeadKeys));
    }
  }

  return json({
    ok: true,
    version: next.version,
    storage_backend: storageBackendName(env),
  });
}

function canonicalProviderForCompare(p) {
  if (!p || typeof p !== "object") return p;
  const type = typeof p.provider_type === "string" ? p.provider_type : "";
  return {
    enabled: p.enabled !== false,
    provider_type: type,
    api_base:
      typeof p.api_base === "string"
        ? p.api_base.trim().replace(/\/+$/, "")
        : "",
    test_path:
      type === "google"
        ? ""
        : typeof p.test_path === "string"
          ? p.test_path
          : "",
    keys: typeof p.keys === "string" ? p.keys : "",
    models: typeof p.models === "string" ? p.models : "",
    extra_body: typeof p.extra_body === "string" ? p.extra_body : "",
    custom_headers: Array.isArray(p.custom_headers)
      ? p.custom_headers.map((h) => ({
          key: String(h?.key ?? ""),
          value: String(h?.value ?? ""),
        }))
      : [],
    max_concurrency: p.max_concurrency != null ? p.max_concurrency : null,
    alias: typeof p.alias === "string" ? p.alias : "",
  };
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]),
  );
}

function settingsDataEqual(existing, next) {
  const cur = withSettingsDefaults(existing);
  const lhs = {
    providers: (Array.isArray(cur.providers) ? cur.providers : []).map(
      canonicalProviderForCompare,
    ),
    github_url: typeof cur.github_url === "string" ? cur.github_url : "",
    discord_webhook_url:
      typeof cur.discord_webhook_url === "string" ? cur.discord_webhook_url : "",
    proxy_password:
      typeof cur.proxy_password === "string" ? cur.proxy_password : "",
    ai_gateway_logs_url:
      typeof existing?.ai_gateway_logs_url === "string"
        ? existing.ai_gateway_logs_url
        : "",
    ai_gateway_token:
      typeof existing?.ai_gateway_token === "string"
        ? existing.ai_gateway_token
        : "",
    proxy_fail_threshold: cur.proxy_fail_threshold,
    proxy_max_retries: cur.proxy_max_retries,
    proxy_upstream_timeout_ms: cur.proxy_upstream_timeout_ms,
  };
  const rhs = {
    providers: (Array.isArray(next.providers) ? next.providers : []).map(
      canonicalProviderForCompare,
    ),
    github_url: next.github_url,
    discord_webhook_url: next.discord_webhook_url,
    proxy_password: next.proxy_password,
    ai_gateway_logs_url:
      typeof next.ai_gateway_logs_url === "string"
        ? next.ai_gateway_logs_url
        : "",
    ai_gateway_token:
      typeof next.ai_gateway_token === "string" ? next.ai_gateway_token : "",
    proxy_fail_threshold: next.proxy_fail_threshold,
    proxy_max_retries: next.proxy_max_retries,
    proxy_upstream_timeout_ms: next.proxy_upstream_timeout_ms,
  };
  return deepEqual(lhs, rhs);
}

// ─── /api/results ────────────────────────────────────────────────────────────
