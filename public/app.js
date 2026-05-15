const API_BASE = '';
const TOKEN_STORAGE_KEY = 'api_test_admin_token';

let token = '';
let currentProviders = [];
let keysRevealed = false;

const authOverlay = document.getElementById('auth-overlay');
const authTokenInput = document.getElementById('auth-token');
const authBtn = document.getElementById('auth-btn');
const authError = document.getElementById('auth-error');
const logoutBtn = document.getElementById('logout-btn');

const configLoading = document.getElementById('config-loading');
const configError = document.getElementById('config-error');
const providersTableWrap = document.getElementById('providers-table-wrap');
const providersTbody = document.getElementById('providers-tbody');
const addProviderBtn = document.getElementById('add-provider-btn');
const revealKeysBtn = document.getElementById('reveal-keys-btn');
const providerFormCard = document.getElementById('provider-form-card');
const providerForm = document.getElementById('provider-form');
const cancelFormBtn = document.getElementById('cancel-form-btn');
const formTitle = document.getElementById('form-title');
const formIndex = document.getElementById('form-index');
const formError = document.getElementById('form-error');
const providerTypeHelpBtn = document.getElementById('provider-type-help-btn');
const providerTypeHelp = document.getElementById('provider-type-help');
const providerTypeSelect = document.getElementById('p-provider_type');
const modelsListInput = document.getElementById('p-models_list');

const refreshResultsBtn = document.getElementById('refresh-results-btn');
const resultsLoading = document.getElementById('results-loading');
const resultsError = document.getElementById('results-error');
const noResults = document.getElementById('no-results');
const resultsContent = document.getElementById('results-content');
const resultsGroups = document.getElementById('results-groups');

const detailOverlay = document.getElementById('detail-overlay');
const detailCloseBtn = document.getElementById('detail-close-btn');
const detailTitle = document.getElementById('detail-title');
const detailSubtitle = document.getElementById('detail-subtitle');
const detailContent = document.getElementById('detail-content');

const DEFAULT_ENDPOINT_HINT = {
  openai: '/chat/completions',
  ollama: '/api/chat',
  gemini: '/models/{model}:streamGenerateContent?alt=sse',
};

authBtn.addEventListener('click', async () => {
  token = authTokenInput.value.trim();
  if (!token) {
    authError.textContent = '请输入 token';
    return;
  }
  authError.textContent = '';
  const ok = await checkAuth();
  if (!ok) {
    authError.textContent = '认证失败，请确认 MASTER_API_TOKEN 是否正确';
    token = '';
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    authOverlay.classList.add('active');
    document.documentElement.classList.remove('auth-checking');
    return;
  }
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
  authOverlay.classList.remove('active');
  authTokenInput.value = '';
  document.documentElement.classList.remove('auth-checking');
  initApp();
});

logoutBtn.addEventListener('click', () => {
  token = '';
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  authOverlay.classList.add('active');
  authTokenInput.value = '';
});

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

async function checkAuth() {
  try {
    const response = await fetch('/api/config', { headers: authHeaders() });
    return response.ok;
  } catch {
    return false;
  }
}

function initApp() {
  loadConfig();
  loadResults();
}

document.querySelectorAll('.tab-btn').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
    button.classList.add('active');
    document.getElementById(`tab-${button.dataset.tab}`).classList.add('active');
    if (button.dataset.tab === 'results') {
      loadResults();
    }
  });
});

