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

// ── State ────────────────────────────────────────────────────────────────
const state = {
  signedIn: false,
  settings: null,
  fpCache: new Map(), // api_base + provider_type -> sha256 fingerprint
  selectedProviders: new Set(), // indices of currently selected provider cards
  deadKeys: [], // dead key records loaded from /api/dead-keys
  deadKeysLoaded: false,
  dkSelectMode: false, // bulk-selection mode active on dead keys tab
  dkSelected: new Set(), // set of dead key record ids checked in the table
  dkPendingDelete: null, // snapshot of ids currently being confirmed for deletion
  dkSort: { col: "index", dir: "asc" },
  editorSnapshot: null, // key textarea content when the delete confirmation appeared
  editorPendingRemoved: null, // keys shown in the current confirmation
  editorSortMode: "none",
  editorSortOrigin: "",
  proxy: null,
  proxySelected: null,
  proxyBusy: false,
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
  configSaveOk: $("config-save-ok"),

  // results tab
  refreshBtn: $("refresh-results-btn"),
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
  edGatewayProvider: $("ed-gateway-provider"),
  edKeysHighlight: $("ed-keys-highlight"),
  edKeysSearch: $("ed-keys-search"),
  edKeysSearchClear: $("ed-keys-search-clear"),
  edSortKeysBtn: $("ed-sort-keys-btn"),
  edExportKeysBtn: $("ed-export-keys-btn"),
  editorConfirm: $("editor-confirm"),
  editorConfirmMsg: $("editor-confirm-msg"),
  editorConfirmList: $("editor-confirm-list"),
  editorConfirmOk: $("editor-confirm-ok"),
  editorConfirmCancel: $("editor-confirm-cancel"),

  // app settings modal
  settingsOverlay: $("settings-overlay"),
  settingsCancel: $("settings-cancel-btn"),
  settingsSave: $("settings-save-btn"),
  settingsError: $("settings-error"),
  settingsOk: $("settings-ok"),
  setGithubUrl: $("set-github-url"),
  setDiscordUrl: $("set-discord-url"),
  testDiscordBtn: $("test-discord-btn"),

  // sample modal
  sampleOverlay: $("sample-overlay"),
  sampleClose: $("sample-close-btn"),
  sampleTitle: $("sample-title"),
  sampleSubtitle: $("sample-subtitle"),
  sampleContent: $("sample-content"),

  // dead keys tab
  dkRefreshBtn: $("dk-refresh-btn"),
  dkHost: $("dk-host"),
  dkKey: $("dk-key"),
  dkExpired: $("dk-expired"),
  dkAddBtn: $("dk-add-btn"),
  dkBulkDelBtn: $("dk-bulk-del-btn"),
  dkFilterToggle: $("dk-filter-toggle"),
  dkFilterCount: $("dk-filter-count"),
  dkFilterPanel: $("dk-filter-panel"),
  dkFHost: $("dk-f-host"),
  dkFKey: $("dk-f-key"),
  dkFCode: $("dk-f-code"),
  dkFFrom: $("dk-f-from"),
  dkFTo: $("dk-f-to"),
  dkFReset: $("dk-f-reset"),
  dkFormError: $("dk-form-error"),
  dkLoading: $("dk-loading"),
  dkError: $("dk-error"),
  dkEmpty: $("dk-empty"),
  dkTableWrap: $("dk-table-wrap"),

  // dead key editor modal
  dkEditOverlay: $("dkedit-overlay"),
  dkEditId: $("dkedit-id"),
  dkEditSave: $("dkedit-save-btn"),
  dkEditCancel: $("dkedit-cancel-btn"),
  dkEditError: $("dkedit-error"),
  dkeHost: $("dke-host"),
  dkeKey: $("dke-key"),
  dkeExpired: $("dke-expired"),
  dkeCode: $("dke-code"),

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
  errDetailTitle: $("errdetail-title"),
  errDetailSubtitle: $("errdetail-subtitle"),
  errDetailContent: $("errdetail-content"),

  // proxy tab
  proxyRefreshBtn: $("proxy-refresh-btn"),
  proxyNotice: $("proxy-notice"),
  proxyLoading: $("proxy-loading"),
  proxyError: $("proxy-error"),
  proxyEmpty: $("proxy-empty"),
  proxyKeyEmpty: $("proxy-key-empty"),
  proxyToolbar: $("proxy-toolbar"),
  proxyProvider: $("proxy-provider"),
  proxySummary: $("proxy-summary"),
  proxyUrl: $("proxy-url"),
  proxyCopyUrl: $("proxy-copy-url"),
  proxySample: $("proxy-sample"),
  proxyTestModel: $("proxy-test-model"),
  proxySaveModel: $("proxy-save-model"),
  proxyTestAll: $("proxy-test-all"),
  proxyTestActive: $("proxy-test-active"),
  proxyTestDisabled: $("proxy-test-disabled"),
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

/** Head/tail mask for keys. Keep this function in sync with the identically
 *  named one in `_worker.js` (same threshold, same separators): a 9-character
 *  key would otherwise reveal 8 of its 9 characters (4+4). */
function maskKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length < 16) return `${s.slice(0, 1)}***${s.slice(-1)}`;
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
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
const SORT_LABELS = { none: "预设", asc: "A→Z", desc: "Z→A" };

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
  state.deadKeysLoaded = false;
  sessionEnded();
  dom.authInput.value = "";
}

// ── UI Helpers ────────────────────────────────────────────────────────────
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

// ── Settings modal ────────────────────────────────────────────────────────
function openSettings() {
  const s = state.settings || {};
  dom.setGithubUrl.value = s.github_url || "";
  dom.setDiscordUrl.value = s.discord_webhook_url || "";
  dom.settingsError.textContent = "";
  dom.settingsOk.classList.add("hidden");
  dom.settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  dom.settingsOverlay.classList.add("hidden");
}

