/**
 * Cloudflare Pages API Gateway — async_test_keys edition
 *
 * KV bindings required:
 *   KV_STORE
 *     app_settings               { providers[], github_url, discord_webhook_url }
 *     results:{fingerprint}      per-provider latest test results
 *     checkpoint:{fingerprint}   per-provider in-progress checkpoint
 *     dead_keys                  synced dead key records (array)
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
  "PUT /api/dead-keys": handlePutDeadKey,
  "DELETE /api/dead-keys": handleDeleteDeadKey,
  "GET /api/proxy/state": handleGetProxyState,
  "POST /api/proxy/test": handleProxyTest,
  "POST /api/proxy/recover": handleProxyRecover,
  "POST /api/proxy/test-model": handleProxyTestModel,
  "GET /api/storage/export": handleStorageExport,
  "POST /api/storage/migrate": handleStorageMigrate,
  "POST /api/storage/restore": handleStorageRestore,
};

/**
 * A `_headers` file cannot do this job: Cloudflare does not apply it to
 * responses produced by Pages Functions, and in advanced mode that is every
 * response, including the ones handed back from env.ASSETS.fetch(). So the
 * headers are attached here instead, on the way out.
 *
 * CSP notes, each of which fails silently if broken:
 *   script-src 'self'  — index.html must keep its pre-paint script in boot.js;
 *                        an inline <script> would need a hash that goes stale.
 *   style-src 'self'   — no style="" attributes anywhere, including the strings
 *                        app.js builds for innerHTML. Writing element.style from
 *                        JS is fine, CSP does not cover CSSOM.
 *   img-src data:      — the favicon is an inline SVG data URI.
 *   connect-src        — the Discord test button posts straight from the page to
 *                        the webhook URL the user typed. Only Discord's own hosts
 *                        are allowed; a webhook behind any other domain (a relay,
 *                        a proxy) will be blocked and needs adding here.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://discord.com https://discordapp.com",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), " +
    "magnetometer=(), microphone=(), payment=(), usb=()",
};

function withSecurityHeaders(response) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(name, value);
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/");
    const isProxy = url.pathname.startsWith("/proxy/");

    if (!isApi && !isProxy) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }

    // Pages Functions have no startup phase, so a bad storage setting can only be
    // reported per request. Static assets stay reachable on purpose — the page
    // itself has to load, otherwise the operator sees a blank 500 instead of the
    // reason. /api/storage/* is exempt: export only needs KV and is exactly what
    // an operator reaches for when the backend is misconfigured.
    if (isApi && !url.pathname.startsWith("/api/storage/")) {
      const configError = storageConfigError(env);
      if (configError) {
        return withSecurityHeaders(
          json({ error: configError, code: "CONFIG_ERROR" }, 500),
        );
      }
    }

    if (isProxy) {
      try {
        return withSecurityHeaders(await handleProxy(request, env, url));
      } catch (err) {
        if (err && err.code === "CONFIG_ERROR") {
          return withSecurityHeaders(json({ error: err.message }, 500));
        }
        console.error(err);
        return withSecurityHeaders(
          json({ error: "Internal Server Error" }, 500),
        );
      }
    }

    const key = `${request.method} ${url.pathname}`;
    const handler = ROUTES[key];
    if (!handler) return withSecurityHeaders(text("Not Found", 404));

    try {
      if (!url.pathname.startsWith("/api/storage/")) {
        const configError = storageConfigError(env);
        if (configError) {
          return withSecurityHeaders(
            json({ error: configError, code: "CONFIG_ERROR" }, 500),
          );
        }
      }
      return withSecurityHeaders(await handler(request, env, url));
    } catch (err) {
      if (err && err.code === "CONFIG_ERROR") {
        return withSecurityHeaders(json({ error: err.message }, 500));
      }
      console.error(err);
      return withSecurityHeaders(json({ error: "Internal Server Error" }, 500));
    }
  },
};

// ─── storage backend (KV ⇄ D1) ─────────────────────────────────────────────
// STORAGE_BACKEND defaults to d1 on purpose: the proxy needs single-row atomic
// updates (key_state), which KV's final consistency and 1,000 writes/day cannot
// provide. Existing KV-only deployments must set STORAGE_BACKEND=kv explicitly
// until they have created D1, bound it as DB and run the migration — deploying
// without that order turns every /api request into a 500.

const D1_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS key_state (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "fp TEXT NOT NULL, " +
    "api_key TEXT NOT NULL, " +
    "last_used_at INTEGER, " +
    "fail_count INTEGER NOT NULL DEFAULT 0, " +
    "disabled INTEGER NOT NULL DEFAULT 0, " +
    "updated_at INTEGER NOT NULL, " +
    "UNIQUE (fp, api_key))",
  "CREATE INDEX IF NOT EXISTS idx_key_state_pick " +
    "ON key_state (fp, disabled, last_used_at)",
];

async function ensureSchema(db) {
  for (const sql of D1_SCHEMA) await db.prepare(sql).run();
}

function storageBackendName(env) {
  const raw = env.STORAGE_BACKEND;
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return name || "d1";
}

function hasD1(env) {
  return !!env.DB && typeof env.DB.prepare === "function";
}

function hasKv(env) {
  return !!env.KV_STORE && typeof env.KV_STORE.get === "function";
}

/** Returns a human-readable reason when the configured backend cannot work. */
function storageConfigError(env) {
  const name = storageBackendName(env);
  const raw = typeof env.STORAGE_BACKEND === "string" ? env.STORAGE_BACKEND.trim() : "";
  if (name !== "d1" && name !== "kv") {
    return `STORAGE_BACKEND=${raw} 无效；只能填 d1 或 kv`;
  }
  if (name === "d1" && !hasD1(env)) {
    return raw
      ? "STORAGE_BACKEND=d1 但没有绑定 D1 数据库 DB"
      : "STORAGE_BACKEND=d1（未设定时的预设值）但没有绑定 D1 数据库 DB";
  }
  if (name === "kv" && !hasKv(env)) {
    return "STORAGE_BACKEND=kv 但没有绑定 KV 命名空间 KV_STORE";
  }
  return null;
}

/** KV-shaped adapter over the D1 `store` table: get / put / delete / list.
 *  The rest of this file stays backend-agnostic because these are the only four
 *  operations the existing data model ever uses. */
