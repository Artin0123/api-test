// Split from the original app.js; loaded in original order (see index.html).
// ── Proxy tab (rotation / forwarding) ──────────────────────────────────────
function proxyProviders() {
  return ((state.proxy && state.proxy.providers) || []).filter(
    (p) => p && String(p.alias || "").trim(),
  );
}

function selectedProxyProvider() {
  const providers = proxyProviders();
  return (
    providers.find((p) => p.fp === state.proxySelected) ||
    providers[0] ||
    null
  );
}

function setProxyNotice(text, level = "info") {
  dom.proxyNotice.className = `alert alert-${level}`;
  dom.proxyNotice.textContent = text;
  dom.proxyNotice.classList.remove("hidden");
}

function clearProxyNotice({ keepGlobal = true } = {}) {
  if (keepGlobal && state.proxy && !state.proxy.proxy_enabled) {
    setProxyNotice(state.proxy.proxy_message || "转发功能目前停用", "error");
    return;
  }
  dom.proxyNotice.classList.add("hidden");
}

async function syncProxyPlainKeys(proxyProviders) {
  if (MOCK) return;

  const listMatchesProvider = (list, pp) => {
    const keys = pp.keys || [];
    if (!Array.isArray(list) || list.length !== keys.length) return false;
    return keys.every((k, i) => maskKey(list[i]) === k.masked);
  };

  const buildByFp = async (forceReload = false) => {
    if (!state.settings || forceReload) {
      const d = await api("/api/settings", { auth: true });
      applyFetchedSettings(d);
    }
    await ensureProviderFps(state.settings.providers || []);
    const byFp = new Map();
    for (const p of state.settings.providers || []) {
      const fp = cachedProviderFp(p);
      if (fp) byFp.set(fp, splitKeyLines(p.keys));
    }
    return byFp;
  };

  let byFp = await buildByFp(false);
  if (
    (proxyProviders || []).some(
      (pp) => pp && !listMatchesProvider(byFp.get(pp.fp), pp),
    )
  ) {
    byFp = await buildByFp(true);
  }

  const map = new Map();
  for (const pp of proxyProviders || []) {
    if (pp && pp.fp) map.set(pp.fp, byFp.get(pp.fp) || []);
  }
  state.proxyPlainKeys = map;
}

async function loadProxyState({ preserveOrder = false } = {}) {
  const reqId = ++state.reqSeq.proxy;
  if (isKvStorageMode()) {
    dom.proxyLoading.classList.add("hidden");
    return false;
  }
  // Keep existing toolbar/cards visible during in-place test refreshes so the
  // layout does not collapse/flash or jump the scroll position.
  if (!preserveOrder || !state.proxy) {
    dom.proxyKeyEmpty.classList.add("hidden");
    dom.proxyToolbar.classList.add("hidden");
    dom.proxyKeyGrid.classList.add("hidden");
    dom.proxyPagination.classList.add("hidden");
  }
  clearProxyNotice({ keepGlobal: false });

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
      if (isKvStorageMode()) return false;
      await ensureProviderFps(state.settings.providers || []);
      data = mockProxyState(state.settings);
    } else {
      data = await api("/api/proxy/state", { auth: true });
    }
    if (reqId !== state.reqSeq.proxy) return false;
    const providers = data.providers || [];
    if (!MOCK) {
      await syncProxyPlainKeys(providers);
      if (reqId !== state.reqSeq.proxy) return false;
    } else {
      state.proxyPlainKeys.clear();
      for (const p of providers) {
        state.proxyPlainKeys.set(p.fp, p._mockPlainKeys || []);
      }
    }
    state.proxy = data;
    const visibleProviders = proxyProviders();
    const active =
      visibleProviders.find((p) => p.fp === state.proxySelected) ||
      visibleProviders[0] ||
      null;
    state.proxySelected = active ? active.fp : null;
    renderProxyState(data, { preserveOrder });
    return true;
  } catch (err) {
    if (reqId !== state.reqSeq.proxy) return false;
    dom.proxyError.textContent = `读取失败：${err.message}`;
    dom.proxyError.classList.remove("hidden");
    return false;
  } finally {
    if (reqId === state.reqSeq.proxy) {
      dom.proxyLoading.classList.add("hidden");
    }
  }
}

