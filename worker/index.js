/**
 * Cloudflare Worker API Gateway
 *
 * KV bindings required:
 *   KV_STORE  providers_config, run_checkpoint,
 *             latest_scorecard:{config_fingerprint},
 *             latest_benchmark:{config_fingerprint}
 *
 * Secrets required:
 *   MASTER_API_TOKEN
 *   GITHUB_ACTIONS_URL  (used by frontend Run Now button)
 */

const ROUTES = {
  "GET /api/env": handleGetEnv,
  "GET /api/config": handleGetConfig,
  "POST /api/config": handlePostConfig,
  "GET /api/checkpoint": handleGetCheckpoint,
  "POST /api/checkpoint": handlePostCheckpoint,
  "DELETE /api/checkpoint": handleDeleteCheckpoint,
  "POST /api/results": handlePostResults,
  "GET /api/results": handleGetResults,
};

const VALID_TYPES = new Set(["openai", "ollama", "gemini"]);
const VALID_MODES = new Set(["thinking", "vision"]);

const DEFAULT_ENDPOINT_PATH = {
  openai: "/v1/chat/completions",
  ollama: "/api/chat",
  gemini: "/v1beta/models/{model}:streamGenerateContent?alt=sse",
};

const DEFAULT_MODELS_ENDPOINT = {
  openai: "/v1/models",
  ollama: "/api/tags",
  gemini: "/v1beta/models",
};

// ── Entry point ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const handler = ROUTES[key];
    if (!handler) return text("Not Found", 404);
    try {
      return await handler(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: "Internal Server Error" }, 500);
    }
  },
};

// ── Auth & helpers ────────────────────────────────────────────────────────────

function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === env.MASTER_API_TOKEN;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(msg, status = 200) {
  return new Response(msg, { status });
}

function maskKey(key) {
  if (!key || key.length <= 6) return "***";
  return key.slice(0, 4) + "***" + key.slice(-2);
}

function asNonEmptyString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function normalizeProvider(p) {
  const providerType = p.provider_type;
  return {
    ...p,
    endpoint_path: asNonEmptyString(p.endpoint_path, DEFAULT_ENDPOINT_PATH[providerType] || ""),
    models_endpoint: asNonEmptyString(p.models_endpoint, DEFAULT_MODELS_ENDPOINT[providerType] || ""),
    tester_enabled: typeof p.tester_enabled === "boolean" ? p.tester_enabled : true,
    benchmark_enabled: typeof p.benchmark_enabled === "boolean" ? p.benchmark_enabled : true,
  };
}

function providerKey(p) {
  return `${p.provider_type}::${p.mode}::${p.api_base}`;
}

function looksMaskedKey(value) {
  return typeof value === "string" && value.includes("***");
}