function d1Store(env) {
  if (!hasD1(env)) {
    const err = new Error(
      "STORAGE_BACKEND=d1 but no D1 database is bound as DB",
    );
    err.code = "CONFIG_ERROR";
    throw err;
  }
  const db = env.DB;
  return {
    async get(k) {
      await ensureSchemaFor(db);
      const row = await db
        .prepare("SELECT v FROM store WHERE k = ?")
        .bind(k)
        .first();
      return row ? row.v : null;
    },
    async put(k, v) {
      await ensureSchemaFor(db);
      await db
        .prepare(
          "INSERT INTO store (k, v) VALUES (?, ?) " +
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        )
        .bind(k, v)
        .run();
    },
    async delete(k) {
      await ensureSchemaFor(db);
      await db.prepare("DELETE FROM store WHERE k = ?").bind(k).run();
    },
    async list({ prefix = "", cursor = null, limit = 1000 } = {}) {
      await ensureSchemaFor(db);
      const n = Math.min(Math.max(Number(limit) || 1000, 1), 1000);
      const rows = await db
        .prepare(
          "SELECT k FROM store " +
            "WHERE (? = '' OR substr(k, 1, length(?)) = ?) " +
            "AND (? IS NULL OR k > ?) " +
            "ORDER BY k LIMIT ?",
        )
        .bind(prefix, prefix, prefix, cursor, cursor, n)
        .all();
      const keys = (rows.results || []).map((r) => ({ name: r.k }));
      const complete = keys.length < n;
      return {
        keys,
        list_complete: complete,
        cursor: complete ? null : keys[keys.length - 1].name,
      };
    },
  };
}

function kvStore(env) {
  if (!hasKv(env)) {
    const err = new Error("KV_STORE is not configured");
    err.code = "CONFIG_ERROR";
    throw err;
  }
  return env.KV_STORE;
}

/** The one entry point every handler uses for settings / results / checkpoint /
 *  dead_keys. The proxy's own key_state table is SQL-only and lives in D1. */
function store(env) {
  return storageBackendName(env) === "d1" ? d1Store(env) : kvStore(env);
}

/** KV `list()` is paginated for real namespaces; migration must walk every page. */
async function listAllEntries(source) {
  const entries = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await source.list({ cursor, limit: 1000 });
    pages++;
    for (const key of page.keys || []) {
      const name = key && key.name;
      if (!name) continue;
      const value = await source.get(name);
      if (value !== null && value !== undefined) {
        entries.push({ k: name, v: value });
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { entries, pages };
}

function parseJsonObject(raw) {
  const parsed = parseJsonOrNull(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : null;
}

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
  version: 0,
};

function settingsVersion(settings) {
  return typeof settings.version === "number" ? settings.version : 0;
}

// `/proxy/{alias}` is matched as the first path segment, so an alias has to be a
// single lowercase segment. Validated at save time: a bad alias must fail with a
// 400 here, not turn into a mystery 404 at forward time.
const PROXY_ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Trim the two proxy fields and drop them when empty so old providers keep the
 *  exact shape they had before this feature existed. */
function normalizeProviderForStorage(p) {
  if (!p || typeof p !== "object") return p;
  const out = { ...p };
  if (typeof p.alias === "string") {
    const alias = p.alias.trim();
    if (alias) out.alias = alias;
    else delete out.alias;
  }
  if (typeof p.gateway_provider === "string") {
    const slug = p.gateway_provider.trim();
    if (slug) out.gateway_provider = slug;
    else delete out.gateway_provider;
  }
  return out;
}

// Only these three provider families are supported. `ollama` was removed on
// purpose: its auth header and payload shape differ enough that keeping it
// around produced a half-supported format with no data to migrate.
const PROVIDER_TYPES = new Set(["openai", "gemini", "anthropic"]);

function validateProviderTypes(providers) {
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p || typeof p !== "object") continue;
    const type = typeof p.provider_type === "string" ? p.provider_type.trim() : "";
    if (!type) return `providers[${i}].provider_type 不能为空`;
    if (!PROVIDER_TYPES.has(type)) {
      return `providers[${i}].provider_type "${type}" 不支援；只能是 ${[...PROVIDER_TYPES].join(" / ")}`;
    }
  }
  return null;
}

/** Every provider must keep at least one key: a keyless card can never be
 *  forwarded and would silently sit in the notebook forever. The editor already
 *  refuses it (app.js); this closes the curl/write-API path as well. */
/** `proxy_test_models` is a { fingerprint: model } map kept *outside* providers[]:
 *  the proxy probe model is its own setting and must not inherit the daily-test
 *  model list. Empty values are dropped so the map stays small. */
function normalizeProxyTestModels(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [fp, model] of Object.entries(raw)) {
    if (typeof fp !== "string" || !fp || typeof model !== "string") continue;
    const trimmed = model.trim();
    if (trimmed) out[fp] = trimmed;
  }
  return out;
}

function validateProviderKeys(providers) {
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p || typeof p !== "object") continue;
    if (!providerKeys(p).length) {
      return `providers[${i}] 没有任何 API Key；至少要保留一把，要停用请把 enabled 设为 false`;
    }
  }
  return null;
}

function validateProviderAliases(providers) {
  const seen = new Set();
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p || typeof p !== "object") continue;
    const alias = p.alias;
    if (alias === undefined || alias === null || alias === "") continue;
    if (typeof alias !== "string") {
      return `providers[${i}].alias 必须是字符串`;
    }
    if (!PROXY_ALIAS_RE.test(alias)) {
      return `providers[${i}].alias "${alias}" 格式不正确：只能用小写英文、数字与连字号，且不超过 64 个字元`;
    }
    if (seen.has(alias)) {
      return `providers[${i}].alias "${alias}" 与其他服务商重复`;
    }
    seen.add(alias);
  }
  return null;
}

