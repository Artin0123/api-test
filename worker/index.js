/**
 * Cloudflare Worker API Gateway
 *
 * KV bindings required:
 *   KV_STORE  providers_config
 *             tester_checkpoint:{provider_fingerprint}
 *             benchmark_checkpoint:{provider_fingerprint}
 *             latest_tester:{provider_fingerprint}
 *             latest_benchmark:{provider_fingerprint}
 *
 * Secrets required:
 *   MASTER_API_TOKEN
 *   GITHUB_ACTIONS_URL
 */

const ROUTES = {
  "GET /api/env": handleGetEnv,
  "GET /api/config": handleGetConfig,
  "POST /api/config": handlePostConfig,
  "GET /api/checkpoint": handleGetCheckpoint,
  "POST /api/checkpoint": handlePostCheckpoint,
  "DELETE /api/checkpoint": handleDeleteCheckpoint,
  "POST /api/results": handlePostResults,
  "GET /api/results": handleGetResults,
};

const VALID_TYPES = new Set(["openai", "ollama", "gemini"]);
const VALID_MODES = new Set(["thinking", "vision"]);
const VALID_STAGES = new Set(["tester", "benchmark"]);

const MODELS_LIST_ITEM_MAX_LENGTH = 200;
const MODELS_LIST_MAX_ITEMS = 500;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const handler = ROUTES[key];
    if (!handler) {
      return text("Not Found", 404);
    }
    try {
      return await handler(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: "Internal Server Error" }, 500);
    }
  },
};

function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === env.MASTER_API_TOKEN;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(value, status = 200) {
  return new Response(value, { status });
}

function asNonEmptyString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized || fallback;
}

