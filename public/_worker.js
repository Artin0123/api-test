/**
 * Cloudflare Pages API Gateway — async_test_keys edition
 *
 * KV bindings required:
 *   KV_STORE
 *     app_settings               { providers[], github_url, discord_webhook_url }
 *     results:{fingerprint}      per-provider latest test results
 *     checkpoint:{fingerprint}   per-provider in-progress checkpoint
 *
 * Secrets required:
 *   ADMIN_PASSWORD
 *
 * Fingerprint = SHA-256( JSON.stringify({ api_base, provider_type }) )
 * key order must be alphabetical — matches both frontend and Python script.
 */

const ROUTES = {
  "GET /api/settings":    handleGetSettings,
  "POST /api/settings":   handlePostSettings,
  "GET /api/results":     handleGetResults,
  "POST /api/results":    handlePostResults,
  "GET /api/checkpoint":  handleGetCheckpoint,
  "DELETE /api/checkpoint": handleDeleteCheckpoint,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

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

// ─── helpers ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(value, status = 200) {
  return new Response(value, { status });
}

function kvStore(env) {
  if (!env.KV_STORE || typeof env.KV_STORE.get !== "function") {
    const err = new Error("KV_STORE is not configured");
    err.code = "CONFIG_ERROR";
    throw err;
  }
  return env.KV_STORE;
}

function requireAuth(request, env) {
  const adminPassword = (env.ADMIN_PASSWORD || "").trim();
  if (!adminPassword) return false;
  const auth  = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === adminPassword;
}

function parseJsonOrNull(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function sha256Hex(str) {
  const buf  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute provider fingerprint.
 * Keys sorted alphabetically: { api_base, provider_type }
 * Must stay in sync with frontend app.js fingerprintPayload() and async_test_keys.py.
 */
async function providerFingerprint(provider_type, api_base) {
  const normalized = api_base.replace(/\/+$/, "");
  const payload = JSON.stringify({ api_base: normalized, provider_type });
  return sha256Hex(payload);
}

function getNonEmptyString(url, param) {
  const v = (url.searchParams.get(param) || "").trim();
  return v || null;
}

// ─── /api/settings ──────────────────────────────────────────────────────────

const SETTINGS_KEY = "app_settings";

const DEFAULT_SETTINGS = {
  providers: [],
  github_url: "",
  discord_webhook_url: "",
};

async function handleGetSettings(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);
  const kv  = kvStore(env);
  const raw = await kv.get(SETTINGS_KEY);
  const settings = parseJsonOrNull(raw) || { ...DEFAULT_SETTINGS };
  return json({ ok: true, settings });
}

async function handlePostSettings(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  // Full-replace: accept the entire settings object from client.
  // Validate top-level shape only; provider internals are trusted from authenticated clients.
  if (body.providers !== undefined && !Array.isArray(body.providers)) {
    return json({ error: "providers must be an array" }, 400);
  }

  const kv  = kvStore(env);
  const raw = await kv.get(SETTINGS_KEY);
  const existing = parseJsonOrNull(raw) || { ...DEFAULT_SETTINGS };

  const next = {
    providers: Array.isArray(body.providers) ? body.providers : existing.providers,
    github_url:          typeof body.github_url          === "string" ? body.github_url          : existing.github_url,
    discord_webhook_url: typeof body.discord_webhook_url === "string" ? body.discord_webhook_url : existing.discord_webhook_url,
  };

  await kv.put(SETTINGS_KEY, JSON.stringify(next));
  return json({ ok: true });
}

// ─── /api/results ────────────────────────────────────────────────────────────

async function handleGetResults(request, env, url) {
  // Public — no auth required
  const fp = getNonEmptyString(url, "fp");
  if (!fp) return json({ error: "fp (fingerprint) required" }, 400);

  const kv  = kvStore(env);
  const raw = await kv.get(`results:${fp}`);
  if (!raw) return json({ exists: false });

  const results = parseJsonOrNull(raw);
  if (!results) return json({ exists: false });
  return json({ exists: true, results });
}

async function handlePostResults(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  // Require provider identity fields to compute fingerprint
  const { provider_type, api_base } = body;
  if (typeof provider_type !== "string" || !provider_type.trim()) {
    return json({ error: "provider_type required" }, 400);
  }
  if (typeof api_base !== "string" || !api_base.trim()) {
    return json({ error: "api_base required" }, 400);
  }

  // Minimal results schema check
  if (
    !Array.isArray(body.valid_keys) ||
    !Array.isArray(body.invalid_records) ||
    !Array.isArray(body.proven_working_models) ||
    !Array.isArray(body.failed_models)
  ) {
    return json({ error: "Invalid results schema" }, 400);
  }

  const fp = await providerFingerprint(provider_type.trim(), api_base.trim());
  const kv = kvStore(env);
  const payload = { ...body, uploaded_at: new Date().toISOString() };
  await kv.put(`results:${fp}`, JSON.stringify(payload));
  return json({ ok: true, fingerprint: fp });
}

// ─── /api/checkpoint ─────────────────────────────────────────────────────────

async function handleGetCheckpoint(request, env, url) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

  const fp = getNonEmptyString(url, "fp");
  if (!fp) return json({ error: "fp (fingerprint) required" }, 400);

  const kv  = kvStore(env);
  const raw = await kv.get(`checkpoint:${fp}`);
  if (!raw) return json({ exists: false });

  const checkpoint = parseJsonOrNull(raw);
  if (!checkpoint) return json({ exists: false });
  return json({ exists: true, checkpoint });
}

async function handleDeleteCheckpoint(request, env, url) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

  const fp = getNonEmptyString(url, "fp");
  if (!fp) return json({ error: "fp (fingerprint) required" }, 400);

  const kv = kvStore(env);
  await kv.delete(`checkpoint:${fp}`);
  return json({ ok: true });
}
