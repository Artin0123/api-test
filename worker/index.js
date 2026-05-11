/**
 * Cloudflare Worker API Gateway
 *
 * KV bindings required:
 *   KV_STORE  providers_config, run_checkpoint,
 *             latest_scorecard, latest_benchmark, latest_run_meta
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
    benchmark_enabled: typeof p.benchmark_enabled === "boolean" ? p.benchmark_enabled : true,
  };
}

function providerKey(p) {
  return `${p.provider_type}::${p.mode}::${p.api_base}`;
}

function looksMaskedKey(value) {
  return typeof value === "string" && value.includes("***");
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
  for (const field of ["run_id", "started_at", "finished_at", "scorecard", "benchmark"]) {
    if (body[field] == null) return json({ error: `Missing field: ${field}` }, 400);
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

  // 409 if result is not newer
  const existingMetaRaw = await env.KV_STORE.get("latest_run_meta");
  if (existingMetaRaw) {
    const existing = JSON.parse(existingMetaRaw);
    if (body.finished_at <= existing.finished_at) {
      return json({ error: "Stale result: finished_at is not newer than existing" }, 409);
    }
  }

  const run_meta = {
    run_id: body.run_id,
    started_at: body.started_at,
    finished_at: body.finished_at,
  };

  await Promise.all([
    env.KV_STORE.put("latest_scorecard", JSON.stringify(body.scorecard)),
    env.KV_STORE.put("latest_benchmark", JSON.stringify(body.benchmark)),
    env.KV_STORE.put("latest_run_meta", JSON.stringify(run_meta)),
  ]);

  return json({ ok: true });
}

// ── GET /api/results ──────────────────────────────────────────────────────────
// Public endpoint �?no auth required

async function handleGetResults(request, env) {
  const [scorecardRaw, benchmarkRaw, metaRaw] = await Promise.all([
    env.KV_STORE.get("latest_scorecard"),
    env.KV_STORE.get("latest_benchmark"),
    env.KV_STORE.get("latest_run_meta"),
  ]);

  if (!metaRaw) return json({ exists: false });

  return json({
    meta: JSON.parse(metaRaw),
    scorecard: scorecardRaw ? JSON.parse(scorecardRaw) : null,
    benchmark: benchmarkRaw ? JSON.parse(benchmarkRaw) : null,
  });
}