async function handleGetSettings(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);
  const kv = store(env);
  const raw = await kv.get(SETTINGS_KEY);
  const settings = parseJsonOrNull(raw) || { ...DEFAULT_SETTINGS };
  settings.version = settingsVersion(settings);
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
        ? body.github_url
        : existing.github_url,
    discord_webhook_url:
      typeof body.discord_webhook_url === "string"
        ? body.discord_webhook_url
        : existing.discord_webhook_url,
    proxy_test_models: normalizeProxyTestModels(
      body.proxy_test_models !== undefined
        ? body.proxy_test_models
        : existing.proxy_test_models,
    ),
    version: currentVersion + 1,
  };

  const aliasError = validateProviderAliases(next.providers || []);
  if (aliasError) return json({ error: aliasError }, 400);

  const typeError = validateProviderTypes(next.providers || []);
  if (typeError) return json({ error: typeError }, 400);

  const keyError = validateProviderKeys(next.providers || []);
  if (keyError) return json({ error: keyError }, 400);

  // Drop test-model entries whose provider no longer exists, so editing api_base
  // (new fingerprint) or deleting a provider cannot leave the map growing.
  const liveFps = new Set(
    await Promise.all(
      (next.providers || [])
        .filter((p) => p && p.provider_type?.trim() && p.api_base?.trim())
        .map((p) =>
          providerFingerprint(p.provider_type.trim(), p.api_base.trim()),
        ),
    ),
  );
  next.proxy_test_models = Object.fromEntries(
    Object.entries(next.proxy_test_models).filter(([fp]) => liveFps.has(fp)),
  );

  await kv.put(SETTINGS_KEY, JSON.stringify(next));

  // key_state mirrors the settings key list, so removals and fingerprint changes
  // are reconciled right here. Doing it lazily at forward time would leave stale
  // rows behind forever on a site nobody calls. A failure here must not roll back
  // the settings write that already succeeded.
  try {
    await syncKeyState(env, next.providers || []);
  } catch (err) {
    console.error("key_state sync failed", err);
  }

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

  return json({ ok: true, version: next.version });
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

  const kv = store(env);
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
  const kv = store(env);
  const payload = { ...body, uploaded_at: new Date().toISOString() };
  await kv.put(`results:${fp}`, JSON.stringify(payload));
  // Auto-clean checkpoint so frontend won't show stale "执行中"
  await kv.delete(`checkpoint:${fp}`);

  // Best-effort: the results are already stored, so a failure here must not make
  // the uploader think the whole run was lost and retry it.
  let synced = { added: 0, removed: 0, updated: 0 };
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
  // The daily run is the authority on key health: keys reported as valid get their
  // proxy ledger cleared. Best-effort like the dead-key sync — the results are
  // already stored, so a failure here must not look like a lost run.
  let recovered = 0;
  try {
    recovered = await recoverKeysFromResults(env, fp, body.valid_keys);
  } catch (err) {
    console.error("key_state recovery failed", err);
  }

  return json({
    ok: true,
    fingerprint: fp,
    dead_keys_added: synced.added,
    dead_keys_removed: synced.removed,
    dead_keys_updated: synced.updated,
    keys_recovered: recovered,
  });
}

// ─── /api/checkpoint ─────────────────────────────────────────────────────────

async function handleGetCheckpoint(request, env, url) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const fp = getNonEmptyString(url, "fp");
  if (!fp) return json({ error: "fp (fingerprint) required" }, 400);

  const kv = store(env);
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
  const kv = store(env);
  const payload = { ...body, saved_at: new Date().toISOString() };
  await kv.put(`checkpoint:${fp}`, JSON.stringify(payload));
  return json({ ok: true, fingerprint: fp });
}

async function handleDeleteCheckpoint(request, env, url) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const fp = getNonEmptyString(url, "fp");
  if (!fp) return json({ error: "fp (fingerprint) required" }, 400);

  const kv = store(env);
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

/** Hand error_detail from removed records to a remaining sibling in the same
 *  host+code group. Dedup stores the message on one row only, so deleting that
 *  holder without this step would blank the group's 📋 for everyone left. */
function rebalanceErrorDetail(removed, remaining) {
  for (const gone of removed) {
    if (!gone || !gone.error_detail) continue;
    if (remaining.some((r) => r && r.error_detail && sameDedupGroup(r, gone))) {
      continue;
    }
    const heir = remaining.find(
      (r) => r && !r.error_detail && sameDedupGroup(r, gone),
    );
    if (heir) heir.error_detail = gone.error_detail;
  }
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

/** Flatten a result record into the stored error_detail shape. Prefer the
 *  structured object; fall back to {message: error_reason} so 📋 still has
 *  something when the provider returned no body. */
function extractRecordDetail(rec) {
  if (!rec) return null;
  const detail = normalizeErrorDetail(rec.error_detail);
  if (detail) return detail;
  if (rec.error_reason) return { message: String(rec.error_reason) };
  return null;
}

/** Compare normalized error_detail objects by sorted keys so insertion order
 *  cannot trigger a false "updated" write. */
function areErrorDetailsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (k !== keysB[i]) return false;
    if (String(a[k]) !== String(b[k])) return false;
  }
  return true;
}

/** Providers store keys as a newline-separated string (normalizeKeys in app.js),
 *  not an array. Union every card on this host so one upload cannot drop another
 *  card's still-configured dead keys. */
function collectConfiguredKeysForHost(settings, provider_host) {
  const keys = new Set();
  const providers = Array.isArray(settings?.providers) ? settings.providers : [];
  for (const p of providers) {
    if (!p || typeof p.api_base !== "string" || typeof p.keys !== "string") continue;
    try {
      if (new URL(p.api_base.trim()).hostname !== provider_host) continue;
    } catch {
      continue;
    }
    for (const line of p.keys.split("\n")) {
      const k = line.trim();
      if (k) keys.add(k);
    }
  }
  return keys;
}

/** Reconcile the dead key list against one test run and the current 来源设定.
 *  The list means "keys currently failing in source", not a permanent ledger —
 *  which is what lets us record any failure code, since a transient one (429,
 *  500, 全网皆败) clears itself on the next successful run. A key dropped from
 *  来源设定 is also dropped here (ghost cleanup). 来源设定 itself is never
 *  rewritten by this path. Existing records keep id/expired_at/created_at;
 *  error_code and error_detail are refreshed in two stages so Python's
 *  per-cause holder (often a different key) cannot wipe or skip the KV holder. */
