# Deployment Architecture & Variables

## 1. 架構流程（文字圖）

```text
[Cloudflare Worker + Assets]
  GET /, /style.css, /app.js  → Static files (Assets binding)
  GET /api/env                → GITHUB_ACTIONS_URL (for frontend)
  GET /api/config     ←──────────────────── [Cloudflare KV]
  POST /api/config     ──────────────────── KV_STORE
  GET /api/checkpoint ←────────────────────   providers_config
  POST /api/checkpoint ────────────────────   run_checkpoint
  DELETE /api/checkpoint ──────────────────   latest_scorecard
  POST /api/results    ────────────────────   latest_benchmark
  GET /api/results    ←────────────────────   latest_run_meta
        ^
        |
[GitHub Actions Runner (runner.py, cron or manual)]
  1) 生成 run_id（{UTC_datetime}_{random_6chars}）
  2) GET /api/config
  3) GET /api/checkpoint（run_id 不符則重頭，符合則續跑）
  4) 自動 GET models_endpoint 取模型列表（若留空則依 provider_type 套預設；失敗或空列表則跳過該 provider）
  5) 執行 tester（timeout/retry/thinking detect/計時 total_time_ms）
     └─ 每 CHECKPOINT_EVERY_N 個模型 POST /api/checkpoint
  6) 執行 benchmark（success models，3 runs）
  7) POST /api/results（scorecard + benchmark + run_meta）
  8) DELETE /api/checkpoint（僅上傳成功後）

  觸發方式：
    - 自動：schedule (cron)
    - 手動：Admin UI 的 Run Now 按鈕開啟 GitHub Actions 頁面
```

## 2. 元件職責表

| 元件 | 職責 |
| :-- | :-- |
| Cloudflare Worker (JS) | API 閘道、Auth、KV 讀寫、Anti-IDOR、/api/env 回傳環境變數 |
| Cloudflare Assets | Admin UI 靜態檔案（public/ 目錄：index.html、style.css、app.js） |
| Cloudflare KV | providers_config、run_checkpoint、最新測試結果儲存 |
| GitHub Actions | 執行 runner.py（Python）：抓模型、測試、benchmark、上傳結果 |

補充：`providers_config.benchmark_enabled` 只控制 benchmark 階段是否執行，不影響 tester 主流程。

## 3. 端點對照表

| `GET /api/env` | 前端 -> Worker | 回傳環境變數（github_actions_url） |
| `GET /api/config` | GHA / 前端 -> Worker | 讀取 provider 設定（api_key 以 masked 版本回傳給前端；GHA 需完整值，Worker 視呼叫者決定） |
| `POST /api/config` | 前端 -> Worker | 更新 provider 設定 |
| `GET /api/checkpoint` | GHA -> Worker | 讀取續跑進度 |
| `POST /api/checkpoint` | GHA -> Worker | 更新續跑進度 |
| `DELETE /api/checkpoint` | GHA -> Worker | 完成後清除進度 |
| `POST /api/results` | GHA -> Worker | 上傳 scorecard / benchmark / run_meta |
| `GET /api/results` | 前端 -> Worker | 讀取最新結果 |

## 4. 部署變數清單（只列要手動填的）

### 4.1 Cloudflare Worker Variables / Secrets

| 變數 | 用途 |
| :-- | :-- |
| `MASTER_API_TOKEN` | 保護管理 API（config / checkpoint / results 寫入） |
| `GITHUB_ACTIONS_URL` | 前端「立即執行」按鈕跳轉網址（GitHub workflow 頁面） |

KV Namespace 綁定（在 Worker 設定中綁定，不用手動填值）：
- `KV_STORE`（單一 namespace，儲存全部 key）

所有 KV key：`providers_config`、`run_checkpoint`、`latest_scorecard`、`latest_benchmark`、`latest_run_meta`

### 4.2 GitHub Actions Secrets / Variables

| 變數 | 用途 |
| :-- | :-- |
| `WORKER_API_URL` | Worker base URL（例如 `https://xxx.workers.dev`） |
| `MASTER_API_TOKEN` | GHA 呼叫 Worker API 用 |

### 4.3 GitHub Actions Workflow 內固定參數（寫死在 runner.py）

| 參數 | 值 |
| :-- | :-- |
| `TIMEOUT_SECONDS` | `30` |
| `MAX_RETRIES` | `2`（總嘗試 3 次） |
| `RETRY_BACKOFF_SECONDS` | `[0.8, 1.6]` |
| `BENCHMARK_RUNS_PER_MODEL` | `3` |
| `CHECKPOINT_EVERY_N` | `3` |

## 5. 檔案結構（目標狀態）

```
api-test/
├── runner.py              # 唯一 Python 執行腳本
├── worker/
│   └── index.js           # Cloudflare Worker（API endpoints）
├── public/                # Admin UI 靜態檔案（Assets binding）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── wrangler.toml          # Worker 部署設定（含 assets binding）
├── .github/
│   └── workflows/
│       └── run.yml        # GitHub Actions workflow
├── WEB_PLAN.md
└── DEPLOYMENT_ARCHITECTURE.md
```

舊檔案（`api_tester.py`、`consolidate_results.py`、各 provider 資料夾的 `.json` 歷史記錄）在 runner.py 驗證穩定後可刪除。

## 6. 部署順序（最短路徑）

**Batch 1 — Worker API**
1. 建立 Cloudflare KV namespace（`KV_STORE`），取得 KV ID 填入 `wrangler.toml`
2. 在 Worker 設定第 4.1 節變數（`MASTER_API_TOKEN`、`GITHUB_ACTIONS_URL`）
3. 執行 `npx wrangler deploy` 部署 `worker/index.js`
4. 用 curl 手動測試 7 個 endpoint（驗證 auth、KV 讀寫、409 邏輯）

**Batch 2 — runner.py + GHA**
1. 在 GitHub repo 設定第 4.2 節 secrets
2. 確認 `runner.py` 就位
3. 新增 `.github/workflows/run.yml`（含 `workflow_dispatch` + `schedule` + `concurrency`）
4. 手動觸發 workflow，做一次完整端到端驗證

**Batch 3 — 前端 Admin UI（Assets 模式）**
1. 建立 `public/` 目錄，放入 `index.html`、`style.css`、`app.js`
2. 在 `wrangler.toml` 配置 `[assets]` binding 指向 `./public`
3. 實作 config 管理頁（CRUD providers）
4. 實作結果查看頁（scorecard + benchmark 排序展示）
5. Worker 新增 `GET /api/env` 回傳 `GITHUB_ACTIONS_URL`
6. 前端 JS boot 時 fetch `/api/env` 設置 Run Now 按鈕
7. 執行 `npx wrangler deploy`

## 7. 並行保護

GHA workflow 設定：

```yaml
concurrency:
  group: api-test-run
  cancel-in-progress: false  # 不取消正在跑的，排隊等
```

效果：cron 與手動 Run workflow 同時觸發時，後發的會排隊，不會覆蓋 checkpoint 或並行寫入結果。

## 8. 安全備忘

- `GET /api/config` 回傳給前端時，`api_key` 欄位必須 masked（`前4碼***後2碼`）
- GHA 需要完整 key 才能呼叫 provider API；Worker 在收到 `GET /api/config?full=1` 且有有效 `MASTER_API_TOKEN` 時才回傳完整值（僅供 GHA 呼叫）
- `runner.py` 的所有 log 輸出使用 `mask_key()` 函式，確保完整 key 不出現在 GHA log