function mockOverrideForProvider(fp) {
  let override = state.mockProxyOverrides.get(fp);
  if (!override) {
    override = { test_model: "", keys: new Map() };
    state.mockProxyOverrides.set(fp, override);
  }
  return override;
}

function mockProxyState(settings) {
  const logsUrl = String(settings.ai_gateway_logs_url || "").trim();
  const gwToken = String(settings.ai_gateway_token || "").trim();
  const proxyPass = String(settings.proxy_password || "").trim();
  const gatewayReady = !!(isValidGatewayLogsUrl(logsUrl) && gwToken);
  let proxyMessage = "";
  if (!proxyPass) proxyMessage = "代理密码未设定，请到右上角「设定」填写后再启用转发";
  else if (!isValidGatewayLogsUrl(logsUrl))
    proxyMessage = "AI Gateway Logs URL 未设定或格式无效，请到右上角「设定」填写";
  else if (!gwToken) proxyMessage = "AI Gateway Token 未设定，请到右上角「设定」填写";

  const providers = (settings.providers || [])
    .filter((p) => p && String(p.alias || "").trim())
    .map((p, i) => {
    const fp = cachedProviderFp(p) || `mock-${i}`;
    const override = mockOverrideForProvider(fp);
    const keys = splitKeyLines(p.keys);
    const keyEntries = keys.map((key, ki) => {
      let entryState = override.keys.get(key);
      if (!entryState) {
        const disabled = keys.length > 1 && ki === keys.length - 1;
        entryState = {
          disabled,
          fail_count: disabled ? 3 : 0,
          last_used_at: disabled
            ? Date.now() - 3 * 3600 * 1000
            : ki === 0
              ? Date.now() - 25 * 1000
              : null,
        };
        override.keys.set(key, entryState);
      }
      return {
        id: i * 100 + ki + 1,
        masked: maskKey(key),
        disabled: !!entryState.disabled,
        fail_count: Number(entryState.fail_count || 0),
        last_used_at: entryState.last_used_at,
        synced: true,
      };
    });
    return {
      fp,
      _mockPlainKeys: keys,
      alias: p.alias || "",
      host: extractHost(p.api_base),
      provider_type: p.provider_type || "openai",
      enabled: p.enabled !== false,
      via_gateway: !!(gatewayReady && p.alias),
      proxy_url: p.alias ? `/proxy/${p.alias}` : "",
      sample_path:
        ({
          google: "/v1beta/models/{model}:streamGenerateContent?alt=sse",
          anthropic: "/messages",
        })[p.provider_type] || "/chat/completions",
      test_model: override.test_model || "",
      logs_url: isValidGatewayLogsUrl(logsUrl) ? logsUrl : "",
      models: splitModels(p.models),
      keys_total: keyEntries.length,
      keys_available: keyEntries.filter((k) => !k.disabled).length,
      keys: keyEntries,
    };
  });
  return {
    ok: true,
    backend: "d1",
    proxy_enabled: !proxyMessage,
    proxy_message: proxyMessage,
    gateway_ready: gatewayReady,
    logs_url_template: logsUrl,
    providers,
  };
}

