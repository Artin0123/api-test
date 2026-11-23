// src/proxy-logs.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
// ─── proxy_logs (request/response capture, SSE reassembly & query API) ──────

const PROXY_LOGS_CAP = 1980;
const PROXY_LOGS_PAGE_SIZE = 20;
const PROXY_LOGS_MAX_PAGES = 99;
const PAYLOAD_MAX_CHARS = 65536;
const PAYLOAD_HALF_CHARS = 32768;
const ERROR_SUMMARY_MAX_CHARS = 300;
const NON_SSE_LOG_MAX_BYTES = 2 * 1024 * 1024;
const SSE_ACCUM_SOFT_CAP = PAYLOAD_MAX_CHARS * 3;
const SSE_ACCUM_KEEP_EDGE = PAYLOAD_HALF_CHARS + 4096;
const SSE_EVENT_BUFFER_CAP = 262144;

const DATA_URI_BASE64_RE = /data:[^;,"'\s]+;base64,[A-Za-z0-9+/=\r\n]{256,}/g;
const JSON_INLINE_BASE64_RE = /("data"\s*:\s*")[A-Za-z0-9+/=\r\n]{512,}(")/g;

function sanitizeLogBody(rawText) {
  if (typeof rawText !== "string" || !rawText) return null;
  let cleaned = rawText
    .replace(DATA_URI_BASE64_RE, (m) => `<base64 omitted (${m.length} chars)>`)
    .replace(
      JSON_INLINE_BASE64_RE,
      (m, p1, p2) =>
        `${p1}<base64 omitted (${m.length - p1.length - p2.length} chars)>${p2}`,
    );
  if (cleaned.length > PAYLOAD_MAX_CHARS) {
    const omitted = cleaned.length - PAYLOAD_MAX_CHARS;
    cleaned =
      cleaned.slice(0, PAYLOAD_HALF_CHARS) +
      `\n... [${omitted} chars omitted] ...\n` +
      cleaned.slice(cleaned.length - PAYLOAD_HALF_CHARS);
  }
  return cleaned;
}

function scrubSecrets(rawText, secrets) {
  if (typeof rawText !== "string" || !rawText) return "";
  let out = rawText;
  for (const secret of secrets || []) {
    if (typeof secret !== "string" || !secret) continue;
    if (out.includes(secret)) {
      out = out.split(secret).join(maskKey(secret));
    }
  }
  return out;
}

function summarizeErrorText(rawText, secrets) {
  if (typeof rawText !== "string" || !rawText.trim()) return null;
  let message = rawText.trim();
  const parsed = parseJsonOrNull(message);
  if (parsed && typeof parsed === "object") {
    const candidate =
      (typeof parsed.error === "string" && parsed.error) ||
      (typeof parsed.error?.message === "string" && parsed.error.message) ||
      (typeof parsed.message === "string" && parsed.message) ||
      (typeof parsed.detail === "string" && parsed.detail);
    if (candidate && candidate.trim()) message = candidate.trim();
  }
  const scrubbed = scrubSecrets(message, secrets).replace(/\s+/g, " ").trim();
  if (!scrubbed) return null;
  return scrubbed.length > ERROR_SUMMARY_MAX_CHARS
    ? scrubbed.slice(0, ERROR_SUMMARY_MAX_CHARS)
    : scrubbed;
}

function isBinaryContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (!ct) return false;
  return (
    ct.startsWith("multipart/form-data") ||
    ct.startsWith("application/octet-stream") ||
    ct.startsWith("audio/") ||
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("application/pdf")
  );
}

function extractRequestMeta(providerType, subPath, urlSearch, parsedJson) {
  let model = null;
  if (
    parsedJson &&
    typeof parsedJson.model === "string" &&
    parsedJson.model.trim()
  ) {
    model = parsedJson.model.trim();
  } else if (providerType === "google" && typeof subPath === "string") {
    const match = subPath.match(/\/models\/([^/:?]+)/);
    if (match && match[1]) {
      try {
        model = decodeURIComponent(match[1]);
      } catch {
        model = match[1];
      }
    }
  }

  const streamByBody = parsedJson?.stream === true;
  const streamByGooglePath =
    providerType === "google" &&
    (/:streamGenerateContent\b/i.test(subPath || "") ||
      /(?:^|[?&])alt=sse(?:&|$)/i.test(urlSearch || ""));

  return {
    model,
    stream: streamByBody || streamByGooglePath ? 1 : 0,
  };
}

