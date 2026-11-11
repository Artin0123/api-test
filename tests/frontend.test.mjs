/**
 * Frontend invariants that a syntax check cannot catch:
 *  - every DOM id app.js looks up must exist in index.html (typos fail silently)
 *  - maskKey() must behave identically in app.js and _worker.js
 *  - the CSP invariants (no inline <script>, no style="" attribute)
 *
 * These parse the files instead of running a browser, so they stay fast and run
 * on every `npm test`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const html = read("index.html");
const app = read("app.js");
const worker = read("_worker.js");

test("every DOM id referenced by app.js exists in index.html", () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...app.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
  const missing = [...new Set(refs)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `app.js references missing ids: ${missing.join(", ")}`);
});

test("maskKey() is identical in app.js and _worker.js", () => {
  const body = (source) => {
    const start = source.indexOf("function maskKey");
    assert.ok(start >= 0, "maskKey not found");
    const end = source.indexOf("\n}", start);
    return source
      .slice(start, end + 2)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"))
      .join(" ");
  };
  assert.equal(body(app), body(worker));
});

test("the page keeps the CSP invariants", () => {
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "no inline <script> in index.html");
  assert.ok(!/\sstyle="/i.test(html), 'no style="" attribute in index.html');
  assert.ok(!/\sstyle="/i.test(app), 'app.js must not build style="" attributes');
});

test("proxy assets referenced by the page exist in style.css", () => {
  const css = read("style.css");
  for (const cls of [
    "proxy-toolbar",
    "proxy-toolbar-row",
    "proxy-summary",
    "proxy-save-model",
    "proxy-key-grid",
    "proxy-key-card",
    "proxy-test-result",
    "keys-toolbar",
    "keys-search",
    "keys-search-wrap",
    "keys-search-clear",
    "keys-highlight",
    "keys-highlight-inner",
    "editor-confirm",
  ]) {
    assert.ok(css.includes(`.${cls}`), `style.css is missing .${cls}`);
  }
});

test("dead keys filter panel is always visible without manual add row or toggle", () => {
  const filterMatch = html.match(/<div\s+id="dk-filter-panel"\s+class="([^"]+)"/);
  assert.ok(filterMatch, "dk-filter-panel markup not found");
  assert.ok(
    !filterMatch[1].split(/\s+/).includes("hidden"),
    "dk-filter-panel must not start hidden",
  );
  for (const removedId of [
    "dk-host",
    "dk-key",
    "dk-expired",
    "dk-add-btn",
    "dk-filter-toggle",
    "dk-filter-count",
    "dk-form-error",
  ]) {
    assert.ok(!html.includes(`id="${removedId}"`), `index.html still has #${removedId}`);
    assert.ok(!app.includes(`"${removedId}"`), `app.js still references #${removedId}`);
  }
  for (const dateId of ["dk-f-from", "dk-f-to"]) {
    const tag = html.match(new RegExp(`<input[^>]*\\bid="${dateId}"[^>]*>`));
    assert.ok(tag, `#${dateId} input not found`);
    assert.match(tag[0], /\btype="text"/, `#${dateId} must be type="text" to hide yyyy/mm/dd`);
    assert.doesNotMatch(tag[0], /\bplaceholder=/, `#${dateId} must not have a placeholder`);
  }
  const actionsBlock = html.match(/<div\s+class="dk-filter-actions">([\s\S]*?)<\/div>/);
  assert.ok(actionsBlock, "dk-filter-actions container not found inside filter panel");
  const delIdx = actionsBlock[1].indexOf('id="dk-bulk-del-btn"');
  const resetIdx = actionsBlock[1].indexOf('id="dk-f-reset"');
  assert.ok(delIdx >= 0 && resetIdx > delIdx, "dk-bulk-del-btn must sit left of dk-f-reset");
  const resetBtn = actionsBlock[1].match(/<button[\s\S]*?id="dk-f-reset"[\s\S]*?>/);
  assert.ok(resetBtn, "dk-f-reset button not found");
  assert.match(resetBtn[0], /\bbtn-secondary\b/, "dk-f-reset must use btn-secondary");
  assert.doesNotMatch(resetBtn[0], /\bbtn-(?:ghost|sm)\b/, "dk-f-reset must match normal button styling");
  const delBtn = actionsBlock[1].match(/<button[\s\S]*?id="dk-bulk-del-btn"[\s\S]*?>/);
  assert.ok(delBtn, "dk-bulk-del-btn button not found");
  assert.match(delBtn[0], /\bbtn-danger\b/, "dk-bulk-del-btn must use btn-danger");
  assert.doesNotMatch(delBtn[0], /\bbtn-danger-solid\b/, "dk-bulk-del-btn must not use btn-danger-solid");
});

test("proxy toolbar keeps an outer frame with inner spacing", () => {
  const css = read("style.css");
  const block = css.match(/\.proxy-toolbar\s*\{([^}]+)\}/);
  assert.ok(block, ".proxy-toolbar rule not found");
  assert.match(block[1], /\bborder\s*:/, ".proxy-toolbar needs a border");
  assert.match(block[1], /\bpadding\s*:/, ".proxy-toolbar needs inner padding");
  assert.ok(css.includes(".proxy-key-card-btns"), "style.css is missing .proxy-key-card-btns");
  assert.ok(css.includes(".proxy-key-state-tag"), "style.css is missing .proxy-key-state-tag");
  assert.ok(css.includes(".proxy-summary-group"), "style.css is missing .proxy-summary-group");
  assert.ok(css.includes(".proxy-summary-num"), "style.css is missing .proxy-summary-num");
  const numRule = css.match(/\.proxy-summary-num\s*\{([^}]+)\}/);
  assert.ok(numRule, ".proxy-summary-num rule not found");
  assert.doesNotMatch(numRule[1], /\bmin-width\s*:/, ".proxy-summary-num must grow naturally rightwards without fixed min-width");
  assert.doesNotMatch(numRule[1], /\btext-align\s*:\s*right/, ".proxy-summary-num must not right-pad single digits");
});

test("shared button borders, select height, and mobile compact button rules stay aligned", () => {
  const css = read("style.css");
  assert.match(css, /\.btn\s*\{[^}]*border:\s*1px solid transparent/s);
  assert.match(css, /\.input-text,\s*\.input-select\s*\{[^}]*height:\s*var\(--control-h\)/s);
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 640px)"));
  assert.match(mobileBlock, /\.btn-xs\s*\{/);
  assert.match(mobileBlock, /\.btn-icon\s*\{/);
  for (const dead of [
    ".copy-textarea--horizontal",
    ".inv-models-details",
    ".config-form",
    ".config-cols",
    ".field--inline",
    ".modal-footer--editor",
  ]) {
    assert.ok(!css.includes(dead), `dead CSS rule ${dead} should stay removed`);
  }
});

test("async tab loaders guard stale requests and proxy batch keeps key results", () => {
  assert.match(app, /reqSeq\s*:\s*\{/);
  assert.match(app, /loadProxyState\(\{\s*preserveResults:\s*true\s*\}\)/);
  assert.match(app, /clearProxyNotice\(\{\s*keepGlobal:\s*true\s*\}\)/);
});

test("dead keys provider labels, responsive key masking, and flat desktop select rules stay intact", () => {
  const css = read("style.css");
  assert.ok(!html.includes("供应商域名"), "index.html should use 供应商 instead of 供应商域名");
  assert.ok(!html.includes("域名供应商"), "index.html should use 供应商 instead of 域名供应商");
  assert.ok(!app.includes("域名供应商"), "app.js should use 供应商 instead of 域名供应商");
  assert.ok(!app.includes("全部域名"), "app.js should use 全部供应商 instead of 全部域名");

  assert.match(app, /function maskKeyMobile\(/);
  assert.match(app, /function dkProviderLabel\([\s\S]*?providerDisplayName\(/);
  assert.match(app, /dk-key-desktop/);
  assert.match(app, /dk-key-mobile/);
  assert.ok(css.includes(".custom-select-trigger"), "style.css is missing .custom-select-trigger");
  assert.ok(css.includes(".custom-select-menu"), "style.css is missing .custom-select-menu");
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 640px)"));
  assert.match(mobileBlock, /\.dk-key-desktop\s*\{\s*display:\s*none/s);
  assert.match(mobileBlock, /\.dk-key-mobile\s*\{\s*display:\s*inline/s);

  const previewHtml = read("select-preview.html");
  const previewJs = read("select-preview.js");
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(previewHtml), "no inline <script> in select-preview.html");
  assert.ok(!/\sstyle="/i.test(previewHtml), 'no style="" attribute in select-preview.html');
  assert.ok(!/\sstyle="/i.test(previewJs), 'select-preview.js must not build style="" attributes');

  const summaryPreviewHtml = read("summary-preview.html");
  const summaryPreviewJs = read("summary-preview.js");
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(summaryPreviewHtml), "no inline <script> in summary-preview.html");
  assert.ok(!/\sstyle="/i.test(summaryPreviewHtml), 'no style="" attribute in summary-preview.html');
  assert.ok(!/\sstyle="/i.test(summaryPreviewJs), 'summary-preview.js must not build style="" attributes');
});

test("proxy toolbar places recover-all button next to test-disabled and scopes by fp", () => {
  const groupMatch = html.match(/<div\s+class="proxy-model-group">([\s\S]*?)<\/div>/);
  assert.ok(groupMatch, "proxy-model-group not found");
  const testDisabledIdx = groupMatch[1].indexOf('id="proxy-test-disabled"');
  const recoverAllIdx = groupMatch[1].indexOf('id="proxy-recover-all"');
  assert.ok(
    testDisabledIdx >= 0 && recoverAllIdx > testDisabledIdx,
    "proxy-recover-all must sit right after proxy-test-disabled",
  );
  assert.match(app, /async function recoverAllProxyKeys\(/);
  assert.match(app, /body:\s*\{\s*fp:\s*currentProvider\.fp,\s*all:\s*true\s*\}/);
});

test("Batch 1 simplifications remove dead-key editor, gateway_provider, and _uiKey", () => {
  const css = read("style.css");
  for (const id of ["ed-gateway-provider", "dkedit-overlay", "dkedit-save-btn", "dke-host"]) {
    assert.ok(!html.includes(`id="${id}"`), `index.html still has #${id}`);
  }
  for (const token of ["_uiKey", "assignProxyUiKeys", "openDkEdit", "saveDkEdit", "providerHosts("]) {
    assert.ok(!app.includes(token), `app.js still contains ${token}`);
  }
  for (const cls of [".dk-edit-col", ".input-errcode", ".dk-actions"]) {
    assert.ok(!css.includes(cls), `style.css still contains ${cls}`);
  }
  assert.ok(!worker.includes("handlePutDeadKey"), "_worker.js still has handlePutDeadKey");
  assert.ok(!worker.includes("collectConfiguredKeysForHost"), "_worker.js still has collectConfiguredKeysForHost");
  assert.match(app, /已存在相同的 \$\{pType\} 与 API Base 服务商/);
});

test("Batch 2 moves gateway and proxy config into settings modal without env reads", () => {
  const css = read("style.css");
  for (const id of [
    "set-proxy-password",
    "set-gateway-logs-url",
    "set-gateway-token",
    "set-proxy-fail-threshold",
    "set-proxy-max-retries",
    "set-proxy-timeout-ms",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html missing #${id}`);
  }
  assert.ok(css.includes(".settings-grid-3"), "style.css missing .settings-grid-3");
  assert.doesNotMatch(worker, /env\.(?:AI_GATEWAY_|PROXY_)/, "_worker.js must not read env gateway/proxy vars");
  assert.ok(!worker.includes("metadataKeyTag"), "_worker.js still has metadataKeyTag");
  assert.ok(!app.includes("AI_GATEWAY_LOGS_URL"), "app.js should not refer to env AI_GATEWAY_LOGS_URL");
});

test("Batch 3 removes refresh buttons, checkpoint bars, avg TTFT, and unifies copy icon buttons", () => {
  const css = read("style.css");
  for (const id of ["refresh-results-btn", "dk-refresh-btn", "proxy-refresh-btn"]) {
    assert.ok(!html.includes(`id="${id}"`), `index.html still has #${id}`);
    assert.ok(!app.includes(id), `app.js still references ${id}`);
  }
  const resultsMatch = html.match(/<section id="tab-results"[\s\S]*?<\/section>/);
  assert.ok(resultsMatch, "#tab-results section not found");
  assert.ok(resultsMatch[0].includes('id="run-now-btn"'), "run-now-btn must live inside #tab-results");
  assert.ok(resultsMatch[0].includes('id="results-running-badge"'), "results-running-badge missing from #tab-results");
  assert.ok(html.includes('id="proxy-url-copy"'), "index.html missing #proxy-url-copy");
  assert.ok(css.includes(".proxy-url-wrap"), "style.css missing .proxy-url-wrap");
  assert.ok(css.includes(".results-title-row"), "style.css missing .results-title-row");
  for (const deadToken of ["hasUsableCheckpoint", "renderCheckpointBar", "copyProxyUrl", "avg TTFT", "一键复制"]) {
    assert.ok(!app.includes(deadToken), `app.js still contains ${deadToken}`);
  }
  assert.ok(!css.includes(".checkpoint-bar"), "style.css still contains .checkpoint-bar");
});

test("review fixes keep confirm labels fp-aware, URLs http(s)-guarded, and remove dead code", () => {
  const py = readFileSync(new URL("../async_test_keys.py", import.meta.url), "utf8");
  assert.match(
    app,
    /dkConfirmList\.innerHTML[\s\S]*dkProviderLabel\(r\)/,
    "openDkConfirm must pass full dead-key record `r` to dkProviderLabel",
  );
  assert.doesNotMatch(app, /dkProviderLabel\(r\.provider_host\)/);
  assert.ok(!app.includes("beside 重新读取"), "app.js still has stale refresh comment");
  assert.ok(!worker.includes("does not write the ledger"), "_worker.js still has stale P9 comment");
  assert.match(app, /const HTTP_URL_RE\s*=\s*\/\^https\?:\\\/\\\/\\S\+\/i/);
  assert.match(app, /HTTP_URL_RE\.test\(url\)/, "applySettingsToUI must validate github_url scheme");
  assert.ok(!py.includes("compute_fingerprint"), "async_test_keys.py still has unused compute_fingerprint");
  assert.ok(!py.includes("import hashlib"), "async_test_keys.py still has unused hashlib import");
});

test("editor modal marks required fields, places error left of save button, and portals info tooltip above select menu", () => {
  const css = read("style.css");
  const editorSection = html.match(/<div id="editor-overlay"[\s\S]*?<\/section>\s*<\/div>/);
  assert.ok(editorSection, "#editor-overlay markup not found");
  const editorMarkup = editorSection[0];

  const reqMatches = [...editorMarkup.matchAll(/<span class="field-label-title"[^>]*>([\s\S]*?)<span[^>]*class="field-required"[^>]*>\*<\/span\s*>/g)];
  const reqTitles = reqMatches.map((m) => m[1].trim());
  assert.deepEqual(reqTitles, ["Provider Type", "API Base URL", "API Keys", "Models"]);

  const footerMatch = editorMarkup.match(/<div class="modal-footer modal-footer-stack">([\s\S]*?)<\/div>\s*<\/section>/);
  assert.ok(footerMatch, "editor modal-footer stack not found");
  const confirmIdx = footerMatch[1].indexOf('id="editor-confirm"');
  const rowIdx = footerMatch[1].indexOf('class="modal-footer-row"');
  const errIdx = footerMatch[1].indexOf('id="editor-error"');
  const saveIdx = footerMatch[1].indexOf('id="editor-save-btn"');
  assert.ok(confirmIdx >= 0 && rowIdx > confirmIdx, "editor-confirm must sit above modal-footer-row");
  assert.ok(errIdx >= 0 && saveIdx > errIdx, "editor-error must sit left of editor-save-btn inside modal-footer");
  assert.match(footerMatch[1], /\bmodal-footer-error\b/, "editor-error must carry modal-footer-error class");
  for (const removedId of ["editor-confirm-msg", "editor-confirm-ok", "editor-confirm-cancel"]) {
    assert.ok(!html.includes(`id="${removedId}"`), `index.html must not keep #${removedId}`);
  }
  assert.match(app, /dom\.editorError\.textContent = `即将删除 \$\{removed\.length\} 支密钥；确认后才会储存。`/);
  assert.match(app, /dom\.editorSave\.classList\.add\("btn-danger-solid"\)/);
  assert.match(app, /dom\.editorSave\.classList\.remove\("btn-danger-solid"\)/);

  const btnFont = css.match(/(?:^|\r?\n)\.btn\s*\{[^}]*font-size:\s*([^;]+);/);
  const errFont = css.match(/\.modal-footer-error\s*\{[^}]*font-size:\s*([^;]+);/s);
  assert.ok(btnFont && errFont, ".btn and .modal-footer-error font-size rules must exist");
  assert.equal(errFont[1].trim(), btnFont[1].trim(), "modal-footer-error font-size must match .btn");

  const menuZ = css.match(/\.custom-select-menu\s*\{[^}]*z-index:\s*(\d+)/s);
  const portalZ = css.match(/\.info-tooltip--portal\s*\{[^}]*z-index:\s*(\d+)/s);
  assert.ok(menuZ && portalZ, ".custom-select-menu and .info-tooltip--portal z-index rules must exist");
  assert.ok(Number(portalZ[1]) > Number(menuZ[1]), ".info-tooltip--portal z-index must sit above .custom-select-menu");

  assert.match(css, /\.modal-footer\s*\{[^}]*flex-shrink:\s*0;/s);
  assert.match(css, /\.editor-confirm-list\s*\{[^}]*max-height:\s*8rem;/s);

  assert.match(app, /function initInfoTooltips\(/);
  assert.match(app, /initInfoTooltips\(\);/);
  assert.match(app, /document\.body\.appendChild\(tip\)/);
  assert.match(app, /e\.target\.closest\("\.custom-select, \.info-icon"\)/);
});

test("editor and settings modals replace inline hint text with info tooltips and support multiline models", () => {
  const editorMatch = html.match(/<div id="editor-overlay"[\s\S]*?<!-- App settings modal -->/);
  const settingsMatch = html.match(/<div id="settings-overlay"[\s\S]*?<!-- Sample modal -->/);
  assert.ok(editorMatch && settingsMatch, "editor and settings modals must exist");

  assert.doesNotMatch(editorMatch[0], /<small\s+class="muted"/, "editor modal must not have inline <small class=\"muted\"> hints");
  assert.doesNotMatch(settingsMatch[0], /<small\s+class="muted"/, "settings modal must not have inline <small class=\"muted\"> hints");

  const editorTips = [...editorMatch[0].matchAll(/class="info-tooltip"/g)];
  const settingsTips = [...settingsMatch[0].matchAll(/class="info-tooltip"/g)];
  assert.equal(editorTips.length, 7, "editor modal should have 7 info tooltips");
  assert.equal(settingsTips.length, 2, "settings modal should have 2 info tooltips");
  assert.match(editorMatch[0], /id="ed-extra-body-status"/, "Extra Body live JSON status must stay intact");

  assert.match(app, /function normalizeModels[\s\S]*?\.split\(\/\[,\\r\\n\]\+\/\)/);
  assert.match(app, /function splitModels[\s\S]*?\.split\(\/\[,\\r\\n\]\+\/\)/);
  assert.match(app, /modelCount = splitModels\(p\.models\)\.length/);
  assert.match(app, /positionInfoTooltip[\s\S]*?icon\.closest\("\.modal-body"\)/);
  assert.match(app, /dom\.edModels\.addEventListener\("blur"/);
  assert.match(app, /dom\.edKeys\.addEventListener\("blur"/);
  const saveBody = app.slice(app.indexOf("async function saveEditor()"), app.indexOf("async function deleteProvider("));
  assert.doesNotMatch(saveBody, /dom\.edModels\.value\s*=/, "saveEditor should only validate, not rewrite edModels display");
  assert.doesNotMatch(saveBody, /dom\.edKeys\.value\s*=/, "saveEditor should only validate, not rewrite edKeys display");
});

test("dead keys host menu uses Name - Format, date filters stay empty, proxy summary uses segmented readout + count tooltips, and results copy buttons sit on titles", () => {
  const css = read("style.css");
  const fillHostFn = app.slice(app.indexOf("function fillHostSelect"), app.indexOf("const DK_CODE_NONE"));
  assert.match(fillHostFn, /providerFormatLabel\(e\.provider,\s*e\.host\)/);
  assert.doesNotMatch(fillHostFn, /e\.multiOnHost/);

  assert.doesNotMatch(app, /todayFilterDate/);
  const summaryCss = css.match(/\.proxy-summary\s*\{([^}]+)\}/);
  assert.ok(summaryCss, ".proxy-summary rule not found");
  assert.match(summaryCss[1], /\bgap:\s*0\.75rem;/);
  const summaryLabelCss = css.match(/\.proxy-summary-label\s*\{([^}]+)\}/);
  assert.ok(summaryLabelCss, ".proxy-summary-label rule not found");
  assert.match(summaryLabelCss[1], /\bcolor:\s*var\(--text\);/);
  const summaryGroupCss = css.match(/\.proxy-summary-group\s*\{([^}]+)\}/);
  assert.ok(summaryGroupCss, ".proxy-summary-group rule not found");
  assert.match(summaryGroupCss[1], /\bheight:\s*var\(--control-h\);/);
  assert.match(summaryGroupCss[1], /\bbackground:\s*var\(--bg-3\);/);
  assert.match(summaryGroupCss[1], /\bborder:\s*1px solid var\(--border\);/);
  assert.match(css, /\.proxy-summary-cell\s*\{[^}]*min-width:\s*calc\(3ch \+ 1\.5rem\);/s);
  assert.match(css, /\.proxy-summary-cell\s*\+\s*\.proxy-summary-cell\s*\{[^}]*border-left:\s*1px solid var\(--border\);/s);

  const urlCopyBtn = html.match(/<button[^>]*id="proxy-url-copy"[^>]*>/);
  assert.ok(urlCopyBtn, "#proxy-url-copy button not found");
  assert.match(urlCopyBtn[0], /\bproxy-url-copy\b/);
  assert.doesNotMatch(urlCopyBtn[0], /\bbtn-xs\b/);
  assert.match(css, /\.btn\.proxy-url-copy\s*\{[^}]*width:\s*var\(--control-h\);[^}]*height:\s*var\(--control-h\);/s);
  assert.match(css, /\.btn\.proxy-url-copy svg\s*\{[^}]*width:\s*1\.15rem;[^}]*height:\s*1\.15rem;/s);

  const summaryFn = app.slice(app.indexOf("function renderProxyToolbar()"), app.indexOf("function renderProxyLogsLink()"));
  assert.match(summaryFn, /"密钥状态"/);
  assert.match(summaryFn, /makeCount\("proxy-summary-ok",\s*available,\s*"有效数量"\)/);
  assert.match(summaryFn, /makeCount\("proxy-summary-fail",\s*disabled,\s*"无效数量"\)/);

  const resultBodyFn = app.slice(app.indexOf("function renderResultBody("), app.indexOf("function renderPerfTable("));
  assert.match(resultBodyFn, /有效 Key[\s\S]*?badge-ok[\s\S]*?复制全部有效 Key[\s\S]*?<\/div>\s*<div class="lined-editor/);
  assert.match(resultBodyFn, /有效模型[\s\S]*?badge-ok[\s\S]*?复制全部有效模型[\s\S]*?<\/div>\s*<div class="lined-editor/);
  assert.doesNotMatch(resultBodyFn, /copy-block/);
  assert.match(resultBodyFn, /失效 Key/);
  assert.doesNotMatch(resultBodyFn, /无效 Key/);

  const invalidGroupsFn = app.slice(app.indexOf("function renderInvalidGroups("), app.indexOf("function openErrorDetail("));
  assert.match(invalidGroupsFn, /复制本组全部 KEY/);
  assert.doesNotMatch(invalidGroupsFn, /title="复制 KEY"/);
});

test("editor deduplicates keys/models keeping first occurrence, results CTA updated, KV hides proxy UI, and settings fields reordered with secret controls", () => {
  const css = read("style.css");

  // 1. Key/Model deduplication preserving first occurrence
  const sliceFn = (startMarker, endMarker) =>
    app.slice(app.indexOf(startMarker), app.indexOf(endMarker));
  const normBlock = sliceFn(
    "function splitUniqueDelimited(",
    "/** Newline list helper",
  );
  const { normalizeKeys, normalizeModels } = new Function(
    `${normBlock}\nreturn { normalizeKeys, normalizeModels };`,
  )();
  assert.equal(normalizeKeys("k1\n k2 \n\nk1\nk3\nk2"), "k1\nk2\nk3");
  assert.equal(normalizeModels("gpt-4o, m2\ngpt-4o\r\nm3, m2"), "gpt-4o,m2,m3");

  // 2. Results header CTA text
  assert.match(html, /id="run-now-btn"[^>]*>立即执行 \/ 查看记录<span class="btn-ext"/);

  // 3. KV mode hides proxy tab, panel, and settings block + skips proxy fields on save
  assert.ok(html.includes('id="settings-proxy-fields"'), "index.html missing #settings-proxy-fields");
  assert.match(css, /\.settings-proxy-fields\s*\{[^}]*flex-direction:\s*column;[^}]*gap:\s*1\.25rem;/s);
  assert.match(app, /function isKvStorageMode\(\)/);
  assert.match(app, /if \(name === "proxy" && isKvStorageMode\(\)\) name = "config";/);
  assert.match(app, /dom\.proxyTabBtn\.classList\.toggle\("hidden",\s*kvMode\)/);
  assert.match(app, /dom\.settingsProxyFields\.classList\.toggle\("hidden",\s*kvMode\)/);
  assert.match(app, /if \(isKvStorageMode\(\)\) \{\s*dom\.proxyLoading\.classList\.add\("hidden"\);\s*return false;/s);

  // 4 & 5. Settings field order (Discord before GitHub, Logs URL before Proxy Password) + secret eye/copy controls
  const settingsBody = html.match(/<div id="settings-overlay"[\s\S]*?<div class="modal-body">([\s\S]*?)<\/div>\s*<div class="modal-footer">/);
  assert.ok(settingsBody, "#settings-overlay .modal-body not found");
  const body = settingsBody[1];
  const discordIdx = body.indexOf('id="set-discord-url"');
  const githubIdx = body.indexOf('id="set-github-url"');
  const proxyWrapIdx = body.indexOf('id="settings-proxy-fields"');
  const logsIdx = body.indexOf('id="set-gateway-logs-url"');
  const passIdx = body.indexOf('id="set-proxy-password"');
  const tokenIdx = body.indexOf('id="set-gateway-token"');
  const gridIdx = body.indexOf('class="settings-grid-3"');
  assert.ok(discordIdx >= 0 && githubIdx > discordIdx, "Discord Webhook URL must sit before GitHub Actions URL");
  assert.ok(proxyWrapIdx > githubIdx, "#settings-proxy-fields must sit after GitHub Actions URL");
  assert.ok(logsIdx > proxyWrapIdx && passIdx > logsIdx && tokenIdx > passIdx && gridIdx > tokenIdx,
    "Proxy settings order inside #settings-proxy-fields must be Logs URL -> Proxy Password -> Gateway Token -> grid-3");

  for (const secretId of ["set-proxy-password", "set-gateway-token"]) {
    assert.ok(body.includes(`id="${secretId}-toggle"`), `missing #${secretId}-toggle`);
    assert.ok(body.includes(`id="${secretId}-copy"`), `missing #${secretId}-copy`);
    const copyTag = body.match(new RegExp(`<button[^>]*id="${secretId}-copy"[^>]*>`));
    assert.ok(copyTag && /\bproxy-url-copy\b/.test(copyTag[0]), `#${secretId}-copy must share .proxy-url-copy square geometry`);
  }
  assert.match(app, /const EYE_ICON_SVG\s*=/);
  assert.match(app, /const EYE_OFF_ICON_SVG\s*=[\s\S]*?<line x1="1" y1="1" x2="23" y2="23"><\/line>/);
  assert.match(css, /\.input-secret::-ms-reveal/);
  assert.match(css, /\.input-secret-toggle\s*\{/);
  assert.match(app, /openModal\(dom\.settingsOverlay,\s*dom\.setDiscordUrl\)/);
});
