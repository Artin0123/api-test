const TOKEN_STORAGE_KEY = "api_test_admin_password";

const DEFAULT_ENDPOINT_HINT = {
  openai: "/chat/completions",
  ollama: "/api/chat",
  gemini: "/models/{model}:streamGenerateContent?alt=sse",
};

const state = {
  token: "",
  providers: [],
  keysRevealed: false,
  lastAuthError: "",
};

const dom = {
  authOverlay: document.getElementById("auth-overlay"),
  authTokenInput: document.getElementById("auth-token"),
  authBtn: document.getElementById("auth-btn"),
  authError: document.getElementById("auth-error"),
  logoutBtn: document.getElementById("logout-btn"),
  runNowBtn: document.getElementById("run-now-btn"),

  tabButtons: Array.from(document.querySelectorAll(".tab-btn")),
  tabPanels: Array.from(document.querySelectorAll(".tab-panel")),

  configLoading: document.getElementById("config-loading"),
  configError: document.getElementById("config-error"),
  providerList: document.getElementById("provider-list"),
  revealKeysBtn: document.getElementById("reveal-keys-btn"),
  addProviderBtn: document.getElementById("add-provider-btn"),

  formCard: document.getElementById("provider-form-card"),
  form: document.getElementById("provider-form"),
  formTitle: document.getElementById("form-title"),
  formIndex: document.getElementById("form-index"),
  formError: document.getElementById("form-error"),
  cancelFormBtn: document.getElementById("cancel-form-btn"),
  resetFormBtn: document.getElementById("reset-form-btn"),
  providerType: document.getElementById("p-provider_type"),
  mode: document.getElementById("p-mode"),
  apiBase: document.getElementById("p-api_base"),
  apiKey: document.getElementById("p-api_key"),
  modelsList: document.getElementById("p-models_list"),
  testerEnabled: document.getElementById("p-tester-enabled"),
  benchmarkEnabled: document.getElementById("p-benchmark-enabled"),
  providerTypeHelp: document.getElementById("provider-type-help"),

  refreshResultsBtn: document.getElementById("refresh-results-btn"),
  resultsLoading: document.getElementById("results-loading"),
  resultsError: document.getElementById("results-error"),
  noResults: document.getElementById("no-results"),
  resultsContent: document.getElementById("results-content"),
  resultsGroups: document.getElementById("results-groups"),

  detailOverlay: document.getElementById("detail-overlay"),
  detailCloseBtn: document.getElementById("detail-close-btn"),
  detailTitle: document.getElementById("detail-title"),
  detailSubtitle: document.getElementById("detail-subtitle"),
  detailContent: document.getElementById("detail-content"),
};

function authHeaders() {
  return { Authorization: `Bearer ${state.token}` };
}

async function apiRequest(path, options = {}) {
  const headers = {
    ...(options.auth ? authHeaders() : {}),
    ...(options.body ? { "Content-Type": "application/json" } : {}),
  };

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const missing = data.missing ? `: ${data.missing}` : "";
    throw new Error(data.error ? `${data.error}${missing}` : `HTTP ${response.status}`);
  }
  return data;
}

async function checkAuth() {
  state.lastAuthError = "";
  try {
    await apiRequest("/api/config", { auth: true });
    return true;
  } catch (err) {
    const message = err.message || "认证检查失败";
    state.lastAuthError = message.includes("Server misconfigured")
      ? `服务器设定错误${message.replace("Server misconfigured", "")}`
      : message === "Unauthorized"
        ? "认证失败，请确认 ADMIN_PASSWORD 是否正确"
        : message;
    return false;
  }
}

async function loadEnv() {
  try {
    const data = await apiRequest("/api/env");
    if (data.github_actions_url) {
      dom.runNowBtn.href = data.github_actions_url;
    }
  } catch {}
}

function initApp() {
  loadConfig(state.keysRevealed);
  loadResults();
}

async function login() {
  state.token = dom.authTokenInput.value.trim();
  if (!state.token) {
    dom.authError.textContent = "请输入 ADMIN_PASSWORD";
    return;
  }

  dom.authError.textContent = "";
  dom.authBtn.disabled = true;
  const ok = await checkAuth();
  dom.authBtn.disabled = false;

  if (!ok) {
    dom.authError.textContent = state.lastAuthError || "认证失败，请确认 ADMIN_PASSWORD 是否正确";
    state.token = "";
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    dom.authOverlay.classList.add("active");
    document.documentElement.classList.remove("auth-checking");
    return;
  }

  localStorage.setItem(TOKEN_STORAGE_KEY, state.token);
  dom.authOverlay.classList.remove("active");
  dom.authTokenInput.value = "";
  document.documentElement.classList.remove("auth-checking");
  initApp();
}