function parseJsonOrNull(raw) {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function maskKey(key) {
  if (!key || key.length <= 6) {
    return "***";
  }
  return key.slice(0, 4) + "***" + key.slice(-2);
}

function providerKey(provider) {
  return `${provider.provider_type}::${provider.mode}::${provider.api_base}`;
}

function looksMaskedKey(value) {
  return typeof value === "string" && value.includes("***");
}

function normalizeApiBase(value) {
  return asNonEmptyString(value).replace(/\/+$/, "");
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

async function handleGetEnv(_request, env) {
  return json({ github_actions_url: env.GITHUB_ACTIONS_URL || null });
}

function normalizeModelsList(modelsList) {
  // 后端只接受 canonical 的 string[]，并在这里做最终把关。
  if (!Array.isArray(modelsList)) {
    return { error: "models_list must be an array" };
  }
  if (modelsList.length > MODELS_LIST_MAX_ITEMS) {
    return {
      error: `models_list has ${modelsList.length} items, max allowed is ${MODELS_LIST_MAX_ITEMS}`,
    };
  }

  const seen = new Set();
  const normalized = [];

  for (let i = 0; i < modelsList.length; i += 1) {
    const item = modelsList[i];
    if (typeof item !== "string") {
      return { error: `models_list[${i}] must be a string` };
    }
    const trimmed = item.trim();
    if (!trimmed) {
      return { error: `models_list[${i}] is empty after trim` };
    }
    if (trimmed.length > MODELS_LIST_ITEM_MAX_LENGTH) {
      return {
        error: `models_list[${i}] exceeds max length ${MODELS_LIST_ITEM_MAX_LENGTH}`,
      };
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }

  normalized.sort((a, b) => a.localeCompare(b));
  return { value: normalized };
}

function normalizeProvider(input, previousProvider) {
  if (!VALID_TYPES.has(input?.provider_type)) {
    return { error: `Invalid provider_type: ${input?.provider_type}` };
  }
  if (!VALID_MODES.has(input?.mode)) {
    return { error: `Invalid mode: ${input?.mode}` };
  }

  const apiBase = normalizeApiBase(input.api_base);
  if (!apiBase) {
    return { error: "api_base required" };
  }

  const modelsListResult = normalizeModelsList(input.models_list);
  if (modelsListResult.error) {
    return { error: modelsListResult.error };
  }

  let apiKey = asNonEmptyString(input.api_key);
  if ((!apiKey || looksMaskedKey(apiKey)) && previousProvider?.api_key) {
    apiKey = previousProvider.api_key;
  }
  if (!apiKey) {
    return { error: `api_key required for provider: ${input.provider_type}::${input.mode}::${apiBase}` };
  }

  return {
    value: {
      provider_type: input.provider_type,
      mode: input.mode,
      api_base: apiBase,
      api_key: apiKey,
      tester_enabled: typeof input.tester_enabled === "boolean" ? input.tester_enabled : true,
      benchmark_enabled:
        typeof input.benchmark_enabled === "boolean" ? input.benchmark_enabled : true,
      models_list: modelsListResult.value,
    },
  };
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildProviderFingerprint(provider) {
  // fingerprint 故意不含 api_key / models_list / tester_enabled / benchmark_enabled。
  const payload = JSON.stringify(
    sortKeysDeep({
      provider_type: provider.provider_type,
      mode: provider.mode,
      api_base: normalizeApiBase(provider.api_base),
    }),
  );
  return sha256Hex(payload);
}

function testerKey(providerFingerprint) {
  return `latest_tester:${providerFingerprint}`;
}

function benchmarkKey(providerFingerprint) {
  return `latest_benchmark:${providerFingerprint}`;
}

function checkpointKey(stage, providerFingerprint) {
  return `${stage}_checkpoint:${providerFingerprint}`;
}

function asFingerprint(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function getStageAndFingerprint(url) {
  const stage = asNonEmptyString(url.searchParams.get("stage"), null);
  const fingerprint = asFingerprint(url.searchParams.get("fingerprint"));

  if (!VALID_STAGES.has(stage)) {
    return { error: "stage must be tester or benchmark" };
  }
  if (!fingerprint) {
    return { error: "fingerprint required" };
  }
  return { stage, fingerprint };
}

async function loadConfig(env) {
  return parseJsonOrNull(await env.KV_STORE.get("providers_config")) || {
    providers: [],
    updated_at: null,
  };
}

async function getConfigProviderMaps(env) {
  const config = await loadConfig(env);
  const byKey = new Map();
  const byFingerprint = new Map();

  for (const provider of config.providers || []) {
    const key = providerKey(provider);
    byKey.set(key, provider);
    const fingerprint = await buildProviderFingerprint(provider);
    byFingerprint.set(fingerprint, provider);
  }

  return { config, byKey, byFingerprint };
}

function getPayloadProviderKeys(payload) {
  const keys = new Set();
  for (const item of payload?.items || []) {
    keys.add(`${item?.provider_type || ""}::${item?.mode || ""}::${item?.api_base || ""}`);
  }
  return keys;
}

function validateSingleProviderPayload(payload, expectedProvider, label) {
  if (payload == null) {
    return null;
  }

  if (!Array.isArray(payload.items)) {
    return `${label}.items must be an array`;
  }

  const expectedKey = providerKey(expectedProvider);
  const providerKeys = Array.from(getPayloadProviderKeys(payload));

  // 新语义规定：一次上传只允许对应一个 provider_fingerprint。
  if (providerKeys.length > 1) {
    return `${label}.items must contain exactly one provider`;
  }
  if (providerKeys.length === 1 && providerKeys[0] !== expectedKey) {
    return `${label}.items provider does not match fingerprint`;
  }

  return null;
}

async function handleGetConfig(request, env, url) {
  if (!requireAuth(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const config = await loadConfig(env);
  const full = url.searchParams.get("full") === "1";

  if (!full) {
    config.providers = (config.providers || []).map((provider) => ({
      ...provider,
      api_key: maskKey(provider.api_key),
    }));
  }

  return json(config);
}

async function handlePostConfig(request, env) {
  if (!requireAuth(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (!Array.isArray(body.providers)) {
    return json({ error: "providers must be an array" }, 400);
  }

  const existingConfig = await loadConfig(env);
  const existingByKey = new Map((existingConfig.providers || []).map((p) => [providerKey(p), p]));
  const nextProviders = [];
  const seenProviderKeys = new Set();

  for (const rawProvider of body.providers) {
    const candidateKey = `${rawProvider?.provider_type || ""}::${rawProvider?.mode || ""}::${normalizeApiBase(rawProvider?.api_base || "")}`;
    const normalized = normalizeProvider(rawProvider, existingByKey.get(candidateKey));
    if (normalized.error) {
      return json({ error: normalized.error }, 400);
    }

    const provider = normalized.value;
    const key = providerKey(provider);
    if (seenProviderKeys.has(key)) {
      return json({ error: "Duplicate provider (provider_type + mode + api_base)" }, 400);
    }

    seenProviderKeys.add(key);
    nextProviders.push(provider);
  }

  const payload = {
    providers: nextProviders,
    updated_at: new Date().toISOString(),
  };

  await env.KV_STORE.put("providers_config", JSON.stringify(payload));
  return json({ ok: true });
}

async function handleGetCheckpoint(request, env, url) {
  if (!requireAuth(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const parsed = getStageAndFingerprint(url);
  if (parsed.error) {
    return json({ error: parsed.error }, 400);
  }

  const raw = await env.KV_STORE.get(checkpointKey(parsed.stage, parsed.fingerprint));
  if (!raw) {
    return json({ exists: false, stage: parsed.stage, fingerprint: parsed.fingerprint });
  }

  const checkpoint = parseJsonOrNull(raw);
  if (!checkpoint) {
    return json({ exists: false, stage: parsed.stage, fingerprint: parsed.fingerprint });
  }

  return json({ exists: true, ...checkpoint });
}

async function handlePostCheckpoint(request, env, url) {
  if (!requireAuth(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const parsed = getStageAndFingerprint(url);
  if (parsed.error) {
    return json({ error: parsed.error }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (!asNonEmptyString(body.run_id)) {
    return json({ error: "run_id required" }, 400);
  }

  const payload = {
    ...body,
    stage: parsed.stage,
    fingerprint: parsed.fingerprint,
    updated_at: new Date().toISOString(),
  };

  await env.KV_STORE.put(checkpointKey(parsed.stage, parsed.fingerprint), JSON.stringify(payload));
  return json({ ok: true });
}

async function handleDeleteCheckpoint(request, env, url) {
  if (!requireAuth(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const parsed = getStageAndFingerprint(url);
  if (parsed.error) {
    return json({ error: parsed.error }, 400);
  }

  await env.KV_STORE.delete(checkpointKey(parsed.stage, parsed.fingerprint));
  return json({ ok: true });
}

async function handlePostResults(request, env) {
  if (!requireAuth(request, env)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const providerFingerprint = asFingerprint(body.provider_fingerprint);
  if (!providerFingerprint) {
    return json({ error: "provider_fingerprint required" }, 400);
  }

  if (body.tester == null && body.benchmark == null) {
    return json({ error: "At least one of tester or benchmark is required" }, 400);
  }

  const { byFingerprint } = await getConfigProviderMaps(env);
  const provider = byFingerprint.get(providerFingerprint);
  if (!provider) {
    return json({ error: "Unknown provider_fingerprint" }, 400);
  }

  // Anti-IDOR：即使 token 正确，也只能写回当前 providers_config 内存在的 provider。
  const testerError = validateSingleProviderPayload(body.tester, provider, "tester");
  if (testerError) {
    return json({ error: testerError }, 400);
  }

  const benchmarkError = validateSingleProviderPayload(body.benchmark, provider, "benchmark");
  if (benchmarkError) {
    return json({ error: benchmarkError }, 400);
  }

  if (body.tester) {
    const runId = asNonEmptyString(body.tester.run_id);
    const startedAt = asNonEmptyString(body.tester.started_at);
    const finishedAt = asNonEmptyString(body.tester.finished_at);
    if (!runId || !startedAt || !finishedAt) {
      return json(
        { error: "tester.run_id, tester.started_at, tester.finished_at are required" },
        400,
      );
    }
  }

  if (body.benchmark && !asNonEmptyString(body.benchmark.run_id)) {
    return json({ error: "benchmark.run_id is required" }, 400);
  }

  const writes = [];
  if (body.tester) {
    writes.push(env.KV_STORE.put(testerKey(providerFingerprint), JSON.stringify(body.tester)));
  }
  if (body.benchmark) {
    writes.push(env.KV_STORE.put(benchmarkKey(providerFingerprint), JSON.stringify(body.benchmark)));
  }

  await Promise.all(writes);
  return json({ ok: true });
}

async function handleGetResults(_request, env, url) {
  const providerFingerprint = asFingerprint(url.searchParams.get("fingerprint"));
  if (!providerFingerprint) {
    return json({ error: "fingerprint required" }, 400);
  }

  const [testerRaw, benchmarkRaw] = await Promise.all([
    env.KV_STORE.get(testerKey(providerFingerprint)),
    env.KV_STORE.get(benchmarkKey(providerFingerprint)),
  ]);

  const tester = parseJsonOrNull(testerRaw);
  const benchmark = parseJsonOrNull(benchmarkRaw);

  if (!tester && !benchmark) {
    return json({
      exists: false,
      provider_fingerprint: providerFingerprint,
    });
  }

  return json({
    exists: true,
    provider_fingerprint: providerFingerprint,
    tester,
    benchmark,
  });
}
