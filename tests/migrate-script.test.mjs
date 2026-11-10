/**
 * The migration script's safety contract: the local backup is written before
 * the migrate call, and a failed backup aborts without writing anything.
 *
 * A tiny mock of the Pages endpoints stands in for the deployment, so no real
 * KV, D1 or key is involved.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/migrate-kv-to-d1.mjs");

function runScript(args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function startServer(state) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const url = new URL(req.url, "http://local");
      const send = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };

      if (url.pathname === "/api/storage/export") {
        const source = url.searchParams.get("source");
        state.calls.push(`export:${source}`);
        if (state.failExport) return send(500, { error: "export boom" });
        const entries = source === "kv" ? state.kv : state.d1;
        return send(200, {
          ok: true,
          source,
          entries,
          key_state: state.keyState,
          entry_count: entries.length,
          key_state_count: state.keyState.length,
          kv_pages: 2,
          bytes: 10,
        });
      }

      if (url.pathname === "/api/storage/migrate") {
        state.calls.push(`migrate:${body.dryRun ? "dry" : "real"}`);
        if (!body.dryRun) state.d1 = state.kv.map((e) => ({ ...e }));
        return send(200, {
          ok: true,
          store_inserted: state.kv.length,
          store_skipped_existing: 0,
          key_state_seeded: state.keyState.length,
          entries: state.kv.length,
          kv_pages: 2,
          providers: 1,
          keys: 1,
        });
      }

      if (url.pathname === "/api/storage/restore") {
        state.calls.push("restore");
        state.d1 = body.entries.map((e) => ({ ...e }));
        return send(200, {
          ok: true,
          store_restored: body.entries.length,
          key_state_restored: (body.key_state || []).length,
        });
      }

      send(404, { error: "not found" });
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise(server));
  });
}

async function withServer(state, fn) {
  const server = await startServer(state);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    return await fn(base);
  } finally {
    server.close();
  }
}

const KV = [
  { k: "app_settings", v: JSON.stringify({ providers: [{ api_base: "https://x/v1", provider_type: "openai", keys: "k1" }] }) },
  { k: "results:abc", v: JSON.stringify({ ok: true }) },
];

test("migration writes the backup first, then migrates and verifies", async () => {
  const state = {
    kv: KV,
    d1: [],
    keyState: [{ id: 1, fp: "f", api_key: "k1", last_used_at: null, fail_count: 0, disabled: 0, updated_at: 1 }],
    calls: [],
  };
  const backupDir = await mkdtemp(join(tmpdir(), "api-test-migrate-"));

  await withServer(state, async (base) => {
    const result = await runScript(
      ["--base-url", base, "--password", "pw", "--backup-dir", backupDir, "--yes"],
      {},
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /已备份 KV/);
    assert.match(result.stdout, /验证通过/);
  });

  // The backup must have been written before the migrate call was sent.
  assert.deepEqual(state.calls.slice(0, 2), ["export:kv", "migrate:real"]);

  const files = await readdir(backupDir);
  const backupFile = files.find((f) => f.startsWith("kv-backup-"));
  assert.ok(backupFile, `backup file missing: ${files.join(", ")}`);
  const backup = JSON.parse(await readFile(join(backupDir, backupFile), "utf8"));
  assert.deepEqual(backup.entries, KV);
  assert.equal(backup.backup.kind, "kv-backup");
  assert.ok(files.some((f) => f.startsWith("migrate-report-")));
});

test("a failed backup aborts before any migrate request", async () => {
  const state = { kv: KV, d1: [], keyState: [], calls: [], failExport: true };
  const backupDir = await mkdtemp(join(tmpdir(), "api-test-migrate-"));

  await withServer(state, async (base) => {
    const result = await runScript([
      "--base-url",
      base,
      "--password",
      "pw",
      "--backup-dir",
      backupDir,
      "--yes",
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /备份|失败|boom/);
  });

  assert.deepEqual(state.calls, ["export:kv"]);
  const files = await readdir(backupDir);
  assert.equal(files.length, 0);
});

test("an empty KV requires --allow-empty", async () => {
  const state = { kv: [], d1: [], keyState: [], calls: [] };
  const backupDir = await mkdtemp(join(tmpdir(), "api-test-migrate-"));
  await withServer(state, async (base) => {
    const result = await runScript([
      "--base-url",
      base,
      "--password",
      "pw",
      "--backup-dir",
      backupDir,
      "--yes",
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /allow-empty/);
  });
  assert.ok(!state.calls.includes("migrate:real"));
});

test("restore snapshots the current D1 before writing the backup back", async () => {  const state = {
    kv: [],
    d1: [{ k: "app_settings", v: '{"drifted":true}' }],
    keyState: [],
    calls: [],
  };
  const backupDir = await mkdtemp(join(tmpdir(), "api-test-migrate-"));
  const file = join(backupDir, "manual.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    file,
    JSON.stringify({ entries: KV, key_state: [] }),
    "utf8",
  );

  await withServer(state, async (base) => {
    const result = await runScript([
      "--base-url",
      base,
      "--password",
      "pw",
      "--backup-dir",
      backupDir,
      "--restore",
      file,
      "--yes",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /已备份当前 D1/);
    assert.match(result.stdout, /已回复/);
  });

  assert.deepEqual(state.calls.slice(0, 2), ["export:d1", "restore"]);
  const files = await readdir(backupDir);
  assert.ok(files.some((f) => f.startsWith("d1-pre-restore-")));
  assert.deepEqual(state.d1, KV);
});

test("restore refuses a tampered backup before touching D1", async () => {
  const state = { kv: [], d1: KV, keyState: [], calls: [] };
  const backupDir = await mkdtemp(join(tmpdir(), "api-test-migrate-"));
  const file = join(backupDir, "tampered.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    file,
    JSON.stringify({
      entries: KV,
      backup: { entry_sha256: "0".repeat(64) },
    }),
    "utf8",
  );

  await withServer(state, async (base) => {
    const result = await runScript([
      "--base-url",
      base,
      "--password",
      "pw",
      "--backup-dir",
      backupDir,
      "--restore",
      file,
      "--yes",
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /不符/);
  });
  assert.deepEqual(state.calls, []);
  assert.deepEqual(state.d1, KV);
});