async function saveSettings() {
  dom.settingsError.textContent = "";
  dom.settingsOk.classList.add("hidden");
  dom.settingsSave.disabled = true;
  const patch = {
    github_url: dom.setGithubUrl.value.trim(),
    discord_webhook_url: dom.setDiscordUrl.value.trim(),
  };
  try {
    // Send only the two fields this modal owns: a full-object write from here
    // would carry a possibly stale provider list along with it.
    const version = await postSettings(patch);
    const current = state.settings || {};
    state.settings = { ...current, ...patch };
    if (version !== undefined) state.settings.version = version;
    applySettingsToUI();
    closeSettings();
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
  if (s.github_url) dom.runNowBtn.href = s.github_url;
}

// ── Config tab ─────────────────────────────────────────────────────────────
async function loadConfig() {
  dom.configLoading.classList.remove("hidden");
  dom.configError.classList.add("hidden");
  dom.providerGrid.classList.add("hidden");
  dom.providerEmpty.classList.add("hidden");

  try {
    let data;
    if (MOCK) {
      const mock = await getMock();
      data = { settings: mock.settings };
    } else {
      data = await api("/api/settings", { auth: true });
    }
    state.settings = data.settings || {};
    applySettingsToUI();
    renderProviderGrid();
  } catch (err) {
    dom.configError.textContent = `读取失败：${err.message}`;
    dom.configError.classList.remove("hidden");
  } finally {
    dom.configLoading.classList.add("hidden");
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

  dom.providerGrid
    .querySelectorAll("[data-edit]")
    .forEach((btn) =>
      btn.addEventListener("click", () => openEditor(Number(btn.dataset.edit))),
    );
  dom.providerGrid
    .querySelectorAll("[data-delete]")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        deleteProvider(Number(btn.dataset.delete)),
      ),
    );
  dom.providerGrid
    .querySelectorAll("[data-select]")
    .forEach((cb) =>
      cb.addEventListener("change", () =>
        toggleSelection(Number(cb.dataset.select)),
      ),
    );
  updateBulkBtnState();
}

function renderProviderCard(p, index) {
  const host = extractHost(p.api_base);
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
          <span class="badge${isEnabled ? "" : " badge-warn"}">${isEnabled ? esc(p.provider_type) : "已停用"}</span>
          ${!isEnabled ? `<span class="badge badge-spaced">${esc(p.provider_type)}</span>` : ""}
        </div>
        <div class="provider-card-actions">
          <button class="btn btn-secondary btn-sm" data-edit="${index}" type="button">编辑</button>
          <button class="btn btn-danger btn-sm" data-delete="${index}" type="button">删除</button>
        </div>
      </div>
      <div class="provider-card-host" title="${escAttr(p.api_base)}">${esc(host)}</div>
      <div class="provider-card-meta">
        <span><strong>${keyCount}</strong> 个 Key</span>
        <span><strong>${modelCount}</strong> 个模型</span>
        ${p.max_concurrency != null ? `<span>并发: <strong>${p.max_concurrency}</strong></span>` : ""}
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

function hideEditorConfirm() {
  dom.editorConfirm.classList.add("hidden");
  dom.editorConfirmMsg.textContent = "";
  dom.editorConfirmList.replaceChildren();
  state.editorPendingRemoved = null;
}

function showEditorConfirm(removed) {
  dom.editorConfirmMsg.textContent = `即将删除 ${removed.length} 支密钥；确认后才会储存。`;
  dom.editorConfirmList.replaceChildren();
  for (const key of removed) {
    const li = document.createElement("li");
    li.textContent = maskKey(key);
    dom.editorConfirmList.appendChild(li);
  }
  dom.editorConfirm.classList.remove("hidden");
  dom.editorConfirmOk.focus();
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
  dom.edSortKeysBtn.textContent = `排序：${SORT_LABELS[state.editorSortMode]}`;
  syncLineNums(dom.edKeys);
  syncKeysHighlight();
}

function exportEditorKeys() {
  const keys = splitKeyLines(dom.edKeys.value);
  if (!keys.length) {
    dom.editorError.textContent = "没有可导出的密钥";
    return;
  }
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
    dom.edApiBase.value = p.api_base || "";
    dom.edKeys.value = p.keys || "";
    dom.edModels.value = p.models || "";
    dom.edExtraBody.value = p.extra_body || "";
    dom.edAlias.value = p.alias || "";
    dom.edGatewayProvider.value = p.gateway_provider || "";
    renderEditorHeaders(p.custom_headers);
    dom.edMaxConcurrency.value =
      p.max_concurrency != null ? String(p.max_concurrency) : "";
  } else {
    dom.editorTitle.textContent = "新增服务商";
    dom.edProviderType.value = "openai";
    dom.edApiBase.value = "";
    dom.edKeys.value = "";
    dom.edModels.value = "";
    dom.edExtraBody.value = "";
    dom.edAlias.value = "";
    dom.edGatewayProvider.value = "";
    renderEditorHeaders([]);
    dom.edMaxConcurrency.value = "";
  }
  dom.edExtraBodyStatus.textContent = "";
  dom.edExtraBodyStatus.className = "json-status";
  state.editorSortMode = "none";
  dom.edSortKeysBtn.textContent = "排序：预设";
  // A query left over from the last time the editor was open would paint marks
  // on a provider the user never searched in.
  if (dom.edKeysSearch) dom.edKeysSearch.value = "";
  syncSearchClearButton();
  hideEditorConfirm();
  state.editorSnapshot = dom.edKeys.value;
  dom.editorOverlay.classList.remove("hidden");
  dom.edApiBase.focus();
  // Sync line numbers after values are populated
  syncLineNums(dom.edKeys);
  syncLineNums(dom.edModels);
  syncLineNums(dom.edExtraBody);
  syncKeysHighlight();
}

function closeEditor() {
  dom.editorOverlay.classList.add("hidden");
}

