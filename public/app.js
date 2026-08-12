// ── Mock mode ────────────────────────────────────────────────────────────
// Append ?mock to the URL to load /mock.json instead of hitting the API.
// Example: http://localhost:8788/?mock
const MOCK = new URLSearchParams(location.search).has("mock");

// Lazily-loaded mock data (fetched once, cached here)
let _mockData = null;
async function getMock() {
  if (!_mockData) _mockData = await fetch("/mock.json").then((r) => r.json());
  return _mockData;
}

// ── State ────────────────────────────────────────────────────────────────
const state = {
  token: "",
  settings: null,
  fpCache: new Map(), // api_base + provider_type -> sha256 fingerprint
  selectedProviders: new Set(), // indices of currently selected provider cards
  deadKeys: [], // dead key records loaded from /api/dead-keys
  deadKeysLoaded: false,
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
  edMaxConcurrency: $("ed-max-concurrency"),

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
  dkFilterToggle: $("dk-filter-toggle"),
  dkFilterCount: $("dk-filter-count"),
  dkFilterPanel: $("dk-filter-panel"),
  dkFHost: $("dk-f-host"),
  dkFKey: $("dk-f-key"),
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

  // error detail modal
  errDetailOverlay: $("errdetail-overlay"),
  errDetailClose: $("errdetail-close-btn"),
  errDetailTitle: $("errdetail-title"),
  errDetailSubtitle: $("errdetail-subtitle"),
  errDetailContent: $("errdetail-content"),
};