function isEventStreamResponse(response) {
  const ct = response.headers.get("content-type") || "";
  return /^text\/event-stream\b/i.test(ct);
}

function appendBoundedText(cur, chunk) {
  if (!chunk) return cur;
  const next = cur + chunk;
  if (next.length <= SSE_ACCUM_SOFT_CAP) return next;
  return (
    next.slice(0, SSE_ACCUM_KEEP_EDGE) +
    "\n... [stream middle omitted] ...\n" +
    next.slice(next.length - SSE_ACCUM_KEEP_EDGE)
  );
}

/** Drain a teed non-SSE response body without buffering unbounded megabytes in
 *  Worker RAM: decodes up to `maxBytes` for log capture while draining any
 *  remainder so the client stream never stalls on `tee()` backpressure. */
async function readBoundedStreamText(streamBody, maxBytes = NON_SSE_LOG_MAX_BYTES) {
  if (!streamBody) return "";
  const reader = streamBody.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let keptBytes = 0;
  let totalBytes = 0;
  let truncated = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array) || value.byteLength === 0) continue;
    totalBytes += value.byteLength;
    if (!truncated) {
      const remaining = maxBytes - keptBytes;
      if (value.byteLength <= remaining) {
        keptBytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
      } else {
        if (remaining > 0) {
          keptBytes += remaining;
          text += decoder.decode(value.subarray(0, remaining), {
            stream: false,
          });
        } else {
          text += decoder.decode();
        }
        truncated = true;
      }
    }
  }
  if (!truncated) {
    text += decoder.decode();
  } else {
    text += `\n... [${totalBytes - keptBytes} bytes omitted] ...`;
  }
  return text;
}

/** Consume the teed SSE ReadableStream in `ctx.waitUntil` and reassemble delta
 *  chunks across OpenAI Chat/Responses, Anthropic Messages, and Google Gemini
 *  into a compact JSON summary without delaying client TTFB. */
