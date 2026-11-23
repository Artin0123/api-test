/**
 * Offline regression tests for the KV ⇄ D1 backend, the forwarding proxy and
 * the migration/backup endpoints.
 *
 * Nothing here touches a real key or the network: D1 is node:sqlite behind a
 * tiny prepare/bind/all/run shim, KV is an in-memory map, and the upstream is a
 * local http server. Run with `npm test`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";

import worker from "../public/_worker.js";

// ── D1 shim ────────────────────────────────────────────────────────────────

class FakeStatement {
  constructor(owner, db, sql, params = []) {
    this.owner = owner;
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    // Mirror Cloudflare D1's 100 bound-parameter per SQL statement limit.
    if (params.length > 100) {
      throw new Error(
        `D1 parameter limit exceeded: ${params.length} > 100 bound parameters`,
      );
    }
    return new FakeStatement(this.owner, this.db, this.sql, params);
  }

  async first() {
    this.owner.queryCalls++;
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }

  async all() {
    this.owner.queryCalls++;
    const rows = this.db.prepare(this.sql).all(...this.params);
    return { results: rows, success: true, meta: { changes: 0 } };
  }

  async run() {
    this.owner.queryCalls++;
    const result = this.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: { changes: Number(result.changes || 0) },
    };
  }
}

class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.batchCalls = 0;
    this.queryCalls = 0;
  }

  prepare(sql) {
    return new FakeStatement(this, this.db, sql);
  }

  async batch(stmts) {
    this.batchCalls++;
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (const stmt of stmts) {
        if (/^\s*(?:SELECT|PRAGMA)\b|\bRETURNING\b/i.test(stmt.sql)) {
          results.push(await stmt.all());
        } else {
          results.push(await stmt.run());
        }
      }
      this.db.exec("COMMIT");
      return results;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

// ── KV shim ────────────────────────────────────────────────────────────────

class FakeKV {
  constructor(entries = {}, pageSize = 1000) {
    this.map = new Map(Object.entries(entries));
    this.pageSize = pageSize;
    this.ops = 0;
  }

  async get(key) {
    this.ops++;
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async put(key, value) {
    this.ops++;
    this.map.set(key, value);
  }

  async delete(key) {
    this.ops++;
    this.map.delete(key);
  }

  async list({ prefix = "", cursor = null, limit = 1000 } = {}) {
    this.ops++;
    const size = Math.min(Number(limit) || 1000, this.pageSize);
    const names = [...this.map.keys()]
      .filter((name) => name.startsWith(prefix))
      .filter((name) => (cursor ? name > cursor : true))
      .sort();
    const slice = names.slice(0, size);
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: slice.length < size,
      cursor: slice.length ? slice[slice.length - 1] : null,
    };
  }
}

// ── harness ────────────────────────────────────────────────────────────────

const ADMIN = "admin-secret";
const PROXY = "proxy-secret";

let server;
let upstreamHandler;
let captured;
let outboundCalls;
let pendingWaitUntil;
let originalFetch;

function defaultUpstream(req, res, body) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      auth: req.headers.authorization || req.headers["x-api-key"] || "",
      body,
    }),
  );
}

function resetCaptured() {
  captured = [];
  outboundCalls = [];
  pendingWaitUntil = [];
}

async function drainWaitUntil() {
  while (pendingWaitUntil.length > 0) {
    const batch = pendingWaitUntil.splice(0, pendingWaitUntil.length);
    await Promise.all(batch);
  }
}

function useUpstream(handler) {
  upstreamHandler = handler;
}

function makeEnv({ db = new FakeD1(), kv = new FakeKV(), vars = {} } = {}) {
  return {
    DB: db,
    KV_STORE: kv,
    ASSETS: {
      fetch: async () => new Response("static", { status: 200 }),
    },
    ADMIN_PASSWORD: ADMIN,
    ...vars,
  };
}

async function request(
  env,
  path,
  { method = "GET", headers = {}, body, awaitWaitUntil = true } = {},
) {
  const ctx = {
    waitUntil(promise) {
      pendingWaitUntil.push(Promise.resolve(promise));
    },
  };
  const res = await worker.fetch(
    new Request(`https://example.test${path}`, {
      method,
      headers,
      body,
    }),
    env,
    ctx,
  );
  if (awaitWaitUntil) {
    await drainWaitUntil();
  }
  return res;
}

async function asJson(response) {
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, headers: response.headers, data };
}

function adminHeaders(extra = {}) {
  return { Authorization: `Bearer ${ADMIN}`, ...extra };
}

function proxyHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${PROXY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function provider(overrides = {}) {
  return {
    enabled: true,
    provider_type: "openai",
    api_base: `${upstreamBase()}/v1`,
    keys: "k1\nk2\nk3",
    models: "m1",
    extra_body: "",
    custom_headers: [],
    ...(overrides.provider_type === "google" ? {} : { test_path: "/chat/completions" }),
    ...overrides,
  };
}

function upstreamBase() {
  return `http://127.0.0.1:${server.address().port}`;
}

async function postSettings(env, providers, settingsOverrides = {}) {
  const payload = {
    providers,
    proxy_password: PROXY,
    proxy_fail_threshold: 3,
    proxy_max_retries: 3,
    proxy_upstream_timeout_ms: 120000,
    ...settingsOverrides,
  };
  const response = await request(env, "/api/settings", {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(response);
}

async function postTestModel(env, fp, model) {
  return asJson(
    await request(env, "/api/proxy/test-model", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp, model }),
    }),
  );
}

async function proxy(env, path, options = {}) {
  return asJson(
    await request(env, path, {
      method: "POST",
      headers: proxyHeaders(),
      body: JSON.stringify({ model: "m1", messages: [] }),
      ...options,
    }),
  );
}

async function getKeyRows(env, fp) {
  const response = await request(env, "/api/proxy/state", {
    headers: adminHeaders(),
  });
  const { data } = await asJson(response);
  const found = data.providers.find((p) => p.fp === fp);
  return found ? found.keys : null;
}

function fingerprintOfEntry(entry) {
  return crypto.subtle
    .digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({
          api_base: entry.api_base.replace(/\/+$/, ""),
          provider_type: entry.provider_type,
        }),
      ),
    )
    .then((buf) =>
      [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
}

async function fingerprintOf(env, providerEntry) {
  const response = await request(env, "/api/proxy/state", {
    headers: adminHeaders(),
  });
  const { data } = await asJson(response);
  const fp = await fingerprintOfEntry(providerEntry);
  const found = data.providers.find((p) => p.fp === fp);
  return found ? found.fp : null;
}

test.before(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const rawUrl = String(url);
    const parsed = new URL(rawUrl);
    const headers = new Headers(init.headers);
    outboundCalls.push({
      url: rawUrl,
      method: init.method || "GET",
      headers,
      redirect: init.redirect || "follow",
    });

    const isLoopback =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]";
    const targetUrl = isLoopback
      ? rawUrl
      : `${upstreamBase()}${parsed.pathname}${parsed.search}`;
    return originalFetch(targetUrl, init);
  };

  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      captured.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body,
      });
      upstreamHandler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});

test.beforeEach(() => {
  resetCaptured();
  useUpstream(defaultUpstream);
  worker.__test.resetClock();
  worker.__test.setRandom(() => 0);
  worker.__test.resetLogCleanupEvery();
});

test.after(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  server.close();
});

// ── R0: storage backend ────────────────────────────────────────────────────

test("default backend without DB returns a readable 500 while static assets still load", async () => {
  const env = { ASSETS: { fetch: async () => new Response("page") }, ADMIN_PASSWORD: ADMIN };
  const api = await asJson(await request(env, "/api/settings", { headers: adminHeaders() }));
  assert.equal(api.status, 500);
  assert.equal(api.data.code, "CONFIG_ERROR");
  assert.match(api.data.error, /D1/);

  const page = await request(env, "/", { headers: {} });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "page");
});

test("an invalid STORAGE_BACKEND fails loudly instead of silently falling back", async () => {
  const env = makeEnv({ vars: { STORAGE_BACKEND: "sqlite" } });
  const api = await asJson(await request(env, "/api/settings", { headers: adminHeaders() }));
  assert.equal(api.status, 500);
  assert.match(api.data.error, /sqlite/);
});

test("d1 works against an empty database without a manual schema step", async () => {
  const env = makeEnv();
  const got = await asJson(await request(env, "/api/settings", { headers: adminHeaders() }));
  assert.equal(got.status, 200);
  assert.deepEqual(got.data.settings.providers, []);
});

test("kv mode keeps existing settings/results behaviour", async () => {
  const env = makeEnv({ vars: { STORAGE_BACKEND: "kv" } });
  const saved = await postSettings(env, [provider()]);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.version, 1);
  assert.equal(saved.data.storage_backend, "kv");

  const got = await asJson(await request(env, "/api/settings", { headers: adminHeaders() }));
  assert.equal(got.data.storage_backend, "kv");
  assert.equal(got.data.settings.providers.length, 1);
  assert.match(got.data.settings.providers[0].keys, /k1/);
});

// ── R1: forwarding + auth ──────────────────────────────────────────────────

test("kv mode disables the proxy and all /api/proxy/* endpoints without outbound requests", async () => {
  const env = makeEnv({ vars: { STORAGE_BACKEND: "kv" } });

  const unauthState = await asJson(await request(env, "/api/proxy/state"));
  assert.equal(unauthState.status, 401);

  const checks = [
    ["/proxy/abc/chat/completions", { method: "POST", headers: proxyHeaders(), body: "{}" }],
    ["/api/proxy/state", { headers: adminHeaders() }],
    ["/api/proxy/test", { method: "POST", headers: adminHeaders(), body: "{}" }],
    ["/api/proxy/test-commit", { method: "POST", headers: adminHeaders(), body: "{}" }],
    ["/api/proxy/disable", { method: "POST", headers: adminHeaders(), body: "{}" }],
    ["/api/proxy/recover", { method: "POST", headers: adminHeaders(), body: "{}" }],
    ["/api/proxy/test-model", { method: "POST", headers: adminHeaders(), body: "{}" }],
    ["/api/proxy/logs", { headers: adminHeaders() }],
  ];
  for (const [path, init] of checks) {
    const result = await asJson(await request(env, path, init));
    assert.equal(result.status, 503, `${path} should return 503 in KV mode`);
    assert.equal(result.data.code, "PROXY_DISABLED");
    assert.match(result.data.error, /d1/i);
  }
  const delLogsRes = await request(env, "/api/proxy/logs", {
    method: "DELETE",
    headers: adminHeaders(),
  });
  assert.equal(delLogsRes.status, 404, "DELETE /api/proxy/logs is removed");
  assert.equal(captured.length, 0);
});

test("alias validation rejects bad formats and duplicates at save time", async () => {
  const env = makeEnv();
  const bad = await postSettings(env, [provider({ alias: "OpenAI" })]);
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /alias/);

  const dup = await postSettings(env, [
    provider({ alias: "same" }),
    provider({ alias: "same" }),
  ]);
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /重复/);
});

test("proxy password is independent from the admin password and accepts all three SDK headers", async () => {
  const env = makeEnv();
  await postSettings(env, [provider({ alias: "openai", keys: "k1" })]);

  const noAuth = await asJson(
    await request(env, "/proxy/openai/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(noAuth.status, 401);

  const admin = await asJson(
    await request(env, "/proxy/openai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(admin.status, 401);

  for (const header of ["Authorization", "x-api-key", "x-goog-api-key"]) {
    const value = header === "Authorization" ? `Bearer ${PROXY}` : PROXY;
    const result = await asJson(
      await request(env, "/proxy/openai/chat/completions", {
        method: "POST",
        headers: { [header]: value, "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(result.status, 200, header);
  }
});

test("proxy routes directly to provider api_base, keeps query string and replaces auth", async () => {
  const env = makeEnv();
  await postSettings(env, [provider({ alias: "openai", keys: "key-aaaa" })]);

  const result = await proxy(env, "/proxy/openai/chat/completions?x=1");
  assert.equal(result.status, 200);
  assert.equal(outboundCalls.length, 1);
  assert.equal(
    outboundCalls[0].url,
    `${upstreamBase()}/v1/chat/completions?x=1`,
  );
  assert.equal(outboundCalls[0].redirect, "manual");
  for (const [k] of outboundCalls[0].headers.entries()) {
    assert.equal(k.toLowerCase().startsWith("cf-aig-"), false);
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "/v1/chat/completions?x=1");
  assert.equal(captured[0].headers.authorization, "Bearer key-aaaa");
});

test("unknown alias is rejected before upstream; disabled provider with alias still proxies", async () => {
  const env = makeEnv();
  await postSettings(env, [
    provider({ alias: "off", enabled: false, keys: "k1" }),
  ]);

  const unknown = await proxy(env, "/proxy/nope/chat/completions");
  assert.equal(unknown.status, 404);
  assert.equal(captured.length, 0);

  const allowed = await proxy(env, "/proxy/off/chat/completions");
  assert.equal(allowed.status, 200);
  assert.equal(captured.length, 1);
});

test("an empty suffix lands on api_base itself", async () => {
  const env = makeEnv();
  await postSettings(env, [provider({ alias: "base", keys: "k1" })]);

  const emptySuffix = await asJson(
    await request(env, "/proxy/base", {
      method: "GET",
      headers: { Authorization: `Bearer ${PROXY}` },
    }),
  );
  assert.equal(emptySuffix.status, 200);
  assert.equal(captured[0].url, "/v1");
});

test("a provider without keys is rejected at save time", async () => {
  const env = makeEnv();
  const result = await postSettings(env, [
    provider({ alias: "nokeys", keys: "" }),
  ]);
  assert.equal(result.status, 400);
  assert.match(result.data.error, /API Key/);
});

test("all keys disabled returns 503 NO_KEYS without calling upstream", async () => {
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const env = makeEnv();
  const p = provider({ alias: "alloff", keys: "k1\nk2" });
  await postSettings(env, [p]);
  const fp = await fingerprintOf(env, p);
  await env.DB.prepare("UPDATE key_state SET disabled = 1 WHERE fp = ?")
    .bind(fp)
    .run();
  worker.__test.invalidateSnapshot(env.DB);

  const result = await proxy(env, "/proxy/alloff/chat/completions");
  assert.equal(result.status, 503);
  assert.equal(result.data.code, "NO_KEYS");
  assert.equal(captured.length, 0);
});

test("extra body, custom headers, cookie and caller cf-aig-* handling", async () => {
  const env = makeEnv();
  await postSettings(env, [
    provider({
      alias: "openai",
      keys: "k1",
      extra_body: '{"temperature":0.2,"stream":true}',
      custom_headers: [{ key: "X-Custom", value: "yes" }],
    }),
  ]);

  const response = await proxy(env, "/proxy/openai/chat/completions", {
    headers: proxyHeaders({
      Cookie: "atk_session=leak",
      "cf-aig-metadata": '{"key":"forged"}',
      "cf-aig-authorization": "Bearer forged",
      "cf-aig-skip-cache": "false",
      "cf-connecting-ip": "203.0.113.7",
      "cf-ray": "abc123-HKG",
      "cf-ipcountry": "TW",
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
    }),
    body: JSON.stringify({ model: "m1", temperature: 1, messages: [] }),
  });
  assert.equal(response.status, 200);

  const sent = captured[0];
  assert.equal(sent.headers["x-custom"], "yes");
  assert.equal(sent.headers.cookie, undefined);
  assert.equal(sent.headers["cf-aig-metadata"], undefined);
  assert.equal(sent.headers["cf-aig-authorization"], undefined);
  assert.equal(sent.headers["cf-aig-skip-cache"], undefined);
  // Cloudflare metadata / caller IP must not reach a third-party upstream.
  for (const name of [
    "cf-connecting-ip",
    "cf-ray",
    "cf-ipcountry",
    "x-forwarded-for",
    "x-real-ip",
  ]) {
    assert.equal(sent.headers[name], undefined, `${name} 不該外流`);
  }
  const parsed = JSON.parse(sent.body);
  assert.equal(parsed.temperature, 0.2);
  assert.equal(parsed.stream, true);
  assert.equal(parsed.model, "m1");
});

test("google and anthropic use their own auth headers", async () => {
  const env = makeEnv();
  await postSettings(env, [
    provider({
      alias: "gem",
      provider_type: "google",
      api_base: `${upstreamBase()}/v1beta`,
      keys: "g-key",
      models: "gemini-2.5-pro",
    }),
    provider({
      alias: "cla",
      provider_type: "anthropic",
      api_base: `${upstreamBase()}/v1`,
      keys: "a-key",
      models: "claude-test",
    }),
  ]);

  await proxy(env, "/proxy/gem/models/gemini-2.5-pro:generateContent");
  assert.equal(captured[0].headers["x-goog-api-key"], "g-key");
  assert.equal(captured[0].headers.authorization, undefined);

  await proxy(env, "/proxy/cla/messages");
  assert.equal(captured[1].headers["x-api-key"], "a-key");
  assert.equal(captured[1].headers["anthropic-version"], "2023-06-01");
});

test("streaming responses pass through as SSE", async () => {
  useUpstream((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    res.write("data: one\n\n");
    setTimeout(() => {
      res.write("data: two\n\n");
      res.end();
    }, 20);
  });
  const env = makeEnv();
  await postSettings(env, [provider({ alias: "openai", keys: "k1" })]);

  const response = await request(env, "/proxy/openai/chat/completions", {
    method: "POST",
    headers: proxyHeaders(),
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), "data: one\n\ndata: two\n\n");
});

// ── R2/R3/R4: rotation, ledger, retries ────────────────────────────────────

test("six requests over three keys are split 2/2/2", async () => {
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1\nk2\nk3" });
  await postSettings(env, [p]);
  for (let i = 0; i < 6; i++) {
    const result = await proxy(env, "/proxy/openai/chat/completions");
    assert.equal(result.status, 200);
  }
  const counts = {};
  for (const call of captured) {
    const key = call.headers.authorization;
    counts[key] = (counts[key] || 0) + 1;
  }
  assert.deepEqual(counts, {
    "Bearer k1": 2,
    "Bearer k2": 2,
    "Bearer k3": 2,
  });
});

test("a retryable failure moves to the next key and counts against the first", async () => {
  useUpstream((req, res) => {
    if (req.headers.authorization === "Bearer bad") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"error":"invalid key"}');
      return;
    }
    defaultUpstream(req, res, "");
  });
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "bad\ngood" });
  await postSettings(env, [p], { proxy_fail_threshold: 3 });
  const fp = await fingerprintOf(env, p);

  const result = await proxy(env, "/proxy/openai/chat/completions");
  assert.equal(result.status, 200);
  assert.deepEqual(
    captured.map((c) => c.headers.authorization),
    ["Bearer bad", "Bearer good"],
  );

  const keys = await getKeyRows(env, fp);
  const bad = keys.find((k) => k.masked === "bad");
  assert.equal(bad.fail_count, 1);
  assert.equal(bad.disabled, false);
});

test("failure threshold disables a key; recovery is manual or via the next daily pass", async () => {
  useUpstream((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":"invalid key"}');
  });
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "only" });
  await postSettings(env, [p], { proxy_fail_threshold: 1 });
  const fp = await fingerprintOf(env, p);

  const first = await proxy(env, "/proxy/openai/chat/completions");
  assert.equal(first.status, 401);

  const keys = await getKeyRows(env, fp);
  assert.equal(keys[0].disabled, true);
  assert.equal(keys[0].fail_count, 1);

  const second = await proxy(env, "/proxy/openai/chat/completions");
  assert.equal(second.status, 503);
  assert.equal(second.data.code, "NO_KEYS");
  assert.equal(captured.length, 1);

  const recovered = await asJson(
    await request(env, "/api/proxy/recover", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp, id: keys[0].id }),
    }),
  );
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.key.disabled, false);
  assert.equal(recovered.data.key.fail_count, 0);

  useUpstream(defaultUpstream);
  const third = await proxy(env, "/proxy/openai/chat/completions");
  assert.equal(third.status, 200);
});

test("every non-2xx is charged, including a caller-error 400", async () => {
  useUpstream((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end('{"error":"bad request"}');
  });
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1\nk2\nk3" });
  await postSettings(env, [p], { proxy_fail_threshold: 1 });
  const fp = await fingerprintOf(env, p);

  // One request walks all three keys, so each key gets exactly one failure and
  // the threshold of 1 disables all of them. That is the agreed rule: no
  // per-status guessing (Gemini answers 400 for a dead key).
  const result = await proxy(env, "/proxy/openai/chat/completions");
  assert.equal(result.status, 400);

  const keys = await getKeyRows(env, fp);
  assert.deepEqual(
    keys.map((k) => [k.fail_count, k.disabled]),
    [
      [1, true],
      [1, true],
      [1, true],
    ],
  );
  assert.equal(captured.length, 3);
});

test("a daily result that lists a key as valid clears its proxy ledger", async () => {
  useUpstream((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":"invalid key"}');
  });
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1\nk2" });
  await postSettings(env, [p], { proxy_fail_threshold: 1 });
  const fp = await fingerprintOf(env, p);

  await proxy(env, "/proxy/openai/chat/completions");
  assert.deepEqual(
    (await getKeyRows(env, fp)).map((k) => k.disabled),
    [true, true],
  );

  // The daily run is the authority: k1 is alive again, k2 is not.
  const posted = await request(env, "/api/results", {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      provider_type: p.provider_type,
      api_base: p.api_base,
      valid_keys: ["k1"],
      invalid_records: [{ api_key: "k2", error_code: 401, error_reason: "bad" }],
      proven_working_models: [],
      failed_models: [],
      model_performance: {},
    }),
  }).then(asJson);
  assert.equal(posted.status, 200);
  assert.equal(posted.data.keys_recovered, 1);

  const keys = await getKeyRows(env, fp);
  assert.deepEqual(
    keys.map((k) => [k.masked, k.fail_count, k.disabled]),
    [
      ["k1", 0, false],
      ["k2", 1, true],
    ],
  );
});

test("an unsupported provider_type is rejected at save time", async () => {
  const env = makeEnv();
  const p = provider({ provider_type: "ollama", keys: "k1" });
  const res = await postSettings(env, [p]);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /ollama|不支援/);
});

test("retries stop at four upstream calls and the fifth key is untouched", async () => {
  useUpstream((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":"invalid key"}');
  });
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1\nk2\nk3\nk4\nk5" });
  await postSettings(env, [p], { proxy_fail_threshold: 9, proxy_max_retries: 3 });
  const fp = await fingerprintOf(env, p);

  const result = await proxy(env, "/proxy/openai/chat/completions");
  assert.equal(result.status, 401);
  assert.equal(captured.length, 4);

  const keys = await getKeyRows(env, fp);
  assert.equal(keys[4].fail_count, 0);
  assert.deepEqual(
    keys.slice(0, 4).map((k) => k.fail_count),
    [1, 1, 1, 1],
  );
});

// ── R5/R6: state + single-key test ─────────────────────────────────────────

test("proxy state masks every key and never leaks plaintext", async () => {
  const env = makeEnv();
  const p = provider({
    alias: "openai",
    keys: "sk-aaaaaaaaaaaa1111\n123456789012\n12345678901\n1234567890\nabcdefghi",
  });
  await postSettings(env, [p]);

  const response = await request(env, "/api/proxy/state", {
    headers: adminHeaders(),
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!text.includes("sk-aaaaaaaaaaaa1111"));
  assert.ok(!text.includes("123456789012"));
  assert.ok(!text.includes("12345678901"));
  assert.ok(!text.includes("1234567890"));
  const data = JSON.parse(text);
  assert.equal(typeof data.state_seq, "number");
  assert.equal("via_gateway" in data, false);
  assert.equal("gateway_ready" in data, false);
  assert.equal("logs_url_template" in data, false);
  const found = data.providers[0];
  assert.equal(found.keys_total, 5);
  assert.equal(found.keys_available, 5);
  assert.equal(found.proxy_url, "/proxy/openai");
  assert.equal("sample_path" in found, false);
  assert.equal("logs_url" in found, false);
  assert.equal(found.keys[0].masked, "sk-aaa***111");
  assert.equal(found.keys[1].masked, "123456***012");
  assert.equal(found.keys[2].masked, "123456**901");
  assert.equal(found.keys[3].masked, "123456*890");
  // Exactly 9 characters are displayed directly without masking.
  assert.equal(found.keys[4].masked, "abcdefghi");
});

test("a failed manual test charges the key and can disable it", async () => {
  useUpstream((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":"nope"}');
  });
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1" });
  await postSettings(env, [p], { proxy_fail_threshold: 2 });
  const fp = await fingerprintOf(env, p);
  await postTestModel(env, fp, "probe-model");
  const [key] = await getKeyRows(env, fp);

  const call = () =>
    request(env, "/api/proxy/test", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp, id: key.id }),
    });

  const first = await asJson(await call());
  assert.equal(first.status, 200);
  assert.equal(first.data.ok, false);
  assert.equal(first.data.status, 401);
  assert.equal(first.data.fail_count, 1);
  assert.equal(first.data.disabled, false);

  const second = await asJson(await call());
  assert.equal(second.data.fail_count, 2);
  assert.equal(second.data.disabled, true, "門檻到了就要禁用");

  const third = await asJson(await call());
  assert.equal(third.data.fail_count, 2, "已達門檻不應再往上加失敗次數");
  assert.equal(third.data.disabled, true);

  const [after] = await getKeyRows(env, fp);
  assert.equal(after.fail_count, 2);

  // Network / timeout error in catch() must also charge fail_count.
  const envNet = makeEnv();
  await postSettings(envNet, [p], { proxy_fail_threshold: 1 });
  const fpNet = await fingerprintOf(envNet, p);
  await postTestModel(envNet, fpNet, "probe-model");
  const [kNet] = await getKeyRows(envNet, fpNet);
  useUpstream((req, res) => { req.socket.destroy(); });
  const netErr = await asJson(
    await request(envNet, "/api/proxy/test", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp: fpNet, id: kNet.id }),
    }),
  );
  assert.equal(netErr.status, 200);
  assert.equal(netErr.data.ok, false);
  assert.equal(netErr.data.fail_count, 1);
  assert.equal(netErr.data.disabled, true);
  assert.equal(after.disabled, true);
  assert.equal(after.last_used_at, null, "手動測試不參與輪用，不該蓋最近使用時間");
});

test("a successful manual test clears fail_count and re-enables a disabled key", async () => {
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1" });
  await postSettings(env, [p]);
  const fp = await fingerprintOf(env, p);
  await postTestModel(env, fp, "probe-model");
  const [key] = await getKeyRows(env, fp);

  await env.DB.prepare(
    "UPDATE key_state SET disabled = 1, fail_count = 3 WHERE id = ?",
  )
    .bind(key.id)
    .run();
  worker.__test.invalidateSnapshot(env.DB);

  const result = await asJson(
    await request(env, "/api/proxy/test", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp, id: key.id }),
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.disabled, false);
  assert.equal(result.data.fail_count, 0);

  const [after] = await getKeyRows(env, fp);
  assert.equal(after.disabled, false, "手动测试成功应立即解除禁用");
  assert.equal(after.fail_count, 0, "手动测试成功应立即归零失败次数");
});

test("the proxy test model is stored separately, not auto-borrowed", async () => {
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1", models: "m1,m2" });
  await postSettings(env, [p]);
  const fp = await fingerprintOf(env, p);

  const stateBefore = await asJson(
    await request(env, "/api/proxy/state", { headers: adminHeaders() }),
  );
  assert.equal(stateBefore.data.providers[0].test_model, "");
  // The toolbar's model menu is built from this list, so the state has to carry
  // the whole Models field and not just its first entry.
  assert.deepEqual(stateBefore.data.providers[0].models, ["m1", "m2"]);

  // Without a configured probe model the test endpoint refuses, instead of
  // silently borrowing providers[].models.
  const [key] = await getKeyRows(env, fp);
  const noModel = await asJson(
    await request(env, "/api/proxy/test", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp, id: key.id }),
    }),
  );
  assert.equal(noModel.status, 400);
  assert.match(noModel.data.error, /测试模型/);

  const saved = await postTestModel(env, fp, "probe-model");
  assert.equal(saved.status, 200);
  assert.equal(saved.data.test_model, "probe-model");

  // A later settings save must keep the map (it is a sibling of providers[]).
  await postSettings(env, [p]);
  const stateAfter = await asJson(
    await request(env, "/api/proxy/state", { headers: adminHeaders() }),
  );
  assert.equal(stateAfter.data.providers[0].test_model, "probe-model");

  captured.length = 0;
  const probe = await asJson(
    await request(env, "/api/proxy/test", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp, id: (await getKeyRows(env, fp))[0].id }),
    }),
  );
  assert.equal(probe.status, 200);
  assert.equal(
    JSON.parse(captured[0].body).model,
    "probe-model",
    "探測要用設定的模型",
  );

  // Clicking Test with a new model saves it into standalone store('proxy_test_models')
  // without bumping app_settings.version.
  captured.length = 0;
  const appSettingsBefore = await env.DB.prepare(
    "SELECT v FROM store WHERE k = 'app_settings'",
  ).first();
  const keyId = (await getKeyRows(env, fp))[0].id;
  const testWithNewModel = await asJson(
    await request(env, "/api/proxy/test", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp, id: keyId, model: "m2" }),
    }),
  );
  assert.equal(testWithNewModel.status, 200);
  assert.equal(testWithNewModel.data.model, "m2");
  assert.equal(testWithNewModel.data.settings_version, undefined);
  assert.equal(JSON.parse(captured[0].body).model, "m2");

  const appSettingsAfter = await env.DB.prepare(
    "SELECT v FROM store WHERE k = 'app_settings'",
  ).first();
  assert.equal(appSettingsAfter.v, appSettingsBefore.v);

  const testModelsRow = await env.DB.prepare(
    "SELECT v FROM store WHERE k = 'proxy_test_models'",
  ).first();
  assert.equal(JSON.parse(testModelsRow.v)[fp], "m2");

  const stateUpdated = await asJson(
    await request(env, "/api/proxy/state", { headers: adminHeaders() }),
  );
  assert.equal(stateUpdated.data.providers[0].test_model, "m2");

  const testSameModel = await asJson(
    await request(env, "/api/proxy/test", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp, id: keyId, model: "m2" }),
    }),
  );
  assert.equal(testSameModel.status, 200);
  assert.equal(testSameModel.data.settings_version, undefined);
});

// ── R0: settings ↔ key_state sync ──────────────────────────────────────────

test("removing a key or changing api_base prunes key_state without resetting counters", async () => {
  const env = makeEnv();
  const first = provider({ alias: "openai", keys: "k1\nk2" });
  await postSettings(env, [first]);
  const fp = await fingerprintOf(env, first);
  const before = await getKeyRows(env, fp);
  assert.equal(before.length, 2);

  // Make k1 dirty; a settings save must keep that state.
  await env.DB.prepare(
    "UPDATE key_state SET fail_count = 2, disabled = 1 WHERE fp = ? AND api_key = ?",
  )
    .bind(fp, "k1")
    .run();
  await postSettings(env, [{ ...first, keys: "k2" }]);
  const after = await getKeyRows(env, fp);
  assert.deepEqual(after.map((k) => k.masked), ["k2"]);

  const moved = { ...first, api_base: `${upstreamBase()}/v2` };
  await postSettings(env, [moved]);
  const oldFp = await fingerprintOf(env, { ...first });
  assert.equal(oldFp, null);
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM key_state").first();
  assert.equal(Number(rows.n), 2);
});

test("re-saving the same keys keeps fail_count and skips redundant writes", async () => {
  const kv = new FakeKV();
  const env = makeEnv({ kv });
  const p = provider({ alias: "openai", keys: "k1" });
  const firstSave = await postSettings(env, [p]);
  assert.equal(firstSave.status, 200);
  const fp = await fingerprintOf(env, p);
  await env.DB.prepare(
    "UPDATE key_state SET fail_count = 2 WHERE fp = ? AND api_key = ?",
  )
    .bind(fp, "k1")
    .run();
  worker.__test.invalidateSnapshot(env.DB);

  const beforeRow = await env.DB.prepare("SELECT v FROM store WHERE k = ?").bind("app_settings").first();
  const res = await postSettings(env, [p]);
  assert.equal(res.status, 200);
  assert.equal(res.data.unchanged, true);
  assert.equal(res.data.version, firstSave.data.version);
  const afterRow = await env.DB.prepare("SELECT v FROM store WHERE k = ?").bind("app_settings").first();
  assert.equal(afterRow.v, beforeRow.v);
  const [key] = await getKeyRows(env, fp);
  assert.equal(key.fail_count, 2);

  // Also verify KV mode skips kv.put when payload matches existing settings.
  const kvEnv = makeEnv({ vars: { STORAGE_BACKEND: "kv" } });
  const kvFirst = await postSettings(kvEnv, [p]);
  const kvSecond = await postSettings(kvEnv, [p]);
  assert.equal(kvSecond.status, 200);
  assert.equal(kvSecond.data.unchanged, true);
  assert.equal(kvSecond.data.version, kvFirst.data.version);
});

// ── R0: D1 atomic batch & pruning ──────────────────────────────────────────

test("D1 settings save writes store and key_state in one atomic batch and rolls back on failure", async () => {
  const env = makeEnv();
  const initial = provider({ alias: "openai", keys: "k1\nk2" });
  const initRes = await postSettings(env, [initial]);
  assert.equal(initRes.status, 200);
  const fp = await fingerprintOf(env, initial);

  // Poison key_state inserts inside SQLite so the key_state part of the batch fails.
  await env.DB.prepare(
    "CREATE TRIGGER block_k3 BEFORE INSERT ON key_state WHEN NEW.api_key = 'k3' " +
      "BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;",
  ).run();

  const failedRes = await postSettings(env, [
    { ...initial, alias: "renamed", keys: "k1\nk3" },
  ]);
  assert.equal(failedRes.status, 500);

  // Rollback: both app_settings (alias) and key_state (k2 still present, k3 absent) remain unchanged.
  const settingsRes = await asJson(
    await request(env, "/api/settings", { headers: adminHeaders() }),
  );
  assert.equal(settingsRes.data.settings.providers[0].alias, "openai");
  const rows = await getKeyRows(env, fp);
  assert.deepEqual(rows.map((r) => r.masked), ["k1", "k2"]);
});

test("duplicate (provider_type, api_base) is rejected at save time", async () => {
  const env = makeEnv();
  const res = await postSettings(env, [
    provider({ provider_type: "openai", api_base: "https://dup.example/v1", keys: "k1" }),
    provider({ provider_type: "openai", api_base: "https://dup.example/v1/", keys: "k2" }),
  ]);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /重复/);

  // Same api_base with a different provider_type is allowed.
  const diffType = await postSettings(env, [
    provider({ provider_type: "openai", api_base: "https://dup.example/v1", alias: "oa", keys: "k1" }),
    provider({ provider_type: "anthropic", api_base: "https://dup.example/v1", alias: "an", keys: "k2" }),
  ]);
  assert.equal(diffType.status, 200);
});

test("removing a key or deleting a provider prunes results and dead_keys with detail rebalance", async () => {
  const env = makeEnv();
  const base = `${upstreamBase()}/prune/v1`;
  const p = provider({ api_base: base, keys: "sk-dead1\nsk-dead2\nsk-good1" });
  await postSettings(env, [p]);
  const fp = await fingerprintOf(env, p);

  await request(env, "/api/results", {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      provider_type: "openai",
      api_base: base,
      valid_keys: ["sk-good1"],
      invalid_records: [
        { api_key: "sk-dead1", error_code: 401, error_reason: "invalid", error_detail: { message: "bad key" } },
        { api_key: "sk-dead2", error_code: 401, error_reason: "invalid", error_detail: null },
      ],
      proven_working_models: ["m1"],
      failed_models: [],
    }),
  });

  // Remove sk-dead1 in 来源设定 -> dead_keys drops sk-dead1 and hands error_detail to sk-dead2.
  const editRes = await postSettings(env, [{ ...p, keys: "sk-dead2\nsk-good1" }]);
  assert.equal(editRes.status, 200);
  const dkAfterEdit = await asJson(
    await request(env, "/api/dead-keys", { headers: adminHeaders() }),
  );
  assert.equal(dkAfterEdit.data.dead_keys.length, 1);
  assert.equal(dkAfterEdit.data.dead_keys[0].api_key, "sk-dead2");
  assert.deepEqual(dkAfterEdit.data.dead_keys[0].error_detail, { message: "bad key" });

  // Delete the entire provider -> results:{fp} and dead_keys for fp are purged too.
  const delRes = await postSettings(env, []);
  assert.equal(delRes.status, 200);
  const resAfterDel = await asJson(
    await request(env, `/api/results?fp=${fp}`, { headers: adminHeaders() }),
  );
  assert.equal(resAfterDel.data.exists, false);
  const dkAfterDel = await asJson(
    await request(env, "/api/dead-keys", { headers: adminHeaders() }),
  );
  assert.equal(dkAfterDel.data.dead_keys.length, 0);
});

test("dead_keys is scoped by fp so same-host different-format cards stay independent", async () => {
  const env = makeEnv();
  const base = `${upstreamBase()}/shared/v1`;
  const oa = provider({ provider_type: "openai", alias: "oa", api_base: base, keys: "sk-oa-dead\nsk-oa-ok" });
  const an = provider({ provider_type: "anthropic", alias: "an", api_base: base, keys: "sk-an-dead\nsk-an-ok" });
  await postSettings(env, [oa, an]);
  const fpOa = await fingerprintOf(env, oa);
  const fpAn = await fingerprintOf(env, an);

  await request(env, "/api/results", {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      provider_type: "openai",
      api_base: base,
      valid_keys: ["sk-oa-ok"],
      invalid_records: [{ api_key: "sk-oa-dead", error_code: 401, error_reason: "oa err", error_detail: { message: "oa err" } }],
      proven_working_models: ["m1"],
      failed_models: [],
    }),
  });
  await request(env, "/api/results", {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      provider_type: "anthropic",
      api_base: base,
      valid_keys: ["sk-an-ok"],
      invalid_records: [{ api_key: "sk-an-dead", error_code: 401, error_reason: "an err", error_detail: { message: "an err" } }],
      proven_working_models: ["m1"],
      failed_models: [],
    }),
  });

  const list = await asJson(await request(env, "/api/dead-keys", { headers: adminHeaders() }));
  assert.equal(list.data.dead_keys.length, 2);
  const oaRec = list.data.dead_keys.find((r) => r.fp === fpOa);
  const anRec = list.data.dead_keys.find((r) => r.fp === fpAn);
  assert.ok(oaRec && anRec);
  assert.deepEqual(oaRec.error_detail, { message: "oa err" });
  assert.deepEqual(anRec.error_detail, { message: "an err" });
});

// ── Direct upstream forwarding & rollback field preservation ───────────────

test("direct mode ignores legacy env vars, preserves existing ai_gateway_* in app_settings, and sends zero cf-aig-* headers", async () => {
  // Legacy env.* vars must be completely ignored in favor of app_settings.
  const env = makeEnv({
    vars: {
      PROXY_PASSWORD: "legacy-env-password",
      AI_GATEWAY_ACCOUNT_ID: "legacy-acct",
      AI_GATEWAY_ID: "legacy-gw",
      AI_GATEWAY_TOKEN: "legacy-token",
    },
  });
  // Seed pre-migration app_settings containing ai_gateway_logs_url & ai_gateway_token
  await request(env, "/api/settings", { headers: adminHeaders() });
  await env.DB.prepare(
    "INSERT OR REPLACE INTO store (k, v) VALUES ('app_settings', ?)",
  )
    .bind(
      JSON.stringify({
        providers: [],
        proxy_password: PROXY,
        ai_gateway_logs_url: "https://dash.cloudflare.com/acct/ai/ai-gateway/gateways/gw/logs",
        ai_gateway_token: "preserved-gw-token",
        version: 1,
      }),
    )
    .run();
  worker.__test.invalidateSnapshot(env.DB);

  // Save new settings without sending ai_gateway_* -> preserved verbatim in D1 for 1-click rollback!
  const saveRes = await postSettings(env, [
    provider({
      alias: "openai",
      keys: "sk-abcdefghij1234\nsk-short\nsk-cafe-ok",
    }),
  ]);
  assert.equal(saveRes.status, 200);
  const rawStored = JSON.parse(
    (await env.DB.prepare("SELECT v FROM store WHERE k = 'app_settings'").first()).v,
  );
  assert.equal(
    rawStored.ai_gateway_logs_url,
    "https://dash.cloudflare.com/acct/ai/ai-gateway/gateways/gw/logs",
  );
  assert.equal(rawStored.ai_gateway_token, "preserved-gw-token");

  const getSettingsRes = await asJson(
    await request(env, "/api/settings", { headers: adminHeaders() }),
  );
  assert.equal("ai_gateway_logs_url" in getSettingsRes.data.settings, false);
  assert.equal("ai_gateway_token_set" in getSettingsRes.data.settings, false);

  const proxyState = await asJson(
    await request(env, "/api/proxy/state", { headers: adminHeaders() }),
  );
  assert.equal("tag" in proxyState.data.providers[0].keys[0], false);
  assert.equal("logs_url" in proxyState.data.providers[0], false);

  for (const expectedKey of ["sk-abcdefghij1234", "sk-short", "sk-cafe-ok"]) {
    outboundCalls.length = 0;
    captured.length = 0;
    const result = await proxy(env, "/proxy/openai/chat/completions?q=1");
    assert.equal(result.status, 200);
    assert.equal(outboundCalls.length, 1);
    const seen = outboundCalls[0];
    assert.equal(
      seen.url,
      `${upstreamBase()}/v1/chat/completions?q=1`,
    );
    assert.equal(seen.redirect, "manual");
    for (const [k] of seen.headers.entries()) {
      assert.equal(k.toLowerCase().startsWith("cf-aig-"), false);
    }
    assert.equal(captured[0].headers.authorization, `Bearer ${expectedKey}`);
  }
});

test("settings validate proxy config and probes connect directly without Gateway", async () => {
  const env = makeEnv();

  const samePass = await postSettings(env, [], { proxy_password: ADMIN });
  assert.equal(samePass.status, 400);

  const badRetry = await postSettings(env, [], { proxy_max_retries: 5 });
  assert.equal(badRetry.status, 400);

  const noAliasProv = provider({ keys: "k1", models: "m1" });
  const oaAliasProv = provider({
    provider_type: "openai",
    alias: "oa",
    api_base: `${upstreamBase()}/oa/v1`,
    extra_body: '{"temperature":0.1,"seed":7}',
    keys: "k-oa",
    models: "m-oa",
  });
  const gemAliasProv = provider({
    provider_type: "google",
    alias: "gem",
    api_base: `${upstreamBase()}`,
    keys: "k-gem",
    models: "gemini-2.5-pro",
  });
  const anAliasProv = provider({
    provider_type: "anthropic",
    alias: "cla",
    api_base: `${upstreamBase()}/ant/v1`,
    keys: "k-cla",
    models: "claude-test",
  });

  // Direct forwarding works with no Gateway config at all.
  await postSettings(env, [noAliasProv, oaAliasProv, gemAliasProv, anAliasProv]);
  const fpNoAlias = await fingerprintOfEntry(noAliasProv);
  await postTestModel(env, fpNoAlias, "m1");
  assert.equal(await getKeyRows(env, fpNoAlias), null);
  const noAliasRow = await env.DB.prepare(
    "SELECT id FROM key_state WHERE fp = ?",
  )
    .bind(fpNoAlias)
    .first();
  const needAlias = await asJson(
    await request(env, "/api/proxy/test", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp: fpNoAlias, id: noAliasRow.id }),
    }),
  );
  assert.equal(needAlias.status, 400);
  assert.match(needAlias.data.error, /alias/);

  for (const [entry, model, checkBody] of [
    [
      oaAliasProv,
      "m-oa",
      (b) => {
        assert.equal(b.messages[0].content, "only reply 1.");
        assert.equal(b.max_tokens, 8);
        assert.equal(b.stream, false);
        assert.equal(b.temperature, 0.1);
        assert.equal(b.seed, 7);
      },
    ],
    [
      gemAliasProv,
      "gemini-2.5-pro",
      (b, url) => {
        assert.equal(url, "/v1beta/models/gemini-2.5-pro:generateContent");
        assert.equal(b.contents[0].parts[0].text, "only reply 1.");
        assert.equal(b.generationConfig.maxOutputTokens, 8);
      },
    ],
    [
      anAliasProv,
      "claude-test",
      (b) => {
        assert.equal(b.messages[0].content, "only reply 1.");
        assert.equal(b.max_tokens, 8);
        assert.equal(b.stream, false);
      },
    ],
  ]) {
    captured.length = 0;
    const fp = await fingerprintOf(env, entry);
    await postTestModel(env, fp, model);
    const [row] = await getKeyRows(env, fp);
    const res = await asJson(
      await request(env, "/api/proxy/test", {
        method: "POST",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ fp, id: row.id }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    checkBody(JSON.parse(captured[0].body), captured[0].url);
  }
});

test("POST and PUT /api/dead-keys are removed while GET/DELETE remain active", async () => {
  const env = makeEnv();
  const postRes = await request(env, "/api/dead-keys", {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ provider_host: "api.example.com", api_key: "sk-dead1" }),
  });
  assert.equal(postRes.status, 404);

  await postSettings(env, [provider({ keys: "sk-dead1\nsk-good1" })]);
  const syncRes = await request(env, "/api/results", {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      provider_type: "openai",
      api_base: `${upstreamBase()}/v1`,
      valid_keys: ["sk-good1"],
      invalid_records: [{ api_key: "sk-dead1", error_code: 401, error_reason: "invalid" }],
      proven_working_models: ["gpt-4o"],
      failed_models: [],
    }),
  });
  assert.equal(syncRes.status, 200);

  const list = await asJson(
    await request(env, "/api/dead-keys", { headers: adminHeaders() }),
  );
  assert.equal(list.status, 200);
  assert.equal(list.data.dead_keys.length, 1);
  const id = list.data.dead_keys[0].id;
  assert.ok(list.data.dead_keys[0].fp);

  const putRes = await asJson(
    await request(env, `/api/dead-keys?id=${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ error_code: 403 }),
    }),
  );
  assert.equal(putRes.status, 404);

  const delRes = await asJson(
    await request(env, "/api/dead-keys", {
      method: "DELETE",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    }),
  );
  assert.equal(delRes.status, 200);
  assert.equal(delRes.data.dead_keys.length, 0);
});

test("POST /api/proxy/recover with all:true recovers only disabled keys of the target provider", async () => {
  const env = makeEnv();
  const pA = provider({ alias: "prov-a", api_base: `${upstreamBase()}/a/v1`, keys: "ka1\nka2\nka3" });
  const pB = provider({ alias: "prov-b", api_base: `${upstreamBase()}/b/v1`, keys: "kb1\nkb2" });
  await postSettings(env, [pA, pB]);
  const fpA = await fingerprintOf(env, pA);
  const fpB = await fingerprintOf(env, pB);

  // Seed rows via first proxy request per provider, then mark specific rows disabled/failed in D1.
  await proxy(env, "/proxy/prov-a/chat/completions");
  await proxy(env, "/proxy/prov-b/chat/completions");
  const now = Date.now();
  await env.DB.prepare("UPDATE key_state SET disabled = 1, fail_count = 3 WHERE fp = ? AND api_key IN ('ka1', 'ka2')").bind(fpA).run();
  await env.DB.prepare("UPDATE key_state SET disabled = 0, fail_count = 1 WHERE fp = ? AND api_key = 'ka3'").bind(fpA).run();
  await env.DB.prepare("UPDATE key_state SET disabled = 1, fail_count = 3 WHERE fp = ? AND api_key = 'kb1'").bind(fpB).run();
  await env.DB.prepare("UPDATE key_state SET disabled = 0, fail_count = 2, updated_at = ? WHERE fp = ? AND api_key = 'kb2'").bind(now, fpB).run();
  worker.__test.invalidateSnapshot(env.DB);

  const badReq = await asJson(
    await request(env, "/api/proxy/recover", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }),
  );
  assert.equal(badReq.status, 400);

  const recRes = await asJson(
    await request(env, "/api/proxy/recover", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp: fpA, all: true }),
    }),
  );
  assert.equal(recRes.status, 200);
  assert.equal(recRes.data.ok, true);
  assert.equal(recRes.data.recovered, 2);
  assert.equal(recRes.data.ids.length, 2);

  const keysA = await getKeyRows(env, fpA);
  assert.deepEqual(
    keysA.map((k) => [k.masked, k.fail_count, k.disabled]),
    [
      ["ka1", 0, false],
      ["ka2", 0, false],
      ["ka3", 1, false], // active key with fail_count=1 is untouched
    ],
  );

  const keysB = await getKeyRows(env, fpB);
  assert.deepEqual(
    keysB.map((k) => [k.masked, k.fail_count, k.disabled]),
    [
      ["kb1", 3, true], // other provider's disabled key is untouched
      ["kb2", 2, false],
    ],
  );

  const second = await asJson(
    await request(env, "/api/proxy/recover", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp: fpA, all: true }),
    }),
  );
  assert.equal(second.status, 200);
  assert.equal(second.data.recovered, 0);
  assert.deepEqual(second.data.ids, []);
});

test("global /api/run-status replaces /api/checkpoint and expires lazily after 90 minutes", async () => {
  const env = makeEnv();

  // Legacy /api/checkpoint endpoints are gone.
  const oldGet = await request(env, "/api/checkpoint?fp=abc", { headers: adminHeaders() });
  assert.equal(oldGet.status, 404);
  const oldPost = await request(env, "/api/checkpoint", {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(oldPost.status, 404);

  // Initial state is not running.
  const initial = await asJson(
    await request(env, "/api/run-status", { headers: adminHeaders() }),
  );
  assert.equal(initial.status, 200);
  assert.equal(initial.data.running, false);
  assert.equal(initial.data.started_at, null);

  // POST marks global run active.
  const started = await asJson(
    await request(env, "/api/run-status", {
      method: "POST",
      headers: adminHeaders(),
    }),
  );
  assert.equal(started.status, 200);
  assert.equal(started.data.running, true);
  assert.ok(started.data.started_at);

  const running = await asJson(
    await request(env, "/api/run-status", { headers: adminHeaders() }),
  );
  assert.equal(running.data.running, true);
  assert.equal(running.data.started_at, started.data.started_at);

  // Exceeding 90 minutes lazily clears test_run_status on GET.
  const staleTime = new Date(Date.now() - 91 * 60 * 1000).toISOString();
  await env.DB.prepare("UPDATE store SET v = ? WHERE k = 'test_run_status'")
    .bind(JSON.stringify({ started_at: staleTime }))
    .run();
  const expired = await asJson(
    await request(env, "/api/run-status", { headers: adminHeaders() }),
  );
  assert.equal(expired.data.running, false);
  assert.equal(expired.data.expired, true);
  const cleanedRow = await env.DB.prepare(
    "SELECT v FROM store WHERE k = 'test_run_status'",
  ).first();
  assert.equal(cleanedRow, null);

  // Explicit DELETE clears an active run immediately.
  await request(env, "/api/run-status", {
    method: "POST",
    headers: adminHeaders(),
  });
  const del = await asJson(
    await request(env, "/api/run-status", {
      method: "DELETE",
      headers: adminHeaders(),
    }),
  );
  assert.equal(del.status, 200);
  assert.equal(del.data.running, false);
  const afterDel = await asJson(
    await request(env, "/api/run-status", { headers: adminHeaders() }),
  );
  assert.equal(afterDel.data.running, false);
});

test("D1 chunks IN queries under 100 params across 105-key recover, sync, and provider state", async () => {
  const env = makeEnv();
  const base = `${upstreamBase()}/bulk/v1`;
  const manyKeys = Array.from({ length: 105 }, (_, i) => `sk-bulk-${String(i).padStart(3, "0")}`);
  const p = provider({
    alias: "bulk",
    api_base: base,
    keys: manyKeys.join("\n"),
  });
  const saveRes = await postSettings(env, [p]);
  assert.equal(saveRes.status, 200);
  const fp = await fingerprintOf(env, p);

  // Mark all 105 keys disabled so recoverKeysFromResults must update every key.
  await env.DB.prepare("UPDATE key_state SET disabled = 1, fail_count = 3 WHERE fp = ?")
    .bind(fp)
    .run();
  worker.__test.invalidateSnapshot(env.DB);

  const postRes = await asJson(
    await request(env, "/api/results", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_type: "openai",
        api_base: base,
        valid_keys: manyKeys,
        invalid_records: [],
        proven_working_models: ["m1"],
        failed_models: [],
      }),
    }),
  );
  assert.equal(postRes.status, 200);
  assert.equal(postRes.data.keys_recovered, 105);

  const rows = await getKeyRows(env, fp);
  assert.equal(rows.filter((r) => !r.disabled).length, 105);

  // Removing 104 keys triggers >100 staleIds deletion inside D1 batch cleanly.
  const shrinkRes = await postSettings(env, [{ ...p, keys: manyKeys[0] }]);
  assert.equal(shrinkRes.status, 200);
  const afterShrink = await getKeyRows(env, fp);
  assert.equal(afterShrink.length, 1);
});

test("settings reject unsafe URL schemes and proxy retry preserves merged extra_body", async () => {
  const env = makeEnv();
  const badGithub = await postSettings(env, [], {
    github_url: "javascript:alert(1)",
  });
  assert.equal(badGithub.status, 400);
  assert.match(badGithub.data.error, /GitHub Actions URL/);

  const badDiscord = await postSettings(env, [], {
    discord_webhook_url: "ftp://example.com/hook",
  });
  assert.equal(badDiscord.status, 400);
  assert.match(badDiscord.data.error, /Discord Webhook URL/);

  useUpstream((req, res) => {
    const auth = req.headers.authorization || "";
    if (auth === "Bearer k-bad") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"error":"bad"}');
      return;
    }
    defaultUpstream(req, res, "");
  });
  await postSettings(env, [
    provider({
      alias: "extra",
      extra_body: '{"temperature":0.2,"top_p":0.9}',
      keys: "k-bad\nk-good",
    }),
  ]);
  const res = await proxy(env, "/proxy/extra/chat/completions", {
    body: JSON.stringify({ model: "gpt-test", stream: false }),
  });
  assert.equal(res.status, 200);
  assert.equal(captured.length, 2);
  for (const call of captured) {
    const sent = JSON.parse(call.body);
    assert.equal(sent.temperature, 0.2);
    assert.equal(sent.top_p, 0.9);
    assert.equal(sent.model, "gpt-test");
  }
});

test("settings deduplicate keys/models preserving first occurrence and reject missing models", async () => {
  const env = makeEnv();
  const saved = await postSettings(env, [
    provider({
      alias: "multiline-models",
      keys: "k-first\n k-second \n\nk-first\nk-third\nk-second",
      models: "gpt-4o\ngpt-4.1, gpt-4o, o3\r\n  , claude-3-7, o3 ",
    }),
  ]);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.storage_backend, "d1");

  const got = await asJson(
    await request(env, "/api/settings", { headers: adminHeaders() }),
  );
  assert.equal(got.status, 200);
  assert.equal(got.data.storage_backend, "d1");
  assert.equal(got.data.settings.providers[0].keys, "k-first\nk-second\nk-third");
  assert.equal(got.data.settings.providers[0].models, "gpt-4o,gpt-4.1,o3,claude-3-7");

  const proxyState = await asJson(
    await request(env, "/api/proxy/state", { headers: adminHeaders() }),
  );
  assert.equal(proxyState.status, 200);
  assert.equal(proxyState.data.providers[0].keys_total, 3);
  assert.deepEqual(proxyState.data.providers[0].models, [
    "gpt-4o",
    "gpt-4.1",
    "o3",
    "claude-3-7",
  ]);

  for (const badModels of ["", " \n , \r\n ", 123]) {
    const res = await postSettings(env, [
      provider({ alias: "bad-models", models: badModels }),
    ]);
    assert.equal(res.status, 400);
    assert.match(res.data.error, /模型/);
  }
});

test("settings enforce at most 999 unique keys per provider", async () => {
  const env = makeEnv();
  const makeKeys = (n) =>
    Array.from({ length: n }, (_, i) => `sk-limit-${i + 1}`).join("\n");

  const okRes = await postSettings(env, [
    provider({ alias: "limit-ok", keys: makeKeys(999) }),
  ]);
  assert.equal(okRes.status, 200);

  const tooManyRes = await postSettings(env, [
    provider({ alias: "limit-too-many", keys: makeKeys(1000) }),
  ]);
  assert.equal(tooManyRes.status, 400);
  assert.match(tooManyRes.data.error, /999/);
});

test("POST /api/proxy/disable disables a single key without touching fail_count", async () => {
  const env = makeEnv();
  const p = provider({ alias: "disable-test", keys: "sk-one\nsk-two" });
  await postSettings(env, [p]);
  const fp = await fingerprintOf(env, p);

  const before = await getKeyRows(env, fp);
  const target = before[0];
  const other = before[1];
  assert.equal(target.disabled, false);

  const res = await asJson(
    await request(env, "/api/proxy/disable", {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ fp, id: target.id }),
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.key.disabled, true);
  assert.equal(res.data.key.fail_count, 0);

  const after = await getKeyRows(env, fp);
  assert.equal(after.find((r) => r.id === target.id).disabled, true);
  assert.equal(after.find((r) => r.id === other.id).disabled, false);

  const missing = await asJson(
    await request(env, "/api/proxy/disable", {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ fp, id: 999999 }),
    }),
  );
  assert.equal(missing.status, 404);
});


test("GET /api/proxy/state omits providers without alias and allows disabled providers with alias", async () => {
  const env = makeEnv();
  const noAlias = provider({ alias: "", api_base: "https://no-alias.example/v1", keys: "sk-no" });
  const offProv = provider({ alias: "off-prov", enabled: false, api_base: "https://off.example/v1", keys: "sk-off-1\nsk-off-2" });
  await postSettings(env, [noAlias, offProv]);

  const fpNoAlias = await fingerprintOfEntry(noAlias);
  const fpOff = await fingerprintOf(env, offProv);
  const stateRes = await asJson(
    await request(env, "/api/proxy/state", { headers: adminHeaders() }),
  );
  assert.equal(stateRes.status, 200);
  assert.equal(stateRes.data.providers.some((p) => p.fp === fpNoAlias), false);
  const offEntry = stateRes.data.providers.find((p) => p.fp === fpOff);
  assert.ok(offEntry);
  assert.equal(offEntry.enabled, false);

  const keyId = offEntry.keys[0].id;
  for (const [path, body] of [
    ["/api/proxy/test", { fp: fpOff, id: keyId, model: "m1" }],
    ["/api/proxy/disable", { fp: fpOff, id: keyId }],
    ["/api/proxy/recover", { fp: fpOff, id: keyId }],
    ["/api/proxy/recover", { fp: fpOff, all: true }],
  ]) {
    const res = await asJson(
      await request(env, path, {
        method: "POST",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 200, `${path} should allow disabled provider with alias`);
  }
});

test("custom test_path is required for openai/anthropic and google defaults to v1beta", async () => {
  const env = makeEnv();
  const missing = await postSettings(env, [
    provider({ alias: "missing", test_path: "" }),
  ]);
  assert.equal(missing.status, 400);

  const bad = await postSettings(env, [
    provider({ alias: "bad", keys: "k1", test_path: "https://evil.example/v1" }),
  ]);
  assert.equal(bad.status, 400);

  const pOpenai = provider({
    alias: "vercel",
    api_base: "https://ai-gateway.vercel.sh",
    keys: "k1",
    test_path: "v1/chat/completions",
  });
  const pGoogle = provider({
    provider_type: "google",
    alias: "g-root",
    api_base: "https://generativelanguage.googleapis.com",
    keys: "g1",
    test_path: "/ignored/path",
  });
  const ok = await postSettings(env, [pOpenai, pGoogle]);
  assert.equal(ok.status, 200);

  const saved = await asJson(
    await request(env, "/api/settings", { headers: adminHeaders() }),
  );
  assert.equal(saved.data.settings.providers[0].test_path, "/v1/chat/completions");
  assert.equal("test_path" in saved.data.settings.providers[1], false);

  const fpO = await fingerprintOf(env, pOpenai);
  const [kO] = await getKeyRows(env, fpO);
  outboundCalls.length = 0;
  await request(env, "/api/proxy/test", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp: fpO, id: kO.id, model: "gpt-4o" }),
  });
  assert.equal(
    outboundCalls[0].url,
    "https://ai-gateway.vercel.sh/v1/chat/completions",
  );

  const fpG = await fingerprintOf(env, pGoogle);
  const [kG] = await getKeyRows(env, fpG);
  outboundCalls.length = 0;
  await request(env, "/api/proxy/test", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp: fpG, id: kG.id, model: "gemini-2.5-flash" }),
  });
  assert.equal(
    outboundCalls[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  );
});

// ── Phase 0: Direct-proxy security, snapshot TTL, batch test-commit & logs ─

test("redirect: manual blocks 302 redirect following, rotates keys, and strips Location header", async () => {
  useUpstream((req, res) => {
    if (req.headers.authorization === "Bearer k-redir") {
      res.writeHead(302, {
        Location: "http://169.254.169.254/latest/meta-data",
        "Content-Type": "text/plain",
      });
      res.end("redirecting");
      return;
    }
    defaultUpstream(req, res, "");
  });

  const env = makeEnv();
  const p = provider({ alias: "redir-oa", keys: "k-redir\nk-good" });
  await postSettings(env, [p], { proxy_fail_threshold: 2 });
  const fp = await fingerprintOf(env, p);

  const rotated = await proxy(env, "/proxy/redir-oa/chat/completions");
  assert.equal(rotated.status, 200);
  assert.equal(outboundCalls.length, 2);
  assert.equal(outboundCalls[0].redirect, "manual");
  assert.equal(outboundCalls[1].redirect, "manual");
  // Never followed 169.254.169.254
  assert.ok(outboundCalls.every((c) => !c.url.includes("169.254.169.254")));
  const rows = await getKeyRows(env, fp);
  assert.equal(rows.find((r) => r.masked === "k-redir").fail_count, 1);

  // When all attempts return 302, Worker returns 302 with Location stripped
  useUpstream((req, res) => {
    res.writeHead(302, {
      Location: "https://evil.example/steal",
      "Content-Type": "text/plain",
    });
    res.end("bounce");
  });
  const envAll302 = makeEnv();
  await postSettings(envAll302, [provider({ alias: "all-302", keys: "k1" })]);
  const raw302 = await request(envAll302, "/proxy/all-302/chat/completions", {
    method: "POST",
    headers: proxyHeaders(),
    body: '{"model":"m1"}',
  });
  assert.equal(raw302.status, 302);
  assert.equal(raw302.headers.get("location"), null);
});

test("validateProviderApiBases guards scheme/userinfo/query/fragment and test_path-only edits save", async () => {
  const env = makeEnv();

  for (const badBase of [
    "http://api.openai.com/v1",
    "https://user:pass@api.example.com/v1",
    "https://api.example.com/v1?x=1",
    "https://api.example.com/v1#frag",
    "ftp://api.example.com/v1",
  ]) {
    const res = await postSettings(env, [
      provider({ alias: "bad", api_base: badBase, keys: "k1" }),
    ]);
    assert.equal(res.status, 400, `Expected 400 for ${badBase}`);
  }

  for (const goodBase of [
    "https://api.openai.com/v1",
    "http://127.0.0.1:8080/v1",
    "http://localhost:11434/v1",
    "http://[::1]:8000/v1",
  ]) {
    const res = await postSettings(env, [
      provider({ alias: "good", api_base: goodBase, keys: "k1" }),
    ]);
    assert.equal(res.status, 200, `Expected 200 for ${goodBase}`);
  }

  // Changing ONLY test_path must NOT be skipped as unchanged
  const baseProv = provider({
    alias: "tp-edit",
    api_base: "https://tp.example/v1",
    keys: "k1",
    test_path: "/chat/completions",
  });
  const first = await postSettings(env, [baseProv]);
  assert.equal(first.status, 200);
  const v1 = first.data.version;

  const second = await postSettings(env, [
    { ...baseProv, test_path: "/responses" },
  ]);
  assert.equal(second.status, 200);
  assert.equal(second.data.unchanged, undefined);
  assert.equal(second.data.version, v1 + 1);
  const got = await asJson(
    await request(env, "/api/settings", { headers: adminHeaders() }),
  );
  assert.equal(got.data.settings.providers[0].test_path, "/responses");
});

test("snapshot lifecycle: cold 1-batch, warm 0 sync reads, Soft TTL waitUntil, Hard TTL sync, inflight dedup, and localMutatedAt anti-race", async () => {
  let now = 1_700_000_000_000;
  worker.__test.setClock(() => now);

  const env = makeEnv();
  const p = provider({ alias: "snap", keys: "k1\nk2" });
  await postSettings(env, [p]);

  // Invalidate snapshot to measure cold start on /proxy/snap/*
  worker.__test.invalidateSnapshot(env.DB);
  env.DB.batchCalls = 0;
  env.DB.queryCalls = 0;

  // Concurrent cold start shares single inflight load (gate upstream until both arrive)
  let arrived = 0;
  let releaseCold;
  const bothArrived = new Promise((resolve) => {
    useUpstream((req, res, body) => {
      arrived += 1;
      if (arrived === 2) resolve();
      releaseCold.then(() => defaultUpstream(req, res, body));
    });
  });
  let triggerRelease;
  releaseCold = new Promise((resolve) => {
    triggerRelease = resolve;
  });

  const coldPromiseA = request(env, "/proxy/snap/chat/completions", {
    method: "POST",
    headers: proxyHeaders(),
    body: '{"model":"m1"}',
    awaitWaitUntil: false,
  });
  const coldPromiseB = request(env, "/proxy/snap/chat/completions", {
    method: "POST",
    headers: proxyHeaders(),
    body: '{"model":"m1"}',
    awaitWaitUntil: false,
  });
  await bothArrived;
  // Both requests passed getSnapshot() and reached upstream with ONLY 1 cold-start db.batch!
  assert.equal(env.DB.batchCalls, 1);
  triggerRelease();
  const [coldA, coldB] = await Promise.all([coldPromiseA, coldPromiseB]);
  assert.equal(coldA.status, 200);
  assert.equal(coldB.status, 200);
  await coldA.text();
  await coldB.text();
  await drainWaitUntil();
  useUpstream(defaultUpstream);

  // Warm (< 10s Soft TTL): 0 synchronous D1 reads/batches before waitUntil drains
  now += 5_000;
  env.DB.batchCalls = 0;
  env.DB.queryCalls = 0;
  const warmRes = await request(env, "/proxy/snap/chat/completions", {
    method: "POST",
    headers: proxyHeaders(),
    body: '{"model":"m1"}',
    awaitWaitUntil: false,
  });
  assert.equal(warmRes.status, 200);
  assert.equal(env.DB.batchCalls, 0, "Warm request must do 0 sync D1 batches");
  assert.equal(env.DB.queryCalls, 0, "Warm request must do 0 sync D1 queries");
  await warmRes.text();
  await drainWaitUntil();

  // Soft TTL (10s..60s): returns cached snapshot immediately without blocking on D1,
  // while scheduling incremental refresh in ctx.waitUntil!
  const fp = await fingerprintOf(env, p);
  await env.DB.prepare(
    "UPDATE key_state SET disabled = 1, updated_at = ? WHERE fp = ?",
  )
    .bind(now + 100, fp)
    .run();
  now += 12_000;
  const softRes = await request(env, "/proxy/snap/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${PROXY}` },
    awaitWaitUntil: false,
  });
  // Served from warm snapshot immediately (200 OK) before background refresh applied disabled=1!
  assert.equal(softRes.status, 200);
  await softRes.text();
  await drainWaitUntil();
  // After waitUntil finishes incremental refresh, snapshot now reflects disabled=1 -> 503 NO_KEYS!
  const afterSoftRefresh = await proxy(env, "/proxy/snap/chat/completions");
  assert.equal(afterSoftRefresh.status, 503);
  await request(env, "/api/proxy/recover", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp, all: true }),
  });

  // Anti-race: older D1 row updated_at must NOT overwrite newer localMutatedAt in snapshot
  const [k1Row] = await getKeyRows(env, fp);
  // Write an older updated_at into D1 (simulating stale read), then mutate locally at newer timestamp
  await env.DB.prepare(
    "UPDATE key_state SET disabled = 0, fail_count = 0, updated_at = ? WHERE id = ?",
  )
    .bind(now - 500, k1Row.id)
    .run();
  now += 1_000;
  await request(env, "/api/proxy/disable", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp, id: k1Row.id }),
  });
  // Now poison D1 behind Worker's back with an OLDER updated_at (now - 200) claiming disabled = 0
  await env.DB.prepare(
    "UPDATE key_state SET disabled = 0, updated_at = ? WHERE id = ?",
  )
    .bind(now - 200, k1Row.id)
    .run();
  // Trigger Hard TTL (>= 60s) incremental refresh
  now += 65_000;
  const afterAntiRace = await getKeyRows(env, fp);
  assert.equal(
    afterAntiRace.find((r) => r.id === k1Row.id).disabled,
    true,
    "localMutatedAt must block older D1 row from clobbering newer in-memory disable",
  );

  // Newer D1 updated_at (> localMutatedAt) IS applied on Hard TTL refresh
  await env.DB.prepare(
    "UPDATE key_state SET disabled = 0, updated_at = ? WHERE id = ?",
  )
    .bind(now + 100, k1Row.id)
    .run();
  now += 65_000;
  const afterHardTtl = await getKeyRows(env, fp);
  assert.equal(
    afterHardTtl.find((r) => r.id === k1Row.id).disabled,
    false,
    "Hard TTL refresh picks up genuinely newer D1 updated_at",
  );
});

test("last_used_at updates only on /proxy/*, throttles D1 writes to 60s, and state_seq supports ?since_seq=", async () => {
  let now = 1_710_000_000_000;
  worker.__test.setClock(() => now);

  const env = makeEnv();
  const p = provider({ alias: "live", keys: "k-only" });
  await postSettings(env, [p]);
  const fp = await fingerprintOf(env, p);
  const [keyRow] = await getKeyRows(env, fp);

  // Manual test, disable, and recover must NOT touch last_used_at
  await request(env, "/api/proxy/test", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp, id: keyRow.id, model: "m1" }),
  });
  await request(env, "/api/proxy/disable", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp, id: keyRow.id }),
  });
  await request(env, "/api/proxy/recover", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp, id: keyRow.id }),
  });
  const stateBeforeProxy = await asJson(
    await request(env, "/api/proxy/state", { headers: adminHeaders() }),
  );
  assert.equal(stateBeforeProxy.data.providers[0].keys[0].last_used_at, null);
  const seq0 = stateBeforeProxy.data.state_seq;

  // ?since_seq= matching current stateSeq returns unchanged:true with 0 D1 queries
  env.DB.queryCalls = 0;
  env.DB.batchCalls = 0;
  const unchangedState = await asJson(
    await request(env, `/api/proxy/state?since_seq=${seq0}`, {
      headers: adminHeaders(),
    }),
  );
  assert.equal(unchangedState.status, 200);
  assert.equal(unchangedState.data.unchanged, true);
  assert.equal(unchangedState.data.state_seq, seq0);
  assert.equal(env.DB.queryCalls, 0);
  assert.equal(env.DB.batchCalls, 0);

  // First external /proxy/* call stamps last_used_at in memory AND persists to D1
  await proxy(env, "/proxy/live/chat/completions");
  const state1 = await asJson(
    await request(env, `/api/proxy/state?since_seq=${seq0}`, {
      headers: adminHeaders(),
    }),
  );
  assert.equal(state1.data.unchanged, undefined);
  assert.ok(state1.data.state_seq > seq0);
  assert.equal(state1.data.providers[0].keys[0].last_used_at, now);
  const dbRow1 = await env.DB.prepare(
    "SELECT last_used_at FROM key_state WHERE id = ?",
  )
    .bind(keyRow.id)
    .first();
  assert.equal(Number(dbRow1.last_used_at), now);

  // Second /proxy/* call 5s later updates memory + stateSeq immediately, but throttles D1 key_state write
  now += 5_000;
  await proxy(env, "/proxy/live/chat/completions");
  const state2 = await asJson(
    await request(env, `/api/proxy/state?since_seq=${state1.data.state_seq}`, {
      headers: adminHeaders(),
    }),
  );
  assert.equal(state2.data.providers[0].keys[0].last_used_at, now);
  const dbRow2 = await env.DB.prepare(
    "SELECT last_used_at FROM key_state WHERE id = ?",
  )
    .bind(keyRow.id)
    .first();
  assert.equal(
    Number(dbRow2.last_used_at),
    now - 5_000,
    "D1 last_used_at write is throttled within 60s window",
  );

  // After 61s, D1 key_state.last_used_at is persisted again
  now += 61_000;
  await proxy(env, "/proxy/live/chat/completions");
  const dbRow3 = await env.DB.prepare(
    "SELECT last_used_at FROM key_state WHERE id = ?",
  )
    .bind(keyRow.id)
    .first();
  assert.equal(Number(dbRow3.last_used_at), now);
});

test("defer_write:true probes without D1 writes and POST /api/proxy/test-commit persists batch in 1 db.batch", async () => {
  useUpstream((req, res) => {
    const auth = req.headers.authorization || "";
    if (auth.endsWith("sk-b000")) {
      defaultUpstream(req, res, "");
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":"bad key"}');
  });

  const env = makeEnv();
  const keys = Array.from(
    { length: 105 },
    (_, i) => `sk-b${String(i).padStart(3, "0")}`,
  );
  const p = provider({ alias: "batch-oa", keys: keys.join("\n") });
  await postSettings(env, [p], { proxy_fail_threshold: 1 });
  const fp = await fingerprintOf(env, p);
  await postTestModel(env, fp, "m1");
  const rowsBefore = await getKeyRows(env, fp);

  // Mark sk-b000 disabled beforehand so we verify test-commit recovers ok keys too
  await request(env, "/api/proxy/disable", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp, id: rowsBefore[0].id }),
  });

  // Run defer_write: true on first two keys: D1 key_state must remain untouched during probes
  env.DB.batchCalls = 0;
  const probeOk = await asJson(
    await request(env, "/api/proxy/test", {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ fp, id: rowsBefore[0].id, defer_write: true }),
    }),
  );
  const probeFail = await asJson(
    await request(env, "/api/proxy/test", {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ fp, id: rowsBefore[1].id, defer_write: true }),
    }),
  );
  assert.equal(probeOk.data.ok, true);
  assert.equal(probeOk.data.deferred, true);
  assert.equal(probeFail.data.ok, false);
  assert.equal(probeFail.data.deferred, true);
  assert.equal(env.DB.batchCalls, 0, "defer_write probes do 0 D1 batches");

  const stillUnchanged = await env.DB.prepare(
    "SELECT disabled, fail_count FROM key_state WHERE id = ?",
  )
    .bind(rowsBefore[1].id)
    .first();
  assert.equal(Number(stillUnchanged.fail_count), 0);

  // Commit all 105 outcomes in one /api/proxy/test-commit call -> 1 atomic db.batch!
  const commitResults = rowsBefore.map((r, idx) => ({
    id: r.id,
    ok: idx === 0,
  }));
  env.DB.batchCalls = 0;
  const commitRes = await asJson(
    await request(env, "/api/proxy/test-commit", {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ fp, results: commitResults }),
    }),
  );
  assert.equal(commitRes.status, 200);
  assert.equal(commitRes.data.ok, true);
  assert.equal(commitRes.data.committed, 105);
  assert.equal(env.DB.batchCalls, 1, "105 key outcomes committed in 1 D1 batch");
  const rowsAfterCommit = await getKeyRows(env, fp);
  assert.equal(rowsAfterCommit.length, 105);
  assert.equal(rowsAfterCommit[0].disabled, false);
  assert.equal(rowsAfterCommit[0].fail_count, 0);
  assert.equal(rowsAfterCommit[1].disabled, true);
  assert.equal(rowsAfterCommit[1].fail_count, 1);
  assert.equal(rowsAfterCommit[104].disabled, true);
});

test("proxy_logs reassembles SSE streams across OpenAI Chat/Responses, Anthropic, and Google without TTFB blocking", async () => {
  const env = makeEnv();
  await postSettings(env, [
    provider({ alias: "oa-sse", provider_type: "openai", keys: "k-oa" }),
    provider({
      alias: "ant-sse",
      provider_type: "anthropic",
      api_base: `${upstreamBase()}/ant/v1`,
      keys: "k-ant",
    }),
    provider({
      alias: "gem-sse",
      provider_type: "google",
      api_base: `${upstreamBase()}/v1beta`,
      keys: "k-gem",
    }),
  ]);

  // 1) OpenAI Chat SSE + zero-TTFB check (first chunk readable BEFORE stream finishes)
  let finishSecondChunk;
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      'data: {"model":"gpt-4o-2026","choices":[{"delta":{"reasoning_content":"think-1 ","content":"Hello "}}]}\n\n',
    );
    finishSecondChunk = () => {
      res.write(
        'data: {"choices":[{"delta":{"content":"world!","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n\n',
      );
      res.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ok\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      );
      res.write("data: [DONE]\n\n");
      res.end();
    };
  });

  const sseRes = await request(env, "/proxy/oa-sse/chat/completions", {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [] }),
    awaitWaitUntil: false,
  });
  assert.equal(sseRes.status, 200);
  const reader = sseRes.body.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  assert.match(new TextDecoder().decode(firstChunk.value), /Hello /);

  // Before stream finishes, proxy_logs has NOT written yet (zero TTFB blocking)
  const countMidStream = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM proxy_logs",
  ).first();
  assert.equal(Number(countMidStream.n), 0);

  finishSecondChunk();
  while (!(await reader.read()).done) {
    // consume remaining chunks
  }
  await drainWaitUntil();

  const oaLogs = await asJson(
    await request(env, "/api/proxy/logs?alias=oa-sse", {
      headers: adminHeaders(),
    }),
  );
  assert.equal(oaLogs.data.logs.length, 1);
  assert.equal(oaLogs.data.logs[0].stream, true);
  const oaDetail = await asJson(
    await request(env, `/api/proxy/logs?id=${oaLogs.data.logs[0].id}`, {
      headers: adminHeaders(),
    }),
  );
  const oaReassembled = JSON.parse(oaDetail.data.log.res_body);
  assert.equal(oaReassembled.content, "Hello world!");
  assert.equal(oaReassembled.thinking, "think-1 ");
  assert.equal(oaReassembled.finish_reason, "tool_calls");
  assert.equal(oaReassembled.tool_calls[0].name, "lookup");
  assert.equal(oaReassembled.tool_calls[0].arguments, '{"q":"ok"}');
  assert.deepEqual(oaReassembled.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
  });

  // 2) OpenAI Responses SSE
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Resp "}\n\n',
    );
    res.write(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    );
    res.write(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
    );
    res.end();
  });
  await proxy(env, "/proxy/oa-sse/responses", {
    body: JSON.stringify({ model: "o3", stream: true, input: "hi" }),
  });
  const respLogs = await asJson(
    await request(env, "/api/proxy/logs?model=o3", { headers: adminHeaders() }),
  );
  const respDetail = await asJson(
    await request(env, `/api/proxy/logs?id=${respLogs.data.logs[0].id}`, {
      headers: adminHeaders(),
    }),
  );
  const respBody = JSON.parse(respDetail.data.log.res_body);
  assert.equal(respBody.content, "Resp OK");
  assert.equal(respBody.finish_reason, "completed");
  assert.deepEqual(respBody.usage, { input_tokens: 4, output_tokens: 2 });

  // 3) Anthropic Messages SSE
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-4","usage":{"input_tokens":12}}}\n\n',
    );
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"deep thought"}}\n\n',
    );
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Claude reply"}}\n\n',
    );
    res.write(
      'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash"}}\n\n',
    );
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}\n\n',
    );
    res.write(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n',
    );
    res.end();
  });
  await proxy(env, "/proxy/ant-sse/messages", {
    body: JSON.stringify({ model: "claude-4", stream: true, messages: [] }),
  });
  const antLogs = await asJson(
    await request(env, "/api/proxy/logs?alias=ant-sse", {
      headers: adminHeaders(),
    }),
  );
  const antDetail = await asJson(
    await request(env, `/api/proxy/logs?id=${antLogs.data.logs[0].id}`, {
      headers: adminHeaders(),
    }),
  );
  const antBody = JSON.parse(antDetail.data.log.res_body);
  assert.equal(antBody.thinking, "deep thought");
  assert.equal(antBody.content, "Claude reply");
  assert.equal(antBody.finish_reason, "tool_use");
  assert.equal(antBody.tool_calls[0].name, "bash");
  assert.equal(antBody.tool_calls[0].arguments, '{"cmd":"ls"}');
  assert.deepEqual(antBody.usage, { input_tokens: 12, output_tokens: 9 });

  // 4) Google Gemini SSE (model extracted from URL path)
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"plan..."},{"text":"Gemini answer"}]}}]}\n\n',
    );
    res.write(
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"q":"cf"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":4}}\n\n',
    );
    res.end();
  });
  await proxy(
    env,
    "/proxy/gem-sse/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    { body: JSON.stringify({ contents: [] }) },
  );
  const gemLogs = await asJson(
    await request(env, "/api/proxy/logs?alias=gem-sse", {
      headers: adminHeaders(),
    }),
  );
  assert.equal(gemLogs.data.logs[0].model, "gemini-2.5-pro");
  assert.equal(gemLogs.data.logs[0].stream, true);
  const gemDetail = await asJson(
    await request(env, `/api/proxy/logs?id=${gemLogs.data.logs[0].id}`, {
      headers: adminHeaders(),
    }),
  );
  const gemBody = JSON.parse(gemDetail.data.log.res_body);
  assert.equal(gemBody.thinking, "plan...");
  assert.equal(gemBody.content, "Gemini answer");
  assert.equal(gemBody.finish_reason, "STOP");
  assert.equal(gemBody.tool_calls[0].name, "search");
  assert.deepEqual(gemBody.usage, {
    promptTokenCount: 7,
    candidatesTokenCount: 4,
  });
});

test("proxy_logs sanitizes base64/oversized bodies, scrubs keys, records each retry attempt separately, enforces scope & 1980 cap, and supports filters", async () => {
  const secretKey = "sk-supersecretkey9999";
  const env = makeEnv();
  const pA = provider({ alias: "logs-a", keys: secretKey });
  const pB = provider({
    alias: "logs-b",
    api_base: `${upstreamBase()}/b/v1`,
    keys: "sk-otherkey8888",
  });
  await postSettings(env, [pA, pB], { proxy_fail_threshold: 5 });
  const fpA = await fingerprintOf(env, pA);

  // Excluded from proxy_logs: 401 bad proxy auth, 404 unknown alias, and /api/proxy/test
  await request(env, "/proxy/logs-a/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
    body: "{}",
  });
  await proxy(env, "/proxy/unknown-alias/chat/completions");
  const [rowA] = await getKeyRows(env, fpA);
  await request(env, "/api/proxy/test", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp: fpA, id: rowA.id, model: "m1" }),
  });
  const zeroLogs = await asJson(
    await request(env, "/api/proxy/logs", { headers: adminHeaders() }),
  );
  assert.equal(zeroLogs.data.total, 0);

  // Logged: sanitized base64 + >65536 clipping on 200 OK
  const bigBase64Uri = `data:image/png;base64,${"A".repeat(400)}`;
  const bigInlineData = `"data": "${"B".repeat(600)}"`;
  const hugeResp = "X".repeat(70_000);
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(hugeResp);
  });
  await proxy(env, "/proxy/logs-a/chat/completions", {
    headers: proxyHeaders({ "User-Agent": "TestClient/2.4" }),
    body: `{"model":"gpt-img","uri":"${bigBase64Uri}",${bigInlineData}}`,
  });

  // Logged: upstream 401 echoing secret key -> scrubbed in error & res_body
  useUpstream((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(`{"error":{"message":"Incorrect API key provided: ${secretKey}"}}`);
  });
  await proxy(env, "/proxy/logs-a/chat/completions", {
    body: '{"model":"gpt-err"}',
  });

  // Logged: status = 502 network error & status = 499 timeout error
  useUpstream((req) => {
    req.socket.destroy();
  });
  await proxy(env, "/proxy/logs-b/chat/completions", {
    body: '{"model":"gpt-net"}',
  });
  await postSettings(env, [pA, pB], {
    proxy_fail_threshold: 5,
    proxy_upstream_timeout_ms: 1000,
  });
  useUpstream(() => {
    // never respond so Worker aborts after timeout
  });
  const timeoutProxyRes = await proxy(env, "/proxy/logs-b/chat/completions", {
    body: '{"model":"gpt-timeout"}',
  });
  assert.equal(timeoutProxyRes.status, 499);

  // Logged: 503 NO_KEYS when all keys of logs-a are disabled
  await request(env, "/api/proxy/disable", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp: fpA, id: rowA.id }),
  });
  await proxy(env, "/proxy/logs-a/chat/completions", {
    body: '{"model":"gpt-nokeys"}',
  });

  // Verify list mode omits heavy payload columns and supports filters
  const allList = await asJson(
    await request(env, "/api/proxy/logs", { headers: adminHeaders() }),
  );
  assert.equal(allList.data.total, 5);
  const netLogRow = allList.data.logs.find((r) => r.model === "gpt-net");
  const timeoutLogRow = allList.data.logs.find((r) => r.model === "gpt-timeout");
  assert.equal(netLogRow.status, 502);
  assert.equal(timeoutLogRow.status, 499);
  for (const item of allList.data.logs) {
    assert.equal("req_body" in item, false);
    assert.equal("res_body" in item, false);
    assert.equal("attempts" in item, false);
    assert.equal("attempts_detail" in item, false);
    assert.equal(item.ttfb_ms, null, "non-streaming logs must report ttfb_ms as null");
  }
  assert.deepEqual(allList.data.facets.aliases, ["logs-a", "logs-b"]);
  for (const item of allList.data.logs) {
    assert.equal(
      "api_key" in item,
      false,
      "GET /api/proxy/logs list rows must never expose plaintext api_key",
    );
  }

  const okOnly = await asJson(
    await request(env, "/api/proxy/logs?status=ok", { headers: adminHeaders() }),
  );
  assert.equal(okOnly.data.total, 1);
  assert.equal(okOnly.data.logs[0].model, "gpt-img");

  const failOnly = await asJson(
    await request(env, "/api/proxy/logs?status=fail", { headers: adminHeaders() }),
  );
  assert.equal(failOnly.data.total, 4);

  const status503 = await asJson(
    await request(env, "/api/proxy/logs?status=503", { headers: adminHeaders() }),
  );
  assert.equal(status503.data.total, 1);
  assert.equal(status503.data.logs[0].model, "gpt-nokeys");

  // Time filter `to_ts` keeps only records with `ts <= to_ts`
  const cutoffZero = await asJson(
    await request(env, "/api/proxy/logs?to_ts=0", { headers: adminHeaders() }),
  );
  assert.equal(cutoffZero.data.total, 0);
  const cutoffAll = await asJson(
    await request(
      env,
      `/api/proxy/logs?to_ts=${Date.now() + 60_000}`,
      { headers: adminHeaders() },
    ),
  );
  assert.equal(cutoffAll.data.total, 5);

  // Key search matches BOTH plaintext key and masked key!
  const byPlainKey = await asJson(
    await request(
      env,
      `/api/proxy/logs?key=${encodeURIComponent(secretKey)}`,
      { headers: adminHeaders() },
    ),
  );
  assert.equal(byPlainKey.data.total, 2);
  const maskedA = byPlainKey.data.logs[0].key_masked;
  const byMaskedKey = await asJson(
    await request(
      env,
      `/api/proxy/logs?key=${encodeURIComponent(maskedA)}`,
      { headers: adminHeaders() },
    ),
  );
  assert.equal(byMaskedKey.data.total, 2);

  // Inspect sanitized request/response bodies, upstream_url & scrubbed secret in detail mode
  const imgId = okOnly.data.logs[0].id;
  const imgDetail = await asJson(
    await request(env, `/api/proxy/logs?id=${imgId}`, {
      headers: adminHeaders(),
    }),
  );
  assert.equal(imgDetail.data.log.api_key, secretKey);
  assert.equal(
    imgDetail.data.log.upstream_url,
    `${upstreamBase()}/v1/chat/completions`,
  );
  assert.equal(imgDetail.data.log.user_agent, "TestClient/2.4");
  assert.equal("attempts" in imgDetail.data.log, false);
  assert.equal("attempts_detail" in imgDetail.data.log, false);
  assert.match(imgDetail.data.log.req_body, /<base64 omitted/);
  assert.ok(!imgDetail.data.log.req_body.includes("AAAA"));
  assert.ok(!imgDetail.data.log.req_body.includes("BBBB"));
  assert.match(imgDetail.data.log.res_body, /\[\d+ chars omitted\]/);
  assert.ok(imgDetail.data.log.res_body.length < 66_000);

  const errRow = allList.data.logs.find((r) => r.model === "gpt-err");
  const errDetail = await asJson(
    await request(env, `/api/proxy/logs?id=${errRow.id}`, {
      headers: adminHeaders(),
    }),
  );
  assert.ok(!errDetail.data.log.error.includes(secretKey));
  assert.ok(errDetail.data.log.error.includes(maskedA));
  assert.ok(!errDetail.data.log.res_body.includes(secretKey));

  // Verify each attempt is recorded as an independent row (4 failed attempts -> 4 rows)
  const pMulti = provider({
    alias: "logs-multi",
    api_base: `${upstreamBase()}/m/v1`,
    keys: "sk-m11111111111\nsk-m22222222222\nsk-m33333333333\nsk-m44444444444",
  });
  await postSettings(env, [pA, pB, pMulti], {
    proxy_fail_threshold: 5,
    proxy_max_retries: 3,
  });
  useUpstream((_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end('{"error":"rate limit"}');
  });
  await proxy(env, "/proxy/logs-multi/chat/completions", {
    body: '{"model":"gpt-retry-4"}',
  });
  const multiLogs = await asJson(
    await request(env, "/api/proxy/logs?alias=logs-multi", {
      headers: adminHeaders(),
    }),
  );
  assert.equal(
    multiLogs.data.total,
    4,
    "4 attempts (initial + 3 retries) must produce 4 separate proxy_logs rows",
  );

  // Seed >1,980 rows + trigger cleanupEvery(1) on next proxy request -> auto-capped to 1,980 rows!
  await request(env, "/api/proxy/recover", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp: fpA, id: rowA.id }),
  });
  useUpstream(defaultUpstream);
  env.DB.db.exec("BEGIN");
  const insertStmt = env.DB.db.prepare(
    "INSERT INTO proxy_logs (ts, alias, provider_type, method, path, status, duration_ms) VALUES (?, 'logs-a', 'openai', 'POST', '/chat/completions', 200, 10)",
  );
  for (let i = 0; i < 1982; i++) {
    insertStmt.run(1_000_000 + i);
  }
  env.DB.db.exec("COMMIT");

  worker.__test.setLogCleanupEvery(1);
  await proxy(env, "/proxy/logs-a/chat/completions", {
    body: '{"model":"newest-kept"}',
  });
  const cappedCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM proxy_logs",
  ).first();
  assert.equal(Number(cappedCount.n), 1980);

  // Page 99 returns the tail within 1980 cap, page 100 clamps to 99
  const page99 = await asJson(
    await request(env, "/api/proxy/logs?page=99", { headers: adminHeaders() }),
  );
  assert.equal(page99.data.page, 99);
  assert.equal(page99.data.total_pages, 99);
  assert.equal(page99.data.logs.length, 20);
});

test("review hardening: snapshot epoch anti-race, split CRLF SSE + Anthropic empty tool input, zero-tee binary stream, URL/path guards, and JSON1 test-model upsert", async () => {
  // 1. URL / private-IP / self-origin / path-traversal / test_path guards
  const envGuard = makeEnv();
  for (const badBase of [
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.8/v1",
    "https://172.16.5.4/v1",
    "https://192.168.1.10/v1",
    "https://[fc00::1]/v1",
    "https://[fe80::1]/v1",
    "https://example.test/proxy/loop",
    "https://api.openai.com/tenant-a/../tenant-b",
    "https://api.openai.com/tenant-a/%2e%2e/tenant-b",
  ]) {
    const res = await asJson(
      await request(envGuard, "/api/settings", {
        method: "POST",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          providers: [provider({ alias: "guard", api_base: badBase, keys: "sk-111111111111" })],
          proxy_password: PROXY,
        }),
      }),
    );
    assert.equal(res.status, 400, `expected 400 for unsafe api_base ${badBase}`);
  }

  for (const badTestPath of [
    "/v1/chat/completions?foo=1",
    "/v1/chat/completions#frag",
    "/v1/../admin",
    "/v1/%2e%2e/admin",
  ]) {
    const res = await asJson(
      await request(envGuard, "/api/settings", {
        method: "POST",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          providers: [provider({ alias: "tp", test_path: badTestPath, keys: "sk-111111111111" })],
          proxy_password: PROXY,
        }),
      }),
    );
    assert.equal(res.status, 400, `expected 400 for unsafe test_path ${badTestPath}`);
  }

  // 2. Proxy encoded path traversal rejected with 400 + zero-tee binary passthrough + split CRLF SSE
  const env = makeEnv();
  const pAnthropic = provider({
    alias: "ant-sse",
    provider_type: "anthropic",
    test_path: "/v1/messages",
    api_base: `${upstreamBase()}/ant`,
    keys: "sk-ant-review-key-111111111111",
    models: "claude-sonnet-4",
  });
  const pBin = provider({
    alias: "tts-bin",
    provider_type: "openai",
    test_path: "/v1/chat/completions",
    api_base: `${upstreamBase()}/bin`,
    keys: "sk-bin-review-key-222222222222",
    models: "tts-1",
  });
  await postSettings(env, [pAnthropic, pBin]);

  // Single-encoded %2e%2e is collapsed by WHATWG URL before alias routing (404, 0 outbound);
  // double-encoded %252e%252e or %5c in subPath is rejected with 400 (0 outbound).
  resetCaptured();
  const singleEncTraversal = await asJson(
    await request(env, "/proxy/ant-sse/%2e%2e/admin/secrets", {
      method: "POST",
      headers: proxyHeaders(),
      body: "{}",
    }),
  );
  assert.equal(singleEncTraversal.status, 404);
  const doubleEncTraversal = await asJson(
    await request(env, "/proxy/ant-sse/%252e%252e/admin/secrets", {
      method: "POST",
      headers: proxyHeaders(),
      body: "{}",
    }),
  );
  assert.equal(doubleEncTraversal.status, 400);
  assert.equal(captured.length, 0);

  // Binary audio response streams verbatim without buffering as text
  const rawAudio = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0xff, 0xfb]);
  useUpstream((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(rawAudio.length),
    });
    res.end(rawAudio);
  });
  const binRes = await request(env, "/proxy/tts-bin/v1/audio/speech", {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify({ model: "tts-1", input: "hello" }),
  });
  assert.equal(binRes.status, 200);
  const clientAudio = Buffer.from(await binRes.arrayBuffer());
  assert.deepEqual(clientAudio, rawAudio);

  // Split `\r\n\r\n` right across chunk boundaries + Anthropic empty-input tool_use (`input: {}`)
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === "string" ? input : input.url;
    if (u.includes("/ant/v1/messages")) {
      const enc = new TextEncoder();
      const chunks = [
        'event: message_start\r',
        '\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4","usage":{"input_tokens":9}}}\r',
        '\n\r',
        '\nevent: content_block_start\r\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_empty","name":"ping","input":{}}}\r',
        '\n\r',
        '\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Split CRLF OK"}}\r\n\r',
        '\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\r\n\r\n',
      ];
      let idx = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (idx < chunks.length) {
            controller.enqueue(enc.encode(chunks[idx++]));
          } else {
            controller.close();
          }
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return origFetch(input, init);
  };
  try {
    const sseRes = await request(env, "/proxy/ant-sse/v1/messages", {
      method: "POST",
      headers: proxyHeaders(),
      body: JSON.stringify({ model: "claude-sonnet-4", stream: true }),
    });
    assert.equal(sseRes.status, 200);
    await sseRes.text();
    await drainWaitUntil();
  } finally {
    globalThis.fetch = origFetch;
  }

  const logsList = await asJson(
    await request(env, "/api/proxy/logs", { headers: adminHeaders() }),
  );
  assert.equal(logsList.data.total, 2);
  const sseItem = logsList.data.logs.find((r) => r.alias === "ant-sse");
  const binItem = logsList.data.logs.find((r) => r.alias === "tts-bin");
  assert.ok(sseItem && binItem);

  const sseDetail = await asJson(
    await request(env, `/api/proxy/logs?id=${sseItem.id}`, {
      headers: adminHeaders(),
    }),
  );
  const parsedSse = JSON.parse(sseDetail.data.log.res_body);
  assert.equal(parsedSse.content, "Split CRLF OK");
  assert.equal(parsedSse.finish_reason, "tool_use");
  assert.deepEqual(parsedSse.tool_calls, [
    { id: "toolu_empty", type: "tool_use", name: "ping", arguments: "{}" },
  ]);

  const binDetail = await asJson(
    await request(env, `/api/proxy/logs?id=${binItem.id}`, {
      headers: adminHeaders(),
    }),
  );
  assert.equal(
    binDetail.data.log.res_body,
    `[binary payload (${rawAudio.length} bytes, audio/mpeg)]`,
  );

  // 3. Atomic SQLite JSON1 `proxy_test_models` preserves concurrent updates from other isolates
  const fpAnt = await fingerprintOf(env, pAnthropic);
  const fpBin = await fingerprintOf(env, pBin);
  await postTestModel(env, fpAnt, "claude-sonnet-4");
  // Simulate another isolate writing `fpBin` directly in D1 while this isolate's snapshot is warm
  await env.DB.prepare(
    "UPDATE store SET v = json_set(v, ?, ?) WHERE k = 'proxy_test_models'",
  )
    .bind(`$.${fpBin}`, "tts-1")
    .run();
  // Updating `fpAnt` on this isolate must NOT clobber `fpBin` in D1!
  await postTestModel(env, fpAnt, "claude-sonnet-4");
  const rawModelsRow = await env.DB.prepare(
    "SELECT v FROM store WHERE k = 'proxy_test_models'",
  ).first();
  const storedMap = JSON.parse(rawModelsRow.v);
  assert.equal(storedMap[fpAnt], "claude-sonnet-4");
  assert.equal(storedMap[fpBin], "tts-1");

  // 4. Snapshot `epoch` prevents an in-flight cold load from overwriting a concurrent settings save
  worker.__test.invalidateSnapshot(env.DB);
  const origBatch = env.DB.batch.bind(env.DB);
  let releaseSlowColdLoad;
  let interceptedFirstColdLoad = false;
  let notifyPaused;
  const pausedPromise = new Promise((r) => {
    notifyPaused = r;
  });
  env.DB.batch = async (stmts) => {
    const res = await origBatch(stmts);
    if (!interceptedFirstColdLoad) {
      interceptedFirstColdLoad = true;
      notifyPaused();
      await new Promise((r) => {
        releaseSlowColdLoad = r;
      });
    }
    return res;
  };
  try {
    useUpstream(defaultUpstream);
    // Start a cold snapshot load that reads version = 1 and pauses before committing snapshot
    const inflightStateReq = request(env, "/api/proxy/state", {
      headers: adminHeaders(),
    });
    await pausedPromise;

    // While paused, save new settings (version = 2, only pBin kept with new alias)
    const updatedBin = { ...pBin, alias: "tts-v2" };
    await postSettings(env, [updatedBin]);

    // Release the paused cold load from epoch 0 -> must NOT overwrite snapshot with stale version 1!
    releaseSlowColdLoad();
    const stateRes = await asJson(await inflightStateReq);
    assert.equal(stateRes.status, 200);
    assert.deepEqual(
      stateRes.data.providers.map((p) => p.alias),
      ["tts-v2"],
    );
    assert.deepEqual(
      [...worker.__test.getDbState(env.DB).snapshot.providersByAlias.keys()],
      ["tts-v2"],
    );
  } finally {
    env.DB.batch = origBatch;
  }
});
