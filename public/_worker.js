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
 * Fingerprint = SHA-256( JSON.stringify({ api_base, provider_type }) )
 * key order must be alphabetical — matches both frontend and Python script.
 */

const ROUTES = {
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

function requireAuth(request, env) {
  const adminPassword = (env.ADMIN_PASSWORD || "").trim();
  if (!adminPassword) return false;
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === adminPassword;
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
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);
  const kv = kvStore(env);
  const raw = await kv.get(SETTINGS_KEY);
  const settings = parseJsonOrNull(raw) || { ...DEFAULT_SETTINGS };
  return json({ ok: true, settings });
}

async function handlePostSettings(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

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
  // Public — no auth required
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
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

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
  let recorded = 0;
  try {
    recorded = await recordDeadKeysFromResults(
      kv,
      api_base.trim(),
      body.invalid_records,
      payload.uploaded_at,
    );
  } catch (err) {
    console.error("dead key auto-record failed", err);
  }
  return json({ ok: true, fingerprint: fp, dead_keys_added: recorded });
}

// ─── /api/checkpoint ─────────────────────────────────────────────────────────

async function handleGetCheckpoint(request, env, url) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

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
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

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
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

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

/** Only HTTP 401 is auto-recorded. Anything else (403, 402, quota wording, 429…)
 *  stays manual on purpose: api_key dedup keeps the earliest record forever, so a
 *  key parked here by mistake never leaves on its own. */
const AUTO_RECORD_CODE = 401;

function isDeadKeyRecord(rec) {
  if (!rec || typeof rec.api_key !== "string" || !rec.api_key.trim()) return false;
  return normalizeErrorCode(rec.error_code) === AUTO_RECORD_CODE;
}

/** Append keys that a test run proved dead, applying the same dedup rules as a
 *  manual POST. Returns how many records were added. */
async function recordDeadKeysFromResults(kv, api_base, invalidRecords, uploadedAt) {
  if (!Array.isArray(invalidRecords) || !invalidRecords.length) return 0;

  let provider_host;
  try {
    provider_host = new URL(api_base).hostname;
  } catch {
    return 0;
  }
  if (!provider_host) return 0;

  // Store the calendar day at midnight UTC — the exact shape manual entries use
  // (toIsoDay in app.js). expired_at is read as a date (dkDateOf slices 10 chars,
  // the range filter compares strings), so mixing a full instant in here would make
  // auto and manual rows for the same day sort and filter as different days.
  // The precise moment is still kept in created_at.
  const expired_at = `${String(uploadedAt).slice(0, 10)}T00:00:00.000Z`;

  const list = await readDeadKeys(kv);
  const known = new Set(list.map((r) => r && r.api_key));
  let added = 0;

  for (const rec of invalidRecords) {
    if (!isDeadKeyRecord(rec)) continue;
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

  if (added) await kv.put(DEAD_KEYS_KEY, JSON.stringify(list));
  return added;
}

async function handleGetDeadKeys(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);
  const kv = kvStore(env);
  return json({ ok: true, dead_keys: await readDeadKeys(kv) });
}

async function handlePostDeadKey(request, env) {
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

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
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

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
  if (!requireAuth(request, env)) return json({ error: "Unauthorized" }, 401);

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
