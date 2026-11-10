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
    PROXY_PASSWORD: PROXY,
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

async function postSettings(env, providers) {
  const response = await request(env, "/api/settings", {
    method: "POST",
    headers: { ...adminHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ providers }),
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

  const got = await asJson(await request(env, "/api/settings", { headers: adminHeaders() }));
  assert.equal(got.data.settings.providers.length, 1);
  assert.match(got.data.settings.providers[0].keys, /k1/);
});

// ── R1: forwarding + auth ──────────────────────────────────────────────────

test("kv mode disables the proxy with an explicit message and no outbound request", async () => {
  const env = makeEnv({ vars: { STORAGE_BACKEND: "kv" } });
  const response = await request(env, "/proxy/abc/chat/completions", {
    method: "POST",
    headers: proxyHeaders(),
    body: "{}",
  });
  const result = await asJson(response);
  assert.equal(result.status, 503);
  assert.match(result.data.error, /d1/i);
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

test("proxy builds api_base + relative path, keeps the query string and replaces auth", async () => {
  const env = makeEnv();
  await postSettings(env, [provider({ alias: "openai", keys: "key-aaaa" })]);

  const result = await proxy(env, "/proxy/openai/chat/completions?x=1");
  assert.equal(result.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "/v1/chat/completions?x=1");
  assert.equal(captured[0].headers.authorization, "Bearer key-aaaa");
});

test("unknown alias and disabled provider are rejected before any upstream call", async () => {
  const env = makeEnv();
  await postSettings(env, [
    provider({ alias: "off", enabled: false, keys: "k1" }),
  ]);

  const unknown = await proxy(env, "/proxy/nope/chat/completions");
  assert.equal(unknown.status, 404);

  const disabled = await proxy(env, "/proxy/off/chat/completions");
  assert.equal(disabled.status, 503);
  assert.equal(captured.length, 0);
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
  const env = makeEnv({ vars: { PROXY_FAIL_THRESHOLD: "3" } });
  const p = provider({ alias: "openai", keys: "bad\ngood" });
  await postSettings(env, [p]);
  const fp = await fingerprintOf(env, p);

  const result = await proxy(env, "/proxy/openai/chat/completions");
  assert.equal(result.status, 200);
  assert.deepEqual(
    captured.map((c) => c.headers.authorization),
    ["Bearer bad", "Bearer good"],
  );

  const keys = await getKeyRows(env, fp);
  const bad = keys.find((k) => k.masked === "b***d");
  assert.equal(bad.fail_count, 1);
  assert.equal(bad.disabled, false);
});

test("failure threshold disables a key; recovery is manual or via the next daily pass", async () => {
  useUpstream((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":"invalid key"}');
  });
  const env = makeEnv({ vars: { PROXY_FAIL_THRESHOLD: "1" } });
  const p = provider({ alias: "openai", keys: "only" });
  await postSettings(env, [p]);
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
  const env = makeEnv({ vars: { PROXY_FAIL_THRESHOLD: "1" } });
  const p = provider({ alias: "openai", keys: "k1\nk2\nk3" });
  await postSettings(env, [p]);
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
  const env = makeEnv({ vars: { PROXY_FAIL_THRESHOLD: "1" } });
  const p = provider({ alias: "openai", keys: "k1\nk2" });
  await postSettings(env, [p]);
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
      ["k***1", 0, false],
      ["k***2", 1, true],
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
  const env = makeEnv({ vars: { PROXY_FAIL_THRESHOLD: "9" } });
  const p = provider({ alias: "openai", keys: "k1\nk2\nk3\nk4\nk5" });
  await postSettings(env, [p]);
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
  const p = provider({ alias: "openai", keys: "sk-aaaaaaaaaaaa1111\nsk-bbbbbbbbbbbb2222\nabcdefghi" });
  await postSettings(env, [p]);

  const response = await request(env, "/api/proxy/state", {
    headers: adminHeaders(),
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!text.includes("sk-aaaaaaaaaaaa1111"));
  assert.ok(!text.includes("sk-bbbbbbbbbbbb2222"));
  const data = JSON.parse(text);
  const found = data.providers[0];
  assert.equal(found.keys_total, 3);
  assert.equal(found.keys_available, 3);
  assert.equal(found.proxy_url, "/proxy/openai");
  assert.equal(found.sample_path, "/chat/completions");
  assert.equal(found.keys[0].masked, "sk-a***1111");
  // A 9-character key must not show 8 of its 9 characters.
  assert.equal(found.keys[2].masked, "a***i");
});

test("a failed manual test charges the key and can disable it", async () => {
  useUpstream((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":"nope"}');
  });
  const env = makeEnv({ vars: { PROXY_FAIL_THRESHOLD: "2" } });
  const p = provider({ alias: "openai", keys: "k1" });
  await postSettings(env, [p]);
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

  const [after] = await getKeyRows(env, fp);
  assert.equal(after.fail_count, 2);
  assert.equal(after.disabled, true);
  assert.equal(after.last_used_at, null, "手動測試不參與輪用，不該蓋最近使用時間");
});

test("a successful manual test does not clear a disabled key", async () => {
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{\"ok\":true}");
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
  assert.equal(result.data.ok, true);
  assert.equal(result.data.disabled, undefined, "成功不寫帳本");

  const [after] = await getKeyRows(env, fp);
  assert.equal(after.disabled, true, "恢復只能靠每日結果或手動按钮");
  assert.equal(after.fail_count, 3);
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
  assert.deepEqual(after.map((k) => k.masked), ["k***2"]);

  const moved = { ...first, api_base: `${upstreamBase()}/v2` };
  await postSettings(env, [moved]);
  const oldFp = await fingerprintOf(env, { ...first });
  assert.equal(oldFp, null);
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM key_state").first();
  assert.equal(Number(rows.n), 2);
});

test("re-saving the same keys keeps fail_count", async () => {
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1" });
  await postSettings(env, [p]);
  const fp = await fingerprintOf(env, p);
  await env.DB.prepare(
    "UPDATE key_state SET fail_count = 2 WHERE fp = ? AND api_key = ?",
  )
    .bind(fp, "k1")
    .run();
  await postSettings(env, [p]);
  const [key] = await getKeyRows(env, fp);
  assert.equal(key.fail_count, 2);
});

// ── R0: migration + backup ─────────────────────────────────────────────────

test("migration walks every KV page, seeds key_state, is rerun-safe and verifiable", async () => {
  const kv = new FakeKV({}, 2); // force many pages
  const providers = [provider({ alias: "openai", keys: "k1\nk2\nk3" })];
  kv.map.set(
    "app_settings",
    JSON.stringify({ providers, github_url: "", discord_webhook_url: "", version: 4 }),
  );
  for (let i = 0; i < 7; i++) {
    kv.map.set(`results:fp${i}`, JSON.stringify({ i, value: `v${i}` }));
  }
  kv.map.set("dead_keys", JSON.stringify([{ id: "x", api_key: "k1" }]));

  const env = makeEnv({ kv, vars: { STORAGE_BACKEND: "kv" } });

  const dry = await asJson(
    await request(env, "/api/storage/migrate", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "migrate", dryRun: true }),
    }),
  );
  assert.equal(dry.status, 200);
  assert.equal(dry.data.entries, 9);
  assert.ok(dry.data.kv_pages > 1);

  const migrated = await asJson(
    await request(env, "/api/storage/migrate", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "migrate" }),
    }),
  );
  assert.equal(migrated.status, 200);
  assert.equal(migrated.data.store_inserted, 9);
  assert.equal(migrated.data.key_state_seeded, 3);

  const again = await asJson(
    await request(env, "/api/storage/migrate", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "migrate" }),
    }),
  );
  assert.equal(again.data.store_inserted, 0);
  assert.equal(again.data.store_skipped_existing, 9);
  assert.equal(again.data.key_state_seeded, 0);

  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM key_state").first();
  assert.equal(Number(rows.n), 3);

  const kvExport = await asJson(
    await request(env, "/api/storage/export?source=kv", { headers: adminHeaders() }),
  );
  const d1Export = await asJson(
    await request(env, "/api/storage/export?source=d1", { headers: adminHeaders() }),
  );
  assert.equal(kvExport.status, 200);
  assert.equal(d1Export.status, 200);
  assert.equal(d1Export.headers.get("cache-control"), "no-store");
  const target = new Map(d1Export.data.entries.map((e) => [e.k, e.v]));
  for (const entry of kvExport.data.entries) {
    assert.equal(target.get(entry.k), entry.v, entry.k);
  }
});

