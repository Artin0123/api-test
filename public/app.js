/* ── API Test Admin Frontend ── */

const API_BASE = ''; // same origin
let token = '';

/* ── Auth ── */
const authOverlay = document.getElementById('auth-overlay');
const authTokenInput = document.getElementById('auth-token');
const authBtn = document.getElementById('auth-btn');
const authError = document.getElementById('auth-error');
const logoutBtn = document.getElementById('logout-btn');

authBtn.addEventListener('click', async () => {
  token = authTokenInput.value.trim();
  if (!token) { authError.textContent = '請輸入 token'; return; }
  authError.textContent = '';
  const ok = await checkAuth();
  if (ok) {
    authOverlay.classList.remove('active');
    authTokenInput.value = '';
    initApp();
  } else {
    authError.textContent = '驗證失敗，請確認 MASTER_API_TOKEN 是否正確';
    token = '';
  }
});

logoutBtn.addEventListener('click', () => {
  token = '';
  authOverlay.classList.add('active');
  authTokenInput.value = '';
});

async function checkAuth() {
  try {
    const res = await fetch('/api/config', { headers: authHeaders() });
    return res.ok;
  } catch { return false; }
}

function authHeaders() {
  return { 'Authorization': `Bearer ${token}` };
}

/* ── Init ── */
function initApp() {
  loadConfig();
  loadResults();
}

/* ── Tabs ── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'results') loadResults();
  });
});

/* ── Config ── */
const configLoading = document.getElementById('config-loading');
const configError = document.getElementById('config-error');
const providersTableWrap = document.getElementById('providers-table-wrap');
const providersTbody = document.getElementById('providers-tbody');
const addProviderBtn = document.getElementById('add-provider-btn');
const providerFormCard = document.getElementById('provider-form-card');
const providerForm = document.getElementById('provider-form');
const cancelFormBtn = document.getElementById('cancel-form-btn');
const formTitle = document.getElementById('form-title');
const formIndex = document.getElementById('form-index');
const formError = document.getElementById('form-error');

let currentProviders = [];

const DEFAULT_ENDPOINT_PATH = {
  openai: '/v1/chat/completions',
  ollama: '/api/chat',
  gemini: '/v1beta/models/{model}:streamGenerateContent?alt=sse',
};

const DEFAULT_MODELS_ENDPOINT = {
  openai: '/v1/models',
  ollama: '/api/tags',
  gemini: '/v1beta/models',
};

function getDefaultEndpointPath(providerType) {
  return DEFAULT_ENDPOINT_PATH[providerType] || '';
}

function getDefaultModelsEndpoint(providerType) {
  return DEFAULT_MODELS_ENDPOINT[providerType] || '';
}

function isBenchmarkEnabled(provider) {
  if (typeof provider?.benchmark_enabled === 'boolean') return provider.benchmark_enabled;
  if (typeof provider?.enabled === 'boolean') return provider.enabled;
  return true;
}

addProviderBtn.addEventListener('click', () => {
  resetForm();
  providerFormCard.classList.remove('hidden');
  providerFormCard.scrollIntoView({ behavior: 'smooth' });
});

cancelFormBtn.addEventListener('click', () => {
  providerFormCard.classList.add('hidden');
});

providerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const idx = parseInt(formIndex.value, 10);
  const providerType = document.getElementById('p-provider_type').value;
  const endpointPathInput = document.getElementById('p-endpoint_path').value.trim();
  const modelsEndpointInput = document.getElementById('p-models_endpoint').value.trim();
  const p = {
    provider_id: document.getElementById('p-provider_id').value.trim(),
    provider_type: providerType,
    mode: document.getElementById('p-mode').value,
    api_base: document.getElementById('p-api_base').value.trim(),
    endpoint_path: endpointPathInput || getDefaultEndpointPath(providerType),
    models_endpoint: modelsEndpointInput || getDefaultModelsEndpoint(providerType),
    api_key: document.getElementById('p-api_key').value.trim(),
    benchmark_enabled: document.getElementById('p-benchmark-enabled').checked,
  };

  if (!p.provider_id || !p.provider_type || !p.mode || !p.api_base || !p.api_key) {
    formError.textContent = '請填寫所有必填欄位';
    return;
  }

  if (idx >= 0) {
    currentProviders[idx] = p;
  } else {
    if (currentProviders.some((x, i) => i !== idx && x.provider_id === p.provider_id)) {
      formError.textContent = 'provider_id 已存在';
      return;
    }
    currentProviders.push(p);
  }

  const ok = await saveConfig(currentProviders);
  if (ok) {
    providerFormCard.classList.add('hidden');
    renderProviders();
  } else {
    formError.textContent = '儲存失敗，請檢查 API 連線';
  }
});

