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
  "location",
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
// key), 401, 403, 429, 3xx redirects and 5xx on the same path instead of trying
// to infer whose fault each code is. The trade-off is explicit: a provider-wide
// outage, or one malformed body, charges every key it touches — the daily test
// result puts those keys back (see recoverKeysFromResults) and the card shows
// the counters.

/** Head/tail mask for keys: left 6 + 1..3 asterisks + right 3 (<=9 shown as-is).
 *  Keep this function identical to the one in `public/js/state.js`. */
function maskKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 9) return s;
  const stars = "*".repeat(Math.min(s.length - 9, 3));
  return `${s.slice(0, 6)}${stars}${s.slice(-3)}`;
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

function buildDirectUpstreamUrl(apiBase, subPath, search = "") {
  const base = String(apiBase || "")
    .trim()
    .replace(/\/+$/, "");
  const suffix = subPath
    ? subPath.startsWith("/")
      ? subPath
      : `/${subPath}`
    : "";
  return `${base}${suffix}${search || ""}`;
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

function buildForwardHeaders(providerType, customHeaders, apiKey, incoming) {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    const lower = name.toLowerCase();
    if (DROP_UPSTREAM_HEADERS.has(lower)) continue;
    if (CALLER_CREDENTIAL_HEADERS.has(lower)) continue;
    if (lower === "cookie") continue;
    if (lower.startsWith("cf-aig-")) continue;
    headers.append(name, value);
  }

  applyProviderAuth(headers, providerType, apiKey);

  // Custom headers come after auth on purpose, matching async_test_keys.py:
  // a deliberately configured header is allowed to override the default.
  if (Array.isArray(customHeaders)) {
    for (const h of customHeaders) {
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

/** null when the proxy can serve requests directly to upstream, otherwise an explicit reason. */
function proxyConfigError(env, settings) {
  if (storageBackendName(env) !== "d1") {
    return "转发需要 STORAGE_BACKEND=d1（KV 模式无法即时维护密钥状态与请求记录）";
  }
  const proxyPassword = String(settings?.proxy_password || "").trim();
  if (!proxyPassword) {
    return "代理密码未设定，请到右上角「设定」填写后再启用转发";
  }
  const adminPassword = (env.ADMIN_PASSWORD || "").trim();
  if (adminPassword && timingSafeEqual(proxyPassword, adminPassword)) {
    return "代理密码不能与 ADMIN_PASSWORD 相同";
  }
  return null;
}

// ─── key_state sync & daily recovery ────────────────────────────────────────

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

/**
 * The daily GHA run is the authority on whether a key is alive. When it reports a
 * key in `valid_keys`, clear that key's proxy ledger: a transient outage that
 * pushed fail_count to the threshold must not keep the key disabled forever.
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
  const now = nowMs();
  const stmts = [];
  for (let i = 0; i < keys.length; i += D1_IN_CHUNK_SIZE) {
    const chunk = keys.slice(i, i + D1_IN_CHUNK_SIZE);
    const sql =
      "UPDATE key_state SET disabled = 0, fail_count = 0, updated_at = ? " +
      "WHERE fp = ? AND (disabled <> 0 OR fail_count <> 0) " +
      `AND api_key IN (${chunk.map(() => "?").join(",")})`;
    stmts.push(db.prepare(sql).bind(now, fp, ...chunk));
  }
  const batchRes = await db.batch(stmts);
  let recovered = 0;
  for (const r of batchRes) recovered += Number(r.meta?.changes || 0);

  const dbState = getDbState(db);
  const fpState = dbState.snapshot?.providersByFp.get(fp);
  if (fpState) {
    let memChanged = false;
    for (const k of keys) {
      const entry = fpState.byApiKey.get(k);
      if (entry && (entry.disabled || entry.failCount > 0)) {
        entry.disabled = false;
        entry.failCount = 0;
        entry.localMutatedAt = now;
        memChanged = true;
      }
    }
    if (memChanged) bumpStateSeq(dbState);
  }
  return recovered;
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

async function handleProxy(request, env, url, ctx) {
  const blocked = rejectIfProxyDisabled(env);
  if (blocked) return blocked;

  const snapshot = await getSnapshot(env, ctx);
  const settings = snapshot.settings;
  const configError = proxyConfigError(env, settings);
  if (configError) {
    return json({ error: configError, code: "PROXY_DISABLED" }, 503);
  }

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
  if (!alias) return json({ error: "Unknown proxy alias" }, 404);

  const subPath = slash === -1 ? "" : rest.slice(slash);
  if (hasPathTraversalSegment(subPath)) {
    return json({ error: "Invalid proxy path" }, 400);
  }
  const pathAndQuery = `${subPath}${url.search}`;
  const logPath = pathAndQuery || "/";

  const provMeta = snapshot.providersByAlias.get(alias);
  if (!provMeta) return json({ error: "Unknown proxy alias" }, 404);

  const db = env.DB;
  const dbState = getDbState(db);
  const target = buildDirectUpstreamUrl(provMeta.apiBase, subPath, url.search);
  try {
    const targetHost = new URL(target).host;
    if (targetHost && url.host && targetHost.toLowerCase() === url.host.toLowerCase()) {
      return json({ error: "Upstream URL cannot point to proxy origin" }, 502);
    }
  } catch {
    return json({ error: "Invalid upstream URL" }, 502);
  }
  const timeoutMs = proxyTimeoutMs(settings);
  const threshold = proxyFailThreshold(settings);
  const maxRetries = proxyMaxRetries(settings);
  const colo =
    typeof request.cf?.colo === "string" && request.cf.colo
      ? request.cf.colo
      : null;
  const rawUa = (request.headers.get("user-agent") || "").trim();
  const userAgent = rawUa ? rawUa.slice(0, 512) : null;

  const rawBody =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.arrayBuffer();
  const contentType = request.headers.get("content-type") || "";
  const isJson = /^application\/json\b/i.test(contentType);
  const isBinaryReq = isBinaryContentType(contentType);

  let decodedReqText = null;
  let parsedReqJson = null;
  if (rawBody !== null && rawBody.byteLength > 0 && !isBinaryReq) {
    decodedReqText = new TextDecoder().decode(rawBody);
    if (isJson || decodedReqText.trimStart().startsWith("{")) {
      parsedReqJson = parseJsonObject(decodedReqText);
    }
  }

  let forwardBody;
  let reqBodyForLog = null;
  if (rawBody !== null) {
    forwardBody = rawBody;
    if (isJson && provMeta.extraBody && parsedReqJson) {
      const merged = JSON.stringify({ ...parsedReqJson, ...provMeta.extraBody });
      forwardBody = merged;
      reqBodyForLog = sanitizeLogBody(merged);
    } else if (isBinaryReq) {
      reqBodyForLog = `[binary payload (${rawBody.byteLength} bytes)]`;
    } else if (decodedReqText) {
      reqBodyForLog = sanitizeLogBody(decodedReqText);
    }
  }

  const reqMeta = extractRequestMeta(
    provMeta.providerType,
    subPath,
    url.search,
    parsedReqJson,
  );

  const requestStartMs = nowMs();
  const tried = new Set();
  const secretList = [];
  const logRows = [];
  const keyWriteMap = new Map();
  let lastFailure = null;

  const makeLogRow = (overrides) => ({
    ts: requestStartMs,
    alias,
    provider_type: provMeta.providerType,
    method: request.method,
    path: logPath,
    model: reqMeta.model,
    stream: reqMeta.stream,
    status: 500,
    ttfb_ms: reqMeta.stream ? 0 : null,
    duration_ms: nowMs() - requestStartMs,
    key_id: null,
    api_key: null,
    colo,
    user_agent: userAgent,
    error: null,
    req_body: reqBodyForLog,
    res_body: null,
    ...overrides,
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const entry = pickKeyFromSnapshot(dbState, provMeta.fp, tried);
    if (!entry) {
      if (!lastFailure) {
        const errPayload = {
          error: "暂无可用的 Key（全部已禁用或无密钥）",
          code: "NO_KEYS",
        };
        runInBackground(
          ctx,
          flushProxyWrites(
            db,
            dbState,
            [],
            makeLogRow({
              status: 503,
              ttfb_ms: null,
              error: errPayload.error,
              res_body: JSON.stringify(errPayload),
            }),
          ),
        );
        return json(errPayload, 503);
      }
      break;
    }

    tried.add(entry.id);
    secretList.push(entry.apiKey);

    const headers = buildForwardHeaders(
      provMeta.providerType,
      provMeta.customHeaders,
      entry.apiKey,
      request.headers,
    );

    // The timeout covers "time to first byte", not the stream: a chat completion
    // can legitimately stream for minutes, and AbortSignal.timeout would cut the
    // body mid-stream. Clear the timer as soon as the headers arrive.
    // `redirect: "manual"` prevents fetch from leaking x-api-key / x-goog-api-key /
    // custom headers onto cross-origin redirect targets; 3xx counts as non-2xx.
    const attemptStartMs = nowMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        body: forwardBody,
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      const attemptMs = nowMs() - attemptStartMs;
      const timedOut = err && err.name === "AbortError";
      const logStatus = timedOut ? 499 : 502;
      const rawErrMsg = timedOut
        ? `Upstream timeout (${timeoutMs}ms)`
        : String((err && err.message) || err);
      const scrubbedErr =
        scrubSecrets(rawErrMsg, secretList).slice(0, ERROR_SUMMARY_MAX_CHARS) ||
        "Upstream request failed";

      const writeBuilder = stageProxyKeyFailure(
        db,
        dbState,
        entry,
        threshold,
        true,
      );
      if (writeBuilder) keyWriteMap.set(entry.id, writeBuilder);

      const errBodyStr = JSON.stringify({
        error: "Upstream request failed",
        detail: scrubbedErr,
      });
      logRows.push(
        makeLogRow({
          ts: attemptStartMs,
          status: logStatus,
          ttfb_ms: reqMeta.stream ? attemptMs : null,
          duration_ms: attemptMs,
          key_id: entry.id,
          api_key: entry.apiKey,
          error: scrubbedErr,
          res_body: sanitizeLogBody(errBodyStr),
        }),
      );
      lastFailure = {
        status: logStatus,
        headers: { "Content-Type": "application/json" },
        body: errBodyStr,
      };
      continue;
    }

    const ttfbMs = nowMs() - attemptStartMs;

    if (response.ok) {
      const successBuilder = stageProxyKeySuccess(db, dbState, entry);
      if (successBuilder) keyWriteMap.set(entry.id, successBuilder);

      const outHeaders = copyUpstreamHeaders(response);
      const resContentType = response.headers.get("content-type") || "";
      const isSse = isEventStreamResponse(response);

      if (isSse && response.body) {
        const [clientBody, logBody] = response.body.tee();
        runInBackground(
          ctx,
          (async () => {
            const assembled = await reassembleSseStream(
              logBody,
              provMeta.providerType,
            );
            await flushProxyWrites(
              db,
              dbState,
              [...keyWriteMap.values()],
              [
                ...logRows,
                makeLogRow({
                  ts: attemptStartMs,
                  model: reqMeta.model || assembled.model,
                  stream: 1,
                  status: response.status,
                  ttfb_ms: ttfbMs,
                  duration_ms: nowMs() - attemptStartMs,
                  key_id: entry.id,
                  api_key: entry.apiKey,
                  error: assembled.streamError
                    ? scrubSecrets(assembled.streamError, secretList).slice(
                        0,
                        ERROR_SUMMARY_MAX_CHARS,
                      )
                    : null,
                  res_body: assembled.body,
                }),
              ],
            );
          })(),
        );
        return new Response(clientBody, {
          status: response.status,
          statusText: response.statusText,
          headers: outHeaders,
        });
      }

      // Stream binary responses straight through without `tee()` so multi-MB
      // audio / image / video / PDF payloads never buffer in Worker RAM.
      if (response.body && isBinaryContentType(resContentType)) {
        const declaredLen = response.headers.get("content-length");
        const mediaLabel = resContentType.split(";")[0].trim() || "binary";
        const binaryNote = declaredLen
          ? `[binary payload (${declaredLen} bytes, ${mediaLabel})]`
          : `[binary payload (${mediaLabel})]`;
        runInBackground(
          ctx,
          flushProxyWrites(
            db,
            dbState,
            [...keyWriteMap.values()],
            [
              ...logRows,
              makeLogRow({
                ts: attemptStartMs,
                status: response.status,
                ttfb_ms: reqMeta.stream ? ttfbMs : null,
                duration_ms: nowMs() - attemptStartMs,
                key_id: entry.id,
                api_key: entry.apiKey,
                res_body: binaryNote,
              }),
            ],
          ),
        );
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: outHeaders,
        });
      }

      if (response.body) {
        const [clientBody, logBody] = response.body.tee();
        runInBackground(
          ctx,
          (async () => {
            let resBodyForLog = null;
            let detectedModel = reqMeta.model;
            try {
              const textBody = await readBoundedStreamText(logBody);
              if (textBody) {
                if (!detectedModel) {
                  const parsedRes = parseJsonObject(textBody);
                  if (typeof parsedRes?.model === "string" && parsedRes.model) {
                    detectedModel = parsedRes.model;
                  } else if (
                    typeof parsedRes?.modelVersion === "string" &&
                    parsedRes.modelVersion
                  ) {
                    detectedModel = parsedRes.modelVersion;
                  }
                }
                resBodyForLog = sanitizeLogBody(textBody);
              }
            } catch (readErr) {
              resBodyForLog = `[response read error: ${String((readErr && readErr.message) || readErr)}]`;
            }

            await flushProxyWrites(
              db,
              dbState,
              [...keyWriteMap.values()],
              [
                ...logRows,
                makeLogRow({
                  ts: attemptStartMs,
                  model: detectedModel,
                  status: response.status,
                  ttfb_ms: reqMeta.stream ? ttfbMs : null,
                  duration_ms: nowMs() - attemptStartMs,
                  key_id: entry.id,
                  api_key: entry.apiKey,
                  res_body: resBodyForLog,
                }),
              ],
            );
          })(),
        );
        return new Response(clientBody, {
          status: response.status,
          statusText: response.statusText,
          headers: outHeaders,
        });
      }

      runInBackground(
        ctx,
        flushProxyWrites(
          db,
          dbState,
          [...keyWriteMap.values()],
          [
            ...logRows,
            makeLogRow({
              ts: attemptStartMs,
              status: response.status,
              ttfb_ms: reqMeta.stream ? ttfbMs : null,
              duration_ms: nowMs() - attemptStartMs,
              key_id: entry.id,
              api_key: entry.apiKey,
            }),
          ],
        ),
      );
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: outHeaders,
      });
    }

    // Every non-2xx (including 3xx manual redirect) lands here: charge the key
    // in memory, stage its D1 failure update, and move on to the next key.
    const errBodyText = await response.text();
    const attemptDurationMs = nowMs() - attemptStartMs;
    const errSummary =
      summarizeErrorText(errBodyText, secretList) || `HTTP ${response.status}`;
    const failBuilder = stageProxyKeyFailure(
      db,
      dbState,
      entry,
      threshold,
      true,
    );
    if (failBuilder) keyWriteMap.set(entry.id, failBuilder);

    logRows.push(
      makeLogRow({
        ts: attemptStartMs,
        status: response.status,
        ttfb_ms: reqMeta.stream ? ttfbMs : null,
        duration_ms: attemptDurationMs,
        key_id: entry.id,
        api_key: entry.apiKey,
        error: errSummary,
        res_body: sanitizeLogBody(scrubSecrets(errBodyText, secretList)),
      }),
    );
    lastFailure = {
      status: response.status,
      headers: copyUpstreamHeaders(response),
      body: errBodyText,
    };
  }

  if (!lastFailure) {
    return json({ error: "暂无可用的 Key", code: "NO_KEYS" }, 503);
  }

  runInBackground(
    ctx,
    flushProxyWrites(
      db,
      dbState,
      [...keyWriteMap.values()],
      logRows,
    ),
  );

  return new Response(lastFailure.body, {
    status: lastFailure.status,
    headers: lastFailure.headers,
  });
}

// ─── /api/proxy/state ──────────────────────────────────────────────────────
