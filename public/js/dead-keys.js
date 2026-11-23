// Split from the original app.js; loaded in original order (see index.html).
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
  return null;
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
    const label = providerFormatLabel(e.provider, e.host);
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
  if (includeAll) opts.push(`<option value="">全部</option>`);
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

// ── Dead keys tab ─────────────────────────────────────────────────────────

function fillCodeSelect() {
  const selected = dom.dkFCode.value;
  const codes = [];
  for (const r of state.deadKeys) {
    if (!r || r.error_code == null) continue;
    const n = Number(r.error_code);
    if (!Number.isFinite(n)) continue;
    if (!codes.includes(n)) codes.push(n);
  }
  codes.sort((a, b) => a - b);

  const opts = [`<option value="">全部</option>`];
  for (const c of codes) {
    opts.push(`<option value="${escAttr(String(c))}">${esc(String(c))}</option>`);
  }
  dom.dkFCode.innerHTML = opts.join("");
  if (selected && codes.includes(Number(selected))) {
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
        applyFetchedSettings({
          settings: mock.settings,
          storage_backend: mock.storage_backend || "d1",
        });
      } else {
        const d = await api("/api/settings", { auth: true });
        if (reqId !== state.reqSeq.deadkeys) return;
        applyFetchedSettings(d);
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

function bindDateFilterInput(input, onChange = renderDeadKeys) {
  if (!input) return;
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
    onChange();
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
    onChange();
  });

  if (picker) {
    picker.addEventListener("change", () => {
      input.value = picker.value ? picker.value.replace(/-/g, "/") : "";
      sync(false);
      onChange();
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

function filteredDeadKeys() {
  const scope = dom.dkFHost.value;
  const scopeEntry = scope
    ? dkProviderEntries().find((e) => (e.fp || e.host) === scope)
    : null;
  const q = dom.dkFKey.value.trim().toLowerCase();
  const code = dom.dkFCode.value;
  const to = parseFilterDate(dom.dkFTo.value);

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
    if (code && Number(r.error_code) !== Number(code)) return false;
    if (to) {
      const d = dkDateOf(r);
      if (!d || d > to) return false;
    }
    return true;
  });
}

/**Order rows by provider order (providers that are gone go last), keeping
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
          ${dkSortHead("code", "状态码", "dk-code-col")}
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
