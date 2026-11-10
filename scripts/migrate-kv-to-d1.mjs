#!/usr/bin/env node
/**
 * KV → D1 migration with a mandatory pre-migration backup.
 *
 * The backup is written locally *before* the migrate call is sent. If anything
 * after that point fails, the file is the rollback path:
 *
 *   node scripts/migrate-kv-to-d1.mjs --restore backups/kv-....json
 *
 * It talks to the deployed Pages project, so the deployment must have both
 * bindings available:
 *   KV_STORE → the old namespace
 *   DB       → the new D1 database (empty or partially migrated)
 *
 * Safe deploy order (also in README):
 *   1. create D1 and bind DB (keep KV_STORE bound too)
 *   2. set STORAGE_BACKEND=kv and deploy this version
 *   3. npm run migrate            ← backs up, copies KV → D1, verifies
 *   4. set STORAGE_BACKEND=d1 (or remove it) and deploy again
 *
 * Exit codes: 0 success, 1 failure, 2 bad usage / aborted.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const TIMEOUT_MS = 120_000;

function usage() {
  return `用法：
  node scripts/migrate-kv-to-d1.mjs [options]
  node scripts/migrate-kv-to-d1.mjs --restore <backup.json> [options]

选项：
  --base-url <url>      Pages 网址（默认读 PAGES_URL）
  --password <pwd>      管理员密码（默认读 ADMIN_PASSWORD）
  --backup-dir <dir>    备份目录（默认 ./backups）
  --dry-run             只读取并备份，不写入 D1
  --restore <file>      用备份档回复 D1（会先备份当前 D1）
  --allow-empty         KV 没有任何资料时仍继续
  --yes                 不询问确认（CI 用）
  -h, --help            显示本说明
`;
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.PAGES_URL || "",
    password: process.env.ADMIN_PASSWORD || "",
    backupDir: "backups",
    dryRun: false,
    restore: "",
    allowEmpty: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} 缺少参数`);
      i++;
      return v;
    };
    switch (arg) {
      case "--base-url":
        opts.baseUrl = next();
        break;
      case "--password":
        opts.password = next();
        break;
      case "--backup-dir":
        opts.backupDir = next();
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--restore":
        opts.restore = next();
        break;
      case "--allow-empty":
        opts.allowEmpty = true;
        break;
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function request(opts, path, { method = "GET", body } = {}) {
  const url = `${opts.baseUrl}${path}`;
  const headers = { Authorization: `Bearer ${opts.password}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`${method} ${path} 连线失败：${err.message}`);
  }
  const textBody = await response.text();
  let data;
  try {
    data = textBody ? JSON.parse(textBody) : {};
  } catch {
    throw new Error(
      `${method} ${path} 回传非 JSON（HTTP ${response.status}）：${textBody.slice(0, 200)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${method} ${path} 失败（HTTP ${response.status}）：${data.error || textBody.slice(0, 300)}`,
    );
  }
  return data;
}

async function exportSource(opts, source) {
  return request(opts, `/api/storage/export?source=${encodeURIComponent(source)}`);
}

async function writeBackup(opts, kind, payload) {
  const dir = resolve(opts.backupDir);
  await mkdir(dir, { recursive: true });
  const text = `${JSON.stringify(
    {
      ...payload,
      backup: {
        kind,
        created_at: new Date().toISOString(),
        base_url: opts.baseUrl,
        entry_sha256: sha256(JSON.stringify(payload.entries || [])),
      },
    },
    null,
    2,
  )}\n`;
  const file = resolve(dir, `${kind}-${stamp()}.json`);
  await writeFile(file, text, { mode: 0o600 });
  return { file, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

async function confirmOrAbort(opts, message) {
  if (opts.yes) return;
  if (!process.stdin.isTTY) {
    throw new Error(`${message}\n非互动环境，请加 --yes`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} 输入 yes 继续：`)).trim();
    if (answer !== "yes") throw new Error("已取消");
  } finally {
    rl.close();
  }
}

function entryMap(entries) {
  const map = new Map();
  for (const e of entries || []) map.set(e.k, e.v);
  return map;
}

function printBackup(label, backup) {
  console.log(`✓ ${label}`);
  console.log(`  档案：${backup.file}`);
  console.log(`  大小：${backup.bytes} bytes`);
  console.log(`  sha256：${backup.sha256}`);
  console.log("  注意：备份含明文 API Key，请勿提交到版本控制。");
}

function verifyCopy(sourceEntries, targetEntries) {
  const target = entryMap(targetEntries);
  const missing = [];
  const mismatched = [];
  for (const e of sourceEntries) {
    if (!target.has(e.k)) missing.push(e.k);
    else if (target.get(e.k) !== e.v) mismatched.push(e.k);
  }
  return { missing, mismatched };
}

async function runMigrate(opts) {
  console.log(`读取 KV：${opts.baseUrl}`);
  const kv = await exportSource(opts, "kv");
  console.log(
    `KV：${kv.entry_count} 笔资料 / ${kv.kv_pages} 页 / ${kv.bytes} bytes`,
  );

  if (!kv.entry_count && !opts.allowEmpty) {
    throw new Error(
      "KV 没有任何资料（若确定要从空白开始，请加 --allow-empty）",
    );
  }

  const backup = await writeBackup(opts, "kv-backup", kv);
  printBackup("已备份 KV（在任何写入之前完成）", backup);

  if (opts.dryRun) {
    const plan = await request(opts, "/api/storage/migrate", {
      method: "POST",
      body: { confirm: "migrate", dryRun: true },
    });
    console.log(
      `dry-run：将复制 ${plan.entries} 笔到 store，并建立 ${plan.key_state_rows_to_seed} 笔 key_state。`,
    );
    return;
  }

  await confirmOrAbort(
    opts,
    `即将把 ${kv.entry_count} 笔 KV 资料写入 D1（备份已完成）。`,
  );

  console.log("写入 D1…");
  const result = await request(opts, "/api/storage/migrate", {
    method: "POST",
    body: { confirm: "migrate" },
  });
  console.log(
    `D1：新增 ${result.store_inserted} 笔，已存在而略过 ${result.store_skipped_existing} 笔，` +
      `key_state 新建 ${result.key_state_seeded} 笔。`,
  );

  console.log("验证 D1 内容…");
  const d1 = await exportSource(opts, "d1");
  const { missing, mismatched } = verifyCopy(kv.entries, d1.entries);
  if (missing.length || mismatched.length) {
    const report = await writeBackup(opts, "verify-failed", {
      missing,
      mismatched,
      source_count: kv.entry_count,
      target_count: d1.entry_count,
      entries: kv.entries,
    });
    printBackup("验证失败，已保留报告", report);
    throw new Error(
      `验证失败：缺少 ${missing.length} 笔，内容不同 ${mismatched.length} 笔`,
    );
  }
  console.log(
    `✓ 验证通过：KV 的 ${kv.entry_count} 笔资料都能在 D1 逐字找到（D1 共 ${d1.entry_count} 笔）。`,
  );

  const report = await writeBackup(opts, "migrate-report", {
    source_count: kv.entry_count,
    target_count: d1.entry_count,
    key_state_count: d1.key_state_count,
    backup_file: backup.file,
    entries: [],
  });
  console.log(`  报告：${report.file}`);
  console.log("完成。接下来把 STORAGE_BACKEND 设为 d1（或移除）并重新部署。");
}

async function runRestore(opts) {
  const file = resolve(opts.restore);
  console.log(`读取备份：${file}`);
  const parsed = JSON.parse(await readFile(file, "utf8"));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : null;
  if (!entries) throw new Error("备份档没有 entries 阵列，无法回复");
  if (!entries.length) throw new Error("备份档没有资料，拒绝回复");
  if (parsed.backup && parsed.backup.entry_sha256) {
    const actual = sha256(JSON.stringify(entries));
    if (actual !== parsed.backup.entry_sha256) {
      throw new Error("备份档内容与记录不符（档案可能被修改或损毁）");
    }
    console.log("✓ 备份档完整性检查通过");
  }
  const keyState = Array.isArray(parsed.key_state) ? parsed.key_state : [];
  console.log(
    `备份内容：${entries.length} 笔 store，${keyState.length} 笔 key_state。`,
  );

  // Restoring is destructive in the same way migrating is: snapshot what is
  // currently in D1 first, so a wrong file is itself reversible.
  const current = await exportSource(opts, "d1");
  const safety = await writeBackup(opts, "d1-pre-restore", current);
  printBackup("已备份当前 D1", safety);

  await confirmOrAbort(opts, `即将用备份回复 ${entries.length} 笔资料。`);
  console.log("回复 D1…");
  const result = await request(opts, "/api/storage/restore", {
    method: "POST",
    body: { confirm: "restore", entries, key_state: keyState },
  });
  console.log(
    `✓ 已回复 ${result.store_restored} 笔 store、${result.key_state_restored} 笔 key_state。`,
  );

  const after = await exportSource(opts, "d1");
  const afterMap = entryMap(after.entries);
  const missing = entries.filter((e) => afterMap.get(e.k) !== e.v).map((e) => e.k);
  if (missing.length) {
    throw new Error(`回复后仍有 ${missing.length} 笔内容不一致：${missing.slice(0, 5).join(", ")}`);
  }
  console.log("✓ 验证通过：备份中的每一笔都已就位。");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exit(2);
  }
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (!opts.baseUrl) {
    console.error("缺少 --base-url（或环境变数 PAGES_URL）");
    console.error(usage());
    process.exit(2);
  }
  if (!opts.password) {
    console.error("缺少 --password（或环境变数 ADMIN_PASSWORD）");
    console.error(usage());
    process.exit(2);
  }
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, "");

  try {
    if (opts.restore) await runRestore(opts);
    else await runMigrate(opts);
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 2;
  }
}

main();
