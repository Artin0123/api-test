// src/proxy.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
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

/** HTTP header values cannot contain CRLF or non-ASCII characters: strip
 *  unsafe bytes so cf-aig-metadata never makes fetch() throw TypeError while
 *  preserving the full plaintext ASCII key for Cloudflare AI Gateway logs. */
function sanitizeHeaderAscii(value) {
  return String(value ?? "")
    .replace(/[\r\n]/g, "")
    .replace(/[^\x20-\x7e]/g, "");
}

function providerKeys(provider) {
  if (!provider || typeof provider.keys !== "string") return [];
  return splitUniqueDelimited(provider.keys, "\n");
}

function providerModels(provider) {
  if (!provider || typeof provider.models !== "string") return [];
  return splitUniqueDelimited(provider.models, /[,\r\n]+/);
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
    case "google":
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

/** Always route proxy and manual probe requests through Cloudflare AI Gateway.
 *  The Custom Provider's slug matches `provider.alias`, so `custom-{alias}` +
 *  caller path reaches upstream while keeping all traffic in Gateway logs. */
function upstreamFor(settings, provider) {
  const slug =
    typeof provider?.alias === "string" ? provider.alias.trim() : "";
  const gw = parseGatewayLogsUrl(settings?.ai_gateway_logs_url);
  const token = String(settings?.ai_gateway_token || "").trim();
  if (!slug || !gw || !token) return null;
  return {
    kind: "gateway",
    token,
    base:
      `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gw.accountId)}` +
      `/${encodeURIComponent(gw.gatewayId)}/custom-${encodeURIComponent(slug)}`,
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

function buildForwardHeaders(
  settings,
  provider,
  alias,
  apiKey,
  incoming,
  upstream,
) {
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

  headers.set("cf-aig-authorization", `Bearer ${upstream.token}`);
  headers.set("cf-aig-skip-cache", "true");
  // 关闭 Cloudflare AI Gateway 对同一把坏金钥的重复重试，把「立即切换下一把不同金钥」的控制权完全留在 Worker 迴圈。
  headers.set("cf-aig-max-attempts", "1");
  headers.set(
    "cf-aig-request-timeout",
    String(proxyTimeoutMs(settings)),
  );
  headers.set(
    "cf-aig-metadata",
    JSON.stringify({ key: sanitizeHeaderAscii(apiKey), provider: alias }),
  );

  return headers;
}

function proxyTimeoutMs(settings) {
  return clampOrDefaultInt(
    settings?.proxy_upstream_timeout_ms,
    PROXY_INT_LIMITS.proxy_upstream_timeout_ms,
  );
}

function proxyFailThreshold(settings) {
  return clampOrDefaultInt(
    settings?.proxy_fail_threshold,
    PROXY_INT_LIMITS.proxy_fail_threshold,
  );
}

// Cap retries at 3 (4 keys per request), well under the free plan's 50-subrequest ceiling.
function proxyMaxRetries(settings) {
  return clampOrDefaultInt(
    settings?.proxy_max_retries,
    PROXY_INT_LIMITS.proxy_max_retries,
  );
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

/** null when the proxy can serve requests via Gateway, otherwise an explicit reason. */
function proxyConfigError(env, settings) {
  if (storageBackendName(env) !== "d1") {
    return "转发需要 STORAGE_BACKEND=d1（KV 模式无法即时维护密钥状态）";
  }
  const proxyPassword = String(settings?.proxy_password || "").trim();
  if (!proxyPassword) {
    return "代理密码未设定，请到右上角「设定」填写后再启用转发";
  }
  const adminPassword = (env.ADMIN_PASSWORD || "").trim();
  if (adminPassword && timingSafeEqual(proxyPassword, adminPassword)) {
    return "代理密码不能与 ADMIN_PASSWORD 相同";
  }
  if (!parseGatewayLogsUrl(settings?.ai_gateway_logs_url)) {
    return "AI Gateway Logs URL 未设定或格式无效，请到右上角「设定」填写";
  }
  if (!String(settings?.ai_gateway_token || "").trim()) {
    return "AI Gateway Token 未设定，请到右上角「设定」填写";
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

function buildKeyStateSyncStmts(db, entries, existingRows, now) {
  const wanted = [];
  for (const { provider: p, fp } of entries || []) {
    for (const apiKey of providerKeys(p)) wanted.push({ fp, apiKey });
  }

  const identity = (row) => `${row.fp}\u0000${row.api_key}`;
  const wantedSet = new Set(wanted.map((w) => `${w.fp}\u0000${w.apiKey}`));
  const existingSet = new Set((existingRows || []).map(identity));
  const stmts = [];

  const staleIds = (existingRows || [])
    .filter((r) => !wantedSet.has(identity(r)))
    .map((r) => r.id);
  for (let i = 0; i < staleIds.length; i += D1_IN_CHUNK_SIZE) {
    const chunk = staleIds.slice(i, i + D1_IN_CHUNK_SIZE);
    const sql = `DELETE FROM key_state WHERE id IN (${chunk.map(() => "?").join(",")})`;
    stmts.push(db.prepare(sql).bind(...chunk));
  }

  const missing = wanted.filter(
    (w) => !existingSet.has(`${w.fp}\u0000${w.apiKey}`),
  );
  // 3 bound parameters per row -> cap at 30 rows per statement (<= 90 params < 100 D1 limit).
  for (let i = 0; i < missing.length; i += 30) {
    const chunk = missing.slice(i, i + 30);
    const sql =
      "INSERT INTO key_state (fp, api_key, last_used_at, fail_count, disabled, updated_at) " +
      `VALUES ${chunk.map(() => "(?, ?, NULL, 0, 0, ?)").join(",")} ` +
      "ON CONFLICT(fp, api_key) DO NOTHING";
    const params = [];
    for (const w of chunk) params.push(w.fp, w.apiKey, now);
    stmts.push(db.prepare(sql).bind(...params));
  }

  return stmts;
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
        "SET fail_count = MIN(?, fail_count + 1), " +
        "    disabled = CASE WHEN fail_count + 1 >= ? THEN 1 ELSE disabled END, " +
        "    updated_at = ? " +
        "WHERE id = ? AND disabled = 0 AND fail_count < ? " +
        "RETURNING fail_count, disabled",
    )
    .bind(threshold, threshold, Date.now(), id, threshold)
    .all();
  return (result.results || [])[0] || null;
}

/**
 * The daily GHA run is the authority on whether a key is alive. When it reports a
 * key in `valid_keys`, clear that key's proxy ledger: a transient outage that
 * pushed fail_count to the threshold must not keep the key disabled forever.
 * (A successful manual Test press in handleProxyTest also clears fail_count and
 * disabled immediately, while failed probes continue incrementing fail_count.)
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
  for (let i = 0; i < keys.length; i += D1_IN_CHUNK_SIZE) {
    const chunk = keys.slice(i, i + D1_IN_CHUNK_SIZE);
    const sql =
      "UPDATE key_state SET disabled = 0, fail_count = 0, updated_at = ? " +
      "WHERE fp = ? AND (disabled <> 0 OR fail_count <> 0) " +
      `AND api_key IN (${chunk.map(() => "?").join(",")})`;
    const res = await db.prepare(sql).bind(Date.now(), fp, ...chunk).run();
    recovered += Number(res.meta?.changes || 0);
  }
  return recovered;
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

function rejectIfProxyDisabled(env) {
  if (storageBackendName(env) !== "d1") {
    return json(
      { error: proxyConfigError(env, null), code: "PROXY_DISABLED" },
      503,
    );
  }
  return null;
}

async function handleProxy(request, env, url) {
  const blocked = rejectIfProxyDisabled(env);
  if (blocked) return blocked;

  const kv = store(env);
  const settings = parseJsonObject(await kv.get(SETTINGS_KEY));
  const configError = proxyConfigError(env, settings);
  if (configError) return json({ error: configError, code: "PROXY_DISABLED" }, 503);

  const proxyPassword = String(settings?.proxy_password || "").trim();
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

  const providers = Array.isArray(settings?.providers) ? settings.providers : [];
  const provider = providers.find(
    (p) => p && typeof p.alias === "string" && p.alias === alias,
  );
  if (!provider) return json({ error: "Unknown proxy alias" }, 404);

  const upstream = upstreamFor(settings, provider);
  if (!upstream) {
    return json(
      { error: "AI Gateway 设定不完整，无法转发", code: "PROXY_DISABLED" },
      503,
    );
  }

  const db = env.DB;
  await ensureSchemaFor(db);
  const fp = await providerFingerprint(
    String(provider.provider_type || "").trim(),
    String(provider.api_base || "").trim(),
  );
  const target = targetUrl(upstream, pathAndQuery);
  const timeoutMs = proxyTimeoutMs(settings);
  const threshold = proxyFailThreshold(settings);
  const maxRetries = proxyMaxRetries(settings);

  const rawBody =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.arrayBuffer();
  const contentType = request.headers.get("content-type") || "";
  const isJson = /^application\/json\b/i.test(contentType);
  const extraBody = parseExtraBody(provider);
  let forwardBody;
  if (rawBody !== null) {
    forwardBody = rawBody;
    if (isJson && extraBody) {
      try {
        const decoded = new TextDecoder().decode(rawBody);
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          forwardBody = JSON.stringify({ ...parsed, ...extraBody });
        }
      } catch {
        // Non-JSON or unreadable payload falls back to forwarding raw bytes as-is.
      }
    }
  }

  const tried = new Set();
  let lastFailure = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const keyRow = await pickKeyRow(db, fp, [...tried]);
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
      settings,
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
        body: forwardBody,
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
