// Split from the original app.js; loaded in original order (see index.html).
// ── Theme ────────────────────────────────────────────────────────────────
function getTheme() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  dom.themeToggle.textContent = theme === "dark" ? "🌙" : "☀️";
  try {
    localStorage.setItem("atk_theme", theme);
  } catch {}
}

function toggleTheme() {
  applyTheme(getTheme() === "dark" ? "light" : "dark");
}