function proxyTimeLabel(ms) {
  if (!ms) return "从未";
  const ts = Number(ms);
  if (!Number.isFinite(ts)) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "60 秒前";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} 天前`;
}

function proxyTimeTitle(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function renderProxyState(data, { preserveOrder = false } = {}) {
  const providers = proxyProviders();
  if (!data.proxy_enabled) {
    setProxyNotice(data.proxy_message || "转发功能目前停用", "error");
  }
  if (!providers.length) {
    dom.proxyEmpty.classList.remove("hidden");
    dom.proxyToolbar.classList.add("hidden");
    dom.proxyKeyGrid.classList.add("hidden");
    dom.proxyKeyEmpty.classList.add("hidden");
    dom.proxyPagination.classList.add("hidden");
    renderProxyLogsLink();
    return;
  }

  dom.proxyProvider.replaceChildren();
  for (const p of providers) {
    const opt = document.createElement("option");
    opt.value = p.fp;
    // The menu answers two questions at once — which provider, and what API it
    // speaks. The format used to be a separate pill under the select; folding it
    // into the option text keeps one row and makes each choice self-describing.
    opt.textContent = providerFormatLabel(p, p.host);
    if (p.fp === state.proxySelected) opt.selected = true;
    dom.proxyProvider.appendChild(opt);
  }
  syncCustomSelect(dom.proxyProvider);

  dom.proxyEmpty.classList.add("hidden");
  dom.proxyToolbar.classList.remove("hidden");
  renderProxyToolbar();
  renderProxyKeyCards({ preserveOrder });
}

/** The probe model options come from the provider's own Models field in 来源设定,
 *  not from a second text box on this tab. A saved value that is no longer in that
 *  comma list stays at the top, so an edit over there cannot silently turn the
 *  current selection into a different model. */
function proxyModelOptions(p) {
  const list = Array.isArray(p.models) ? p.models : splitModels(p.models);
  const models = [
    ...new Set(list.map((m) => String(m).trim()).filter(Boolean)),
  ];
  const saved = String(p.test_model || "").trim();
  if (saved && !models.includes(saved)) models.unshift(saved);
  return models;
}

function renderProxyModelSelect(p) {
  const models = proxyModelOptions(p);
  const saved = String(p.test_model || "").trim();
  dom.proxyTestModel.replaceChildren();
  if (!models.length) {
    syncCustomSelect(dom.proxyTestModel);
    return;
  }
  for (const model of models) {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    dom.proxyTestModel.appendChild(opt);
  }
  // Default to the saved model while still listed, otherwise the first option.
  // The chosen model is persisted only when the operator clicks a Test button.
  dom.proxyTestModel.value =
    saved && models.includes(saved) ? saved : models[0];
  syncCustomSelect(dom.proxyTestModel);
}

function proxyDisabledReason() {
  if (!state.proxy || !state.proxy.proxy_enabled) {
    return (state.proxy && state.proxy.proxy_message) || "转发功能目前停用";
  }
  return "";
}

function proxyCardTitles() {
  const blockReason = proxyDisabledReason();
  return {
    testTitle: blockReason,
    manageTitle: blockReason,
  };
}

function renderProxyToolbar() {
  const p = selectedProxyProvider();
  if (!p) return;
  const blockReason = proxyDisabledReason();
  const enabled = !blockReason;
  const url = `${location.origin}${p.proxy_url}`;

  const available = Number(p.keys_available || 0);
  const total = Number(p.keys_total || 0);
  const disabled = Math.max(total - available, 0);
  // Single neutral label + control-height segmented two-cell readout so counts
  // stay framed alongside the adjacent select/button row and hover reveals meaning.
  const labelSpan = document.createElement("span");
  labelSpan.className = "proxy-summary-label";
  labelSpan.textContent = "密钥状态";

  const makeCount = (cls, count, title) => {
    const span = document.createElement("span");
    span.className = `proxy-summary-cell ${cls} proxy-summary-num`;
    span.textContent = String(count);
    span.title = title;
    return span;
  };
  const countsGroup = document.createElement("span");
  countsGroup.className = "proxy-summary-group";
  countsGroup.append(
    makeCount("proxy-summary-ok", available, "有效数量"),
    makeCount("proxy-summary-fail", disabled, "无效数量"),
  );
  dom.proxySummary.setAttribute(
    "aria-label",
    `有效 ${available}，无效 ${disabled}`,
  );
  dom.proxySummary.replaceChildren(labelSpan, countsGroup);
  dom.proxyUrl.textContent = url;
  dom.proxyUrl.classList.remove("is-disabled");
  dom.proxyUrlCopy.dataset.copyVal = url;
  dom.proxyUrlCopy.disabled = false;
  dom.proxyTestModel.disabled = !enabled;
  renderProxyModelSelect(p);

  const hasKeys = (p.keys || []).some((k) => k.id != null);
  const hasDisabledKeys = (p.keys || []).some((k) => k.disabled && k.id != null);
  const canTest = enabled && hasKeys;
  const testTitle =
    blockReason || (!hasKeys ? "当前供应商没有密钥" : "");
  for (const btn of [dom.proxyTestActive, dom.proxyTestDisabled]) {
    btn.disabled = !canTest || state.proxyBusy;
    btn.title = testTitle;
  }
  dom.proxyRecoverAll.disabled = !enabled || !hasDisabledKeys || state.proxyBusy;
  dom.proxyRecoverAll.title =
    blockReason ||
    (!hasDisabledKeys
      ? "当前供应商没有已失效的密钥"
      : "恢复当前供应商下的所有失效密钥");
  renderProxyLogsLink();
}

/** The Gateway log shortcut sits in the results/proxy panel header: it is a
 *  whole-provider/gateway view, not one of the probe controls. When there is no
 *  Logs URL or no provider, the link turns aria-disabled cleanly. */
function renderProxyLogsLink() {
  const p = selectedProxyProvider();
  const url = p && p.logs_url;
  if (url) {
    dom.proxyLogs.href = url;
    dom.proxyLogs.removeAttribute("aria-disabled");
    const filtered = /(?:\?|&)provider=/i.test(url);
    dom.proxyLogs.title = filtered
      ? "打开 AI Gateway 日志（已按服务商过滤）"
      : "打开 AI Gateway 日志";
    return;
  }
  dom.proxyLogs.removeAttribute("href");
  dom.proxyLogs.setAttribute("aria-disabled", "true");
  dom.proxyLogs.title = p
    ? "请在右上角「设定」填写 AI Gateway Logs URL 后可用"
    : "尚无服务商，先到「来源设定」添加";
}

function updateProxyCardButtonsDisabled() {
  const p = selectedProxyProvider();
  if (!p) return;
  const enabled = !proxyDisabledReason();
  const canAct = enabled;
  const { testTitle, manageTitle } = proxyCardTitles();
  for (const btn of dom.proxyKeyGrid.querySelectorAll("[data-proxy-test]")) {
    const id = btn.dataset.proxyTest;
    const token = `${btn.dataset.fp}:${id}`;
    const busy =
      state.proxyBusy ||
      state.proxyTestingKeys.has(token) ||
      state.proxyRecoveringKeys.has(token) ||
      state.proxyDisablingKeys.has(token);
    btn.disabled = !canAct || !id || busy;
    btn.title = testTitle || (!id ? "密钥尚未同步" : "");
  }
  for (const btn of dom.proxyKeyGrid.querySelectorAll("[data-proxy-recover]")) {
    const id = btn.dataset.proxyRecover;
    const token = `${btn.dataset.fp}:${id}`;
    const busy =
      state.proxyBusy ||
      state.proxyRecoveringKeys.has(token) ||
      state.proxyTestingKeys.has(token);
    btn.disabled = !enabled || !id || busy;
    btn.title = manageTitle || (!id ? "密钥尚未同步" : "");
  }
  for (const btn of dom.proxyKeyGrid.querySelectorAll("[data-proxy-disable]")) {
    const id = btn.dataset.proxyDisable;
    const token = `${btn.dataset.fp}:${id}`;
    const busy =
      state.proxyBusy ||
      state.proxyDisablingKeys.has(token) ||
      state.proxyTestingKeys.has(token);
    btn.disabled = !enabled || !id || busy;
    btn.title = manageTitle || (!id ? "密钥尚未同步" : "");
  }
}

const PROXY_PAGE_SIZE = 9;
const PAGE_PREV_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
const PAGE_NEXT_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
const PAGE_CANCEL_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
const PAGE_GO_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;

function goToProxyPage(page, totalPages) {
  const next = Math.min(totalPages, Math.max(1, Number(page) || 1));
  if (next === state.proxyPage) return;
  state.proxyPage = next;
  renderProxyKeyCards();
}

function renderProxyPagination(totalPages) {
  if (!dom.proxyPagination) return;
  if (totalPages <= 1) {
    dom.proxyPagination.replaceChildren();
    dom.proxyPagination.classList.add("hidden");
    return;
  }

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "btn btn-secondary btn-sm proxy-page-btn";
  prevBtn.setAttribute("aria-label", "上一页");

  const pageBox = document.createElement("div");
  pageBox.className = "proxy-page-box";

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = 3;
  input.className = "proxy-page-input";
  input.value = String(state.proxyPage);
  input.setAttribute("aria-label", "页码");

  const sepSpan = document.createElement("span");
  sepSpan.className = "proxy-page-sep";
  sepSpan.textContent = "/";

  const totalSpan = document.createElement("span");
  totalSpan.className = "proxy-page-total";
  totalSpan.textContent = String(totalPages);
  pageBox.append(input, sepSpan, totalSpan);

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn btn-secondary btn-sm proxy-page-btn";
  nextBtn.setAttribute("aria-label", "下一页");

  let isDirty = false;
  const syncPaginationControls = () => {
    const raw = input.value.trim();
    const parsed = Number(raw);
    isDirty = raw !== String(state.proxyPage);
    if (isDirty) {
      prevBtn.innerHTML = PAGE_CANCEL_SVG;
      prevBtn.title = "取消";
      prevBtn.setAttribute("aria-label", "取消");
      prevBtn.disabled = false;
      nextBtn.innerHTML = PAGE_GO_SVG;
      nextBtn.title = "前往";
      nextBtn.setAttribute("aria-label", "前往");
      nextBtn.disabled = !raw || !Number.isInteger(parsed);
    } else {
      prevBtn.innerHTML = PAGE_PREV_SVG;
      prevBtn.title = "上一页";
      prevBtn.setAttribute("aria-label", "上一页");
      prevBtn.disabled = state.proxyPage <= 1;
      nextBtn.innerHTML = PAGE_NEXT_SVG;
      nextBtn.title = "下一页";
      nextBtn.setAttribute("aria-label", "下一页");
      nextBtn.disabled = state.proxyPage >= totalPages;
    }
  };

  const submitPage = () => {
    const raw = input.value.trim();
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed)) return;
    const clamped = Math.min(totalPages, Math.max(1, parsed));
    if (clamped === state.proxyPage) {
      input.value = String(state.proxyPage);
      syncPaginationControls();
    } else {
      goToProxyPage(clamped, totalPages);
    }
  };

  input.addEventListener("input", () => {
    const cleaned = input.value.replace(/\D+/g, "").slice(0, 3);
    if (input.value !== cleaned) input.value = cleaned;
    syncPaginationControls();
  });
  pageBox.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const cur = Number.parseInt(input.value, 10) || state.proxyPage;
      const next = Math.min(
        totalPages,
        Math.max(1, cur + (e.deltaY < 0 ? 1 : -1)),
      );
      input.value = String(next);
      syncPaginationControls();
    },
    { passive: false },
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitPage();
    } else if (e.key === "Escape") {
      input.value = String(state.proxyPage);
      syncPaginationControls();
    } else if (
      e.key.length === 1 &&
      !/^\d$/.test(e.key) &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
    }
  });
  prevBtn.addEventListener("click", () => {
    if (isDirty) {
      input.value = String(state.proxyPage);
      syncPaginationControls();
    } else {
      goToProxyPage(state.proxyPage - 1, totalPages);
    }
  });
  nextBtn.addEventListener("click", () => {
    if (isDirty) {
      submitPage();
    } else {
      goToProxyPage(state.proxyPage + 1, totalPages);
    }
  });

  syncPaginationControls();
  dom.proxyPagination.replaceChildren(prevBtn, pageBox, nextBtn);
  dom.proxyPagination.classList.remove("hidden");
}

function renderProxyKeyCards({ preserveOrder = false } = {}) {
  const p = selectedProxyProvider();
  if (!p) return;
  const keys = p.keys || [];
  const enabled = !proxyDisabledReason();
  if (!keys.length) {
    // Sibling of the grid, not a grid item: a .state-card dropped inside the
    // grid used to render as one 280px column instead of a full-width notice.
    dom.proxyKeyGrid.replaceChildren();
    dom.proxyKeyGrid.classList.add("hidden");
    dom.proxyKeyEmpty.classList.remove("hidden");
    renderProxyPagination(0);
    return;
  }
  dom.proxyKeyEmpty.classList.add("hidden");
  const canAct = enabled;
  const { testTitle, manageTitle } = proxyCardTitles();
  const totalPages = Math.max(1, Math.ceil(keys.length / PROXY_PAGE_SIZE));
  state.proxyPage = Math.min(
    totalPages,
    Math.max(1, Number(state.proxyPage) || 1),
  );
  const plainList = state.proxyPlainKeys.get(p.fp) || [];
  const keepSnapshot =
    preserveOrder &&
    state.proxyCardOrder &&
    state.proxyCardOrder.fp === p.fp &&
    state.proxyCardOrder.indices.length === keys.length;
  // Sort active keys before disabled ones on fresh loads, keeping fail_count > 0
  // active keys in their original 来源设定 order, and keep card positions fixed
  // when reloading right after manual/batch tests.
  const ordered = keepSnapshot
    ? state.proxyCardOrder.indices.map((idx) => ({
        k: keys[idx],
        idx,
        candidate: plainList[idx] || "",
      }))
    : keys
        .map((k, idx) => ({ k, idx, candidate: plainList[idx] || "" }))
        .sort((a, b) => {
          const da = a.k.disabled ? 1 : 0;
          const db = b.k.disabled ? 1 : 0;
          return da - db || a.idx - b.idx;
        });
  state.proxyCardOrder = { fp: p.fp, indices: ordered.map((item) => item.idx) };
  const startIdx = (state.proxyPage - 1) * PROXY_PAGE_SIZE;
  const pageKeys = ordered.slice(startIdx, startIdx + PROXY_PAGE_SIZE);
  dom.proxyKeyGrid.innerHTML = pageKeys
    .map(({ k, candidate }) => {
      const id = k.id == null ? "" : String(k.id);
      const mask = esc(k.masked || "");
      const rawKey = candidate && maskKey(candidate) === k.masked ? candidate : "";
      const copyBtn = rawKey
        ? `<button class="btn btn-ghost btn-xs btn-icon copy-btn" type="button" title="复制 KEY" aria-label="复制 KEY" data-copy-val="${escAttr(rawKey)}">${COPY_ICON_SVG}</button>`
        : "";
      const token = `${p.fp}:${id}`;
      const keyBusy =
        state.proxyBusy ||
        state.proxyTestingKeys.has(token) ||
        state.proxyRecoveringKeys.has(token) ||
        state.proxyDisablingKeys.has(token);
      const recoverDisabled = !enabled || !id || keyBusy;
      const disableDisabled = !enabled || !id || keyBusy;
      const cardTestTitle = testTitle || (!id ? "密钥尚未同步" : "");
      const cardManageTitle = manageTitle || (!id ? "密钥尚未同步" : "");
      const cardTestTitleAttr = cardTestTitle ? ` title="${escAttr(cardTestTitle)}"` : "";
      const cardManageTitleAttr = cardManageTitle ? ` title="${escAttr(cardManageTitle)}"` : "";
      const actionBtn = k.disabled
        ? `<button class="btn btn-secondary btn-sm" type="button" data-proxy-recover="${escAttr(id)}" data-fp="${escAttr(p.fp)}"${cardManageTitleAttr}${recoverDisabled ? " disabled" : ""}>恢复</button>`
        : `<button class="btn btn-danger btn-sm" type="button" data-proxy-disable="${escAttr(id)}" data-fp="${escAttr(p.fp)}"${cardManageTitleAttr}${disableDisabled ? " disabled" : ""}>禁用</button>`;
      const testDisabled = !canAct || !id || keyBusy;
      const stateTag = k.disabled
        ? `<span class="proxy-key-state-tag">已失效</span>`
        : "";
      const timeTitle = proxyTimeTitle(k.last_used_at);
      const timeAttr = timeTitle ? ` title="${escAttr(timeTitle)}"` : "";
      return `
        <article class="proxy-key-card${k.disabled ? " proxy-key-card--disabled" : ""}" data-key-id="${escAttr(id)}">
          <div class="proxy-key-card-head">
            <code class="proxy-key-mask" title="${mask}">${mask}</code>
            ${copyBtn}
          </div>
          <div class="proxy-key-card-meta">
            <span>失败 <strong data-proxy-fail-count>${Number(k.fail_count || 0)}</strong></span>
            <span${timeAttr}>最近使用 ${esc(proxyTimeLabel(k.last_used_at))}</span>
          </div>
          <div class="proxy-key-card-actions">
            ${stateTag}
            <div class="proxy-key-card-btns">
              <button class="btn btn-secondary btn-sm" type="button" data-proxy-test="${escAttr(id)}" data-fp="${escAttr(p.fp)}"${cardTestTitleAttr}${testDisabled ? " disabled" : ""}>测试</button>
              ${actionBtn}
            </div>
          </div>
        </article>`;
    })
    .join("");
  dom.proxyKeyGrid.classList.remove("hidden");
  renderProxyPagination(totalPages);
}
