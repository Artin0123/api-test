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
- `dead_keys` — array of manually curated dead key records (`GET/POST/PUT/DELETE /api/dead-keys`, `id` via `crypto.randomUUID()`)

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
- Python version: 3.14; script has no 3.14-specific features.
- CI installs only `pip install aiohttp`, not `-r requirements.txt`.
- Required secrets: `PAGES_URL`, `ADMIN_PASSWORD`.
- Post-run: Discord notification via webhook URL fetched from KV `app_settings`.

## Quirks and Gotchas

- **`wrangler.toml` is intentionally absent.** All Cloudflare config is done via the dashboard only (per SPEC.md §13).
- **`DELETE /api/checkpoint`** exists in `_worker.js` but is not called by Python — the checkpoint is auto-deleted by `handlePostResults` when results are uploaded. Python only deletes the local `checkpoint.json` file. The DELETE endpoint exists for manual cleanup if needed.
- **Local fallback file paths are hardcoded** as `valid_keys/keys.txt` and `models_list/models.txt`. The per-provider named `.txt` files in those dirs are not used by the Python script.
- **Local checkpoint path is hardcoded** as `checkpoint.json` (not `checkpoint_{fingerprint}.json`). Only one checkpoint file exists at a time in local mode.
- **`async_test_results.json`** is gitignored but currently committed with real key data — treat as accidental; do not reference or expand it.
- **`has_thinking_ratio` can be `null`** (not `0.0`) when `sample_count == 0` — frontend must handle null explicitly.
- **Circuit breaker:** HTTP 401/403, or error message containing `balance` / `quota` → key added to `dead_keys`, all remaining models for that key skipped. HTTP 429/408 → one retry after 2s.
- **Single-key providers run every model twice.** With only one key there is no cross-key validation, so `runs_per_pair = 2` and each `(key, model)` runs two rounds separated by `SINGLE_KEY_RERUN_DELAY` (2s) to avoid tripping rate limits. Both rounds are recorded, so a model counts as failed only if both fail. The second round is skipped if round 1 tripped the circuit breaker. Resume requires `runs_per_pair` successes before a pair is treated as done, and a partially-done pair discards its stale record so the fresh rounds do not stack.
- **Success criterion:** `has_content or has_thinking` — either non-empty content text or non-empty thinking tokens counts as success.
- **`error_reason` is the provider's own message**, parsed from the first failed record's `error_body` by `parse_error_body` / `pick_error_message` (capped at 200 chars). The old canned text (`Key 专属硬伤 ...`) is only a fallback when no message can be parsed. Frontend truncates display at 120 chars with a `...` suffix.
- **Dedup key is `error_code` + normalized message**, computed by `normalize_message()` (Python) / `normalizeMessage()` (JS), which masks `sk-xxxx`, `****2fb7`, hex ids and digit runs. Neither side may use `\b` or `\d`: Python counts CJK as word characters and full-width digits as digits, JS does not, so those shorthands produce different output on the Chinese messages these providers return. Use explicit classes (`[0-9０-９]`) and a captured leading char (`(^|[^a-z0-9])` … `$1`) so both engines agree. Lookbehind is also off-limits in `app.js` — it is a parse-time syntax error below Safari 16.4 and would take down the whole file. Raw text would split one cause across every key (providers embed the key fragment in the message); `error_code` alone would merge two genuinely different causes under one code (invalid key vs. account deactivated). Every record keeps its own `error_reason`; only the first record of each distinct cause keeps `error_detail`. The two normalizers should stay in sync, but unlike the fingerprint a drift does not break anything: it costs at most one extra stored detail, or splits a group away from the record holding the detail — in which case `renderInvalidGroups` falls back to `{message: <full reason>}` so the 📋 modal still shows the untruncated message.
- **Windows:** `asyncio.WindowsSelectorEventLoopPolicy()` is set automatically when running on win32.
