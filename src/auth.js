// src/auth.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
const SESSION_COOKIE = "atk_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Bumping this invalidates every cookie in circulation without touching the password.
const SESSION_VERSION = "v1";

/** Length is allowed to leak; the byte comparison itself is constant-time. */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sessions are stateless: the cookie is `<expiry-ms>.<HMAC(ADMIN_PASSWORD, ver.expiry)>`.
 * No KV round-trip on the read path (which would otherwise double the read quota this
 * app spends per page view), and rotating ADMIN_PASSWORD or SESSION_VERSION revokes
 * every outstanding cookie. The trade-off is that a single cookie cannot be revoked
 * on its own — acceptable for a single shared admin login.
 */
async function issueSession(adminPassword) {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${await hmacHex(adminPassword, `${SESSION_VERSION}.${exp}`)}`;
}

async function sessionIsValid(adminPassword, value) {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const exp = value.slice(0, dot);
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || Date.now() >= expMs) return false;
  const expected = await hmacHex(adminPassword, `${SESSION_VERSION}.${exp}`);
  return timingSafeEqual(value.slice(dot + 1), expected);
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/**
 * Path=/api keeps the cookie off static asset requests. SameSite=Strict is what
 * stands in for a CSRF token here: the write endpoints parse the body with
 * request.json() without checking Content-Type, so a cross-site form post would
 * otherwise be accepted — Strict means no cross-site request carries the cookie,
 * while typing an /api/ URL into the address bar still does.
 */
function sessionCookieHeader(value, maxAgeSeconds) {
  return (
    `${SESSION_COOKIE}=${value}; Max-Age=${maxAgeSeconds}; Path=/api; ` +
    `HttpOnly; Secure; SameSite=Strict`
  );
}

async function requireAuth(request, env) {
  const adminPassword = (env.ADMIN_PASSWORD || "").trim();
  if (!adminPassword) return false;

  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    return timingSafeEqual(auth.slice(7), adminPassword);
  }
  return sessionIsValid(adminPassword, readCookie(request, SESSION_COOKIE));
}

async function handleLogin(request, env) {
  const adminPassword = (env.ADMIN_PASSWORD || "").trim();
  if (!adminPassword) return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const password = typeof body.password === "string" ? body.password.trim() : "";
  if (!password || !timingSafeEqual(password, adminPassword)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const value = await issueSession(adminPassword);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookieHeader(value, Math.floor(SESSION_TTL_MS / 1000)),
    },
  });
}

function handleLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookieHeader("", 0),
    },
  });
}

function parseJsonOrNull(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
