// src/settings.js — verbatim section of public/_worker.js (assembled back by scripts/build-worker.mjs; order matters).
const SETTINGS_KEY = "app_settings";
const PROXY_TEST_MODELS_KEY = "proxy_test_models";

const DEFAULT_SETTINGS = {
  providers: [],
  github_url: "",
  discord_webhook_url: "",
  proxy_password: "",
  proxy_fail_threshold: 3,
  proxy_max_retries: 3,
  proxy_upstream_timeout_ms: 120000,
  version: 0,
};

// Safely below Cloudflare D1's 100 bound-parameter limit per statement even
// when a query binds 1–2 leading scalar values alongside an `IN (...)` list.
const D1_IN_CHUNK_SIZE = 90;

const PROXY_INT_LIMITS = {
  proxy_fail_threshold: { min: 1, max: null, fallback: 3 },
  proxy_max_retries: { min: 0, max: 3, fallback: 3 },
  proxy_upstream_timeout_ms: { min: 1000, max: 600000, fallback: 120000 },
};

function isHttpUrl(rawUrl) {
  return /^https?:\/\/\S+/i.test(rawUrl);
}

function isLoopbackHttpHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
}

function isPrivateOrReservedIpLiteral(hostname) {
  const raw = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!raw || isLoopbackHttpHost(raw)) return false;

  // IPv4 literal check
  const ipv4Match = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b, c, d] = ipv4Match.slice(1).map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  // IPv6 literal check
  if (raw.includes(":")) {
    if (raw === "::" || raw.startsWith("::ffff:")) return true;
    if (/^(?:fc|fd)[0-9a-f]{0,2}:/.test(raw)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(raw)) return true;
    if (raw.startsWith("ff")) return true;
  }
  return false;
}

function hasPathTraversalSegment(rawPath) {
  const s = String(rawPath || "");
  return /(?:^|[\\/])\.\.(?:[\\/]|$)|%(?:25)*2e|%(?:25)*5c/i.test(s);
}

function validateApiBaseUrl(rawBase, selfHost = "") {
  const trimmed = typeof rawBase === "string" ? rawBase.trim() : "";
  if (!trimmed) return "api_base 不能为空";
  if (hasPathTraversalSegment(trimmed)) {
    return "api_base 不能包含路径穿越片段 (..)";
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `api_base "${trimmed}" 不是有效的 URL`;
  }
  if (parsed.username || parsed.password) {
    return "api_base 不能包含帐号或密码 (userinfo)";
  }
  if (parsed.search) {
    return "api_base 不能包含查询参数 (?query)";
  }
  if (parsed.hash) {
    return "api_base 不能包含片段 (#fragment)";
  }
  if (
    selfHost &&
    parsed.host &&
    parsed.host.toLowerCase() === String(selfHost).toLowerCase()
  ) {
    return "api_base 不能指向当前代理站点自身";
  }
  if (isPrivateOrReservedIpLiteral(parsed.hostname)) {
    return "api_base 不能指向内网或保留 IP 位址";
  }
  if (parsed.protocol === "https:") {
    return parsed.hostname ? null : "api_base 缺少有效域名";
  }
  if (parsed.protocol === "http:" && isLoopbackHttpHost(parsed.hostname)) {
    return null;
  }
  return "api_base 必须使用 https://（本机测试仅允许 http://127.0.0.1 或 http://localhost）";
}

function validateProviderApiBases(providers, selfHost = "") {
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p || typeof p !== "object") continue;
    const err = validateApiBaseUrl(p.api_base, selfHost);
    if (err) return `providers[${i}].${err}`;
  }
  return null;
}

function clampOrDefaultInt(value, spec) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < spec.min) return spec.fallback;
  if (spec.max !== null && n > spec.max) return spec.max;
  return n;
}

function parseIntSetting(rawVal, existingVal, field) {
  const spec = PROXY_INT_LIMITS[field];
  if (rawVal === undefined) {
    return { value: clampOrDefaultInt(existingVal, spec), error: null };
  }
  if (rawVal === "" || rawVal === null) {
    return { value: spec.fallback, error: null };
  }
  const n = typeof rawVal === "string" ? Number(rawVal.trim()) : Number(rawVal);
  if (!Number.isInteger(n) || n < spec.min || (spec.max !== null && n > spec.max)) {
    const range =
      spec.max === null ? `>= ${spec.min}` : `${spec.min} ~ ${spec.max}`;
    return { value: null, error: `${field} 必须是 ${range} 的整数` };
  }
  return { value: n, error: null };
}

function withSettingsDefaults(raw) {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    proxy_password: typeof s.proxy_password === "string" ? s.proxy_password : "",
    proxy_fail_threshold: clampOrDefaultInt(
      s.proxy_fail_threshold,
      PROXY_INT_LIMITS.proxy_fail_threshold,
    ),
    proxy_max_retries: clampOrDefaultInt(
      s.proxy_max_retries,
      PROXY_INT_LIMITS.proxy_max_retries,
    ),
    proxy_upstream_timeout_ms: clampOrDefaultInt(
      s.proxy_upstream_timeout_ms,
      PROXY_INT_LIMITS.proxy_upstream_timeout_ms,
    ),
  };
}

function settingsVersion(settings) {
  return typeof settings.version === "number" ? settings.version : 0;
}