async function reassembleSseStream(streamBody, providerType) {
  if (!streamBody) return { body: null, model: null, streamError: null };
  const reader = streamBody.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let rawPreview = "";
  let parsedEvents = 0;
  let content = "";
  let thinking = "";
  let finishReason = null;
  let usage = null;
  let detectedModel = null;
  let streamError = null;
  const toolCallsByIdx = new Map();

  const processEventLines = (lines) => {
    const dataParts = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataParts.push(line.slice(5).trimStart());
      }
    }
    if (!dataParts.length) return;
    const payload = dataParts.join("\n").trim();
    if (!payload || payload === "[DONE]") return;

    const obj = parseJsonOrNull(payload);
    if (!obj || typeof obj !== "object") return;
    parsedEvents += 1;

    if (!detectedModel) {
      if (typeof obj.model === "string" && obj.model) detectedModel = obj.model;
      else if (typeof obj.modelVersion === "string" && obj.modelVersion) {
        detectedModel = obj.modelVersion;
      } else if (typeof obj.message?.model === "string" && obj.message.model) {
        detectedModel = obj.message.model;
      }
    }

    // OpenAI Chat Completions delta
    if (Array.isArray(obj.choices)) {
      for (const ch of obj.choices) {
        if (!ch || typeof ch !== "object") continue;
        const delta = ch.delta;
        if (delta && typeof delta === "object") {
          if (typeof delta.content === "string") {
            content = appendBoundedText(content, delta.content);
          } else if (Array.isArray(delta.content)) {
            for (const part of delta.content) {
              if (typeof part?.text === "string") {
                content = appendBoundedText(content, part.text);
              }
            }
          }
          if (typeof delta.reasoning_content === "string") {
            thinking = appendBoundedText(thinking, delta.reasoning_content);
          } else if (typeof delta.reasoning === "string") {
            thinking = appendBoundedText(thinking, delta.reasoning);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = Number.isInteger(tc?.index) ? tc.index : 0;
              const cur = toolCallsByIdx.get(idx) || {
                id: "",
                type: "function",
                name: "",
                arguments: "",
              };
              if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
              if (typeof tc.type === "string" && tc.type) cur.type = tc.type;
              if (typeof tc.function?.name === "string") {
                cur.name += tc.function.name;
              }
              if (typeof tc.function?.arguments === "string") {
                cur.arguments = appendBoundedText(
                  cur.arguments,
                  tc.function.arguments,
                );
              }
              toolCallsByIdx.set(idx, cur);
            }
          }
        }
        if (typeof ch.finish_reason === "string" && ch.finish_reason) {
          finishReason = ch.finish_reason;
        }
      }
      if (obj.usage && typeof obj.usage === "object") usage = obj.usage;
      return;
    }

    // OpenAI Responses API events
    if (typeof obj.type === "string" && obj.type.startsWith("response.")) {
      if (
        obj.type === "response.output_text.delta" &&
        typeof obj.delta === "string"
      ) {
        content = appendBoundedText(content, obj.delta);
      } else if (
        (obj.type === "response.reasoning_summary_text.delta" ||
          obj.type === "response.reasoning_text.delta") &&
        typeof obj.delta === "string"
      ) {
        thinking = appendBoundedText(thinking, obj.delta);
      }
      if (obj.response && typeof obj.response === "object") {
        if (obj.response.usage) usage = obj.response.usage;
        if (typeof obj.response.status === "string") {
          finishReason = obj.response.status;
        }
      }
      return;
    }

    // Anthropic Messages SSE events
    if (
      providerType === "anthropic" ||
      obj.type === "message_start" ||
      obj.type === "content_block_start" ||
      obj.type === "content_block_delta" ||
      obj.type === "message_delta"
    ) {
      if (obj.type === "message_start" && obj.message) {
        if (obj.message.usage && typeof obj.message.usage === "object") {
          usage = { ...(usage || {}), ...obj.message.usage };
        }
      } else if (
        obj.type === "content_block_start" &&
        obj.content_block?.type === "tool_use"
      ) {
        const idx = Number.isInteger(obj.index)
          ? obj.index
          : toolCallsByIdx.size;
        const initInput =
          obj.content_block.input &&
          typeof obj.content_block.input === "object"
            ? obj.content_block.input
            : undefined;
        toolCallsByIdx.set(idx, {
          id: obj.content_block.id || "",
          type: "tool_use",
          name: obj.content_block.name || "",
          arguments: "",
          _initialInput: initInput,
        });
      } else if (obj.type === "content_block_delta" && obj.delta) {
        if (
          obj.delta.type === "text_delta" &&
          typeof obj.delta.text === "string"
        ) {
          content = appendBoundedText(content, obj.delta.text);
        } else if (
          obj.delta.type === "thinking_delta" &&
          typeof obj.delta.thinking === "string"
        ) {
          thinking = appendBoundedText(thinking, obj.delta.thinking);
        } else if (
          obj.delta.type === "input_json_delta" &&
          typeof obj.delta.partial_json === "string"
        ) {
          const idx = Number.isInteger(obj.index) ? obj.index : 0;
          const cur = toolCallsByIdx.get(idx) || {
            id: "",
            type: "tool_use",
            name: "",
            arguments: "",
          };
          cur.arguments = appendBoundedText(
            cur.arguments,
            obj.delta.partial_json,
          );
          toolCallsByIdx.set(idx, cur);
        }
      } else if (obj.type === "message_delta") {
        if (typeof obj.delta?.stop_reason === "string") {
          finishReason = obj.delta.stop_reason;
        }
        if (obj.usage && typeof obj.usage === "object") {
          usage = { ...(usage || {}), ...obj.usage };
        }
      } else if (obj.type === "error" && obj.error) {
        streamError =
          typeof obj.error.message === "string"
            ? obj.error.message
            : JSON.stringify(obj.error);
      }
      return;
    }

    // Google Gemini SSE chunks
    if (Array.isArray(obj.candidates)) {
      const cand = obj.candidates[0];
      const parts = cand?.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          if (part.thought === true && typeof part.text === "string") {
            thinking = appendBoundedText(thinking, part.text);
          } else if (typeof part.text === "string") {
            content = appendBoundedText(content, part.text);
          } else if (part.functionCall) {
            const idx = toolCallsByIdx.size;
            toolCallsByIdx.set(idx, {
              id: "",
              type: "functionCall",
              name: part.functionCall.name || "",
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            });
          }
        }
      }
      if (typeof cand?.finishReason === "string" && cand.finishReason) {
        finishReason = cand.finishReason;
      }
      if (obj.usageMetadata && typeof obj.usageMetadata === "object") {
        usage = obj.usageMetadata;
      }
      return;
    }

    if (obj.usage && typeof obj.usage === "object") {
      usage = obj.usage;
    }
    if (obj.error) {
      streamError =
        typeof obj.error === "string"
          ? obj.error
          : typeof obj.error.message === "string"
            ? obj.error.message
            : JSON.stringify(obj.error);
    }
  };

  let pendingCr = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const textChunk = decoder.decode(value, { stream: true });
      if (rawPreview.length < PAYLOAD_MAX_CHARS + 4096) {
        rawPreview += textChunk;
      }
      let combined = (pendingCr ? "\r" : "") + textChunk;
      pendingCr = combined.endsWith("\r");
      if (pendingCr) combined = combined.slice(0, -1);
      buffer += combined.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        processEventLines(block.split("\n"));
      }
      if (buffer.length > SSE_EVENT_BUFFER_CAP) {
        buffer = buffer.slice(-SSE_ACCUM_KEEP_EDGE);
      }
    }
    const tail = (pendingCr ? "\r" : "") + decoder.decode();
    pendingCr = false;
    if (tail) {
      if (rawPreview.length < PAYLOAD_MAX_CHARS + 4096) rawPreview += tail;
      buffer += tail.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }
    if (buffer.trim()) {
      for (const block of buffer.split("\n\n")) {
        if (block.trim()) processEventLines(block.split("\n"));
      }
    }
  } catch (err) {
    streamError = String((err && err.message) || err);
  }

  if (parsedEvents === 0) {
    return {
      body: sanitizeLogBody(rawPreview),
      model: detectedModel,
      streamError,
    };
  }

  const toolCalls = [...toolCallsByIdx.values()].map(
    ({ _initialInput, ...rest }) => ({
      ...rest,
      arguments:
        rest.arguments ||
        (_initialInput !== undefined ? JSON.stringify(_initialInput) : ""),
    }),
  );
  const assembled = {
    content,
    ...(thinking ? { thinking } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    finish_reason: finishReason,
    usage,
    ...(streamError ? { stream_error: streamError } : {}),
  };
  return {
    body: sanitizeLogBody(JSON.stringify(assembled, null, 2)),
    model: detectedModel,
    streamError,
  };
}

