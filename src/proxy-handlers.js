// src/proxy-handlers.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
const SAMPLE_PATHS = {
  openai: "/chat/completions",
  google: "/v1beta/models/{model}:streamGenerateContent?alt=sse",
  anthropic: "/messages",
};

async function handleGetProxyState(request, env) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const blocked = rejectIfProxyDisabled(env);
  if (blocked) return blocked;

  const backend = storageBackendName(env);
  const kv = store(env);
  const settings = parseJsonObject(await kv.get(SETTINGS_KEY));
  const configError = proxyConfigError(env, settings);
  const providers = Array.isArray(settings?.providers) ? settings.providers : [];

  // Resolve fingerprint per provider first, so the key_state read can be scoped to
  // this site's providers. A full table scan would bill every row on every tab
  // switch once the table grows.
  const entries = (await providerFpEntries(providers)).filter(
    ({ provider: p }) => typeof p.alias === "string" && p.alias.trim(),
  );

  const testModels =
    settings &&
    typeof settings.proxy_test_models === "object" &&
    !Array.isArray(settings.proxy_test_models)
      ? settings.proxy_test_models
      : {};

  let rows = [];
  if (backend === "d1" && hasD1(env) && entries.length) {
    await ensureSchemaFor(env.DB);
    const fps = [...new Set(entries.map((e) => e.fp))];
    for (let i = 0; i < fps.length; i += D1_IN_CHUNK_SIZE) {
      const chunk = fps.slice(i, i + D1_IN_CHUNK_SIZE);
      const result = await env.DB.prepare(
        "SELECT id, fp, api_key, last_used_at, fail_count, disabled FROM key_state " +
          `WHERE fp IN (${chunk.map(() => "?").join(",")})`,
      )
        .bind(...chunk)
        .all();
      rows = rows.concat(result.results || []);
    }
  }
  const rowsByFp = new Map();
  for (const row of rows) {
    if (!rowsByFp.has(row.fp)) rowsByFp.set(row.fp, new Map());
    rowsByFp.get(row.fp).set(row.api_key, row);
  }

  const list = [];
  for (const { provider: p, providerType, apiBase, fp } of entries) {
    const fpRows = rowsByFp.get(fp) || new Map();
    const upstream = upstreamFor(settings, p);
    const keys = providerKeys(p).map((apiKey) => {
      const row = fpRows.get(apiKey);
      return {
        id: row ? row.id : null,
        masked: maskKey(apiKey),
        disabled: row ? !!row.disabled : false,
        fail_count: row ? row.fail_count : 0,
        last_used_at: row ? row.last_used_at : null,
        synced: !!row,
      };
    });
    let host = apiBase;
    try {
      host = new URL(apiBase).hostname;
    } catch {}
    const alias = typeof p.alias === "string" ? p.alias : "";
    list.push({
      fp,
      alias,
      host,
      provider_type: providerType,
      enabled: p.enabled !== false,
      via_gateway: !!upstream,
      proxy_url: alias ? `/proxy/${alias}` : "",
      sample_path: SAMPLE_PATHS[providerType] || "/chat/completions",
      test_model:
        typeof testModels[fp] === "string" ? testModels[fp] : "",
      logs_url: gatewayLogsUrl(settings, alias),
      // The proxy toolbar offers these as the probe-model menu. Keeping the
      // whole list (not just the first entry) is what lets 来源设定 stay the one
      // place where a provider's models are typed.
      models: providerModels(p),
      keys_total: keys.length,
      keys_available: keys.filter((k) => !k.disabled).length,
      keys,
    });
  }

  return json({
    ok: true,
    backend,
    proxy_enabled: !configError,
    proxy_message: configError || "",
    gateway_ready: upstreamReady(settings),
    logs_url_template: String(settings?.ai_gateway_logs_url || "").trim(),
    providers: list,
  });
}

function upstreamReady(settings) {
  return !!(
    parseGatewayLogsUrl(settings?.ai_gateway_logs_url) &&
    String(settings?.ai_gateway_token || "").trim()
  );
}

/** Build Gateway Logs shortcut URL from the configured AI Gateway Logs URL. */
function gatewayLogsUrl(settings, alias = "") {
  const raw = String(settings?.ai_gateway_logs_url ?? "").trim();
  if (!parseGatewayLogsUrl(raw)) return "";
  return raw.replace(/\{provider\}/g, encodeURIComponent(alias || ""));
}

// ─── /api/proxy/test ───────────────────────────────────────────────────────

/** Minimal single-key non-streaming probe ("only reply 1.", max 8 tokens).
 *  Failed probes increment fail_count (possibly disabling the key); a
 *  successful probe resets fail_count = 0 and clears disabled = 0 immediately. */
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
      const normalized = customPath.startsWith("/") ? customPath : "/" + customPath;
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
      const normalized = customPath.startsWith("/") ? customPath : "/" + customPath;
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