// ── API ──────────────────────────────────────────────────────────────────
async function api(path, { method = "GET", auth = false, body } = {}) {
  const headers = {};
  if (auth) headers["Authorization"] = `Bearer ${state.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
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
async function login() {
  const tok = dom.authInput.value.trim();
  if (!tok) {
    dom.authError.textContent = "请输入密码";
    return;
  }
  dom.authError.textContent = "";
  dom.authBtn.disabled = true;
  state.token = tok;
  try {
    await api("/api/settings", { auth: true });
    localStorage.setItem("atk_token", tok);
    dom.authOverlay.classList.remove("active");
    dom.authInput.value = "";
    document.documentElement.classList.remove("has-token");
    await initApp();
  } catch (err) {
    state.token = "";
    localStorage.removeItem("atk_token");
    dom.authError.textContent =
      err.message === "Unauthorized" ? "密码错误" : `认证失败：${err.message}`;
  } finally {
    dom.authBtn.disabled = false;
  }
}

function logout() {
  state.token = "";
  localStorage.removeItem("atk_token");
  dom.authOverlay.classList.add("active");
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
    // Merge into existing settings and save
    const current = state.settings || {};
    if (!MOCK) {
      await api("/api/settings", {
        method: "POST",
        auth: true,
        body: { ...current, ...patch },
      });
    }
    state.settings = { ...current, ...patch };
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
        <div style="flex:1;min-width:0">
          <span class="badge${isEnabled ? "" : " badge-warn"}">${isEnabled ? esc(p.provider_type) : "已停用"}</span>
          ${!isEnabled ? `<span class="badge" style="margin-left:.25rem">${esc(p.provider_type)}</span>` : ""}
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
    dom.edMaxConcurrency.value =
      p.max_concurrency != null ? String(p.max_concurrency) : "";
  } else {
    dom.editorTitle.textContent = "新增服务商";
    dom.edProviderType.value = "openai";
    dom.edApiBase.value = "";
    dom.edKeys.value = "";
    dom.edModels.value = "";
    dom.edExtraBody.value = "";
    dom.edMaxConcurrency.value = "";
  }
  dom.edExtraBodyStatus.textContent = "";
  dom.edExtraBodyStatus.className = "json-status";
  dom.editorOverlay.classList.remove("hidden");
  dom.edApiBase.focus();
  // Sync line numbers after values are populated
  syncLineNums(dom.edKeys);
  syncLineNums(dom.edModels);
  syncLineNums(dom.edExtraBody);
}

function closeEditor() {
  dom.editorOverlay.classList.add("hidden");
}

async function saveEditor() {
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
  const maxConcurrencyRaw = dom.edMaxConcurrency.value.trim();

  // Update UI immediately so the user sees the cleaned up data if they reopen
  dom.edKeys.value = keys;
  dom.edModels.value = models;
  syncLineNums(dom.edKeys);
  syncLineNums(dom.edModels);

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
    max_concurrency: maxConcurrency,
  };
  const settings = state.settings || {};
  const providers = [...(settings.providers || [])];

  if (index >= 0) {
    providers[index] = entry;
  } else {
    providers.push(entry);
  }

  dom.editorSave.disabled = true;
  try {
    if (!MOCK) {
      await api("/api/settings", {
        method: "POST",
        auth: true,
        body: { ...settings, providers },
      });
    }
    state.settings = { ...settings, providers };
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
    if (!MOCK) {
      await api("/api/settings", {
        method: "POST",
        auth: true,
        body: { ...settings, providers },
      });
    }
    state.settings = { ...settings, providers };
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
    if (!MOCK) {
      await api("/api/settings", {
        method: "POST",
        auth: true,
        body: { ...settings, providers },
      });
    }
    state.settings = { ...settings, providers };
    state.selectedProviders.clear();
    renderProviderGrid();
  } catch (err) {
    dom.configSaveError.textContent = err.message;
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
            api(`/api/results?fp=${encodeURIComponent(fp)}`).catch(() => ({
              exists: false,
            })),
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
    ? `上次更新：${new Date(r.uploaded_at).toLocaleString()}`
    : "";

  const checkpointHtml = hasCheckpoint
    ? renderCheckpointBar(checkpointData.checkpoint || checkpointData)
    : "";

  const bodyHtml = hasResult
    ? renderResultBody(r)
    : `<p class="muted" style="padding:1rem 0">尚无测试结果。</p>`;

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
  const savedAt = ck.saved_at
    ? new Date(ck.saved_at).toLocaleTimeString()
    : "-";
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
        .map(
          (rec) => `<div class="inv-key-item">
        <span class="inv-key-mono">${esc(rec.api_key || "")}</span>
      </div>`,
        )
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
function providerHosts() {
  const hosts = ((state.settings || {}).providers || [])
    .map((p) => extractHost(p.api_base))
    .filter(Boolean);
  return Array.from(new Set(hosts)).sort();
}

/** Host dropdowns always mirror state.settings.providers, plus any host already
 *  recorded in dead_keys (a provider may have been deleted after the fact). */
function fillHostSelect(select, { includeAll = false, selected = "" } = {}) {
  const hosts = new Set(providerHosts());
  for (const r of state.deadKeys) if (r?.provider_host) hosts.add(r.provider_host);
  const list = Array.from(hosts).sort();

  const opts = [];
  if (includeAll) opts.push(`<option value="">全部域名</option>`);
  else if (!list.length) opts.push(`<option value="">（尚无服务商）</option>`);
  for (const h of list) opts.push(`<option value="${escAttr(h)}">${esc(h)}</option>`);
  select.innerHTML = opts.join("");
  if (selected && list.includes(selected)) select.value = selected;
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

  if (state.deadKeysLoaded && !force) {
    renderDeadKeys();
    return;
  }

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
    if (lo || hi) {
      const d = dkDateOf(r);
      if (!d) return false;
      if (lo && d < lo) return false;
      if (hi && d > hi) return false;
    }
    return true;
  });
}

function activeFilterCount() {
  return [
    dom.dkFHost.value,
    dom.dkFKey.value.trim(),
    dom.dkFFrom.value,
    dom.dkFTo.value,
  ].filter(Boolean).length;
}

function renderDeadKeys() {
  fillHostSelect(dom.dkHost, { selected: dom.dkHost.value });
  fillHostSelect(dom.dkFHost, { includeAll: true, selected: dom.dkFHost.value });

  const n = activeFilterCount();
  dom.dkFilterCount.textContent = String(n);
  dom.dkFilterCount.classList.toggle("hidden", n === 0);

  const rows = filteredDeadKeys();
  if (!rows.length) {
    dom.dkEmpty.textContent = state.deadKeys.length
      ? "没有符合筛选条件的记录。"
      : "尚无失效密钥记录。";
    dom.dkEmpty.classList.remove("hidden");
    dom.dkTableWrap.classList.add("hidden");
    return;
  }
  dom.dkEmpty.classList.add("hidden");
  dom.dkTableWrap.innerHTML = renderDeadKeysTable(rows);
  dom.dkTableWrap.classList.remove("hidden");
}

function renderDeadKeysTable(rows) {
  const body = rows
    .map((r) => {
      const detail = detailFor(r);
      const msg = detailMessage(detail);
      const detailBtn = detail
        ? `<button class="btn btn-ghost btn-xs" type="button" title="查看错误详情" aria-label="查看错误详情" data-dk-detail="${escAttr(r.id)}">📋</button>`
        : `<span class="na">-</span>`;
      const preview = msg
        ? `<span class="dk-msg" title="${escAttr(msg)}">${esc(truncate(msg))}</span>`
        : "";
      return `<tr>
      <td><span class="dk-host-cell" title="${escAttr(r.provider_host || "")}">${esc(r.provider_host || "")}</span></td>
      <td><code class="dk-key-cell" title="${escAttr(r.api_key || "")}">${esc(r.api_key || "")}</code></td>
      <td class="dk-date-cell">${esc(dkDateOf(r) || "-")}</td>
      <td>${r.error_code != null ? esc(r.error_code) : `<span class="na">-</span>`}</td>
      <td><div class="dk-msg-line">${detailBtn}${preview}</div></td>
      <td class="dk-actions">
        <button class="btn btn-secondary btn-xs" type="button" title="编辑" aria-label="编辑" data-dk-edit="${escAttr(r.id)}">✏️</button>
        <button class="btn btn-danger btn-xs" type="button" title="删除" aria-label="删除" data-dk-del="${escAttr(r.id)}">🗑️</button>
      </td>
    </tr>`;
    })
    .join("");

  return `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          <th>域名供应商</th>
          <th>KEY</th>
          <th>失效时间</th>
          <th>Code</th>
          <th>错误讯息</th>
          <th>操作</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
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
    dom.dkExpired.value = "";
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
  dom.dkeExpired.value = dkDateOf(rec);
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

async function deleteDeadKey(id) {
  const rec = state.deadKeys.find((r) => r && r.id === id);
  if (!rec || !confirm(`确定删除 ${rec.api_key} ？`)) return;
  try {
    if (MOCK) {
      state.deadKeys = state.deadKeys.filter((r) => r && r.id !== id);
      renderDeadKeys();
    } else {
      await api(`/api/dead-keys?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        auth: true,
      });
      // Deleting may hand the group's error_detail over to another record server-side.
      await loadDeadKeys(true);
    }
  } catch (err) {
    dom.dkError.textContent = `删除失败：${err.message}`;
    dom.dkError.classList.remove("hidden");
  }
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
function copyText(text, btn) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const orig = btn.textContent;
      btn.textContent = "已复制!";
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = orig;
        btn.disabled = false;
      }, 1500);
    })
    .catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    });
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
  dom.editorSave.addEventListener("click", saveEditor);
  dom.editorCancel.addEventListener("click", closeEditor);
  dom.editorOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "editor") closeEditor();
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
  dom.dkKey.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addDeadKey();
  });
  dom.dkFilterToggle.addEventListener("click", () => {
    const open = dom.dkFilterPanel.classList.toggle("hidden") === false;
    dom.dkFilterToggle.setAttribute("aria-expanded", String(open));
  });
  [dom.dkFHost, dom.dkFFrom, dom.dkFTo].forEach((el) =>
    el.addEventListener("change", renderDeadKeys),
  );
  dom.dkFKey.addEventListener("input", renderDeadKeys);
  dom.dkFReset.addEventListener("click", () => {
    dom.dkFHost.value = "";
    dom.dkFKey.value = "";
    dom.dkFFrom.value = "";
    dom.dkFTo.value = "";
    renderDeadKeys();
  });
  dom.dkTableWrap.addEventListener("click", (e) => {
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
    const delBtn = e.target.closest("[data-dk-del]");
    if (delBtn) deleteDeadKey(delBtn.dataset.dkDel);
  });

  // Dead key editor modal
  dom.dkEditSave.addEventListener("click", saveDkEdit);
  dom.dkEditCancel.addEventListener("click", closeDkEdit);
  dom.dkEditOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "dkedit") closeDkEdit();
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
    state.token = "mock";
    dom.authOverlay.classList.remove("active");
    document.documentElement.classList.remove("has-token");
    await initApp();
    return;
  }

  const saved = localStorage.getItem("atk_token") || "";
  if (saved) {
    state.token = saved;
    try {
      await api("/api/settings", { auth: true });
      dom.authOverlay.classList.remove("active");
      document.documentElement.classList.remove("has-token");
      await initApp();
    } catch {
      state.token = "";
      localStorage.removeItem("atk_token");
      document.documentElement.classList.remove("has-token");
      dom.authError.textContent = "登入已过期，请重新输入密码";
    }
  } else {
    document.documentElement.classList.remove("has-token");
  }
}

bootstrap();
