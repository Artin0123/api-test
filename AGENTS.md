# AGENTS.md

## Working agreements

- If the change has already been reviewed, commit it directly.
- Do not push unless the user explicitly asks for it.
- Run `npm run check` after touching `public/_worker.js` or `public/app.js`. It is `node --check`, parse-only — this repo has no linter, formatter, or type checker, so nothing else catches a mistake before deploy.
- Never create `wrangler.toml`. All Cloudflare config is done in the dashboard.
- Never write an API key into source. Keys come from `.env` (names in `.env.example`) or `valid_keys/*.txt`; `valid_keys/`, `async_test_results.json`, `.env` and `.dev.vars` are gitignored.
- Test against `?mock` or a local mock provider, never a real key. Write test artifacts to a temp dir, not the repo.
- Record a non-obvious decision in a comment next to the code it governs, not in this file — a copy here goes stale the moment the code moves.
- Only add markdown when asked, as `docs/<name>-MMDDHHMM.md`. Nothing new in the repo root.
- `docs/decision-*.md` is maintained, not a snapshot: when you change error grouping, dead keys, single-key reruns or sample clipping, update it and rename it to the time of that update. Reference it by glob, never by its current filename.

## Commands

| Purpose | Command |
|---|---|
| Start local dev | `npm run dev` → `wrangler pages dev public --kv=KV_STORE` |
| Syntax check JS | `npm run check` → `node --check` on `_worker.js` and `app.js` |
| Run Python tester | `pip install aiohttp` then `python async_test_keys.py` |
| Frontend mock mode | Open `http://127.0.0.1:8788/?mock` |

## Invariants (breaking these fails silently)

- **Fingerprint** is `SHA-256(JSON.stringify({ api_base, provider_type }))` — alphabetical key order, trailing slashes stripped from `api_base`. Implemented separately in `_worker.js`, `app.js` and `async_test_keys.py`; any drift makes result lookup miss.
- **KV binding name is exactly `KV_STORE`**, in the dashboard and in the `--kv=KV_STORE` flag.
- **`normalize_message()` (Python) and `normalizeMessage()` (JS) must stay in sync, and neither may use `\b` or `\d`.** Python counts CJK as word characters and full-width digits as digits; JS does not, and these providers reply in Chinese. Use explicit classes (`[0-9０-９]`) and a captured leading char (`(^|[^a-z0-9])` … `$1`). Lookbehind is banned in `app.js` outright: below Safari 16.4 it is a parse-time error that takes down the whole file.
- **`has_thinking_ratio` is `null`, not `0.0`, when `sample_count == 0`** — the frontend must handle null explicitly.
- **`answer_verified` is computed before `clip_sample()`**, never after.
- **The `atk_session` cookie must keep `SameSite=Strict`.** The write handlers parse bodies with `request.json()` without checking `Content-Type`, so a cross-site form post would be accepted as JSON; `Strict` is the only thing stopping it, there is no CSRF token.
- **CI runs `pip install aiohttp`, not `-r requirements.txt`.** A new Python dependency has to be added to `.github/workflows/main.yml` as well.

## Orientation

- `public/_worker.js` — Cloudflare Pages Functions entry. Routes in a flat `ROUTES` map (`"METHOD /path" → handler`); static files via `env.ASSETS.fetch(request)`.
- `public/app.js` — frontend, plain global script despite `"type": "module"` in `package.json`.
- `async_test_keys.py` — local mode (no `PAGES_URL`) reads `valid_keys/keys.txt` and `models_list/models.txt` and writes `async_test_results.json`; GHA mode (`PAGES_URL` + `ADMIN_PASSWORD`) pulls providers from the API and uploads results to KV.
- Auth: every `/api/` endpoint requires credentials, no exceptions — stored results carry plaintext keys and the fingerprint is derived from public inputs, so it gates nothing. Two accepted forms: `Authorization: Bearer <ADMIN_PASSWORD>` (Python script and GHA) or the `atk_session` cookie from `POST /api/login` (browser). The local secret lives in `.dev.vars`, read automatically by Wrangler.
- Background: `README.md` for deployment and usage, `docs/` for plans, decisions and the archived spec snapshot.
