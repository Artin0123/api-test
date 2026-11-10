const THEME_KEY = "atk_theme";
const desktopMql =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(min-width: 641px) and (hover: hover) and (pointer: fine)")
    : null;

let activePreviewSelect = null;

function isDesktop() {
  return !!(desktopMql && desktopMql.matches);
}

function createArrowSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "custom-select-arrow");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const poly = document.createElementNS(ns, "polyline");
  poly.setAttribute("points", "6 9 12 15 18 9");
  svg.appendChild(poly);
  return svg;
}

function closeOpenMenu({ restoreFocus = false } = {}) {
  const sel = activePreviewSelect;
  if (!sel || !sel._previewUi) return;
  const ui = sel._previewUi;
  activePreviewSelect = null;
  ui.menu.classList.add("hidden");
  ui.trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) ui.trigger.focus();
}

function syncPreviewSelect(sel) {
  const ui = sel._previewUi;
  if (!ui) return;
  const opt = sel.options[sel.selectedIndex] || sel.options[0];
  const label = opt ? opt.textContent || "" : "";
  ui.valueEl.textContent = label;
  ui.trigger.title = label;
}

function positionMenu(sel) {
  const ui = sel._previewUi;
  const rect = ui.trigger.getBoundingClientRect();
  const gap = 4;
  const margin = 12;
  const spaceBelow = window.innerHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
  const maxH = Math.max(120, Math.min(256, openUp ? spaceAbove - gap : spaceBelow - gap));

  ui.menu.style.width = `${rect.width}px`;
  ui.menu.style.left = `${rect.left}px`;
  ui.menu.style.maxHeight = `${maxH}px`;
  if (openUp) {
    const h = Math.min(ui.menu.scrollHeight || maxH, maxH);
    ui.menu.style.top = `${Math.max(margin, rect.top - gap - h)}px`;
  } else {
    ui.menu.style.top = `${rect.bottom + gap}px`;
  }
}

function openMenu(sel) {
  if (!isDesktop()) return;
  if (activePreviewSelect === sel) {
    closeOpenMenu();
    return;
  }
  closeOpenMenu();
  activePreviewSelect = sel;
  const ui = sel._previewUi;
  ui.menu.replaceChildren();
  Array.from(sel.options).forEach((opt, idx) => {
    const li = document.createElement("li");
    li.className = "custom-select-option";
    li.setAttribute("role", "option");
    li.dataset.index = String(idx);
    li.textContent = opt.textContent || "";
    li.title = opt.textContent || "";
    const selected = idx === sel.selectedIndex;
    li.classList.toggle("is-selected", selected);
    li.setAttribute("aria-selected", String(selected));
    ui.menu.appendChild(li);
  });
  ui.menu.classList.remove("hidden");
  positionMenu(sel);
  ui.trigger.setAttribute("aria-expanded", "true");
}

function enhancePreviewSelect(sel) {
  const variant = sel.dataset.variant || "flat";
  const wrap = document.createElement("div");
  wrap.className = `custom-select custom-select--${variant}`;
  wrap.dataset.enhanced = "1";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add("custom-select-native");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const valueEl = document.createElement("span");
  valueEl.className = "custom-select-value";
  trigger.append(valueEl, createArrowSvg());
  wrap.appendChild(trigger);

  const menu = document.createElement("ul");
  menu.className = `custom-select-menu custom-select-menu--${variant} hidden`;
  menu.setAttribute("role", "listbox");
  document.body.appendChild(menu);

  sel._previewUi = { wrap, trigger, valueEl, menu };
  syncPreviewSelect(sel);

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    openMenu(sel);
  });

  menu.addEventListener("click", (e) => {
    const li = e.target.closest(".custom-select-option");
    if (!li) return;
    const idx = Number(li.dataset.index);
    if (Number.isInteger(idx)) {
      sel.selectedIndex = idx;
      syncPreviewSelect(sel);
      closeOpenMenu({ restoreFocus: true });
    }
  });

  const label = sel.closest("label.field");
  if (label) {
    label.addEventListener("click", (e) => {
      if (!isDesktop()) return;
      if (e.target.closest(".custom-select")) return;
      e.preventDefault();
      trigger.focus();
    });
  }
}

document.querySelectorAll("select.preview-custom-select").forEach(enhancePreviewSelect);

document.addEventListener("click", (e) => {
  if (!activePreviewSelect || !activePreviewSelect._previewUi) return;
  const { trigger, menu } = activePreviewSelect._previewUi;
  if (trigger.contains(e.target) || menu.contains(e.target)) return;
  closeOpenMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activePreviewSelect) {
    e.preventDefault();
    closeOpenMenu({ restoreFocus: true });
  }
});

window.addEventListener("resize", () => closeOpenMenu());
window.addEventListener("scroll", () => closeOpenMenu(), true);

const themeBtn = document.getElementById("preview-theme-btn");
if (themeBtn) {
  const syncThemeBtn = () => {
    const t = document.documentElement.getAttribute("data-theme") || "dark";
    themeBtn.textContent = t === "dark" ? "切換淺色主題" : "切換深色主題";
  };
  syncThemeBtn();
  themeBtn.addEventListener("click", () => {
    const curr = document.documentElement.getAttribute("data-theme") || "dark";
    const next = curr === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    syncThemeBtn();
  });
}