async function syncDeadKeysFromResults(
  kv,
  api_base,
  validKeys,
  invalidRecords,
  uploadedAt,
) {
  const none = { added: 0, removed: 0, updated: 0 };

  let provider_host;
  try {
    provider_host = new URL(api_base).hostname;
  } catch {
    return none;
  }
  if (!provider_host) return none;

  const [rawDeadKeys, rawSettings] = await Promise.all([
    kv.get(DEAD_KEYS_KEY),
    kv.get(SETTINGS_KEY),
  ]);
  let list = parseJsonOrNull(rawDeadKeys);
  if (!Array.isArray(list)) list = [];

  // KV miss or corrupt JSON must not look like "source is empty" — that would
  // wipe every dead key on this host. A real {providers:[]} is available and
  // correctly means nothing is configured.
  const settingsParsed = parseJsonOrNull(rawSettings);
  const settingsAvailable =
    !!rawSettings &&
    !!settingsParsed &&
    typeof settingsParsed === "object" &&
    !Array.isArray(settingsParsed);
  const configuredKeysForHost = settingsAvailable
    ? collectConfiguredKeysForHost(settingsParsed, provider_host)
    : null;

  const recovered = new Set(
    (Array.isArray(validKeys) ? validKeys : [])
      .filter((k) => typeof k === "string")
      .map((k) => k.trim())
      .filter(Boolean),
  );

  const keep = [];
  const dropped = [];
  for (const r of list) {
    if (!r || r.provider_host !== provider_host) {
      keep.push(r);
      continue;
    }
    const key = typeof r.api_key === "string" ? r.api_key.trim() : "";
    const isRecovered = key && recovered.has(key);
    const isRemovedFromSettings =
      settingsAvailable && key && !configuredKeysForHost.has(key);
    if (isRecovered || isRemovedFromSettings) dropped.push(r);
    else keep.push(r);
  }
  if (dropped.length) rebalanceErrorDetail(dropped, keep);

  const invList = Array.isArray(invalidRecords) ? invalidRecords : [];
  const invMap = new Map();
  // First non-empty detail per error_code from this upload. Python only stores
  // error_detail on one key per (code, normalized message), which is often not
  // the same key as the KV group's current holder.
  const newGroupDetails = new Map();

  for (const rec of invList) {
    if (!rec || typeof rec.api_key !== "string" || !rec.api_key.trim()) continue;
    const key = rec.api_key.trim();
    invMap.set(key, rec);

    const code = normalizeErrorCode(rec.error_code);
    if (!newGroupDetails.has(code)) {
      const d = extractRecordDetail(rec);
      if (d) newGroupDetails.set(code, d);
    }
  }

  let codeUpdates = 0;
  let detailUpdates = 0;

  // Stage 1: migrate error_code per key. Hand off the old group's detail
  // immediately — waiting until the end would drop it if several keys leave
  // the same group in one pass.
  for (let i = 0; i < keep.length; i++) {
    const r = keep[i];
    if (!r || r.provider_host !== provider_host) continue;

    const recKey = typeof r.api_key === "string" ? r.api_key.trim() : "";
    if (!recKey) continue;
    const newRec = invMap.get(recKey);
    if (!newRec) continue;

    const nextCode = normalizeErrorCode(newRec.error_code);
    if (normalizeErrorCode(r.error_code) === nextCode) continue;

    if (r.error_detail) {
      const heir = keep.find(
        (other, oi) =>
          oi !== i && other && !other.error_detail && sameDedupGroup(other, r),
      );
      if (heir) heir.error_detail = r.error_detail;
    }
    r.error_code = nextCode;
    r.error_detail = null;
    codeUpdates++;
  }

  // Stage 2: one holder per (host, code); refresh from this upload's
  // representative detail. A missing body must not wipe an existing 📋.
  const hostCodes = new Set();
  for (const r of keep) {
    if (r && r.provider_host === provider_host) {
      hostCodes.add(normalizeErrorCode(r.error_code));
    }
  }

  for (const code of hostCodes) {
    const siblings = keep.filter(
      (r) =>
        r &&
        r.provider_host === provider_host &&
        normalizeErrorCode(r.error_code) === code,
    );
    if (!siblings.length) continue;

    const holder = siblings.find((s) => s.error_detail) || siblings[0];
    for (const s of siblings) {
      if (s !== holder && s.error_detail) s.error_detail = null;
    }

    if (newGroupDetails.has(code)) {
      const fresh = newGroupDetails.get(code);
      if (!areErrorDetailsEqual(holder.error_detail, fresh)) {
        holder.error_detail = fresh;
        detailUpdates++;
      }
    }
  }

  const listNext = keep;
  const removed = dropped.length;
  let added = 0;

  // Keys that failed get recorded. expired_at is stored as the calendar day at
  // midnight UTC — the same shape date-only edits use (toIsoDay in app.js) —
  // because the UI reads it as a date; the precise moment stays in created_at.
  const expired_at = `${String(uploadedAt).slice(0, 10)}T00:00:00.000Z`;
  const known = new Set();
  for (const r of listNext) {
    if (r && typeof r.api_key === "string" && r.api_key.trim()) {
      known.add(r.api_key.trim());
    }
  }

  for (const rec of invList) {
    if (!rec || typeof rec.api_key !== "string" || !rec.api_key.trim()) continue;
    const api_key = rec.api_key.trim();
    if (known.has(api_key)) continue;
    // Source is the unique standard: a key already gone from 来源设定 must not
    // be re-recorded from a stale in-flight run.
    if (settingsAvailable && !configuredKeysForHost.has(api_key)) continue;

    const error_code = normalizeErrorCode(rec.error_code);
    const hasHolder = listNext.some(
      (r) => r && r.error_detail && sameDedupGroup(r, { provider_host, error_code }),
    );
    const error_detail = hasHolder
      ? null
      : newGroupDetails.get(error_code) || extractRecordDetail(rec);

    listNext.push({
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

  const updated = codeUpdates + detailUpdates;
  if (added || removed || updated) {
    await kv.put(DEAD_KEYS_KEY, JSON.stringify(listNext));
  }
  return { added, removed, updated };
}

async function handleGetDeadKeys(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);
  const kv = store(env);
  return json({ ok: true, dead_keys: await readDeadKeys(kv) });
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

  const kv = store(env);
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

async function collectDeleteIds(request, url) {
  const ids = [];
  const seen = new Set();
  const add = (v) => {
    if (typeof v !== "string") return;
    const t = v.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    ids.push(t);
  };
  for (const v of url.searchParams.getAll("id")) add(v);

  let text = "";
  try {
    text = (await request.text()).trim();
  } catch {
    // Empty or unreadable body
  }

  if (text) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ids, invalidJson: true };
    }
    if (Array.isArray(body?.ids)) body.ids.forEach(add);
    else if (typeof body?.id === "string") add(body.id);
  }

  return { ids, invalidJson: false };
}

async function handleDeleteDeadKey(request, env, url) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const { ids, invalidJson } = await collectDeleteIds(request, url);
  if (invalidJson) return json({ error: "Invalid JSON" }, 400);
  if (!ids.length) return json({ error: "id required" }, 400);

  const kv = store(env);
  const list = await readDeadKeys(kv);
  const idSet = new Set(ids);
  const removed = [];
  const next = [];
  for (const r of list) {
    if (r && idSet.has(r.id)) removed.push(r);
    else next.push(r);
  }
  if (!removed.length) return json({ error: "Not Found" }, 404);

  // dead_keys is one KV value, so N ids still cost 1 get + 1 put — the whole
  // point of accepting a list instead of N single-id DELETEs.
  rebalanceErrorDetail(removed, next);

  await kv.put(DEAD_KEYS_KEY, JSON.stringify(next));
  return json({ ok: true, deleted: removed.length, dead_keys: next });
}

// ─── shared proxy helpers ───────────────────────────────────────────────────

