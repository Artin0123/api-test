// ── Mock mode ────────────────────────────────────────────────────────────
// Append ?mock to the URL to load /mock.json instead of hitting the API.
// Example: http://localhost:8788/?mock
const MOCK = new URLSearchParams(location.search).has("mock");

const COPY_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const TRASH_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
// RFC 7230 token. Must match _HEADER_NAME_RE in async_test_keys.py — aiohttp
// rejects anything else and the whole request would fail.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Lazily-loaded mock data (fetched once, cached here)
let _mockData = null;
async function getMock() {
  if (!_mockData) _mockData = await fetch("/mock.json").then((r) => r.json());
  return _mockData;
}

function cachedProviderFp(p) {
  if (!p || !p.provider_type || !p.api_base) return "";
  return state.fpCache.get(fingerprintPayload(p)) || "";
}

async function ensureProviderFps(providers) {
  for (const p of providers || []) {
    if (!p || !p.provider_type || !p.api_base) continue;
    const payload = fingerprintPayload(p);
    if (!state.fpCache.has(payload)) {
      state.fpCache.set(payload, await sha256(payload));
    }
  }
}

function dkRecordScope(rec) {
  return typeof rec?.fp === "string" && rec.fp.trim()
    ? rec.fp.trim()
    : rec?.provider_host || "";
}

function rebalanceDeadKeyDetails(removed, remaining) {
  for (const gone of removed) {
    if (!gone || !gone.error_detail) continue;
    const scope = dkRecordScope(gone);
    const code = gone.error_code ?? null;
    if (
      remaining.some(
        (r) =>
          r &&
          r.error_detail &&
          dkRecordScope(r) === scope &&
          (r.error_code ?? null) === code,
      )
    ) {
      continue;
    }
    const heir = remaining.find(
      (r) =>
        r &&
        !r.error_detail &&
        dkRecordScope(r) === scope &&
        (r.error_code ?? null) === code,
    );
    if (heir) heir.error_detail = gone.error_detail;
  }
}

function syncMockSettings(settings) {
  if (!MOCK || !_mockData || !settings) return;
  _mockData.settings = settings;
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  if (Array.isArray(_mockData.dead_keys) && _mockData.dead_keys.length) {
    const byFp = new Map();
    const byHost = new Map();
    for (const p of providers) {
      const keys = new Set(splitKeyLines(p?.keys));
      const fp = cachedProviderFp(p);
      if (fp) byFp.set(fp, keys);
      const host = extractHost(p?.api_base);
      if (host) {
        if (!byHost.has(host)) byHost.set(host, new Set());
        for (const k of keys) byHost.get(host).add(k);
      }
    }
    const kept = [];
    const removed = [];
    for (const r of _mockData.dead_keys) {
      if (!r) continue;
      const key = String(r.api_key || "").trim();
      const configured = r.fp
        ? !!key && !!byFp.get(r.fp)?.has(key)
        : !!key && !!byHost.get(r.provider_host)?.has(key);
      if (configured) kept.push(r);
      else removed.push(r);
    }
    if (removed.length) {
      rebalanceDeadKeyDetails(removed, kept);
      _mockData.dead_keys = kept;
      state.deadKeys = kept;
    }
  }
}

// ── State ────────────────────────────────────────────────────────────────
const state = {
  signedIn: false,
  settings: null,
  fpCache: new Map(), // api_base + provider_type -> sha256 fingerprint
  selectedProviders: new Set(), // indices of currently selected provider cards
  deadKeys: [], // dead key records loaded from /api/dead-keys
  dkSelectMode: false, // bulk-selection mode active on dead keys tab
  dkSelected: new Set(), // set of dead key record ids checked in the table
  dkPendingDelete: null, // snapshot of ids currently being confirmed for deletion
  dkSort: { col: "index", dir: "asc" },
  editorSnapshot: null, // key textarea content when the delete confirmation appeared
  editorPendingRemoved: null, // keys shown in the current confirmation
  editorSortMode: "none",
  editorSortOrigin: "",
  proxy: null,
  proxySelected: null, // currently selected provider fp
  proxyBusy: false,
  proxyPlainKeys: new Map(), // fp -> plaintext keys for copy buttons
  proxyTestingKeys: new Set(), // `${fp}:${id}` keys currently testing individually
  proxyRecoveringKeys: new Set(), // `${fp}:${id}` keys currently recovering
  proxyLastResults: new Map(), // fp -> Map<String(id), result> across post-test reloads
  mockProxyOverrides: new Map(), // fp -> { test_model, keys: Map }
  reqSeq: { config: 0, results: 0, deadkeys: 0, proxy: 0 },
  modalStack: [], // active overlay stack for closing only the topmost modal on Esc
};

// ── DOM ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const dom = {
  authOverlay: $("auth-overlay"),
  authInput: $("auth-input"),
  authBtn: $("auth-btn"),
  authError: $("auth-error"),

  topbarMenu: $("topbar-menu"),
  mobileMenuBtn: $("mobile-menu-btn"),
  mobileMenuClose: $("mobile-menu-close"),
  topbarMenuBackdrop: $("topbar-menu-backdrop"),
  runNowBtn: $("run-now-btn"),
  settingsBtn: $("settings-btn"),
  themeToggle: $("theme-toggle"),
  logoutBtn: $("logout-btn"),

  tabBtns: Array.from(document.querySelectorAll(".tab-btn")),
  tabPanels: Array.from(document.querySelectorAll(".tab-panel")),

  // config tab
  configLoading: $("config-loading"),
  configError: $("config-error"),
  providerGrid: $("provider-grid"),
  providerEmpty: $("provider-empty"),
  addProviderBtn: $("add-provider-btn"),
  bulkEnableBtn: $("bulk-enable-btn"),
  bulkDisableBtn: $("bulk-disable-btn"),
  configSaveError: $("config-save-error"),

  // results tab
  resultsRunningBadge: $("results-running-badge"),
  resultsLoading: $("results-loading"),
  resultsError: $("results-error"),
  resultsEmpty: $("results-empty"),
  resultsBody: $("results-body"),

  // provider editor modal
  editorOverlay: $("editor-overlay"),
  editorTitle: $("editor-title"),
  editorIndex: $("editor-index"),
  editorSave: $("editor-save-btn"),
  editorCancel: $("editor-cancel-btn"),
  editorError: $("editor-error"),
  edProviderType: $("ed-provider-type"),
  edApiBase: $("ed-api-base"),
  edKeys: $("ed-keys"),
  edModels: $("ed-models"),
  edExtraBody: $("ed-extra-body"),
  edExtraBodyStatus: $("ed-extra-body-status"),
  edAddHeaderBtn: $("ed-add-header-btn"),
  edHeadersContainer: $("ed-headers-container"),
  edMaxConcurrency: $("ed-max-concurrency"),
  edAlias: $("ed-alias"),
  edKeysHighlight: $("ed-keys-highlight"),
  edKeysSearch: $("ed-keys-search"),
  edKeysSearchClear: $("ed-keys-search-clear"),
  edSortKeysBtn: $("ed-sort-keys-btn"),
  edExportKeysBtn: $("ed-export-keys-btn"),
  editorConfirm: $("editor-confirm"),
  editorConfirmList: $("editor-confirm-list"),

  // app settings modal
  settingsOverlay: $("settings-overlay"),
  settingsCancel: $("settings-cancel-btn"),
  settingsSave: $("settings-save-btn"),
  settingsError: $("settings-error"),
  settingsOk: $("settings-ok"),
  setGithubUrl: $("set-github-url"),
  setDiscordUrl: $("set-discord-url"),
  setProxyPassword: $("set-proxy-password"),
  setGatewayLogsUrl: $("set-gateway-logs-url"),
  setGatewayToken: $("set-gateway-token"),
  setProxyFailThreshold: $("set-proxy-fail-threshold"),
  setProxyMaxRetries: $("set-proxy-max-retries"),
  setProxyTimeoutMs: $("set-proxy-timeout-ms"),
  testDiscordBtn: $("test-discord-btn"),

  // sample modal
  sampleOverlay: $("sample-overlay"),
  sampleClose: $("sample-close-btn"),
  sampleTitle: $("sample-title"),
  sampleSubtitle: $("sample-subtitle"),
  sampleContent: $("sample-content"),

  // dead keys tab
  dkBulkDelBtn: $("dk-bulk-del-btn"),
  dkFHost: $("dk-f-host"),
  dkFKey: $("dk-f-key"),
  dkFCode: $("dk-f-code"),
  dkFFrom: $("dk-f-from"),
  dkFTo: $("dk-f-to"),
  dkFReset: $("dk-f-reset"),
  dkLoading: $("dk-loading"),
  dkError: $("dk-error"),
  dkEmpty: $("dk-empty"),
  dkTableWrap: $("dk-table-wrap"),

  // dead key bulk-delete confirm
  dkConfirmOverlay: $("dkconfirm-overlay"),
  dkConfirmMsg: $("dkconfirm-msg"),
  dkConfirmList: $("dkconfirm-list"),
  dkConfirmError: $("dkconfirm-error"),
  dkConfirmOk: $("dkconfirm-ok-btn"),
  dkConfirmCancel: $("dkconfirm-cancel-btn"),

  // error detail modal
  errDetailOverlay: $("errdetail-overlay"),
  errDetailClose: $("errdetail-close-btn"),
  errDetailSubtitle: $("errdetail-subtitle"),
  errDetailContent: $("errdetail-content"),

  // proxy tab
  proxyNotice: $("proxy-notice"),
  proxyLoading: $("proxy-loading"),
  proxyError: $("proxy-error"),
  proxyEmpty: $("proxy-empty"),
  proxyKeyEmpty: $("proxy-key-empty"),
  proxyToolbar: $("proxy-toolbar"),
  proxyProvider: $("proxy-provider"),
  proxySummary: $("proxy-summary"),
  proxyUrl: $("proxy-url"),
  proxyUrlCopy: $("proxy-url-copy"),
  proxyTestModel: $("proxy-test-model"),
  proxySaveModel: $("proxy-save-model"),
  proxyTestActive: $("proxy-test-active"),
  proxyTestDisabled: $("proxy-test-disabled"),
  proxyRecoverAll: $("proxy-recover-all"),
  proxyLogs: $("proxy-logs"),
  proxyKeyGrid: $("proxy-key-grid"),
};

// ── API ──────────────────────────────────────────────────────────────────
// Credentials travel in the HttpOnly session cookie set by POST /api/login, so
// nothing here reads the password back. `auth: true` marks the calls that need a
// session: a 401 on those means the cookie expired, and the login overlay comes
// back instead of the caller rendering an empty page.
async function api(path, { method = "GET", auth = false, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 401 && auth) {
    sessionEnded();
    throw new Error("Unauthorized");
  }
  if (!resp.ok) {
    const err = new Error(data.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── Settings writes ───────────────────────────────────────────────────────
// Settings are stored as a single object and written whole, so every write
// carries the version this tab last read. A 409 means another tab saved first
// and this tab's copy is stale — pull the winning copy in before the user
// retries, so they are never looking at a snapshot that no longer exists.
async function reloadSettingsFromServer() {
  const d = await api("/api/settings", { auth: true });
  state.settings = d.settings || {};
  state.selectedProviders.clear();
  applySettingsToUI();
  renderProviderGrid();
}

async function postSettings(patch) {
  if (MOCK) return undefined;
  try {
    const resp = await api("/api/settings", {
      method: "POST",
      auth: true,
      body: { ...patch, version: (state.settings || {}).version },
    });
    return resp.version;
  } catch (err) {
    if (err.status !== 409) throw err;
    await reloadSettingsFromServer();
    throw new Error("设定已被其他分页修改，画面已更新为最新内容，请重新操作");
  }
}

// ── Line numbers ──────────────────────────────────────────────────────────
// Hidden mirror div used to measure how many visual lines each logical line
// takes up. All text-rendering properties are copied from the source textarea
// on each call so the mirror matches the actual wrapping behaviour exactly.
let _mirror;
function _ensureMirror() {
  if (_mirror) return;
  _mirror = document.createElement("div");
  _mirror.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;" +
    "box-sizing:content-box;padding:0;margin:0;border:none;";
  document.body.appendChild(_mirror);
}
function _measureVisualLines(textarea, logicalLines) {
  _ensureMirror();
  const cs = getComputedStyle(textarea);
  // Copy all properties that affect line-wrapping from the source textarea.
  // font shorthand covers font-family, font-size, etc.; set lineHeight after
  // because the font shorthand resets it to 'normal' when omitted.
  _mirror.style.font = cs.font;
  _mirror.style.lineHeight = cs.lineHeight;
  _mirror.style.letterSpacing = cs.letterSpacing;
  _mirror.style.whiteSpace = cs.whiteSpace;
  _mirror.style.overflowWrap = cs.overflowWrap;
  _mirror.style.wordBreak = cs.wordBreak;
  // Content width = textarea clientWidth minus its horizontal padding
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const avail = Math.max(1, textarea.clientWidth - padL - padR);
  _mirror.style.width = avail + "px";
  // Measure single-line height with a reference character
  _mirror.textContent = "X";
  const oneLineH = _mirror.scrollHeight;
  if (oneLineH <= 0) return logicalLines.map(() => 1);
  // Measure visual lines per logical line
  return logicalLines.map((line) => {
    _mirror.textContent = line || "\u00A0";
    return Math.max(1, Math.round(_mirror.scrollHeight / oneLineH));
  });
}

function syncLineNums(textarea) {
  const editor = textarea.closest(".lined-editor");
  if (!editor) return;
  const nums = editor.querySelector(".line-nums");
  if (!nums) return;

  const logicalLines = textarea.value.split("\n");
  const visualCounts = _measureVisualLines(textarea, logicalLines);

  // Build spans: one per visual line; only the first of each logical group gets a number
  const spans = [];
  let num = 1;
  for (const vc of visualCounts) {
    spans.push(`<span>${num}</span>`);
    for (let i = 1; i < vc; i++) spans.push(`<span></span>`);
    num++;
  }
  nums.innerHTML = spans.join("");

  // Proportional scroll sync after layout
  requestAnimationFrame(() => {
    const taMax = textarea.scrollHeight - textarea.clientHeight;
    if (taMax <= 0) {
      nums.scrollTop = 0;
      return;
    }
    const ratio = textarea.scrollTop / taMax;
    const numsMax = nums.scrollHeight - nums.clientHeight;
    nums.scrollTop = ratio * Math.max(0, numsMax);
  });
}

function bindLineNums(textarea) {
  const sync = () => syncLineNums(textarea);
  textarea.addEventListener("input", sync);
  textarea.addEventListener("scroll", sync);
  sync();
}

// ── Models normalization ──────────────────────────────────────────────────
// Strips spaces around commas, trailing commas/spaces; collapses runs of commas.
function normalizeModels(raw) {
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .join(",");
}

function normalizeKeys(raw) {
  return raw
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean)
    .join("\n");
}

/** Newline list helper shared by the editor tools and the proxy page. */
function splitKeyLines(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Comma list helper, mirroring providerModels() in `_worker.js`: the proxy page
 *  offers the provider's own Models (来源设定) as the probe model, so both sides
 *  must split the same string the same way. */
function splitModels(raw) {
  return String(raw || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Head/tail mask for keys: left 6 + 1..3 asterisks + right 3 (<=9 shown as-is).
 *  Keep this function identical to the one in `_worker.js`. */
function maskKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 9) return s;
  const stars = "*".repeat(Math.min(s.length - 9, 3));
  return `${s.slice(0, 6)}${stars}${s.slice(-3)}`;
}

/** Mobile head/tail mask for dead keys: left 6 + 1..3 asterisks + right 1 (<=7 shown as-is). */
function maskKeyMobile(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 7) return s;
  const stars = "*".repeat(Math.min(s.length - 7, 3));
  return `${s.slice(0, 6)}${stars}${s.slice(-1)}`;
}

function dkKeyHtml(key) {
  const raw = String(key || "");
  if (!raw) return "";
  return `<span class="dk-key-desktop">${esc(maskKey(raw))}</span><span class="dk-key-mobile">${esc(maskKeyMobile(raw))}</span>`;
}

/** Multiset diff of two newline lists: duplicated keys are counted, so removing
 *  one copy of a key that appears twice reports exactly one removal. */
function diffKeyLines(oldText, newText) {
  const count = (text) => {
    const map = new Map();
    for (const key of splitKeyLines(text)) map.set(key, (map.get(key) || 0) + 1);
    return map;
  };
  const before = count(oldText);
  const after = count(newText);
  const removed = [];
  for (const [key, n] of before) {
    const left = n - (after.get(key) || 0);
    for (let i = 0; i < left; i++) removed.push(key);
  }
  return removed;
}

const SORT_MODES = ["none", "asc", "desc"];
// All three labels are the same length so the button keeps one width instead of
// jumping while you cycle it. The mode is spelled out rather than A→Z / Z→A
// because the direction is what the user picks, and the arrows read as a value.
const SORT_LABELS = { none: "预设排序", asc: "递增排序", desc: "递减排序" };

function nextSortMode(mode) {
  const i = SORT_MODES.indexOf(mode);
  return SORT_MODES[(i + 1) % SORT_MODES.length];
}

/** Three-state sort. "none" restores the text captured when the cycle started,
 *  so the original order (and duplicated lines) survive the round trip. The
 *  comparison is the default JS string comparison (UTF-16 code units), which for
 *  ASCII keys is plain ASCII order; localeCompare would follow the system
 *  locale and is deliberately not used. */
function sortKeysText(text, mode, originText) {
  if (mode === "none") {
    return originText === undefined ? String(text) : originText;
  }
  const lines = splitKeyLines(text);
  const cmp =
    mode === "asc"
      ? (a, b) => (a < b ? -1 : a > b ? 1 : 0)
      : (a, b) => (a < b ? 1 : a > b ? -1 : 0);
  return [...lines].sort(cmp).join("\n");
}

// ── Theme ────────────────────────────────────────────────────────────────
function getTheme() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  dom.themeToggle.textContent = theme === "dark" ? "🌙" : "☀️";
  try {
    localStorage.setItem("atk_theme", theme);
  } catch {}
}

function toggleTheme() {
  applyTheme(getTheme() === "dark" ? "light" : "dark");
}

// ── Auth ─────────────────────────────────────────────────────────────────
// The session cookie is HttpOnly, so this flag is the only thing the page can
// see about its own login state. It holds no secret — it exists so index.html
// can hide the overlay before first paint instead of flashing the login card.
const SIGNED_IN_HINT = "atk_signed_in";

function markSignedIn() {
  state.signedIn = true;
  try {
    localStorage.setItem(SIGNED_IN_HINT, "1");
  } catch {}
  document.documentElement.classList.remove("has-token");
}

function sessionEnded() {
  state.signedIn = false;
  try {
    localStorage.removeItem(SIGNED_IN_HINT);
  } catch {}
  document.documentElement.classList.remove("has-token");
  dom.authOverlay.classList.add("active");
}

async function login() {
  const password = dom.authInput.value.trim();
  if (!password) {
    dom.authError.textContent = "请输入密码";
    return;
  }
  dom.authError.textContent = "";
  dom.authBtn.disabled = true;
  try {
    await api("/api/login", { method: "POST", body: { password } });
    markSignedIn();
    dom.authOverlay.classList.remove("active");
    dom.authInput.value = "";
    await initApp();
  } catch (err) {
    sessionEnded();
    dom.authError.textContent =
      err.message === "Unauthorized" ? "密码错误" : `认证失败：${err.message}`;
  } finally {
    dom.authBtn.disabled = false;
  }
}

async function logout() {
  // Only the server can clear an HttpOnly cookie; if the call fails the cookie
  // outlives the click, so the UI must not pretend otherwise.
  try {
    await api("/api/logout", { method: "POST" });
  } catch {}
  state.settings = null;
  state.deadKeys = [];
  state.proxy = null;
  state.proxyPlainKeys.clear();
  state.proxyLastResults.clear();
  state.proxyTestingKeys.clear();
  state.proxyRecoveringKeys.clear();
  sessionEnded();
  dom.authInput.value = "";
}

// ── UI & Modal Helpers ────────────────────────────────────────────────────
function modalFocusableElements(overlay) {
  const panel = overlay ? overlay.querySelector(".modal-panel") : null;
  if (!panel) return [];
  return Array.from(
    panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.closest(".hidden") && el.getClientRects().length > 0);
}

function openModal(overlay, initialFocusEl = null) {
  if (!overlay) return;
  const idx = state.modalStack.indexOf(overlay);
  if (idx >= 0) state.modalStack.splice(idx, 1);
  state.modalStack.push(overlay);
  overlay.classList.remove("hidden");

  if (
    initialFocusEl &&
    !initialFocusEl.disabled &&
    initialFocusEl.getClientRects().length > 0 &&
    typeof initialFocusEl.focus === "function"
  ) {
    initialFocusEl.focus();
  }
}

function closeModal(overlay) {
  if (!overlay) return;
  closeOpenCustomSelect();
  hideActiveInfoTooltip();
  overlay.classList.add("hidden");
  const idx = state.modalStack.indexOf(overlay);
  if (idx >= 0) state.modalStack.splice(idx, 1);
  if (
    overlay.contains(document.activeElement) &&
    typeof document.activeElement.blur === "function"
  ) {
    document.activeElement.blur();
  }
}

// ── Desktop flat custom select (mobile/touch keeps native <select>) ───────
const desktopSelectMql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(min-width: 641px) and (hover: hover) and (pointer: fine)")
    : null;
let activeCustomSelect = null;

function isDesktopCustomSelect() {
  return !!(desktopSelectMql && desktopSelectMql.matches);
}

function createSelectArrowSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "custom-select-arrow");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const poly = document.createElementNS(ns, "polyline");
  poly.setAttribute("points", "6 9 12 15 18 9");
  svg.appendChild(poly);
  return svg;
}