function buildProxyLogStmts(db, dbState, row) {
  const stmts = [
    db
      .prepare(
        "INSERT INTO proxy_logs (" +
          "ts, alias, provider_type, method, path, model, stream, status, " +
          "ttfb_ms, duration_ms, key_id, api_key, colo, user_agent, error, " +
          "req_body, res_body" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.ts,
        row.alias,
        row.provider_type,
        row.method,
        row.path,
        row.model ?? null,
        row.stream ? 1 : 0,
        row.status,
        row.ttfb_ms ?? null,
        row.duration_ms ?? null,
        row.key_id ?? null,
        row.api_key ?? null,
        row.colo ?? null,
        row.user_agent ?? null,
        row.error ?? null,
        row.req_body ?? null,
        row.res_body ?? null,
      ),
  ];

  dbState.logFacets = null;
  dbState.logWriteCounter += 1;
  if (dbState.logWriteCounter >= getLogCleanupEvery()) {
    dbState.logWriteCounter = 0;
    stmts.push(
      db
        .prepare(
          "DELETE FROM proxy_logs WHERE id IN (" +
            "SELECT id FROM proxy_logs ORDER BY id DESC LIMIT -1 OFFSET ?" +
            ")",
        )
        .bind(PROXY_LOGS_CAP),
    );
  }
  return stmts;
}

async function flushProxyWrites(db, dbState, keyWriteBuilders, logRows) {
  await ensureSchemaFor(db);
  const stmts = [];
  for (const build of keyWriteBuilders || []) {
    const stmt = build();
    if (stmt) stmts.push(stmt);
  }
  const rows = Array.isArray(logRows)
    ? logRows
    : logRows
      ? [logRows]
      : [];
  for (const row of rows) {
    if (row) {
      stmts.push(...buildProxyLogStmts(db, dbState, row));
    }
  }
  if (stmts.length) {
    await db.batch(stmts);
  }
}

