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
};

// ── DOM ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const dom = {
  authOverlay:  $("auth-overlay"),
  authInput:    $("auth-input"),
  authBtn:      $("auth-btn"),
  authError:    $("auth-error"),

  topbarMenu:   $("topbar-menu"),
  mobileMenuBtn:$("mobile-menu-btn"),
  mobileMenuClose:$("mobile-menu-close"),
  topbarMenuBackdrop:$("topbar-menu-backdrop"),
  runNowBtn:    $("run-now-btn"),
  settingsBtn:  $("settings-btn"),
  themeToggle:  $("theme-toggle"),
  logoutBtn:    $("logout-btn"),

  tabBtns:   Array.from(document.querySelectorAll(".tab-btn")),
  tabPanels: Array.from(document.querySelectorAll(".tab-panel")),

  // config tab
  configLoading:   $("config-loading"),
  configError:     $("config-error"),
  providerGrid:    $("provider-grid"),
  providerEmpty:   $("provider-empty"),
  addProviderBtn:  $("add-provider-btn"),
  configSaveError: $("config-save-error"),
  configSaveOk:    $("config-save-ok"),

  // results tab
  refreshBtn:       $("refresh-results-btn"),
  resultsTs:        $("results-timestamp"),
  resultsLoading:   $("results-loading"),
  resultsError:     $("results-error"),
  resultsEmpty:     $("results-empty"),
  resultsBody:      $("results-body"),

  // provider editor modal
  editorOverlay:    $("editor-overlay"),
  editorTitle:      $("editor-title"),
  editorIndex:      $("editor-index"),
  editorSave:       $("editor-save-btn"),
  editorCancel:     $("editor-cancel-btn"),
  editorError:      $("editor-error"),
  edProviderType:   $("ed-provider-type"),
  edApiBase:        $("ed-api-base"),
  edKeys:           $("ed-keys"),
  edModels:         $("ed-models"),

  // app settings modal
  settingsOverlay:  $("settings-overlay"),
  settingsCancel:   $("settings-cancel-btn"),
  settingsSave:     $("settings-save-btn"),
  settingsError:    $("settings-error"),
  settingsOk:       $("settings-ok"),
  setGithubUrl:     $("set-github-url"),
  setDiscordUrl:    $("set-discord-url"),
  testDiscordBtn:   $("test-discord-btn"),

  // sample modal
  sampleOverlay:    $("sample-overlay"),
  sampleClose:      $("sample-close-btn"),
  sampleTitle:      $("sample-title"),
  sampleSubtitle:   $("sample-subtitle"),
  sampleContent:    $("sample-content"),
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
function syncLineNums(textarea) {
  const editor = textarea.closest(".lined-editor");
  if (!editor) return;
  const nums = editor.querySelector(".line-nums");
  if (!nums) return;
  const lines = textarea.value.split("\n").length;
  nums.innerHTML = Array.from({ length: lines }, (_, i) =>
    `<span>${i + 1}</span>`
  ).join("");
  nums.scrollTop = textarea.scrollTop;
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
  try { localStorage.setItem("atk_theme", theme); } catch {}
}

function toggleTheme() {
  applyTheme(getTheme() === "dark" ? "light" : "dark");
}

// ── Auth ─────────────────────────────────────────────────────────────────
async function login() {
  const tok = dom.authInput.value.trim();
  if (!tok) { dom.authError.textContent = "请输入密码"; return; }
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
  const open = typeof force === "boolean" ? force : !dom.topbarMenu.classList.contains("open");
  dom.topbarMenu.classList.toggle("open", open);
  dom.topbarMenuBackdrop.classList.toggle("open", open);
  dom.mobileMenuBtn.setAttribute("aria-expanded", String(open));
}

// ── Tabs ──────────────────────────────────────────────────────────────────
function switchTab(name) {
  dom.tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  dom.tabPanels.forEach((p) => {
    const active = p.id === `tab-${name}`;
    p.classList.toggle("active", active);
    p.classList.toggle("hidden", !active);
  });
  if (name === "results") loadResults();
  if (name === "config") loadConfig();
  
  // Close mobile menu if open
  toggleMobileMenu(false);
}

// ── Settings modal ────────────────────────────────────────────────────────
function openSettings() {
  const s = state.settings || {};
  dom.setGithubUrl.value  = s.github_url || "";
  dom.setDiscordUrl.value = s.discord_webhook_url || "";
  dom.settingsError.textContent = "";
  dom.settingsOk.classList.add("hidden");
  dom.settingsOverlay.classList.remove("hidden");
}

