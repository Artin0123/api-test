// src/results.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
async function handleGetResults(request, env, url) {
  // Authenticated: the stored results carry plaintext keys (valid_keys and
  // invalid_records[].api_key), and fp is derived from public inputs
  // (api_base + provider_type), so it is guessable and cannot gate access.
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const fp = getNonEmptyString(url, "fp");
  if (!fp) return json({ error: "fp (fingerprint) required" }, 400);

  const kv = store(env);
  const raw = await kv.get(`results:${fp}`);
  if (!raw) return json({ exists: false });

  const results = parseJsonOrNull(raw);
  if (!results) return json({ exists: false });
  return json({ exists: true, results });
}

async function handlePostResults(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Require provider identity fields to compute fingerprint
  const { provider_type, api_base } = body;
  if (typeof provider_type !== "string" || !provider_type.trim()) {
    return json({ error: "provider_type required" }, 400);
  }
  if (typeof api_base !== "string" || !api_base.trim()) {
    return json({ error: "api_base required" }, 400);
  }

  // Minimal results schema check
  if (
    !Array.isArray(body.valid_keys) ||
    !Array.isArray(body.invalid_records) ||
    !Array.isArray(body.proven_working_models) ||
    !Array.isArray(body.failed_models)
  ) {
    return json({ error: "Invalid results schema" }, 400);
  }

  const fp = await providerFingerprint(provider_type.trim(), api_base.trim());
  const kv = store(env);
  const payload = { ...body, uploaded_at: new Date().toISOString() };
  await kv.put(`results:${fp}`, JSON.stringify(payload));

  // Best-effort: the results are already stored, so a failure here must not make
  // the uploader think the whole run was lost and retry it.
  let synced = { added: 0, removed: 0, updated: 0 };
  try {
    synced = await syncDeadKeysFromResults(
      kv,
      fp,
      api_base.trim(),
      body.valid_keys,
      body.invalid_records,
      payload.uploaded_at,
    );
  } catch (err) {
    console.error("dead key sync failed", err);
  }
  // The daily run is the authority on key health: keys reported as valid get their
  // proxy ledger cleared. Best-effort like the dead-key sync — the results are
  // already stored, so a failure here must not look like a lost run.
  let recovered = 0;
  try {
    recovered = await recoverKeysFromResults(env, fp, body.valid_keys);
  } catch (err) {
    console.error("key_state recovery failed", err);
  }

  return json({
    ok: true,
    fingerprint: fp,
    dead_keys_added: synced.added,
    dead_keys_removed: synced.removed,
    dead_keys_updated: synced.updated,
    keys_recovered: recovered,
  });
}

// ─── /api/run-status ─────────────────────────────────────────────────────────