// ─── /api/proxy/logs ───────────────────────────────────────────────────────

function serializeProxyLogSummary(r) {
  return {
    id: r.id,
    ts: r.ts,
    alias: r.alias,
    provider_type: r.provider_type,
    method: r.method,
    path: r.path,
    model: r.model || null,
    stream: !!r.stream,
    status: r.status,
    ttfb_ms: r.ttfb_ms ?? null,
    duration_ms: r.duration_ms ?? null,
    key_id: r.key_id ?? null,
    key_masked: r.api_key ? maskKey(r.api_key) : null,
    colo: r.colo || null,
    error: r.error || null,
  };
}

function resolveUpstreamUrlFromSnapshot(snapshot, row) {
  if (!row) return null;
  const provMeta = snapshot?.providersByAlias?.get(row.alias);
  if (!provMeta || !provMeta.apiBase) return null;
  const path = String(row.path || "");
  const suffix = path === "/" ? "" : path;
  return buildDirectUpstreamUrl(provMeta.apiBase, suffix, "");
}

async function ensureLogFacets(db, dbState) {
  const headRow = await db
    .prepare("SELECT id FROM proxy_logs ORDER BY id DESC LIMIT 1")
    .first();
  const headId = headRow ? Number(headRow.id) : 0;
  if (dbState.logFacets && dbState.logFacets.headId === headId) {
    return dbState.logFacets;
  }
  if (headId === 0) {
    dbState.logFacets = { headId: 0, total: 0, aliases: [], statuses: [] };
    return dbState.logFacets;
  }
  const facetRes = await db
    .prepare("SELECT alias, status FROM proxy_logs ORDER BY id DESC LIMIT ?")
    .bind(PROXY_LOGS_CAP)
    .all();
  const rows = facetRes.results || [];
  const aliasSet = new Set();
  const statusSet = new Set();
  for (const r of rows) {
    if (r.alias) aliasSet.add(r.alias);
    if (Number.isInteger(r.status)) statusSet.add(r.status);
  }
  dbState.logFacets = {
    headId,
    total: rows.length,
    aliases: [...aliasSet].sort(),
    statuses: [...statusSet].sort((a, b) => a - b),
  };
  return dbState.logFacets;
}