// Fetch already decodes the body, so re-streaming it while keeping the upstream
// Content-Encoding / Content-Length would make the browser try to decode plain
// text. Hop-by-hop headers are connection-scoped and must not be relayed at all.
const DROP_UPSTREAM_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding",
  // Cloudflare request metadata and caller-IP headers: the upstream is a third
  // party, it has no business seeing which edge served the request or who the
  // original caller was (verified by probe-headers: they were passed through).
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "true-client-ip",
]);

// Credential headers are always replaced by the selected key. Letting a caller
// keep its own Authorization would make the key rotation meaningless (and leak
// whatever it sent to the upstream).
const CALLER_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "anthropic-version",
]);

// One rule, no per-status guessing: every non-2xx response counts as a failure
// and moves on to the next key. That keeps 400 (Gemini returns it for an invalid
// key), 401, 403, 429 and 5xx on the same path instead of trying to infer whose
// fault each code is. The trade-off is explicit: a provider-wide outage, or one
// malformed body, charges every key it touches — the daily test result puts
// those keys back (see recoverKeysFromResults) and the card shows the counters.

/** Head/tail mask for keys: left 6 + 1..3 asterisks + right 3 (<=9 shown as-is).
 *  Keep this function identical to the one in `app.js`. */
function maskKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 9) return s;
  const stars = "*".repeat(Math.min(s.length - 9, 3));
  return `${s.slice(0, 6)}${stars}${s.slice(-3)}`;
}

/** cf-aig-metadata travels as an HTTP header, so its value must be ASCII only.
 *  A non-ASCII byte (the document's example was "…") makes fetch throw before
 *  the request leaves the worker. */
function metadataKeyTag(apiKey) {
  const ascii = String(apiKey || "").replace(/[^\x21-\x7e]/g, "");
  if (!ascii) return "key";
  // Never reveal more than the UI mask. Short keys are rare, but a 4+4 tag on a
  // 5-character key would spell out the whole secret in the Gateway logs.
  if (ascii.length < 16) {
    return `${ascii.slice(0, 1)}***${ascii.slice(-1)}`;
  }
  return `${ascii.slice(0, 4)}-${ascii.slice(-4)}`;
}

function providerKeys(provider) {
  if (!provider || typeof provider.keys !== "string") return [];
  return provider.keys
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean);
}

function providerModels(provider) {
  if (!provider || typeof provider.models !== "string") return [];
  return provider.models
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

function parseExtraBody(provider) {
  if (!provider || typeof provider.extra_body !== "string") return null;
  const raw = provider.extra_body.trim();
  if (!raw) return null;
  const parsed = parseJsonOrNull(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : null;
}

function applyProviderAuth(headers, providerType, apiKey) {
  switch (providerType) {
    case "gemini":
      headers.set("x-goog-api-key", apiKey);
      break;
    case "anthropic":
      headers.set("x-api-key", apiKey);
      headers.set("anthropic-version", "2023-06-01");
      break;
    case "openai":
    default:
      headers.set("Authorization", `Bearer ${apiKey}`);
      break;
  }
}

/** Direct upstream or AI Gateway custom-provider. The custom provider's base_url
 *  is registered as the provider's api_base, so `custom-{slug}` + caller path
 *  lands on exactly the same URL as the direct call. No per-type append logic. */
function upstreamFor(env, provider) {
  const slug =
    typeof provider.gateway_provider === "string"
      ? provider.gateway_provider.trim()
      : "";
  const account = (env.AI_GATEWAY_ACCOUNT_ID || "").trim();
  const gateway = (env.AI_GATEWAY_ID || "").trim();
  const token = (env.AI_GATEWAY_TOKEN || "").trim();
  if (slug && account && gateway && token) {
    return {
      kind: "gateway",
      token,
      base:
        `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(account)}` +
        `/${encodeURIComponent(gateway)}/custom-${encodeURIComponent(slug)}`,
    };
  }
  return {
    kind: "direct",
    base: String(provider.api_base || "").trim().replace(/\/+$/, ""),
  };
}

function targetUrl(upstream, subPathAndQuery) {
  const suffix = subPathAndQuery.startsWith("/")
    ? subPathAndQuery
    : subPathAndQuery
      ? `/${subPathAndQuery}`
      : "";
  return `${upstream.base}${suffix}`;
}

function copyUpstreamHeaders(response) {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    const lower = name.toLowerCase();
    if (DROP_UPSTREAM_HEADERS.has(lower)) continue;
    if (lower === "set-cookie") continue;
    if (lower.startsWith("cf-aig-")) continue;
    headers.append(name, value);
  }
  return headers;
}

function buildForwardHeaders(env, provider, alias, apiKey, incoming, upstream) {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    const lower = name.toLowerCase();
    if (DROP_UPSTREAM_HEADERS.has(lower)) continue;
    if (CALLER_CREDENTIAL_HEADERS.has(lower)) continue;
    if (lower === "cookie") continue;
    if (lower.startsWith("cf-aig-")) continue;
    headers.append(name, value);
  }

  applyProviderAuth(headers, provider.provider_type, apiKey);

  // Custom headers come after auth on purpose, matching async_test_keys.py:
  // a deliberately configured header is allowed to override the default.
  if (Array.isArray(provider.custom_headers)) {
    for (const h of provider.custom_headers) {
      const key = typeof h?.key === "string" ? h.key.trim() : "";
      if (!key) continue;
      const value = String(h?.value ?? "").replace(/[\r\n]/g, "");
      try {
        headers.set(key, value);
      } catch {
        // Invalid name/value written by hand (curl); skip instead of failing the
        // whole forward request.
      }
    }
  }

  if (upstream.kind === "gateway") {
    headers.set("cf-aig-authorization", `Bearer ${upstream.token}`);
    headers.set("cf-aig-skip-cache", "true");
    headers.set("cf-aig-max-attempts", "1");
    headers.set(
      "cf-aig-request-timeout",
      String(proxyTimeoutMs(env)),
    );
    headers.set(
      "cf-aig-metadata",
      JSON.stringify({ key: metadataKeyTag(apiKey), provider: alias }),
    );
  }

  return headers;
}

function proxyTimeoutMs(env) {
  const n = parseInt(env.PROXY_UPSTREAM_TIMEOUT_MS, 10);
  if (!Number.isFinite(n)) return 120000;
  return Math.min(Math.max(n, 1000), 600000);
}

function proxyFailThreshold(env) {
  const n = parseInt(env.PROXY_FAIL_THRESHOLD, 10);
  if (!Number.isFinite(n) || n < 1) return 3;
  return n;
}

