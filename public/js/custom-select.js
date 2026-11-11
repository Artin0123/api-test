// Split from the original app.js; loaded in original order (see index.html).
// ── Desktop flat custom select (mobile/touch keeps native <select>) ───────
const desktopSelectMql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(min-width: 641px) and (hover: hover) and (pointer: fine)")
    : null;
let activeCustomSelect = null;

function isDesktopCustomSelect() {
  return !!(desktopSelectMql && desktopSelectMql.matches);
}

function createSelectArrowSvg() {
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

function syncCustomSelect(select) {
  const ui = select && select._customUi;
  if (!ui) return;
  const opts = Array.from(select.options || []);
  const selectedOpt =
    (select.selectedIndex >= 0 && opts[select.selectedIndex]) ||
    opts.find((o) => o.selected) ||
    opts[0] ||
    null;
  const label = selectedOpt ? selectedOpt.textContent || "" : "";
  ui.valueEl.textContent = label;
  ui.trigger.title = label;
  ui.trigger.disabled = !!select.disabled;
  ui.wrap.classList.toggle("is-disabled", !!select.disabled);
  if (activeCustomSelect === select) {
    renderCustomSelectMenu(select);
  }
}

function setCustomMenuActive(select, nextIdx) {
  const ui = select && select._customUi;
  if (!ui) return;
  const items = Array.from(ui.menu.querySelectorAll(".custom-select-option"));
  if (!items.length) {
    ui.activeIndex = -1;
    return;
  }
  const bounded = Math.max(0, Math.min(nextIdx, items.length - 1));
  ui.activeIndex = bounded;
  items.forEach((item, idx) => {
    item.classList.toggle("is-active", idx === bounded);
  });
  const activeItem = items[bounded];
  if (activeItem && typeof activeItem.scrollIntoView === "function") {
    activeItem.scrollIntoView({ block: "nearest" });
  }
}

function moveCustomMenuActive(select, step) {
  const ui = select && select._customUi;
  if (!ui) return;
  const opts = Array.from(select.options || []);
  if (!opts.length) return;
  let idx = ui.activeIndex;
  for (let i = 0; i < opts.length; i++) {
    idx = (idx + step + opts.length) % opts.length;
    if (!opts[idx].disabled) {
      setCustomMenuActive(select, idx);
      return;
    }
  }
}

function positionCustomSelectMenu(select) {
  const ui = select && select._customUi;
  if (!ui) return;
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
    const measured = Math.min(ui.menu.scrollHeight || maxH, maxH);
    ui.menu.style.top = `${Math.max(margin, rect.top - gap - measured)}px`;
  } else {
    ui.menu.style.top = `${rect.bottom + gap}px`;
  }
}

function renderCustomSelectMenu(select) {
  const ui = select && select._customUi;
  if (!ui) return;
  const opts = Array.from(select.options || []);
  ui.menu.replaceChildren();
  opts.forEach((opt, idx) => {
    const li = document.createElement("li");
    li.className = "custom-select-option";
    li.setAttribute("role", "option");
    li.dataset.index = String(idx);
    const label = opt.textContent || "";
    li.textContent = label;
    li.title = opt.title || label;
    const isSelected = idx === select.selectedIndex;
    li.classList.toggle("is-selected", isSelected);
    li.setAttribute("aria-selected", String(isSelected));
    if (opt.disabled) {
      li.classList.add("is-disabled");
      li.setAttribute("aria-disabled", "true");
    }
    ui.menu.appendChild(li);
  });
  const initialIdx =
    select.selectedIndex >= 0
      ? select.selectedIndex
      : opts.findIndex((o) => !o.disabled);
  setCustomMenuActive(select, initialIdx);
}

function closeOpenCustomSelect({ restoreFocus = false } = {}) {
  const select = activeCustomSelect;
  if (!select || !select._customUi) return false;
  const ui = select._customUi;
  activeCustomSelect = null;
  ui.menu.classList.add("hidden");
  ui.trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus && typeof ui.trigger.focus === "function") {
    ui.trigger.focus();
  }
  return true;
}

