# AGENTS.md

## Stack

- **Backend:** Cloudflare Pages + `public/_worker.js` (ESM, no TypeScript, no bundler)
- **Frontend:** Vanilla JS (`public/app.js`) + HTML/CSS — no framework, no build step
- **Test runner:** Python (`async_test_keys.py`) via GitHub Actions; uses `aiohttp` only
- **Dev server:** Wrangler (`npm run dev`)

## Commands

| Purpose | Command |
|---|---|
| Start local dev | `npm run dev` → `wrangler pages dev public --kv=KV_STORE` |
| Syntax check JS | `npm run check` → `node --check` on `_worker.js` and `app.js` |
| Run Python tester | `pip install aiohttp` then `python async_test_keys.py` |
| Frontend mock mode | Open `http://127.0.0.1:8788/?mock` |

No linter, formatter, or type checker exists. `node --check` is parse-only.

## Architecture

- `public/_worker.js`: Cloudflare Pages Functions entry point. Routes defined in a flat `ROUTES` object (`"METHOD /path" → handler`). Static files served via `env.ASSETS.fetch(request)`.
- `public/app.js`: Frontend, global scope (not an ES module despite `"type": "module"` in package.json).
- `async_test_keys.py`: Runs in two modes:
  - **Local** (no `PAGES_URL` env): reads `valid_keys/keys.txt` and `models_list/models.txt`, writes `async_test_results.json` locally.
  - **GHA** (`PAGES_URL` + `ADMIN_PASSWORD` set): fetches providers from API, uploads results to KV.

## KV Key Schema

- `app_settings` — full settings JSON
- `results:{fingerprint}` — per-provider test results
- `checkpoint:{fingerprint}` — in-progress checkpoint

KV binding name is exactly `KV_STORE` (must match dashboard and `--kv=KV_STORE` flag).

## Fingerprint (critical — must stay in sync across all three files)

```js
SHA-256( JSON.stringify({ api_base: normalized, provider_type }) )
```

- Key ordering is alphabetical: `api_base` before `provider_type`.
- Strip trailing slashes from `api_base` before hashing.
- Used in `_worker.js`, `app.js`, and `async_test_keys.py` — changing order in any one breaks result lookup.

## Auth

- `Authorization: Bearer <ADMIN_PASSWORD>` header required on all endpoints except `GET /api/results`.
- Local secret stored in `.dev.vars` (gitignored, read automatically by Wrangler).

## CI

- Workflow: `.github/workflows/main.yml` — runs daily at UTC 02:00 and on `workflow_dispatch`.
- Concurrency: `cancel-in-progress: false` — never cancels running jobs.
- Python version: 3.14 (pre-release); script has no 3.14-specific features.
- CI installs only `pip install aiohttp`, not `-r requirements.txt`.
- Required secrets: `PAGES_URL`, `ADMIN_PASSWORD`.
- Post-run: Discord notification via webhook URL fetched from KV `app_settings`.

## Quirks and Gotchas

- **`wrangler.toml` is intentionally absent.** All Cloudflare config is done via the dashboard only (per SPEC.md §13).
- **`DELETE /api/checkpoint`** exists in `_worker.js` but is not in SPEC.md — called by Python after successful results upload to clear the KV checkpoint and prevent the frontend from showing "执行中" after a completed run.
- **Local fallback file paths are hardcoded** as `valid_keys/keys.txt` and `models_list/models.txt`. The per-provider named `.txt` files in those dirs are not used by the Python script.
- **`async_test_results.json`** is gitignored but currently committed with real key data — treat as accidental; do not reference or expand it.
- **`has_thinking_ratio` can be `null`** (not `0.0`) when `sample_count == 0` — frontend must handle null explicitly.
- **Circuit breaker:** HTTP 401/403 → key added to `dead_keys`, all remaining models for that key skipped. HTTP 429/408 → one retry after 2s.
- **Success criterion:** `has_content == True` — response must return non-empty content text, not just thinking tokens.
- **Windows:** `asyncio.WindowsSelectorEventLoopPolicy()` is set automatically when running on win32.