function normalizeForFingerprint(providers) {
  const normalized = (providers || []).map((p) => {
    const providerType = p.provider_type;
    return {
      provider_type: providerType,
      mode: p.mode || "",
      api_base: p.api_base || "",
      endpoint_path: asNonEmptyString(p.endpoint_path, DEFAULT_ENDPOINT_PATH[providerType] || ""),
      models_endpoint: asNonEmptyString(p.models_endpoint, DEFAULT_MODELS_ENDPOINT[providerType] || ""),
      tester_enabled: typeof p.tester_enabled === "boolean" ? p.tester_enabled : true,
      benchmark_enabled: typeof p.benchmark_enabled === "boolean" ? p.benchmark_enabled : true,
    };
  });

  normalized.sort((a, b) => {
    const ak = `${a.provider_type}::${a.mode}::${a.api_base}`;
    const bk = `${b.provider_type}::${b.mode}::${b.api_base}`;
    return ak.localeCompare(bk);
  });

  return normalized;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

async function buildConfigFingerprint(providers) {
  const normalized = normalizeForFingerprint(providers);
  const payload = JSON.stringify(sortKeysDeep(normalized));
  return sha256Hex(payload);
}

async function getCurrentConfigFingerprint(env) {
  const configRaw = await env.KV_STORE.get("providers_config");
  if (!configRaw) return null;
  try {
    const config = JSON.parse(configRaw);
    return await buildConfigFingerprint(config.providers || []);
  } catch {
    return null;
  }
}

function scorecardKey(configFingerprint) {
  return configFingerprint ? `latest_scorecard:${configFingerprint}` : null;
}

function benchmarkKey(configFingerprint) {
  return configFingerprint ? `latest_benchmark:${configFingerprint}` : null;
}

function asFingerprint(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function parseJsonOrNull(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readResultBundle(env, configFingerprint) {
  const scKey = scorecardKey(configFingerprint);
  const bmKey = benchmarkKey(configFingerprint);

  if (!scKey || !bmKey) {
    return { scorecard: null, benchmark: null };
  }

  const [scorecardRaw, benchmarkRaw] = await Promise.all([
    env.KV_STORE.get(scKey),
    env.KV_STORE.get(bmKey),
  ]);

  const scorecard = parseJsonOrNull(scorecardRaw);
  const benchmark = parseJsonOrNull(benchmarkRaw);

  return { scorecard, benchmark };
}

// ── GET /api/env ──────────────────────────────────────────────────────────────

async function handleGetEnv(request, env) {
  return json({ github_actions_url: env.GITHUB_ACTIONS_URL || null });
}

// ── GET /api/config ───────────────────────────────────────────────────────────
// ?full=1 + auth �?returns complete api_key (for GHA)
// default + auth �?returns masked api_key (for frontend)

async function handleGetConfig(request, env, url) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

  const raw = await env.KV_STORE.get("providers_config");
  if (!raw) return json({ providers: [], updated_at: null });

  const config = JSON.parse(raw);
  const full = url.searchParams.get("full") === "1";

  if (!full) {
    config.providers = (config.providers || []).map((p) => ({
      ...p,
      api_key: maskKey(p.api_key),
    }));
  }

  return json(config);
}

// ── POST /api/config ──────────────────────────────────────────────────────────

async function handlePostConfig(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  if (!Array.isArray(body.providers)) {
    return json({ error: "providers must be an array" }, 400);
  }

  for (const p of body.providers) {
    if (!VALID_TYPES.has(p.provider_type))
      return json({ error: `Invalid provider_type: ${p.provider_type}` }, 400);
    if (!VALID_MODES.has(p.mode))
      return json({ error: `Invalid mode: ${p.mode}` }, 400);
    if (typeof p.api_base !== "string" || !p.api_base.trim())
      return json({ error: "api_base required" }, 400);
  }

  let existingConfig = { providers: [] };
  const existingRaw = await env.KV_STORE.get("providers_config");
  if (existingRaw) {
    try {
      existingConfig = JSON.parse(existingRaw);
    } catch {
      existingConfig = { providers: [] };
    }
  }

  const existingByKey = new Map((existingConfig.providers || []).map((p) => [providerKey(p), p]));

  body.providers = body.providers.map((incoming) => {
    const normalized = normalizeProvider(incoming);
    const k = providerKey(normalized);
    const prev = existingByKey.get(k);

    if (!normalized.api_key || looksMaskedKey(normalized.api_key)) {
      if (prev && typeof prev.api_key === "string" && prev.api_key.trim()) {
        normalized.api_key = prev.api_key;
      }
    }

    return normalized;
  });

  for (const p of body.providers) {
    if (typeof p.api_key !== "string" || !p.api_key.trim())
      return json({ error: `api_key required for provider: ${providerKey(p)}` }, 400);
  }

  const keys = new Set();
  for (const p of body.providers) {
    const k = providerKey(p);
    if (keys.has(k)) return json({ error: "Duplicate provider (provider_type + mode + api_base)" }, 400);
    keys.add(k);
  }

  body.updated_at = new Date().toISOString();
  await env.KV_STORE.put("providers_config", JSON.stringify(body));
  return json({ ok: true });
}

// ── GET /api/checkpoint ───────────────────────────────────────────────────────

async function handleGetCheckpoint(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

  const raw = await env.KV_STORE.get("run_checkpoint");
  if (!raw) return json({ exists: false });
  return json(JSON.parse(raw));
}

// ── POST /api/checkpoint ──────────────────────────────────────────────────────

async function handlePostCheckpoint(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  if (!body.run_id) return json({ error: "run_id required" }, 400);

  body.updated_at = new Date().toISOString();
  await env.KV_STORE.put("run_checkpoint", JSON.stringify(body));
  return json({ ok: true });
}

// ── DELETE /api/checkpoint ────────────────────────────────────────────────────

async function handleDeleteCheckpoint(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

  await env.KV_STORE.delete("run_checkpoint");
  return json({ ok: true });
}

// ── POST /api/results ─────────────────────────────────────────────────────────

async function handlePostResults(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  // Required fields
  for (const field of ["scorecard", "benchmark"]) {
    if (body[field] == null) return json({ error: `Missing field: ${field}` }, 400);
  }

  const configFingerprint =
    (typeof body.config_fingerprint === "string" && body.config_fingerprint.trim())
      ? body.config_fingerprint.trim()
      : (typeof body.scorecard?.config_fingerprint === "string" && body.scorecard.config_fingerprint.trim())
        ? body.scorecard.config_fingerprint.trim()
        : (typeof body.benchmark?.config_fingerprint === "string" && body.benchmark.config_fingerprint.trim())
          ? body.benchmark.config_fingerprint.trim()
          : null;

  if (!configFingerprint) {
    return json({ error: "Missing field: config_fingerprint" }, 400);
  }

  const scorecardRunId = asNonEmptyString(body.scorecard?.run_id);
  const scorecardStartedAt = asNonEmptyString(body.scorecard?.started_at);
  const scorecardFinishedAt = asNonEmptyString(body.scorecard?.finished_at);
  if (!scorecardRunId || !scorecardStartedAt || !scorecardFinishedAt) {
    return json({ error: "scorecard.run_id, scorecard.started_at, scorecard.finished_at are required" }, 400);
  }

  // Anti-IDOR: all items must refer to a registered provider
  const configRaw = await env.KV_STORE.get("providers_config");
  if (configRaw) {
    const config = JSON.parse(configRaw);
    const validKeys = new Set((config.providers || []).map(providerKey));
    for (const item of body.scorecard.items || []) {
      const k = `${item.provider_type}::${item.mode}::${item.api_base}`;
      if (!validKeys.has(k)) return json({ error: `Unknown provider: ${k}` }, 400);
    }
    for (const item of body.benchmark.items || []) {
      const k = `${item.provider_type}::${item.mode}::${item.api_base}`;
      if (!validKeys.has(k)) return json({ error: `Unknown provider: ${k}` }, 400);
    }
  }

  await Promise.all([
    env.KV_STORE.put(scorecardKey(configFingerprint), JSON.stringify(body.scorecard)),
    env.KV_STORE.put(benchmarkKey(configFingerprint), JSON.stringify(body.benchmark)),
  ]);

  return json({ ok: true });
}

// ── GET /api/results ──────────────────────────────────────────────────────────
// Public endpoint �?no auth required

async function handleGetResults(request, env, url) {
  const requestedFingerprint = asFingerprint(url.searchParams.get("fingerprint"));
  const resolvedFingerprint = requestedFingerprint || (await getCurrentConfigFingerprint(env));
  const source = requestedFingerprint ? "requested_fingerprint" : "current_fingerprint";
  const bundle = await readResultBundle(env, resolvedFingerprint);

  if (!bundle.scorecard && !bundle.benchmark) {
    return json({
      exists: false,
      source,
      requested_config_fingerprint: requestedFingerprint,
      config_fingerprint: resolvedFingerprint,
    });
  }

  return json({
    exists: true,
    source,
    requested_config_fingerprint: requestedFingerprint,
    config_fingerprint:
      resolvedFingerprint ||
      asFingerprint(bundle.scorecard?.config_fingerprint) ||
      asFingerprint(bundle.benchmark?.config_fingerprint),
    scorecard: bundle.scorecard,
    benchmark: bundle.benchmark,
  });
}
