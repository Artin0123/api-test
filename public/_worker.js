/**
 * Cloudflare Pages API Gateway — async_test_keys edition
 *
 * KV bindings required:
 *   KV_STORE
 *     app_settings               { providers[], github_url, discord_webhook_url }
 *     results:{fingerprint}      per-provider latest test results
 *     checkpoint:{fingerprint}   per-provider in-progress checkpoint
 *     dead_keys                  manually curated dead key records (array)
 *
 * Secrets required:
 *   ADMIN_PASSWORD
 *
 * Auth: every /api/ endpoint requires either `Authorization: Bearer <ADMIN_PASSWORD>`
 * (used by async_test_keys.py and the GHA workflow) or the session cookie issued by
 * POST /api/login (used by the browser, so URLs can be opened straight from the
 * address bar without a REST client).
 *
 * Fingerprint = SHA-256( JSON.stringify({ api_base, provider_type }) )
 * key order must be alphabetical — matches both frontend and Python script.
 */

const ROUTES = {
  "POST /api/login": handleLogin,
  "POST /api/logout": handleLogout,
  "GET /api/settings": handleGetSettings,
  "POST /api/settings": handlePostSettings,
  "GET /api/results": handleGetResults,
  "POST /api/results": handlePostResults,
  "GET /api/checkpoint": handleGetCheckpoint,
  "POST /api/checkpoint": handlePostCheckpoint,
  "DELETE /api/checkpoint": handleDeleteCheckpoint,
  "GET /api/dead-keys": handleGetDeadKeys,
  "POST /api/dead-keys": handlePostDeadKey,
  "PUT /api/dead-keys": handlePutDeadKey,
  "DELETE /api/dead-keys": handleDeleteDeadKey,
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

// ─── auth ───────────────────────────────────────────────────────────────────

const SESSION_COOKIE = "atk_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Bumping this invalidates every cookie in circulation without touching the password.
const SESSION_VERSION = "v1";

/** Length is allowed to leak; the byte comparison itself is constant-time. */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sessions are stateless: the cookie is `<expiry-ms>.<HMAC(ADMIN_PASSWORD, ver.expiry)>`.
 * No KV round-trip on the read path (which would otherwise double the read quota this
 * app spends per page view), and rotating ADMIN_PASSWORD or SESSION_VERSION revokes
 * every outstanding cookie. The trade-off is that a single cookie cannot be revoked
 * on its own — acceptable for a single shared admin login.
 */
async function issueSession(adminPassword) {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${await hmacHex(adminPassword, `${SESSION_VERSION}.${exp}`)}`;
}

async function sessionIsValid(adminPassword, value) {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const exp = value.slice(0, dot);
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || Date.now() >= expMs) return false;
  const expected = await hmacHex(adminPassword, `${SESSION_VERSION}.${exp}`);
  return timingSafeEqual(value.slice(dot + 1), expected);
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/**
 * Path=/api keeps the cookie off static asset requests. SameSite=Strict is what
 * stands in for a CSRF token here: the write endpoints parse the body with
 * request.json() without checking Content-Type, so a cross-site form post would
 * otherwise be accepted — Strict means no cross-site request carries the cookie,
 * while typing an /api/ URL into the address bar still does.
 */
function sessionCookieHeader(value, maxAgeSeconds) {
  return (
    `${SESSION_COOKIE}=${value}; Max-Age=${maxAgeSeconds}; Path=/api; ` +
    `HttpOnly; Secure; SameSite=Strict`
  );
}

async function requireAuth(request, env) {
  const adminPassword = (env.ADMIN_PASSWORD || "").trim();
  if (!adminPassword) return false;

  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return timingSafeEqual(auth.slice(7), adminPassword);
  }
  return sessionIsValid(adminPassword, readCookie(request, SESSION_COOKIE));
}

async function handleLogin(request, env) {
  const adminPassword = (env.ADMIN_PASSWORD || "").trim();
  if (!adminPassword) return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const password = typeof body.password === "string" ? body.password.trim() : "";
  if (!password || !timingSafeEqual(password, adminPassword)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const value = await issueSession(adminPassword);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookieHeader(value, Math.floor(SESSION_TTL_MS / 1000)),
    },
  });
}

function handleLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookieHeader("", 0),
    },
  });
}

function parseJsonOrNull(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
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
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);
  const kv = kvStore(env);
  const raw = await kv.get(SETTINGS_KEY);
  const settings = parseJsonOrNull(raw) || { ...DEFAULT_SETTINGS };
  return json({ ok: true, settings });
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

  const kv = kvStore(env);
  const raw = await kv.get(SETTINGS_KEY);
  const existing = parseJsonOrNull(raw) || { ...DEFAULT_SETTINGS };

  const next = {
    providers: Array.isArray(body.providers)
      ? body.providers
      : existing.providers,
    github_url:
      typeof body.github_url === "string"
        ? body.github_url
        : existing.github_url,
    discord_webhook_url:
      typeof body.discord_webhook_url === "string"
        ? body.discord_webhook_url
        : existing.discord_webhook_url,
  };

  await kv.put(SETTINGS_KEY, JSON.stringify(next));

  // Cleanup stale checkpoints: only delete for providers that were REMOVED or had their
  // identity (api_base / provider_type) changed — i.e. old fingerprints not present in
  // the new settings. Providers that still exist keep their checkpoint intact.
  const oldProviders = existing.providers || [];
  if (oldProviders.length > 0) {
    const newFpSet = new Set(
      await Promise.all(
        (next.providers || [])
          .filter((p) => p && p.provider_type?.trim() && p.api_base?.trim())
          .map((p) =>
            providerFingerprint(p.provider_type.trim(), p.api_base.trim()),
          ),
      ),
    );
    await Promise.allSettled(
      oldProviders.map(async (p) => {
        if (
          !p ||
          typeof p.provider_type !== "string" ||
          typeof p.api_base !== "string"
        )
          return;
        if (!p.provider_type.trim() || !p.api_base.trim()) return;
        const fp = await providerFingerprint(
          p.provider_type.trim(),
          p.api_base.trim(),
        );
        if (!newFpSet.has(fp)) await kv.delete(`checkpoint:${fp}`);
      }),
    );
  }

  return json({ ok: true });
}

// ─── /api/results ────────────────────────────────────────────────────────────

async function handleGetResults(request, env, url) {
  // Authenticated: the stored results carry plaintext keys (valid_keys and
  // invalid_records[].api_key), and fp is derived from public inputs
  // (api_base + provider_type), so it is guessable and cannot gate access.
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const fp = getNonEmptyString(url, "fp");
  if (!fp) return json({ error: "fp (fingerprint) required" }, 400);

  const kv = kvStore(env);
  const raw = await kv.get(`results:${fp}`);
  if (!raw) return json({ exists: false });

  const results = parseJsonOrNull(raw);
  if (!results) return json({ exists: false });
  return json({ exists: true, results });
}

async function handlePostResults(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

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
  // Auto-clean checkpoint so frontend won't show stale "执行中"
  await kv.delete(`checkpoint:${fp}`);

  // Best-effort: the results are already stored, so a failure here must not make
  // the uploader think the whole run was lost and retry it.
  let synced = { added: 0, removed: 0 };
  try {
    synced = await syncDeadKeysFromResults(
      kv,
      api_base.trim(),
      body.valid_keys,
      body.invalid_records,
      payload.uploaded_at,
    );
  } catch (err) {
    console.error("dead key sync failed", err);
  }
  return json({
    ok: true,
    fingerprint: fp,
    dead_keys_added: synced.added,
    dead_keys_removed: synced.removed,
  });
}

// ─── /api/checkpoint ─────────────────────────────────────────────────────────

async function handleGetCheckpoint(request, env, url) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const fp = getNonEmptyString(url, "fp");
  if (!fp) return json({ error: "fp (fingerprint) required" }, 400);

  const kv = kvStore(env);
  const raw = await kv.get(`checkpoint:${fp}`);
  if (!raw) return json({ exists: false });

  const checkpoint = parseJsonOrNull(raw);
  if (!checkpoint) return json({ exists: false });
  return json({ exists: true, checkpoint });
}

async function handlePostCheckpoint(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { provider_type, api_base } = body;
  if (!provider_type || !api_base)
    return json({ error: "provider_type and api_base required" }, 400);

  const fp = await providerFingerprint(provider_type.trim(), api_base.trim());
  const kv = kvStore(env);
  const payload = { ...body, saved_at: new Date().toISOString() };
  await kv.put(`checkpoint:${fp}`, JSON.stringify(payload));
  return json({ ok: true, fingerprint: fp });
}

async function handleDeleteCheckpoint(request, env, url) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const fp = getNonEmptyString(url, "fp");
  if (!fp) return json({ error: "fp (fingerprint) required" }, 400);

  const kv = kvStore(env);
  await kv.delete(`checkpoint:${fp}`);
  return json({ ok: true });
}

// ─── /api/dead-keys ──────────────────────────────────────────────────────────

const DEAD_KEYS_KEY = "dead_keys";

async function readDeadKeys(kv) {
  const parsed = parseJsonOrNull(await kv.get(DEAD_KEYS_KEY));
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeErrorCode(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** error_detail is deduped per provider_host + error_code — same host, same
 *  status code means the same provider message, so it is stored only once. */
function sameDedupGroup(a, b) {
  return (
    a.provider_host === b.provider_host &&
    normalizeErrorCode(a.error_code) === normalizeErrorCode(b.error_code)
  );
}

/** error_detail must be a flat-ish key-value object; anything else is dropped. */
function normalizeErrorDetail(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return Object.keys(out).length ? out : null;
}

/** Reconcile the dead key list against one test run: every key that failed is
 *  recorded, every key that passed is dropped. The list therefore means "keys
 *  currently failing", not a permanent ledger — which is what lets us record any
 *  failure code, since a transient one (429, 500, 全网皆败) clears itself on the
 *  next run instead of parking a working key here forever. Removing the key from
 *  来源设定 stays a manual decision. */
async function syncDeadKeysFromResults(
  kv,
  api_base,
  validKeys,
  invalidRecords,
  uploadedAt,
) {
  const none = { added: 0, removed: 0 };

  let provider_host;
  try {
    provider_host = new URL(api_base).hostname;
  } catch {
    return none;
  }
  if (!provider_host) return none;

  let list = await readDeadKeys(kv);
  let removed = 0;
  let added = 0;

  // 1. Keys that answered this run are not dead any more — drop them, manual or
  //    auto alike, since the record now asserts something untrue.
  const recovered = new Set(
    (Array.isArray(validKeys) ? validKeys : [])
      .filter((k) => typeof k === "string")
      .map((k) => k.trim())
      .filter(Boolean),
  );
  if (recovered.size) {
    const keep = [];
    const dropped = [];
    for (const r of list) {
      if (r && r.provider_host === provider_host && recovered.has(r.api_key)) {
        dropped.push(r);
      } else {
        keep.push(r);
      }
    }
    // A dropped record may hold its group's only error_detail — hand it over,
    // same as DELETE does.
    for (const gone of dropped) {
      if (!gone.error_detail) continue;
      const heir = keep.find((r) => r && !r.error_detail && sameDedupGroup(r, gone));
      if (heir) heir.error_detail = gone.error_detail;
    }
    if (dropped.length) {
      list = keep;
      removed = dropped.length;
    }
  }

  // 2. Keys that failed get recorded. expired_at is stored as the calendar day at
  //    midnight UTC — the exact shape manual entries use (toIsoDay in app.js) —
  //    because the UI reads it as a date; the precise moment stays in created_at.
  const expired_at = `${String(uploadedAt).slice(0, 10)}T00:00:00.000Z`;
  const known = new Set(list.map((r) => r && r.api_key));

  for (const rec of Array.isArray(invalidRecords) ? invalidRecords : []) {
    if (!rec || typeof rec.api_key !== "string" || !rec.api_key.trim()) continue;
    const api_key = rec.api_key.trim();
    if (known.has(api_key)) continue;

    const error_code = normalizeErrorCode(rec.error_code);
    let error_detail = normalizeErrorDetail(rec.error_detail);
    if (!error_detail && rec.error_reason) {
      error_detail = { message: String(rec.error_reason) };
    }
    if (
      error_detail &&
      list.some(
        (r) => r && r.error_detail && sameDedupGroup(r, { provider_host, error_code }),
      )
    ) {
      error_detail = null;
    }

    list.push({
      id: crypto.randomUUID(),
      provider_host,
      api_key,
      expired_at,
      error_code,
      error_detail,
      created_at: uploadedAt,
    });
    known.add(api_key);
    added++;
  }

  if (added || removed) await kv.put(DEAD_KEYS_KEY, JSON.stringify(list));
  return { added, removed };
}

async function handleGetDeadKeys(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);
  const kv = kvStore(env);
  return json({ ok: true, dead_keys: await readDeadKeys(kv) });
}

async function handlePostDeadKey(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const api_key = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!api_key) return json({ error: "api_key required" }, 400);

  const provider_host =
    typeof body.provider_host === "string" ? body.provider_host.trim() : "";
  if (!provider_host) return json({ error: "provider_host required" }, 400);

  const kv = kvStore(env);
  const list = await readDeadKeys(kv);

  // Key dedup is global (not per host): the earliest record wins, nothing is overwritten.
  if (list.some((r) => r && r.api_key === api_key)) {
    return json({ error: "api_key already recorded", duplicated: true }, 409);
  }

  const error_code = normalizeErrorCode(body.error_code);
  let error_detail = normalizeErrorDetail(body.error_detail);

  if (
    error_detail &&
    list.some(
      (r) => r && r.error_detail && sameDedupGroup(r, { provider_host, error_code }),
    )
  ) {
    error_detail = null;
  }

  const record = {
    id: crypto.randomUUID(),
    provider_host,
    api_key,
    expired_at:
      typeof body.expired_at === "string" && body.expired_at.trim()
        ? body.expired_at.trim()
        : null,
    error_code,
    error_detail,
    created_at: new Date().toISOString(),
  };

  list.push(record);
  await kv.put(DEAD_KEYS_KEY, JSON.stringify(list));
  return json({ ok: true, record });
}

async function handlePutDeadKey(request, env, url) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const id = getNonEmptyString(url, "id");
  if (!id) return json({ error: "id required" }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const kv = kvStore(env);
  const list = await readDeadKeys(kv);
  const idx = list.findIndex((r) => r && r.id === id);
  if (idx === -1) return json({ error: "Not Found" }, 404);

  const prev = list[idx];
  const next = { ...prev };

  if (typeof body.api_key === "string") {
    const api_key = body.api_key.trim();
    if (!api_key) return json({ error: "api_key must not be empty" }, 400);
    if (list.some((r, i) => i !== idx && r && r.api_key === api_key)) {
      return json({ error: "api_key already recorded", duplicated: true }, 409);
    }
    next.api_key = api_key;
  }
  if (typeof body.provider_host === "string") {
    const provider_host = body.provider_host.trim();
    if (!provider_host)
      return json({ error: "provider_host must not be empty" }, 400);
    next.provider_host = provider_host;
  }
  if (body.expired_at !== undefined) {
    next.expired_at =
      typeof body.expired_at === "string" && body.expired_at.trim()
        ? body.expired_at.trim()
        : null;
  }
  if (body.error_code !== undefined) {
    next.error_code = normalizeErrorCode(body.error_code);
  }
  if (body.error_detail !== undefined) {
    next.error_detail = normalizeErrorDetail(body.error_detail);
  }

  list[idx] = next;

  // Editing host or error_code moves the record between dedup groups. Without
  // rebalancing, the old group loses its only stored detail and the new group
  // can end up holding two copies.
  if (!sameDedupGroup(prev, next)) {
    if (prev.error_detail) {
      const heir = list.find(
        (r, i) => i !== idx && r && !r.error_detail && sameDedupGroup(r, prev),
      );
      if (heir) heir.error_detail = prev.error_detail;
    }
    if (
      next.error_detail &&
      list.some(
        (r, i) => i !== idx && r && r.error_detail && sameDedupGroup(r, next),
      )
    ) {
      next.error_detail = null;
    }
  }

  await kv.put(DEAD_KEYS_KEY, JSON.stringify(list));
  return json({ ok: true, record: next });
}

async function handleDeleteDeadKey(request, env, url) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const id = getNonEmptyString(url, "id");
  if (!id) return json({ error: "id required" }, 400);

  const kv = kvStore(env);
  const list = await readDeadKeys(kv);
  const removed = list.find((r) => r && r.id === id);
  if (!removed) return json({ error: "Not Found" }, 404);
  const next = list.filter((r) => !r || r.id !== id);

  // The deleted record may have been the only holder of its group's error_detail
  // (the rest were nulled by dedup) — hand it over so the group keeps its message.
  if (removed.error_detail) {
    const heir = next.find(
      (r) => r && !r.error_detail && sameDedupGroup(r, removed),
    );
    if (heir) heir.error_detail = removed.error_detail;
  }

  await kv.put(DEAD_KEYS_KEY, JSON.stringify(next));
  return json({ ok: true });
}
