// src/dead-keys.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
const DEAD_KEYS_KEY = "dead_keys";

async function readDeadKeys(kv) {
  const parsed = parseJsonOrNull(await kv.get(DEAD_KEYS_KEY));
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeErrorCode(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** error_detail is deduped per fp + error_code — stored only once per group. */
function deadKeyScope(rec) {
  return typeof rec?.fp === "string" ? rec.fp.trim() : "";
}

function sameDedupGroup(a, b) {
  return (
    deadKeyScope(a) === deadKeyScope(b) &&
    normalizeErrorCode(a?.error_code) === normalizeErrorCode(b?.error_code)
  );
}

/** Hand error_detail from removed records to a remaining sibling in the same
 *  host+code group. Dedup stores the message on one row only, so deleting that
 *  holder without this step would blank the group's 📋 for everyone left. */
function rebalanceErrorDetail(removed, remaining) {
  for (const gone of removed) {
    if (!gone || !gone.error_detail) continue;
    if (remaining.some((r) => r && r.error_detail && sameDedupGroup(r, gone))) {
      continue;
    }
    const heir = remaining.find(
      (r) => r && !r.error_detail && sameDedupGroup(r, gone),
    );
    if (heir) heir.error_detail = gone.error_detail;
  }
}

/** error_detail must be a flat-ish key-value object; anything else is dropped. */
function normalizeErrorDetail(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return Object.keys(out).length ? out : null;
}

/** Flatten a result record into the stored error_detail shape. Prefer the
 *  structured object; fall back to {message: error_reason} so 📋 still has
 *  something when the provider returned no body. */
function extractRecordDetail(rec) {
  if (!rec) return null;
  const detail = normalizeErrorDetail(rec.error_detail);
  if (detail) return detail;
  if (rec.error_reason) return { message: String(rec.error_reason) };
  return null;
}

/** Compare normalized error_detail objects by sorted keys so insertion order
 *  cannot trigger a false "updated" write. */
function areErrorDetailsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (k !== keysB[i]) return false;
    if (String(a[k]) !== String(b[k])) return false;
  }
  return true;
}

/** Build lookup sets of configured keys keyed by card fingerprint `fp`. */
async function configuredKeysIndex(providers) {
  const byFp = new Map();
  for (const { provider: p, fp } of await providerFpEntries(providers)) {
    const keys = providerKeys(p);
    let fpSet = byFp.get(fp);
    if (!fpSet) {
      fpSet = new Set();
      byFp.set(fp, fpSet);
    }
    for (const k of keys) fpSet.add(k);
  }
  return byFp;
}

/** Drop dead_keys entries whose card (fp) was deleted or whose key was removed
 *  from 来源设定, returning null if nothing changed so saves avoid empty writes. */
async function pruneDeadKeysForSettings(rawDeadKeys, providers) {
  const list = parseJsonOrNull(rawDeadKeys);
  if (!Array.isArray(list) || !list.length) return null;
  const byFp = await configuredKeysIndex(providers);
  const kept = [];
  const removed = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const key = typeof r.api_key === "string" ? r.api_key.trim() : "";
    const recFp = typeof r.fp === "string" ? r.fp.trim() : "";
    const configured = !!(recFp && key && byFp.get(recFp)?.has(key));
    if (configured) kept.push(r);
    else removed.push(r);
  }
  if (!removed.length) return null;
  rebalanceErrorDetail(removed, kept);
  return kept;
}

/** Reconcile dead_keys for one provider `fp` against a fresh test upload and
 *  来源设定. Recovered keys and keys no longer configured on this card are
 *  dropped; error_code/error_detail stay deduplicated within `(fp, code)`. */
