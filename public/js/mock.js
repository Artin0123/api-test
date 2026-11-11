// Split from the original app.js; loaded in original order (see index.html).
// ── Mock mode ────────────────────────────────────────────────────────────
// Append ?mock to the URL to load /mock.json instead of hitting the API.
// Example: http://localhost:8788/?mock
const MOCK = new URLSearchParams(location.search).has("mock");

const COPY_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_ICON_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const TRASH_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
const EYE_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_OFF_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
// RFC 7230 token. Must match _HEADER_NAME_RE in async_test_keys.py — aiohttp
// rejects anything else and the whole request would fail.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Lazily-loaded mock data (fetched once, cached here)
let _mockData = null;
async function getMock() {
  if (!_mockData) _mockData = await fetch("/mock.json").then((r) => r.json());
  return _mockData;
}

function cachedProviderFp(p) {
  if (!p || !p.provider_type || !p.api_base) return "";
  return state.fpCache.get(fingerprintPayload(p)) || "";
}

async function ensureProviderFps(providers) {
  for (const p of providers || []) {
    if (!p || !p.provider_type || !p.api_base) continue;
    const payload = fingerprintPayload(p);
    if (!state.fpCache.has(payload)) {
      state.fpCache.set(payload, await sha256(payload));
    }
  }
}

function dkRecordScope(rec) {
  return typeof rec?.fp === "string" && rec.fp.trim()
    ? rec.fp.trim()
    : rec?.provider_host || "";
}

function rebalanceDeadKeyDetails(removed, remaining) {
  for (const gone of removed) {
    if (!gone || !gone.error_detail) continue;
    const scope = dkRecordScope(gone);
    const code = gone.error_code ?? null;
    if (
      remaining.some(
        (r) =>
          r &&
          r.error_detail &&
          dkRecordScope(r) === scope &&
          (r.error_code ?? null) === code,
      )
    ) {
      continue;
    }
    const heir = remaining.find(
      (r) =>
        r &&
        !r.error_detail &&
        dkRecordScope(r) === scope &&
        (r.error_code ?? null) === code,
    );
    if (heir) heir.error_detail = gone.error_detail;
  }
}

function syncMockSettings(settings) {
  if (!MOCK || !_mockData || !settings) return;
  _mockData.settings = settings;
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  if (Array.isArray(_mockData.dead_keys) && _mockData.dead_keys.length) {
    const byFp = new Map();
    const byHost = new Map();
    for (const p of providers) {
      const keys = new Set(splitKeyLines(p?.keys));
      const fp = cachedProviderFp(p);
      if (fp) byFp.set(fp, keys);
      const host = extractHost(p?.api_base);
      if (host) {
        if (!byHost.has(host)) byHost.set(host, new Set());
        for (const k of keys) byHost.get(host).add(k);
      }
    }
    const kept = [];
    const removed = [];
    for (const r of _mockData.dead_keys) {
      if (!r) continue;
      const key = String(r.api_key || "").trim();
      const configured = r.fp
        ? !!key && !!byFp.get(r.fp)?.has(key)
        : !!key && !!byHost.get(r.provider_host)?.has(key);
      if (configured) kept.push(r);
      else removed.push(r);
    }
    if (removed.length) {
      rebalanceDeadKeyDetails(removed, kept);
      _mockData.dead_keys = kept;
      state.deadKeys = kept;
    }
  }
}