function closeSettings() { dom.settingsOverlay.classList.add("hidden"); }

async function saveSettings() {
  dom.settingsError.textContent = "";
  dom.settingsOk.classList.add("hidden");
  dom.settingsSave.disabled = true;
  const patch = {
    github_url:          dom.setGithubUrl.value.trim(),
    discord_webhook_url: dom.setDiscordUrl.value.trim(),
  };
  try {
    // Merge into existing settings and save
    const current = state.settings || {};
    if (!MOCK) {
      await api("/api/settings", {
        method: "POST", auth: true,
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
      body: JSON.stringify({ content: "🔔 **API Key Tester**：这是一条测试通知。如果您看到此消息，表示 Webhook 已成功连线！" })
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

function renderProviderGrid() {
  const providers = (state.settings || {}).providers || [];
  if (!providers.length) {
    dom.providerEmpty.classList.remove("hidden");
    dom.providerGrid.classList.add("hidden");
    return;
  }
  dom.providerGrid.innerHTML = providers.map((p, i) => renderProviderCard(p, i)).join("");
  dom.providerGrid.classList.remove("hidden");
  dom.providerEmpty.classList.add("hidden");

  dom.providerGrid.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => openEditor(Number(btn.dataset.edit)))
  );
  dom.providerGrid.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", () => deleteProvider(Number(btn.dataset.delete)))
  );
}

function renderProviderCard(p, index) {
  const host = extractHost(p.api_base);
  const keyCount   = (p.keys || "").split("\n").filter((l) => l.trim()).length;
  const modelCount = (p.models || "").split(",").filter((m) => m.trim()).length;
  return `
    <div class="provider-card">
      <div class="provider-card-header">
        <div style="flex:1;min-width:0">
          <div style="margin-bottom:.35rem">
            <span class="badge">${esc(p.provider_type)}</span>
          </div>
          <div class="provider-card-host" title="${esc(p.api_base)}">${esc(host)}</div>
        </div>
        <div class="provider-card-actions">
          <button class="btn btn-secondary btn-sm" data-edit="${index}" type="button">编辑</button>
          <button class="btn btn-danger btn-sm" data-delete="${index}" type="button">删除</button>
        </div>
      </div>
      <div class="provider-card-meta">
        <span><strong>${keyCount}</strong> 个 Key</span>
        <span><strong>${modelCount}</strong> 个模型</span>
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
    dom.edApiBase.value      = p.api_base || "";
    dom.edKeys.value         = p.keys || "";
    dom.edModels.value       = p.models || "";
  } else {
    dom.editorTitle.textContent = "新增服务商";
    dom.edProviderType.value = "openai";
    dom.edApiBase.value = "";
    dom.edKeys.value    = "";
    dom.edModels.value  = "";
  }
  dom.editorOverlay.classList.remove("hidden");
  dom.edApiBase.focus();
  // Sync line numbers after values are populated
  syncLineNums(dom.edKeys);
  syncLineNums(dom.edModels);
}

function closeEditor() { dom.editorOverlay.classList.add("hidden"); }

async function saveEditor() {
  dom.editorError.textContent = "";
  const index    = Number(dom.editorIndex.value);
  const apiBase  = dom.edApiBase.value.trim().replace(/\/+$/, "");
  const keys     = normalizeKeys(dom.edKeys.value);
  const models   = normalizeModels(dom.edModels.value);
  const pType    = dom.edProviderType.value;

  // Update UI immediately so the user sees the cleaned up data if they reopen
  dom.edKeys.value = keys;
  dom.edModels.value = models;
  syncLineNums(dom.edKeys);
  syncLineNums(dom.edModels);

  if (!apiBase) { dom.editorError.textContent = "请填写 API Base URL"; return; }
  if (!keys.trim()) { dom.editorError.textContent = "请填写至少一个 API Key"; return; }
  if (!models.trim()) { dom.editorError.textContent = "请填写至少一个模型名"; return; }

  const entry = { provider_type: pType, api_base: apiBase, keys, models };
  const settings = state.settings || {};
  const providers = [...((settings.providers) || [])];

  if (index >= 0) {
    providers[index] = entry;
  } else {
    providers.push(entry);
  }

  dom.editorSave.disabled = true;
  try {
    if (!MOCK) {
      await api("/api/settings", {
        method: "POST", auth: true,
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
  if (!p || !confirm(`确定删除 ${extractHost(p.api_base)} (${p.provider_type}) ？`)) return;

  const settings  = state.settings || {};
  const providers = ((settings.providers) || []).filter((_, i) => i !== index);

  try {
    if (!MOCK) {
      await api("/api/settings", { method: "POST", auth: true, body: { ...settings, providers } });
    }
    state.settings = { ...settings, providers };
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

    const providers = (state.settings.providers) || [];
    if (!providers.length) {
      dom.resultsEmpty.classList.remove("hidden");
      return;
    }

    // Fetch results + checkpoints per provider in parallel
    const bundles = await Promise.all(providers.map(async (p) => {
      const fp = await sha256(fingerprintPayload(p));
      const host = extractHost(p.api_base);

      let resultData = { exists: false };
      let checkpointData = { exists: false };

      if (MOCK) {
        const mock = await getMock();
        resultData     = (mock.results     || {})[host] || { exists: false };
        checkpointData = (mock.checkpoints || {})[host] || { exists: false };
      } else {
        [resultData, checkpointData] = await Promise.all([
          api(`/api/results?fp=${encodeURIComponent(fp)}`).catch(() => ({ exists: false })),
          api(`/api/checkpoint?fp=${encodeURIComponent(fp)}`, { auth: true }).catch(() => ({ exists: false })),
        ]);
      }
      return { provider: p, fp, host, resultData, checkpointData };
    }));

    const hasAny = bundles.some((b) => b.resultData.exists || b.checkpointData.exists);
    if (!hasAny) {
      dom.resultsEmpty.classList.remove("hidden");
      return;
    }

    // Sort: executing (has checkpoint) first
    bundles.sort((a, b) => {
      const aExec = a.checkpointData.exists ? 1 : 0;
      const bExec = b.checkpointData.exists ? 1 : 0;
      return bExec - aExec;
    });

    dom.resultsBody.innerHTML = bundles.map(renderProviderResult).join("");
    // Seed line numbers in result copy blocks (readonly, one-time)
    dom.resultsBody.querySelectorAll(".result-lined-editor textarea").forEach(syncLineNums);
    // Keyboard support for result-group-header (click handled by delegation)
    dom.resultsBody.querySelectorAll(".result-group-header").forEach((h) => {
      h.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); h.click(); }
      });
    });
    // Bind inv-group toggles
    dom.resultsBody.querySelectorAll(".inv-group-header").forEach((h) => {
      const toggle = () => {
        const g = h.closest(".inv-group");
        const open = g.classList.toggle("open");
        h.setAttribute("aria-expanded", String(open));
      };
      h.addEventListener("click", toggle);
      h.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
    // Bind sample buttons
    dom.resultsBody.querySelectorAll("[data-sample]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const payload = JSON.parse(btn.dataset.sample);
        openSample(payload.model, payload.sample);
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
  const hasResult     = resultData.exists;
  const hasCheckpoint = checkpointData.exists;
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

function renderCheckpointBar(ck) {
  const completed = ck.completed_tasks ?? 0;
  const total     = ck.total_tasks ?? 0;
  const deadCount = Array.isArray(ck.dead_keys) ? ck.dead_keys.length : 0;
  const savedAt   = ck.saved_at ? new Date(ck.saved_at).toLocaleTimeString() : "-";
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
  const validKeys    = r.valid_keys || [];
  const invalidRecs  = r.invalid_records || [];
  const provenModels = r.proven_working_models || [];
  const failedModels = r.failed_models || [];
  const modelPerf    = r.model_performance || {};

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

  const rows = models.map((model) => {
    const p = modelPerf[model];
    const ttft  = p.avg_ttft  != null ? `${p.avg_ttft}s`  : "-";
    const total = p.avg_total != null ? `${p.avg_total}s` : "-";
    const toRate = p.timeout_rate != null
      ? `<span class="${p.timeout_rate > 0.3 ? "fail" : "na"}">${(p.timeout_rate * 100).toFixed(1)}%</span>` : "-";
    const thinkRatio = p.has_thinking_ratio != null
      ? `${(p.has_thinking_ratio * 100).toFixed(0)}%` : "-";
    const hasSample = p.sample && (p.sample.content || p.sample.thinking);
    const sampleBtn = hasSample
      ? `<button class="btn btn-ghost btn-xs" type="button"
           data-sample="${escAttr(JSON.stringify({ model, sample: p.sample }))}">查看</button>`
      : `<span class="na">-</span>`;

    return `<tr>
      <td><code>${esc(model)}</code></td>
      <td>${p.sample_count ?? 0}</td>
      <td class="na">${esc(ttft)}</td>
      <td class="na">${esc(total)}</td>
      <td>${toRate}</td>
      <td class="na">${esc(thinkRatio)}</td>
      <td>${sampleBtn}</td>
    </tr>`;
  }).join("");

  return `
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          <th>模型</th><th>成功数</th><th>avg TTFT</th>
          <th>avg 总耗时</th><th>超时率</th><th>有思考</th><th>Sample</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ── Invalid key groups ───────────────────────────────────────────────────
function renderInvalidGroups(records) {
  if (!records.length) return `<p class="muted">（无）</p>`;

  const groups = new Map();
  for (const rec of records) {
    const reason = rec.error_reason || "未知原因";
    if (!groups.has(reason)) groups.set(reason, []);
    groups.get(reason).push(rec);
  }

  return Array.from(groups.entries()).map(([reason, recs]) => {
    const items = recs.map((rec) => {
      const details = Array.isArray(rec.failed_models_details) && rec.failed_models_details.length
        ? `<div class="inv-models-details">${rec.failed_models_details.map(esc).join("<br>")}</div>` : "";
      return `<div class="inv-key-item">
        <span class="inv-key-mono">${esc(rec.api_key || "")}</span>
        ${details ? `<div>${details}</div>` : ""}
      </div>`;
    }).join("");

    return `<div class="inv-group">
      <div class="inv-group-header" tabindex="0" role="button" aria-expanded="false">
        <span class="inv-group-title">${esc(reason)}</span>
        <span class="badge badge-fail">${recs.length}</span>
        <span class="inv-group-toggle">▼</span>
      </div>
      <div class="inv-group-body">${items}</div>
    </div>`;
  }).join("");
}

// ── Result group open/close ──────────────────────────────────────────────
// handled via event delegation after innerHTML set in loadResults

// ── Sample modal ──────────────────────────────────────────────────────────
function openSample(model, sample) {
  dom.sampleTitle.textContent = model;
  dom.sampleSubtitle.textContent = "";
  const thinking = sample?.thinking || "";
  const content  = sample?.content  || "";
  dom.sampleContent.innerHTML = `
    ${thinking ? `<div class="sample-block">
      <div class="sample-block-label">Thinking</div>
      <pre class="sample-pre">${esc(thinking)}</pre>
    </div>` : ""}
    <div class="sample-block">
      <div class="sample-block-label">Content</div>
      <pre class="sample-pre">${content ? esc(content) : `<span class="na">（空）</span>`}</pre>
    </div>
  `;
  dom.sampleOverlay.classList.remove("hidden");
}
function closeSample() { dom.sampleOverlay.classList.add("hidden"); }

// ── Copy ──────────────────────────────────────────────────────────────────
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "已复制!";
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
  }).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy");
    document.body.removeChild(ta);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function escAttr(v) { return esc(v); }

function extractHost(url) {
  try { return new URL(url).hostname; } catch { return url || ""; }
}

function fingerprintPayload(p) {
  // Must match _worker.js: sorted keys { api_base, provider_type }
  return JSON.stringify({ api_base: p.api_base.replace(/\/+$/, ""), provider_type: p.provider_type });
}

async function sha256(str) {
  const buf  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Events ────────────────────────────────────────────────────────────────
function bindEvents() {
  // Auth
  dom.authBtn.addEventListener("click", login);
  dom.authInput.addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  dom.logoutBtn.addEventListener("click", logout);

  // Topbar mobile menu
  dom.mobileMenuBtn.addEventListener("click", () => toggleMobileMenu());
  dom.mobileMenuClose?.addEventListener("click", () => toggleMobileMenu(false));
  dom.topbarMenuBackdrop?.addEventListener("click", () => toggleMobileMenu(false));

  // Theme
  dom.themeToggle.addEventListener("click", () => {
    toggleTheme();
    toggleMobileMenu(false);
  });

  // Tabs
  dom.tabBtns.forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // Line numbers
  bindLineNums(dom.edKeys);
  bindLineNums(dom.edModels);

  // Config
  dom.addProviderBtn.addEventListener("click", () => openEditor());
  dom.editorSave.addEventListener("click", saveEditor);
  dom.editorCancel.addEventListener("click", closeEditor);
  dom.editorOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "editor") closeEditor();
  });

  // Results
  dom.refreshBtn.addEventListener("click", loadResults);

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
    const copyBtn = e.target.closest(".copy-btn");
    if (copyBtn) copyText(copyBtn.dataset.copyVal || "", copyBtn);
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
    if (!dom.editorOverlay.classList.contains("hidden"))   closeEditor();
    if (!dom.settingsOverlay.classList.contains("hidden")) closeSettings();
    if (!dom.sampleOverlay.classList.contains("hidden"))   closeSample();
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
