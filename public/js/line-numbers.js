// Split from the original app.js; loaded in original order (see index.html).
// ── Line numbers ──────────────────────────────────────────────────────────
// Hidden mirror div used to measure how many visual lines each logical line
// takes up. All text-rendering properties are copied from the source textarea
// on each call so the mirror matches the actual wrapping behaviour exactly.
let _mirror;
function _ensureMirror() {
  if (_mirror) return;
  _mirror = document.createElement("div");
  _mirror.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;" +
    "box-sizing:content-box;padding:0;margin:0;border:none;";
  document.body.appendChild(_mirror);
}
function _measureVisualLines(textarea, logicalLines) {
  _ensureMirror();
  const cs = getComputedStyle(textarea);
  // Copy all properties that affect line-wrapping from the source textarea.
  // font shorthand covers font-family, font-size, etc.; set lineHeight after
  // because the font shorthand resets it to 'normal' when omitted.
  _mirror.style.font = cs.font;
  _mirror.style.lineHeight = cs.lineHeight;
  _mirror.style.letterSpacing = cs.letterSpacing;
  _mirror.style.whiteSpace = cs.whiteSpace;
  _mirror.style.overflowWrap = cs.overflowWrap;
  _mirror.style.wordBreak = cs.wordBreak;
  // Content width = textarea clientWidth minus its horizontal padding
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const avail = Math.max(1, textarea.clientWidth - padL - padR);
  _mirror.style.width = avail + "px";
  // Measure single-line height with a reference character
  _mirror.textContent = "X";
  const oneLineH = _mirror.scrollHeight;
  if (oneLineH <= 0) return logicalLines.map(() => 1);
  // Measure visual lines per logical line
  return logicalLines.map((line) => {
    _mirror.textContent = line || "\u00A0";
    return Math.max(1, Math.round(_mirror.scrollHeight / oneLineH));
  });
}

function syncLineNums(textarea) {
  const editor = textarea.closest(".lined-editor");
  if (!editor) return;
  const nums = editor.querySelector(".line-nums");
  if (!nums) return;

  const logicalLines = textarea.value.split("\n");
  const visualCounts = _measureVisualLines(textarea, logicalLines);

  // Build spans: one per visual line; only the first of each logical group gets a number
  const spans = [];
  let num = 1;
  for (const vc of visualCounts) {
    spans.push(`<span>${num}</span>`);
    for (let i = 1; i < vc; i++) spans.push(`<span></span>`);
    num++;
  }
  nums.innerHTML = spans.join("");

  // Proportional scroll sync after layout
  requestAnimationFrame(() => {
    const taMax = textarea.scrollHeight - textarea.clientHeight;
    if (taMax <= 0) {
      nums.scrollTop = 0;
      return;
    }
    const ratio = textarea.scrollTop / taMax;
    const numsMax = nums.scrollHeight - nums.clientHeight;
    nums.scrollTop = ratio * Math.max(0, numsMax);
  });
}

function bindLineNums(textarea) {
  const sync = () => syncLineNums(textarea);
  textarea.addEventListener("input", sync);
  textarea.addEventListener("scroll", sync);
  sync();
}