// `/proxy/{alias}` is matched as the first path segment, so an alias has to be a
// single lowercase segment. Validated at save time: a bad alias must fail with a
// 400 here, not turn into a mystery 404 at forward time.
const PROXY_ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Split trimmed non-empty items while preserving first occurrence order. */
function splitUniqueDelimited(raw, splitRe) {
  if (typeof raw !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const item of raw.split(splitRe)) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Normalize comma/newline-separated model names into canonical deduplicated CSV form. */
function normalizeModelsString(raw) {
  return splitUniqueDelimited(raw, /[,\r\n]+/).join(",");
}

/** Normalize newline-separated API keys into canonical deduplicated LF form. */
function normalizeKeysString(raw) {
  return splitUniqueDelimited(raw, "\n").join("\n");
}

/** Normalize keys, alias, api_base, test_path, and models formatting for storage. */
function normalizeProviderForStorage(p) {
  if (!p || typeof p !== "object") return p;
  const out = { ...p };
  delete out.gateway_provider;
  if (typeof p.api_base === "string") {
    out.api_base = p.api_base.trim().replace(/\/+$/, "");
  }
  if (typeof p.alias === "string") {
    const alias = p.alias.trim();
    if (alias) out.alias = alias;
    else delete out.alias;
  }
  if (out.provider_type === "google") {
    delete out.test_path;
  } else if (typeof p.test_path === "string") {
    const tp = p.test_path.trim();
    if (tp) out.test_path = tp.startsWith("/") ? tp : "/" + tp;
    else delete out.test_path;
  }
  if (typeof p.keys === "string") {
    out.keys = normalizeKeysString(p.keys);
  }
  if (typeof p.models === "string") {
    out.models = normalizeModelsString(p.models);
  }
  return out;
}

async function providerFpEntries(providers) {
  const entries = [];
  for (const p of providers || []) {
    if (!p || typeof p !== "object") continue;
    const providerType =
      typeof p.provider_type === "string" ? p.provider_type.trim() : "";
    const apiBase = typeof p.api_base === "string" ? p.api_base.trim() : "";
    if (!providerType || !apiBase) continue;
    entries.push({
      provider: p,
      providerType,
      apiBase,
      fp: await providerFingerprint(providerType, apiBase),
    });
  }
  return entries;
}

function validateProviderDuplicates(providers) {
  const seen = new Map();
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p || typeof p !== "object") continue;
    const type =
      typeof p.provider_type === "string" ? p.provider_type.trim() : "";
    const base =
      typeof p.api_base === "string"
        ? p.api_base.trim().replace(/\/+$/, "")
        : "";
    if (!type || !base) continue;
    const key = `${type}\u0000${base}`;
    if (seen.has(key)) {
      return `providers[${i}] 与 providers[${seen.get(key)}] 的 provider_type (${type}) 与 api_base 重复`;
    }
    seen.set(key, i);
  }
  return null;
}

const PROVIDER_TYPES = new Set(["openai", "google", "anthropic"]);

function validateProviderTypes(providers) {
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p || typeof p !== "object") continue;
    const type = typeof p.provider_type === "string" ? p.provider_type.trim() : "";
    if (!type) return `providers[${i}].provider_type 不能为空`;
    if (!PROVIDER_TYPES.has(type)) {
      return `providers[${i}].provider_type "${type}" 不支援；只能是 ${[...PROVIDER_TYPES].join(" / ")}`;
    }
  }
  return null;
}

/** `proxy_test_models` is a { fingerprint: model } map kept in its own store key
 *  (`proxy_test_models`) so saving the probe model never bumps `app_settings.version`. */
function normalizeProxyTestModels(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [fp, model] of Object.entries(raw)) {
    if (typeof fp !== "string" || !fp || typeof model !== "string") continue;
    const trimmed = model.trim();
    if (trimmed) out[fp] = trimmed;
  }
  return out;
}

const MAX_PROVIDER_KEYS = 999;

function validateProviderKeys(providers) {
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p || typeof p !== "object") continue;
    const keys = providerKeys(p);
    if (keys.length > MAX_PROVIDER_KEYS) {
      return `providers[${i}] 最多只能保存 ${MAX_PROVIDER_KEYS} 个 API Key（当前 ${keys.length} 个）`;
    }
    if (!keys.length) {
      return `providers[${i}] 没有任何 API Key；至少要保留一把，要停用请把 enabled 设为 false`;
    }
  }
  return null;
}

function validateProviderModels(providers) {
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p || typeof p !== "object") continue;
    if (typeof p.models !== "string" || !providerModels(p).length) {
      return `providers[${i}] 没有任何模型；至少要保留一个模型`;
    }
    if (/[\r\n]/.test(p.models)) {
      return `providers[${i}].models 格式不正确：请以逗号分隔`;
    }
  }
  return null;
}

function validateProviderAliases(providers) {
  const seen = new Set();
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p || typeof p !== "object") continue;
    const alias = p.alias;
    if (alias === undefined || alias === null || alias === "") continue;
    if (typeof alias !== "string") {
      return `providers[${i}].alias 必须是字符串`;
    }
    if (!PROXY_ALIAS_RE.test(alias)) {
      return `providers[${i}].alias "${alias}" 格式不正确：只能用小写英文、数字与连字号，且不超过 64 个字元`;
    }
    if (seen.has(alias)) {
      return `providers[${i}].alias "${alias}" 与其他服务商重复`;
    }
    seen.add(alias);
  }
  return null;
}

function validateProviderTestPaths(providers) {
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (!p || typeof p !== "object") continue;
    if (p.provider_type === "google") continue;
    const tp = p.test_path;
    if (typeof tp !== "string" || !tp.trim()) {
      return "providers[" + i + "].test_path 不能为空";
    }
    if (
      /\s/.test(tp) ||
      tp.includes("://") ||
      tp.includes("?") ||
      tp.includes("#") ||
      hasPathTraversalSegment(tp)
    ) {
      return "providers[" + i + "].test_path 格式不正确：只能填不含查询参数或 .. 的相对路径";
    }
  }
  return null;
}
