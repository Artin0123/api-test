// src/storage.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
const D1_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS key_state (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "fp TEXT NOT NULL, " +
    "api_key TEXT NOT NULL, " +
    "last_used_at INTEGER, " +
    "fail_count INTEGER NOT NULL DEFAULT 0, " +
    "disabled INTEGER NOT NULL DEFAULT 0, " +
    "updated_at INTEGER NOT NULL, " +
    "UNIQUE (fp, api_key))",
  "CREATE INDEX IF NOT EXISTS idx_key_state_pick " +
    "ON key_state (fp, disabled, last_used_at)",
];

async function ensureSchema(db) {
  for (const sql of D1_SCHEMA) await db.prepare(sql).run();
}

function storageBackendName(env) {
  const raw = env.STORAGE_BACKEND;
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return name || "d1";
}

function hasD1(env) {
  return !!env.DB && typeof env.DB.prepare === "function";
}

function hasKv(env) {
  return !!env.KV_STORE && typeof env.KV_STORE.get === "function";
}

/** Returns a human-readable reason when the configured backend cannot work. */
function storageConfigError(env) {
  const name = storageBackendName(env);
  const raw = typeof env.STORAGE_BACKEND === "string" ? env.STORAGE_BACKEND.trim() : "";
  if (name !== "d1" && name !== "kv") {
    return `STORAGE_BACKEND=${raw} 无效；只能填 d1 或 kv`;
  }
  if (name === "d1" && !hasD1(env)) {
    return raw
      ? "STORAGE_BACKEND=d1 但没有绑定 D1 数据库 DB"
      : "STORAGE_BACKEND=d1（未设定时的预设值）但没有绑定 D1 数据库 DB";
  }
  if (name === "kv" && !hasKv(env)) {
    return "STORAGE_BACKEND=kv 但没有绑定 KV 命名空间 KV_STORE";
  }
  return null;
}

/** KV-shaped adapter over the D1 `store` table: get / put / delete / list.
 *  The rest of this file stays backend-agnostic because these are the only four
 *  operations the existing data model ever uses. */
function d1Store(env) {
  if (!hasD1(env)) {
    const err = new Error(
      "STORAGE_BACKEND=d1 but no D1 database is bound as DB",
    );
    err.code = "CONFIG_ERROR";
    throw err;
  }
  const db = env.DB;
  return {
    async get(k) {
      await ensureSchemaFor(db);
      const row = await db
        .prepare("SELECT v FROM store WHERE k = ?")
        .bind(k)
        .first();
      return row ? row.v : null;
    },
    async put(k, v) {
      await ensureSchemaFor(db);
      await db
        .prepare(
          "INSERT INTO store (k, v) VALUES (?, ?) " +
            "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        )
        .bind(k, v)
        .run();
    },
    async delete(k) {
      await ensureSchemaFor(db);
      await db.prepare("DELETE FROM store WHERE k = ?").bind(k).run();
    },
    async list({ prefix = "", cursor = null, limit = 1000 } = {}) {
      await ensureSchemaFor(db);
      const n = Math.min(Math.max(Number(limit) || 1000, 1), 1000);
      const rows = await db
        .prepare(
          "SELECT k FROM store " +
            "WHERE (? = '' OR substr(k, 1, length(?)) = ?) " +
            "AND (? IS NULL OR k > ?) " +
            "ORDER BY k LIMIT ?",
        )
        .bind(prefix, prefix, prefix, cursor, cursor, n)
        .all();
      const keys = (rows.results || []).map((r) => ({ name: r.k }));
      const complete = keys.length < n;
      return {
        keys,
        list_complete: complete,
        cursor: complete ? null : keys[keys.length - 1].name,
      };
    },
  };
}

function kvStore(env) {
  if (!hasKv(env)) {
    const err = new Error("KV_STORE is not configured");
    err.code = "CONFIG_ERROR";
    throw err;
  }
  return env.KV_STORE;
}

/** The one entry point every handler uses for settings / results / run-status /
 *  dead_keys. The proxy's own key_state table is SQL-only and lives in D1. */
function store(env) {
  return storageBackendName(env) === "d1" ? d1Store(env) : kvStore(env);
}

/** KV `list()` is paginated for real namespaces; migration must walk every page. */
async function listAllEntries(source) {
  const entries = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await source.list({ cursor, limit: 1000 });
    pages++;
    for (const key of page.keys || []) {
      const name = key && key.name;
      if (!name) continue;
      const value = await source.get(name);
      if (value !== null && value !== undefined) {
        entries.push({ k: name, v: value });
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { entries, pages };
}

function parseJsonObject(raw) {
  const parsed = parseJsonOrNull(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : null;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(value, status = 200) {
  return new Response(value, { status });
}

// ─── auth ───────────────────────────────────────────────────────────────────
