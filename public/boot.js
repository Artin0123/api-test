// Runs before first paint, as a render-blocking script in <head>.
//
// It lives in its own file rather than inline in index.html so the CSP can say
// script-src 'self': an inline script would force either 'unsafe-inline' or a
// hash that silently stops matching the moment this code is edited.
(() => {
    try {
        const saved = localStorage.getItem("atk_theme");
        const theme =
            saved ||
            (matchMedia("(prefers-color-scheme: light)").matches
                ? "light"
                : "dark");
        document.documentElement.setAttribute("data-theme", theme);
        // Not a credential — the session lives in an HttpOnly cookie. This only
        // avoids flashing the login card at a user who is already signed in;
        // app.js verifies for real.
        if (localStorage.getItem("atk_signed_in") === "1") {
            document.documentElement.classList.add("has-token");
        }
    } catch {}
})();