test("migration requires confirmation and both bindings", async () => {
  const env = makeEnv({ vars: { STORAGE_BACKEND: "kv" } });
  const noConfirm = await asJson(
    await request(env, "/api/storage/migrate", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(noConfirm.status, 400);

  const noDb = makeEnv({ vars: { STORAGE_BACKEND: "kv", DB: undefined } });
  const missing = await asJson(
    await request(noDb, "/api/storage/migrate", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "migrate" }),
    }),
  );
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /DB/);
});

test("export refuses more entries than restore can take", async () => {
  const env = makeEnv();
  // FakeKV exposes its map; filling it directly keeps the test fast.
  for (let i = 0; i < 20001; i++) {
    env.KV_STORE.map.set(`k${String(i).padStart(5, "0")}`, "v");
  }
  const result = await asJson(
    await request(env, "/api/storage/export?source=kv", { headers: adminHeaders() }),
  );
  assert.equal(result.status, 400);
  assert.equal(result.data.limit, 20000);
  assert.match(result.data.error, /20000/);
});

test("export requires auth and a preview can be taken without a working backend", async () => {
  const kv = new FakeKV({ app_settings: JSON.stringify({ providers: [] }) });
  const env = { KV_STORE: kv, ASSETS: { fetch: async () => new Response("") }, ADMIN_PASSWORD: ADMIN };

  const unauthorized = await request(env, "/api/storage/export?source=kv");
  assert.equal(unauthorized.status, 401);

  const ok = await asJson(
    await request(env, "/api/storage/export?source=kv", { headers: adminHeaders() }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.data.entry_count, 1);
});

test("a ghost key_state row is never forwarded and gets deleted", async () => {
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1" });
  await postSettings(env, [p]);
  const fp = await fingerprintOf(env, p);

  // Simulate "the notebook deleted this key but syncKeyState never ran": the row
  // is the least-recently-used one, so it would be picked first.
  await env.DB.prepare("UPDATE key_state SET last_used_at = ?").bind(Date.now()).run();
  await env.DB.prepare(
    "INSERT INTO key_state (fp, api_key, last_used_at, fail_count, disabled, updated_at) " +
      "VALUES (?, 'sk-deleted', NULL, 0, 0, ?)",
  )
    .bind(fp, Date.now())
    .run();

  const response = await proxy(env, "/proxy/openai/chat/completions");
  assert.equal(response.status, 200);
  assert.equal(captured.length, 1);
  assert.match(captured[0].headers.authorization, /^Bearer k1$/);
  const ghost = await env.DB.prepare(
    "SELECT id FROM key_state WHERE api_key = 'sk-deleted'",
  ).first();
  assert.equal(ghost, null, "幽靈列應該被清掉");
});

test("a provider with no ledger rows at all is seeded on the first request", async () => {
  useUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1\nk2" });
  await postSettings(env, [p]);
  const fp = await fingerprintOf(env, p);
  // Simulate the insert half of syncKeyState failing.
  await env.DB.prepare("DELETE FROM key_state WHERE fp = ?").bind(fp).run();

  const response = await proxy(env, "/proxy/openai/chat/completions");
  assert.equal(response.status, 200);
  assert.equal(captured.length, 1);
  const rows = await env.DB.prepare(
    "SELECT api_key FROM key_state WHERE fp = ? ORDER BY api_key",
  )
    .bind(fp)
    .all();
  assert.deepEqual(
    (rows.results || []).map((r) => r.api_key),
    ["k1", "k2"],
  );
});

test("restore writes a backup back including key_state", async () => {
  const env = makeEnv();
  const p = provider({ alias: "openai", keys: "k1" });
  await postSettings(env, [p]);

  const backup = await asJson(
    await request(env, "/api/storage/export?source=d1", { headers: adminHeaders() }),
  );
  assert.equal(backup.status, 200);

  await env.DB.prepare("UPDATE store SET v = ? WHERE k = ?")
    .bind("{}", "app_settings")
    .run();
  await env.DB.prepare("UPDATE key_state SET disabled = 1, fail_count = 9").run();
  // Row created after the backup was taken; precise rollback must drop it.
  await env.DB.prepare("INSERT INTO store (k, v) VALUES ('results:later', '{}')").run();

  const restored = await asJson(
    await request(env, "/api/storage/restore", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: "restore",
        entries: backup.data.entries,
        key_state: backup.data.key_state,
      }),
    }),
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.data.store_restored, backup.data.entry_count);
  assert.equal(restored.data.key_state_restored, backup.data.key_state.length);

  // Precise rollback: anything created after the backup is gone again.
  assert.equal(restored.data.store_removed, 1);
  assert.equal(restored.data.key_state_removed, 0);
  const leftovers = await env.DB.prepare("SELECT k FROM store WHERE k = 'results:later'").all();
  assert.equal((leftovers.results || []).length, 0, "備份裡沒有的列要被刪掉");

  const settings = await asJson(
    await request(env, "/api/settings", { headers: adminHeaders() }),
  );
  assert.equal(settings.data.settings.providers.length, 1);
  const [key] = await getKeyRows(env, await fingerprintOf(env, p));
  assert.equal(key.disabled, false);
  assert.equal(key.fail_count, 0);
});

