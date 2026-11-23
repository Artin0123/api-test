// Split from the original app.js; loaded in original order (see index.html).
// ── Proxy tab (rotation / forwarding) ──────────────────────────────────────
const PROXY_LIVE_TICK_MS = 1000;
const PROXY_STATE_POLL_MS = 2000;

let _proxyClockTimer = null;
let _proxyPollTimer = null;
let _proxyPollInflight = false;
let _proxyVisibilityBound = false;

function isProxyTabActive() {
  return !!(
    state.signedIn &&
    !isKvStorageMode() &&
    dom.tabProxy &&
    dom.tabProxy.classList.contains("active")
  );
}

function tickProxyLiveLabels() {
  if (!isProxyTabActive() || document.hidden || !dom.proxyKeyGrid) return;
  for (const el of dom.proxyKeyGrid.querySelectorAll("[data-last-used]")) {
    const raw = el.dataset.lastUsed;
    if (!raw) continue;
    const nextText = `最近使用 ${proxyTimeLabel(Number(raw))}`;
    if (el.textContent !== nextText) el.textContent = nextText;
  }
}

function tryPatchProxyCardsInPlace(
  prevProvider,
  nextProvider,
  prevData,
  nextData,
) {
  if (!prevProvider || !nextProvider || !dom.proxyKeyGrid) return false;
  if (dom.proxyKeyGrid.classList.contains("hidden")) return false;
  if (prevProvider.fp !== nextProvider.fp) return false;
  if (prevProvider.alias !== nextProvider.alias) return false;
  if (prevProvider.enabled !== nextProvider.enabled) return false;
  if ((prevProvider.test_model || "") !== (nextProvider.test_model || "")) {
    return false;
  }
  if ((prevData?.enabled ?? true) !== (nextData?.enabled ?? true)) return false;
  if ((prevData?.disabled_reason || "") !== (nextData?.disabled_reason || "")) {
    return false;
  }

  const prevModels = Array.isArray(prevProvider.models) ? prevProvider.models : [];
  const nextModels = Array.isArray(nextProvider.models) ? nextProvider.models : [];
  if (
    prevModels.length !== nextModels.length ||
    prevModels.some((m, i) => m !== nextModels[i])
  ) {
    return false;
  }

  const prevKeys = Array.isArray(prevProvider.keys) ? prevProvider.keys : [];
  const nextKeys = Array.isArray(nextProvider.keys) ? nextProvider.keys : [];
  if (prevKeys.length !== nextKeys.length || prevKeys.length === 0) return false;

  for (let i = 0; i < prevKeys.length; i++) {
    const pk = prevKeys[i];
    const nk = nextKeys[i];
    if (
      pk.id !== nk.id ||
      pk.masked !== nk.masked ||
      !!pk.disabled !== !!nk.disabled
    ) {
      return false;
    }
  }

  const nextById = new Map(nextKeys.map((k) => [String(k.id ?? ""), k]));
  for (const card of dom.proxyKeyGrid.querySelectorAll("[data-key-id]")) {
    const k = nextById.get(card.dataset.keyId || "");
    if (!k) continue;
    const failEl = card.querySelector("[data-proxy-fail-count]");
    if (failEl) {
      const nextFail = String(Number(k.fail_count || 0));
      if (failEl.textContent !== nextFail) failEl.textContent = nextFail;
    }
    const usedEl = card.querySelector("[data-last-used]");
    if (usedEl) {
      const nextVal = k.last_used_at != null ? String(k.last_used_at) : "";
      if (usedEl.dataset.lastUsed !== nextVal) {
        usedEl.dataset.lastUsed = nextVal;
      }
      const nextTitle = proxyTimeTitle(k.last_used_at);
      if (nextTitle) usedEl.title = nextTitle;
      else usedEl.removeAttribute("title");
      const nextText = `最近使用 ${proxyTimeLabel(k.last_used_at)}`;
      if (usedEl.textContent !== nextText) usedEl.textContent = nextText;
    }
  }
  return true;
}