async function saveEditor(confirmed = false) {
  dom.editorError.textContent = "";
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

  if (!apiBase) {
    dom.editorError.textContent = "请填写 API Base URL";
    return;
  }
  if (!keys.trim()) {
    dom.editorError.textContent = "请填写至少一个 API Key";
    return;
  }
  if (!models.trim()) {
    dom.editorError.textContent = "请填写至少一个模型名";
    return;
  }
  if (extraBodyRaw) {
    try {
      JSON.parse(extraBodyRaw);
    } catch {
      dom.editorError.textContent = "Extra Body 不是有效的 JSON";
      return;
    }
  }
  if (invalidHeaders.length) {
    dom.editorError.textContent = `请求头名称不合法: ${invalidHeaders[0]}`;
    return;
  }

  let maxConcurrency = null;
  if (maxConcurrencyRaw !== "") {
    const n = parseInt(maxConcurrencyRaw, 10);
    if (!Number.isInteger(n) || n < 1) {
      dom.editorError.textContent = "Max Concurrency 必须是正整数";
      return;
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
  const gatewayProvider = dom.edGatewayProvider.value.trim();
  // Omit empty proxy fields so a provider that never used forwarding keeps the
  // exact shape it had before this feature existed.
  if (alias) entry.alias = alias;
  if (gatewayProvider) entry.gateway_provider = gatewayProvider;

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
      state.editorPendingRemoved = removed.length ? removed : null;
      if (removed.length) {
        showEditorConfirm(removed);
        return;
      }
    }
  }
  state.editorPendingRemoved = null;
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
    hideEditorConfirm();
    state.editorSnapshot = null;
    state.editorSortMode = "none";
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

  const settings = state.settings || {};
  const providers = (settings.providers || []).filter((_, i) => i !== index);

  try {
    const version = await postSettings({ providers });
    state.settings = { ...settings, providers };
    if (version !== undefined) state.settings.version = version;
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
  const settings = state.settings || {};
  const providers = (settings.providers || []).map((p, i) =>
    state.selectedProviders.has(i) ? { ...p, enabled: enable } : p,
  );
  try {
    const version = await postSettings({ providers });
    state.settings = { ...settings, providers };
    if (version !== undefined) state.settings.version = version;
    state.selectedProviders.clear();
    renderProviderGrid();
  } catch (err) {
    dom.configSaveError.textContent = err.message;
  }
}

// ── Proxy tab (rotation / forwarding) ──────────────────────────────────────
function selectedProxyProvider() {
  const providers = (state.proxy && state.proxy.providers) || [];
  return providers.find((p) => p.fp === state.proxySelected) || providers[0] || null;
}

async function loadProxyState() {
  dom.proxyLoading.classList.remove("hidden");
  dom.proxyError.classList.add("hidden");
  dom.proxyEmpty.classList.add("hidden");
  dom.proxyKeyEmpty.classList.add("hidden");
  dom.proxyToolbar.classList.add("hidden");
  dom.proxyKeyGrid.classList.add("hidden");
  dom.proxyNotice.classList.add("hidden");

  try {
    let data;
    if (MOCK) {
      const mock = await getMock();
      data = mockProxyState(mock.settings || {});
    } else {
      data = await api("/api/proxy/state", { auth: true });
    }
    state.proxy = data;
    const providers = data.providers || [];
    if (!providers.some((p) => p.fp === state.proxySelected)) {
      state.proxySelected = providers[0] ? providers[0].fp : null;
    }
    renderProxyState(data);
  } catch (err) {
    dom.proxyError.textContent = `读取失败：${err.message}`;
    dom.proxyError.classList.remove("hidden");
  } finally {
    dom.proxyLoading.classList.add("hidden");
  }
}

function mockProxyState(settings) {
  const providers = (settings.providers || []).map((p, i) => {
    const keys = splitKeyLines(p.keys);
    return {
      fp: `mock-${i}`,
      alias: p.alias || "",
      host: extractHost(p.api_base),
      provider_type: p.provider_type || "openai",
      enabled: p.enabled !== false,
      via_gateway: false,
      gateway_provider: p.gateway_provider || "",
      proxy_url: p.alias ? `/proxy/${p.alias}` : "",
      sample_path:
        ({ gemini: "/models/{model}:generateContent", anthropic: "/messages" })[
          p.provider_type
        ] || "/chat/completions",
      test_model: "",
      logs_url: "",
      keys_total: keys.length,
      keys_available: keys.length,
      keys: keys.map((key, ki) => ({
        id: i * 100 + ki + 1,
        masked: maskKey(key),
        disabled: false,
        fail_count: 0,
        last_used_at: null,
        synced: true,
      })),
    };
  });
  return {
    ok: true,
    backend: "d1",
    proxy_enabled: true,
    proxy_message: "",
    gateway_ready: false,
    logs_url_template: "",
    providers,
  };
}

function proxyTimeLabel(ms) {
  if (!ms) return "从未";
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function renderProxyState(data) {
  const providers = data.providers || [];
  if (!data.proxy_enabled) {
    dom.proxyNotice.textContent = data.proxy_message || "转发功能目前停用";
    dom.proxyNotice.className = "alert alert-error";
    dom.proxyNotice.classList.remove("hidden");
  }
  if (!providers.length) {
    dom.proxyEmpty.classList.remove("hidden");
    dom.proxyToolbar.classList.add("hidden");
    dom.proxyKeyGrid.classList.add("hidden");
    dom.proxyKeyEmpty.classList.add("hidden");
    return;
  }

  dom.proxyProvider.replaceChildren();
  for (const p of providers) {
    const opt = document.createElement("option");
    opt.value = p.fp;
    opt.textContent = `${p.alias || "（未设别名）"} · ${p.host} · ${p.provider_type}`;
    if (p.fp === state.proxySelected) opt.selected = true;
    dom.proxyProvider.appendChild(opt);
  }

  dom.proxyEmpty.classList.add("hidden");
  dom.proxyToolbar.classList.remove("hidden");
  renderProxyToolbar();
  renderProxyKeyCards();
}

function renderProxyToolbar() {
  const p = selectedProxyProvider();
  if (!p) return;
  const enabled =
    !!(state.proxy && state.proxy.proxy_enabled) && p.enabled !== false;
  const url = p.alias ? `${location.origin}${p.proxy_url}` : "";

  const available = Number(p.keys_available || 0);
  dom.proxySummary.textContent = `可用 ${available} / ${Number(p.keys_total || 0)}`;
  // Colour the one number on this row that means "nothing will be served".
  dom.proxySummary.className =
    "proxy-summary" + (available ? "" : " proxy-summary--empty");
  dom.proxyUrl.textContent = url || "（尚未设定转发别名）";
  dom.proxyCopyUrl.dataset.copyVal = url;
  dom.proxyCopyUrl.disabled = !url;
  dom.proxySample.textContent = p.alias
    ? `范例路径：${p.sample_path}`
    : "未设别名：请到「来源设定」编辑这个服务商";
  dom.proxyTestModel.value = p.test_model || "";
  dom.proxySaveModel.disabled = !enabled;

  const hasKeys = (p.keys || []).some((k) => k.id != null);
  const canTest = enabled && hasKeys && !!p.test_model;
  for (const btn of [
    dom.proxyTestAll,
    dom.proxyTestActive,
    dom.proxyTestDisabled,
  ]) {
    btn.disabled = !canTest;
    btn.title = !p.test_model ? "请先填写并保存测试模型" : "";
  }

  if (p.logs_url) {
    dom.proxyLogs.href = p.logs_url;
    dom.proxyLogs.removeAttribute("aria-disabled");
    dom.proxyLogs.title = "打开 AI Gateway 日志（已按服务商过滤）";
  } else {
    dom.proxyLogs.removeAttribute("href");
    dom.proxyLogs.setAttribute("aria-disabled", "true");
    dom.proxyLogs.title = "部署设定 AI_GATEWAY_LOGS_URL 后可用";
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
  const canAct = enabled && !!p.test_model;
  dom.proxyKeyGrid.innerHTML = keys
    .map((k) => {
      const id = k.id == null ? "" : String(k.id);
      const mask = esc(k.masked || "");
      // Green / amber, the same pairing .provider-card uses for 启用 / 停用,
      // so "正常" stops looking like an unknown state.
      const badge = k.disabled
        ? `<span class="badge badge-warn">已禁用</span>`
        : `<span class="badge badge-ok">正常</span>`;
      const recover = k.disabled
        ? `<button class="btn btn-secondary btn-sm" type="button" data-proxy-recover="${escAttr(id)}" data-fp="${escAttr(p.fp)}"${enabled && id ? "" : " disabled"}>恢复</button>`
        : "";
      return `
        <article class="proxy-key-card${k.disabled ? " proxy-key-card--disabled" : ""}" data-key-id="${escAttr(id)}">
          <div class="proxy-key-card-head">
            <code class="proxy-key-mask" title="${mask}">${mask}</code>
            ${badge}
          </div>
          <div class="proxy-key-card-meta">
            <span>连续失败 <strong>${Number(k.fail_count || 0)}</strong></span>
            <span>最近使用 ${esc(proxyTimeLabel(k.last_used_at))}</span>
          </div>
          <div class="proxy-key-card-actions">
            <button class="btn btn-secondary btn-sm" type="button" data-proxy-test="${escAttr(id)}" data-fp="${escAttr(p.fp)}"${canAct && id ? "" : " disabled"}>测试</button>
            ${recover}
          </div>
          <div class="proxy-test-result" data-proxy-result="${escAttr(id)}"></div>
        </article>`;
    })
    .join("");
  dom.proxyKeyGrid.classList.remove("hidden");
}

function renderProxyTestResult(id, result) {
  if (id == null) return;
  const el = dom.proxyKeyGrid.querySelector(`[data-proxy-result="${id}"]`);
  if (!el) return;
  if (result && result.ok) {
    el.textContent = `可用 · ${result.ms} ms · ${result.model || ""}`;
    el.className = "proxy-test-result ok";
    return;
  }
  const detail = result && result.error ? ` · ${truncate(result.error, 90)}` : "";
  const charged =
    result && result.disabled
      ? " · 已达门槛，已禁用"
      : result && typeof result.fail_count === "number"
        ? ` · 连续失败 ${result.fail_count} 次`
        : "";
  el.textContent = `不可用 · HTTP ${result && result.status ? result.status : "—"}${detail}${charged}`;
  el.className = "proxy-test-result fail";
}

/** Returns the result object so the batch loop can count it. */
async function testProxyKey(fp, id) {
  const el = dom.proxyKeyGrid.querySelector(`[data-proxy-result="${id}"]`);
  if (el) {
    el.textContent = "测试中...";
    el.className = "proxy-test-result";
  }
  let result;
  try {
    if (MOCK) {
      result = { ok: true, status: 200, ms: 123, model: "mock" };
    } else {
      result = await api("/api/proxy/test", {
        method: "POST",
        auth: true,
        body: { fp, id: Number(id) },
      });
    }
    renderProxyTestResult(id, result);
  } catch (err) {
    result = { ok: false, status: err.status || 0, error: err.message };
    renderProxyTestResult(id, result);
  }
  if (result && result.disabled) {
    await loadProxyState();
    dom.proxyNotice.className = "alert alert-error";
    dom.proxyNotice.textContent = `这把密钥已达门槛并被禁用（连续失败 ${result.fail_count} 次）。`;
    dom.proxyNotice.classList.remove("hidden");
  }
  return result;
}

function proxyActionButtons() {
  return [
    dom.proxyTestAll,
    dom.proxyTestActive,
    dom.proxyTestDisabled,
    dom.proxySaveModel,
  ];
}

async function runProxyBatch(mode) {
  if (state.proxyBusy) return;
  const p = selectedProxyProvider();
  if (!p) return;
  const keys = (p.keys || []).filter((k) => {
    if (k.id == null) return false;
    if (mode === "active") return !k.disabled;
    if (mode === "disabled") return k.disabled;
    return true;
  });
  if (!keys.length) {
    dom.proxyNotice.className = "alert alert-info";
    dom.proxyNotice.textContent = "没有符合这个条件的密钥。";
    dom.proxyNotice.classList.remove("hidden");
    return;
  }

  state.proxyBusy = true;
  proxyActionButtons().forEach((b) => {
    b.disabled = true;
  });
  dom.proxyNotice.className = "alert alert-info";
  dom.proxyNotice.classList.remove("hidden");

  let ok = 0;
  let fail = 0;
  try {
    for (let i = 0; i < keys.length; i++) {
      dom.proxyNotice.textContent = `批量测试中：${i + 1} / ${keys.length}（可用 ${ok}，不可用 ${fail}）`;
      const result = await testProxyKey(p.fp, keys[i].id);
      if (result && result.ok) ok++;
      else fail++;
    }
  } finally {
    // Reset even if something throws: otherwise the buttons stay disabled forever.
    state.proxyBusy = false;
  }

  await loadProxyState();
  dom.proxyNotice.className = "alert alert-info";
  dom.proxyNotice.textContent = `批量测试完成：共 ${keys.length} 把，可用 ${ok}，不可用 ${fail}。`;
  dom.proxyNotice.classList.remove("hidden");
}

async function saveProxyTestModel() {
  if (state.proxyBusy) return;
  const p = selectedProxyProvider();
  if (!p) return;
  const model = dom.proxyTestModel.value.trim();
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
    }
    renderProxyToolbar();
    renderProxyKeyCards();
    dom.proxySaveModel.textContent = "已保存";
    setTimeout(() => {
      dom.proxySaveModel.textContent = "保存模型";
    }, 1200);
  } catch (err) {
    dom.proxyNotice.className = "alert alert-error";
    dom.proxyNotice.textContent = `保存失败：${err.message}`;
    dom.proxyNotice.classList.remove("hidden");
  } finally {
    dom.proxySaveModel.disabled = false;
  }
}

async function recoverProxyKey(fp, id) {
  if (!confirm("恢复这把密钥？恢复后会重新参与轮用。")) return;
  try {
    if (!MOCK) {
      await api("/api/proxy/recover", {
        method: "POST",
        auth: true,
        body: { fp, id: Number(id) },
      });
    }
    await loadProxyState();
  } catch (err) {
    dom.proxyError.textContent = `恢复失败：${err.message}`;
    dom.proxyError.classList.remove("hidden");
  }
}

// ── Results tab ────────────────────────────────────────────────────────────
async function loadResults() {
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
        state.settings = mock.settings;
      } else {
        const d = await api("/api/settings", { auth: true });
        state.settings = d.settings || {};
        applySettingsToUI();
      }
    }

    const providers = state.settings.providers || [];
    if (!providers.length) {
      dom.resultsEmpty.classList.remove("hidden");
      return;
    }

    // Fetch results + checkpoints per provider in parallel
    const bundles = await Promise.all(
      providers.map(async (p) => {
        const payload = fingerprintPayload(p);
        let fp = state.fpCache.get(payload);
        if (!fp) {
          fp = await sha256(payload);
          state.fpCache.set(payload, fp);
        }
        const host = extractHost(p.api_base);

        let resultData = { exists: false };
        let checkpointData = { exists: false };

        if (MOCK) {
          const mock = await getMock();
          resultData = (mock.results || {})[host] || { exists: false };
          checkpointData = (mock.checkpoints || {})[host] || { exists: false };
        } else {
          [resultData, checkpointData] = await Promise.all([
            api(`/api/results?fp=${encodeURIComponent(fp)}`, {
              auth: true,
            }).catch(() => ({ exists: false })),
            api(`/api/checkpoint?fp=${encodeURIComponent(fp)}`, {
              auth: true,
            }).catch(() => ({ exists: false })),
          ]);
        }
        return { provider: p, fp, host, resultData, checkpointData };
      }),
    );

    const hasAny = bundles.some(
      (b) =>
        b.resultData.exists ||
        hasUsableCheckpoint(b.resultData, b.checkpointData),
    );
    if (!hasAny) {
      dom.resultsEmpty.classList.remove("hidden");
      return;
    }

    // Sort: executing (has usable checkpoint) first
    bundles.sort((a, b) => {
      const aExec = hasUsableCheckpoint(a.resultData, a.checkpointData) ? 1 : 0;
      const bExec = hasUsableCheckpoint(b.resultData, b.checkpointData) ? 1 : 0;
      return bExec - aExec;
    });

    dom.resultsBody.innerHTML = bundles.map(renderProviderResult).join("");
    // Seed line numbers in result copy blocks
    dom.resultsBody
      .querySelectorAll(".result-lined-editor textarea")
      .forEach(function (textarea) {
        syncLineNums(textarea);
      });
    // Keyboard support for result-group-header (click handled by delegation)
    dom.resultsBody.querySelectorAll(".result-group-header").forEach((h) => {
      h.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          h.click();
        }
      });
    });
    // Bind inv-group toggles
    dom.resultsBody.querySelectorAll(".inv-group-header").forEach((h) => {
      const toggle = (e) => {
        if (e && e.target.closest("button")) return;
        const g = h.closest(".inv-group");
        const open = g.classList.toggle("open");
        h.setAttribute("aria-expanded", String(open));
      };
      h.addEventListener("click", toggle);
      h.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle(e);
        }
      });
    });
    dom.resultsBody.classList.remove("hidden");
  } catch (err) {
    dom.resultsError.textContent = `读取失败：${err.message}`;
    dom.resultsError.classList.remove("hidden");
  } finally {
    dom.resultsLoading.classList.add("hidden");
  }
}