function syncCustomSelect(select) {
  const ui = select && select._customUi;
  if (!ui) return;
  const opts = Array.from(select.options || []);
  const selectedOpt =
    (select.selectedIndex >= 0 && opts[select.selectedIndex]) ||
    opts.find((o) => o.selected) ||
    opts[0] ||
    null;
  const label = selectedOpt ? selectedOpt.textContent || "" : "";
  ui.valueEl.textContent = label;
  ui.trigger.title = label;
  ui.trigger.disabled = !!select.disabled;
  ui.wrap.classList.toggle("is-disabled", !!select.disabled);
  if (activeCustomSelect === select) {
    renderCustomSelectMenu(select);
  }
}

function setCustomMenuActive(select, nextIdx) {
  const ui = select && select._customUi;
  if (!ui) return;
  const items = Array.from(ui.menu.querySelectorAll(".custom-select-option"));
  if (!items.length) {
    ui.activeIndex = -1;
    return;
  }
  const bounded = Math.max(0, Math.min(nextIdx, items.length - 1));
  ui.activeIndex = bounded;
  items.forEach((item, idx) => {
    item.classList.toggle("is-active", idx === bounded);
  });
  const activeItem = items[bounded];
  if (activeItem && typeof activeItem.scrollIntoView === "function") {
    activeItem.scrollIntoView({ block: "nearest" });
  }
}

function moveCustomMenuActive(select, step) {
  const ui = select && select._customUi;
  if (!ui) return;
  const opts = Array.from(select.options || []);
  if (!opts.length) return;
  let idx = ui.activeIndex;
  for (let i = 0; i < opts.length; i++) {
    idx = (idx + step + opts.length) % opts.length;
    if (!opts[idx].disabled) {
      setCustomMenuActive(select, idx);
      return;
    }
  }
}

function positionCustomSelectMenu(select) {
  const ui = select && select._customUi;
  if (!ui) return;
  const rect = ui.trigger.getBoundingClientRect();
  const gap = 4;
  const margin = 12;
  const spaceBelow = window.innerHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
  const maxH = Math.max(120, Math.min(256, openUp ? spaceAbove - gap : spaceBelow - gap));

  ui.menu.style.width = `${rect.width}px`;
  ui.menu.style.left = `${rect.left}px`;
  ui.menu.style.maxHeight = `${maxH}px`;

  if (openUp) {
    const measured = Math.min(ui.menu.scrollHeight || maxH, maxH);
    ui.menu.style.top = `${Math.max(margin, rect.top - gap - measured)}px`;
  } else {
    ui.menu.style.top = `${rect.bottom + gap}px`;
  }
}

function renderCustomSelectMenu(select) {
  const ui = select && select._customUi;
  if (!ui) return;
  const opts = Array.from(select.options || []);
  ui.menu.replaceChildren();
  opts.forEach((opt, idx) => {
    const li = document.createElement("li");
    li.className = "custom-select-option";
    li.setAttribute("role", "option");
    li.dataset.index = String(idx);
    const label = opt.textContent || "";
    li.textContent = label;
    li.title = opt.title || label;
    const isSelected = idx === select.selectedIndex;
    li.classList.toggle("is-selected", isSelected);
    li.setAttribute("aria-selected", String(isSelected));
    if (opt.disabled) {
      li.classList.add("is-disabled");
      li.setAttribute("aria-disabled", "true");
    }
    ui.menu.appendChild(li);
  });
  const initialIdx =
    select.selectedIndex >= 0
      ? select.selectedIndex
      : opts.findIndex((o) => !o.disabled);
  setCustomMenuActive(select, initialIdx);
}

function closeOpenCustomSelect({ restoreFocus = false } = {}) {
  const select = activeCustomSelect;
  if (!select || !select._customUi) return false;
  const ui = select._customUi;
  activeCustomSelect = null;
  ui.menu.classList.add("hidden");
  ui.trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus && typeof ui.trigger.focus === "function") {
    ui.trigger.focus();
  }
  return true;
}

function openCustomSelectMenu(select) {
  if (!select || !select._customUi || select.disabled || !isDesktopCustomSelect()) return;
  if (activeCustomSelect === select) {
    closeOpenCustomSelect();
    return;
  }
  closeOpenCustomSelect();
  activeCustomSelect = select;
  const ui = select._customUi;
  renderCustomSelectMenu(select);
  ui.menu.classList.remove("hidden");
  positionCustomSelectMenu(select);
  ui.trigger.setAttribute("aria-expanded", "true");
  if (ui.activeIndex >= 0) {
    setCustomMenuActive(select, ui.activeIndex);
  }
}

function commitCustomSelectIndex(select, idx) {
  const opts = Array.from(select.options || []);
  const opt = opts[idx];
  if (!opt || opt.disabled) return;
  const changed = select.selectedIndex !== idx;
  select.selectedIndex = idx;
  syncCustomSelect(select);
  closeOpenCustomSelect({ restoreFocus: true });
  if (changed) {
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function enhanceSelect(select) {
  if (!select || select._customUi) return;
  const parent = select.parentNode;
  if (!parent) return;

  const wrap = document.createElement("div");
  wrap.className = "custom-select";
  wrap.dataset.enhanced = "1";
  parent.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add("custom-select-native");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const valueEl = document.createElement("span");
  valueEl.className = "custom-select-value";
  trigger.append(valueEl, createSelectArrowSvg());
  wrap.appendChild(trigger);

  const menu = document.createElement("ul");
  menu.className = "custom-select-menu hidden";
  menu.setAttribute("role", "listbox");
  document.body.appendChild(menu);

  select._customUi = { wrap, trigger, valueEl, menu, activeIndex: -1 };
  syncCustomSelect(select);

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    openCustomSelectMenu(select);
  });

  trigger.addEventListener("keydown", (e) => {
    if (!isDesktopCustomSelect()) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (activeCustomSelect !== select) {
        openCustomSelectMenu(select);
      } else {
        moveCustomMenuActive(select, e.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      if (activeCustomSelect === select) {
        e.preventDefault();
        const idx = select._customUi.activeIndex;
        if (idx >= 0) commitCustomSelectIndex(select, idx);
        else closeOpenCustomSelect({ restoreFocus: true });
      }
      return;
    }
    if (e.key === "Tab" && activeCustomSelect === select) {
      closeOpenCustomSelect();
    }
  });

  menu.addEventListener("click", (e) => {
    const li = e.target.closest(".custom-select-option");
    if (!li) return;
    const idx = Number(li.dataset.index);
    if (Number.isInteger(idx)) commitCustomSelectIndex(select, idx);
  });

  const label = select.closest("label.field");
  if (label) {
    label.addEventListener("click", (e) => {
      if (!isDesktopCustomSelect()) return;
      if (e.target.closest(".custom-select, .info-icon")) return;
      e.preventDefault();
      if (!trigger.disabled) trigger.focus();
    });
  }

  const observer = new MutationObserver(() => syncCustomSelect(select));
  observer.observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });
}

function initCustomSelects() {
  document.querySelectorAll("select.input-select").forEach(enhanceSelect);
  document.addEventListener("click", (e) => {
    if (!activeCustomSelect || !activeCustomSelect._customUi) return;
    const { trigger, menu } = activeCustomSelect._customUi;
    if (trigger.contains(e.target) || menu.contains(e.target)) return;
    closeOpenCustomSelect();
  });
  window.addEventListener("resize", () => closeOpenCustomSelect());
  window.addEventListener(
    "scroll",
    (e) => {
      if (!activeCustomSelect || !activeCustomSelect._customUi) return;
      if (activeCustomSelect._customUi.menu.contains(e.target)) return;
      closeOpenCustomSelect();
    },
    true,
  );
  if (desktopSelectMql && typeof desktopSelectMql.addEventListener === "function") {
    desktopSelectMql.addEventListener("change", () => closeOpenCustomSelect());
  }
}

// ── Floating info tooltips (portaled to body to layer above open select menus) ─
let activeInfoIcon = null;

function positionInfoTooltip(icon, tip) {
  if (!icon || !tip) return;
  const rect = icon.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const margin = 12;
  const gap = 6;
  const tipW = tipRect.width || tip.offsetWidth || 210;
  const tipH = tipRect.height || tip.offsetHeight || 120;
  const rawLeft = rect.left - 80;
  const left = Math.max(
    margin,
    Math.min(rawLeft, window.innerWidth - tipW - margin),
  );
  let top = rect.bottom + gap;
  if (
    top + tipH > window.innerHeight - margin &&
    rect.top - gap - tipH >= margin
  ) {
    top = rect.top - gap - tipH;
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideActiveInfoTooltip() {
  if (!activeInfoIcon || !activeInfoIcon._tooltipState) return;
  const icon = activeInfoIcon;
  icon._tooltipState.hovered = false;
  icon._tooltipState.focused = false;
  icon._tooltipState.tip.classList.remove("is-open");
  activeInfoIcon = null;
}

function syncInfoTooltip(icon) {
  const stateObj = icon && icon._tooltipState;
  if (!stateObj) return;
  const { tip, hovered, focused } = stateObj;
  const visible =
    (hovered || focused) &&
    icon.isConnected &&
    icon.getClientRects().length > 0;
  if (!visible) {
    tip.classList.remove("is-open");
    if (activeInfoIcon === icon) activeInfoIcon = null;
    return;
  }
  if (activeInfoIcon && activeInfoIcon !== icon) {
    hideActiveInfoTooltip();
  }
  positionInfoTooltip(icon, tip);
  tip.classList.add("is-open");
  activeInfoIcon = icon;
}

function initInfoTooltips() {
  document.querySelectorAll(".info-icon").forEach((icon, idx) => {
    if (icon._tooltipState) return;
    const tip = icon.querySelector(".info-tooltip");
    if (!tip) return;
    if (!tip.id) tip.id = `info-tooltip-${idx + 1}`;
    tip.setAttribute("role", "tooltip");
    icon.setAttribute("aria-describedby", tip.id);
    // Portal outside modal stacking contexts so .info-tooltip paints above .custom-select-menu.
    tip.classList.add("info-tooltip--portal");
    document.body.appendChild(tip);

    const stateObj = { tip, hovered: false, focused: false };
    icon._tooltipState = stateObj;

    icon.addEventListener("mouseenter", () => {
      stateObj.hovered = true;
      syncInfoTooltip(icon);
    });
    icon.addEventListener("mouseleave", () => {
      stateObj.hovered = false;
      syncInfoTooltip(icon);
    });
    icon.addEventListener("focusin", () => {
      stateObj.focused = true;
      syncInfoTooltip(icon);
    });
    icon.addEventListener("focusout", () => {
      stateObj.focused = false;
      syncInfoTooltip(icon);
    });
    icon.addEventListener("click", (e) => {
      e.preventDefault();
      icon.focus();
    });
  });

  document.addEventListener("pointerdown", (e) => {
    if (activeInfoIcon && !activeInfoIcon.contains(e.target)) {
      hideActiveInfoTooltip();
    }
  });
  window.addEventListener("resize", () => {
    if (activeInfoIcon) syncInfoTooltip(activeInfoIcon);
  });
  window.addEventListener(
    "scroll",
    () => {
      if (!activeInfoIcon) return;
      const body = activeInfoIcon.closest(".modal-body");
      if (body) {
        const iconRect = activeInfoIcon.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        if (iconRect.bottom < bodyRect.top || iconRect.top > bodyRect.bottom) {
          hideActiveInfoTooltip();
          return;
        }
      }
      syncInfoTooltip(activeInfoIcon);
    },
    true,
  );
}

function topOpenModal() {
  for (let i = state.modalStack.length - 1; i >= 0; i--) {
    const overlay = state.modalStack[i];
    if (overlay && !overlay.classList.contains("hidden")) return overlay;
  }
  return null;
}
function toggleMobileMenu(force) {
  const open =
    typeof force === "boolean"
      ? force
      : !dom.topbarMenu.classList.contains("open");
  dom.topbarMenu.classList.toggle("open", open);
  dom.topbarMenuBackdrop.classList.toggle("open", open);
  dom.mobileMenuBtn.setAttribute("aria-expanded", String(open));
}

// ── Tabs ──────────────────────────────────────────────────────────────────
function switchTab(name) {
  closeOpenCustomSelect();
  dom.tabBtns.forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name),
  );
  dom.tabPanels.forEach((p) => {
    const active = p.id === `tab-${name}`;
    p.classList.toggle("active", active);
    p.classList.toggle("hidden", !active);
  });
  if (name === "results") loadResults();
  if (name === "config") loadConfig();
  if (name === "deadkeys") loadDeadKeys();
  if (name === "proxy") loadProxyState();

  // Close mobile menu if open
  toggleMobileMenu(false);
}

