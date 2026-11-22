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
  constructor(db, sql, params = []) {
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
    return new FakeStatement(this.db, this.sql, params);
  }

  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }

  async all() {
    const rows = this.db.prepare(this.sql).all(...this.params);
    return { results: rows, success: true, meta: { changes: 0 } };
  }

  async run() {
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
  }

  prepare(sql) {
    return new FakeStatement(this.db, sql);
  }

  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (const stmt of stmts) {
        results.push(await stmt.run());
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
const DEFAULT_GW_LOGS_URL =
  "https://dash.cloudflare.com/acct/ai/ai-gateway/gateways/gw/logs";
const DEFAULT_GW_TOKEN = "gw-token";

let server;
let upstreamHandler;
let captured;
let gatewayCalls;
let aliasBases;
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
  gatewayCalls = [];
  aliasBases = new Map();
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

function request(env, path, { method = "GET", headers = {}, body } = {}) {
  return worker.fetch(
    new Request(`https://example.test${path}`, {
      method,
      headers,
      body,
    }),
    env,
  );
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

function adminHeaders() {
  return { Authorization: `Bearer ${ADMIN}` };
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
    ai_gateway_logs_url: DEFAULT_GW_LOGS_URL,
    ai_gateway_token: DEFAULT_GW_TOKEN,
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
  const parsed = await asJson(response);
  if (parsed.status === 200 && Array.isArray(providers)) {
    for (const p of providers) {
      if (p && p.alias && p.api_base) {
        aliasBases.set(
          String(p.alias).trim(),
          String(p.api_base).trim().replace(/\/+$/, ""),
        );
      }
    }
  }
  return parsed;
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
    const gwPrefix = "https://gateway.ai.cloudflare.com/v1/";
    if (!rawUrl.startsWith(gwPrefix)) {
      return originalFetch(url, init);
    }
    const parsed = new URL(rawUrl);
    const match = /^\/v1\/([^/]+)\/([^/]+)\/custom-([^/]+)(\/.*)?$/.exec(
      parsed.pathname,
    );
    if (!match) {
      throw new Error(`Unexpected AI Gateway path in test: ${parsed.pathname}`);
    }
    const accountId = decodeURIComponent(match[1]);
    const gatewayId = decodeURIComponent(match[2]);
    const slug = decodeURIComponent(match[3]);
    const restPath = match[4] || "";
    const gwHeaders = new Headers(init.headers);
    gatewayCalls.push({
      url: rawUrl,
      accountId,
      gatewayId,
      slug,
      headers: gwHeaders,
      method: init.method || "GET",
    });

    // Simulate Cloudflare AI Gateway stripping cf-aig-* control headers before forwarding upstream.
    const upstreamHeaders = new Headers();
    for (const [k, v] of gwHeaders.entries()) {
      if (k.toLowerCase().startsWith("cf-aig-")) continue;
      upstreamHeaders.append(k, v);
    }
    const base = aliasBases.get(slug) || `${upstreamBase()}/v1`;
    return originalFetch(`${base}${restPath}${parsed.search}`, {
      ...init,
      headers: upstreamHeaders,
    });
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
    ["/api/proxy/recover", { method: "POST", headers: adminHeaders(), body: "{}" }],
    ["/api/proxy/test-model", { method: "POST", headers: adminHeaders(), body: "{}" }],
  ];
  for (const [path, init] of checks) {
    const result = await asJson(await request(env, path, init));
    assert.equal(result.status, 503, `${path} should return 503 in KV mode`);
    assert.equal(result.data.code, "PROXY_DISABLED");
    assert.match(result.data.error, /d1/i);
  }
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

test("proxy routes through AI Gateway custom-{alias}, keeps query string and replaces auth", async () => {
  const env = makeEnv();
  await postSettings(env, [provider({ alias: "openai", keys: "key-aaaa" })]);

  const result = await proxy(env, "/proxy/openai/chat/completions?x=1");
  assert.equal(result.status, 200);
  assert.equal(gatewayCalls.length, 1);
  assert.equal(
    gatewayCalls[0].url,
    "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-openai/chat/completions?x=1",
  );
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

test("gemini and anthropic use their own auth headers", async () => {
  const env = makeEnv();
  await postSettings(env, [
    provider({
      alias: "gem",
      provider_type: "gemini",
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
  const found = data.providers[0];
  assert.equal(found.keys_total, 5);
  assert.equal(found.keys_available, 5);
  assert.equal(found.proxy_url, "/proxy/openai");
  assert.equal(found.sample_path, "/chat/completions");
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

  // Clicking Test with a new model saves it alongside the probe, and repeating
  // the same model avoids redundant app_settings writes.
  captured.length = 0;
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
  assert.equal(typeof testWithNewModel.data.settings_version, "number");
  assert.equal(JSON.parse(captured[0].body).model, "m2");

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

// ── AI Gateway (fetch intercepted) ─────────────────────────────────────────

test("gateway mode parses Logs URL, ignores legacy env vars, and writes plaintext ASCII metadata", async () => {
  // Legacy env.* vars must be completely ignored in favor of app_settings.
  const env = makeEnv({
    vars: {
      PROXY_PASSWORD: "legacy-env-password",
      AI_GATEWAY_ACCOUNT_ID: "legacy-acct",
      AI_GATEWAY_ID: "legacy-gw",
      AI_GATEWAY_TOKEN: "legacy-token",
    },
  });
  await postSettings(env, [
    provider({
      alias: "openai",
      keys: "sk-abcdefghij1234\nsk-short\nsk-caf\u00e9-ok",
    }),
  ]);

  const proxyState = await asJson(
    await request(env, "/api/proxy/state", { headers: adminHeaders() }),
  );
  assert.equal("tag" in proxyState.data.providers[0].keys[0], false);
  assert.equal(proxyState.data.providers[0].logs_url, DEFAULT_GW_LOGS_URL);

  for (const expectedKey of ["sk-abcdefghij1234", "sk-short", "sk-caf-ok"]) {
    gatewayCalls.length = 0;
    const result = await proxy(env, "/proxy/openai/chat/completions?q=1");
    assert.equal(result.status, 200);
    assert.equal(gatewayCalls.length, 1);
    const seen = gatewayCalls[0];
    assert.equal(
      seen.url,
      "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-openai/chat/completions?q=1",
    );
    assert.equal(seen.headers.get("cf-aig-skip-cache"), "true");
    assert.equal(seen.headers.get("cf-aig-max-attempts"), "1");
    assert.equal(seen.headers.get("cf-aig-authorization"), "Bearer gw-token");
    const metadata = seen.headers.get("cf-aig-metadata");
    assert.equal(
      metadata,
      JSON.stringify({ key: expectedKey, provider: "openai" }),
    );
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x20-\x7e]*$/.test(metadata));
  }
});

test("settings validate Gateway Logs URL and proxy/test require Gateway & alias with no direct fallback", async () => {
  const env = makeEnv();

  const badUrl = await postSettings(env, [], {
    ai_gateway_logs_url: "https://example.com/not-cloudflare",
  });
  assert.equal(badUrl.status, 400);
  assert.match(badUrl.data.error, /Logs URL/);

  const samePass = await postSettings(env, [], { proxy_password: ADMIN });
  assert.equal(samePass.status, 400);

  const badRetry = await postSettings(env, [], { proxy_max_retries: 5 });
  assert.equal(badRetry.status, 400);

  // Incomplete Gateway config blocks both /proxy/* and /api/proxy/test with 503.
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
    provider_type: "gemini",
    alias: "gem",
    api_base: `${upstreamBase()}/v1beta`,
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

  await postSettings(env, [oaAliasProv], { ai_gateway_token: "" });
  const fpOaMissing = await fingerprintOf(env, oaAliasProv);
  await postTestModel(env, fpOaMissing, "m-oa");
  const [oaRowMissing] = await getKeyRows(env, fpOaMissing);
  const proxyDisabled = await proxy(env, "/proxy/oa/chat/completions");
  assert.equal(proxyDisabled.status, 503);
  const testDisabled = await asJson(
    await request(env, "/api/proxy/test", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fp: fpOaMissing, id: oaRowMissing.id }),
    }),
  );
  assert.equal(testDisabled.status, 503);
  assert.equal(captured.length, 0);

  // Valid Gateway config: alias is required for manual probe, and probes use non-streaming "only reply 1." max 8 tokens.
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

test("custom test_path overrides proxy probe path and validates relative path format", async () => {
  const env = makeEnv();
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
  const pGemini = provider({
    provider_type: "gemini",
    alias: "g-root",
    api_base: "https://generativelanguage.googleapis.com",
    keys: "g1",
    test_path: "/v1beta/models/{model}:generateContent",
  });
  const ok = await postSettings(env, [pOpenai, pGemini]);
  assert.equal(ok.status, 200);

  const saved = await asJson(
    await request(env, "/api/settings", { headers: adminHeaders() }),
  );
  assert.equal(saved.data.settings.providers[0].test_path, "/v1/chat/completions");

  const fpO = await fingerprintOf(env, pOpenai);
  const [kO] = await getKeyRows(env, fpO);
  gatewayCalls.length = 0;
  await request(env, "/api/proxy/test", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp: fpO, id: kO.id, model: "gpt-4o" }),
  });
  assert.match(gatewayCalls[0].url, /\/custom-vercel\/v1\/chat\/completions$/);

  const fpG = await fingerprintOf(env, pGemini);
  const [kG] = await getKeyRows(env, fpG);
  gatewayCalls.length = 0;
  await request(env, "/api/proxy/test", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ fp: fpG, id: kG.id, model: "gemini-2.5-flash" }),
  });
  assert.match(gatewayCalls[0].url, /\/custom-g-root\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
});