function openCustomSelectMenu(select) {
  if (!select || !select._customUi || select.disabled || !isDesktopCustomSelect()) return;
  if (activeCustomSelect === select) {
    closeOpenCustomSelect();
    return;
  }
  closeOpenCustomSelect();
  activeCustomSelect = select;
  const ui = select._customUi;
  renderCustomSelectMenu(select);
  ui.menu.classList.remove("hidden");
  positionCustomSelectMenu(select);
  ui.trigger.setAttribute("aria-expanded", "true");
  if (ui.activeIndex >= 0) {
    setCustomMenuActive(select, ui.activeIndex);
  }
}

function commitCustomSelectIndex(select, idx) {
  const opts = Array.from(select.options || []);
  const opt = opts[idx];
  if (!opt || opt.disabled) return;
  const changed = select.selectedIndex !== idx;
  select.selectedIndex = idx;
  syncCustomSelect(select);
  closeOpenCustomSelect({ restoreFocus: true });
  if (changed) {
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function enhanceSelect(select) {
  if (!select || select._customUi) return;
  const parent = select.parentNode;
  if (!parent) return;

  const wrap = document.createElement("div");
  wrap.className = "custom-select";
  wrap.dataset.enhanced = "1";
  parent.insertBefore(wrap, select);
  wrap.appendChild(select);
  select.classList.add("custom-select-native");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const valueEl = document.createElement("span");
  valueEl.className = "custom-select-value";
  trigger.append(valueEl, createSelectArrowSvg());
  wrap.appendChild(trigger);

  const menu = document.createElement("ul");
  menu.className = "custom-select-menu hidden";
  menu.setAttribute("role", "listbox");
  document.body.appendChild(menu);

  select._customUi = { wrap, trigger, valueEl, menu, activeIndex: -1 };
  syncCustomSelect(select);

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    openCustomSelectMenu(select);
  });

  trigger.addEventListener("keydown", (e) => {
    if (!isDesktopCustomSelect()) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (activeCustomSelect !== select) {
        openCustomSelectMenu(select);
      } else {
        moveCustomMenuActive(select, e.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      if (activeCustomSelect === select) {
        e.preventDefault();
        const idx = select._customUi.activeIndex;
        if (idx >= 0) commitCustomSelectIndex(select, idx);
        else closeOpenCustomSelect({ restoreFocus: true });
      }
      return;
    }
    if (e.key === "Tab" && activeCustomSelect === select) {
      closeOpenCustomSelect();
    }
  });

  menu.addEventListener("click", (e) => {
    const li = e.target.closest(".custom-select-option");
    if (!li) return;
    const idx = Number(li.dataset.index);
    if (Number.isInteger(idx)) commitCustomSelectIndex(select, idx);
  });

  const label = select.closest("label.field");
  if (label) {
    label.addEventListener("click", (e) => {
      if (!isDesktopCustomSelect()) return;
      if (e.target.closest(".custom-select, .info-icon")) return;
      e.preventDefault();
      if (!trigger.disabled) trigger.focus();
    });
  }

  const observer = new MutationObserver(() => syncCustomSelect(select));
  observer.observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });
}

function initCustomSelects() {
  document.querySelectorAll("select.input-select").forEach(enhanceSelect);
  document.addEventListener("click", (e) => {
    if (!activeCustomSelect || !activeCustomSelect._customUi) return;
    const { trigger, menu } = activeCustomSelect._customUi;
    if (trigger.contains(e.target) || menu.contains(e.target)) return;
    closeOpenCustomSelect();
  });
  window.addEventListener("resize", () => closeOpenCustomSelect());
  window.addEventListener(
    "scroll",
    (e) => {
      if (!activeCustomSelect || !activeCustomSelect._customUi) return;
      if (activeCustomSelect._customUi.menu.contains(e.target)) return;
      closeOpenCustomSelect();
    },
    true,
  );
  if (desktopSelectMql && typeof desktopSelectMql.addEventListener === "function") {
    desktopSelectMql.addEventListener("change", () => closeOpenCustomSelect());
  }
}