function normalizeModelsText(raw) {
  const pieces = String(raw || '')
    .split(/[\n,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
  return pieces.join(', ');
}

function parseModelsList(raw) {
  const normalizedText = normalizeModelsText(raw);
  if (!normalizedText) {
    return [];
  }
  return normalizedText.split(', ').filter(Boolean);
}

function formatModelsList(modelsList) {
  return (Array.isArray(modelsList) ? modelsList : []).join(', ');
}

function providerFingerprint(provider) {
  // 前端只用同一套输入字段算展示用 fingerprint，真正存储仍以后端为准。
  const payload = JSON.stringify({
    api_base: String(provider.api_base || '').trim().replace(/\/+$/, ''),
    mode: provider.mode,
    provider_type: provider.provider_type,
  });
  return sha256Hex(payload);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function endpointHintText(providerType) {
  return `此类型会自动使用固定 endpoint: ${DEFAULT_ENDPOINT_HINT[providerType] || '-'}`;
}

function updateProviderTypeHint() {
  providerTypeHelp.textContent = endpointHintText(providerTypeSelect.value);
}

providerTypeHelpBtn.addEventListener('click', () => {
  updateProviderTypeHint();
  providerTypeHelp.classList.toggle('hidden');
});

providerTypeSelect.addEventListener('change', updateProviderTypeHint);

modelsListInput.addEventListener('blur', () => {
  modelsListInput.value = normalizeModelsText(modelsListInput.value);
});

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

providerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.textContent = '';

  const index = Number(formIndex.value);
  const existing = index >= 0 ? currentProviders[index] : null;
  const apiKeyInput = document.getElementById('p-api_key').value.trim();
  const modelsList = parseModelsList(modelsListInput.value);
  const provider = {
    provider_type: document.getElementById('p-provider_type').value,
    mode: document.getElementById('p-mode').value,
    api_base: document.getElementById('p-api_base').value.trim(),
    api_key: apiKeyInput || existing?.api_key || '',
    tester_enabled: document.getElementById('p-tester-enabled').checked,
    benchmark_enabled: document.getElementById('p-benchmark-enabled').checked,
    models_list: modelsList,
  };

  if (!provider.provider_type || !provider.mode || !provider.api_base) {
    formError.textContent = '请填写所有必填栏位';
    return;
  }
  if (!provider.models_list.length) {
    formError.textContent = 'models_list 不能为空';
    return;
  }
  if (index < 0 && !apiKeyInput) {
    formError.textContent = '新增 provider 时必须填写 api_key';
    return;
  }

  const nextProviders = currentProviders.slice();
  if (index >= 0) {
    nextProviders[index] = provider;
  } else {
    nextProviders.push(provider);
  }

  const duplicateKeys = new Set();
  for (const item of nextProviders) {
    const key = `${item.provider_type}::${item.mode}::${String(item.api_base || '').trim().replace(/\/+$/, '')}`;
    if (duplicateKeys.has(key)) {
      formError.textContent = 'provider_type + mode + api_base 不可重复';
      return;
    }
    duplicateKeys.add(key);
  }

  const result = await saveConfig(nextProviders);
  if (!result.ok) {
    formError.textContent = result.error || '储存失败';
    return;
  }

  providerFormCard.classList.add('hidden');
  await loadConfig(keysRevealed);
});

async function loadConfig(full = false) {
  configLoading.classList.remove('hidden');
  configError.classList.add('hidden');
  providersTableWrap.classList.add('hidden');

  try {
    const url = full ? '/api/config?full=1' : '/api/config';
    const response = await fetch(url, { headers: authHeaders() });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    currentProviders = Array.isArray(data.providers) ? data.providers : [];
    keysRevealed = full;
    revealKeysBtn.textContent = full ? '已显示完整 key' : '显示完整 key';
    revealKeysBtn.disabled = full;
    renderProviders();
    configLoading.classList.add('hidden');
    providersTableWrap.classList.remove('hidden');
  } catch (err) {
    configLoading.classList.add('hidden');
    configError.textContent = `读取失败: ${err.message}`;
    configError.classList.remove('hidden');
  }
}

function renderProviders() {
  providersTbody.innerHTML = '';
  if (!currentProviders.length) {
    providersTbody.innerHTML = '<tr><td colspan="8" class="cell-empty">尚未新增 provider</td></tr>';
    return;
  }

  currentProviders.forEach((provider, index) => {
    const testerEnabled = provider.tester_enabled !== false;
    const benchmarkEnabled = provider.benchmark_enabled !== false;
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${esc(provider.provider_type)}</td>
      <td>${esc(provider.mode)}</td>
      <td><code>${esc(provider.api_base)}</code></td>
      <td>${esc(formatModelsList(provider.models_list))}</td>
      <td>${testerEnabled ? '<span class="status-ok">on</span>' : '<span class="status-fail">off</span>'}</td>
      <td>${benchmarkEnabled ? '<span class="status-ok">on</span>' : '<span class="status-fail">off</span>'}</td>
      <td>${esc(provider.api_key)}</td>
      <td class="cell-actions">
        <button class="btn btn-sm btn-ghost" data-action="edit" data-idx="${index}">编辑</button>
        <button class="btn btn-sm btn-danger" data-action="delete" data-idx="${index}">删除</button>
      </td>
    `;
    providersTbody.appendChild(row);
  });

  providersTbody.querySelectorAll('[data-action="edit"]').forEach((button) => {
    button.addEventListener('click', () => editProvider(Number(button.dataset.idx)));
  });
  providersTbody.querySelectorAll('[data-action="delete"]').forEach((button) => {
    button.addEventListener('click', () => deleteProvider(Number(button.dataset.idx)));
  });
}

function editProvider(index) {
  const provider = currentProviders[index];
  formIndex.value = String(index);
  formTitle.textContent = '编辑 Provider';
  document.getElementById('p-provider_type').value = provider.provider_type;
  document.getElementById('p-mode').value = provider.mode;
  document.getElementById('p-api_base').value = provider.api_base;
  document.getElementById('p-api_key').value = '';
  document.getElementById('p-tester-enabled').checked = provider.tester_enabled !== false;
  document.getElementById('p-benchmark-enabled').checked = provider.benchmark_enabled !== false;
  modelsListInput.value = formatModelsList(provider.models_list);
  updateProviderTypeHint();
  providerFormCard.classList.remove('hidden');
  providerFormCard.scrollIntoView({ behavior: 'smooth' });
}

async function deleteProvider(index) {
  const provider = currentProviders[index];
  if (!confirm(`确定删除 ${provider.api_base} ?`)) {
    return;
  }
  const nextProviders = currentProviders.filter((_, idx) => idx !== index);
  const result = await saveConfig(nextProviders);
  if (!result.ok) {
    alert(result.error || '删除失败');
    return;
  }
  await loadConfig(keysRevealed);
}

function resetForm() {
  formIndex.value = '-1';
  formTitle.textContent = '新增 Provider';
  providerForm.reset();
  document.getElementById('p-tester-enabled').checked = true;
  document.getElementById('p-benchmark-enabled').checked = true;
  modelsListInput.value = '';
  providerTypeHelp.classList.add('hidden');
  updateProviderTypeHint();
  formError.textContent = '';
}

async function saveConfig(providers) {
  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: data.error || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

refreshResultsBtn.addEventListener('click', loadResults);

async function loadResults() {
  resultsLoading.classList.remove('hidden');
  resultsError.classList.add('hidden');
  noResults.classList.add('hidden');
  resultsContent.classList.add('hidden');

  try {
    const configResponse = await fetch('/api/config', { headers: authHeaders() });
    const configData = await configResponse.json();
    if (!configResponse.ok) {
      throw new Error(configData.error || `HTTP ${configResponse.status}`);
    }

    const providers = Array.isArray(configData.providers) ? configData.providers : [];
    if (!providers.length) {
      resultsLoading.classList.add('hidden');
      noResults.classList.remove('hidden');
      return;
    }

    const providersWithFingerprint = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        fingerprint: await providerFingerprint(provider),
      })),
    );

    const resultBundles = await Promise.all(
      providersWithFingerprint.map(async ({ provider, fingerprint }) => {
        const response = await fetch(`/api/results?fingerprint=${encodeURIComponent(fingerprint)}`);
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }
        return { provider, fingerprint, data };
      }),
    );

    const existingResults = resultBundles.filter((item) => item.data.exists);
    if (!existingResults.length) {
      resultsLoading.classList.add('hidden');
      noResults.classList.remove('hidden');
      return;
    }

    renderResults(existingResults);
    resultsLoading.classList.add('hidden');
    resultsContent.classList.remove('hidden');
  } catch (err) {
    resultsLoading.classList.add('hidden');
    resultsError.textContent = `读取失败: ${err.message}`;
    resultsError.classList.remove('hidden');
  }
}

function renderResults(items) {
  resultsGroups.innerHTML = items
    .map(({ provider, fingerprint, data }) => renderProviderResults(provider, fingerprint, data))
    .join('');

  resultsGroups.querySelectorAll('.results-provider').forEach((details) => {
    details.addEventListener('toggle', () => {
      const chevron = details.querySelector('.chevron');
      if (chevron) {
        chevron.textContent = details.open ? '▾' : '▸';
      }
    });
  });

  resultsGroups.querySelectorAll('[data-detail-payload]').forEach((button) => {
    button.addEventListener('click', () => {
      const payload = JSON.parse(button.dataset.detailPayload);
      openDetail(payload);
    });
  });
}

function renderProviderResults(provider, fingerprint, data) {
  const tester = data.tester || null;
  const benchmark = data.benchmark || null;
  const testerItems = Array.isArray(tester?.items) ? tester.items : [];
  const benchmarkItems = Array.isArray(benchmark?.items) ? benchmark.items : [];
  const benchmarkByModel = new Map(
    benchmarkItems.map((item) => [item.model, item]),
  );

  const rows = testerItems
    .slice()
    .sort((a, b) => {
      if (a.success !== b.success) return a.success ? -1 : 1;
      return (a.total_time_ms ?? Infinity) - (b.total_time_ms ?? Infinity);
    })
    .map((item) => renderResultRow(item, benchmarkByModel.get(item.model) || null))
    .join('');

  return `
    <details class="results-provider" open>
      <summary class="results-provider-summary">
        <span class="chevron">▾</span>
        <span class="group-title">${esc(provider.api_base)}</span>
        <span class="muted-inline">type:${esc(provider.provider_type)} / mode:${esc(provider.mode)} / fp:${esc(shortFingerprint(fingerprint))}</span>
      </summary>
      <div class="provider-config-strip">
        <span><strong>provider_type</strong>: ${esc(provider.provider_type)}</span>
        <span><strong>mode</strong>: ${esc(provider.mode)}</span>
        <span><strong>api_base</strong>: <code>${esc(provider.api_base)}</code></span>
        <span><strong>models_list</strong>: ${esc(formatModelsList(provider.models_list))}</span>
      </div>
      <div class="results-table-wrap">
        <table class="data-table results-table">
          <thead>
            <tr>
              <th>model</th>
              <th>status</th>
              <th>tester total_time</th>
              <th>benchmark avg</th>
              <th>error_type</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="6" class="cell-empty">没有 tester 结果</td></tr>'}
          </tbody>
        </table>
      </div>
    </details>
  `;
}

function renderResultRow(item, benchmark) {
  const detailPayload = {
    title: item.model || '-',
    subtitle: `${item.provider_type} / ${item.mode} / ${item.api_base}`,
    item,
    benchmark,
  };
  return `
    <tr>
      <td><code>${esc(item.model || '-')}</code></td>
      <td>${item.success ? '<span class="status-ok">success</span>' : '<span class="status-fail">failed</span>'}</td>
      <td>${fmtMs(item.total_time_ms)}</td>
      <td>${benchmark ? fmtMs(benchmark.avg_total_time_ms) : '-'}</td>
      <td>${esc(item.error_type || '-')}</td>
      <td><button type="button" class="btn btn-sm btn-ghost" data-detail-payload="${escAttr(JSON.stringify(detailPayload))}">详情</button></td>
    </tr>
  `;
}

function openDetail(payload) {
  detailTitle.textContent = payload.title || '详情';
  detailSubtitle.textContent = payload.subtitle || '';
  detailContent.innerHTML = `
    <div class="detail-section">
      <h4>Tester</h4>
      <div class="detail-grid">
        <div><strong>success</strong>: ${payload.item?.success ? 'true' : 'false'}</div>
        <div><strong>has_answer</strong>: ${payload.item?.has_answer ? 'true' : 'false'}</div>
        <div><strong>has_thinking</strong>: ${payload.item?.has_thinking ? 'true' : 'false'}</div>
        <div><strong>retry_count</strong>: ${payload.item?.retry_count ?? 0}</div>
        <div><strong>total_time_ms</strong>: ${fmtMs(payload.item?.total_time_ms)}</div>
        <div><strong>error_type</strong>: ${esc(payload.item?.error_type || '-')}</div>
      </div>
      <pre class="detail-pre"><strong>answer</strong>\n${esc(payload.item?.answer_preview || '')}</pre>
      <pre class="detail-pre"><strong>thinking</strong>\n${esc(payload.item?.thinking_preview || '')}</pre>
      <pre class="detail-pre"><strong>error</strong>\n${esc(payload.item?.error_message_preview || '')}</pre>
    </div>
    <div class="detail-section">
      <h4>Benchmark</h4>
      ${renderBenchmarkDetail(payload.benchmark)}
    </div>
  `;
  detailOverlay.classList.remove('hidden');
}

function renderBenchmarkDetail(benchmark) {
  if (!benchmark) {
    return '<p class="form-note">没有 benchmark 结果。</p>';
  }
  const runs = Array.isArray(benchmark.runs) ? benchmark.runs : [];
  return `
    <div class="detail-grid">
      <div><strong>avg_total_time_ms</strong>: ${fmtMs(benchmark.avg_total_time_ms)}</div>
      <div><strong>runs</strong>: ${runs.length}</div>
    </div>
    <table class="data-table detail-runs-table">
      <thead>
        <tr>
          <th>run_index</th>
          <th>total_time_ms</th>
          <th>ttft_ms</th>
          <th>output_chars</th>
          <th>error</th>
        </tr>
      </thead>
      <tbody>
        ${runs.map((run) => `
          <tr>
            <td>${run.run_index}</td>
            <td>${fmtMs(run.total_time_ms)}</td>
            <td>${run.ttft_ms == null ? '-' : fmtMs(run.ttft_ms)}</td>
            <td>${run.output_chars ?? 0}</td>
            <td>${esc(run.error || '-')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

detailCloseBtn.addEventListener('click', closeDetail);
detailOverlay.addEventListener('click', (event) => {
  if (event.target.dataset.closeDetail === '1') {
    closeDetail();
  }
});

function closeDetail() {
  detailOverlay.classList.add('hidden');
}

function shortFingerprint(value) {
  const text = String(value || '');
  if (!text) return '-';
  if (text.length <= 18) return text;
  return `${text.slice(0, 12)}...${text.slice(-6)}`;
}

function fmtMs(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return '-';
  }
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}ms`;
}

function esc(value) {
  if (value == null) return '';
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function escAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

(async () => {
  try {
    const envResponse = await fetch('/api/env');
    if (envResponse.ok) {
      const envData = await envResponse.json();
      if (envData.github_actions_url) {
        document.getElementById('run-now-btn').href = envData.github_actions_url;
      }
    }
  } catch {}

  token = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  if (token) {
    const ok = await checkAuth();
    if (ok) {
      authOverlay.classList.remove('active');
      initApp();
    } else {
      token = '';
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      authOverlay.classList.add('active');
    }
  }

  updateProviderTypeHint();
  document.documentElement.classList.remove('auth-checking');
})();