// The document caps retries at 3 (4 keys per request), well under the free
// plan's 50-subrequest ceiling. Clamp rather than trust the deployment setting.
function proxyMaxRetries(env) {
  const n = parseInt(env.PROXY_MAX_RETRIES, 10);
  if (!Number.isFinite(n) || n < 0) return 3;
  return Math.min(n, 3);
}

function proxyCredential(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return (
    request.headers.get("x-api-key") ||
    request.headers.get("x-goog-api-key") ||
    ""
  ).trim();
}

/** null when the proxy can serve requests, otherwise a human-readable reason. */
function proxyConfigError(env) {
  if (storageBackendName(env) !== "d1") {
    return "转发需要 STORAGE_BACKEND=d1（KV 模式无法即时维护密钥状态）";
  }
  const proxyPassword = (env.PROXY_PASSWORD || "").trim();
  if (!proxyPassword) {
    return "PROXY_PASSWORD 未设定，转发功能已停用";
  }
  const adminPassword = (env.ADMIN_PASSWORD || "").trim();
  if (adminPassword && timingSafeEqual(proxyPassword, adminPassword)) {
    return "PROXY_PASSWORD 不能与 ADMIN_PASSWORD 相同";
  }
  return null;
}

// ─── key_state (rotation + blacklist ledger) ────────────────────────────────

// D1 schema creation is memoized per binding object. Pages Functions have no
// startup hook, and a missing table must not block the first request — this also
// makes a freshly bound empty D1 usable without a separate init step.
const schemaReady = new WeakMap();
function ensureSchemaFor(db) {
  let ready = schemaReady.get(db);
  if (!ready) {
    ready = ensureSchema(db).catch((err) => {
      // Do not memoize a transient failure: the next request should retry.
      schemaReady.delete(db);
      throw err;
    });
    schemaReady.set(db, ready);
  }
  return ready;
}

async function syncKeyState(env, providers) {
  if (storageBackendName(env) !== "d1" || !hasD1(env)) return;
  const db = env.DB;
  await ensureSchemaFor(db);
  const now = Date.now();

  const wanted = [];
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
    for (const apiKey of providerKeys(p)) wanted.push({ fp, apiKey });
  }

  const identity = (row) => `${row.fp}\u0000${row.api_key}`;
  const current = await db
    .prepare("SELECT id, fp, api_key FROM key_state")
    .all();
  const rows = current.results || [];
  const wantedSet = new Set(wanted.map((w) => `${w.fp}\u0000${w.apiKey}`));
  const existingSet = new Set(rows.map(identity));

  const staleIds = rows.filter((r) => !wantedSet.has(identity(r))).map((r) => r.id);
  for (let i = 0; i < staleIds.length; i += 100) {
    const chunk = staleIds.slice(i, i + 100);
    const sql = `DELETE FROM key_state WHERE id IN (${chunk.map(() => "?").join(",")})`;
    await db.prepare(sql).bind(...chunk).run();
  }

  for (const w of wanted) {
    if (existingSet.has(`${w.fp}\u0000${w.apiKey}`)) continue;
    await db
      .prepare(
        "INSERT INTO key_state (fp, api_key, last_used_at, fail_count, disabled, updated_at) " +
          "VALUES (?, ?, NULL, 0, 0, ?) ON CONFLICT(fp, api_key) DO NOTHING",
      )
      .bind(w.fp, w.apiKey, now)
      .run();
  }
}

/** One atomic statement picks the least-recently-used enabled key and stamps it.
 *  Stamp-at-pick is required: stamping after success would let a retry loop pick
 *  the key that just failed, and a broken key would stay first forever. MAX(now,
 *  global max + 1) keeps two picks in the same millisecond strictly increasing. */
async function pickKeyRow(db, fp, excludeIds) {
  const now = Date.now();
  const excluded = Array.isArray(excludeIds) ? excludeIds : [];
  const notIn = excluded.length
    ? ` AND id NOT IN (${excluded.map(() => "?").join(",")})`
    : "";
  const sql =
    "UPDATE key_state " +
    "SET last_used_at = MAX(?, COALESCE((SELECT MAX(last_used_at) FROM key_state WHERE fp = ?), 0) + 1), " +
    "    updated_at = ? " +
    "WHERE id = (" +
    "  SELECT id FROM key_state " +
    "   WHERE fp = ? AND disabled = 0" +
    notIn +
    "   ORDER BY last_used_at, id LIMIT 1" +
    ") " +
    "RETURNING id, api_key, fail_count, disabled";
  const result = await db
    .prepare(sql)
    .bind(now, fp, now, fp, ...excluded)
    .all();
  return (result.results || [])[0] || null;
}

async function recordKeyFailure(db, id, threshold) {
  const result = await db
    .prepare(
      "UPDATE key_state " +
        "SET fail_count = fail_count + 1, " +
        "    disabled = CASE WHEN fail_count + 1 >= ? THEN 1 ELSE disabled END, " +
        "    updated_at = ? " +
        "WHERE id = ? RETURNING fail_count, disabled",
    )
    .bind(threshold, Date.now(), id)
    .all();
  return (result.results || [])[0] || null;
}

/**
 * The daily GHA run is the authority on whether a key is alive. When it reports a
 * key in `valid_keys`, clear that key's proxy ledger: a transient outage that
 * pushed fail_count to the threshold must not keep the key disabled forever.
 * Only the daily result recovers — a manual Test press does not write the ledger
 * (see handleProxyTest), so pressing the button can not paper over a dead key.
 * Returns the number of rows that actually changed.
 */
async function recoverKeysFromResults(env, fp, validKeys) {
  if (storageBackendName(env) !== "d1" || !hasD1(env)) return 0;
  const keys = (Array.isArray(validKeys) ? validKeys : [])
    .filter((k) => typeof k === "string")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!keys.length) return 0;

  const db = env.DB;
  await ensureSchemaFor(db);
  let recovered = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const sql =
      "UPDATE key_state SET disabled = 0, fail_count = 0, updated_at = ? " +
      "WHERE fp = ? AND (disabled <> 0 OR fail_count <> 0) " +
      `AND api_key IN (${chunk.map(() => "?").join(",")})`;
    const res = await db.prepare(sql).bind(Date.now(), fp, ...chunk).run();
    recovered += Number(res.meta?.changes || 0);
  }
  return recovered;
}

/** Insert a row for every key that has none yet; existing rows are untouched.
 *  Chunked because SQLite caps bound parameters. */