// Keep in sync with GATEWAY_LOGS_URL_RE in _worker.js.
const GATEWAY_LOGS_URL_RE =
  /^https:\/\/dash\.cloudflare\.com\/([^/?#]+)\/ai\/ai-gateway\/gateways\/([^/?#]+)\/logs(?:[/?#].*)?$/i;

const HTTP_URL_RE = /^https?:\/\/\S+/i;

const PROXY_SETTING_SPECS = {
  proxy_fail_threshold: { label: "失败禁用门槛", fallback: 3, min: 1, max: null },
  proxy_max_retries: { label: "最多重试次数", fallback: 3, min: 0, max: 3 },
  proxy_upstream_timeout_ms: { label: "上游超时 (ms)", fallback: 120000, min: 1000, max: 600000 },
};

function isValidGatewayLogsUrl(url) {
  return !!url && GATEWAY_LOGS_URL_RE.test(url);
}

// ── Settings modal ────────────────────────────────────────────────────────
function openSettings() {
  const s = state.settings || {};
  dom.setGithubUrl.value = s.github_url || "";
  dom.setDiscordUrl.value = s.discord_webhook_url || "";
  dom.setProxyPassword.value = s.proxy_password || "";
  dom.setGatewayLogsUrl.value = s.ai_gateway_logs_url || "";
  dom.setGatewayToken.value = s.ai_gateway_token || "";
  dom.setProxyFailThreshold.value = String(
    s.proxy_fail_threshold ?? PROXY_SETTING_SPECS.proxy_fail_threshold.fallback,
  );
  dom.setProxyMaxRetries.value = String(
    s.proxy_max_retries ?? PROXY_SETTING_SPECS.proxy_max_retries.fallback,
  );
  dom.setProxyTimeoutMs.value = String(
    s.proxy_upstream_timeout_ms ?? PROXY_SETTING_SPECS.proxy_upstream_timeout_ms.fallback,
  );
  dom.settingsError.textContent = "";
  dom.settingsOk.classList.add("hidden");
  openModal(dom.settingsOverlay, dom.setGithubUrl);
}

function closeSettings() {
  closeModal(dom.settingsOverlay);
}

async function saveSettings() {
  dom.settingsError.textContent = "";
  dom.settingsOk.classList.add("hidden");

  const githubUrl = dom.setGithubUrl.value.trim();
  if (githubUrl && !HTTP_URL_RE.test(githubUrl)) {
    dom.settingsError.textContent =
      "GitHub Actions URL 必须以 http:// 或 https:// 开头";
    return;
  }
  const discordUrl = dom.setDiscordUrl.value.trim();
  if (discordUrl && !HTTP_URL_RE.test(discordUrl)) {
    dom.settingsError.textContent =
      "Discord Webhook URL 必须以 http:// 或 https:// 开头";
    return;
  }
  const logsUrl = dom.setGatewayLogsUrl.value.trim();
  if (logsUrl && !isValidGatewayLogsUrl(logsUrl)) {
    dom.settingsError.textContent =
      "AI Gateway Logs URL 格式无效，请填写 https://dash.cloudflare.com/{account_id}/ai/ai-gateway/gateways/{gateway_id}/logs";
    return;
  }

  const parseSettingInt = (input, spec) => {
    const raw = input.value.trim();
    if (!raw) return spec.fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < spec.min || (spec.max != null && n > spec.max)) {
      const range = spec.max == null ? `>= ${spec.min}` : `${spec.min} ~ ${spec.max}`;
      throw new Error(`${spec.label} 必须是 ${range} 的整数`);
    }
    return n;
  };

  let patch;
  try {
    patch = {
      github_url: githubUrl,
      discord_webhook_url: discordUrl,
      proxy_password: dom.setProxyPassword.value.trim(),
      ai_gateway_logs_url: logsUrl,
      ai_gateway_token: dom.setGatewayToken.value.trim(),
      proxy_fail_threshold: parseSettingInt(
        dom.setProxyFailThreshold,
        PROXY_SETTING_SPECS.proxy_fail_threshold,
      ),
      proxy_max_retries: parseSettingInt(
        dom.setProxyMaxRetries,
        PROXY_SETTING_SPECS.proxy_max_retries,
      ),
      proxy_upstream_timeout_ms: parseSettingInt(
        dom.setProxyTimeoutMs,
        PROXY_SETTING_SPECS.proxy_upstream_timeout_ms,
      ),
    };
  } catch (err) {
    dom.settingsError.textContent = err.message;
    return;
  }

  dom.settingsSave.disabled = true;
  try {
    // Send only the fields this modal owns so an open edit doesn't race providers[].
    const version = await postSettings(patch);
    const current = state.settings || {};
    state.settings = { ...current, ...patch };
    if (version !== undefined) state.settings.version = version;
    syncMockSettings(state.settings);
    applySettingsToUI();
    closeSettings();
    if (state.proxy) loadProxyState({ preserveResults: true });
  } catch (err) {
    dom.settingsError.textContent = err.message;
  } finally {
    dom.settingsSave.disabled = false;
  }
}

async function testDiscordWebhook() {
  const url = dom.setDiscordUrl.value.trim();
  if (!url) {
    dom.settingsError.textContent = "请先输入 Discord Webhook URL";
    return;
  }
  dom.settingsError.textContent = "";
  const originalText = dom.testDiscordBtn.textContent;
  dom.testDiscordBtn.disabled = true;
  dom.testDiscordBtn.textContent = "发送中...";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content:
          "🔔 **API Key Tester**：这是一条测试通知。如果您看到此消息，表示 Webhook 已成功连线！",
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dom.testDiscordBtn.textContent = "发送成功！";
    setTimeout(() => {
      dom.testDiscordBtn.textContent = originalText;
      dom.testDiscordBtn.disabled = false;
    }, 2000);
  } catch (err) {
    dom.settingsError.textContent = `发送失败: ${err.message}`;
    dom.testDiscordBtn.textContent = originalText;
    dom.testDiscordBtn.disabled = false;
  }
}

function applySettingsToUI() {
  const s = state.settings || {};
  const url = String(s.github_url || "").trim();
  if (url && HTTP_URL_RE.test(url)) {
    dom.runNowBtn.href = url;
    dom.runNowBtn.removeAttribute("aria-disabled");
    dom.runNowBtn.title = "前往 GitHub Actions 立即执行测试";
  } else {
    dom.runNowBtn.removeAttribute("href");
    dom.runNowBtn.setAttribute("aria-disabled", "true");
    dom.runNowBtn.title = "请在右上角「设定」填写 GitHub Actions URL 后可用";
  }
}

// ── Config tab ─────────────────────────────────────────────────────────────
async function loadConfig() {
  const reqId = ++state.reqSeq.config;
  dom.configLoading.classList.remove("hidden");
  dom.configError.classList.add("hidden");
  dom.configSaveError.textContent = "";
  dom.providerGrid.classList.add("hidden");
  dom.providerEmpty.classList.add("hidden");

  try {
    let data;
    if (MOCK) {
      const mock = await getMock();
      data = { settings: state.settings || mock.settings };
    } else {
      data = await api("/api/settings", { auth: true });
    }
    if (reqId !== state.reqSeq.config) return;
    state.settings = data.settings || {};
    syncMockSettings(state.settings);
    applySettingsToUI();
    renderProviderGrid();
  } catch (err) {
    if (reqId !== state.reqSeq.config) return;
    dom.configError.textContent = `读取失败：${err.message}`;
    dom.configError.classList.remove("hidden");
  } finally {
    if (reqId === state.reqSeq.config) {
      dom.configLoading.classList.add("hidden");
    }
  }
}

function updateBulkBtnState() {
  const has = state.selectedProviders.size > 0;
  dom.bulkEnableBtn.disabled = !has;
  dom.bulkDisableBtn.disabled = !has;
}

function renderProviderGrid() {
  const providers = (state.settings || {}).providers || [];
  if (!providers.length) {
    dom.providerEmpty.classList.remove("hidden");
    dom.providerGrid.classList.add("hidden");
    updateBulkBtnState();
    return;
  }
  dom.providerGrid.innerHTML = providers
    .map((p, i) => renderProviderCard(p, i))
    .join("");
  dom.providerGrid.classList.remove("hidden");
  dom.providerEmpty.classList.add("hidden");
  updateBulkBtnState();
}

function renderProviderCard(p, index) {
  // With an alias set, the alias is the card's name: it is what the provider is
  // addressed by (`/proxy/{alias}`), and the upstream domain is then only a
  // detail. Both stay reachable — the real api_base is the tooltip, the alias
  // alone when there is one.
  const host = extractHost(p.api_base);
  const alias = (p.alias || "").trim();
  const keyCount = (p.keys || "").split("\n").filter((l) => l.trim()).length;
  const modelCount = (p.models || "").split(",").filter((m) => m.trim()).length;
  const isEnabled = p.enabled !== false;
  const isSelected = state.selectedProviders.has(index);

  return `
    <div class="provider-card${isEnabled ? "" : " provider-card--disabled"}${isSelected ? " provider-card--selected" : ""}" data-card="${index}">
      <div class="provider-card-header">
        <label class="provider-card-select" title="选中以批量操作">
          <input type="checkbox" data-select="${index}"${isSelected ? " checked" : ""} />
        </label>
        <div class="provider-card-badges">
          <span class="badge">${esc(p.provider_type)}</span>
        </div>
        <div class="provider-card-actions">
          <button class="btn btn-secondary btn-sm" data-edit="${index}" type="button">编辑</button>
          <button class="btn btn-danger btn-sm" data-delete="${index}" type="button">删除</button>
        </div>
      </div>
      <div class="provider-card-host" title="${escAttr(p.api_base)}">${esc(alias || host)}</div>
      <div class="provider-card-meta">
        ${isEnabled ? "" : `<span class="provider-card-state-tag">已停用</span>`}
        <span class="provider-card-counts">
          <span><strong>${keyCount}</strong> 个 Key</span>
          <span><strong>${modelCount}</strong> 个模型</span>
          ${p.max_concurrency != null ? `<span>并发: <strong>${p.max_concurrency}</strong></span>` : ""}
        </span>
      </div>
    </div>
  `;
}

// ── Provider editor modal ──────────────────────────────────────────────────
// Build rows via DOM APIs, not innerHTML: key/value can contain quotes.
function createHeaderRow(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "custom-header-row";

  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.className = "input-text";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  keyInput.placeholder = "名称，如 X-Custom-Auth";
  keyInput.setAttribute("aria-label", "请求头名称");
  keyInput.dataset.headerKey = "";
  keyInput.value = key;

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.className = "input-text";
  valueInput.autocomplete = "off";
  valueInput.spellcheck = false;
  valueInput.placeholder = "值";
  valueInput.setAttribute("aria-label", "请求头值");
  valueInput.dataset.headerValue = "";
  valueInput.value = value;

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn btn-danger-icon";
  delBtn.title = "删除";
  delBtn.setAttribute("aria-label", "删除此请求头");
  delBtn.innerHTML = TRASH_ICON_SVG;
  delBtn.addEventListener("click", () => row.remove());

  row.append(keyInput, valueInput, delBtn);
  return row;
}

function renderEditorHeaders(headers = []) {
  dom.edHeadersContainer.replaceChildren();
  if (!Array.isArray(headers)) return;
  for (const h of headers) {
    const key = typeof h?.key === "string" ? h.key : "";
    const value = typeof h?.value === "string" ? h.value : "";
    if (!key && !value) continue;
    dom.edHeadersContainer.appendChild(createHeaderRow(key, value));
  }
}

function getEditorHeaders() {
  const headers = [];
  const invalid = [];
  for (const row of dom.edHeadersContainer.querySelectorAll(
    ".custom-header-row",
  )) {
    const key = (row.querySelector("[data-header-key]")?.value || "").trim();
    const value = (row.querySelector("[data-header-value]")?.value || "").replace(
      /[\r\n]/g,
      "",
    );
    if (!key) continue;
    if (!HEADER_NAME_RE.test(key)) {
      invalid.push(key);
      continue;
    }
    headers.push({ key, value });
  }
  return { headers, invalid };
}

function hideEditorConfirm({ keepError = false } = {}) {
  dom.editorConfirm.classList.add("hidden");
  dom.editorConfirmList.replaceChildren();
  state.editorPendingRemoved = null;
  dom.editorSave.classList.remove("btn-danger-solid");
  dom.editorSave.classList.add("btn-primary");
  if (!keepError) dom.editorError.textContent = "";
}

function showEditorConfirm(removed) {
  dom.editorConfirmList.replaceChildren();
  for (const key of removed) {
    const li = document.createElement("li");
    li.textContent = maskKey(key);
    dom.editorConfirmList.appendChild(li);
  }
  dom.editorConfirm.classList.remove("hidden");
  dom.editorError.textContent = `即将删除 ${removed.length} 支密钥；确认后才会储存。`;
  dom.editorSave.classList.remove("btn-primary");
  dom.editorSave.classList.add("btn-danger-solid");
  dom.editorSave.focus();
}

// ── Keys textarea: orange marks on every occurrence of the query ─────────
// The query is whatever is typed in the search box; while that box is empty it is
// whatever is selected in the textarea. A textarea cannot colour part of its own
// text, so the marks are drawn in a mirror layer of identically styled text
// sitting behind it (see .keys-highlight in style.css): the marks are the only
// thing visible, because the layer's own glyphs are transparent and the textarea
// paints its real text on top of them. This replaced the old hit list — the same
// query, drawn where the keys are instead of in a second list underneath. Every
// occurrence is marked, square-edged like the browser's own find highlight.
let _keysHighlightFrame = 0;

// Lays the mirror layer onto the textarea's text box and copies every property
// that decides where a glyph lands. Copied rather than restated in CSS so the
// two can never drift apart when a token changes.
// Two boxes: the outer one is clipped by its own overflow and never moves, the
// inner one carries the text and is translated by the scroll offset. A single
// box cannot do both jobs — the clip region of an element travels with its own
// transform, so one box would cut away the very lines that just scrolled in.
function _placeKeysHighlight(layer, inner, ta) {
  const editor = ta.closest(".keys-editor");
  if (!editor) return false;
  const eRect = editor.getBoundingClientRect();
  const eCs = getComputedStyle(editor);
  const tRect = ta.getBoundingClientRect();
  const cs = getComputedStyle(ta);
  // Absolute children of the editor are placed against its padding box.
  layer.style.left =
    tRect.left - eRect.left - (parseFloat(eCs.borderLeftWidth) || 0) + "px";
  layer.style.top =
    tRect.top - eRect.top - (parseFloat(eCs.borderTopWidth) || 0) + "px";
  // clientWidth/clientHeight are the textarea's padding box, scrollbar already
  // excluded: exactly the area the textarea shows its text in, so the outer box
  // can clip at the same edge the textarea clips at.
  layer.style.width = ta.clientWidth + "px";
  layer.style.height = ta.clientHeight + "px";
  inner.style.padding = cs.padding;
  inner.style.font = cs.font;
  // After the font shorthand, which resets line-height to 'normal'.
  inner.style.lineHeight = cs.lineHeight;
  inner.style.letterSpacing = cs.letterSpacing;
  inner.style.whiteSpace = cs.whiteSpace;
  inner.style.overflowWrap = cs.overflowWrap;
  inner.style.wordBreak = cs.wordBreak;
  inner.style.tabSize = cs.tabSize;
  return true;
}

function syncKeysHighlight() {
  const ta = dom.edKeys;
  const layer = dom.edKeysHighlight;
  if (!ta || !layer) return;
  // Closed editor: nothing laid out, nothing to paint.
  if (!ta.clientWidth) return;
  const inner = layer.firstElementChild;
  if (!inner) return;
  if (!_placeKeysHighlight(layer, inner, ta)) return;

  const value = ta.value;
  // Search box first, selection second: an empty box is the "just show me what I
  // picked" mode, and a filled box keeps marking its phrase even after the user
  // clicks back into the textarea and the selection collapses.
  const typed = (dom.edKeysSearch && dom.edKeysSearch.value.trim()) || "";
  const query = typed || value.slice(ta.selectionStart, ta.selectionEnd);
  const frag = document.createDocumentFragment();
  const mark = (text) => {
    const el = document.createElement("mark");
    el.textContent = text;
    frag.appendChild(el);
  };
  if (query.trim()) {
    // Case-insensitive substring match, same rule the old hit list used: every
    // occurrence gets a band, and the browser's find-bar look (square, no
    // rounding) is what tells them apart from the markup around them.
    const hay = value.toLowerCase();
    const needle = query.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      if (at > from) frag.appendChild(document.createTextNode(value.slice(from, at)));
      mark(value.slice(at, at + needle.length));
      from = at + needle.length;
    }
    if (from < value.length)
      frag.appendChild(document.createTextNode(value.slice(from)));
  } else {
    frag.appendChild(document.createTextNode(value));
  }
  // A textarea whose value ends in a newline shows an empty last line; a block
  // of pre-wrap text does not, so pad it to keep the marks on the right lines.
  if (value.endsWith("\n")) frag.appendChild(document.createTextNode("\u200b"));
  inner.replaceChildren(frag);
  // Translated rather than scrolled: a scroll offset would be clamped to the
  // inner box's own overflow, and any round-off would slide the marks off the
  // text.
  inner.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
}

// One rebuild per frame at most: selectionchange and input both fire while a
// drag-select is in progress.
function scheduleKeysHighlight() {
  if (_keysHighlightFrame) return;
  _keysHighlightFrame = requestAnimationFrame(() => {
    _keysHighlightFrame = 0;
    syncKeysHighlight();
  });
}

// The clear button never moves, so the box does not change shape under the
// cursor: it only lights up (and becomes clickable and tabbable) when there is
// something to clear.
function syncSearchClearButton() {
  const btn = dom.edKeysSearchClear;
  if (!btn || !dom.edKeysSearch) return;
  const has = !!dom.edKeysSearch.value;
  btn.classList.toggle("is-active", has);
  btn.disabled = !has;
}

