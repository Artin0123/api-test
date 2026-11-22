// Split from the original app.js; loaded in original order (see index.html).
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
        applyFetchedSettings({
          settings: mock.settings,
          storage_backend: mock.storage_backend || "d1",
        });
      } else {
        const d = await api("/api/settings", { auth: true });
        if (reqId !== state.reqSeq.results) return;
        applyFetchedSettings(d);
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
        <button class="btn btn-ghost btn-xs btn-icon copy-btn" data-copy-val="${escAttr(validKeys.join("\n"))}" type="button" title="复制全部有效 Key" aria-label="复制全部有效 Key"${validKeys.length ? "" : " disabled"}>${COPY_ICON_SVG}</button>
      </div>
      <div class="lined-editor result-lined-editor result-editor-box">
        <div class="line-nums" aria-hidden="true"></div>
        <textarea class="copy-textarea lined-textarea" readonly spellcheck="false">${esc(validKeys.join("\n"))}</textarea>
      </div>
    </div>

    <div class="result-section">
      <div class="section-title">
        有效模型
        <span class="badge badge-ok">${provenModels.length}</span>
        <button class="btn btn-ghost btn-xs btn-icon copy-btn" data-copy-val="${escAttr(provenModels.join(","))}" type="button" title="复制全部有效模型" aria-label="复制全部有效模型"${provenModels.length ? "" : " disabled"}>${COPY_ICON_SVG}</button>
      </div>
      <div class="lined-editor lined-editor--wrap result-lined-editor result-editor-box">
        <div class="line-nums" aria-hidden="true"></div>
        <textarea class="copy-textarea lined-textarea" readonly spellcheck="false">${esc(provenModels.join(","))}</textarea>
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
      <p class="mono-list muted">${failedModels.length ? esc(failedModels.join(", ")) : "(none)"}</p>
    </div>

    <div class="result-section">
      <div class="section-title">
        失效 Key
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