async function findProxyProviderByFp(kv, fp) {
  const settings = parseJsonObject(await kv.get(SETTINGS_KEY));
  const providers = Array.isArray(settings?.providers) ? settings.providers : [];
  for (const p of providers) {
    if (!p || typeof p.api_base !== "string") continue;
    const candidate = await providerFingerprint(
      String(p.provider_type || "").trim(),
      p.api_base.trim(),
    );
    if (candidate === fp) return { settings, providers, provider: p };
  }
  return { settings, providers, provider: null };
}

function proxyProviderActionError(provider) {
  if (!provider) return json({ error: "Not Found" }, 404);
  const alias = typeof provider.alias === "string" ? provider.alias.trim() : "";
  if (!alias) {
    return json(
      {
        error:
          "请先在「来源设定」填写转发别名 (alias)，才能经由 AI Gateway 操作",
      },
      400,
    );
  }
  return null;
}

async function handleProxyTest(request, env) {
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
  if (!Number.isInteger(id) || !fp) {
    return json({ error: "id and fp required" }, 400);
  }

  const kv = store(env);
  const settings = parseJsonObject(await kv.get(SETTINGS_KEY));
  const configError = proxyConfigError(env, settings);
  if (configError) return json({ error: configError }, 503);

  await ensureSchemaFor(env.DB);
  const row = await env.DB.prepare(
    "SELECT id, fp, api_key, fail_count, disabled FROM key_state WHERE id = ? AND fp = ?",
  )
    .bind(id, fp)
    .first();
  if (!row) return json({ error: "Not Found" }, 404);

  const providers = Array.isArray(settings?.providers) ? settings.providers : [];
  const provider = (
    await Promise.all(
      providers.map(async (p) => {
        if (!p || typeof p.api_base !== "string") return null;
        const candidate = await providerFingerprint(
          String(p.provider_type || "").trim(),
          p.api_base.trim(),
        );
        return candidate === fp ? p : null;
      }),
    )
  ).find(Boolean);
  if (!provider) return json({ error: "Not Found" }, 404);

  const providerErr = proxyProviderActionError(provider);
  if (providerErr) return providerErr;
  const alias = provider.alias.trim();

  // The probe model is its own setting (proxy_test_models), never auto-borrowed
  // from daily-test lists unless a model is explicitly selected when testing.
  // Writing it here only when it changed avoids extra store writes during normal
  // selection changes or multi-key batch loops.
  const requestedModel =
    typeof body.model === "string" ? body.model.trim() : "";
  const savedModel =
    settings &&
    typeof settings.proxy_test_models === "object" &&
    !Array.isArray(settings.proxy_test_models) &&
    typeof settings.proxy_test_models[fp] === "string"
      ? settings.proxy_test_models[fp].trim()
      : "";
  const testModel = requestedModel || savedModel;
  if (!testModel) {
    return json({ error: "尚未设定测试模型" }, 400);
  }

  if (provider.provider_type !== "google" && !(typeof provider.test_path === "string" && provider.test_path.trim())) {
    return json({ error: "请先在「来源设定」填写测试路径" }, 400);
  }
  const probe = testRequestFor(provider, testModel);
  if (!probe) return json({ error: "无效的测试模型设定" }, 400);

  const upstream = upstreamFor(settings, provider);
  if (!upstream) {
    return json({ error: "AI Gateway 设定不完整，无法测试" }, 503);
  }

  let savedSettingsVersion;
  if (requestedModel && requestedModel !== savedModel) {
    const map = normalizeProxyTestModels(settings.proxy_test_models);
    map[fp] = requestedModel;
    savedSettingsVersion = settingsVersion(settings) + 1;
    const nextSettings = {
      ...settings,
      providers,
      proxy_test_models: map,
      version: savedSettingsVersion,
    };
    await kv.put(SETTINGS_KEY, JSON.stringify(nextSettings));
  }
  const headers = buildForwardHeaders(
    settings,
    provider,
    alias,
    row.api_key,
    new Headers({ "Content-Type": "application/json" }),
    upstream,
  );
  headers.set("Content-Type", "application/json");

  const probeTimeoutMs = Math.min(proxyTimeoutMs(settings), 19000);
  const recordProbeFailure = async () => {
    const threshold = proxyFailThreshold(settings);
    if (row.disabled || Number(row.fail_count || 0) >= threshold) {
      return {
        fail_count: Number(row.fail_count || 0),
        disabled: !!row.disabled,
      };
    }
    try {
      return (
        (await recordKeyFailure(env.DB, row.id, threshold)) || {
          fail_count: Number(row.fail_count || 0),
          disabled: !!row.disabled,
        }
      );
    } catch (dbErr) {
      console.error("key_state failure write failed", dbErr);
      return null;
    }
  };

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    let response;
    try {
      response = await fetch(targetUrl(upstream, probe.path), {
        method: "POST",
        headers,
        body: JSON.stringify(probe.body),
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    let detail = "";
    let ledger = null;
    if (!response.ok) {
      detail = (await response.text()).slice(0, 300);
      ledger = await recordProbeFailure();
    } else {
      if (response.body) await response.body.cancel();
      if (row.disabled || Number(row.fail_count || 0) !== 0) {
        await env.DB.prepare(
          "UPDATE key_state SET fail_count = 0, disabled = 0, updated_at = ? WHERE id = ?",
        )
          .bind(Date.now(), row.id)
          .run();
      }
      ledger = { fail_count: 0, disabled: false };
    }
    return json({
      ok: response.ok,
      status: response.status,
      ms,
      model: probe.model,
      ...(savedSettingsVersion !== undefined
        ? { settings_version: savedSettingsVersion }
        : {}),
      error: detail || undefined,
      fail_count: ledger ? ledger.fail_count : undefined,
      disabled: ledger ? !!ledger.disabled : undefined,
    });
  } catch (err) {
    const ledger = await recordProbeFailure();
    const timedOut = err && err.name === "AbortError";
    return json({
      ok: false,
      status: 0,
      ms: Date.now() - started,
      model: probe.model,
      ...(savedSettingsVersion !== undefined
        ? { settings_version: savedSettingsVersion }
        : {}),
      error: timedOut
        ? `请求超时（${Math.round(probeTimeoutMs / 1000)} 秒）`
        : String((err && err.message) || err),
      fail_count: ledger ? ledger.fail_count : undefined,
      disabled: ledger ? !!ledger.disabled : undefined,
    });
  }
}

// ─── /api/proxy/recover ────────────────────────────────────────────────────

async function handleProxyRecover(request, env) {
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
  const kv = store(env);

  if (body.all === true) {
    if (!fp) {
      return json({ error: "fp required" }, 400);
    }
    const { provider } = await findProxyProviderByFp(kv, fp);
    const providerErr = proxyProviderActionError(provider);
    if (providerErr) return providerErr;
    await ensureSchemaFor(env.DB);
    const result = await env.DB.prepare(
      "UPDATE key_state SET disabled = 0, fail_count = 0, updated_at = ? " +
        "WHERE fp = ? AND disabled = 1 RETURNING id",
    )
      .bind(Date.now(), fp)
      .all();
    const ids = (result.results || []).map((r) => r.id);
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
  const { provider } = await findProxyProviderByFp(kv, fp);
  const providerErr = proxyProviderActionError(provider);
  if (providerErr) return providerErr;

  await ensureSchemaFor(env.DB);
  const result = await env.DB.prepare(
    "UPDATE key_state SET disabled = 0, fail_count = 0, updated_at = ? " +
      "WHERE id = ? AND fp = ? RETURNING id, fail_count, disabled, last_used_at",
  )
    .bind(Date.now(), id, fp)
    .all();
  const row = (result.results || [])[0];
  if (!row) return json({ error: "Not Found" }, 404);
  return json({
    ok: true,
    key: {
      id: row.id,
      fail_count: row.fail_count,
      disabled: !!row.disabled,
      last_used_at: row.last_used_at,
    },
  });
}

// ─── /api/proxy/disable ────────────────────────────────────────────────────

async function handleProxyDisable(request, env) {
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
  const { provider } = await findProxyProviderByFp(store(env), fp);
  const providerErr = proxyProviderActionError(provider);
  if (providerErr) return providerErr;

  await ensureSchemaFor(env.DB);
  const result = await env.DB.prepare(
    "UPDATE key_state SET disabled = 1, updated_at = ? " +
      "WHERE id = ? AND fp = ? RETURNING id, fail_count, disabled, last_used_at",
  )
    .bind(Date.now(), id, fp)
    .all();
  const row = (result.results || [])[0];
  if (!row) return json({ error: "Not Found" }, 404);
  return json({
    ok: true,
    key: {
      id: row.id,
      fail_count: row.fail_count,
      disabled: !!row.disabled,
      last_used_at: row.last_used_at,
    },
  });
}

// ─── /api/proxy/test-model ─────────────────────────────────────────────────
// Stores which model each provider should probe with, keyed by fingerprint. The
// *options* come from providers[].models (the Models field in 来源设定), but the
// choice is kept here so editing that comma list does not silently change a
// provider's probe model.
async function handleProxyTestModel(request, env) {
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

  const kv = store(env);
  const settings =
    parseJsonObject(await kv.get(SETTINGS_KEY)) || { ...DEFAULT_SETTINGS };
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  const known = new Set(
    await Promise.all(
      providers
        .filter((p) => p && typeof p.api_base === "string" && p.provider_type)
        .map((p) =>
          providerFingerprint(String(p.provider_type).trim(), p.api_base.trim()),
        ),
    ),
  );
  if (!known.has(fp)) return json({ error: "Not Found" }, 404);

  const model = typeof body.model === "string" ? body.model.trim() : "";
  const map = normalizeProxyTestModels(settings.proxy_test_models);
  if (model) map[fp] = model;
  else delete map[fp];

  const next = {
    ...settings,
    providers,
    proxy_test_models: map,
    version: settingsVersion(settings) + 1,
  };
  await kv.put(SETTINGS_KEY, JSON.stringify(next));
  return json({ ok: true, test_model: model });
}