function bindKeysHighlight() {
  const ta = dom.edKeys;
  if (!ta || !dom.edKeysHighlight) return;
  ta.addEventListener("input", scheduleKeysHighlight);
  ta.addEventListener("scroll", scheduleKeysHighlight, { passive: true });
  if (dom.edKeysSearch) {
    // "search" as well as "input": the box's own clear button fires both in
    // Chrome, but the box is also cleared by Esc, which only fires "search".
    dom.edKeysSearch.addEventListener("input", () => {
      syncSearchClearButton();
      scheduleKeysHighlight();
    });
    dom.edKeysSearch.addEventListener("search", () => {
      syncSearchClearButton();
      scheduleKeysHighlight();
    });
    if (dom.edKeysSearchClear)
      dom.edKeysSearchClear.addEventListener("mousedown", (e) => {
        // Keeps the caret where it is; focusing the box below is then enough.
        e.preventDefault();
      });
    if (dom.edKeysSearchClear)
      dom.edKeysSearchClear.addEventListener("click", () => {
        if (!dom.edKeysSearch.value) return;
        dom.edKeysSearch.value = "";
        syncSearchClearButton();
        // The box no longer fires "input" when a script writes value, so the
        // marks are rebuilt from here.
        syncKeysHighlight();
        dom.edKeysSearch.focus();
      });
    syncSearchClearButton();
  }
  document.addEventListener("selectionchange", () => {
    // Ignore selections that have nothing to do with this textarea, so marks
    // stay put when the user clicks a button or selects text elsewhere.
    if (document.activeElement === ta) scheduleKeysHighlight();
  });
  if (typeof ResizeObserver !== "undefined")
    new ResizeObserver(scheduleKeysHighlight).observe(ta);
  window.addEventListener("resize", scheduleKeysHighlight);
  syncKeysHighlight();
}

function cycleEditorSort() {
  if (state.editorSortMode === "none") state.editorSortOrigin = dom.edKeys.value;
  state.editorSortMode = nextSortMode(state.editorSortMode);
  dom.edKeys.value = sortKeysText(
    dom.edKeys.value,
    state.editorSortMode,
    state.editorSortOrigin,
  );
  dom.edSortKeysBtn.textContent = SORT_LABELS[state.editorSortMode];
  syncLineNums(dom.edKeys);
  syncKeysHighlight();
}

