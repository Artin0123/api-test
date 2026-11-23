// Split from the original app.js; loaded in original order (see index.html).
// ── Request logs tab & detail modal ────────────────────────────────────────
const LOGS_PAGE_SIZE = 20;
const LOGS_MAX_PAGES = 99;
const LOGS_CAP = 1980;
let _logsSearchTimer = null;

function formatLogClock(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "-";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatLogLatency(ms) {
  if (ms == null) return "-";
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "-";
  return formatProxyTestDuration(n, { compact: true });
}

function resolveLogPlainKeyLocally(alias, keyMasked) {
  if (!keyMasked) return "";
  const providers = (state.settings && state.settings.providers) || [];
  const preferred = providers.filter(
    (p) => p && String(p.alias || "").trim() === alias,
  );
  for (const group of [preferred, providers]) {
    for (const p of group) {
      if (!p || typeof p.keys !== "string") continue;
      for (const raw of p.keys.split("\n")) {
        const k = raw.trim();
        if (k && maskKey(k) === keyMasked) return k;
      }
    }
  }
  return "";
}

async function copyLogKeyById(id, btn) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) return;
  try {
    let rawKey = "";
    if (MOCK) {
      const mock = await getMock();
      const found = (mock.proxy_logs || []).find(
        (r) => r && Number(r.id) === numId,
      );
      rawKey = found?.api_key || "";
    } else {
      const d = await api(
        `/api/proxy/logs?id=${encodeURIComponent(String(numId))}`,
        { auth: true },
      );
      rawKey = d?.log?.api_key || "";
    }
    if (!rawKey) return;
    if (btn) btn.dataset.copyVal = rawKey;
    copyText(rawKey, btn);
  } catch (err) {
    showProxyToast(`复制失败：${err.message}`, {
      type: "fail",
      duration: PROXY_TOAST_FAIL_MS,
    });
  }
}

function renderLogStatusBadge(status) {
  const code = Number(status);
  if (code >= 200 && code < 300) {
    return `<span class="badge badge-ok">${esc(String(code))}</span>`;
  }
  return `<span class="badge badge-fail">${esc(String(code))}</span>`;
}

function fillLogsFilterSelects(facets = {}) {
  if (dom.logsFAlias) {
    const prevAlias = dom.logsFAlias.value;
    const aliases = new Set();
    for (const p of (state.settings || {}).providers || []) {
      const a = typeof p?.alias === "string" ? p.alias.trim() : "";
      if (a) aliases.add(a);
    }
    for (const a of facets.aliases || []) {
      if (a) aliases.add(String(a));
    }
    const sortedAliases = [...aliases].sort();
    const opts = [`<option value="">全部</option>`];
    for (const a of sortedAliases) {
      opts.push(`<option value="${escAttr(a)}">${esc(a)}</option>`);
    }
    dom.logsFAlias.innerHTML = opts.join("");
    if (prevAlias && aliases.has(prevAlias)) dom.logsFAlias.value = prevAlias;
    syncCustomSelect(dom.logsFAlias);
  }

  if (dom.logsFStatus) {
    const prevStatus = dom.logsFStatus.value;
    const codes = (facets.statuses || [])
      .map(Number)
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
    const opts = [
      `<option value="">全部</option>`,
      `<option value="ok">成功</option>`,
      `<option value="fail">失败</option>`,
    ];
    for (const c of codes) {
      opts.push(`<option value="${escAttr(String(c))}">${esc(String(c))}</option>`);
    }
    dom.logsFStatus.innerHTML = opts.join("");
    const validSpecial = prevStatus === "ok" || prevStatus === "fail";
    if (validSpecial || (prevStatus && codes.includes(Number(prevStatus)))) {
      dom.logsFStatus.value = prevStatus;
    }
    syncCustomSelect(dom.logsFStatus);
  }
}

function formatLogDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseLogToCutoffMs(dateStr) {
  const parsed = parseFilterDate(dateStr);
  if (!parsed) return null;
  const [y, m, d] = parsed.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function resolveLogUpstreamUrl(log) {
  if (!log) return "";
  const alias = String(log.alias || "").trim();
  const path = String(log.path || "");
  const providers = (state.settings && state.settings.providers) || [];
  const prov = providers.find(
    (p) => p && String(p.alias || "").trim() === alias,
  );
  const base = String(prov?.api_base || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return "";
  const suffix =
    !path || path === "/"
      ? ""
      : path.startsWith("/")
        ? path
        : `/${path}`;
  return `${base}${suffix}`;
}

function buildMockLogsResponse(mock) {
  const allRows = (Array.isArray(mock.proxy_logs) ? mock.proxy_logs : []).slice(
    0,
    LOGS_CAP,
  );
  const aliasSet = new Set();
  const statusSet = new Set();
  for (const r of allRows) {
    if (r?.alias) aliasSet.add(r.alias);
    if (Number.isInteger(r?.status)) statusSet.add(r.status);
  }

  const aliasFilter = (dom.logsFAlias?.value || "").trim();
  const statusFilter = (dom.logsFStatus?.value || "").trim().toLowerCase();
  const keyFilter = (dom.logsFKey?.value || "").trim().toLowerCase();
  const modelFilter = (dom.logsFModel?.value || "").trim().toLowerCase();
  const toCutoffMs = parseLogToCutoffMs(dom.logsFTo?.value || "");

  const filtered = allRows.filter((r) => {
    if (!r) return false;
    if (aliasFilter && r.alias !== aliasFilter) return false;
    if (statusFilter) {
      const code = Number(r.status);
      if (statusFilter === "ok" && !(code >= 200 && code < 300)) return false;
      if (statusFilter === "fail" && code >= 200 && code < 300) return false;
      if (statusFilter !== "ok" && statusFilter !== "fail") {
        if (code !== Number(statusFilter)) return false;
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
      const m = String(r.model || "").toLowerCase();
      if (!m.includes(modelFilter)) return false;
    }
    if (toCutoffMs !== null) {
      const ts = Number(r.ts);
      if (!Number.isFinite(ts) || ts > toCutoffMs) return false;
    }
    return true;
  });

  const total = filtered.length;
  const totalPages =
    total === 0
      ? 1
      : Math.min(LOGS_MAX_PAGES, Math.ceil(total / LOGS_PAGE_SIZE));
  const currentPage = Math.min(
    Math.max(1, Number(state.logsPage) || 1),
    totalPages,
  );
  const start = (currentPage - 1) * LOGS_PAGE_SIZE;
  const logs = filtered.slice(start, start + LOGS_PAGE_SIZE).map((r) => {
    const { api_key: rawKey, ...rest } = r;
    return {
      ...rest,
      key_masked: rawKey ? maskKey(rawKey) : rest.key_masked || null,
    };
  });

  return {
    ok: true,
    logs,
    total,
    page: currentPage,
    page_size: LOGS_PAGE_SIZE,
    total_pages: totalPages,
    facets: {
      aliases: [...aliasSet].sort(),
      statuses: [...statusSet].sort((a, b) => a - b),
    },
  };
}

async function loadProxyLogs({ resetPage = false } = {}) {
  const reqId = ++state.reqSeq.logs;
  if (isKvStorageMode()) {
    dom.logsLoading.classList.add("hidden");
    return;
  }
  if (resetPage) state.logsPage = 1;

  dom.logsError.classList.add("hidden");
  if (!state.logsData) {
    fillLogsFilterSelects({});
    dom.logsLoading.classList.remove("hidden");
    dom.logsEmpty.classList.add("hidden");
    dom.logsTableWrap.classList.add("hidden");
    dom.logsPagination.classList.add("hidden");
  }

  try {
    let data;
    if (MOCK) {
      const mock = await getMock();
      if (!state.settings) {
        applyFetchedSettings({
          settings: mock.settings || {},
          storage_backend: mock.storage_backend || "d1",
        });
      }
      data = buildMockLogsResponse(mock);
    } else {
      const params = new URLSearchParams();
      params.set("page", String(Math.max(1, Number(state.logsPage) || 1)));
      const aliasVal = (dom.logsFAlias?.value || "").trim();
      const statusVal = (dom.logsFStatus?.value || "").trim();
      const keyVal = (dom.logsFKey?.value || "").trim();
      const modelVal = (dom.logsFModel?.value || "").trim();
      const toCutoffMs = parseLogToCutoffMs(dom.logsFTo?.value || "");
      if (aliasVal) params.set("alias", aliasVal);
      if (statusVal) params.set("status", statusVal);
      if (keyVal) params.set("key", keyVal);
      if (modelVal) params.set("model", modelVal);
      if (toCutoffMs !== null) params.set("to_ts", String(toCutoffMs));
      data = await api(`/api/proxy/logs?${params.toString()}`, { auth: true });
    }
    if (reqId !== state.reqSeq.logs) return;
    state.logsData = data;
    state.logsPage = data.page || 1;
    fillLogsFilterSelects(data.facets || {});
    renderProxyLogs(data);
  } catch (err) {
    if (reqId !== state.reqSeq.logs) return;
    dom.logsError.textContent = `读取失败：${err.message}`;
    dom.logsError.classList.remove("hidden");
  } finally {
    if (reqId === state.reqSeq.logs) {
      dom.logsLoading.classList.add("hidden");
    }
  }
}

function hasActiveLogsFilter() {
  return !!(
    (dom.logsFAlias && dom.logsFAlias.value.trim()) ||
    (dom.logsFStatus && dom.logsFStatus.value.trim()) ||
    (dom.logsFKey && dom.logsFKey.value.trim()) ||
    (dom.logsFModel && dom.logsFModel.value.trim()) ||
    parseFilterDate(dom.logsFTo?.value || "")
  );
}

function renderProxyLogs(data) {
  const rows = Array.isArray(data?.logs) ? data.logs : [];

  if (!rows.length) {
    dom.logsEmpty.textContent = hasActiveLogsFilter()
      ? "没有符合筛选条件的请求记录。"
      : "尚无请求记录。";
    dom.logsEmpty.classList.remove("hidden");
    dom.logsTableWrap.classList.add("hidden");
    renderStepperPagination(dom.logsPagination, 1, 0, () => {});
    return;
  }

  const scroller = dom.logsTableWrap.querySelector(".table-scroll");
  const scrollLeft = scroller ? scroller.scrollLeft : 0;
  dom.logsEmpty.classList.add("hidden");

  const tbody = rows
    .map((r) => {
      const fullTime = proxyTimeTitle(r.ts);
      const timeAttr = fullTime ? ` title="${escAttr(fullTime)}"` : "";
      const routeTitle = `${r.method || "POST"} /proxy/${r.alias || ""}${r.path || ""}`;
      const modelText = r.model || "-";
      const ttfb = r.stream ? formatLogLatency(r.ttfb_ms) : "-";
      const dur = formatLogLatency(r.duration_ms ?? r.ttfb_ms);
      const latencyHtml = esc(dur);
      const latencyTitle = `TTFB: ${ttfb} · 总耗时: ${dur}`;
      const streamText = r.stream ? "是" : "否";
      const keyMask = r.key_masked || "";
      const localPlain = resolveLogPlainKeyLocally(r.alias, keyMask);
      const copyAttr = localPlain
        ? `data-copy-val="${escAttr(localPlain)}"`
        : `data-log-copy-id="${escAttr(String(r.id))}"`;
      const copyBtn = keyMask
        ? `<button class="btn btn-ghost btn-xs btn-icon copy-btn" type="button" title="复制 KEY" aria-label="复制 KEY" ${copyAttr}>${COPY_ICON_SVG}</button>`
        : "";
      const keyCell = keyMask
        ? `<div class="dk-key-line"><code class="dk-key-cell" title="${escAttr(keyMask)}">${esc(keyMask)}</code>${copyBtn}</div>`
        : `<span class="na">-</span>`;

      return `<tr>
        <td class="logs-time-col"${timeAttr}>${esc(formatLogClock(r.ts))}</td>
        <td class="logs-alias-col"><span class="logs-ellipsis" title="${escAttr(routeTitle)}">${esc(r.alias || "-")}</span></td>
        <td class="logs-status-col">${renderLogStatusBadge(r.status)}</td>
        <td class="logs-model-col"><div class="logs-model-line"><span class="logs-model-name" title="${escAttr(modelText)}">${esc(modelText)}</span></div></td>
        <td class="logs-key-col">${keyCell}</td>
        <td class="logs-latency-col" title="${escAttr(latencyTitle)}">${latencyHtml}</td>
        <td class="logs-stream-col">${esc(streamText)}</td>
        <td class="logs-action-col"><button class="btn btn-ghost btn-xs" type="button" data-log-detail="${escAttr(String(r.id))}">查看</button></td>
      </tr>`;
    })
    .join("");

  dom.logsTableWrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table logs-table">
        <thead><tr>
          <th class="logs-time-col" scope="col">时间</th>
          <th class="logs-alias-col" scope="col">供应商</th>
          <th class="logs-status-col" scope="col">状态码</th>
          <th class="logs-model-col" scope="col">模型</th>
          <th class="logs-key-col" scope="col">密钥</th>
          <th class="logs-latency-col" scope="col">耗时</th>
          <th class="logs-stream-col" scope="col">串流</th>
          <th class="logs-action-col" scope="col">详情</th>
        </tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
  `;
  const nextScroller = dom.logsTableWrap.querySelector(".table-scroll");
  if (nextScroller) nextScroller.scrollLeft = scrollLeft;
  dom.logsTableWrap.classList.remove("hidden");

  renderStepperPagination(
    dom.logsPagination,
    data.page || 1,
    data.total_pages || 1,
    (nextPage) => {
      state.logsPage = nextPage;
      loadProxyLogs();
    },
  );
}

function scheduleLogsFilterReload() {
  if (_logsSearchTimer) clearTimeout(_logsSearchTimer);
  _logsSearchTimer = setTimeout(() => {
    _logsSearchTimer = null;
    loadProxyLogs({ resetPage: true });
  }, 200);
}

async function openLogDetail(id) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) return;

  dom.logDetailContent.innerHTML = `<p class="muted">读取详情中...</p>`;
  openModal(dom.logDetailOverlay, dom.logDetailClose);

  try {
    let log;
    if (MOCK) {
      const mock = await getMock();
      const found = (mock.proxy_logs || []).find(
        (r) => r && Number(r.id) === numId,
      );
      if (!found) throw new Error("找不到该笔请求记录");
      log = {
        ...found,
        key_masked: found.api_key ? maskKey(found.api_key) : null,
      };
    } else {
      const d = await api(`/api/proxy/logs?id=${encodeURIComponent(String(numId))}`, {
        auth: true,
      });
      log = d.log;
    }
    renderLogDetailModal(log);
  } catch (err) {
    dom.logDetailContent.innerHTML = `<div class="alert alert-error">${esc(`读取失败：${err.message}`)}</div>`;
  }
}

function formatPayloadForDisplay(raw) {
  if (raw == null || raw === "") return "";
  const str = String(raw);
  const trimmed = str.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return str;
    }
  }
  return str;
}

function renderLogDetailModal(log) {
  if (!log) return;
  const route = `${log.method || "POST"} /proxy/${log.alias || ""}${log.path || ""}`;
  const upstreamUrl = log.upstream_url || resolveLogUpstreamUrl(log) || "-";
  const userAgent = log.user_agent || "-";

  const fullTime = proxyTimeTitle(log.ts) || formatLogClock(log.ts);
  const keyMasked = log.key_masked || (log.api_key ? maskKey(log.api_key) : "-");
  const keyCopyBtn = log.api_key
    ? `<button class="btn btn-ghost btn-xs btn-icon copy-btn" type="button" title="复制 KEY" aria-label="复制 KEY" data-copy-val="${escAttr(log.api_key)}">${COPY_ICON_SVG}</button>`
    : "";

  const ttfbText = log.stream ? formatLogLatency(log.ttfb_ms) : "-";
  const durText = formatLogLatency(log.duration_ms);
  const streamText = log.stream ? "是" : "否";

  const reqFormatted = formatPayloadForDisplay(log.req_body);
  const resFormatted = formatPayloadForDisplay(log.res_body);

  const renderPayloadSection = (title, content) => {
    const copyBtn = content
      ? `<button class="btn btn-ghost btn-xs btn-icon copy-btn" type="button" title="复制内容" aria-label="复制内容" data-copy-val="${escAttr(content)}">${COPY_ICON_SVG}</button>`
      : "";
    return `<div class="logdetail-section">
      <div class="logdetail-section-head">
        <span class="sample-block-label">${esc(title)}</span>
        ${copyBtn}
      </div>
      ${
        content
          ? `<pre class="sample-pre">${esc(content)}</pre>`
          : `<p class="muted">（无内容）</p>`
      }
    </div>`;
  };

  dom.logDetailContent.innerHTML = `
    <div class="logdetail-route-box">
      <div class="logdetail-meta-item">
        <span class="logdetail-meta-label">请求格式</span>
        <span class="logdetail-meta-val">${esc(route)}</span>
      </div>
      <div class="logdetail-meta-item">
        <span class="logdetail-meta-label">请求上游</span>
        <span class="logdetail-meta-val">${esc(upstreamUrl)}</span>
      </div>
      <div class="logdetail-meta-item">
        <span class="logdetail-meta-label">User Agent</span>
        <span class="logdetail-meta-val">${esc(userAgent)}</span>
      </div>
    </div>
    <div class="logdetail-meta-grid">
      <div class="logdetail-meta-item">
        <span class="logdetail-meta-label">时间</span>
        <span class="logdetail-meta-val">${esc(fullTime)}</span>
      </div>
      <div class="logdetail-meta-item">
        <span class="logdetail-meta-label">供应商 / 格式</span>
        <span class="logdetail-meta-val">${esc(`${log.alias || "-"} (${log.provider_type || "-"})`)}</span>
      </div>
      <div class="logdetail-meta-item">
        <span class="logdetail-meta-label">状态码</span>
        <span class="logdetail-meta-val">${renderLogStatusBadge(log.status)}</span>
      </div>
      <div class="logdetail-meta-item">
        <span class="logdetail-meta-label">模型</span>
        <span class="logdetail-meta-val">${esc(log.model || "-")}</span>
      </div>
      <div class="logdetail-meta-item">
        <span class="logdetail-meta-label">密钥</span>
        <span class="logdetail-meta-val"><span>${esc(keyMasked)}</span>${keyCopyBtn}</span>
      </div>
      <div class="logdetail-meta-item">
        <span class="logdetail-meta-label">TTFB / 总耗时</span>
        <span class="logdetail-meta-val">${esc(`${ttfbText} / ${durText}`)}</span>
      </div>
      <div class="logdetail-meta-item">
        <span class="logdetail-meta-label">串流</span>
        <span class="logdetail-meta-val">${esc(streamText)}</span>
      </div>
      ${
        log.colo
          ? `<div class="logdetail-meta-item">
              <span class="logdetail-meta-label">边缘节点</span>
              <span class="logdetail-meta-val">${esc(log.colo)}</span>
            </div>`
          : ""
      }
    </div>
    ${renderPayloadSection("请求内容", reqFormatted)}
    ${renderPayloadSection("响应内容", resFormatted)}
  `;
}

function closeLogDetail() {
  closeModal(dom.logDetailOverlay);
}
