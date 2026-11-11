// Split from the original app.js; loaded in original order (see index.html).
// ── Models & keys normalization ───────────────────────────────────────────
function splitUniqueDelimited(raw, splitRe) {
  const seen = new Set();
  const out = [];
  for (const item of String(raw || "").split(splitRe)) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// Accepts comma-separated and/or newline-separated model names; trims items,
// drops empties, deduplicates keeping first occurrence, and joins with commas.
function normalizeModels(raw) {
  return splitUniqueDelimited(raw, /[,\r\n]+/).join(",");
}

function normalizeKeys(raw) {
  return splitUniqueDelimited(raw, "\n").join("\n");
}

/** Newline list helper shared by the editor tools and the proxy page. */
function splitKeyLines(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Comma list helper, mirroring providerModels() in `_worker.js`: the proxy page
 *  offers the provider's own Models (来源设定) as the probe model, so both sides
 *  must split the same string the same way. */
function splitModels(raw) {
  return String(raw || "")
    .split(/[,\r\n]+/)
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Head/tail mask for keys: left 6 + 1..3 asterisks + right 3 (<=9 shown as-is).
 *  Keep this function identical to the one in `_worker.js`. */
function maskKey(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 9) return s;
  const stars = "*".repeat(Math.min(s.length - 9, 3));
  return `${s.slice(0, 6)}${stars}${s.slice(-3)}`;
}

/** Mobile head/tail mask for dead keys: left 6 + 1..3 asterisks + right 1 (<=7 shown as-is). */
function maskKeyMobile(key) {
  const s = String(key || "");
  if (!s) return "";
  if (s.length <= 7) return s;
  const stars = "*".repeat(Math.min(s.length - 7, 3));
  return `${s.slice(0, 6)}${stars}${s.slice(-1)}`;
}

function dkKeyHtml(key) {
  const raw = String(key || "");
  if (!raw) return "";
  return `<span class="dk-key-desktop">${esc(maskKey(raw))}</span><span class="dk-key-mobile">${esc(maskKeyMobile(raw))}</span>`;
}

/** Multiset diff of two newline lists: duplicated keys are counted, so removing
 *  one copy of a key that appears twice reports exactly one removal. */
function diffKeyLines(oldText, newText) {
  const count = (text) => {
    const map = new Map();
    for (const key of splitKeyLines(text)) map.set(key, (map.get(key) || 0) + 1);
    return map;
  };
  const before = count(oldText);
  const after = count(newText);
  const removed = [];
  for (const [key, n] of before) {
    const left = n - (after.get(key) || 0);
    for (let i = 0; i < left; i++) removed.push(key);
  }
  return removed;
}

const SORT_MODES = ["none", "asc", "desc"];
// All three labels are the same length so the button keeps one width instead of
// jumping while you cycle it. The mode is spelled out rather than A→Z / Z→A
// because the direction is what the user picks, and the arrows read as a value.
const SORT_LABELS = { none: "预设排序", asc: "递增排序", desc: "递减排序" };

function nextSortMode(mode) {
  const i = SORT_MODES.indexOf(mode);
  return SORT_MODES[(i + 1) % SORT_MODES.length];
}

/** Three-state sort. "none" restores the text captured when the cycle started,
 *  so the original order (and duplicated lines) survive the round trip. The
 *  comparison is the default JS string comparison (UTF-16 code units), which for
 *  ASCII keys is plain ASCII order; localeCompare would follow the system
 *  locale and is deliberately not used. */
function sortKeysText(text, mode, originText) {
  if (mode === "none") {
    return originText === undefined ? String(text) : originText;
  }
  const lines = splitKeyLines(text);
  const cmp =
    mode === "asc"
      ? (a, b) => (a < b ? -1 : a > b ? 1 : 0)
      : (a, b) => (a < b ? 1 : a > b ? -1 : 0);
  return [...lines].sort(cmp).join("\n");
}
