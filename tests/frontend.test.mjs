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