async function seedKeyRows(db, fp, keys, now) {
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const sql =
      "INSERT INTO key_state (fp, api_key, last_used_at, fail_count, disabled, updated_at) " +
      `VALUES ${chunk.map(() => "(?, ?, NULL, 0, 0, ?)").join(",")} ` +
      "ON CONFLICT(fp, api_key) DO NOTHING";
    const params = [];
    for (const key of chunk) params.push(fp, key, now);
    await db.prepare(sql).bind(...params).run();
  }
}

async function resetKeyFailure(db, id) {
  // Only write when there is something to reset: a success on an already-clean
  // key must not spend a D1 write on every single forwarded request.
  await db
    .prepare(
      "UPDATE key_state SET fail_count = 0, updated_at = ? WHERE id = ? AND fail_count <> 0",
    )
    .bind(Date.now(), id)
    .run();
}

// ─── /proxy/{alias}/… ───────────────────────────────────────────────────────

async function handleProxy(request, env, url) {
  const configError = proxyConfigError(env);
  if (configError) return json({ error: configError, code: "PROXY_DISABLED" }, 503);

  const proxyPassword = (env.PROXY_PASSWORD || "").trim();
  const credential = proxyCredential(request);
  if (!credential || !timingSafeEqual(credential, proxyPassword)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const prefix = "/proxy/";
  const rest = url.pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  let alias = slash === -1 ? rest : rest.slice(0, slash);
  try {
    alias = decodeURIComponent(alias);
  } catch {
    return json({ error: "Bad alias" }, 400);
  }
  const subPath = slash === -1 ? "" : rest.slice(slash);
  const pathAndQuery = `${subPath}${url.search}`;

  const kv = store(env);
  const settings = parseJsonObject(await kv.get(SETTINGS_KEY));
  const providers = Array.isArray(settings?.providers) ? settings.providers : [];
  const provider = providers.find(
    (p) => p && typeof p.alias === "string" && p.alias === alias,
  );
  if (!provider) return json({ error: "Unknown proxy alias" }, 404);
  if (provider.enabled === false) {
    return json({ error: "Provider is disabled" }, 503);
  }

  const db = env.DB;
  await ensureSchemaFor(db);
  const fp = await providerFingerprint(
    String(provider.provider_type || "").trim(),
    String(provider.api_base || "").trim(),
  );
  const upstream = upstreamFor(env, provider);
  const target = targetUrl(upstream, pathAndQuery);
  const timeoutMs = proxyTimeoutMs(env);
  const threshold = proxyFailThreshold(env);
  const maxRetries = proxyMaxRetries(env);

  const rawBody =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.arrayBuffer();
  const contentType = request.headers.get("content-type") || "";
  const isJson = /^application\/json\b/i.test(contentType);
  const extraBody = parseExtraBody(provider);
  const attemptBody = () => {
    if (rawBody === null) return undefined;
    if (!isJson || !extraBody) return rawBody;
    try {
      const decoded = new TextDecoder().decode(rawBody);
      const parsed = JSON.parse(decoded);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return rawBody;
      }
      return JSON.stringify({ ...parsed, ...extraBody });
    } catch {
      return rawBody;
    }
  };

  const tried = new Set();
  const notebookKeys = providerKeys(provider);
  let lastFailure = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let keyRow = await pickKeyRow(db, fp, [...tried]);

    // Ghost guard (B′): the notebook is the authority on *which* keys may be
    // used; key_state only carries their counters. A row whose key was deleted
    // from the notebook but never pruned (sync failed) must never reach the
    // upstream — drop it and pick again. Happy path costs nothing extra.
    for (let ghosts = 0; keyRow && ghosts < 5; ghosts++) {
      if (notebookKeys.includes(keyRow.api_key)) break;
      try {
        await db.prepare("DELETE FROM key_state WHERE id = ?").bind(keyRow.id).run();
      } catch (dbErr) {
        console.error("ghost key_state row cleanup failed", dbErr);
      }
      keyRow = await pickKeyRow(db, fp, [...tried]);
    }

    // Opposite direction: the notebook lists keys but the ledger has no row at
    // all (sync failed on insert). Seed once and pick again. Partial gaps are
    // not detected here on purpose — they are safe (a key that is missing a row
    // simply gets no traffic) and the card shows `synced: false`.
    if (!keyRow && notebookKeys.length) {
      const count = await db
        .prepare("SELECT COUNT(*) AS n FROM key_state WHERE fp = ?")
        .bind(fp)
        .first();
      if (!count || Number(count.n) === 0) {
        await seedKeyRows(db, fp, notebookKeys, Date.now());
        keyRow = await pickKeyRow(db, fp, [...tried]);
      }
    }

    if (!keyRow) {
      if (!lastFailure) {
        return json(
          { error: "暂无可用的 Key（全部已禁用或无金钥）", code: "NO_KEYS" },
          503,
        );
      }
      break;
    }
    tried.add(keyRow.id);

    const headers = buildForwardHeaders(
      env,
      provider,
      alias,
      keyRow.api_key,
      request.headers,
      upstream,
    );

    // The timeout covers "time to first byte", not the stream: a chat completion
    // can legitimately stream for minutes, and AbortSignal.timeout would cut the
    // body mid-stream. Clear the timer as soon as the headers arrive.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        body: attemptBody(),
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      try {
        await recordKeyFailure(db, keyRow.id, threshold);
      } catch (dbErr) {
        console.error("key_state failure write failed", dbErr);
      }
      lastFailure = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Upstream request failed",
          detail: String((err && err.message) || err),
        }),
      };
      continue;
    }

    if (response.ok) {
      try {
        await resetKeyFailure(db, keyRow.id);
      } catch (dbErr) {
        console.error("key_state reset failed", dbErr);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: copyUpstreamHeaders(response),
      });
    }

    // Every non-2xx lands here: charge the key and move on to the next one (the
    // single rule explained above maskKey). The body is buffered because it has to
    // be consumed before the next attempt, while the last one is returned verbatim.
    try {
      await recordKeyFailure(db, keyRow.id, threshold);
    } catch (dbErr) {
      console.error("key_state failure write failed", dbErr);
    }
    lastFailure = {
      status: response.status,
      headers: copyUpstreamHeaders(response),
      body: await response.text(),
    };
  }

  if (!lastFailure) {
    return json({ error: "暂无可用的 Key", code: "NO_KEYS" }, 503);
  }
  return new Response(lastFailure.body, {
    status: lastFailure.status,
    headers: lastFailure.headers,
  });
}

// ─── /api/proxy/state ──────────────────────────────────────────────────────

const SAMPLE_PATHS = {
  openai: "/chat/completions",
  gemini: "/models/{model}:streamGenerateContent?alt=sse",
  anthropic: "/messages",
};

