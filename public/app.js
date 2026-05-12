/* ── API Test Admin Frontend ── */

const API_BASE = ''; // same origin
let token = '';
const TOKEN_STORAGE_KEY = 'api_test_admin_token';

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
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    document.documentElement.classList.remove('auth-checking');
    authOverlay.classList.remove('active');
    authTokenInput.value = '';
    initApp();
  } else {
    authError.textContent = '驗證失敗，請確認 MASTER_API_TOKEN 是否正確';
    token = '';
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    document.documentElement.classList.remove('auth-checking');
    authOverlay.classList.add('active');
  }
});

logoutBtn.addEventListener('click', () => {
  token = '';
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  document.documentElement.classList.remove('auth-checking');
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
  loadCheckpointStatus();
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
const revealKeysBtn = document.getElementById('reveal-keys-btn');
const checkpointStatusText = document.getElementById('checkpoint-status-text');
const refreshCheckpointBtn = document.getElementById('refresh-checkpoint-btn');
const clearCheckpointBtn = document.getElementById('clear-checkpoint-btn');
const providerFormCard = document.getElementById('provider-form-card');
const providerForm = document.getElementById('provider-form');
const cancelFormBtn = document.getElementById('cancel-form-btn');
const formTitle = document.getElementById('form-title');
const formIndex = document.getElementById('form-index');
const formError = document.getElementById('form-error');

let currentProviders = [];
let keysRevealed = false;

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

addProviderBtn.addEventListener('click', () => {
  resetForm();
  providerFormCard.classList.remove('hidden');
  providerFormCard.scrollIntoView({ behavior: 'smooth' });
});

revealKeysBtn.addEventListener('click', async () => {
  if (keysRevealed) return;
  await loadConfig(true);
});

cancelFormBtn.addEventListener('click', () => {
  providerFormCard.classList.add('hidden');
});

refreshCheckpointBtn.addEventListener('click', loadCheckpointStatus);

clearCheckpointBtn.addEventListener('click', async () => {
  if (!confirm('確定清除目前 Checkpoint？這只會刪除中斷續跑進度，不會刪除結果或供應商設定。')) return;
  clearCheckpointBtn.disabled = true;
  checkpointStatusText.textContent = '清除中…';
  try {
    const res = await fetch('/api/checkpoint', {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    checkpointStatusText.textContent = '目前無 Checkpoint（已清除）';
  } catch (err) {
    checkpointStatusText.textContent = `清除失敗: ${err.message}`;
  } finally {
    clearCheckpointBtn.disabled = false;
    await loadCheckpointStatus();
  }
});

providerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const idx = parseInt(formIndex.value, 10);
  const existing = idx >= 0 ? currentProviders[idx] : null;
  const providerType = document.getElementById('p-provider_type').value;
  const endpointPathInput = document.getElementById('p-endpoint_path').value.trim();
  const modelsEndpointInput = document.getElementById('p-models_endpoint').value.trim();
  const apiKeyInput = document.getElementById('p-api_key').value.trim();
  const p = {
    provider_type: providerType,
    mode: document.getElementById('p-mode').value,
    api_base: document.getElementById('p-api_base').value.trim(),
    endpoint_path: endpointPathInput || getDefaultEndpointPath(providerType),
    models_endpoint: modelsEndpointInput || getDefaultModelsEndpoint(providerType),
    api_key: apiKeyInput || existing?.api_key || '',
    tester_enabled: document.getElementById('p-tester-enabled').checked,
    benchmark_enabled: document.getElementById('p-benchmark-enabled').checked,
  };

  if (!p.provider_type || !p.mode || !p.api_base || !p.api_key) {
    formError.textContent = '請填寫所有必填欄位';
    return;
  }

  if (idx < 0 && !apiKeyInput) {
    formError.textContent = '新增供應商時必須填寫 api_key';
    return;
  }

  if (idx >= 0) {
    currentProviders[idx] = p;
  } else {
    const key = `${p.provider_type}::${p.mode}::${p.api_base}`;
    if (currentProviders.some((x, i) => i !== idx && `${x.provider_type}::${x.mode}::${x.api_base}` === key)) {
      formError.textContent = '相同的 provider_type + mode + api_base 已存在';
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

async function loadConfig(full = false) {
  configLoading.classList.remove('hidden');
  configError.classList.add('hidden');
  providersTableWrap.classList.add('hidden');

  try {
    const url = full ? '/api/config?full=1' : '/api/config';
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentProviders = data.providers || [];
    keysRevealed = full;
    revealKeysBtn.textContent = full ? '已顯示完整 key' : '顯示完整 key';
    revealKeysBtn.disabled = full;
    renderProviders();
    configLoading.classList.add('hidden');
    providersTableWrap.classList.remove('hidden');
  } catch (err) {
    configLoading.classList.add('hidden');
    configError.textContent = `載入失敗: ${err.message}`;
    configError.classList.remove('hidden');
  }
}

async function loadCheckpointStatus() {
  checkpointStatusText.textContent = '讀取中…';
  refreshCheckpointBtn.disabled = true;
  clearCheckpointBtn.disabled = true;

  try {
    const res = await fetch('/api/checkpoint', { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.exists === false || !data.run_id) {
      checkpointStatusText.textContent = '目前無 Checkpoint';
      return;
    }

    const completedCount = Array.isArray(data.completed) ? data.completed.length : 0;
    const updatedAt = data.updated_at || '-';
    const fp = typeof data.config_fingerprint === 'string' && data.config_fingerprint
      ? data.config_fingerprint.slice(0, 12)
      : null;
    const fpText = fp ? `，fingerprint=${fp}...` : '';
    checkpointStatusText.textContent = `run_id=${data.run_id}${fpText}，已完成 ${completedCount} 項，更新時間 ${updatedAt}`;
  } catch (err) {
    checkpointStatusText.textContent = `讀取失敗: ${err.message}`;
  } finally {
    refreshCheckpointBtn.disabled = false;
    clearCheckpointBtn.disabled = false;
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
    const testerEnabled = p.tester_enabled !== false;
    const benchmarkEnabled = !!p.benchmark_enabled;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(p.provider_type)}</td>
      <td>${esc(p.mode)}</td>
      <td><code>${esc(p.api_base)}</code></td>
      <td><code>${esc(endpointPath)}</code></td>
      <td><code>${esc(modelsEndpoint)}</code></td>
      <td>${testerEnabled ? '<span class="status-ok">執行</span>' : '<span class="status-fail">略過</span>'}</td>
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
  document.getElementById('p-provider_type').value = p.provider_type;
  document.getElementById('p-mode').value = p.mode;
  document.getElementById('p-api_base').value = p.api_base;
  document.getElementById('p-endpoint_path').value = p.endpoint_path || '';
  document.getElementById('p-models_endpoint').value = p.models_endpoint || '';
  document.getElementById('p-api_key').value = '';
  document.getElementById('p-tester-enabled').checked = p.tester_enabled !== false;
  document.getElementById('p-benchmark-enabled').checked = !!p.benchmark_enabled;
  providerFormCard.classList.remove('hidden');
  providerFormCard.scrollIntoView({ behavior: 'smooth' });
}

async function deleteProvider(idx) {
  if (!confirm(`確定刪除供應商 "${currentProviders[idx].api_base}"？`)) return;
  currentProviders.splice(idx, 1);
  const ok = await saveConfig(currentProviders);
  if (ok) renderProviders();
  else alert('刪除失敗');
}

function resetForm() {
  formIndex.value = -1;
  formTitle.textContent = '新增供應商';
  providerForm.reset();
  document.getElementById('p-tester-enabled').checked = true;
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
const resultsGroups = document.getElementById('results-groups');

refreshResultsBtn.addEventListener('click', loadResults);

async function loadResults() {
  resultsLoading.classList.remove('hidden');
  resultsError.classList.add('hidden');
  noResults.classList.add('hidden');
  resultsContent.classList.add('hidden');

  try {
    const res = await fetch('/api/results/catalog');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      resultsLoading.classList.add('hidden');
      noResults.classList.remove('hidden');
      return;
    }
    renderResultsCatalog(items);
    resultsLoading.classList.add('hidden');
    resultsContent.classList.remove('hidden');
  } catch (err) {
    resultsLoading.classList.add('hidden');
    resultsError.textContent = `載入失敗: ${err.message}`;
    resultsError.classList.remove('hidden');
  }
}

function renderResultsCatalog(items) {
  resultsGroups.innerHTML = items.map((item, idx) => {
    const summary = item?.summary || {};
    const providers = Array.isArray(item?.providers) ? item.providers.length : 0;
    return `
      <details class="result-group" data-fingerprint="${esc(item?.config_fingerprint || '')}" ${idx === 0 ? 'open' : ''}>
        <summary>
          <span class="group-title">fingerprint ${esc(shortFingerprint(item?.config_fingerprint))}</span>
          <span class="muted-inline">run:${esc(item?.run_id || '-')} · providers:${providers} · total:${summary.total ?? 0} · success:${summary.success ?? 0}</span>
        </summary>
        <div class="result-group-body">
          <div class="muted-inline">started:${esc(item?.started_at || '-')} · finished:${esc(item?.finished_at || '-')}</div>
          <div class="result-group-detail"></div>
        </div>
      </details>
    `;
  }).join('');

  const groups = resultsGroups.querySelectorAll('.result-group');
  groups.forEach((group) => {
    group.addEventListener('toggle', () => {
      if (group.open && group.dataset.loaded !== '1') {
        loadResultGroupDetail(group);
      }
    });
  });
  const firstOpen = Array.from(groups).find((g) => g.open);
  if (firstOpen && firstOpen.dataset.loaded !== '1') {
    loadResultGroupDetail(firstOpen);
  }
}

async function loadResultGroupDetail(groupEl) {
  const fingerprint = groupEl.dataset.fingerprint || '';
  const detailEl = groupEl.querySelector('.result-group-detail');
  if (!detailEl || !fingerprint) return;
  detailEl.innerHTML = '<div class="muted-inline">載入中…</div>';
  try {
    const res = await fetch(`/api/results?fingerprint=${encodeURIComponent(fingerprint)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.exists) {
      detailEl.innerHTML = '<div class="alert alert-info">此 fingerprint 無資料</div>';
      groupEl.dataset.loaded = '1';
      return;
    }
    detailEl.innerHTML = renderFingerprintDetail(data.scorecard, data.benchmark);
    groupEl.dataset.loaded = '1';
  } catch (err) {
    detailEl.innerHTML = `<div class="alert alert-error">載入失敗: ${esc(err.message)}</div>`;
  }
}

function renderFingerprintDetail(scorecard, benchmark) {
  const scoreItems = Array.isArray(scorecard?.items) ? scorecard.items : [];
  const benchmarkItems = Array.isArray(benchmark?.items) ? benchmark.items : [];
  if (!scoreItems.length) return '<div class="alert alert-info">無 scorecard 資料</div>';

  const benchmarkByModel = new Map();
  benchmarkItems.forEach((item) => {
    const key = `${item?.provider_type || ''}::${item?.mode || ''}::${item?.api_base || ''}::${item?.model || ''}`;
    benchmarkByModel.set(key, item);
  });

  const providerGroups = new Map();
  scoreItems.forEach((item) => {
    const pkey = `${item?.provider_type || ''}::${item?.mode || ''}::${item?.api_base || ''}`;
    if (!providerGroups.has(pkey)) {
      providerGroups.set(pkey, {
        provider_type: item?.provider_type || '',
        mode: item?.mode || '',
        api_base: item?.api_base || '',
        items: [],
      });
    }
    const mkey = `${item?.provider_type || ''}::${item?.mode || ''}::${item?.api_base || ''}::${item?.model || ''}`;
    providerGroups.get(pkey).items.push({
      ...item,
      benchmark: benchmarkByModel.get(mkey) || null,
    });
  });

  const providers = Array.from(providerGroups.values()).sort((a, b) => {
    const ak = `${a.api_base}::${a.provider_type}::${a.mode}`;
    const bk = `${b.api_base}::${b.provider_type}::${b.mode}`;
    return ak.localeCompare(bk);
  });

  return providers.map((provider) => renderProviderGroup(provider)).join('');
}

function renderProviderGroup(provider) {
  const sortedItems = (provider.items || []).slice().sort((a, b) => {
    if (a.success !== b.success) return b.success ? 1 : -1;
    return (a.total_time_ms ?? Infinity) - (b.total_time_ms ?? Infinity);
  });
  const success = sortedItems.filter((item) => item.success).length;
  const total = sortedItems.length;

  return `
    <details class="provider-group">
      <summary>
        <code class="truncate-code" title="${esc(provider.api_base)}">${esc(provider.api_base)}</code>
        <span class="muted-inline">type:${esc(provider.provider_type)} · mode:${esc(provider.mode)} · ${success}/${total}</span>
      </summary>
      <div class="model-list">
        ${sortedItems.map((item) => renderModelCard(item)).join('')}
      </div>
    </details>
  `;
}

function renderModelCard(item) {
  const benchmark = item?.benchmark;
  const benchmarkAvg = benchmark ? fmtNum(benchmark.avg_total_time_ms) : '-';
  const benchmarkText = benchmarkAvg === '-' ? '-' : `${benchmarkAvg}ms`;
  const totalMs = fmtNum(item?.total_time_ms);
  const totalText = totalMs === '-' ? '-' : `${totalMs}ms`;
  const status = item?.success
    ? '<span class="status-ok">success</span>'
    : '<span class="status-fail">failed</span>';
  return `
    <div class="model-item">
      <div class="model-head">
        <code class="truncate-code" title="${esc(item?.model || '')}">${esc(item?.model || '-')}</code>
        ${status}
        <span class="muted-inline">${totalText}</span>
      </div>
      <div class="model-meta">${renderStatusSummary(item)}</div>
      <div class="model-meta"><span class="preview-label">benchmark avg:</span> ${benchmarkText}</div>
      <div class="model-preview">${renderResultPreview(item)}</div>
    </div>
  `;
}

function shortFingerprint(value) {
  const s = typeof value === 'string' ? value : '';
  if (!s) return '-';
  if (s.length <= 16) return s;
  return `${s.slice(0, 12)}...${s.slice(-6)}`;
}

function renderResultPreview(item) {
  const answer = item?.answer_preview || '';
  const thinking = item?.thinking_preview || '';
  const errMsg = item?.error_message_preview || '';

  const lines = [];
  if (errMsg) lines.push(`<div><span class="preview-label">error:</span> ${esc(errMsg)}</div>`);
  if (answer) lines.push(`<div><span class="preview-label">answer:</span> ${esc(answer)}</div>`);
  if (thinking) lines.push(`<div><span class="preview-label">thinking:</span> ${esc(thinking)}</div>`);

  if (!lines.length) return '<span class="muted-inline">-</span>';
  return `<details class="preview-details"><summary>查看</summary>${lines.join('')}</details>`;
}

function renderStatusSummary(item) {
  const lines = [];
  lines.push(
    item?.success
      ? '<span class="status-ok">success</span>'
      : '<span class="status-fail">failed</span>',
  );
  lines.push(
    `answer:${item?.has_answer ? '<span class="status-ok">yes</span>' : '<span class="status-fail">no</span>'}`,
  );
  lines.push(
    `thinking:${item?.has_thinking ? '<span class="status-ok">yes</span>' : '<span class="status-warn">no</span>'}`,
  );
  const err = item?.error_type ? esc(item.error_type) : '-';
  const retry = item?.retry_count ?? 0;
  lines.push(`<span class="muted-inline">error:${err} retry:${retry}</span>`);
  return `<div class="status-summary">${lines.join(' · ')}</div>`;
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
  const root = document.documentElement;

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

  token = localStorage.getItem(TOKEN_STORAGE_KEY) || '';

  if (token) {
    const ok = await checkAuth();
    if (ok) {
      authOverlay.classList.remove('active');
      initApp();
    }
    else {
      token = '';
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      authOverlay.classList.add('active');
    }
  }

  root.classList.remove('auth-checking');
})();