function renderProviderResult({ provider, host, resultData, checkpointData }) {
  const hasResult = resultData.exists;
  const hasCheckpoint = hasUsableCheckpoint(resultData, checkpointData);
  const r = hasResult ? resultData.results : null;

  const uploadedAt = r?.uploaded_at
    ? `上次更新：${fmtDateTime(r.uploaded_at)}`
    : "";

  const checkpointHtml = hasCheckpoint
    ? renderCheckpointBar(checkpointData.checkpoint || checkpointData)
    : "";

  const bodyHtml = hasResult
    ? renderResultBody(r)
    : `<p class="muted empty-note">尚无测试结果。</p>`;

  return `
    <div class="result-group">
      <div class="result-group-header" tabindex="0" role="button" aria-expanded="false">
        <div class="rgh-main">
          <div class="rgh-top">
            <span class="badge">${esc(provider.provider_type)}</span>
            ${hasCheckpoint ? `<span class="badge badge-warn">⏳ 执行中</span>` : ""}
            <span class="rgh-arrow">▼</span>
          </div>
          <div class="rgh-host" title="${esc(provider.api_base)}">${esc(host)}</div>
          ${uploadedAt ? `<div class="rgh-time muted">${esc(uploadedAt)}</div>` : ""}
        </div>
      </div>
      ${checkpointHtml}
      <div class="result-group-body">
        ${bodyHtml}
      </div>
    </div>
  `;
}

