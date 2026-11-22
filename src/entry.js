// src/entry.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
/**
 * Cloudflare Pages API Gateway — async_test_keys edition
 *
 * KV / D1 store keys:
 *     app_settings               { providers[], github_url, discord_webhook_url, ... }
 *     results:{fingerprint}      per-provider latest test results
 *     test_run_status            global { started_at } flag for running workflow (90m TTL)
 *     dead_keys                  synced dead key records (array)
 *
 * Secrets required:
 *   ADMIN_PASSWORD
 *
 * Auth: every /api/ endpoint requires either `Authorization: Bearer <ADMIN_PASSWORD>`
 * (used by async_test_keys.py and the GHA workflow) or the session cookie issued by
 * POST /api/login (used by the browser, so URLs can be opened straight from the
 * address bar without a REST client).
 *
 * Fingerprint = SHA-256( JSON.stringify({ api_base, provider_type }) )
 * key order must be alphabetical — matches both frontend and Python script.
 */

const ROUTES = {
  "POST /api/login": handleLogin,
  "POST /api/logout": handleLogout,
  "GET /api/settings": handleGetSettings,
  "POST /api/settings": handlePostSettings,
  "GET /api/results": handleGetResults,
  "POST /api/results": handlePostResults,
  "GET /api/run-status": handleGetRunStatus,
  "POST /api/run-status": handlePostRunStatus,
  "DELETE /api/run-status": handleDeleteRunStatus,
  "GET /api/dead-keys": handleGetDeadKeys,
  "DELETE /api/dead-keys": handleDeleteDeadKey,
  "GET /api/proxy/state": handleGetProxyState,
  "POST /api/proxy/test": handleProxyTest,
  "POST /api/proxy/recover": handleProxyRecover,
  "POST /api/proxy/disable": handleProxyDisable,
  "POST /api/proxy/test-model": handleProxyTestModel,
};

/**
 * A `_headers` file cannot do this job: Cloudflare does not apply it to
 * responses produced by Pages Functions, and in advanced mode that is every
 * response, including the ones handed back from env.ASSETS.fetch(). So the
 * headers are attached here instead, on the way out.
 *
 * CSP notes, each of which fails silently if broken:
 *   script-src 'self'  — index.html must keep its pre-paint script in boot.js;
 *                        an inline <script> would need a hash that goes stale.
 *   style-src 'self'   — no style="" attributes anywhere, including the strings
 *                        app.js builds for innerHTML. Writing element.style from
 *                        JS is fine, CSP does not cover CSSOM.
 *   img-src data:      — the favicon is an inline SVG data URI.
 *   connect-src        — the Discord test button posts straight from the page to
 *                        the webhook URL the user typed. Only Discord's own hosts
 *                        are allowed; a webhook behind any other domain (a relay,
 *                        a proxy) will be blocked and needs adding here.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://discord.com https://discordapp.com",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), " +
    "magnetometer=(), microphone=(), payment=(), usb=()",
};

function withSecurityHeaders(response) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(name, value);
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/");
    const isProxy = url.pathname.startsWith("/proxy/");

    if (!isApi && !isProxy) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }

    // Pages Functions have no startup phase, so a bad storage setting can only be
    // reported per request. Static assets stay reachable on purpose — the page
    // itself has to load, otherwise the operator sees a blank 500 instead of the
    // reason. /api/storage/* is exempt: export only needs KV and is exactly what
    // an operator reaches for when the backend is misconfigured.
    if (isApi && !url.pathname.startsWith("/api/storage/")) {
      const configError = storageConfigError(env);
      if (configError) {
        return withSecurityHeaders(
          json({ error: configError, code: "CONFIG_ERROR" }, 500),
        );
      }
    }

    if (isProxy) {
      try {
        return withSecurityHeaders(await handleProxy(request, env, url));
      } catch (err) {
        if (err && err.code === "CONFIG_ERROR") {
          return withSecurityHeaders(json({ error: err.message }, 500));
        }
        console.error(err);
        return withSecurityHeaders(
          json({ error: "Internal Server Error" }, 500),
        );
      }
    }

    const key = `${request.method} ${url.pathname}`;
    const handler = ROUTES[key];
    if (!handler) return withSecurityHeaders(text("Not Found", 404));

    try {
      if (!url.pathname.startsWith("/api/storage/")) {
        const configError = storageConfigError(env);
        if (configError) {
          return withSecurityHeaders(
            json({ error: configError, code: "CONFIG_ERROR" }, 500),
          );
        }
      }
      return withSecurityHeaders(await handler(request, env, url));
    } catch (err) {
      if (err && err.code === "CONFIG_ERROR") {
        return withSecurityHeaders(json({ error: err.message }, 500));
      }
      console.error(err);
      return withSecurityHeaders(json({ error: "Internal Server Error" }, 500));
    }
  },
};

// ─── storage backend (KV ⇄ D1) ─────────────────────────────────────────────
// STORAGE_BACKEND defaults to d1 on purpose: the proxy needs single-row atomic
// updates (key_state), which KV's final consistency and 1,000 writes/day cannot
// provide. Existing KV-only deployments must set STORAGE_BACKEND=kv explicitly
// until they have created D1, bound it as DB and run the migration — deploying
// without that order turns every /api request into a 500.