// ── AI Gateway (fetch intercepted) ─────────────────────────────────────────

test("gateway mode builds the custom-provider URL and writes ASCII metadata", async () => {
  const env = makeEnv({
    vars: {
      AI_GATEWAY_ACCOUNT_ID: "acct",
      AI_GATEWAY_ID: "gw",
      AI_GATEWAY_TOKEN: "gw-token",
    },
  });
  await postSettings(env, [
    provider({ alias: "openai", keys: "sk-abcdefghij1234", gateway_provider: "openai-main" }),
  ]);

  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), headers: new Headers(init.headers) };
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const result = await proxy(env, "/proxy/openai/chat/completions?q=1");
    assert.equal(result.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(
    seen.url,
    "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-openai-main/chat/completions?q=1",
  );
  assert.equal(seen.headers.get("cf-aig-skip-cache"), "true");
  assert.equal(seen.headers.get("cf-aig-max-attempts"), "1");
  assert.equal(seen.headers.get("cf-aig-authorization"), "Bearer gw-token");
  assert.equal(seen.headers.get("authorization"), "Bearer sk-abcdefghij1234");
  const metadata = seen.headers.get("cf-aig-metadata");
  assert.equal(metadata, JSON.stringify({ key: "sk-a-1234", provider: "openai" }));
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x20-\x7e]*$/.test(metadata));
});