async function loadConfig() {
  configLoading.classList.remove('hidden');
  configError.classList.add('hidden');
  providersTableWrap.classList.add('hidden');

  try {
    const res = await fetch('/api/config', { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentProviders = data.providers || [];
    renderProviders();
    configLoading.classList.add('hidden');
    providersTableWrap.classList.remove('hidden');
  } catch (err) {
    configLoading.classList.add('hidden');
    configError.textContent = `載入失敗: ${err.message}`;
    configError.classList.remove('hidden');
  }
}

function renderProviders() {
  providersTbody.innerHTML = '';
  if (currentProviders.length === 0) {
    providersTbody.innerHTML = '<tr><td colspan="9" class="cell-empty">尚無供應商</td></tr>';
    return;
  }
  currentProviders.forEach((p, i) => {
    const endpointPath = p.endpoint_path || getDefaultEndpointPath(p.provider_type);
    const modelsEndpoint = p.models_endpoint || getDefaultModelsEndpoint(p.provider_type);
    const benchmarkEnabled = isBenchmarkEnabled(p);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${esc(p.provider_id)}</code></td>
      <td>${esc(p.provider_type)}</td>
      <td>${esc(p.mode)}</td>
      <td><code>${esc(p.api_base)}</code></td>
      <td><code>${esc(endpointPath)}</code></td>
      <td><code>${esc(modelsEndpoint)}</code></td>
      <td>${benchmarkEnabled ? '<span class="status-ok">執行</span>' : '<span class="status-fail">略過</span>'}</td>
      <td>${esc(p.api_key)}</td>
      <td class="cell-actions">
        <button class="btn btn-sm btn-ghost" data-idx="${i}" data-action="edit">編輯</button>
        <button class="btn btn-sm btn-danger" data-idx="${i}" data-action="delete">刪除</button>
      </td>
    `;
    providersTbody.appendChild(tr);
  });

  providersTbody.querySelectorAll('button[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => editProvider(parseInt(btn.dataset.idx, 10)));
  });
  providersTbody.querySelectorAll('button[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteProvider(parseInt(btn.dataset.idx, 10)));
  });
}

function editProvider(idx) {
  const p = currentProviders[idx];
  formIndex.value = idx;
  formTitle.textContent = '編輯供應商';
  document.getElementById('p-provider_id').value = p.provider_id;
  document.getElementById('p-provider_type').value = p.provider_type;
  document.getElementById('p-mode').value = p.mode;
  document.getElementById('p-api_base').value = p.api_base;
  document.getElementById('p-endpoint_path').value = p.endpoint_path || '';
  document.getElementById('p-models_endpoint').value = p.models_endpoint || '';
  document.getElementById('p-api_key').value = p.api_key;
  document.getElementById('p-benchmark-enabled').checked = isBenchmarkEnabled(p);
  providerFormCard.classList.remove('hidden');
  providerFormCard.scrollIntoView({ behavior: 'smooth' });
}

async function deleteProvider(idx) {
  if (!confirm(`確定刪除供應商 "${currentProviders[idx].provider_id}"？`)) return;
  currentProviders.splice(idx, 1);
  const ok = await saveConfig(currentProviders);
  if (ok) renderProviders();
  else alert('刪除失敗');
}

function resetForm() {
  formIndex.value = -1;
  formTitle.textContent = '新增供應商';
  providerForm.reset();
  document.getElementById('p-benchmark-enabled').checked = true;
  formError.textContent = '';
}

async function saveConfig(providers) {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });
    return res.ok;
  } catch { return false; }
}

/* ── Results ── */
const refreshResultsBtn = document.getElementById('refresh-results-btn');
const resultsLoading = document.getElementById('results-loading');
const resultsError = document.getElementById('results-error');
const noResults = document.getElementById('no-results');
const resultsContent = document.getElementById('results-content');
const runMetaGrid = document.getElementById('run-meta-grid');
const summaryCards = document.getElementById('summary-cards');
const scorecardTbody = document.getElementById('scorecard-tbody');
const benchmarkTbody = document.getElementById('benchmark-tbody');

refreshResultsBtn.addEventListener('click', loadResults);

async function loadResults() {
  resultsLoading.classList.remove('hidden');
  resultsError.classList.add('hidden');
  noResults.classList.add('hidden');
  resultsContent.classList.add('hidden');

  try {
    const res = await fetch('/api/results');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.exists && !data.meta) {
      resultsLoading.classList.add('hidden');
      noResults.classList.remove('hidden');
      return;
    }
    renderResults(data);
    resultsLoading.classList.add('hidden');
    resultsContent.classList.remove('hidden');
  } catch (err) {
    resultsLoading.classList.add('hidden');
    resultsError.textContent = `載入失敗: ${err.message}`;
    resultsError.classList.remove('hidden');
  }
}

function renderResults(data) {
  const meta = data.meta || {};
  runMetaGrid.innerHTML = `
    <div class="kv-item"><span class="kv-key">執行 ID</span><span class="kv-val">${esc(meta.run_id || '-')}</span></div>
    <div class="kv-item"><span class="kv-key">開始時間</span><span class="kv-val">${esc(meta.started_at || '-')}</span></div>
    <div class="kv-item"><span class="kv-key">結束時間</span><span class="kv-val">${esc(meta.finished_at || '-')}</span></div>
  `;

  const sc = data.scorecard || {};
  const summary = sc.summary || { total: 0, success: 0, failed: 0 };
  summaryCards.innerHTML = `
    <div class="summary-card"><div class="value">${summary.total}</div><div class="label">總數</div></div>
    <div class="summary-card"><div class="value value-success">${summary.success}</div><div class="label">成功</div></div>
    <div class="summary-card"><div class="value value-failed">${summary.failed}</div><div class="label">失敗</div></div>
  `;

  const items = (sc.items || []).slice().sort((a, b) => {
    if (a.success !== b.success) return b.success ? 1 : -1;
    const ta = a.total_time_ms ?? Infinity;
    const tb = b.total_time_ms ?? Infinity;
    if (ta !== tb) return ta - tb;
    return `${a.provider_id}:${a.model}`.localeCompare(`${b.provider_id}:${b.model}`);
  });

  scorecardTbody.innerHTML = '';
  if (items.length === 0) {
    scorecardTbody.innerHTML = '<tr><td colspan="10" class="cell-empty">無資料</td></tr>';
  } else {
    items.forEach(it => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${esc(it.provider_id)}</code></td>
        <td><code>${esc(it.model)}</code></td>
        <td>${esc(it.provider_type)}</td>
        <td>${esc(it.mode)}</td>
        <td>${it.success ? '<span class="status-ok">成功</span>' : '<span class="status-fail">失敗</span>'}</td>
        <td>${it.has_answer ? '<span class="status-ok">有</span>' : '<span class="status-fail">無</span>'}</td>
        <td>${it.has_thinking ? '<span class="status-ok">有</span>' : '<span class="status-warn">無</span>'}</td>
        <td>${fmtNum(it.total_time_ms)}</td>
        <td>${esc(it.error_type || '-')}</td>
        <td>${it.retry_count ?? 0}</td>
      `;
      scorecardTbody.appendChild(tr);
    });
  }

  const bItems = (data.benchmark?.items || []).slice().sort((a, b) => {
    return (a.avg_total_time_ms ?? Infinity) - (b.avg_total_time_ms ?? Infinity);
  });

  benchmarkTbody.innerHTML = '';
  if (bItems.length === 0) {
    benchmarkTbody.innerHTML = '<tr><td colspan="6" class="cell-empty">無資料</td></tr>';
  } else {
    bItems.forEach(it => {
      const runs = it.runs || [];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${esc(it.provider_id)}</code></td>
        <td><code>${esc(it.model)}</code></td>
        <td><strong>${fmtNum(it.avg_total_time_ms)}</strong></td>
        <td>${runCell(runs[0])}</td>
        <td>${runCell(runs[1])}</td>
        <td>${runCell(runs[2])}</td>
      `;
      benchmarkTbody.appendChild(tr);
    });
  }
}

function runCell(run) {
  if (!run) return '<span class="muted-inline">-</span>';
  return `<code>${fmtNum(run.total_time_ms)}</code> <span class="muted-inline">首字延遲:${fmtNum(run.ttft_ms)} 字元:${run.output_chars ?? '-'}</span>`;
}

/* ── Helpers ── */
function esc(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

function fmtNum(n) {
  if (n == null) return '-';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/* ── Boot ── */
(async () => {
  // Load env vars
  try {
    const envRes = await fetch('/api/env');
    if (envRes.ok) {
      const envData = await envRes.json();
      if (envData.github_actions_url) {
        document.getElementById('run-now-btn').href = envData.github_actions_url;
      }
    }
  } catch { }

  if (token) {
    const ok = await checkAuth();
    if (ok) { authOverlay.classList.remove('active'); initApp(); }
    else { token = ''; authOverlay.classList.add('active'); }
  }
})();