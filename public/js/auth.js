// Split from the original app.js; loaded in original order (see index.html).
// ── Auth ─────────────────────────────────────────────────────────────────
// The session cookie is HttpOnly, so this flag is the only thing the page can
// see about its own login state. It holds no secret — it exists so index.html
// can hide the overlay before first paint instead of flashing the login card.
const SIGNED_IN_HINT = "atk_signed_in";

function markSignedIn() {
  state.signedIn = true;
  try {
    localStorage.setItem(SIGNED_IN_HINT, "1");
  } catch {}
  document.documentElement.classList.remove("has-token");
}

function sessionEnded() {
  state.signedIn = false;
  try {
    localStorage.removeItem(SIGNED_IN_HINT);
  } catch {}
  document.documentElement.classList.remove("has-token");
  dom.authOverlay.classList.add("active");
}

async function login() {
  const password = dom.authInput.value.trim();
  if (!password) {
    dom.authError.textContent = "请输入密码";
    return;
  }
  dom.authError.textContent = "";
  dom.authBtn.disabled = true;
  try {
    await api("/api/login", { method: "POST", body: { password } });
    markSignedIn();
    dom.authOverlay.classList.remove("active");
    dom.authInput.value = "";
    await initApp();
  } catch (err) {
    sessionEnded();
    dom.authError.textContent =
      err.message === "Unauthorized" ? "密码错误" : `认证失败：${err.message}`;
  } finally {
    dom.authBtn.disabled = false;
  }
}

async function logout() {
  // Only the server can clear an HttpOnly cookie; if the call fails the cookie
  // outlives the click, so the UI must not pretend otherwise.
  try {
    await api("/api/logout", { method: "POST" });
  } catch {}
  state.settings = null;
  state.storageBackend = "d1";
  state.deadKeys = [];
  state.proxy = null;
  state.proxySelected = null;
  state.proxyPage = 1;
  state.proxyCardOrder = null;
  state.proxyPlainKeys.clear();
  if (typeof closeOpenCustomSelect === "function") closeOpenCustomSelect();
  state.proxyDisablingKeys.clear();
  state.proxyTestingKeys.clear();
  state.proxyRecoveringKeys.clear();
  sessionEnded();
  dom.authInput.value = "";
}