function hasUsableCheckpoint(resultData, checkpointData) {
  if (!checkpointData.exists) return false;
  if (!resultData.exists) return true;

  const r = resultData.results;
  if (!r?.uploaded_at) return true;

  const ck = checkpointData.checkpoint || checkpointData;
  const ckTime = ck?.saved_at ? new Date(ck.saved_at).getTime() : 0;
  const resTime = new Date(r.uploaded_at).getTime();
  if (!Number.isFinite(resTime)) return true;
  if (!Number.isFinite(ckTime) || ckTime <= 0) return false;
  return ckTime >= resTime;
}

function renderCheckpointBar(ck) {
  const completed = ck.completed_tasks ?? 0;
  const total = ck.total_tasks ?? 0;
  const deadCount = Array.isArray(ck.dead_keys) ? ck.dead_keys.length : 0;
  const savedAt = ck.saved_at ? fmtTime(ck.saved_at) : "-";
  return `
    <div class="checkpoint-bar">
      <span class="checkpoint-bar-label">⏳ 进行中</span>
      <span class="checkpoint-bar-meta">进度：${completed} / ${total} 任务</span>
      <span class="checkpoint-bar-meta">已判死 Key：${deadCount} 个</span>
      <span class="checkpoint-bar-meta">最后存档：${esc(savedAt)}</span>
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
        <button class="btn btn-secondary btn-sm copy-btn" data-copy-val="${escAttr(validKeys.join("\n"))}" type="button">一键复制</button>
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
        <button class="btn btn-secondary btn-sm copy-btn" data-copy-val="${escAttr(provenModels.join(","))}" type="button">一键复制</button>
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
      const ttft = p.avg_ttft != null ? `${p.avg_ttft}s` : "-";
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
      <td data-value="${p.avg_ttft ?? ""}" class="na">${esc(ttft)}</td>
      <td data-value="${p.avg_total ?? ""}" class="na">${esc(total)}</td>
      <td data-value="${p.timeout_rate ?? ""}">${toRate}</td>
      <td data-value="${p.has_thinking_ratio ?? ""}" class="na">${esc(thinkRatio)}</td>
      <td data-value="${p.answer_verified === true ? 1 : 0}">${answerVerified}</td>
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
          <th data-sort="avg_ttft">avg TTFT <span class="sort-indicator"></span></th>
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
        <button class="btn btn-secondary btn-sm copy-btn" data-copy-val="${escAttr(keysToCopy)}" type="button">一键复制</button>
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
  dom.errDetailOverlay.classList.remove("hidden");
}

function closeErrorDetail() {
  dom.errDetailOverlay.classList.add("hidden");
}

// ── Dead keys tab ─────────────────────────────────────────────────────────
/** Hosts in the order the providers appear in 来源设定 — not alphabetical, so the
 *  dropdowns and the table read in the same order as the config and results tabs. */
function providerHosts() {
  const hosts = [];
  for (const p of ((state.settings || {}).providers || [])) {
    const host = extractHost(p.api_base);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** Host dropdowns always mirror state.settings.providers, plus any host already
 *  recorded in dead_keys (a provider may have been deleted after the fact). */
function fillHostSelect(select, { includeAll = false, selected = "" } = {}) {
  const list = providerHosts();
  for (const r of state.deadKeys) {
    if (r?.provider_host && !list.includes(r.provider_host)) list.push(r.provider_host);
  }

  const opts = [];
  if (includeAll) opts.push(`<option value="">全部域名</option>`);
  else if (!list.length) opts.push(`<option value="">（尚无服务商）</option>`);
  for (const h of list) opts.push(`<option value="${escAttr(h)}">${esc(h)}</option>`);
  select.innerHTML = opts.join("");
  if (selected && list.includes(selected)) select.value = selected;
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
}

function dkDateOf(rec) {
  const v = rec && typeof rec.expired_at === "string" ? rec.expired_at : "";
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "";
}

/** A record whose error_detail was nulled by dedup borrows the one stored on the
 *  first record of its host + code group, so 📋 always shows something. */
function detailFor(rec) {
  if (rec.error_detail) return rec.error_detail;
  const twin = state.deadKeys.find(
    (r) =>
      r &&
      r.error_detail &&
      r.provider_host === rec.provider_host &&
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
  dom.dkError.classList.add("hidden");
  dom.dkFormError.textContent = "";
  // Default to today so the native picker shows a real date instead of the
  // browser's own locale placeholder. Only on (re)load — doing it in
  // renderDeadKeys would refill the field on every filter keystroke, undoing a
  // date the user just cleared to type a different one.
  if (!dom.dkExpired.value) dom.dkExpired.value = todayISO();

  if (state.deadKeysLoaded && !force) {
    renderDeadKeys();
    return;
  }

  exitDkSelectMode();

  dom.dkLoading.classList.remove("hidden");
  dom.dkEmpty.classList.add("hidden");
  dom.dkTableWrap.classList.add("hidden");

  try {
    if (!state.settings) {
      if (MOCK) {
        state.settings = (await getMock()).settings;
      } else {
        const d = await api("/api/settings", { auth: true });
        state.settings = d.settings || {};
        applySettingsToUI();
      }
    }

    if (MOCK) {
      const mock = await getMock();
      state.deadKeys = Array.isArray(mock.dead_keys) ? mock.dead_keys : [];
    } else {
      const d = await api("/api/dead-keys", { auth: true });
      state.deadKeys = Array.isArray(d.dead_keys) ? d.dead_keys : [];
    }
    state.deadKeysLoaded = true;
    renderDeadKeys();
  } catch (err) {
    dom.dkError.textContent = `读取失败：${err.message}`;
    dom.dkError.classList.remove("hidden");
  } finally {
    dom.dkLoading.classList.add("hidden");
  }
}

function filteredDeadKeys() {
  const host = dom.dkFHost.value;
  const q = dom.dkFKey.value.trim().toLowerCase();
  const code = dom.dkFCode.value;
  const from = dom.dkFFrom.value;
  const to = dom.dkFTo.value;
  // One bound alone stays open-ended; the same day twice narrows to that day.
  const swap = from && to && from > to;
  const lo = swap ? to : from;
  const hi = swap ? from : to;

  return state.deadKeys.filter((r) => {
    if (!r) return false;
    if (host && r.provider_host !== host) return false;
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

/** Order rows by provider order (hosts whose provider is gone go last), keeping
 *  the stored order within each host so the newest entries stay at the bottom. */
function sortByProviderOrder(rows) {
  const order = providerHosts();
  const rank = (host) => {
    const i = order.indexOf(host);
    return i === -1 ? order.length : i;
  };
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.provider_host) - rank(b.r.provider_host) || a.i - b.i)
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
    return String(a.provider_host || "").localeCompare(String(b.provider_host || ""));
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

function activeFilterCount() {
  return [
    dom.dkFHost.value,
    dom.dkFKey.value.trim(),
    dom.dkFCode.value,
    dom.dkFFrom.value,
    dom.dkFTo.value,
  ].filter(Boolean).length;
}

function renderDeadKeys() {
  fillHostSelect(dom.dkHost, { selected: dom.dkHost.value });
  fillHostSelect(dom.dkFHost, { includeAll: true, selected: dom.dkFHost.value });
  fillCodeSelect();

  const n = activeFilterCount();
  dom.dkFilterCount.textContent = String(n);
  dom.dkFilterCount.classList.toggle("hidden", n === 0);

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
      <td class="dk-host-col"><span class="dk-host-cell" title="${escAttr(r.provider_host || "")}">${esc(r.provider_host || "")}</span></td>
      <td class="dk-key-col"><div class="dk-key-line"><code class="dk-key-cell" title="${escAttr(r.api_key || "")}">${esc(r.api_key || "")}</code>${copyKeyBtn}</div></td>
      <td class="dk-date-col dk-date-cell">${esc(dkDateOf(r) || "-")}</td>
      <td class="dk-code-col">${r.error_code != null ? esc(r.error_code) : `<span class="na">-</span>`}</td>
      <td class="dk-msg-col"><div class="dk-msg-line">${detailBtn}${preview}</div></td>
      <td class="dk-edit-col dk-actions">
        <button class="btn btn-secondary btn-xs" type="button" title="编辑" aria-label="编辑" data-dk-edit="${escAttr(r.id)}">✏️</button>
      </td>
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
          ${dkSortHead("host", "域名供应商", "dk-host-col")}
          ${dkSortHead("key", "KEY", "dk-key-col")}
          ${dkSortHead("expired_at", "失效时间", "dk-date-col")}
          ${dkSortHead("code", "Code", "dk-code-col")}
          <th class="dk-msg-col">错误讯息</th>
          <th class="dk-edit-col">编辑</th>
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

function toIsoDay(dateStr) {
  return dateStr ? `${dateStr}T00:00:00.000Z` : null;
}

async function addDeadKey() {
  dom.dkFormError.textContent = "";
  const provider_host = dom.dkHost.value.trim();
  const api_key = dom.dkKey.value.trim();
  if (!provider_host) {
    dom.dkFormError.textContent = "请先在「来源设定」新增服务商，或选择域名";
    return;
  }
  if (!api_key) {
    dom.dkFormError.textContent = "请输入 API Key";
    return;
  }

  const payload = {
    provider_host,
    api_key,
    expired_at: toIsoDay(dom.dkExpired.value),
  };

  dom.dkAddBtn.disabled = true;
  try {
    if (MOCK) {
      if (state.deadKeys.some((r) => r && r.api_key === api_key)) {
        throw new Error("api_key already recorded");
      }
      state.deadKeys.push({
        id: crypto.randomUUID(),
        ...payload,
        error_code: null,
        error_detail: null,
        created_at: new Date().toISOString(),
      });
    } else {
      const d = await api("/api/dead-keys", {
        method: "POST",
        auth: true,
        body: payload,
      });
      if (d.record) state.deadKeys.push(d.record);
    }
    dom.dkKey.value = "";
    dom.dkExpired.value = todayISO();
    renderDeadKeys();
  } catch (err) {
    dom.dkFormError.textContent =
      err.message === "api_key already recorded"
        ? "此 Key 已记录过，保留最早的那一笔"
        : err.message;
  } finally {
    dom.dkAddBtn.disabled = false;
  }
}

function openDkEdit(id) {
  const rec = state.deadKeys.find((r) => r && r.id === id);
  if (!rec) return;
  dom.dkEditId.value = id;
  dom.dkEditError.textContent = "";
  fillHostSelect(dom.dkeHost, { selected: rec.provider_host || "" });
  dom.dkeKey.value = rec.api_key || "";
  // Records auto-created before expired_at existed have no date; default to today
  // so the field shows a real value instead of the browser's locale placeholder.
  dom.dkeExpired.value = dkDateOf(rec) || todayISO();
  dom.dkeCode.value = rec.error_code != null ? String(rec.error_code) : "";
  dom.dkEditOverlay.classList.remove("hidden");
  dom.dkeKey.focus();
}

function closeDkEdit() {
  dom.dkEditOverlay.classList.add("hidden");
}

async function saveDkEdit() {
  const id = dom.dkEditId.value;
  const rec = state.deadKeys.find((r) => r && r.id === id);
  if (!rec) return closeDkEdit();

  dom.dkEditError.textContent = "";
  const api_key = dom.dkeKey.value.trim();
  if (!api_key) {
    dom.dkEditError.textContent = "请输入 API Key";
    return;
  }
  const codeRaw = dom.dkeCode.value.trim();
  const patch = {
    provider_host: dom.dkeHost.value.trim() || rec.provider_host,
    api_key,
    expired_at: toIsoDay(dom.dkeExpired.value),
    error_code: codeRaw === "" ? null : Number(codeRaw),
  };

  dom.dkEditSave.disabled = true;
  try {
    if (MOCK) {
      if (state.deadKeys.some((r) => r && r.id !== id && r.api_key === api_key)) {
        throw new Error("api_key already recorded");
      }
      Object.assign(rec, patch);
    } else {
      const d = await api(`/api/dead-keys?id=${encodeURIComponent(id)}`, {
        method: "PUT",
        auth: true,
        body: patch,
      });
      if (d.record) Object.assign(rec, d.record);
    }
    renderDeadKeys();
    closeDkEdit();
  } catch (err) {
    dom.dkEditError.textContent =
      err.message === "api_key already recorded"
        ? "此 Key 已存在于其他记录"
        : err.message;
  } finally {
    dom.dkEditSave.disabled = false;
  }
}

function removeDeadKeysLocal(ids) {
  const idSet = new Set(ids);
  const removed = state.deadKeys.filter((r) => r && idSet.has(r.id));
  const next = state.deadKeys.filter((r) => !r || !idSet.has(r.id));
  for (const gone of removed) {
    if (!gone.error_detail) continue;
    if (
      next.some(
        (r) =>
          r &&
          r.error_detail &&
          r.provider_host === gone.provider_host &&
          (r.error_code ?? null) === (gone.error_code ?? null),
      )
    ) {
      continue;
    }
    const heir = next.find(
      (r) =>
        r &&
        !r.error_detail &&
        r.provider_host === gone.provider_host &&
        (r.error_code ?? null) === (gone.error_code ?? null),
    );
    if (heir) heir.error_detail = gone.error_detail;
  }
  state.deadKeys = next;
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
      <span class="dk-confirm-key">${esc(r.api_key || "")}</span>
      <span class="dk-confirm-host">${esc(r.provider_host || "")}</span>
    </li>`,
    )
    .join("");
  if (dom.dkConfirmError) dom.dkConfirmError.textContent = "";
  dom.dkConfirmOverlay.classList.remove("hidden");
  dom.dkConfirmOk.focus();
}