function exportEditorKeys() {
  const keys = splitKeyLines(dom.edKeys.value);
  if (!keys.length) {
    hideEditorConfirm({ keepError: true });
    dom.editorError.textContent = "没有可导出的密钥";
    return;
  }
  if (!state.editorPendingRemoved) dom.editorError.textContent = "";
  const host = extractHost(dom.edApiBase.value || "provider");
  const filename = `${host || "provider"}-keys.txt`.replace(
    /[^a-zA-Z0-9._-]+/g,
    "-",
  );
  const blob = new Blob([`${keys.join("\n")}\n`], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openEditor(index = -1) {
  dom.editorIndex.value = String(index);
  dom.editorError.textContent = "";

  if (index >= 0) {
    const p = ((state.settings || {}).providers || [])[index] || {};
    dom.editorTitle.textContent = "编辑服务商";
    dom.edProviderType.value = p.provider_type || "openai";
    syncCustomSelect(dom.edProviderType);
    dom.edApiBase.value = p.api_base || "";
    dom.edKeys.value = p.keys || "";
    dom.edModels.value = p.models || "";
    dom.edExtraBody.value = p.extra_body || "";
    dom.edAlias.value = p.alias || "";
    renderEditorHeaders(p.custom_headers);
    dom.edMaxConcurrency.value =
      p.max_concurrency != null ? String(p.max_concurrency) : "";
  } else {
    dom.editorTitle.textContent = "新增服务商";
    dom.edProviderType.value = "openai";
    syncCustomSelect(dom.edProviderType);
    dom.edApiBase.value = "";
    dom.edKeys.value = "";
    dom.edModels.value = "";
    dom.edExtraBody.value = "";
    dom.edAlias.value = "";
    renderEditorHeaders([]);
    dom.edMaxConcurrency.value = "";
  }
  dom.edExtraBodyStatus.textContent = "";
  dom.edExtraBodyStatus.className = "json-status";
  state.editorSortMode = "none";
  dom.edSortKeysBtn.textContent = SORT_LABELS.none;
  // A query left over from the last time the editor was open would paint marks
  // on a provider the user never searched in.
  if (dom.edKeysSearch) dom.edKeysSearch.value = "";
  syncSearchClearButton();
  hideEditorConfirm();
  state.editorSnapshot = dom.edKeys.value;
  openModal(dom.editorOverlay, dom.edApiBase);
  // Sync line numbers after values are populated
  syncLineNums(dom.edKeys);
  syncLineNums(dom.edModels);
  syncLineNums(dom.edExtraBody);
  syncKeysHighlight();
}

function closeEditor() {
  hideEditorConfirm();
  closeModal(dom.editorOverlay);
}

async function saveEditor() {
  const confirmed = Boolean(state.editorPendingRemoved);
  if (!confirmed) dom.editorError.textContent = "";
  const failValidation = (msg) => {
    hideEditorConfirm({ keepError: true });
    dom.editorError.textContent = msg;
  };
  const index = Number(dom.editorIndex.value);
  const existingProviders = (state.settings || {}).providers || [];
  const enabled =
    index >= 0 ? existingProviders[index]?.enabled !== false : true;
  const apiBase = dom.edApiBase.value.trim().replace(/\/+$/, "");
  const keys = normalizeKeys(dom.edKeys.value);
  const models = normalizeModels(dom.edModels.value);
  const pType = dom.edProviderType.value;
  const extraBodyRaw = dom.edExtraBody.value.trim();
  const { headers: customHeaders, invalid: invalidHeaders } = getEditorHeaders();
  const maxConcurrencyRaw = dom.edMaxConcurrency.value.trim();

  // Update UI immediately so the user sees the cleaned up data if they reopen
  dom.edKeys.value = keys;
  dom.edModels.value = models;
  syncLineNums(dom.edKeys);
  syncLineNums(dom.edModels);
  syncKeysHighlight();

  if (!apiBase) return failValidation("请填写 API Base URL");
  const dupIdx = existingProviders.findIndex(
    (p, i) =>
      i !== index &&
      p &&
      (p.provider_type || "").trim() === pType &&
      (p.api_base || "").trim().replace(/\/+$/, "") === apiBase,
  );
  if (dupIdx >= 0) {
    return failValidation(`已存在相同的 ${pType} 与 API Base 服务商`);
  }
  if (!keys.trim()) return failValidation("请填写至少一个 API Key");
  if (!models.trim()) return failValidation("请填写至少一个模型名");
  if (extraBodyRaw) {
    try {
      JSON.parse(extraBodyRaw);
    } catch {
      return failValidation("Extra Body 不是有效的 JSON");
    }
  }
  if (invalidHeaders.length) {
    return failValidation(`请求头名称不合法: ${invalidHeaders[0]}`);
  }

  let maxConcurrency = null;
  if (maxConcurrencyRaw !== "") {
    const n = parseInt(maxConcurrencyRaw, 10);
    if (!Number.isInteger(n) || n < 1) {
      return failValidation("Max Concurrency 必须是正整数");
    }
    maxConcurrency = n;
  }

  const entry = {
    enabled,
    provider_type: pType,
    api_base: apiBase,
    keys,
    models,
    extra_body: extraBodyRaw,
    custom_headers: customHeaders,
    max_concurrency: maxConcurrency,
  };
  const alias = dom.edAlias.value.trim();
  // Omit empty alias so a provider without forwarding keeps its minimal shape.
  if (alias) entry.alias = alias;

  // A shrinking key list gets an in-place confirmation instead of a popup: the
  // footer grows, so the warning cannot be missed.
  const baseline = state.editorSnapshot ?? keys;
  const removed = diffKeyLines(baseline, keys);
  if (removed.length && !confirmed) {
    state.editorPendingRemoved = removed;
    showEditorConfirm(removed);
    return;
  }
  // If the textarea changed after the confirmation was shown, the list the
  // operator agreed to is stale: show the new one instead of saving blindly.
  if (confirmed) {
    const shown = state.editorPendingRemoved || [];
    const a = [...removed].sort();
    const b = [...shown].sort();
    const same =
      a.length === b.length && a.every((value, i) => value === b[i]);
    if (!same) {
      if (removed.length) {
        state.editorPendingRemoved = removed;
        showEditorConfirm(removed);
        return;
      }
      hideEditorConfirm();
    }
  }
  const settings = state.settings || {};
  const providers = [...(settings.providers || [])];

  if (index >= 0) {
    providers[index] = entry;
  } else {
    providers.push(entry);
  }

  dom.editorSave.disabled = true;
  try {
    const version = await postSettings({ providers });
    state.settings = { ...settings, providers };
    if (version !== undefined) state.settings.version = version;
    await ensureProviderFps(providers);
    syncMockSettings(state.settings);
    hideEditorConfirm();
    state.editorSnapshot = null;
    state.editorSortMode = "none";
    dom.configSaveError.textContent = "";
    renderProviderGrid();
    closeEditor();
  } catch (err) {
    dom.editorError.textContent = err.message;
  } finally {
    dom.editorSave.disabled = false;
  }
}

async function deleteProvider(index) {
  const p = ((state.settings || {}).providers || [])[index];
  if (
    !p ||
    !confirm(`确定删除 ${extractHost(p.api_base)} (${p.provider_type}) ？`)
  )
    return;

  dom.configSaveError.textContent = "";
  const settings = state.settings || {};
  const providers = (settings.providers || []).filter((_, i) => i !== index);

  try {
    const version = await postSettings({ providers });
    state.settings = { ...settings, providers };
    if (version !== undefined) state.settings.version = version;
    await ensureProviderFps(providers);
    syncMockSettings(state.settings);
    state.selectedProviders.clear();
    renderProviderGrid();
  } catch (err) {
    dom.configSaveError.textContent = err.message;
  }
}

function toggleSelection(index) {
  if (state.selectedProviders.has(index)) {
    state.selectedProviders.delete(index);
  } else {
    state.selectedProviders.add(index);
  }
  // Update card class in-place to avoid full re-render
  const card = dom.providerGrid.querySelector(`[data-card="${index}"]`);
  if (card)
    card.classList.toggle(
      "provider-card--selected",
      state.selectedProviders.has(index),
    );
  updateBulkBtnState();
}

async function bulkToggle(enable) {
  if (state.selectedProviders.size === 0) return;
  dom.configSaveError.textContent = "";
  const settings = state.settings || {};
  const providers = (settings.providers || []).map((p, i) =>
    state.selectedProviders.has(i) ? { ...p, enabled: enable } : p,
  );
  try {
    const version = await postSettings({ providers });
    state.settings = { ...settings, providers };
    if (version !== undefined) state.settings.version = version;
    syncMockSettings(state.settings);
    state.selectedProviders.clear();
    renderProviderGrid();
  } catch (err) {
    dom.configSaveError.textContent = err.message;
  }
}

// ── Proxy tab (rotation / forwarding) ──────────────────────────────────────
function selectedProxyProvider() {
  const providers = (state.proxy && state.proxy.providers) || [];
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

function proxyResultStore(fp) {
  if (!fp) return null;
  let store = state.proxyLastResults.get(fp);
  if (!store) {
    store = new Map();
    state.proxyLastResults.set(fp, store);
  }
  return store;
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
      state.settings = d.settings || {};
      applySettingsToUI();
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

async function loadProxyState({ preserveResults = false } = {}) {
  const reqId = ++state.reqSeq.proxy;
  if (!preserveResults) {
    state.proxyLastResults.clear();
  }
  dom.proxyLoading.classList.remove("hidden");
  dom.proxyError.classList.add("hidden");
  dom.proxyEmpty.classList.add("hidden");
  dom.proxyKeyEmpty.classList.add("hidden");
  dom.proxyToolbar.classList.add("hidden");
  dom.proxyKeyGrid.classList.add("hidden");
  clearProxyNotice({ keepGlobal: false });

  try {
    let data;
    if (MOCK) {
      const mock = await getMock();
      if (!state.settings) {
        state.settings = mock.settings || {};
      }
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
    const active =
      providers.find((p) => p.fp === state.proxySelected) ||
      providers[0] ||
      null;
    state.proxySelected = active ? active.fp : null;
    renderProxyState(data);
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

  const providers = (settings.providers || []).map((p, i) => {
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
          gemini: "/models/{model}:streamGenerateContent?alt=sse",
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

function renderProxyState(data) {
  const providers = data.providers || [];
  if (!data.proxy_enabled) {
    setProxyNotice(data.proxy_message || "转发功能目前停用", "error");
  }
  if (!providers.length) {
    dom.proxyEmpty.classList.remove("hidden");
    dom.proxyToolbar.classList.add("hidden");
    dom.proxyKeyGrid.classList.add("hidden");
    dom.proxyKeyEmpty.classList.add("hidden");
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
  renderProxyKeyCards();
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
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（来源设定未填 Models）";
    dom.proxyTestModel.appendChild(opt);
    return;
  }
  for (const model of models) {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    dom.proxyTestModel.appendChild(opt);
  }
  // No saved choice yet: default to the first model. The save button still has to
  // be pressed before the test buttons treat it as the chosen probe model.
  dom.proxyTestModel.value = saved || models[0];
  syncCustomSelect(dom.proxyTestModel);
}

let proxySaveModelTimer = null;

function renderProxyToolbar() {
  if (proxySaveModelTimer) {
    clearTimeout(proxySaveModelTimer);
    proxySaveModelTimer = null;
  }
  dom.proxySaveModel.textContent = "保存模型";
  const p = selectedProxyProvider();
  if (!p) return;
  const enabled =
    !!(state.proxy && state.proxy.proxy_enabled) && p.enabled !== false;
  const url = p.alias ? `${location.origin}${p.proxy_url}` : "";

  const available = Number(p.keys_available || 0);
  const total = Number(p.keys_total || 0);
  // Two separate spans so the healthy and unhealthy counts can carry their own
  // colour without colouring the whole line. The old "可用 x / y" slash is gone:
  // 有效 x 無效 y says both numbers in words.
  const makeSummaryItem = (cls, label, count) => {
    const wrap = document.createElement("span");
    wrap.className = cls;
    const textSpan = document.createElement("span");
    textSpan.textContent = label;
    const numSpan = document.createElement("span");
    numSpan.className = "proxy-summary-num";
    numSpan.textContent = String(count);
    wrap.append(textSpan, numSpan);
    return wrap;
  };
  dom.proxySummary.replaceChildren(
    makeSummaryItem("proxy-summary-ok", "有效", available),
    makeSummaryItem("proxy-summary-fail", "无效", Math.max(total - available, 0)),
  );
  dom.proxyUrl.textContent = url || "（尚未设定转发别名）";
  dom.proxyUrl.classList.toggle("is-disabled", !url);
  dom.proxyUrlCopy.dataset.copyVal = url;
  dom.proxyUrlCopy.disabled = !url;
  renderProxyModelSelect(p);
  const hasModels = proxyModelOptions(p).length > 0;
  dom.proxyTestModel.disabled = !enabled || !hasModels;
  dom.proxySaveModel.disabled = !enabled || !hasModels;

  const hasKeys = (p.keys || []).some((k) => k.id != null);
  const hasDisabledKeys = (p.keys || []).some((k) => k.disabled && k.id != null);
  const hasAlias = !!String(p.alias || "").trim();
  const canTest = enabled && hasAlias && hasKeys && !!p.test_model;
  for (const btn of [dom.proxyTestActive, dom.proxyTestDisabled]) {
    btn.disabled = !canTest || state.proxyBusy;
    btn.title = !hasAlias
      ? "请先在「来源设定」填写转发别名（alias）"
      : !p.test_model
        ? "请先选择并保存测试模型"
        : "";
  }
  dom.proxyRecoverAll.disabled = !enabled || !hasDisabledKeys || state.proxyBusy;
  if (!state.proxy || !state.proxy.proxy_enabled) {
    dom.proxyRecoverAll.title =
      (state.proxy && state.proxy.proxy_message) || "转发功能目前停用";
  } else if (p.enabled === false) {
    dom.proxyRecoverAll.title = "此服务商已停用";
  } else if (!hasDisabledKeys) {
    dom.proxyRecoverAll.title = "当前供应商没有已失效的密钥";
  } else {
    dom.proxyRecoverAll.title = "恢复当前供应商下的所有失效密钥";
  }
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
  const enabled =
    !!(state.proxy && state.proxy.proxy_enabled) && p.enabled !== false;
  const canAct = enabled && !!String(p.alias || "").trim() && !!p.test_model;
  for (const btn of dom.proxyKeyGrid.querySelectorAll("[data-proxy-test]")) {
    const id = btn.dataset.proxyTest;
    const busy =
      state.proxyBusy ||
      state.proxyTestingKeys.has(`${btn.dataset.fp}:${id}`);
    btn.disabled = !canAct || !id || busy;
  }
  for (const btn of dom.proxyKeyGrid.querySelectorAll("[data-proxy-recover]")) {
    const id = btn.dataset.proxyRecover;
    const busy =
      state.proxyBusy ||
      state.proxyRecoveringKeys.has(`${btn.dataset.fp}:${id}`);
    btn.disabled = !enabled || !id || busy;
  }
}

function renderProxyKeyCards() {
  const p = selectedProxyProvider();
  if (!p) return;
  const keys = p.keys || [];
  const enabled =
    !!(state.proxy && state.proxy.proxy_enabled) && p.enabled !== false;
  if (!keys.length) {
    // Sibling of the grid, not a grid item: a .state-card dropped inside the
    // grid used to render as one 280px column instead of a full-width notice.
    dom.proxyKeyGrid.replaceChildren();
    dom.proxyKeyGrid.classList.add("hidden");
    dom.proxyKeyEmpty.classList.remove("hidden");
    return;
  }
  dom.proxyKeyEmpty.classList.add("hidden");
  const canAct = enabled && !!String(p.alias || "").trim() && !!p.test_model;
  const plainList = state.proxyPlainKeys.get(p.fp) || [];
  dom.proxyKeyGrid.innerHTML = keys
    .map((k, ki) => {
      const id = k.id == null ? "" : String(k.id);
      const mask = esc(k.masked || "");
      const candidate = plainList[ki] || "";
      const rawKey = candidate && maskKey(candidate) === k.masked ? candidate : "";
      const copyBtn = rawKey
        ? `<button class="btn btn-ghost btn-xs btn-icon copy-btn" type="button" title="复制 KEY" aria-label="复制 KEY" data-copy-val="${escAttr(rawKey)}">${COPY_ICON_SVG}</button>`
        : "";
      const recoverDisabled =
        !enabled ||
        !id ||
        state.proxyBusy ||
        state.proxyRecoveringKeys.has(`${p.fp}:${id}`);
      const recover = k.disabled
        ? `<button class="btn btn-secondary btn-sm" type="button" data-proxy-recover="${escAttr(id)}" data-fp="${escAttr(p.fp)}"${recoverDisabled ? " disabled" : ""}>恢复</button>`
        : "";
      const testDisabled =
        !canAct ||
        !id ||
        state.proxyBusy ||
        state.proxyTestingKeys.has(`${p.fp}:${id}`);
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
              <button class="btn btn-secondary btn-sm" type="button" data-proxy-test="${escAttr(id)}" data-fp="${escAttr(p.fp)}"${testDisabled ? " disabled" : ""}>测试</button>
              ${recover}
            </div>
          </div>
          <div class="proxy-test-result" data-proxy-result="${escAttr(id)}"></div>
        </article>`;
    })
    .join("");
  const savedResults = state.proxyLastResults.get(p.fp);
  if (savedResults) {
    for (const [id, result] of savedResults.entries()) {
      renderProxyTestResult(id, result);
    }
  }
  dom.proxyKeyGrid.classList.remove("hidden");
}

function renderProxyTestResult(id, result) {
  if (id == null) return;
  const targetId = String(id);
  const els = Array.from(
    dom.proxyKeyGrid.querySelectorAll("[data-proxy-result]"),
  ).filter((el) => el.dataset.proxyResult === targetId);
  if (!els.length) return;
  let text;
  let className;
  if (result && result.ok) {
    text = `可用 · ${result.ms} ms · ${result.model || ""}`;
    className = "proxy-test-result ok";
  } else {
    const detail =
      result && result.error ? ` · ${truncate(result.error, 90)}` : "";
    const charged =
      result && result.disabled
        ? " · 已达门槛，已禁用"
        : result && typeof result.fail_count === "number"
          ? ` · 连续失败 ${result.fail_count} 次`
          : "";
    text = `不可用 · HTTP ${result && result.status ? result.status : "—"}${detail}${charged}`;
    className = "proxy-test-result fail";
  }
  for (const el of els) {
    el.textContent = text;
    el.className = className;
  }
}

/** Returns the result object so the batch loop can count it. */
async function testProxyKey(fp, id, { fromBatch = false } = {}) {
  if (id == null || id === "") return null;
  if (!fromBatch && state.proxyBusy) return null;
  const targetId = String(id);
  const token = `${fp}:${targetId}`;
  if (state.proxyTestingKeys.has(token)) return null;

  const targetFp = fp || (selectedProxyProvider() || {}).fp || null;
  const beforeProvider = (state.proxy?.providers || []).find(
    (item) => item.fp === targetFp,
  );
  const beforeKey = (beforeProvider?.keys || []).find(
    (k) => String(k.id ?? "") === targetId,
  );
  const wasDirty = !!(
    beforeKey &&
    (beforeKey.disabled || Number(beforeKey.fail_count || 0) > 0)
  );
  state.proxyTestingKeys.add(token);
  updateProxyCardButtonsDisabled();

  for (const el of Array.from(
    dom.proxyKeyGrid.querySelectorAll("[data-proxy-result]"),
  ).filter((node) => node.dataset.proxyResult === targetId)) {
    el.textContent = "测试中...";
    el.className = "proxy-test-result";
  }

  let result;
  try {
    if (MOCK) {
      const provider = (state.proxy?.providers || []).find(
        (item) => item.fp === targetFp,
      );
      if (provider) {
        const ki = (provider.keys || []).findIndex(
          (k) => String(k.id ?? "") === targetId,
        );
        const rawKey = ki >= 0 ? (provider._mockPlainKeys || [])[ki] : "";
        if (rawKey) {
          const override = mockOverrideForProvider(provider.fp);
          const prev = override.keys.get(rawKey) || {};
          override.keys.set(rawKey, {
            ...prev,
            disabled: false,
            fail_count: 0,
          });
        }
      }
      result = {
        ok: true,
        status: 200,
        ms: 123,
        model: (provider && provider.test_model) || "mock",
        fail_count: 0,
        disabled: false,
      };
    } else {
      result = await api("/api/proxy/test", {
        method: "POST",
        auth: true,
        body: { fp, id: Number(targetId) },
      });
    }
  } catch (err) {
    result = { ok: false, status: err.status || 0, error: err.message };
  } finally {
    state.proxyTestingKeys.delete(token);
    updateProxyCardButtonsDisabled();
  }

  const store = proxyResultStore(targetFp);
  if (store) store.set(targetId, result);
  renderProxyTestResult(targetId, result);

  if (
    result &&
    !result.disabled &&
    result.ok === false &&
    typeof result.fail_count === "number"
  ) {
    const provider = (state.proxy?.providers || []).find(
      (item) => item.fp === targetFp,
    );
    for (const k of provider?.keys || []) {
      if (String(k.id ?? "") === targetId) k.fail_count = result.fail_count;
    }
    for (const card of Array.from(
      dom.proxyKeyGrid.querySelectorAll("[data-key-id]"),
    ).filter((node) => node.dataset.keyId === targetId)) {
      const strong = card.querySelector("[data-proxy-fail-count]");
      if (strong) strong.textContent = String(result.fail_count);
    }
  }

  if (!fromBatch && result && result.disabled) {
    await loadProxyState({ preserveResults: true });
    setProxyNotice(
      `这把密钥已达门槛并被禁用（连续失败 ${result.fail_count} 次）。`,
      "error",
    );
  } else if (!fromBatch && result && result.ok && wasDirty) {
    await loadProxyState({ preserveResults: true });
    clearProxyNotice({ keepGlobal: true });
  }
  return result;
}

function proxyActionButtons() {
  return [
    dom.proxyTestActive,
    dom.proxyTestDisabled,
    dom.proxyRecoverAll,
    dom.proxySaveModel,
    dom.proxyProvider,
  ];
}

async function runProxyBatch(mode) {
  if (state.proxyBusy) return;
  const p = selectedProxyProvider();
  if (!p) return;
  const keys = (p.keys || []).filter((k) => {
    if (k.id == null) return false;
    // Only the two scopes the toolbar exposes: healthy keys or disabled keys.
    return mode === "disabled" ? k.disabled : !k.disabled;
  });
  if (!keys.length) {
    setProxyNotice("没有符合这个条件的密钥。", "info");
    return;
  }

  state.proxyBusy = true;
  proxyActionButtons().forEach((b) => {
    b.disabled = true;
  });
  updateProxyCardButtonsDisabled();
  const store = proxyResultStore(p.fp);
  if (store) {
    for (const k of keys) store.delete(String(k.id));
  }

  let ok = 0;
  let fail = 0;
  try {
    for (let i = 0; i < keys.length; i++) {
      setProxyNotice(
        `批量测试中：${i + 1} / ${keys.length}（可用 ${ok}，不可用 ${fail}）`,
        "info",
      );
      const result = await testProxyKey(p.fp, keys[i].id, {
        fromBatch: true,
      });
      if (result && result.ok) ok++;
      else fail++;
    }
  } finally {
    // Reset both flag and UI controls even if requests or reload fail.
    state.proxyBusy = false;
    dom.proxyProvider.disabled = false;
    renderProxyToolbar();
    updateProxyCardButtonsDisabled();
  }

  await loadProxyState({ preserveResults: true });
  setProxyNotice(
    `批量测试完成：共 ${keys.length} 把，可用 ${ok}，不可用 ${fail}。`,
    "info",
  );
}

async function saveProxyTestModel() {
  if (state.proxyBusy) return;
  const p = selectedProxyProvider();
  if (!p) return;
  const model = dom.proxyTestModel.value.trim();
  if (!model) {
    dom.proxyTestModel.focus();
    return;
  }
  dom.proxySaveModel.disabled = true;
  try {
    if (!MOCK) {
      const res = await api("/api/proxy/test-model", {
        method: "POST",
        auth: true,
        body: { fp: p.fp, model },
      });
      p.test_model = res.test_model || "";
    } else {
      p.test_model = model;
      mockOverrideForProvider(p.fp).test_model = model;
    }
    renderProxyToolbar();
    renderProxyKeyCards();
    dom.proxySaveModel.textContent = "已保存";
    proxySaveModelTimer = setTimeout(() => {
      proxySaveModelTimer = null;
      dom.proxySaveModel.textContent = "保存模型";
    }, 1200);
  } catch (err) {
    setProxyNotice(`保存失败：${err.message}`, "error");
  } finally {
    dom.proxySaveModel.disabled = false;
  }
}

async function recoverProxyKey(fp, id) {
  if (state.proxyBusy || id == null || id === "") return;
  const targetId = String(id);
  const token = `${fp}:${targetId}`;
  if (state.proxyRecoveringKeys.has(token)) return;
  if (!confirm("恢复这把密钥？恢复后会重新参与轮用。")) return;

  const currentProvider = selectedProxyProvider();
  const targetFp = (currentProvider || {}).fp;
  state.proxyRecoveringKeys.add(token);
  updateProxyCardButtonsDisabled();
  try {
    if (!MOCK) {
      await api("/api/proxy/recover", {
        method: "POST",
        auth: true,
        body: { fp, id: Number(targetId) },
      });
    } else if (currentProvider) {
      const ki = (currentProvider.keys || []).findIndex(
        (k) => String(k.id ?? "") === targetId,
      );
      const rawKey = ki >= 0 ? (currentProvider._mockPlainKeys || [])[ki] : "";
      if (rawKey) {
        const override = mockOverrideForProvider(currentProvider.fp);
        const prev = override.keys.get(rawKey) || {};
        override.keys.set(rawKey, { ...prev, disabled: false, fail_count: 0 });
      }
    }
    const store = state.proxyLastResults.get(targetFp);
    if (store) store.delete(targetId);
    await loadProxyState({ preserveResults: true });
  } catch (err) {
    dom.proxyError.textContent = `恢复失败：${err.message}`;
    dom.proxyError.classList.remove("hidden");
  } finally {
    state.proxyRecoveringKeys.delete(token);
    updateProxyCardButtonsDisabled();
  }
}

async function recoverAllProxyKeys() {
  if (state.proxyBusy) return;
  const currentProvider = selectedProxyProvider();
  if (!currentProvider) return;
  const enabled =
    !!(state.proxy && state.proxy.proxy_enabled) &&
    currentProvider.enabled !== false;
  if (!enabled) return;

  const disabledKeys = (currentProvider.keys || []).filter(
    (k) => k.disabled && k.id != null,
  );
  if (!disabledKeys.length) {
    setProxyNotice("当前供应商没有已失效的密钥。", "info");
    return;
  }
  if (
    !confirm(
      `确定恢复当前供应商下的全部 ${disabledKeys.length} 把失效密钥？恢复后会重新参与轮用。`,
    )
  ) {
    return;
  }

  const targetFp = currentProvider.fp;
  state.proxyBusy = true;
  proxyActionButtons().forEach((b) => {
    b.disabled = true;
  });
  updateProxyCardButtonsDisabled();

  let recoveredCount = 0;
  try {
    if (!MOCK) {
      const res = await api("/api/proxy/recover", {
        method: "POST",
        auth: true,
        body: { fp: currentProvider.fp, all: true },
      });
      recoveredCount = Number(res.recovered ?? disabledKeys.length);
    } else {
      const override = mockOverrideForProvider(currentProvider.fp);
      (currentProvider.keys || []).forEach((k, ki) => {
        if (!k.disabled || k.id == null) return;
        const rawKey = (currentProvider._mockPlainKeys || [])[ki] || "";
        if (!rawKey) return;
        const prev = override.keys.get(rawKey) || {};
        override.keys.set(rawKey, { ...prev, disabled: false, fail_count: 0 });
        recoveredCount++;
      });
    }
    const store = state.proxyLastResults.get(targetFp);
    if (store) {
      for (const k of disabledKeys) store.delete(String(k.id));
    }
  } catch (err) {
    setProxyNotice(`恢复失败：${err.message}`, "error");
    return;
  } finally {
    state.proxyBusy = false;
    dom.proxyProvider.disabled = false;
    renderProxyToolbar();
    updateProxyCardButtonsDisabled();
  }

  const loaded = await loadProxyState({ preserveResults: true });
  if (loaded) {
    setProxyNotice(
      recoveredCount > 0
        ? `已恢复当前供应商的 ${recoveredCount} 把失效密钥。`
        : "当前供应商没有需要恢复的失效密钥。",
      "info",
    );
  }
}

// ── Results tab ────────────────────────────────────────────────────────────
async function loadResults() {
  const reqId = ++state.reqSeq.results;
  dom.resultsLoading.classList.remove("hidden");
  dom.resultsError.classList.add("hidden");
  dom.resultsEmpty.classList.add("hidden");
  dom.resultsBody.classList.add("hidden");
  dom.resultsBody.innerHTML = "";

  try {
    // Ensure settings loaded
    if (!state.settings) {
      if (MOCK) {
        const mock = await getMock();
        if (reqId !== state.reqSeq.results) return;
        state.settings = mock.settings;
        applySettingsToUI();
      } else {
        const d = await api("/api/settings", { auth: true });
        if (reqId !== state.reqSeq.results) return;
        state.settings = d.settings || {};
        applySettingsToUI();
      }
    }

    const providers = state.settings.providers || [];
    const runStatusPromise = MOCK
      ? getMock().then((m) => m.run_status || { running: false })
      : api("/api/run-status", { auth: true }).catch(() => ({
          running: false,
        }));

    if (!providers.length) {
      const runStatus = await runStatusPromise;
      if (reqId !== state.reqSeq.results) return;
      const running = !!(runStatus && runStatus.running);
      dom.resultsRunningBadge.classList.toggle("hidden", !running);
      dom.resultsEmpty.textContent = running
        ? "测试正在进行中，尚无历史结果。"
        : "尚无测试结果，请先执行一次测试。";
      dom.resultsEmpty.classList.remove("hidden");
      return;
    }

    // Fetch per-provider results and global test_run_status in parallel
    const [bundles, runStatus] = await Promise.all([
      Promise.all(
        providers.map(async (p) => {
          const payload = fingerprintPayload(p);
          let fp = state.fpCache.get(payload);
          if (!fp) {
            fp = await sha256(payload);
            state.fpCache.set(payload, fp);
          }
          const host = extractHost(p.api_base);

          let resultData = { exists: false };
          if (MOCK) {
            const mock = await getMock();
            resultData = (mock.results || {})[host] || { exists: false };
          } else {
            resultData = await api(
              `/api/results?fp=${encodeURIComponent(fp)}`,
              { auth: true },
            ).catch(() => ({ exists: false }));
          }
          return { provider: p, fp, host, resultData };
        }),
      ),
      runStatusPromise,
    ]);

    if (reqId !== state.reqSeq.results) return;

    const running = !!(runStatus && runStatus.running);
    dom.resultsRunningBadge.classList.toggle("hidden", !running);
    if (running && runStatus.started_at) {
      dom.resultsRunningBadge.title = `开始于 ${fmtDateTime(runStatus.started_at)}`;
    } else {
      dom.resultsRunningBadge.removeAttribute("title");
    }

    const withResults = bundles.filter((b) => b.resultData.exists);
    if (!withResults.length) {
      dom.resultsEmpty.textContent = running
        ? "测试正在进行中，尚无历史结果。"
        : "尚无测试结果，请先执行一次测试。";
      dom.resultsEmpty.classList.remove("hidden");
      return;
    }

    dom.resultsBody.innerHTML = withResults.map(renderProviderResult).join("");
    // Seed line numbers in result copy blocks
    dom.resultsBody
      .querySelectorAll(".result-lined-editor textarea")
      .forEach(function (textarea) {
        syncLineNums(textarea);
      });
    dom.resultsBody.classList.remove("hidden");
  } catch (err) {
    if (reqId !== state.reqSeq.results) return;
    dom.resultsError.textContent = `读取失败：${err.message}`;
    dom.resultsError.classList.remove("hidden");
  } finally {
    if (reqId === state.reqSeq.results) {
      dom.resultsLoading.classList.add("hidden");
    }
  }
}

function renderProviderResult({ provider, host, resultData }) {
  const r = resultData.exists ? resultData.results : null;

  const uploadedAt = r?.uploaded_at
    ? `上次更新：${fmtDateTime(r.uploaded_at)}`
    : "";

  const bodyHtml = r
    ? renderResultBody(r)
    : `<p class="muted empty-note">尚无测试结果。</p>`;

  return `
    <div class="result-group">
      <div class="result-group-header" tabindex="0" role="button" aria-expanded="false">
        <div class="rgh-main">
          <div class="rgh-top">
            <span class="badge">${esc(provider.provider_type)}</span>
            <span class="rgh-arrow">▼</span>
          </div>
          <div class="rgh-host" title="${esc(provider.api_base)}">${esc(host)}</div>
          ${uploadedAt ? `<div class="rgh-time muted">${esc(uploadedAt)}</div>` : ""}
        </div>
      </div>
      <div class="result-group-body">
        ${bodyHtml}
      </div>
    </div>
  `;
}

function renderResultBody(r) {
  const validKeys = r.valid_keys || [];
  const invalidRecs = r.invalid_records || [];
  const provenModels = r.proven_working_models || [];
  const failedModels = r.failed_models || [];
  const modelPerf = r.model_performance || {};

  return `
    <div class="result-section">
      <div class="section-title">
        有效 Key
        <span class="badge badge-ok">${validKeys.length}</span>
      </div>
      <div class="copy-block">
        <div class="lined-editor result-lined-editor result-editor-box">
          <div class="line-nums" aria-hidden="true"></div>
          <textarea class="copy-textarea lined-textarea" readonly spellcheck="false">${esc(validKeys.join("\n"))}</textarea>
        </div>
        <button class="btn btn-ghost btn-xs btn-icon copy-btn" data-copy-val="${escAttr(validKeys.join("\n"))}" type="button" title="复制全部有效 Key" aria-label="复制全部有效 Key">${COPY_ICON_SVG}</button>
      </div>
    </div>

    <div class="result-section">
      <div class="section-title">
        有效模型
        <span class="badge badge-ok">${provenModels.length}</span>
      </div>
      <div class="copy-block">
        <div class="lined-editor lined-editor--wrap result-lined-editor result-editor-box">
          <div class="line-nums" aria-hidden="true"></div>
          <textarea class="copy-textarea lined-textarea" readonly spellcheck="false">${esc(provenModels.join(","))}</textarea>
        </div>
        <button class="btn btn-ghost btn-xs btn-icon copy-btn" data-copy-val="${escAttr(provenModels.join(","))}" type="button" title="复制全部有效模型" aria-label="复制全部有效模型">${COPY_ICON_SVG}</button>
      </div>
    </div>

    <div class="result-section">
      <div class="section-title">模型性能</div>
      ${renderPerfTable(modelPerf)}
    </div>

    <div class="result-section">
      <div class="section-title">
        失效模型
        <span class="badge badge-fail">${failedModels.length}</span>
      </div>
      <p class="mono-list muted">${failedModels.length ? esc(failedModels.join(", ")) : "（无）"}</p>
    </div>

    <div class="result-section">
      <div class="section-title">
        无效 Key
        <span class="badge badge-fail">${invalidRecs.length}</span>
      </div>
      ${renderInvalidGroups(invalidRecs)}
    </div>
  `;
}

// ── Model performance table ──────────────────────────────────────────────
function renderPerfTable(modelPerf) {
  const models = Object.keys(modelPerf).sort();
  if (!models.length) return `<p class="muted">（无数据）</p>`;

  const rows = models
    .map((model) => {
      const p = modelPerf[model];
      const total = p.avg_total != null ? `${p.avg_total}s` : "-";
      const toRate =
        p.timeout_rate != null
          ? `<span class="${p.timeout_rate > 0.3 ? "fail" : "na"}">${(p.timeout_rate * 100).toFixed(1)}%</span>`
          : "-";
      const thinkRatio =
        p.has_thinking_ratio != null
          ? `${(p.has_thinking_ratio * 100).toFixed(0)}%`
          : "-";
      const hasSample =
        p.sample &&
        (p.sample.content || p.sample.thinking || p.sample.has_thinking);
      const sampleBtn = hasSample
        ? `<button class="btn btn-ghost btn-xs" type="button"
           data-sample="${escAttr(JSON.stringify({ model, sample: p.sample }))}">查看</button>`
        : `<span class="na">-</span>`;
      const answerVerified =
        p.answer_verified === true
          ? `<span class="ok" title="至少一次成功回应中包含 323">✓</span>`
          : p.answer_verified === false
            ? `<span class="na" title="所有成功回应均未包含 323（可能被截断）">✗</span>`
            : `<span class="na">-</span>`;

      return `<tr>
      <td data-value="${esc(model)}"><code>${esc(model)}</code></td>
      <td data-value="${p.sample_count ?? ""}">${p.sample_count ?? 0}</td>
      <td data-value="${p.avg_total ?? ""}" class="na">${esc(total)}</td>
      <td data-value="${p.timeout_rate ?? ""}">${toRate}</td>
      <td data-value="${p.has_thinking_ratio ?? ""}" class="na">${esc(thinkRatio)}</td>
      <td data-value="${p.answer_verified === true ? 2 : p.answer_verified === false ? 1 : ""}">${answerVerified}</td>
      <td>${sampleBtn}</td>
    </tr>`;
    })
    .join("");

  return `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          <th data-sort="model">模型 <span class="sort-indicator"></span></th>
          <th data-sort="sample_count">成功数 <span class="sort-indicator"></span></th>
          <th data-sort="avg_total">avg 总耗时 <span class="sort-indicator"></span></th>
          <th data-sort="timeout_rate">超时率 <span class="sort-indicator"></span></th>
          <th data-sort="has_thinking_ratio">有思考 <span class="sort-indicator"></span></th>
          <th data-sort="answer_verified">答案验证 <span class="sort-indicator"></span></th>
          <th>Sample</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ── Invalid key groups ───────────────────────────────────────────────────
function renderInvalidGroups(records) {
  if (!records.length) return `<p class="muted">（无）</p>`;

  // Group by error_code + normalized message. Raw text would split one cause across
  // every key (providers embed the key fragment in the message); error_code alone
  // would merge two genuinely different causes sharing a code.
  const groups = new Map();
  for (const rec of records) {
    const reason = rec.error_reason || "未知原因";
    const groupKey = `${rec.error_code ?? ""}|${normalizeMessage(reason)}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(rec);
  }

  return Array.from(groups.values())
    .map((recs) => {
      // Every record keeps its own message; the group shows the first one.
      const reason = recs[0].error_reason || "未知原因";
      const items = recs
        .map((rec) => {
          const copyBtn = rec.api_key
            ? `<button class="btn btn-ghost btn-xs btn-icon copy-btn" type="button" title="复制 KEY" aria-label="复制 KEY" data-copy-val="${escAttr(rec.api_key)}">${COPY_ICON_SVG}</button>`
            : "";
          return `<div class="inv-key-item">
        <span class="inv-key-mono">${esc(rec.api_key || "")}</span>
        ${copyBtn}
      </div>`;
        })
        .join("");

      // Only one record per cause carries error_detail (the rest are nulled by dedup).
      const withDetail = recs.find((rec) => rec.error_detail);
      const errorCode = recs[0].error_code ?? null;
      const fullReason = truncate(reason, Infinity);
      const shownReason = truncate(reason);
      const title =
        errorCode != null ? `${errorCode} · ${shownReason}` : shownReason;
      // When no record in the group carries a detail, still offer the modal if the
      // title had to be cut — reading the whole message is the point of the button.
      const detail =
        withDetail?.error_detail ??
        (shownReason !== fullReason ? { message: fullReason } : null);
      const detailBtn = detail
        ? `<button class="btn btn-ghost btn-sm" type="button" title="查看错误详情" aria-label="查看错误详情"
             data-errdetail="${escAttr(JSON.stringify({ error_code: withDetail?.error_code ?? errorCode, error_detail: detail }))}">📋</button>`
        : "";

      const keysToCopy = recs.map((rec) => rec.api_key).join("\n");
      return `<div class="inv-group">
      <div class="inv-group-header" tabindex="0" role="button" aria-expanded="false">
        <span class="inv-group-title" title="${escAttr(reason)}">${esc(title)}</span>
        <span class="badge badge-fail">${recs.length}</span>
        ${detailBtn}
        <button class="btn btn-ghost btn-xs btn-icon copy-btn" data-copy-val="${escAttr(keysToCopy)}" type="button" title="复制本组全部 KEY" aria-label="复制本组全部 KEY">${COPY_ICON_SVG}</button>
        <span class="inv-group-toggle">▼</span>
      </div>
      <div class="inv-group-body">${items}</div>
    </div>`;
    })
    .join("");
}

// ── Error detail modal (shared by results tab and dead keys tab) ─────────
function openErrorDetail(errorCode, detail, subtitle = "") {
  dom.errDetailSubtitle.textContent = subtitle;
  const entries = detail && typeof detail === "object" ? Object.entries(detail) : [];
  const rows = entries.length
    ? entries
        .map(
          ([k, v]) => `<div class="errdetail-row">
        <div class="errdetail-key">${esc(k)}</div>
        <pre class="errdetail-val">${esc(v)}</pre>
      </div>`,
        )
        .join("")
    : `<p class="muted">（无错误详情）</p>`;

  dom.errDetailContent.innerHTML = `
    ${errorCode != null ? `<div class="errdetail-code">Error Code: <strong>${esc(errorCode)}</strong></div>` : ""}
    ${rows}
  `;
  openModal(dom.errDetailOverlay);
}

function closeErrorDetail() {
  closeModal(dom.errDetailOverlay);
}

// ── Dead keys tab ─────────────────────────────────────────────────────────
function providerDisplayName(p, fallbackHost = "") {
  const host = (p && p.host) || extractHost(p && p.api_base) || fallbackHost;
  return String((p && p.alias) || "").trim() || host;
}

function providerFormatLabel(p, fallbackHost = "") {
  const name = providerDisplayName(p, fallbackHost);
  const format = String((p && p.provider_type) || "").trim();
  return format ? `${name} - ${format}` : name;
}

function dkProviderEntries() {
  const providers = (state.settings || {}).providers || [];
  const hostCounts = new Map();
  const entries = providers.map((p) => {
    const host = extractHost(p?.api_base);
    if (host) hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
    return { provider: p, fp: cachedProviderFp(p), host };
  });
  return entries.map((e) => ({
    ...e,
    multiOnHost: (hostCounts.get(e.host) || 0) > 1,
  }));
}

function dkProviderForRecord(rec) {
  const entries = dkProviderEntries();
  if (rec && typeof rec === "object") {
    const recFp = typeof rec.fp === "string" ? rec.fp.trim() : "";
    if (recFp) return entries.find((e) => e.fp === recFp) || null;
  }
  const host = typeof rec === "string" ? rec : rec?.provider_host || "";
  const byHost = entries.filter((e) => e.host === host);
  return byHost.length === 1 ? byHost[0] : null;
}

function dkProvidersByHost(host) {
  if (!host) return [];
  return ((state.settings || {}).providers || []).filter(
    (p) => p && extractHost(p.api_base) === host,
  );
}

function dkProviderLabel(recOrHost) {
  if (!recOrHost) return "";
  if (typeof recOrHost === "object") {
    const hit = dkProviderForRecord(recOrHost);
    if (hit) {
      return hit.multiOnHost
        ? providerFormatLabel(hit.provider, hit.host)
        : providerDisplayName(hit.provider, hit.host);
    }
    return dkProviderLabel(recOrHost.provider_host || "");
  }
  const h = String(recOrHost);
  const matches = dkProvidersByHost(h);
  if (!matches.length) return h;
  const labels = [];
  for (const p of matches) {
    const lbl = providerDisplayName(p, h);
    if (lbl && !labels.includes(lbl)) labels.push(lbl);
  }
  return labels.join(" / ") || h;
}

function dkProviderTitle(recOrHost) {
  if (!recOrHost) return "";
  if (typeof recOrHost === "object") {
    const hit = dkProviderForRecord(recOrHost);
    if (hit) {
      const lbl = dkProviderLabel(recOrHost);
      const base = String(hit.provider?.api_base || "").trim();
      return base ? `${lbl}\n${base}` : lbl;
    }
    return dkProviderTitle(recOrHost.provider_host || "");
  }
  const h = String(recOrHost);
  const label = dkProviderLabel(h);
  const matches = dkProvidersByHost(h);
  if (!matches.length) return h;
  const bases = [
    ...new Set(
      matches.map((p) => String(p.api_base || "").trim()).filter(Boolean),
    ),
  ];
  return bases.length ? `${label}\n${bases.join("\n")}` : label;
}

/** Provider dropdown mirrors 来源设定 cards (keyed by fp so same-host
 *  providers stay separate), plus any orphaned dead_keys scopes. */
function fillHostSelect(select, { includeAll = false, selected = "" } = {}) {
  const entries = dkProviderEntries();
  const options = [];
  const seenValues = new Set();
  const liveHosts = new Set();

  for (const e of entries) {
    const val = e.fp || e.host;
    if (!val || seenValues.has(val)) continue;
    seenValues.add(val);
    if (e.host) liveHosts.add(e.host);
    const label = e.multiOnHost
      ? providerFormatLabel(e.provider, e.host)
      : providerDisplayName(e.provider, e.host);
    const base = String(e.provider?.api_base || "").trim();
    const title = base ? `${label}\n${base}` : label;
    options.push({ value: val, label, title });
  }

  for (const r of state.deadKeys) {
    if (!r) continue;
    const recFp = typeof r.fp === "string" ? r.fp.trim() : "";
    const val = recFp || r.provider_host || "";
    if (!val || seenValues.has(val)) continue;
    if (!recFp && liveHosts.has(val)) continue;
    seenValues.add(val);
    options.push({
      value: val,
      label: dkProviderLabel(r),
      title: dkProviderTitle(r),
    });
  }

  const opts = [];
  if (includeAll) opts.push(`<option value="">全部供应商</option>`);
  else if (!options.length) opts.push(`<option value="">（尚无服务商）</option>`);
  for (const o of options) {
    opts.push(
      `<option value="${escAttr(o.value)}" title="${escAttr(o.title)}">${esc(o.label)}</option>`,
    );
  }
  select.innerHTML = opts.join("");
  if (selected && seenValues.has(selected)) select.value = selected;
  syncCustomSelect(select);
}

// Empty <select> value is "all codes"; a second empty cannot mean "no code".
const DK_CODE_NONE = "__none__";

function fillCodeSelect() {
  const selected = dom.dkFCode.value;
  const codes = [];
  let hasNone = false;
  for (const r of state.deadKeys) {
    if (!r) continue;
    if (r.error_code == null) {
      hasNone = true;
      continue;
    }
    const n = Number(r.error_code);
    if (!Number.isFinite(n)) continue;
    if (!codes.includes(n)) codes.push(n);
  }
  codes.sort((a, b) => a - b);

  const opts = [`<option value="">全部 Code</option>`];
  for (const c of codes) {
    opts.push(`<option value="${escAttr(String(c))}">${esc(String(c))}</option>`);
  }
  if (hasNone) {
    opts.push(`<option value="${DK_CODE_NONE}">无 Code</option>`);
  }
  dom.dkFCode.innerHTML = opts.join("");
  if (selected === DK_CODE_NONE && hasNone) {
    dom.dkFCode.value = DK_CODE_NONE;
  } else if (selected && codes.includes(Number(selected))) {
    dom.dkFCode.value = selected;
  }
  syncCustomSelect(dom.dkFCode);
}

function dkDateOf(rec) {
  const v = rec && typeof rec.expired_at === "string" ? rec.expired_at : "";
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "";
}

/** A record whose error_detail was nulled by dedup borrows the one stored on the
 *  first record of its scope (fp or host) + code group, so 📋 always shows something. */
function detailFor(rec) {
  if (rec.error_detail) return rec.error_detail;
  const scope = dkRecordScope(rec);
  const twin = state.deadKeys.find(
    (r) =>
      r &&
      r.error_detail &&
      dkRecordScope(r) === scope &&
      (r.error_code ?? null) === (rec.error_code ?? null),
  );
  return twin ? twin.error_detail : null;
}

function detailMessage(detail) {
  if (!detail) return "";
  for (const k of ["message", "msg", "raw"]) {
    if (detail[k]) return String(detail[k]);
  }
  const first = Object.values(detail)[0];
  return first ? String(first) : "";
}

async function loadDeadKeys(force = false) {
  const reqId = ++state.reqSeq.deadkeys;
  dom.dkError.classList.add("hidden");
  // Filter panel stays visible at all times, so keep default options populated
  // even while loading or when a request fails.
  fillHostSelect(dom.dkFHost, { includeAll: true, selected: dom.dkFHost.value });
  fillCodeSelect();

  if (force) {
    exitDkSelectMode();
  }

  dom.dkLoading.classList.remove("hidden");
  dom.dkEmpty.classList.add("hidden");
  dom.dkTableWrap.classList.add("hidden");

  try {
    if (!state.settings) {
      if (MOCK) {
        const mock = await getMock();
        if (reqId !== state.reqSeq.deadkeys) return;
        state.settings = mock.settings;
      } else {
        const d = await api("/api/settings", { auth: true });
        if (reqId !== state.reqSeq.deadkeys) return;
        state.settings = d.settings || {};
        applySettingsToUI();
      }
    }

    if (MOCK) {
      const mock = await getMock();
      if (reqId !== state.reqSeq.deadkeys) return;
      state.deadKeys = Array.isArray(mock.dead_keys) ? mock.dead_keys : [];
    } else {
      const d = await api("/api/dead-keys", { auth: true });
      if (reqId !== state.reqSeq.deadkeys) return;
      state.deadKeys = Array.isArray(d.dead_keys) ? d.dead_keys : [];
    }
    await ensureProviderFps((state.settings || {}).providers || []);
    if (reqId !== state.reqSeq.deadkeys) return;
    if (!force && state.dkSelected.size > 0) {
      const validIds = new Set(state.deadKeys.map((r) => r && r.id).filter(Boolean));
      for (const id of [...state.dkSelected]) {
        if (!validIds.has(id)) state.dkSelected.delete(id);
      }
    }
    renderDeadKeys();
  } catch (err) {
    if (reqId !== state.reqSeq.deadkeys) return;
    dom.dkError.textContent = `读取失败：${err.message}`;
    dom.dkError.classList.remove("hidden");
  } finally {
    if (reqId === state.reqSeq.deadkeys) {
      dom.dkLoading.classList.add("hidden");
    }
  }
}

function parseFilterDate(value) {
  const m = /^(\d{4})[\/-](\d{2})[\/-](\d{2})$/.exec(
    String(value || "").trim(),
  );
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return "";
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function formatDateFilterInput(raw, caret, inputType) {
  const deleting = inputType === "deleteContentBackward";
  if (!deleting) {
    if (/^(\d{4})[\/-]$/.test(raw)) {
      const value = `${raw.slice(0, 4)}/`;
      return { value, caret: value.length };
    }
    const shortMonth = /^(\d{4})[\/-](\d)[\/-]$/.exec(raw);
    if (shortMonth) {
      const value = `${shortMonth[1]}/0${shortMonth[2]}/`;
      return { value, caret: value.length };
    }
    const fullMonth = /^(\d{4})[\/-](\d{2})[\/-]$/.exec(raw);
    if (fullMonth) {
      const value = `${fullMonth[1]}/${fullMonth[2]}/`;
      return { value, caret: value.length };
    }
  }

  const digitsBefore = raw.slice(0, caret).replace(/\D/g, "").length;
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  let value = digits;
  if (digits.length > 6) {
    value = `${digits.slice(0, 4)}/${digits.slice(4, 6)}/${digits.slice(6)}`;
  } else if (digits.length > 4) {
    value = `${digits.slice(0, 4)}/${digits.slice(4)}`;
  }

  let nextCaret = 0;
  let seen = 0;
  while (nextCaret < value.length && seen < digitsBefore) {
    if (/\d/.test(value[nextCaret])) seen++;
    nextCaret++;
  }
  if (!deleting && value[nextCaret] === "/") nextCaret++;
  return { value, caret: nextCaret };
}

function bindDateFilterInput(input) {
  const wrap = input.closest(".dk-date-wrap");
  const picker = wrap ? wrap.querySelector(".dk-date-picker") : null;
  const btn = wrap ? wrap.querySelector(".dk-date-btn") : null;

  const sync = (markIncomplete = false) => {
    const v = input.value.trim();
    const parsed = parseFilterDate(v);
    const bad = markIncomplete ? !!v && !parsed : v.length === 10 && !parsed;
    input.classList.toggle("is-invalid", bad);
    if (picker) picker.value = parsed;
  };

  const handleInput = (e) => {
    if (e && e.isComposing) return;
    const caret = input.selectionStart ?? input.value.length;
    const next = formatDateFilterInput(
      input.value,
      caret,
      e ? e.inputType : "",
    );
    if (input.value !== next.value) {
      input.value = next.value;
      try {
        input.setSelectionRange(next.caret, next.caret);
      } catch {}
    }
    sync(false);
    renderDeadKeys();
  };

  input.addEventListener("input", handleInput);
  input.addEventListener("compositionend", () => handleInput(null));
  input.addEventListener("blur", () => {
    const m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(
      input.value.trim(),
    );
    if (m) {
      input.value = `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;
    }
    sync(true);
    renderDeadKeys();
  });

  if (picker) {
    picker.addEventListener("change", () => {
      input.value = picker.value ? picker.value.replace(/-/g, "/") : "";
      sync(false);
      renderDeadKeys();
    });
  }

  if (btn && picker) {
    btn.addEventListener("click", () => {
      sync(false);
      if (typeof picker.showPicker === "function") {
        try {
          picker.showPicker();
          return;
        } catch {}
      }
      picker.focus();
      picker.click();
    });
  }
}

function resetDateFilterInput(input) {
  input.value = "";
  input.classList.remove("is-invalid");
  const wrap = input.closest(".dk-date-wrap");
  const picker = wrap ? wrap.querySelector(".dk-date-picker") : null;
  if (picker) picker.value = "";
}

function filteredDeadKeys() {
  const scope = dom.dkFHost.value;
  const scopeEntry = scope
    ? dkProviderEntries().find((e) => (e.fp || e.host) === scope)
    : null;
  const q = dom.dkFKey.value.trim().toLowerCase();
  const code = dom.dkFCode.value;
  const from = parseFilterDate(dom.dkFFrom.value);
  const to = parseFilterDate(dom.dkFTo.value);
  // One bound alone stays open-ended; the same day twice narrows to that day.
  const swap = from && to && from > to;
  const lo = swap ? to : from;
  const hi = swap ? from : to;

  return state.deadKeys.filter((r) => {
    if (!r) return false;
    if (scope) {
      if (r.fp) {
        if (r.fp !== scope && r.provider_host !== scope) return false;
      } else if (scopeEntry) {
        if (r.provider_host !== scopeEntry.host) return false;
      } else if (r.provider_host !== scope) {
        return false;
      }
    }
    if (q && !String(r.api_key || "").toLowerCase().includes(q)) return false;
    if (code === DK_CODE_NONE) {
      if (r.error_code != null) return false;
    } else if (code) {
      if (Number(r.error_code) !== Number(code)) return false;
    }
    if (lo || hi) {
      const d = dkDateOf(r);
      if (!d) return false;
      if (lo && d < lo) return false;
      if (hi && d > hi) return false;
    }
    return true;
  });
}

/** Order rows by provider order (providers that are gone go last), keeping
 *  the stored order within each provider so newest entries stay at the bottom. */
function sortByProviderOrder(rows) {
  const entries = dkProviderEntries();
  const indexByFp = new Map();
  const indexByHost = new Map();
  entries.forEach((e, idx) => {
    if (e.fp && !indexByFp.has(e.fp)) indexByFp.set(e.fp, idx);
    if (e.host && !indexByHost.has(e.host)) indexByHost.set(e.host, idx);
  });
  const rank = (r) => {
    if (r?.fp && indexByFp.has(r.fp)) return indexByFp.get(r.fp);
    if (r?.provider_host && indexByHost.has(r.provider_host)) {
      return indexByHost.get(r.provider_host);
    }
    return entries.length;
  };
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

/** 编号是筛选后、默认供应商顺序里的位置，跟着行走。若写成当下的 1..n，
 *  点编号排序时数字栏不会变，看起来像没在排。 */
function deadKeyIndexById(rows) {
  const map = new Map();
  sortByProviderOrder(rows).forEach((r, i) => map.set(r.id, i + 1));
  return map;
}

/** Null dates/codes stay last in both directions. Negating the whole
 *  comparator for desc would flip them to the top. */
function compareDeadKeyNullsLast(a, b, col) {
  if (col === "expired_at") {
    const da = dkDateOf(a);
    const db = dkDateOf(b);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return 0;
  }
  if (col === "code") {
    const aNull = a.error_code == null;
    const bNull = b.error_code == null;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return 0;
  }
  return 0;
}

function compareDeadKey(a, b, col) {
  if (col === "host") {
    return dkProviderLabel(a).localeCompare(dkProviderLabel(b));
  }
  if (col === "key") {
    return String(a.api_key || "").localeCompare(String(b.api_key || ""));
  }
  if (col === "expired_at") {
    const da = dkDateOf(a);
    const db = dkDateOf(b);
    return da < db ? -1 : da > db ? 1 : 0;
  }
  if (col === "code") {
    return Number(a.error_code) - Number(b.error_code);
  }
  return 0;
}

function sortDeadKeyRows(rows, indexById) {
  const { col, dir } = state.dkSort;
  const desc = dir === "desc";
  if (col === "index") {
    return rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const cmp =
          (indexById.get(a.r.id) ?? 0) - (indexById.get(b.r.id) ?? 0);
        if (cmp !== 0) return desc ? -cmp : cmp;
        return a.i - b.i;
      })
      .map((x) => x.r);
  }
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const nullCmp = compareDeadKeyNullsLast(a.r, b.r, col);
      if (nullCmp !== 0) return nullCmp;
      const cmp = compareDeadKey(a.r, b.r, col);
      if (cmp !== 0) return desc ? -cmp : cmp;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

function visibleDeadKeys() {
  const filtered = filteredDeadKeys();
  return sortDeadKeyRows(filtered, deadKeyIndexById(filtered));
}

function renderDeadKeys() {
  fillHostSelect(dom.dkFHost, { includeAll: true, selected: dom.dkFHost.value });
  fillCodeSelect();

  const filtered = filteredDeadKeys();
  const indexById = deadKeyIndexById(filtered);
  const rows = sortDeadKeyRows(filtered, indexById);
  updateDkBulkBtn(rows.length);
  if (!rows.length) {
    dom.dkEmpty.textContent = state.deadKeys.length
      ? "没有符合筛选条件的记录。"
      : "尚无失效密钥记录。";
    dom.dkEmpty.classList.remove("hidden");
    dom.dkTableWrap.classList.add("hidden");
    return;
  }
  // innerHTML 会换掉 .table-scroll，横滑位置要先记下再写回，否则点排序会跳回最左。
  const scroller = dom.dkTableWrap.querySelector(".table-scroll");
  const scrollLeft = scroller ? scroller.scrollLeft : 0;
  dom.dkEmpty.classList.add("hidden");
  dom.dkTableWrap.innerHTML = renderDeadKeysTable(rows, indexById);
  const next = dom.dkTableWrap.querySelector(".table-scroll");
  if (next) next.scrollLeft = scrollLeft;
  syncDkCheckAll(rows);
  dom.dkTableWrap.classList.remove("hidden");
}

function renderDeadKeysTable(rows, indexById) {
  const selecting = state.dkSelectMode;
  const body = rows
    .map((r, i) => {
      const detail = detailFor(r);
      const msg = detailMessage(detail);
      const detailBtn = detail
        ? `<button class="btn btn-ghost btn-xs" type="button" title="查看错误详情" aria-label="查看错误详情" data-dk-detail="${escAttr(r.id)}">📋</button>`
        : `<span class="na">-</span>`;
      const preview = msg
        ? `<span class="dk-msg" title="${escAttr(msg)}">${esc(truncate(msg))}</span>`
        : "";
      const checked = state.dkSelected.has(r.id) ? " checked" : "";
      const copyKeyBtn = r.api_key
        ? `<button class="btn btn-ghost btn-xs btn-icon copy-btn" type="button" title="复制 KEY" aria-label="复制 KEY" data-copy-val="${escAttr(r.api_key)}">${COPY_ICON_SVG}</button>`
        : "";
      const numOrCheckCell = selecting
        ? `<td class="dk-check-col"><label class="dk-check-label"><input type="checkbox" class="dk-check" data-dk-check="${escAttr(r.id)}" aria-label="选中此记录"${checked} /></label></td>`
        : `<td class="dk-check-col dk-num-cell">${indexById.get(r.id) ?? i + 1}</td>`;
      return `<tr>
      ${numOrCheckCell}
      <td class="dk-host-col"><span class="dk-host-cell" title="${escAttr(dkProviderTitle(r))}">${esc(dkProviderLabel(r))}</span></td>
      <td class="dk-key-col"><div class="dk-key-line"><code class="dk-key-cell" title="${escAttr(r.api_key || "")}">${dkKeyHtml(r.api_key)}</code>${copyKeyBtn}</div></td>
      <td class="dk-date-col dk-date-cell">${esc(dkDateOf(r) || "-")}</td>
      <td class="dk-code-col">${r.error_code != null ? esc(r.error_code) : `<span class="na">-</span>`}</td>
      <td class="dk-msg-col"><div class="dk-msg-line">${detailBtn}${preview}</div></td>
    </tr>`;
    })
    .join("");

  const numOrCheckHead = selecting
    ? `<th class="dk-check-col" scope="col"><label class="dk-check-label"><input type="checkbox" class="dk-check" data-dk-check-all aria-label="全选" /></label></th>`
    : dkSortHead("index", "编号", "dk-check-col");

  return `
    <div class="table-scroll">
      <table class="data-table dk-table">
        <thead><tr>
          ${numOrCheckHead}
          ${dkSortHead("host", "供应商", "dk-host-col")}
          ${dkSortHead("key", "KEY", "dk-key-col")}
          ${dkSortHead("expired_at", "失效时间", "dk-date-col")}
          ${dkSortHead("code", "Code", "dk-code-col")}
          <th class="dk-msg-col">错误讯息</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function dkSortHead(col, label, extraClass) {
  const cls = extraClass ? ` class="${extraClass}"` : "";
  const active = state.dkSort.col === col;
  const dir = active ? ` data-sort-dir="${state.dkSort.dir}"` : "";
  const mark = active ? (state.dkSort.dir === "asc" ? "▲" : "▼") : "";
  return `<th${cls} data-sort="${col}"${dir} scope="col">${label}<span class="sort-indicator">${mark}</span></th>`;
}

function removeDeadKeysLocal(ids) {
  const idSet = new Set(ids);
  const removed = state.deadKeys.filter((r) => r && idSet.has(r.id));
  const next = state.deadKeys.filter((r) => !r || !idSet.has(r.id));
  rebalanceDeadKeyDetails(removed, next);
  state.deadKeys = next;
  if (MOCK && _mockData) _mockData.dead_keys = next;
}

function updateDkBulkBtn(visibleCount) {
  const n = state.dkSelected.size;
  const selecting = state.dkSelectMode;
  if (!selecting) {
    dom.dkBulkDelBtn.textContent = "删除密钥";
  } else {
    dom.dkBulkDelBtn.textContent = n > 0 ? "确认删除" : "取消删除";
  }
  dom.dkBulkDelBtn.setAttribute("aria-pressed", String(selecting));
  const empty = visibleCount === 0 && !selecting;
  dom.dkBulkDelBtn.disabled = empty;
}

function syncDkCheckAll(rows) {
  const allBox = dom.dkTableWrap.querySelector("[data-dk-check-all]");
  if (!allBox) return;
  const visibleIds = rows.map((r) => r.id);
  const picked = visibleIds.filter((id) => state.dkSelected.has(id)).length;
  allBox.checked = visibleIds.length > 0 && picked === visibleIds.length;
  allBox.indeterminate = picked > 0 && picked < visibleIds.length;
}

function exitDkSelectMode() {
  state.dkSelectMode = false;
  state.dkSelected.clear();
  updateDkBulkBtn(0);
}

function onDkBulkDelClick() {
  if (!state.dkSelectMode) {
    state.dkSelectMode = true;
    renderDeadKeys();
    return;
  }
  if (state.dkSelected.size === 0) {
    exitDkSelectMode();
    renderDeadKeys();
    return;
  }
  openDkConfirm();
}

function selectedDeadKeys() {
  return state.deadKeys.filter((r) => r && state.dkSelected.has(r.id));
}

function openDkConfirm() {
  const recs = selectedDeadKeys();
  if (!recs.length) return;
  state.dkPendingDelete = recs.map((r) => r.id);
  dom.dkConfirmMsg.textContent = `确定删除以下 ${recs.length} 笔失效密钥？此操作无法复原。`;
  dom.dkConfirmList.innerHTML = recs
    .map(
      (r) => `<li>
      <span class="dk-confirm-key">${dkKeyHtml(r.api_key)}</span>
      <span class="dk-confirm-host">${esc(dkProviderLabel(r))}</span>
    </li>`,
    )
    .join("");
  if (dom.dkConfirmError) dom.dkConfirmError.textContent = "";
  openModal(dom.dkConfirmOverlay);
}

function closeDkConfirm() {
  state.dkPendingDelete = null;
  if (dom.dkConfirmError) dom.dkConfirmError.textContent = "";
  closeModal(dom.dkConfirmOverlay);
}

async function confirmDeleteDeadKeys() {
  const ids = state.dkPendingDelete || selectedDeadKeys().map((r) => r.id);
  if (!ids.length) return closeDkConfirm();

  dom.dkError.classList.add("hidden");
  dom.dkConfirmOk.disabled = true;
  const originalText = dom.dkConfirmOk.textContent;
  dom.dkConfirmOk.textContent = "删除中...";
  if (dom.dkConfirmError) dom.dkConfirmError.textContent = "";

  try {
    if (MOCK) {
      removeDeadKeysLocal(ids);
    } else {
      const d = await api("/api/dead-keys", {
        method: "DELETE",
        auth: true,
        body: { ids },
      });
      if (Array.isArray(d.dead_keys)) {
        state.deadKeys = d.dead_keys;
      } else {
        removeDeadKeysLocal(ids);
      }
    }
    closeDkConfirm();
    exitDkSelectMode();
    renderDeadKeys();
  } catch (err) {
    if (dom.dkConfirmError) {
      dom.dkConfirmError.textContent = `删除失败：${err.message}`;
    } else {
      dom.dkError.textContent = `删除失败：${err.message}`;
      dom.dkError.classList.remove("hidden");
      closeDkConfirm();
    }
  } finally {
    dom.dkConfirmOk.disabled = false;
    dom.dkConfirmOk.textContent = originalText;
  }
}

function onDkCheckChange(e) {
  const all = e.target.closest("[data-dk-check-all]");
  if (all) {
    const boxes = dom.dkTableWrap.querySelectorAll("[data-dk-check]");
    boxes.forEach((cb) => {
      cb.checked = all.checked;
      if (all.checked) state.dkSelected.add(cb.dataset.dkCheck);
      else state.dkSelected.delete(cb.dataset.dkCheck);
    });
    all.indeterminate = false;
    updateDkBulkBtn(boxes.length);
    return;
  }
  const box = e.target.closest("[data-dk-check]");
  if (!box) return;
  if (box.checked) state.dkSelected.add(box.dataset.dkCheck);
  else state.dkSelected.delete(box.dataset.dkCheck);
  const rows = visibleDeadKeys();
  syncDkCheckAll(rows);
  updateDkBulkBtn(rows.length);
}

// ── Result group open/close ──────────────────────────────────────────────
// handled via event delegation after innerHTML set in loadResults

// ── Sample modal ──────────────────────────────────────────────────────────
function openSample(model, sample) {
  dom.sampleTitle.textContent = model;
  dom.sampleSubtitle.textContent = "";
  const thinking = sample?.thinking || "";
  const hasThinking = !!sample?.has_thinking;
  const content = sample?.content || "";
  dom.sampleContent.innerHTML = `
    ${
      thinking || hasThinking
        ? `<div class="sample-block">
      <div class="sample-block-label">Thinking</div>
      <pre class="sample-pre">${thinking ? esc(thinking) : `<span class="na">（思考已發生，但內容未公開）</span>`}</pre>
    </div>`
        : ""
    }
    <div class="sample-block">
      <div class="sample-block-label">Content</div>
      <pre class="sample-pre">${content ? esc(content) : `<span class="na">（空）</span>`}</pre>
    </div>
  `;
  openModal(dom.sampleOverlay);
}
function closeSample() {
  closeModal(dom.sampleOverlay);
}

// ── Copy ──────────────────────────────────────────────────────────────────
const copyBtnTimers = new WeakMap();

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch (_) {}
  document.body.removeChild(ta);
}

function copyText(text, btn) {
  const doFeedback = () => {
    if (!btn || !btn.isConnected) return;
    const prevTimer = copyBtnTimers.get(btn);
    if (prevTimer) clearTimeout(prevTimer);

    const origHtml = btn.dataset.origHtml ?? btn.innerHTML;
    btn.dataset.origHtml = origHtml;
    btn.innerHTML = CHECK_ICON_SVG;
    btn.classList.add("copied");
    btn.disabled = true;
    const timer = setTimeout(() => {
      copyBtnTimers.delete(btn);
      if (!btn.isConnected) return;
      btn.innerHTML = origHtml;
      delete btn.dataset.origHtml;
      btn.classList.remove("copied");
      btn.disabled = false;
    }, 1500);
    copyBtnTimers.set(btn, timer);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(doFeedback)
      .catch(() => {
        fallbackCopy(text);
        doFeedback();
      });
  } else {
    fallbackCopy(text);
    doFeedback();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function escAttr(v) {
  return esc(v);
}

// Collapse whitespace and cut overly long provider messages so they fit one line.
// The untruncated text stays available via title attribute / error detail modal.
function truncate(v, n = 120) {
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? s.slice(0, n) + "..." : s;
}

// Mask the fragments that vary per key/request so two records can be compared as
// "same cause". Must produce byte-identical output to normalize_message() in
// async_test_keys.py, hence two constraints on these patterns:
//   - no \b or \d: Python counts CJK as word chars and full-width digits as digits,
//     JS does not, so they disagree on the Chinese messages providers return.
//   - no lookbehind: it is a parse-time syntax error below Safari 16.4, which would
//     take down this whole file; a captured leading char does the same job.
function normalizeMessage(v) {
  return String(v ?? "")
    .toLowerCase()
    .replace(/(^|[^a-z0-9])(?:sk|gsk|api|key)[-_][a-z0-9_\-*]{3,}/g, "$1<key>")
    .replace(/\*{2,}[a-z0-9]+/g, "<key>")
    .replace(/(^|[^a-z0-9])[0-9a-f]{8,}(?![a-z0-9])/g, "$1<id>")
    .replace(/[0-9０-９]+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// Fixed YYYY-MM-DD HH:mm(:ss) in local time. toLocaleString() follows the browser
// locale, which mixes formats across machines (2026/8/12 下午10:15 vs 8/12/2026
// 10:15 PM); the dead keys table already shows plain ISO dates, so match it.
function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function extractHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "";
  }
}

function fingerprintPayload(p) {
  // Must match _worker.js: sorted keys { api_base, provider_type }
  return JSON.stringify({
    api_base: p.api_base.replace(/\/+$/, ""),
    provider_type: p.provider_type,
  });
}

async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Events ────────────────────────────────────────────────────────────────
function bindEvents() {
  initCustomSelects();
  initInfoTooltips();
  // Auth
  dom.authBtn.addEventListener("click", login);
  dom.authInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });
  dom.logoutBtn.addEventListener("click", logout);

  // Topbar mobile menu
  dom.mobileMenuBtn.addEventListener("click", () => toggleMobileMenu());
  dom.mobileMenuClose?.addEventListener("click", () => toggleMobileMenu(false));
  dom.topbarMenuBackdrop?.addEventListener("click", () =>
    toggleMobileMenu(false),
  );

  // Theme
  dom.themeToggle.addEventListener("click", () => {
    toggleTheme();
    toggleMobileMenu(false);
  });

  // Tabs
  dom.tabBtns.forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab)),
  );

  // Line numbers
  bindLineNums(dom.edKeys);
  bindLineNums(dom.edModels);
  bindLineNums(dom.edExtraBody);
  bindKeysHighlight();

  // Extra Body JSON live validation
  dom.edExtraBody.addEventListener("input", () => {
    const val = dom.edExtraBody.value.trim();
    if (!val) {
      dom.edExtraBodyStatus.textContent = "";
      dom.edExtraBodyStatus.className = "json-status";
      return;
    }
    try {
      JSON.parse(val);
      dom.edExtraBodyStatus.textContent = "✓ 有效";
      dom.edExtraBodyStatus.className = "json-status json-ok";
    } catch {
      dom.edExtraBodyStatus.textContent = "✗ 格式错误";
      dom.edExtraBodyStatus.className = "json-status json-err";
    }
  });

  // Config
  dom.addProviderBtn.addEventListener("click", () => openEditor());
  dom.bulkEnableBtn.addEventListener("click", () => bulkToggle(true));
  dom.bulkDisableBtn.addEventListener("click", () => bulkToggle(false));
  dom.providerGrid.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) return openEditor(Number(editBtn.dataset.edit));
    const delBtn = e.target.closest("[data-delete]");
    if (delBtn) return deleteProvider(Number(delBtn.dataset.delete));
  });
  dom.providerGrid.addEventListener("change", (e) => {
    const box = e.target.closest("[data-select]");
    if (box) toggleSelection(Number(box.dataset.select));
  });
  dom.edAddHeaderBtn.addEventListener("click", () => {
    const row = createHeaderRow();
    dom.edHeadersContainer.appendChild(row);
    row.querySelector("[data-header-key]")?.focus();
  });
  dom.editorSave.addEventListener("click", () => saveEditor());
  dom.editorCancel.addEventListener("click", closeEditor);

  // Key tools: three-state sort, export, footer delete confirmation. Finding a key
  // is the orange occurrence highlight in the textarea, bound in bindKeysHighlight.
  dom.edSortKeysBtn.addEventListener("click", cycleEditorSort);
  dom.edExportKeysBtn.addEventListener("click", exportEditorKeys);
  dom.edKeys.addEventListener("input", () => {
    if (
      state.editorPendingRemoved &&
      diffKeyLines(state.editorSnapshot ?? "", dom.edKeys.value).length === 0
    ) {
      hideEditorConfirm();
    }
  });
  dom.editorOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "editor") closeEditor();
  });

  // Proxy tab
  dom.proxyProvider.addEventListener("change", () => {
    state.proxySelected = dom.proxyProvider.value;
    clearProxyNotice({ keepGlobal: true });
    renderProxyToolbar();
    renderProxyKeyCards();
  });
  dom.proxyUrlCopy.innerHTML = COPY_ICON_SVG;
  dom.proxyUrlCopy.addEventListener("click", () => {
    const url = dom.proxyUrlCopy.dataset.copyVal || "";
    if (url) copyText(url, dom.proxyUrlCopy);
  });
  dom.proxySaveModel.addEventListener("click", saveProxyTestModel);
  dom.proxyTestActive.addEventListener("click", () => runProxyBatch("active"));
  dom.proxyTestDisabled.addEventListener("click", () => runProxyBatch("disabled"));
  dom.proxyRecoverAll.addEventListener("click", recoverAllProxyKeys);
  dom.proxyKeyGrid.addEventListener("click", (e) => {
    const copyBtn = e.target.closest(".copy-btn");
    if (copyBtn) {
      return copyText(copyBtn.dataset.copyVal || "", copyBtn);
    }
    if (state.proxyBusy) return;
    const testBtn = e.target.closest("[data-proxy-test]");
    if (testBtn) {
      return testProxyKey(testBtn.dataset.fp, testBtn.dataset.proxyTest);
    }
    const recoverBtn = e.target.closest("[data-proxy-recover]");
    if (recoverBtn) {
      return recoverProxyKey(
        recoverBtn.dataset.fp,
        recoverBtn.dataset.proxyRecover,
      );
    }
  });

  // Result body delegated scroll (capture phase — scroll doesn't bubble from textarea)
  dom.resultsBody.addEventListener(
    "scroll",
    (e) => {
      if (
        e.target.tagName === "TEXTAREA" &&
        e.target.closest(".result-lined-editor")
      ) {
        syncLineNums(e.target);
      }
    },
    true,
  );

  // Result group open & performance table sorting — delegated
  const toggleResultGroupHeader = (header) => {
    const g = header.closest(".result-group");
    if (!g) return;
    const open = g.classList.toggle("open");
    header.setAttribute("aria-expanded", String(open));
  };
  const toggleInvGroupHeader = (invHeader) => {
    const g = invHeader.closest(".inv-group");
    if (!g) return;
    const open = g.classList.toggle("open");
    invHeader.setAttribute("aria-expanded", String(open));
  };

  dom.resultsBody.addEventListener("click", (e) => {
    const header = e.target.closest(".result-group-header");
    if (header) {
      toggleResultGroupHeader(header);
      return;
    }

    const invHeader = e.target.closest(".inv-group-header");
    if (invHeader && !e.target.closest("button")) {
      toggleInvGroupHeader(invHeader);
      return;
    }

    const sortTh = e.target.closest("th[data-sort]");
    if (sortTh) {
      e.stopPropagation();
      const table = sortTh.closest("table");
      const tbody = table.querySelector("tbody");
      const col = sortTh.dataset.sort;
      const currentDir = sortTh.dataset.sortDir || "";
      const newDir = currentDir === "asc" ? "desc" : "asc";

      table.querySelectorAll("th[data-sort]").forEach((th) => {
        delete th.dataset.sortDir;
        const indicator = th.querySelector(".sort-indicator");
        if (indicator) indicator.textContent = "";
      });

      sortTh.dataset.sortDir = newDir;
      const indicator = sortTh.querySelector(".sort-indicator");
      if (indicator) indicator.textContent = newDir === "asc" ? "▲" : "▼";

      const rowsArr = Array.from(tbody.querySelectorAll("tr"));
      const colIndex = Array.from(table.querySelectorAll("thead th")).indexOf(
        sortTh,
      );

      const isModel = col === "model";
      const pairs = rowsArr.map((row) => {
        const cell = row.children[colIndex];
        const raw =
          cell.dataset.value !== undefined
            ? cell.dataset.value
            : cell.textContent.trim();
        if (isModel) {
          return { row, val: raw, missing: raw === "" };
        }
        const parsed = raw === "" ? NaN : parseFloat(raw);
        return { row, val: parsed, missing: !Number.isFinite(parsed) };
      });

      pairs.sort((a, b) => {
        if (a.missing !== b.missing) return a.missing ? 1 : -1;
        if (isModel) {
          const cmp = a.val.localeCompare(b.val);
          return newDir === "asc" ? cmp : -cmp;
        }
        if (a.val < b.val) return newDir === "asc" ? -1 : 1;
        if (a.val > b.val) return newDir === "asc" ? 1 : -1;
        return 0;
      });

      const frag = document.createDocumentFragment();
      pairs.forEach((p) => frag.appendChild(p.row));
      tbody.appendChild(frag);
      return;
    }

    const copyBtn = e.target.closest(".copy-btn");
    if (copyBtn) {
      copyText(copyBtn.dataset.copyVal || "", copyBtn);
      return;
    }

    const sampleBtn = e.target.closest("[data-sample]");
    if (sampleBtn) {
      try {
        const payload = JSON.parse(sampleBtn.dataset.sample);
        openSample(payload.model, payload.sample);
      } catch {}
      return;
    }

    const errBtn = e.target.closest("[data-errdetail]");
    if (errBtn) {
      e.stopPropagation();
      try {
        const payload = JSON.parse(errBtn.dataset.errdetail);
        openErrorDetail(payload.error_code, payload.error_detail);
      } catch {}
    }
  });

  dom.resultsBody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest("button, input, textarea, select, a")) return;
    const header = e.target.closest(".result-group-header");
    if (header) {
      e.preventDefault();
      toggleResultGroupHeader(header);
      return;
    }
    const invHeader = e.target.closest(".inv-group-header");
    if (invHeader) {
      e.preventDefault();
      toggleInvGroupHeader(invHeader);
    }
  });

  // Dead keys tab
  dom.dkBulkDelBtn.addEventListener("click", onDkBulkDelClick);
  [dom.dkFHost, dom.dkFCode].forEach((el) =>
    el.addEventListener("change", renderDeadKeys),
  );
  bindDateFilterInput(dom.dkFFrom);
  bindDateFilterInput(dom.dkFTo);
  dom.dkFKey.addEventListener("input", renderDeadKeys);
  dom.dkFReset.addEventListener("click", () => {
    dom.dkFHost.value = "";
    dom.dkFKey.value = "";
    dom.dkFCode.value = "";
    syncCustomSelect(dom.dkFHost);
    syncCustomSelect(dom.dkFCode);
    resetDateFilterInput(dom.dkFFrom);
    resetDateFilterInput(dom.dkFTo);
    renderDeadKeys();
  });
  dom.dkTableWrap.addEventListener("click", (e) => {
    const sortTh = e.target.closest("th[data-sort]");
    if (sortTh) {
      const col = sortTh.dataset.sort;
      if (state.dkSort.col === col) {
        state.dkSort.dir = state.dkSort.dir === "asc" ? "desc" : "asc";
      } else {
        state.dkSort.col = col;
        state.dkSort.dir = "asc";
      }
      renderDeadKeys();
      return;
    }
    const copyBtn = e.target.closest(".copy-btn");
    if (copyBtn) return copyText(copyBtn.dataset.copyVal || "", copyBtn);

    const detailBtn = e.target.closest("[data-dk-detail]");
    if (detailBtn) {
      const rec = state.deadKeys.find(
        (r) => r && r.id === detailBtn.dataset.dkDetail,
      );
      if (rec)
        openErrorDetail(
          rec.error_code,
          detailFor(rec),
          dkProviderLabel(rec),
        );
      return;
    }
  });
  dom.dkTableWrap.addEventListener("change", onDkCheckChange);

  // Dead key bulk-delete confirm
  dom.dkConfirmOk.addEventListener("click", confirmDeleteDeadKeys);
  dom.dkConfirmCancel.addEventListener("click", closeDkConfirm);
  dom.dkConfirmOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "dkconfirm") closeDkConfirm();
  });

  // Error detail modal
  dom.errDetailClose.addEventListener("click", closeErrorDetail);
  dom.errDetailOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "errdetail") closeErrorDetail();
  });

  // Settings modal
  dom.settingsBtn.addEventListener("click", () => {
    openSettings();
    toggleMobileMenu(false);
  });
  dom.settingsCancel.addEventListener("click", closeSettings);
  dom.settingsSave.addEventListener("click", saveSettings);
  dom.testDiscordBtn.addEventListener("click", testDiscordWebhook);
  dom.settingsOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "settings") closeSettings();
  });

  // Sample modal
  dom.sampleClose.addEventListener("click", closeSample);
  dom.sampleOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "sample") closeSample();
  });

  // Global modal keyboard handling: Esc closes topmost modal; Tab stays trapped inside
  const MODAL_CLOSE_MAP = new Map([
    [dom.editorOverlay, closeEditor],
    [dom.settingsOverlay, closeSettings],
    [dom.sampleOverlay, closeSample],
    [dom.dkConfirmOverlay, closeDkConfirm],
    [dom.errDetailOverlay, closeErrorDetail],
  ]);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeCustomSelect) {
      e.preventDefault();
      closeOpenCustomSelect({ restoreFocus: true });
      return;
    }
    const activeOverlay = topOpenModal();
    if (!activeOverlay) return;
    if (e.key === "Escape") {
      const closeFn = MODAL_CLOSE_MAP.get(activeOverlay);
      if (closeFn) closeFn();
      return;
    }
    if (e.key === "Tab") {
      const items = modalFocusableElements(activeOverlay);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !activeOverlay.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last || !activeOverlay.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────
async function initApp() {
  // Apply current theme icon
  applyTheme(getTheme());
  // Load config tab (default)
  await loadConfig();
}

async function bootstrap() {
  bindEvents();
  applyTheme(getTheme());

  if (MOCK) {
    // Skip auth in mock mode
    state.signedIn = true;
    dom.authOverlay.classList.remove("active");
    document.documentElement.classList.remove("has-token");
    await initApp();
    return;
  }

  if (localStorage.getItem(SIGNED_IN_HINT) !== "1") {
    document.documentElement.classList.remove("has-token");
    return;
  }

  // The hint says there was a session; only the server knows if the cookie is
  // still valid, so probe it. A 401 here is handled by api() → sessionEnded().
  try {
    await api("/api/settings", { auth: true });
    markSignedIn();
    dom.authOverlay.classList.remove("active");
    await initApp();
  } catch (err) {
    // Also covers a network failure, where sessionEnded() has not run yet — the
    // pre-paint hider must come off either way or the page stays blank.
    sessionEnded();
    dom.authError.textContent =
      err.message === "Unauthorized"
        ? "登入已过期，请重新输入密码"
        : `连线失败：${err.message}`;
  }
}

bootstrap();