async function syncDeadKeysFromResults(
  kv,
  fp,
  api_base,
  validKeys,
  invalidRecords,
  uploadedAt,
) {
  const none = { added: 0, removed: 0, updated: 0 };

  let provider_host;
  try {
    provider_host = new URL(api_base).hostname;
  } catch {
    return none;
  }
  if (!provider_host) return none;

  const [rawDeadKeys, rawSettings] = await Promise.all([
    kv.get(DEAD_KEYS_KEY),
    kv.get(SETTINGS_KEY),
  ]);
  let list = parseJsonOrNull(rawDeadKeys);
  if (!Array.isArray(list)) list = [];

  // KV/store miss or corrupt JSON must not look like "source is empty" — that
  // would wipe every dead key on this provider.
  const settingsParsed = parseJsonOrNull(rawSettings);
  const settingsAvailable =
    !!rawSettings &&
    !!settingsParsed &&
    typeof settingsParsed === "object" &&
    !Array.isArray(settingsParsed);
  const byFp = settingsAvailable
    ? await configuredKeysIndex(settingsParsed.providers)
    : new Map();
  const configuredKeysForFp = byFp.get(fp) || new Set();

  const recovered = new Set(
    (Array.isArray(validKeys) ? validKeys : [])
      .filter((k) => typeof k === "string")
      .map((k) => k.trim())
      .filter(Boolean),
  );

  const invList = Array.isArray(invalidRecords) ? invalidRecords : [];
  const invMap = new Map();
  // First non-empty detail per error_code from this upload. Python only stores
  // error_detail on one key per (code, normalized message), which is often not
  // the same key as the store group's current holder.
  const newGroupDetails = new Map();

  for (const rec of invList) {
    if (!rec || typeof rec.api_key !== "string" || !rec.api_key.trim()) continue;
    const key = rec.api_key.trim();
    invMap.set(key, rec);

    const code = normalizeErrorCode(rec.error_code);
    if (!newGroupDetails.has(code)) {
      const d = extractRecordDetail(rec);
      if (d) newGroupDetails.set(code, d);
    }
  }

  const keep = [];
  const dropped = [];
  for (const r of list) {
    if (!r) continue;
    const key = typeof r.api_key === "string" ? r.api_key.trim() : "";
    const recFp = typeof r.fp === "string" ? r.fp.trim() : "";
    if (recFp !== fp) {
      keep.push(r);
      continue;
    }
    const isRecovered = key && recovered.has(key);
    const isRemovedFromSettings =
      settingsAvailable && (!key || !configuredKeysForFp.has(key));
    if (isRecovered || isRemovedFromSettings) dropped.push(r);
    else keep.push(r);
  }
  if (dropped.length) rebalanceErrorDetail(dropped, keep);

  let codeUpdates = 0;
  let detailUpdates = 0;

  // Stage 1: migrate error_code per key within this provider `fp`.
  for (let i = 0; i < keep.length; i++) {
    const r = keep[i];
    if (!r || r.fp !== fp) continue;

    const recKey = typeof r.api_key === "string" ? r.api_key.trim() : "";
    if (!recKey) continue;
    const newRec = invMap.get(recKey);
    if (!newRec) continue;

    const nextCode = normalizeErrorCode(newRec.error_code);
    if (normalizeErrorCode(r.error_code) === nextCode) continue;

    if (r.error_detail) {
      const heir = keep.find(
        (other, oi) =>
          oi !== i && other && !other.error_detail && sameDedupGroup(other, r),
      );
      if (heir) heir.error_detail = r.error_detail;
    }
    r.error_code = nextCode;
    r.error_detail = null;
    codeUpdates++;
  }

  // Stage 2: one holder per (fp, code); refresh from this upload's detail.
  const fpCodes = new Set();
  for (const r of keep) {
    if (r && r.fp === fp) {
      fpCodes.add(normalizeErrorCode(r.error_code));
    }
  }

  for (const code of fpCodes) {
    const siblings = keep.filter(
      (r) => r && r.fp === fp && normalizeErrorCode(r.error_code) === code,
    );
    if (!siblings.length) continue;

    const holder = siblings.find((s) => s.error_detail) || siblings[0];
    for (const s of siblings) {
      if (s !== holder && s.error_detail) s.error_detail = null;
    }

    if (newGroupDetails.has(code)) {
      const fresh = newGroupDetails.get(code);
      if (!areErrorDetailsEqual(holder.error_detail, fresh)) {
        holder.error_detail = fresh;
        detailUpdates++;
      }
    }
  }

  const listNext = keep;
  const removed = dropped.length;
  let added = 0;

  const expired_at = `${String(uploadedAt).slice(0, 10)}T00:00:00.000Z`;
  const known = new Set();
  for (const r of listNext) {
    if (r && r.fp === fp && typeof r.api_key === "string" && r.api_key.trim()) {
      known.add(r.api_key.trim());
    }
  }

  for (const rec of invList) {
    if (!rec || typeof rec.api_key !== "string" || !rec.api_key.trim()) continue;
    const api_key = rec.api_key.trim();
    if (known.has(api_key)) continue;
    if (settingsAvailable && !configuredKeysForFp.has(api_key)) continue;

    const error_code = normalizeErrorCode(rec.error_code);
    const hasHolder = listNext.some(
      (r) => r && r.error_detail && sameDedupGroup(r, { fp, provider_host, error_code }),
    );
    const error_detail = hasHolder
      ? null
      : newGroupDetails.get(error_code) || extractRecordDetail(rec);

    listNext.push({
      id: crypto.randomUUID(),
      fp,
      provider_host,
      api_key,
      expired_at,
      error_code,
      error_detail,
      created_at: uploadedAt,
    });
    known.add(api_key);
    added++;
  }

  const updated = codeUpdates + detailUpdates;
  if (added || removed || updated) {
    await kv.put(DEAD_KEYS_KEY, JSON.stringify(listNext));
  }
  return { added, removed, updated };
}

async function handleGetDeadKeys(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);
  const kv = store(env);
  return json({ ok: true, dead_keys: await readDeadKeys(kv) });
}

async function collectDeleteIds(request, url) {
  const ids = [];
  const seen = new Set();
  const add = (v) => {
    if (typeof v !== "string") return;
    const t = v.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    ids.push(t);
  };
  for (const v of url.searchParams.getAll("id")) add(v);

  let text = "";
  try {
    text = (await request.text()).trim();
  } catch {
    // Empty or unreadable body
  }

  if (text) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ids, invalidJson: true };
    }
    if (Array.isArray(body?.ids)) body.ids.forEach(add);
    else if (typeof body?.id === "string") add(body.id);
  }

  return { ids, invalidJson: false };
}

async function handleDeleteDeadKey(request, env, url) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const { ids, invalidJson } = await collectDeleteIds(request, url);
  if (invalidJson) return json({ error: "Invalid JSON" }, 400);
  if (!ids.length) return json({ error: "id required" }, 400);

  const kv = store(env);
  const list = await readDeadKeys(kv);
  const idSet = new Set(ids);
  const removed = [];
  const next = [];
  for (const r of list) {
    if (r && idSet.has(r.id)) removed.push(r);
    else next.push(r);
  }
  if (!removed.length) return json({ error: "Not Found" }, 404);

  // dead_keys is one KV value, so N ids still cost 1 get + 1 put — the whole
  // point of accepting a list instead of N single-id DELETEs.
  rebalanceErrorDetail(removed, next);

  await kv.put(DEAD_KEYS_KEY, JSON.stringify(next));
  return json({ ok: true, deleted: removed.length, dead_keys: next });
}
