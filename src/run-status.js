// src/run-status.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
const RUN_STATUS_KEY = "test_run_status";
const RUN_STATUS_TTL_MS = 90 * 60 * 1000;

async function handleGetRunStatus(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const kv = store(env);
  const raw = await kv.get(RUN_STATUS_KEY);
  if (raw === null || raw === undefined) {
    return json({ ok: true, running: false, started_at: null });
  }
  const parsed = parseJsonObject(raw);
  const startedAt =
    parsed && typeof parsed.started_at === "string"
      ? parsed.started_at.trim()
      : "";
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  if (!startedAt || !Number.isFinite(startedMs)) {
    await kv.delete(RUN_STATUS_KEY);
    return json({ ok: true, running: false, started_at: null });
  }
  if (Date.now() - startedMs > RUN_STATUS_TTL_MS) {
    await kv.delete(RUN_STATUS_KEY);
    return json({ ok: true, running: false, started_at: null, expired: true });
  }
  return json({ ok: true, running: true, started_at: startedAt });
}

async function handlePostRunStatus(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  let body = {};
  try {
    const raw = (await request.text()).trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed;
      } else {
        return json({ error: "Invalid JSON body" }, 400);
      }
    }
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const candidate =
    typeof body.started_at === "string" ? body.started_at.trim() : "";
  const startedAt =
    candidate && Number.isFinite(Date.parse(candidate))
      ? candidate
      : new Date().toISOString();

  const kv = store(env);
  await kv.put(RUN_STATUS_KEY, JSON.stringify({ started_at: startedAt }));
  return json({ ok: true, running: true, started_at: startedAt });
}

async function handleDeleteRunStatus(request, env) {
  if (!(await requireAuth(request, env)))
    return json({ error: "Unauthorized" }, 401);

  const kv = store(env);
  await kv.delete(RUN_STATUS_KEY);
  return json({ ok: true, running: false });
}

// ─── /api/dead-keys ──────────────────────────────────────────────────────────
