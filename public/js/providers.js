// Split from the original app.js; loaded in original order (see index.html).
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
  updateBulkBtnState();
}

function renderProviderCard(p, index) {
  // With an alias set, the alias is the card's name: it is what the provider is
  // addressed by (`/proxy/{alias}`), and the upstream domain is then only a
  // detail. Both stay reachable — the real api_base is the tooltip, the alias
  // alone when there is one.
  const host = extractHost(p.api_base);
  const alias = (p.alias || "").trim();
  const keyCount = (p.keys || "").split("\n").filter((l) => l.trim()).length;
  const modelCount = splitModels(p.models).length;
  const isEnabled = p.enabled !== false;
  const isSelected = state.selectedProviders.has(index);

  return `
    <div class="provider-card${isEnabled ? "" : " provider-card--disabled"}${isSelected ? " provider-card--selected" : ""}" data-card="${index}">
      <div class="provider-card-header">
        <label class="provider-card-select" title="选中以批量操作">
          <input type="checkbox" data-select="${index}"${isSelected ? " checked" : ""} />
        </label>
        <div class="provider-card-badges">
          <span class="badge">${esc(p.provider_type)}</span>
        </div>
        <div class="provider-card-actions">
          <button class="btn btn-secondary btn-sm" data-edit="${index}" type="button">编辑</button>
          <button class="btn btn-danger btn-sm" data-delete="${index}" type="button">删除</button>
        </div>
      </div>
      <div class="provider-card-host" title="${escAttr(p.api_base)}">${esc(alias || host)}</div>
      <div class="provider-card-meta">
        ${isEnabled ? "" : `<span class="provider-card-state-tag">已停用</span>`}
        <span class="provider-card-counts">
          <span><strong>${keyCount}</strong> 个 Key</span>
          <span><strong>${modelCount}</strong> 个模型</span>
          ${p.max_concurrency != null ? `<span>并发: <strong>${p.max_concurrency}</strong></span>` : ""}
        </span>
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
  keyInput.placeholder = "X-Custom-Auth";
  keyInput.setAttribute("aria-label", "请求头名称");
  keyInput.dataset.headerKey = "";
  keyInput.value = key;

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.className = "input-text";
  valueInput.autocomplete = "off";
  valueInput.spellcheck = false;
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

function hideEditorConfirm({ keepError = false } = {}) {
  dom.editorConfirm.classList.add("hidden");
  dom.editorConfirmList.replaceChildren();
  state.editorPendingRemoved = null;
  dom.editorSave.classList.remove("btn-danger-solid");
  dom.editorSave.classList.add("btn-primary");
  if (!keepError) dom.editorError.textContent = "";
}

function showEditorConfirm(removed) {
  dom.editorConfirmList.replaceChildren();
  for (const key of removed) {
    const li = document.createElement("li");
    li.textContent = maskKey(key);
    dom.editorConfirmList.appendChild(li);
  }
  dom.editorConfirm.classList.remove("hidden");
  dom.editorError.textContent = `即将删除 ${removed.length} 支密钥；确认后才会储存。`;
  dom.editorSave.classList.remove("btn-primary");
  dom.editorSave.classList.add("btn-danger-solid");
  dom.editorSave.focus();
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
    for (; ;) {
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
  dom.edSortKeysBtn.textContent = SORT_LABELS[state.editorSortMode];
  syncLineNums(dom.edKeys);
  syncKeysHighlight();
}

function exportEditorKeys() {
  const keys = splitKeyLines(dom.edKeys.value);
  if (!keys.length) {
    hideEditorConfirm({ keepError: true });
    dom.editorError.textContent = "没有可导出的密钥";
    return;
  }
  if (!state.editorPendingRemoved) dom.editorError.textContent = "";
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

function syncEditorTestPathVisibility() {
  if (!dom.edTestPathField) return;
  dom.edTestPathField.classList.toggle(
    "hidden",
    dom.edProviderType.value === "google",
  );
}
if (dom.edProviderType) {
  dom.edProviderType.addEventListener("change", syncEditorTestPathVisibility);
}

function openEditor(index = -1) {
  dom.editorIndex.value = String(index);
  dom.editorError.textContent = "";

  if (index >= 0) {
    const p = ((state.settings || {}).providers || [])[index] || {};
    dom.editorTitle.textContent = "编辑服务商";
    dom.edProviderType.value = p.provider_type || "openai";
    syncCustomSelect(dom.edProviderType);
    dom.edApiBase.value = p.api_base || "";
    dom.edKeys.value = p.keys || "";
    dom.edModels.value = p.models || "";
    dom.edExtraBody.value = p.extra_body || "";
    dom.edAlias.value = p.alias || "";
    dom.edTestPath.value = p.test_path || "";
    renderEditorHeaders(p.custom_headers);
    dom.edMaxConcurrency.value =
      p.max_concurrency != null ? String(p.max_concurrency) : "";
  } else {
    dom.editorTitle.textContent = "新增服务商";
    dom.edProviderType.value = "openai";
    syncCustomSelect(dom.edProviderType);
    dom.edApiBase.value = "";
    dom.edKeys.value = "";
    dom.edModels.value = "";
    dom.edExtraBody.value = "";
    dom.edAlias.value = "";
    dom.edTestPath.value = "";
    renderEditorHeaders([]);
    dom.edMaxConcurrency.value = "";
  }
  dom.edExtraBodyStatus.textContent = "";
  dom.edExtraBodyStatus.className = "json-status";
  state.editorSortMode = "none";
  dom.edSortKeysBtn.textContent = SORT_LABELS.none;
  // A query left over from the last time the editor was open would paint marks
  // on a provider the user never searched in.
  if (dom.edKeysSearch) dom.edKeysSearch.value = "";
  syncSearchClearButton();
  hideEditorConfirm();
  state.editorSnapshot = dom.edKeys.value;
  openModal(dom.editorOverlay, dom.edApiBase);
  // Sync line numbers after values are populated
  syncLineNums(dom.edKeys);
  syncLineNums(dom.edModels);
  syncEditorTestPathVisibility();
  syncLineNums(dom.edExtraBody);
  syncKeysHighlight();
}

function closeEditor() {
  hideEditorConfirm();
  closeModal(dom.editorOverlay);
}

function canonicalProvider(p) {
  const item = p && typeof p === "object" ? p : {};
  return {
    enabled: item.enabled !== false,
    provider_type:
      typeof item.provider_type === "string" ? item.provider_type : "openai",
    api_base: typeof item.api_base === "string" ? item.api_base : "",
    keys: typeof item.keys === "string" ? item.keys : "",
    models: typeof item.models === "string" ? item.models : "",
    extra_body: typeof item.extra_body === "string" ? item.extra_body : "",
    custom_headers: Array.isArray(item.custom_headers)
      ? item.custom_headers.map((h) => ({
        key: String(h?.key ?? ""),
        value: String(h?.value ?? ""),
      }))
      : [],
    max_concurrency:
      item.max_concurrency != null ? Number(item.max_concurrency) : null,
    alias: typeof item.alias === "string" ? item.alias : "",
    test_path: typeof item.test_path === "string" ? item.test_path : "",
  };
}

function providersEqual(a, b) {
  const ca = canonicalProvider(a);
  const cb = canonicalProvider(b);
  if (
    ca.enabled !== cb.enabled ||
    ca.provider_type !== cb.provider_type ||
    ca.api_base !== cb.api_base ||
    ca.keys !== cb.keys ||
    ca.models !== cb.models ||
    ca.extra_body !== cb.extra_body ||
    ca.max_concurrency !== cb.max_concurrency ||
    ca.alias !== cb.alias ||
    ca.test_path !== cb.test_path ||
    ca.custom_headers.length !== cb.custom_headers.length
  ) {
    return false;
  }
  return ca.custom_headers.every(
    (h, i) =>
      h.key === cb.custom_headers[i].key &&
      h.value === cb.custom_headers[i].value,
  );
}

const MAX_PROVIDER_KEYS = 999;
const FRONTEND_PROXY_ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function hasFrontendPathTraversal(rawPath) {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)|%(?:25)*2e|%(?:25)*5c/i.test(
    String(rawPath || ""),
  );
}

function isFrontendPrivateIp(hostname) {
  const raw = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (
    !raw ||
    raw === "127.0.0.1" ||
    raw === "localhost" ||
    raw === "::1"
  ) {
    return false;
  }
  const m = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (raw.includes(":")) {
    if (raw === "::" || raw.startsWith("::ffff:")) return true;
    if (/^(?:fc|fd)[0-9a-f]{0,2}:/.test(raw)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(raw)) return true;
    if (raw.startsWith("ff")) return true;
  }
  return false;
}

function validateFrontendApiBase(rawBase) {
  if (!rawBase) return "请填写 API Base URL";
  if (hasFrontendPathTraversal(rawBase)) {
    return "API Base URL 不能包含路径穿越片段 (..)";
  }
  let parsed;
  try {
    parsed = new URL(rawBase);
  } catch {
    return "API Base URL 不是有效的网址";
  }
  if (parsed.username || parsed.password) {
    return "API Base URL 不能包含帐号或密码";
  }
  if (parsed.search) {
    return "API Base URL 不能包含查询参数 (?query)";
  }
  if (parsed.hash) {
    return "API Base URL 不能包含片段 (#fragment)";
  }
  if (
    typeof location !== "undefined" &&
    location.host &&
    parsed.host &&
    parsed.host.toLowerCase() === location.host.toLowerCase()
  ) {
    return "API Base URL 不能指向当前代理站点自身";
  }
  const h = String(parsed.hostname || "").toLowerCase();
  const isLoopback =
    h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  if (isFrontendPrivateIp(h)) {
    return "API Base URL 不能指向内网或保留 IP 位址";
  }
  if (parsed.protocol === "https:") {
    return h ? null : "API Base URL 缺少有效域名";
  }
  if (parsed.protocol === "http:" && isLoopback) {
    return null;
  }
  return "API Base URL 必须以 https:// 开头（本机测试仅允许 http://127.0.0.1 或 http://localhost）";
}

async function saveEditor() {
  const confirmed = Boolean(state.editorPendingRemoved);
  if (!confirmed) dom.editorError.textContent = "";
  const failValidation = (msg) => {
    hideEditorConfirm({ keepError: true });
    dom.editorError.textContent = msg;
  };
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

  const apiBaseErr = validateFrontendApiBase(apiBase);
  if (apiBaseErr) return failValidation(apiBaseErr);
  const dupIdx = existingProviders.findIndex(
    (p, i) =>
      i !== index &&
      p &&
      (p.provider_type || "").trim() === pType &&
      (p.api_base || "").trim().replace(/\/+$/, "") === apiBase,
  );
  if (dupIdx >= 0) {
    return failValidation(`已存在相同的 ${pType} 与 API Base 服务商`);
  }
  if (!keys.trim()) return failValidation("请填写至少一个 API Key");
  const keyCount = splitKeyLines(keys).length;
  if (keyCount > MAX_PROVIDER_KEYS) {
    return failValidation(
      `最多只能保存 ${MAX_PROVIDER_KEYS} 个 API Key（当前 ${keyCount} 个）`,
    );
  }
  if (!models.trim()) return failValidation("请填写至少一个模型名");
  if (extraBodyRaw) {
    try {
      JSON.parse(extraBodyRaw);
    } catch {
      return failValidation("Extra Body 不是有效的 JSON");
    }
  }
  if (invalidHeaders.length) {
    return failValidation(`请求头名称不合法: ${invalidHeaders[0]}`);
  }

  let maxConcurrency = null;
  if (maxConcurrencyRaw !== "") {
    const n = parseInt(maxConcurrencyRaw, 10);
    if (!Number.isInteger(n) || n < 1) {
      return failValidation("Max Concurrency 必须是正整数");
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
  if (alias && !FRONTEND_PROXY_ALIAS_RE.test(alias)) {
    return failValidation(
      "转发别名只能使用小写英文、数字与连字号，且不超过 64 个字元",
    );
  }
  // Omit empty alias so a provider without forwarding keeps its minimal shape.
  if (alias) entry.alias = alias;
  if (pType !== "google") {
    const rawTestPath = dom.edTestPath.value.trim();
    if (!rawTestPath) return failValidation("请填写测试路径");
    if (
      /\s/.test(rawTestPath) ||
      rawTestPath.includes("://") ||
      rawTestPath.includes("?") ||
      rawTestPath.includes("#") ||
      hasFrontendPathTraversal(rawTestPath)
    ) {
      return failValidation(
        "测试路径只能填写不含查询参数或 .. 的相对路径（如 /v1/chat/completions）",
      );
    }
    entry.test_path = rawTestPath.startsWith("/") ? rawTestPath : "/" + rawTestPath;
  }

  if (
    index >= 0 &&
    existingProviders[index] &&
    providersEqual(existingProviders[index], entry)
  ) {
    hideEditorConfirm();
    state.editorSnapshot = null;
    state.editorSortMode = "none";
    closeEditor();
    return;
  }

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
      if (removed.length) {
        state.editorPendingRemoved = removed;
        showEditorConfirm(removed);
        return;
      }
      hideEditorConfirm();
    }
  }
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
    await ensureProviderFps(providers);
    syncMockSettings(state.settings);
    hideEditorConfirm();
    state.editorSnapshot = null;
    state.editorSortMode = "none";
    dom.configSaveError.textContent = "";
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

  dom.configSaveError.textContent = "";
  const settings = state.settings || {};
  const providers = (settings.providers || []).filter((_, i) => i !== index);

  try {
    const version = await postSettings({ providers });
    state.settings = { ...settings, providers };
    if (version !== undefined) state.settings.version = version;
    await ensureProviderFps(providers);
    syncMockSettings(state.settings);
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
  dom.configSaveError.textContent = "";
  const settings = state.settings || {};
  const providers = (settings.providers || []).map((p, i) =>
    state.selectedProviders.has(i) ? { ...p, enabled: enable } : p,
  );
  try {
    const version = await postSettings({ providers });
    state.settings = { ...settings, providers };
    if (version !== undefined) state.settings.version = version;
    await ensureProviderFps(providers);
    syncMockSettings(state.settings);
    state.selectedProviders.clear();
    renderProviderGrid();
  } catch (err) {
    dom.configSaveError.textContent = err.message;
  }
}
