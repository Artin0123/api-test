// Split from the original app.js; loaded in original order (see index.html).
// ── Floating info tooltips (portaled to body to layer above open select menus) ─
let activeInfoIcon = null;

function positionInfoTooltip(icon, tip) {
  if (!icon || !tip) return;
  const rect = icon.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const margin = 12;
  const gap = 6;
  const tipW = tipRect.width || tip.offsetWidth || 210;
  const tipH = tipRect.height || tip.offsetHeight || 120;

  // Keep tooltips inside the modal body frame (between header bottom border,
  // footer top border, and left/right modal edges) with at least `margin` px.
  const body = icon.closest(".modal-body");
  const panel = icon.closest(".modal-panel");
  const bounds = body
    ? body.getBoundingClientRect()
    : panel
      ? panel.getBoundingClientRect()
      : {
          left: 0,
          right: window.innerWidth,
          top: 0,
          bottom: window.innerHeight,
        };
  const minX = Math.max(bounds.left, 0) + margin;
  const contentRight = body
    ? Math.min(bounds.right, bounds.left + body.clientLeft + body.clientWidth)
    : bounds.right;
  const maxX = Math.min(contentRight, window.innerWidth) - margin;
  const minY = Math.max(bounds.top, 0) + margin;
  const maxY = Math.min(bounds.bottom, window.innerHeight) - margin;

  let left = rect.left + rect.width / 2 - tipW / 2;
  if (left + tipW > maxX) left = maxX - tipW;
  if (left < minX) left = minX;

  let top = rect.bottom + gap;
  if (top + tipH > maxY) {
    const aboveTop = rect.top - gap - tipH;
    top = aboveTop >= minY ? aboveTop : Math.max(minY, maxY - tipH);
  }
  if (top < minY) top = minY;

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideActiveInfoTooltip() {
  if (!activeInfoIcon || !activeInfoIcon._tooltipState) return;
  const icon = activeInfoIcon;
  icon._tooltipState.hovered = false;
  icon._tooltipState.focused = false;
  icon._tooltipState.tip.classList.remove("is-open");
  activeInfoIcon = null;
}

function syncInfoTooltip(icon) {
  const stateObj = icon && icon._tooltipState;
  if (!stateObj) return;
  const { tip, hovered, focused } = stateObj;
  const visible =
    (hovered || focused) &&
    icon.isConnected &&
    icon.getClientRects().length > 0;
  if (!visible) {
    tip.classList.remove("is-open");
    if (activeInfoIcon === icon) activeInfoIcon = null;
    return;
  }
  if (activeInfoIcon && activeInfoIcon !== icon) {
    hideActiveInfoTooltip();
  }
  positionInfoTooltip(icon, tip);
  tip.classList.add("is-open");
  activeInfoIcon = icon;
}

function initInfoTooltips() {
  document.querySelectorAll(".info-icon").forEach((icon, idx) => {
    if (icon._tooltipState) return;
    const tip = icon.querySelector(".info-tooltip");
    if (!tip) return;
    if (!tip.id) tip.id = `info-tooltip-${idx + 1}`;
    tip.setAttribute("role", "tooltip");
    icon.setAttribute("aria-describedby", tip.id);
    // Portal outside modal stacking contexts so .info-tooltip paints above .custom-select-menu.
    tip.classList.add("info-tooltip--portal");
    document.body.appendChild(tip);

    const stateObj = { tip, hovered: false, focused: false };
    icon._tooltipState = stateObj;

    icon.addEventListener("mouseenter", () => {
      stateObj.hovered = true;
      syncInfoTooltip(icon);
    });
    icon.addEventListener("mouseleave", () => {
      stateObj.hovered = false;
      syncInfoTooltip(icon);
    });
    icon.addEventListener("focusin", () => {
      stateObj.focused = true;
      syncInfoTooltip(icon);
    });
    icon.addEventListener("focusout", () => {
      stateObj.focused = false;
      syncInfoTooltip(icon);
    });
    icon.addEventListener("click", (e) => {
      e.preventDefault();
      icon.focus();
    });
  });

  document.addEventListener("pointerdown", (e) => {
    if (activeInfoIcon && !activeInfoIcon.contains(e.target)) {
      hideActiveInfoTooltip();
    }
  });
  window.addEventListener("resize", () => {
    if (activeInfoIcon) syncInfoTooltip(activeInfoIcon);
  });
  window.addEventListener(
    "scroll",
    () => {
      if (!activeInfoIcon) return;
      const body = activeInfoIcon.closest(".modal-body");
      if (body) {
        const iconRect = activeInfoIcon.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        if (iconRect.bottom < bodyRect.top || iconRect.top > bodyRect.bottom) {
          hideActiveInfoTooltip();
          return;
        }
      }
      syncInfoTooltip(activeInfoIcon);
    },
    true,
  );
}
