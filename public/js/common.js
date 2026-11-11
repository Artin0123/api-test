// Split from the original app.js; loaded in original order (see index.html).
// ── Sample modal ──────────────────────────────────────────────────────────
function openSample(model, sample) {
  dom.sampleTitle.textContent = model;
  dom.sampleSubtitle.textContent = "";
  const thinking = sample?.thinking || "";
  const hasThinking = !!sample?.has_thinking;
  const content = sample?.content || "";
  dom.sampleContent.innerHTML = `
    ${
      thinking || hasThinking
        ? `<div class="sample-block">
      <div class="sample-block-label">Thinking</div>
      <pre class="sample-pre">${thinking ? esc(thinking) : `<span class="na">（思考已發生，但內容未公開）</span>`}</pre>
    </div>`
        : ""
    }
    <div class="sample-block">
      <div class="sample-block-label">Content</div>
      <pre class="sample-pre">${content ? esc(content) : `<span class="na">（空）</span>`}</pre>
    </div>
  `;
  openModal(dom.sampleOverlay);
}
function closeSample() {
  closeModal(dom.sampleOverlay);
}

// ── Copy ──────────────────────────────────────────────────────────────────
const copyBtnTimers = new WeakMap();

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch (_) {}
  document.body.removeChild(ta);
}

function copyText(text, btn, { shouldDisable } = {}) {
  const doFeedback = () => {
    if (!btn || !btn.isConnected) return;
    const prevTimer = copyBtnTimers.get(btn);
    if (prevTimer) clearTimeout(prevTimer);

    const origHtml = btn.dataset.origHtml ?? btn.innerHTML;
    btn.dataset.origHtml = origHtml;
    btn.innerHTML = CHECK_ICON_SVG;
    btn.classList.add("copied");
    btn.disabled = true;
    const timer = setTimeout(() => {
      copyBtnTimers.delete(btn);
      if (!btn.isConnected) return;
      btn.innerHTML = origHtml;
      delete btn.dataset.origHtml;
      btn.classList.remove("copied");
      btn.disabled =
        typeof shouldDisable === "function" ? !!shouldDisable() : false;
    }, 1500);
    copyBtnTimers.set(btn, timer);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(doFeedback)
      .catch(() => {
        fallbackCopy(text);
        doFeedback();
      });
  } else {
    fallbackCopy(text);
    doFeedback();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function escAttr(v) {
  return esc(v);
}

// Collapse whitespace and cut overly long provider messages so they fit one line.
// The untruncated text stays available via title attribute / error detail modal.
function truncate(v, n = 120) {
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? s.slice(0, n) + "..." : s;
}

// Mask the fragments that vary per key/request so two records can be compared as
// "same cause". Must produce byte-identical output to normalize_message() in
// async_test_keys.py, hence two constraints on these patterns:
//   - no \b or \d: Python counts CJK as word chars and full-width digits as digits,
//     JS does not, so they disagree on the Chinese messages providers return.
//   - no lookbehind: it is a parse-time syntax error below Safari 16.4, which would
//     take down this whole file; a captured leading char does the same job.
function normalizeMessage(v) {
  return String(v ?? "")
    .toLowerCase()
    .replace(/(^|[^a-z0-9])(?:sk|gsk|api|key)[-_][a-z0-9_\-*]{3,}/g, "$1<key>")
    .replace(/\*{2,}[a-z0-9]+/g, "<key>")
    .replace(/(^|[^a-z0-9])[0-9a-f]{8,}(?![a-z0-9])/g, "$1<id>")
    .replace(/[0-9０-９]+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// Fixed YYYY-MM-DD HH:mm(:ss) in local time. toLocaleString() follows the browser
// locale, which mixes formats across machines (2026/8/12 下午10:15 vs 8/12/2026
// 10:15 PM); the dead keys table already shows plain ISO dates, so match it.
function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function extractHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "";
  }
}

function fingerprintPayload(p) {
  // Must match _worker.js: sorted keys { api_base, provider_type }
  return JSON.stringify({
    api_base: p.api_base.replace(/\/+$/, ""),
    provider_type: p.provider_type,
  });
}

async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
