const THEME_KEY = "atk_theme";

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

const digitsBtn = document.getElementById("preview-digits-btn");
if (digitsBtn) {
  let large = false;
  const syncDigits = () => {
    const okVal = large ? "128" : "3";
    const failVal = large ? "14" : "1";
    document.querySelectorAll("[data-ok]").forEach((el) => {
      el.textContent = okVal;
    });
    document.querySelectorAll("[data-fail]").forEach((el) => {
      el.textContent = failVal;
    });
    digitsBtn.textContent = large ? "切換小數字 (3 / 1)" : "切換大數字 (128 / 14)";
  };
  digitsBtn.addEventListener("click", () => {
    large = !large;
    syncDigits();
  });
}