async function pollProxyStateSeq() {
  if (
    MOCK ||
    !isProxyTabActive() ||
    document.hidden ||
    state.proxyBusy ||
    _proxyPollInflight
  ) {
    return;
  }
  _proxyPollInflight = true;
  const reqSnap = state.reqSeq.proxy;
  try {
    const since =
      state.proxyStateSeq != null ? String(state.proxyStateSeq) : "";
    const path = since
      ? `/api/proxy/state?since_seq=${encodeURIComponent(since)}`
      : "/api/proxy/state";
    const data = await api(path, { auth: true });
    if (
      !isProxyTabActive() ||
      state.proxyBusy ||
      state.reqSeq.proxy !== reqSnap
    ) {
      return;
    }
    if (data && data.unchanged) {
      if (data.state_seq != null) state.proxyStateSeq = data.state_seq;
      return;
    }
    if (!data || !Array.isArray(data.providers)) return;
    await syncProxyPlainKeys(data.providers);
    if (
      !isProxyTabActive() ||
      state.proxyBusy ||
      state.reqSeq.proxy !== reqSnap
    ) {
      return;
    }

    const prevData = state.proxy;
    const prevProvider = selectedProxyProvider();
    const prevProviderCount = proxyProviders().length;
    const prevSelectedModel = dom.proxyTestModel
      ? dom.proxyTestModel.value
      : "";

    state.proxyStateSeq = data.state_seq ?? null;
    state.proxy = data;
    const visibleProviders = proxyProviders();
    const active =
      visibleProviders.find((p) => p.fp === state.proxySelected) ||
      visibleProviders[0] ||
      null;
    state.proxySelected = active ? active.fp : null;

    if (
      visibleProviders.length === prevProviderCount &&
      tryPatchProxyCardsInPlace(prevProvider, active, prevData, data)
    ) {
      return;
    }

    renderProxyState(data, {
      preserveOrder: true,
      keepModelChoice: prevSelectedModel,
    });
  } catch {
    // Transient background poll errors must not flash banners over active cards.
  } finally {
    _proxyPollInflight = false;
  }
}

function stopProxyLiveTimers() {
  if (_proxyClockTimer !== null) {
    clearInterval(_proxyClockTimer);
    _proxyClockTimer = null;
  }
  if (_proxyPollTimer !== null) {
    clearInterval(_proxyPollTimer);
    _proxyPollTimer = null;
  }
}

function startProxyLiveTimers() {
  stopProxyLiveTimers();
  if (!isProxyTabActive() || document.hidden) return;
  _proxyClockTimer = setInterval(tickProxyLiveLabels, PROXY_LIVE_TICK_MS);
  if (!MOCK) {
    _proxyPollTimer = setInterval(pollProxyStateSeq, PROXY_STATE_POLL_MS);
  }
  if (!_proxyVisibilityBound && typeof document.addEventListener === "function") {
    _proxyVisibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopProxyLiveTimers();
      } else if (isProxyTabActive()) {
        tickProxyLiveLabels();
        pollProxyStateSeq();
        startProxyLiveTimers();
      }
    });
  }
}

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

async function syncProxyPlainKeys(providersList) {
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
    (providersList || []).some(
      (pp) => pp && !listMatchesProvider(byFp.get(pp.fp), pp),
    )
  ) {
    byFp = await buildByFp(true);
  }

  const map = new Map();
  for (const pp of providersList || []) {
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
  dom.proxyError.classList.add("hidden");
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
    state.proxyStateSeq = data.state_seq ?? null;
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
  const proxyPass = String(settings.proxy_password || "").trim();
  const proxyMessage = proxyPass
    ? ""
    : "代理密码未设定，请到右上角「设定」填写后再启用转发";

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
                ? Date.now() - 12 * 1000
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
        proxy_url: p.alias ? `/proxy/${p.alias}` : "",
        test_model: override.test_model || "",
        models: splitModels(p.models),
        keys_total: keyEntries.length,
        keys_available: keyEntries.filter((k) => !k.disabled).length,
        keys: keyEntries,
      };
    });
  return {
    ok: true,
    backend: "d1",
    state_seq: Date.now(),
    proxy_enabled: !proxyMessage,
    proxy_message: proxyMessage,
    providers,
  };
}

