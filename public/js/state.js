// Split from the original app.js; loaded in original order (see index.html).
// ── State ────────────────────────────────────────────────────────────────
const state = {
  signedIn: false,
  settings: null,
  storageBackend: "d1",
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
  proxyTabBtn: document.querySelector('.tab-btn[data-tab="proxy"]'),
  tabProxy: $("tab-proxy"),

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
  settingsProxyFields: $("settings-proxy-fields"),
  settingsCancel: $("settings-cancel-btn"),
  settingsSave: $("settings-save-btn"),
  settingsError: $("settings-error"),
  settingsOk: $("settings-ok"),
  setGithubUrl: $("set-github-url"),
  setDiscordUrl: $("set-discord-url"),
  setProxyPassword: $("set-proxy-password"),
  setProxyPasswordToggle: $("set-proxy-password-toggle"),
  setProxyPasswordCopy: $("set-proxy-password-copy"),
  setGatewayLogsUrl: $("set-gateway-logs-url"),
  setGatewayToken: $("set-gateway-token"),
  setGatewayTokenToggle: $("set-gateway-token-toggle"),
  setGatewayTokenCopy: $("set-gateway-token-copy"),
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
function isKvStorageMode() {
  return state.storageBackend === "kv";
}

function applyFetchedSettings(payload) {
  state.settings = payload?.settings || {};
  state.storageBackend =
    payload?.storage_backend || state.storageBackend || "d1";
  applySettingsToUI();
}

async function reloadSettingsFromServer() {
  const d = await api("/api/settings", { auth: true });
  applyFetchedSettings(d);
  state.selectedProviders.clear();
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