async function handleGetProxyState(request, env) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const backend = storageBackendName(env);
  const configError = proxyConfigError(env);
  const kv = store(env);
  const settings = parseJsonObject(await kv.get(SETTINGS_KEY));
  const providers = Array.isArray(settings?.providers) ? settings.providers : [];

  // Resolve fingerprint per provider first, so the key_state read can be scoped to
  // this site's providers. A full table scan would bill every row on every tab
  // switch once the table grows.
  const entries = [];
  for (const p of providers) {
    if (!p || typeof p !== "object") continue;
    const providerType = String(p.provider_type || "").trim();
    const apiBase = String(p.api_base || "").trim();
    if (!providerType || !apiBase) continue;
    entries.push({
      provider: p,
      providerType,
      apiBase,
      fp: await providerFingerprint(providerType, apiBase),
    });
  }

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
    for (let i = 0; i < fps.length; i += 500) {
      const chunk = fps.slice(i, i + 500);
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
    const upstream = upstreamFor(env, p);
    const keys = providerKeys(p).map((apiKey) => {
      const row = fpRows.get(apiKey);
      return {
        id: row ? row.id : null,
        masked: maskKey(apiKey),
        tag: metadataKeyTag(apiKey),
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
      via_gateway: upstream.kind === "gateway",
      gateway_provider:
        typeof p.gateway_provider === "string" ? p.gateway_provider : "",
      proxy_url: alias ? `/proxy/${alias}` : "",
      sample_path: SAMPLE_PATHS[providerType] || "/chat/completions",
      test_model:
        typeof testModels[fp] === "string" ? testModels[fp] : "",
      logs_url: gatewayLogsUrl(env, alias),
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
    gateway_ready: upstreamReady(env),
    logs_url_template: (env.AI_GATEWAY_LOGS_URL || "").trim(),
    providers: list,
  });
}

function upstreamReady(env) {
  return !!(
    (env.AI_GATEWAY_ACCOUNT_ID || "").trim() &&
    (env.AI_GATEWAY_ID || "").trim() &&
    (env.AI_GATEWAY_TOKEN || "").trim()
  );
}

/** AI_GATEWAY_LOGS_URL is an operator-provided template; {provider} and {key} are
 *  URL-encoded before substitution. No template = no link (button disabled). */
function gatewayLogsUrl(env, alias, keyTag = "") {
  const template = String(env.AI_GATEWAY_LOGS_URL ?? "").trim();
  if (!template) return "";
  return template
    .replace(/\{provider\}/g, encodeURIComponent(alias || ""))
    .replace(/\{key\}/g, encodeURIComponent(keyTag || ""));
}

// ─── /api/proxy/test ───────────────────────────────────────────────────────

/** Minimal single-key probe. Diagnostic for the ledger *only* in the failure
 *  direction: a failed probe counts toward the blacklist, a successful one does
 *  not clear it (the daily result is what recovers a key). */
function testRequestFor(provider, model) {
  if (!model) return null;
  switch (provider.provider_type) {
    case "gemini":
      return {
        model,
        path: `/models/${encodeURIComponent(model)}:generateContent`,
        body: {
          contents: [{ parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
      };
    case "anthropic":
      return {
        model,
        path: "/messages",
        body: {
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        },
      };
    case "openai":
    default:
      return {
        model,
        path: "/chat/completions",
        body: {
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        },
      };
  }
}

async function handleProxyTest(request, env) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const configError = proxyConfigError(env);
  if (configError) return json({ error: configError }, 503);

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

  await ensureSchemaFor(env.DB);
  const row = await env.DB.prepare(
    "SELECT id, fp, api_key FROM key_state WHERE id = ? AND fp = ?",
  )
    .bind(id, fp)
    .first();
  if (!row) return json({ error: "Not Found" }, 404);

  const settings = parseJsonObject(await store(env).get(SETTINGS_KEY));
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

  // The probe model is its own setting (proxy_test_models), never the provider's
  // daily-test list: changing it here must not touch what the morning run uses.
  const testModel =
    settings &&
    typeof settings.proxy_test_models === "object" &&
    !Array.isArray(settings.proxy_test_models) &&
    typeof settings.proxy_test_models[fp] === "string"
      ? settings.proxy_test_models[fp].trim()
      : "";
  if (!testModel) {
    return json(
      { error: "尚未设定测试模型；请先在「轮询转发」页填写并保存" },
      400,
    );
  }

  const probe = testRequestFor(provider, testModel);
  if (!probe) return json({ error: "该服务商没有设定 Models" }, 400);

  const upstream = upstreamFor(env, provider);
  const alias =
    typeof provider.alias === "string" ? provider.alias : provider.provider_type;
  const headers = buildForwardHeaders(
    env,
    provider,
    alias,
    row.api_key,
    new Headers({ "Content-Type": "application/json" }),
    upstream,
  );
  headers.set("Content-Type", "application/json");

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), proxyTimeoutMs(env));
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
      // A failed manual probe counts: the agreed rule is that a key becomes
      // disabled from a failed test or from proxy traffic, never from the daily
      // result. A *successful* probe does not clear the ledger — recovery is the
      // daily result's job (recoverKeysFromResults), otherwise the button would
      // be a way around the threshold.
      try {
        ledger = await recordKeyFailure(env.DB, row.id, proxyFailThreshold(env));
      } catch (dbErr) {
        console.error("key_state failure write failed", dbErr);
      }
    } else if (response.body) {
      await response.body.cancel();
    }
    return json({
      ok: response.ok,
      status: response.status,
      ms,
      model: probe.model,
      error: detail || undefined,
      fail_count: ledger ? ledger.fail_count : undefined,
      disabled: ledger ? !!ledger.disabled : undefined,
    });
  } catch (err) {
    return json({
      ok: false,
      status: 0,
      ms: Date.now() - started,
      model: probe.model,
      error: String((err && err.message) || err),
    });
  }
}

// ─── /api/proxy/recover ────────────────────────────────────────────────────

async function handleProxyRecover(request, env) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (storageBackendName(env) !== "d1") {
    return json({ error: "Recover requires STORAGE_BACKEND=d1" }, 503);
  }
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

// ─── /api/proxy/test-model ─────────────────────────────────────────────────
// Stores which model each provider should probe with, keyed by fingerprint. The
// *options* come from providers[].models (the Models field in 来源设定), but the
// choice is kept here so editing that comma list does not silently change a
// provider's probe model.
async function handleProxyTestModel(request, env) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
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
  for (let i = 0; i < staleStore.length; i += 100) {
    const chunk = staleStore.slice(i, i + 100);
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
  for (let i = 0; i < staleKeys.length; i += 100) {
    const chunk = staleKeys.slice(i, i + 100);
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
