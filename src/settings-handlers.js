// src/settings-handlers.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
async function handleGetSettings(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);
  const kv = store(env);
  const raw = await kv.get(SETTINGS_KEY);
  const settings = withSettingsDefaults(parseJsonOrNull(raw));
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
    ai_gateway_logs_url:
      typeof body.ai_gateway_logs_url === "string"
        ? body.ai_gateway_logs_url.trim()
        : typeof existing.ai_gateway_logs_url === "string"
          ? existing.ai_gateway_logs_url
          : "",
    ai_gateway_token:
      typeof body.ai_gateway_token === "string"
        ? body.ai_gateway_token.trim()
        : typeof existing.ai_gateway_token === "string"
          ? existing.ai_gateway_token
          : "",
    proxy_test_models: normalizeProxyTestModels(
      body.proxy_test_models !== undefined
        ? body.proxy_test_models
        : existing.proxy_test_models,
    ),
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
  if (next.ai_gateway_logs_url && !parseGatewayLogsUrl(next.ai_gateway_logs_url)) {
    return json(
      {
        error:
          "AI Gateway Logs URL 格式无效，请填写 https://dash.cloudflare.com/{account_id}/ai/ai-gateway/gateways/{gateway_id}/logs",
      },
      400,
    );
  }

  const aliasError = validateProviderAliases(next.providers || []);
  if (aliasError) return json({ error: aliasError }, 400);

  const typeError = validateProviderTypes(next.providers || []);
  if (typeError) return json({ error: typeError }, 400);

  const keyError = validateProviderKeys(next.providers || []);
  if (keyError) return json({ error: keyError }, 400);

  const modelError = validateProviderModels(next.providers || []);
  if (modelError) return json({ error: modelError }, 400);

  const dupError = validateProviderDuplicates(next.providers || []);
  if (dupError) return json({ error: dupError }, 400);

  // Drop test-model entries whose provider no longer exists, so editing api_base
  // (new fingerprint) or deleting a provider cannot leave the map growing.
  const nextEntries = await providerFpEntries(next.providers || []);
  const liveFps = new Set(nextEntries.map((e) => e.fp));
  next.proxy_test_models = Object.fromEntries(
    Object.entries(next.proxy_test_models).filter(([fp]) => liveFps.has(fp)),
  );

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
        Date.now(),
      ),
    );
    await db.batch(stmts);
  } else {
    await kv.put(SETTINGS_KEY, JSON.stringify(next));
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
  return {
    enabled: p.enabled !== false,
    provider_type: typeof p.provider_type === "string" ? p.provider_type : "",
    api_base: typeof p.api_base === "string" ? p.api_base : "",
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
    ...(Object.prototype.hasOwnProperty.call(p, "gateway_provider")
      ? { gateway_provider: p.gateway_provider }
      : {}),
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
      typeof cur.ai_gateway_logs_url === "string" ? cur.ai_gateway_logs_url : "",
    ai_gateway_token:
      typeof cur.ai_gateway_token === "string" ? cur.ai_gateway_token : "",
    proxy_test_models:
      cur.proxy_test_models &&
      typeof cur.proxy_test_models === "object" &&
      !Array.isArray(cur.proxy_test_models)
        ? cur.proxy_test_models
        : {},
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
    ai_gateway_logs_url: next.ai_gateway_logs_url,
    ai_gateway_token: next.ai_gateway_token,
    proxy_test_models: next.proxy_test_models,
    proxy_fail_threshold: next.proxy_fail_threshold,
    proxy_max_retries: next.proxy_max_retries,
    proxy_upstream_timeout_ms: next.proxy_upstream_timeout_ms,
  };
  return deepEqual(lhs, rhs);
}

// ─── /api/results ────────────────────────────────────────────────────────────