function closeDkConfirm() {
  state.dkPendingDelete = null;
  dom.dkConfirmOverlay.classList.add("hidden");
  if (dom.dkConfirmError) dom.dkConfirmError.textContent = "";
  if (dom.dkBulkDelBtn) dom.dkBulkDelBtn.focus();
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
  dom.sampleOverlay.classList.remove("hidden");
}
function closeSample() {
  dom.sampleOverlay.classList.add("hidden");
}

// ── Copy ──────────────────────────────────────────────────────────────────
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
    if (!btn) return;
    const isIconOnly =
      btn.classList.contains("btn-icon") || !btn.textContent.trim();
    if (isIconOnly) {
      const origHtml = btn.innerHTML;
      btn.innerHTML = CHECK_ICON_SVG;
      btn.classList.add("copied");
      btn.disabled = true;
      setTimeout(() => {
        btn.innerHTML = origHtml;
        btn.classList.remove("copied");
        btn.disabled = false;
      }, 1500);
    } else {
      const orig = btn.textContent;
      btn.textContent = "已复制!";
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = orig;
        btn.disabled = false;
      }, 1500);
    }
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

function fmtTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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
  dom.edAddHeaderBtn.addEventListener("click", () => {
    const row = createHeaderRow();
    dom.edHeadersContainer.appendChild(row);
    row.querySelector("[data-header-key]")?.focus();
  });
  dom.editorSave.addEventListener("click", () => saveEditor());
  dom.editorCancel.addEventListener("click", closeEditor);

  // Key tools: three-state sort, export, delete confirmation. Finding a key is
  // the orange occurrence highlight in the textarea, bound in bindKeysHighlight.
  dom.edSortKeysBtn.addEventListener("click", cycleEditorSort);
  dom.edExportKeysBtn.addEventListener("click", exportEditorKeys);
  dom.editorConfirmOk.addEventListener("click", () => saveEditor(true));
  dom.editorConfirmCancel.addEventListener("click", () => {
    if (state.editorSnapshot !== null) {
      dom.edKeys.value = state.editorSnapshot;
      syncLineNums(dom.edKeys);
    }
    hideEditorConfirm();
    syncKeysHighlight();
  });
  dom.editorOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "editor") closeEditor();
  });

  // Proxy tab
  dom.proxyRefreshBtn.addEventListener("click", loadProxyState);
  dom.proxyProvider.addEventListener("change", () => {
    state.proxySelected = dom.proxyProvider.value;
    dom.proxyNotice.classList.add("hidden");
    renderProxyToolbar();
    renderProxyKeyCards();
  });
  dom.proxyCopyUrl.addEventListener("click", () =>
    copyText(dom.proxyCopyUrl.dataset.copyVal || "", dom.proxyCopyUrl),
  );
  dom.proxySaveModel.addEventListener("click", saveProxyTestModel);
  dom.proxyTestModel.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveProxyTestModel();
    }
  });
  dom.proxyTestAll.addEventListener("click", () => runProxyBatch("all"));
  dom.proxyTestActive.addEventListener("click", () => runProxyBatch("active"));
  dom.proxyTestDisabled.addEventListener("click", () => runProxyBatch("disabled"));
  dom.proxyKeyGrid.addEventListener("click", (e) => {
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

  // Results
  dom.refreshBtn.addEventListener("click", loadResults);

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

  // Result group open — delegated
  dom.resultsBody.addEventListener("click", (e) => {
    const header = e.target.closest(".result-group-header");
    if (header) {
      const g = header.closest(".result-group");
      const open = g.classList.toggle("open");
      header.setAttribute("aria-expanded", String(open));
      const arrow = header.querySelector(".rgh-arrow");
      if (arrow) arrow.style.transform = open ? "rotate(180deg)" : "";
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
        const parsed = parseFloat(raw);
        const val = isModel ? raw : isNaN(parsed) ? -Infinity : parsed;
        return { row, val };
      });

      pairs.sort((a, b) => {
        if (a.val < b.val) return newDir === "asc" ? -1 : 1;
        if (a.val > b.val) return newDir === "asc" ? 1 : -1;
        return 0;
      });

      const frag = document.createDocumentFragment();
      pairs.forEach((p) => frag.appendChild(p.row));
      tbody.appendChild(frag);
    }

    const copyBtn = e.target.closest(".copy-btn");
    if (copyBtn) copyText(copyBtn.dataset.copyVal || "", copyBtn);

    const sampleBtn = e.target.closest("[data-sample]");
    if (sampleBtn) {
      const payload = JSON.parse(sampleBtn.dataset.sample);
      openSample(payload.model, payload.sample);
    }

    const errBtn = e.target.closest("[data-errdetail]");
    if (errBtn) {
      e.stopPropagation();
      const payload = JSON.parse(errBtn.dataset.errdetail);
      openErrorDetail(payload.error_code, payload.error_detail);
    }
  });

  // Dead keys tab
  dom.dkRefreshBtn.addEventListener("click", () => loadDeadKeys(true));
  dom.dkAddBtn.addEventListener("click", addDeadKey);
  dom.dkBulkDelBtn.addEventListener("click", onDkBulkDelClick);
  dom.dkKey.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addDeadKey();
  });
  dom.dkFilterToggle.addEventListener("click", () => {
    const open = dom.dkFilterPanel.classList.toggle("hidden") === false;
    dom.dkFilterToggle.setAttribute("aria-expanded", String(open));
  });
  [dom.dkFHost, dom.dkFCode, dom.dkFFrom, dom.dkFTo].forEach((el) =>
    el.addEventListener("change", renderDeadKeys),
  );
  dom.dkFKey.addEventListener("input", renderDeadKeys);
  dom.dkFReset.addEventListener("click", () => {
    dom.dkFHost.value = "";
    dom.dkFKey.value = "";
    dom.dkFCode.value = "";
    dom.dkFFrom.value = "";
    dom.dkFTo.value = "";
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
        openErrorDetail(rec.error_code, detailFor(rec), rec.provider_host || "");
      return;
    }
    const editBtn = e.target.closest("[data-dk-edit]");
    if (editBtn) return openDkEdit(editBtn.dataset.dkEdit);
  });
  dom.dkTableWrap.addEventListener("change", onDkCheckChange);

  // Dead key editor modal
  dom.dkEditSave.addEventListener("click", saveDkEdit);
  dom.dkEditCancel.addEventListener("click", closeDkEdit);
  dom.dkEditOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "dkedit") closeDkEdit();
  });

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

  // Esc closes any open modal
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!dom.editorOverlay.classList.contains("hidden")) closeEditor();
    if (!dom.settingsOverlay.classList.contains("hidden")) closeSettings();
    if (!dom.sampleOverlay.classList.contains("hidden")) closeSample();
    if (!dom.dkEditOverlay.classList.contains("hidden")) closeDkEdit();
    if (!dom.dkConfirmOverlay.classList.contains("hidden")) closeDkConfirm();
    if (!dom.errDetailOverlay.classList.contains("hidden")) closeErrorDetail();
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