function logout() {
  state.token = "";
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  dom.authOverlay.classList.add("active");
  dom.authTokenInput.value = "";
}

function switchTab(tabName) {
  dom.tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });
  dom.tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  });
  if (tabName === "results") {
    loadResults();
  }
}

function normalizeModelsText(raw) {
  return String(raw || "")
    .split(/[\n,]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(", ");
}

function parseModelsList(raw) {
  const normalized = normalizeModelsText(raw);
  return normalized ? normalized.split(", ").filter(Boolean) : [];
}

function formatModelsList(modelsList) {
  return (Array.isArray(modelsList) ? modelsList : []).join(", ");
}

function normalizeApiBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function providerKey(provider) {
  return `${provider.provider_type}::${provider.mode}::${normalizeApiBase(provider.api_base)}`;
}

function updateProviderTypeHint() {
  const endpoint = DEFAULT_ENDPOINT_HINT[dom.providerType.value] || "-";
  dom.providerTypeHelp.textContent = `固定请求路径: ${endpoint}`;
}

async function loadConfig(full = false) {
  dom.configLoading.classList.remove("hidden");
  dom.configError.classList.add("hidden");
  dom.providerList.classList.add("hidden");

  try {
    const data = await apiRequest(full ? "/api/config?full=1" : "/api/config", { auth: true });
    state.providers = Array.isArray(data.providers) ? data.providers : [];
    state.keysRevealed = full;

    dom.revealKeysBtn.textContent = full ? "已显示完整 key" : "显示完整 key";
    dom.revealKeysBtn.disabled = full;
    renderProviders();
    dom.providerList.classList.remove("hidden");
  } catch (err) {
    dom.configError.textContent = `读取失败: ${err.message}`;
    dom.configError.classList.remove("hidden");
  } finally {
    dom.configLoading.classList.add("hidden");
  }
}

function renderProviders() {
  if (!state.providers.length) {
    dom.providerList.innerHTML = '<div class="empty-card">尚未新增测试来源。先建立一个来源后再触发测试。</div>';
    return;
  }

  dom.providerList.innerHTML = state.providers
    .map((provider, index) => renderProviderCard(provider, index))
    .join("");

  dom.providerList.querySelectorAll("[data-action='edit']").forEach((button) => {
    button.addEventListener("click", () => editProvider(Number(button.dataset.idx)));
  });
  dom.providerList.querySelectorAll("[data-action='delete']").forEach((button) => {
    button.addEventListener("click", () => deleteProvider(Number(button.dataset.idx)));
  });
}

function renderProviderCard(provider, index) {
  const models = Array.isArray(provider.models_list) ? provider.models_list : [];
  const testerEnabled = provider.tester_enabled !== false;
  const benchmarkEnabled = provider.benchmark_enabled !== false;
  const modelsPreview = models.slice(0, 5).join(", ") || "-";
  const extraModels = models.length > 5 ? ` +${models.length - 5}` : "";

  return `
    <article class="provider-card">
      <div class="provider-card-header">
        <div>
          <div class="card-actions">
            <span class="badge">${esc(provider.provider_type)}</span>
            <span class="badge neutral">${esc(provider.mode)}</span>
          </div>
          <h3 class="provider-title">${esc(provider.api_base)}</h3>
        </div>
        <div class="provider-actions">
          <button class="btn btn-sm btn-secondary" type="button" data-action="edit" data-idx="${index}">编辑</button>
          <button class="btn btn-sm btn-danger" type="button" data-action="delete" data-idx="${index}">删除</button>
        </div>
      </div>
      <div class="provider-meta">
        <div class="meta-item"><span>模型数</span><strong>${models.length}</strong></div>
        <div class="meta-item"><span>api_key</span><strong>${esc(provider.api_key || "-")}</strong></div>
        <div class="meta-item"><span>模型检查</span><strong class="${testerEnabled ? "status-ok" : "status-fail"}">${testerEnabled ? "启用" : "停用"}</strong></div>
        <div class="meta-item"><span>效能测试</span><strong class="${benchmarkEnabled ? "status-ok" : "status-fail"}">${benchmarkEnabled ? "启用" : "停用"}</strong></div>
      </div>
      <div class="meta-item"><span>models_list</span><strong>${esc(modelsPreview)}${esc(extraModels)}</strong></div>
    </article>
  `;
}

function openEditor(mode, index = -1) {
  dom.formIndex.value = String(index);
  dom.formTitle.textContent = mode === "edit" ? "编辑来源" : "新增来源";
  dom.formCard.classList.remove("hidden");
  dom.formCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetForm() {
  dom.form.reset();
  dom.formIndex.value = "-1";
  dom.formTitle.textContent = "新增来源";
  dom.testerEnabled.checked = true;
  dom.benchmarkEnabled.checked = true;
  dom.modelsList.value = "";
  dom.formError.textContent = "";
  updateProviderTypeHint();
}

function editProvider(index) {
  const provider = state.providers[index];
  if (!provider) return;

  dom.providerType.value = provider.provider_type;
  dom.mode.value = provider.mode;
  dom.apiBase.value = provider.api_base;
  dom.apiKey.value = "";
  dom.testerEnabled.checked = provider.tester_enabled !== false;
  dom.benchmarkEnabled.checked = provider.benchmark_enabled !== false;
  dom.modelsList.value = formatModelsList(provider.models_list);
  dom.formError.textContent = "";
  updateProviderTypeHint();
  openEditor("edit", index);
}

async function deleteProvider(index) {
  const provider = state.providers[index];
  if (!provider || !confirm(`确定删除 ${provider.api_base} ?`)) return;

  const result = await saveConfig(state.providers.filter((_, idx) => idx !== index));
  if (!result.ok) {
    alert(result.error || "删除失败");
    return;
  }
  await loadConfig(state.keysRevealed);
}

async function submitProviderForm(event) {
  event.preventDefault();
  dom.formError.textContent = "";

  const index = Number(dom.formIndex.value);
  const existing = index >= 0 ? state.providers[index] : null;
  const apiKeyInput = dom.apiKey.value.trim();
  const provider = {
    provider_type: dom.providerType.value,
    mode: dom.mode.value,
    api_base: normalizeApiBase(dom.apiBase.value),
    api_key: apiKeyInput || existing?.api_key || "",
    tester_enabled: dom.testerEnabled.checked,
    benchmark_enabled: dom.benchmarkEnabled.checked,
    models_list: parseModelsList(dom.modelsList.value),
  };

  const validationError = validateProviderForm(provider, index, apiKeyInput);
  if (validationError) {
    dom.formError.textContent = validationError;
    return;
  }

  const nextProviders = state.providers.slice();
  if (index >= 0) nextProviders[index] = provider;
  else nextProviders.push(provider);

  const result = await saveConfig(nextProviders);
  if (!result.ok) {
    dom.formError.textContent = result.error || "储存失败";
    return;
  }

  dom.formCard.classList.add("hidden");
  resetForm();
  await loadConfig(state.keysRevealed);
}

function validateProviderForm(provider, index, apiKeyInput) {
  if (!provider.provider_type || !provider.mode || !provider.api_base) {
    return "请填写所有必填栏位";
  }
  if (!provider.models_list.length) {
    return "models_list 不能为空";
  }
  if (index < 0 && !apiKeyInput) {
    return "新增来源时必须填写 api_key";
  }

  const keys = new Set();
  const nextProviders = state.providers.slice();
  if (index >= 0) nextProviders[index] = provider;
  else nextProviders.push(provider);

  for (const item of nextProviders) {
    const key = providerKey(item);
    if (keys.has(key)) return "provider_type + mode + api_base 不可重复";
    keys.add(key);
  }
  return "";
}

async function saveConfig(providers) {
  try {
    await apiRequest("/api/config", {
      method: "POST",
      auth: true,
      body: { providers },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function providerFingerprint(provider) {
  const payload = JSON.stringify({
    api_base: normalizeApiBase(provider.api_base),
    mode: provider.mode,
    provider_type: provider.provider_type,
  });
  return sha256Hex(payload);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadResults() {
  dom.resultsLoading.classList.remove("hidden");
  dom.resultsError.classList.add("hidden");
  dom.noResults.classList.add("hidden");
  dom.resultsContent.classList.add("hidden");

  try {
    const config = await apiRequest("/api/config", { auth: true });
    const providers = Array.isArray(config.providers) ? config.providers : [];
    if (!providers.length) {
      dom.noResults.classList.remove("hidden");
      return;
    }

    const bundles = await Promise.all(providers.map(async (provider) => {
      const fingerprint = await providerFingerprint(provider);
      const data = await apiRequest(`/api/results?fingerprint=${encodeURIComponent(fingerprint)}`);
      return { provider, fingerprint, data };
    }));

    const existing = bundles.filter((bundle) => bundle.data.exists);
    if (!existing.length) {
      dom.noResults.classList.remove("hidden");
      return;
    }

    renderResults(existing);
    dom.resultsContent.classList.remove("hidden");
  } catch (err) {
    dom.resultsError.textContent = `读取失败: ${err.message}`;
    dom.resultsError.classList.remove("hidden");
  } finally {
    dom.resultsLoading.classList.add("hidden");
  }
}

function renderResults(bundles) {
  dom.resultsGroups.innerHTML = bundles.map(renderResultCard).join("");
  dom.resultsGroups.querySelectorAll("[data-detail-payload]").forEach((button) => {
    button.addEventListener("click", () => openDetail(JSON.parse(button.dataset.detailPayload)));
  });
}

function renderResultCard({ provider, fingerprint, data }) {
  const tester = data.tester || null;
  const benchmark = data.benchmark || null;
  const testerItems = Array.isArray(tester?.items) ? tester.items : [];
  const benchmarkItems = Array.isArray(benchmark?.items) ? benchmark.items : [];
  const successCount = testerItems.filter((item) => item.success).length;

  return `
    <article class="result-card">
      <div class="result-card-header">
        <div>
          <div class="card-actions">
            <span class="badge">${esc(provider.provider_type)}</span>
            <span class="badge neutral">${esc(provider.mode)}</span>
            <span class="badge neutral">指纹 ${esc(shortFingerprint(fingerprint))}</span>
          </div>
          <h3 class="result-title">${esc(provider.api_base)}</h3>
        </div>
      </div>
      <div class="result-card-body">
        <div class="metric-grid">
          <div class="meta-item"><span class="metric-label">测试执行</span><strong class="metric-value">${esc(tester?.run_id || "-")}</strong></div>
          <div class="meta-item"><span class="metric-label">成功数</span><strong class="metric-value">${successCount}/${testerItems.length}</strong></div>
          <div class="meta-item"><span class="metric-label">效能测试数</span><strong class="metric-value">${benchmarkItems.length}</strong></div>
          <div class="meta-item"><span class="metric-label">模型数</span><strong class="metric-value">${(provider.models_list || []).length}</strong></div>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>状态</th>
                <th>测试总耗时</th>
                <th>平均耗时</th>
                <th>错误</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>${renderResultRows(testerItems, benchmarkItems)}</tbody>
          </table>
        </div>
      </div>
    </article>
  `;
}

function renderResultRows(testerItems, benchmarkItems) {
  const testerByModel = new Map(testerItems.map((item) => [item.model, item]));
  const benchmarkByModel = new Map(benchmarkItems.map((item) => [item.model, item]));
  const modelNames = Array.from(new Set([...testerByModel.keys(), ...benchmarkByModel.keys()]))
    .sort((a, b) => {
      const left = testerByModel.get(a);
      const right = testerByModel.get(b);
      if (left?.success !== right?.success) return left?.success ? -1 : 1;
      return (left?.total_time_ms ?? Infinity) - (right?.total_time_ms ?? Infinity);
    });

  if (!modelNames.length) {
    return '<tr><td colspan="6" class="cell-empty">没有可显示的结果</td></tr>';
  }

  return modelNames.map((model) => renderResultRow(model, testerByModel.get(model), benchmarkByModel.get(model))).join("");
}

function renderResultRow(model, tester, benchmark) {
  const detailPayload = {
    title: model || "-",
    subtitle: tester ? `${tester.provider_type} / ${tester.mode} / ${tester.api_base}` : "仅效能测试",
    tester,
    benchmark,
  };
  const status = tester
    ? tester.success
      ? '<span class="status-ok">成功</span>'
      : '<span class="status-fail">失败</span>'
    : '<span class="status-muted">无模型检查</span>';

  return `
    <tr>
      <td><code>${esc(model || "-")}</code></td>
      <td>${status}</td>
      <td>${fmtMs(tester?.total_time_ms)}</td>
      <td>${benchmark ? fmtMs(benchmark.avg_total_time_ms) : "-"}</td>
      <td>${esc(tester?.error_type || benchmark?.error || "-")}</td>
      <td><button type="button" class="btn btn-sm btn-secondary" data-detail-payload="${escAttr(JSON.stringify(detailPayload))}">详情</button></td>
    </tr>
  `;
}

function openDetail(payload) {
  dom.detailTitle.textContent = payload.title || "详情";
  dom.detailSubtitle.textContent = payload.subtitle || "";
  dom.detailContent.innerHTML = `
    <section class="detail-section">
      <h4>模型检查</h4>
      ${renderTesterDetail(payload.tester)}
    </section>
    <section class="detail-section">
      <h4>效能测试</h4>
      ${renderBenchmarkDetail(payload.benchmark)}
    </section>
  `;
  dom.detailOverlay.classList.remove("hidden");
}

function renderTesterDetail(item) {
  if (!item) return '<p class="muted">没有模型检查结果。</p>';
  return `
    <div class="detail-grid">
      <div><strong>成功</strong>: ${item.success ? "true" : "false"}</div>
      <div><strong>有答案</strong>: ${item.has_answer ? "true" : "false"}</div>
      <div><strong>有 thinking</strong>: ${item.has_thinking ? "true" : "false"}</div>
      <div><strong>重试次数</strong>: ${item.retry_count ?? 0}</div>
      <div><strong>总耗时</strong>: ${fmtMs(item.total_time_ms)}</div>
      <div><strong>错误类型</strong>: ${esc(item.error_type || "-")}</div>
    </div>
    <pre class="detail-pre"><strong>答案</strong>\n${esc(item.answer_preview || "")}</pre>
    <pre class="detail-pre"><strong>思考</strong>\n${esc(item.thinking_preview || "")}</pre>
    <pre class="detail-pre"><strong>错误</strong>\n${esc(item.error_message_preview || "")}</pre>
  `;
}

function renderBenchmarkDetail(benchmark) {
  if (!benchmark) return '<p class="muted">没有效能测试结果。</p>';
  const runs = Array.isArray(benchmark.runs) ? benchmark.runs : [];
  return `
    <div class="detail-grid">
      <div><strong>平均总耗时</strong>: ${fmtMs(benchmark.avg_total_time_ms)}</div>
      <div><strong>执行次数</strong>: ${runs.length}</div>
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>次数</th>
            <th>总耗时</th>
            <th>ttft</th>
            <th>字数</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          ${runs.map((run) => `
            <tr>
              <td>${run.run_index}</td>
              <td>${fmtMs(run.total_time_ms)}</td>
              <td>${run.ttft_ms == null ? "-" : fmtMs(run.ttft_ms)}</td>
              <td>${run.output_chars ?? 0}</td>
              <td>${esc(run.error || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function closeDetail() {
  dom.detailOverlay.classList.add("hidden");
}

function shortFingerprint(value) {
  const text = String(value || "");
  if (!text) return "-";
  if (text.length <= 18) return text;
  return `${text.slice(0, 12)}...${text.slice(-6)}`;
}

function fmtMs(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}ms`;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escAttr(value) {
  return esc(value);
}

function cleanupLegacyServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
  }
  if ("caches" in window) {
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .catch(() => {});
  }
}

function bindEvents() {
  dom.authBtn.addEventListener("click", login);
  dom.authTokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") login();
  });
  dom.logoutBtn.addEventListener("click", logout);

  dom.tabButtons.forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  dom.addProviderBtn.addEventListener("click", () => {
    resetForm();
    openEditor("new");
  });
  dom.revealKeysBtn.addEventListener("click", () => {
    if (!state.keysRevealed) loadConfig(true);
  });
  dom.cancelFormBtn.addEventListener("click", () => dom.formCard.classList.add("hidden"));
  dom.resetFormBtn.addEventListener("click", resetForm);
  dom.form.addEventListener("submit", submitProviderForm);
  dom.providerType.addEventListener("change", updateProviderTypeHint);
  dom.modelsList.addEventListener("blur", () => {
    dom.modelsList.value = normalizeModelsText(dom.modelsList.value);
  });

  dom.refreshResultsBtn.addEventListener("click", loadResults);
  dom.detailCloseBtn.addEventListener("click", closeDetail);
  dom.detailOverlay.addEventListener("click", (event) => {
    if (event.target.dataset.closeDetail === "1") closeDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dom.detailOverlay.classList.contains("hidden")) {
      closeDetail();
    }
  });
}

async function bootstrap() {
  cleanupLegacyServiceWorker();
  bindEvents();
  updateProviderTypeHint();
  await loadEnv();

  state.token = localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  if (state.token) {
    const ok = await checkAuth();
    if (ok) {
      dom.authOverlay.classList.remove("active");
      initApp();
    } else {
      state.token = "";
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      dom.authOverlay.classList.add("active");
    }
  }

  document.documentElement.classList.remove("auth-checking");
}

bootstrap();