function proxyTimeLabel(ms) {
  if (!ms) return "从未";
  const ts = Number(ms);
  if (!Number.isFinite(ts)) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${Math.max(1, diffSec)} 秒前`;
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

function renderProxyState(
  data,
  { preserveOrder = false, keepModelChoice = "" } = {},
) {
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
  renderProxyToolbar({ keepModelChoice });
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

function renderProxyModelSelect(p, keepModelChoice = "") {
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
  // Preserve an in-progress dropdown pick across background polls; otherwise
  // default to the saved model while still listed, or the first option.
  if (keepModelChoice && models.includes(keepModelChoice)) {
    dom.proxyTestModel.value = keepModelChoice;
  } else {
    dom.proxyTestModel.value =
      saved && models.includes(saved) ? saved : models[0];
  }
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

function renderProxyToolbar({ keepModelChoice = "" } = {}) {
  const p = selectedProxyProvider();
  if (!p) return;
  const blockReason = proxyDisabledReason();
  const enabled = !blockReason;
  const url = `${location.origin}${p.proxy_url}`;

  const available = Number(p.keys_available || 0);
  const total = Number(p.keys_total || 0);
  const disabled = Math.max(total - available, 0);
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
  dom.proxyUrlCopy.dataset.copyVal = url;
  dom.proxyUrlCopy.disabled = false;
  dom.proxyTestModel.disabled = !enabled;
  renderProxyModelSelect(p, keepModelChoice);

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

/** Shared numeric/wheel stepper pagination used by both `#proxy-pagination`
 *  (9 key cards/page) and `#logs-pagination` (20 log rows/page, max 99 pages). */
function renderStepperPagination(container, currentPage, totalPages, onGoPage) {
  if (!container) return;
  if (totalPages <= 1) {
    container.replaceChildren();
    container.classList.add("hidden");
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
  input.value = String(currentPage);
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
    isDirty = raw !== String(currentPage);
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
      prevBtn.disabled = currentPage <= 1;
      nextBtn.innerHTML = PAGE_NEXT_SVG;
      nextBtn.title = "下一页";
      nextBtn.setAttribute("aria-label", "下一页");
      nextBtn.disabled = currentPage >= totalPages;
    }
  };

  const submitPage = () => {
    const raw = input.value.trim();
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed)) return;
    const clamped = Math.min(totalPages, Math.max(1, parsed));
    if (clamped === currentPage) {
      input.value = String(currentPage);
      syncPaginationControls();
    } else {
      onGoPage(clamped);
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
      const cur = Number.parseInt(input.value, 10) || currentPage;
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
      input.value = String(currentPage);
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
      input.value = String(currentPage);
      syncPaginationControls();
    } else {
      onGoPage(Math.max(1, currentPage - 1));
    }
  });
  nextBtn.addEventListener("click", () => {
    if (isDirty) {
      submitPage();
    } else {
      onGoPage(Math.min(totalPages, currentPage + 1));
    }
  });

  syncPaginationControls();
  container.replaceChildren(prevBtn, pageBox, nextBtn);
  container.classList.remove("hidden");
}

function goToProxyPage(page, totalPages) {
  const next = Math.min(totalPages, Math.max(1, Number(page) || 1));
  if (next === state.proxyPage) return;
  state.proxyPage = next;
  renderProxyKeyCards();
}

function renderProxyPagination(totalPages) {
  renderStepperPagination(
    dom.proxyPagination,
    state.proxyPage,
    totalPages,
    (next) => goToProxyPage(next, totalPages),
  );
}

function renderProxyKeyCards({ preserveOrder = false } = {}) {
  const p = selectedProxyProvider();
  if (!p) return;
  const keys = p.keys || [];
  const enabled = !proxyDisabledReason();
  if (!keys.length) {
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
      const lastUsedVal =
        k.last_used_at != null ? escAttr(String(k.last_used_at)) : "";
      return `
        <article class="proxy-key-card${k.disabled ? " proxy-key-card--disabled" : ""}" data-key-id="${escAttr(id)}">
          <div class="proxy-key-card-head">
            <code class="proxy-key-mask" title="${mask}">${mask}</code>
            ${copyBtn}
          </div>
          <div class="proxy-key-card-meta">
            <span>失败 <strong data-proxy-fail-count>${Number(k.fail_count || 0)}</strong></span>
            <span data-last-used="${lastUsedVal}"${timeAttr}>最近使用 ${esc(proxyTimeLabel(k.last_used_at))}</span>
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
