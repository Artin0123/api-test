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
  assert.ok(css.includes(".proxy-summary-num"), "style.css is missing .proxy-summary-num");
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