async function handleGetProxyLogs(request, env, url, ctx) {
  if (!(await requireAuth(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const blocked = rejectIfProxyDisabled(env);
  if (blocked) return blocked;

  const db = env.DB;
  await ensureSchemaFor(db);

  const idParam = url.searchParams.get("id");
  if (idParam !== null && idParam.trim() !== "") {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      return json({ error: "Invalid log id" }, 400);
    }
    const [row, snapshot] = await Promise.all([
      db.prepare("SELECT * FROM proxy_logs WHERE id = ?").bind(id).first(),
      getSnapshot(env, ctx),
    ]);
    if (!row) return json({ error: "Not Found" }, 404);
    return json({
      ok: true,
      log: {
        ...serializeProxyLogSummary(row),
        upstream_url: resolveUpstreamUrlFromSnapshot(snapshot, row),
        user_agent: row.user_agent || null,
        api_key: row.api_key || null,
        req_body: row.req_body ?? null,
        res_body: row.res_body ?? null,
      },
    });
  }

  const rawPage = Number(url.searchParams.get("page") || "1");
  const requestedPage = Number.isInteger(rawPage)
    ? Math.min(Math.max(rawPage, 1), PROXY_LOGS_MAX_PAGES)
    : 1;
  const aliasFilter = (url.searchParams.get("alias") || "").trim();
  const statusFilter = (url.searchParams.get("status") || "").trim().toLowerCase();
  const keyFilter = (url.searchParams.get("key") || "").trim().toLowerCase();
  const modelFilter = (url.searchParams.get("model") || "").trim().toLowerCase();
  const rawToTs = url.searchParams.get("to_ts");
  const toTs =
    rawToTs !== null && rawToTs.trim() !== "" && Number.isFinite(Number(rawToTs))
      ? Number(rawToTs)
      : null;

  const dbState = getDbState(db);
  const hasFilters = !!(
    aliasFilter ||
    statusFilter ||
    keyFilter ||
    modelFilter ||
    toTs !== null
  );

  // Fast path: unfiltered pagination scans only the requested 20 PK-ordered rows
  // and reuses cached facets verified against the latest PK `id` (1 row read).
  if (!hasFilters) {
    const facets = await ensureLogFacets(db, dbState);
    const total = facets.total;
    const totalPages =
      total === 0
        ? 1
        : Math.min(PROXY_LOGS_MAX_PAGES, Math.ceil(total / PROXY_LOGS_PAGE_SIZE));
    const currentPage = Math.min(requestedPage, totalPages);
    const offset = (currentPage - 1) * PROXY_LOGS_PAGE_SIZE;
    const limit = Math.min(PROXY_LOGS_PAGE_SIZE, Math.max(0, total - offset));

    let pageRows = [];
    if (limit > 0) {
      const pageRes = await db
        .prepare(
          "SELECT id, ts, alias, provider_type, method, path, model, stream, " +
            "status, ttfb_ms, duration_ms, key_id, api_key, colo, error " +
            "FROM proxy_logs ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .bind(limit, offset)
        .all();
      pageRows = pageRes.results || [];
    }

    return json({
      ok: true,
      logs: pageRows.map(serializeProxyLogSummary),
      total,
      page: currentPage,
      page_size: PROXY_LOGS_PAGE_SIZE,
      total_pages: totalPages,
      facets: {
        aliases: facets.aliases,
        statuses: facets.statuses,
      },
    });
  }

  const windowRes = await db
    .prepare(
      "SELECT id, ts, alias, provider_type, method, path, model, stream, " +
        "status, ttfb_ms, duration_ms, key_id, api_key, colo, error " +
        "FROM proxy_logs ORDER BY id DESC LIMIT ?",
    )
    .bind(PROXY_LOGS_CAP)
    .all();

  const windowRows = windowRes.results || [];
  const aliasSet = new Set();
  const statusSet = new Set();
  let headId = 0;

  for (const r of windowRows) {
    if (r.id > headId) headId = r.id;
    if (r.alias) aliasSet.add(r.alias);
    if (Number.isInteger(r.status)) statusSet.add(r.status);
  }
  const aliases = [...aliasSet].sort();
  const statuses = [...statusSet].sort((a, b) => a - b);
  dbState.logFacets = {
    headId,
    total: windowRows.length,
    aliases,
    statuses,
  };

  const filtered = windowRows.filter((r) => {
    if (aliasFilter && r.alias !== aliasFilter) return false;
    if (statusFilter) {
      const code = Number(r.status);
      if (statusFilter === "ok") {
        if (!(code >= 200 && code < 300)) return false;
      } else if (statusFilter === "fail") {
        if (code >= 200 && code < 300) return false;
      } else {
        const expectedCode = Number(statusFilter);
        if (!Number.isInteger(expectedCode) || code !== expectedCode) {
          return false;
        }
      }
    }
    if (keyFilter) {
      const plain = String(r.api_key || "").toLowerCase();
      const masked = maskKey(r.api_key || "").toLowerCase();
      if (!plain.includes(keyFilter) && !masked.includes(keyFilter)) {
        return false;
      }
    }
    if (modelFilter) {
      const model = String(r.model || "").toLowerCase();
      if (!model.includes(modelFilter)) return false;
    }
    if (toTs !== null) {
      const ts = Number(r.ts);
      if (!Number.isFinite(ts) || ts > toTs) return false;
    }
    return true;
  });

  const total = filtered.length;
  const totalPages =
    total === 0
      ? 1
      : Math.min(PROXY_LOGS_MAX_PAGES, Math.ceil(total / PROXY_LOGS_PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);
  const start = (currentPage - 1) * PROXY_LOGS_PAGE_SIZE;
  const pageItems = filtered
    .slice(start, start + PROXY_LOGS_PAGE_SIZE)
    .map(serializeProxyLogSummary);

  return json({
    ok: true,
    logs: pageItems,
    total,
    page: currentPage,
    page_size: PROXY_LOGS_PAGE_SIZE,
    total_pages: totalPages,
    facets: { aliases, statuses },
  });
}
