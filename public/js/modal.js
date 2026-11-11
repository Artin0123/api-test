// Split from the original app.js; loaded in original order (see index.html).
// ── UI & Modal Helpers ────────────────────────────────────────────────────
function modalFocusableElements(overlay) {
  const panel = overlay ? overlay.querySelector(".modal-panel") : null;
  if (!panel) return [];
  return Array.from(
    panel.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.closest(".hidden") && el.getClientRects().length > 0);
}

function openModal(overlay, initialFocusEl = null) {
  if (!overlay) return;
  const idx = state.modalStack.indexOf(overlay);
  if (idx >= 0) state.modalStack.splice(idx, 1);
  state.modalStack.push(overlay);
  overlay.classList.remove("hidden");

  if (
    initialFocusEl &&
    !initialFocusEl.disabled &&
    initialFocusEl.getClientRects().length > 0 &&
    typeof initialFocusEl.focus === "function"
  ) {
    initialFocusEl.focus();
  }
}

function closeModal(overlay) {
  if (!overlay) return;
  closeOpenCustomSelect();
  hideActiveInfoTooltip();
  overlay.classList.add("hidden");
  const idx = state.modalStack.indexOf(overlay);
  if (idx >= 0) state.modalStack.splice(idx, 1);
  if (
    overlay.contains(document.activeElement) &&
    typeof document.activeElement.blur === "function"
  ) {
    document.activeElement.blur();
  }
}
