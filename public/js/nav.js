// Split from the original app.js; loaded in original order (see index.html).
function topOpenModal() {
  for (let i = state.modalStack.length - 1; i >= 0; i--) {
    const overlay = state.modalStack[i];
    if (overlay && !overlay.classList.contains("hidden")) return overlay;
  }
  return null;
}
function toggleMobileMenu(force) {
  const open =
    typeof force === "boolean"
      ? force
      : !dom.topbarMenu.classList.contains("open");
  dom.topbarMenu.classList.toggle("open", open);
  dom.topbarMenuBackdrop.classList.toggle("open", open);
  dom.mobileMenuBtn.setAttribute("aria-expanded", String(open));
}

// ── Tabs ──────────────────────────────────────────────────────────────────
function switchTab(name) {
  if (name === "proxy" && isKvStorageMode()) name = "config";
  closeOpenCustomSelect();
  dom.tabBtns.forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name),
  );
  dom.tabPanels.forEach((p) => {
    const active = p.id === `tab-${name}`;
    p.classList.toggle("active", active);
    p.classList.toggle("hidden", !active);
  });
  if (name === "results") loadResults();
  if (name === "config") loadConfig();
  if (name === "deadkeys") loadDeadKeys();
  if (name === "proxy") loadProxyState();

  // Close mobile menu if open
  toggleMobileMenu(false);
}
