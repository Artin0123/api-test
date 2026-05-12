# WEB_PLAN (Implementation-Ready)

## 0. 架構與原則

- 架構：Cloudflare Worker + Assets（靜態檔案） + KV + GitHub Actions (Python)
- 安全最小必做：
  1. 所有管理/寫入 API 必須驗證 `MASTER_API_TOKEN`
  2. 後端 anti-IDOR（驗身份 + 驗資源範圍）
  3. 管理 API 不公開
- 單人維護簡化：不做 token 分權、不做 revision lock（後寫覆蓋前寫）
- 觸發策略：不走 Worker 觸發 GitHub。`Run Now` 按鈕直接開啟 GitHub Actions workflow 頁，由你按 `Run workflow`。
- **GHA 並行控制**：workflow 加 `concurrency` group，確保同一時間只有一個 run，不取消正在執行中的 run（排隊等）。

## 1. KV 設計

Namespace: `KV_STORE`（單一）
- `providers_config`
- `run_checkpoint`
- `latest_scorecard:{config_fingerprint}`
- `latest_benchmark:{config_fingerprint}`

## 2. providers_config 格式（固定）

```json
{
  "providers": [
    {
      "provider_type": "openai",
      "tester_enabled": true,
      "benchmark_enabled": true,
      "api_base": "https://integrate.api.nvidia.com",
      "endpoint_path": "/v1/chat/completions",
      "api_key": "nvapi-xxx",
      "mode": "thinking",
      "models_endpoint": "/v1/models"
    }
  ],
  "updated_at": "2026-05-11T00:00:00Z"
}
```

`provider_type` 僅允許：`openai | ollama | gemini`
`mode` 僅允許：`thinking | vision`

### 2.1 models_endpoint 預設值（可覆蓋）

| provider_type | 預設 models_endpoint |
| :------------ | :------------------- |
| `openai`      | `/v1/models`         |
| `ollama`      | `/api/tags`          |
| `gemini`      | `/v1beta/models`     |

**邏輯**：`models_endpoint` 可留空，留空時依 `provider_type` 套預設值。runner 執行時一律 GET `models_endpoint` 抓取最新模型列表；若抓取失敗或回傳空列表，該 provider 會被跳過。

`endpoint_path` 同樣可留空，留空時依 `provider_type` 套預設值。

`benchmark_enabled` 只控制是否執行 benchmark，不影響 tester 主流程。

只有跑完後的 JSON 結果（scorecard / benchmark）才需要保存至 KV，模型列表本身不做持久化。

### 2.2 Vision 圖片（固定）

vision mode 使用下列 SVG 寫死在程式碼中，不依賴本地檔案：

```
data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCAxNjAgNjAiPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9IndoaXRlIi8+PHRleHQgeD0iNTAlIiB5PSI1NSUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjQwIiBmb250LXdlaWdodD0iYm9sZCIgZmlsbD0iYmxhY2siIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiPk1FT1c8L3RleHQ+PC9zdmc+
```

（內容為白底黑字 "MEOW" 的 SVG 圖片）

## 3. API 契約（Worker）

管理 API 一律驗證：`Authorization: Bearer <MASTER_API_TOKEN>`

1. `GET /api/env`
- 回傳環境變數 `{ github_actions_url: string | null }`（供前端動態設置 Run Now 按鈕）

2. `GET /api/config`
- 回傳 `providers_config`（`api_key` 欄位以 masked 版本回傳，例如 `nvap***co`，不暴露完整值）

2. `POST /api/config`
- 覆寫 `providers_config`

3. `GET /api/checkpoint`
- 回傳 `run_checkpoint`，若無回傳 `{ "exists": false }`

4. `POST /api/checkpoint`
- 寫入 checkpoint（見第 4 節格式）

5. `DELETE /api/checkpoint`
- 清除 checkpoint

6. `POST /api/results`
- 必帶欄位：`scorecard`, `benchmark`, `config_fingerprint`
- `scorecard` 內必帶：`run_id`, `started_at`, `finished_at`
- 以 `config_fingerprint` 為範圍寫入最新結果（每個 fingerprint 各自只保留最新一筆）
- Anti-IDOR：若 `items[*]` 無法對應到 `providers_config` 內既有 provider（以 `provider_type + mode + api_base` 辨識），回 `400`

8. `GET /api/results`
- 前端讀「目前 providers_config 對應 fingerprint」的最新結果（不做全域 latest fallback）

## 4. run_id 與 checkpoint 格式（固定）

### 4.1 run_id 生成規則

格式：`{UTC_datetime}_{random_6chars}`
範例：`2026-05-11T10-30-00Z_a3f9c2`

- 每次 GHA run 開始時生成一次，整個 run 全程使用同一個 `run_id`
- `run_id` 主要用於日誌與結果追蹤，不作為 checkpoint 續跑判斷條件

### 4.2 config_fingerprint 續跑規則

- runner 會依 `providers_config` 計算 `config_fingerprint`（SHA-256）
- 計算內容使用「有效設定值」：`provider_type`、`mode`、`api_base`、`endpoint_path`、`models_endpoint`、`tester_enabled`、`benchmark_enabled`
- 若 `endpoint_path` 或 `models_endpoint` 留空，會先套用對應 `provider_type` 預設值再計算
- `providers` 會先排序後計算，避免因順序不同導致無意義 mismatch
- 讀取 checkpoint 時：
  - 指紋相同 → 續跑
  - 指紋不同 → 視為不同測試配置，從頭開始

### 4.2 checkpoint 格式

```json
{
  "run_id": "2026-05-11T10-30-00Z_a3f9c2",
  "config_fingerprint": "f0d7b85d8f9d1f8e8e0f0e5ec847b6e6d9f5f5d49b0b2f1cd7db0d57f473a917",
  "completed": [
    "nvidia:gpt-4o",
    "nvidia:gpt-4.1"
  ],
  "updated_at": "2026-05-11T10:45:12Z"
}
```

更新頻率：每完成 `3` 個模型寫一次（`CHECKPOINT_EVERY_N = 3`）。
整次 run 上傳成功後刪除 checkpoint；失敗則保留以供續跑。

## 5. Tester 規格（Python runner.py）

### 5.1 檔案結構

現有的 `api_tester.py` + `consolidate_results.py` 合併重寫為單一 **`runner.py`**。
不再有本地 `history.json`、`consolidated.json`、`checkpoint.json` 等本地檔案。

### 5.2 固定參數與 Prompt

所有以下參數全部寫死在 `runner.py`，不放入 KV config。

**原則**：Prompt、timeout、retry 等屬於「測量方法論」而非「provider 設定」。放進 KV 會造成：
1. KV 結果或 config 重複儲存相同字串（噪音）
2. Prompt 被任意修改時歷史結果失去可比性

這類設定應該跟版本控制走，改動需要有意識地 commit。

**執行參數：**
- `TIMEOUT_SECONDS = 30`
- `MAX_RETRIES = 1`（總嘗試 2 次）
- `RETRY_SLEEP_SECONDS = 1.0`（每次重試前固定等待 1 秒）
- `BENCHMARK_RUNS_PER_MODEL = 3`
- `CHECKPOINT_EVERY_N = 3`
- `BENCHMARK_ERROR_PENALTY_MS = 30000`

**Prompt（全部寫死）：**

| 用途                      | Prompt                                                       |
| :------------------------ | :----------------------------------------------------------- |
| Tester — thinking mode    | `"What is 17 multiplied by 19? Think step by step."`         |
| Tester — vision mode      | `"Describe this image in one word."`                         |
| Benchmark — thinking mode | `"What is 17 multiplied by 19? Reply with the number only."` |
| Benchmark — vision mode   | `"Describe this image in one word."`                         |

**Vision 圖片**：vision mode 的 base64 image data 同樣寫死在代碼中（SVG "MEOW" 圖片，詳見 §2.2）。success 判定：模型輸出包含 `meow`（case-insensitive）即視為 `has_answer = true`。

### 5.3 重試條件

- 重試：`429`, `5xx`, timeout
- 不重試：`401`, `403`, `404`, payload 格式錯誤

### 5.4 錯誤分類（固定列舉）

- `timeout`
- `unauthorized`
- `forbidden`
- `not_found`
- `rate_limited`
- `server_error`
- `request_error`
- `unexpected_error`

### 5.5 計時

Tester 階段（第一輪測試）即開始計時 `total_time_ms`，scorecard 排序依賴此欄位。Benchmark 階段另外計時並記錄 `ttft_ms`。

## 6. Thinking 偵測規則（固定順序）

1. OpenAI chat/completions：
- `choices[0].message.thinking`
- `choices[0].message.reasoning_content`
- `choices[0].message.reasoning_details[]`（summary/text/content）

2. OpenAI responses/SSE fallback：
- 事件類型：`response.reasoning.delta`, `response.thinking.delta`, `response.thought.delta`

3. Ollama：
- `message.thinking`

4. Gemini SSE：
- `parts[].thought == true` 的 `text`
- 若僅有 `thoughtSignature`，`has_thinking=true`，`thinking_excerpt` 可留空或標記 signature

5. 最後 fallback：
- 從 `answer` 內抽 `<think>...</think>`

判定：
- 只要任一來源抓到有效 thinking 內容或 thoughtSignature，即 `has_thinking = true`
- 不強制 thinking；`success` 只看是否有有效 answer

## 7. Success 與排序規則

success 規則：
- `success = has_answer`
- `has_answer = len(answer.strip()) > 0`

scorecard 排序：
1. `success=true` 在前
2. 同為 success 時用 `total_time_ms` 由小到大
3. 同時間時用 `api_base + model` 字典序

## 8. Benchmark 規格

- 只對 `success=true` 模型執行
- 每模型固定 `3` 次
- 主要欄位：
  - `total_time_ms`
  - `ttft_ms`（抓不到填 `null`）
  - `output_chars`
- 主排序依據只用 `avg_total_time_ms`
- `tps` 不做主判斷，可不存

TTFT 規則：
- 可從 stream 精準取首 token 才填值
- 非 stream / 格式不支援一律 `null`
- `ttft_ms = null` 不影響 success

## 9. 結果 JSON 契約

### 9.1 scorecard
```json
{
  "run_id": "2026-05-11T10-30-00Z_a3f9c2",
  "started_at": "2026-05-11T10:30:00Z",
  "finished_at": "2026-05-11T11:08:00Z",
  "items": [
    {
      "api_base": "https://integrate.api.nvidia.com",
      "provider_type": "openai",
      "model": "gpt-4o",
      "mode": "thinking",
      "success": true,
      "has_answer": true,
      "has_thinking": true,
      "total_time_ms": 812.4,
      "error_type": "",
      "retry_count": 1,
      "answer_preview": "323",
      "thinking_preview": "I need to compute 17 multiplied by 19...",
      "error_message_preview": ""
    }
  ],
  "summary": {
    "total": 100,
    "success": 80,
    "failed": 20
  }
}
```

`answer_preview`、`thinking_preview`、`error_message_preview` 為前端顯示用摘要欄位，最大長度 `100` chars。

### 9.2 benchmark
```json
{
  "run_id": "2026-05-11T10-30-00Z_a3f9c2",
  "items": [
    {
      "api_base": "https://integrate.api.nvidia.com",
      "provider_type": "openai",
      "mode": "thinking",
      "model": "gpt-4o",
      "runs": [
        { "run_index": 0, "total_time_ms": 900.1, "ttft_ms": 210.2, "output_chars": 120 },
        { "run_index": 1, "total_time_ms": 860.0, "ttft_ms": 205.7, "output_chars": 118 },
        { "run_index": 2, "total_time_ms": 870.5, "ttft_ms": null, "output_chars": 121 }
      ],
      "avg_total_time_ms": 876.87
    }
  ]
}
```

## 10. Auth 與 Anti-IDOR（精確定義）

- Auth：檢查 bearer token 是否正確，確認「你是誰」
- Anti-IDOR：即使 token 正確，也只允許操作伺服器認可資源

本系統單租戶簡化版 anti-IDOR：
- 不允許任意新增未註冊 provider 的結果資料
- `POST /api/results` 若 `items[*]` 無法對應到設定內 provider（以 `provider_type + mode + api_base` 辨識），回 `400`

`GET /api/config` 回傳時，`api_key` 欄位以 masked 版本顯示（前 4 碼 + `***` + 後 2 碼），Worker 讀寫 KV 時仍使用完整值。GHA log 中同樣不允許印出完整 key（runner.py 使用 `mask_key()` 函式）。

## 11. GHA 流程（固定）

1. 生成 `run_id`（`{UTC_datetime}_{random_6chars}`）
2. `GET /api/config`（取得 providers + api_key 完整值）
3. `GET /api/checkpoint`
   - 若 checkpoint 存在且 `config_fingerprint` 相符 → 從 checkpoint 位置續跑
   - 否則 → 從頭開始新 run
4. 對每個 provider，自動 GET `models_endpoint` 取得最新模型列表（失敗或空列表則跳過該 provider）
5. 依 provider 的 `tester_enabled` 決定是否執行 tester（含重試、thinking 偵測、計時，每 N 個模型 `POST /api/checkpoint`）
6. 若某 provider 為 `tester_enabled=false` 且 `benchmark_enabled=true`，則從目前 `config_fingerprint` 最新 scorecard 取模型作 benchmark
7. 執行 benchmark（success models，固定 3 次，仍受每個 provider 的 `benchmark_enabled` 控制）
8. `POST /api/results`（scorecard + benchmark）
9. `DELETE /api/checkpoint`（僅在本次有跑 tester 且上傳成功後）

備註：benchmark 的 `avg_total_time_ms` 會把失敗/timeout run 以 `30000ms` 懲罰值納入平均，避免「2 次快 + 1 次 timeout」被排得過前。

## 12. 手動與排程觸發方式

- 自動：GitHub Actions `schedule (cron)` 觸發
- 手動：前端 `Run Now` 按鈕開啟 `GITHUB_ACTIONS_URL`，在 GitHub Actions 頁按 `Run workflow`
- **並行保護**：workflow 設定 `concurrency.group = api-test-run`，`cancel-in-progress: false`

## 13. 最小驗收標準

1. 同一份 `providers_config` 可跑完 100+ 模型不丟進度
2. 中途中斷後可從 checkpoint 續跑（同一份 providers 配置）
3. 結果頁可依 `total_time_ms` 穩定排序
4. `has_thinking` 與 `error_type` 有固定欄位且可顯示
5. 不在 log 出現完整 API key
6. models_endpoint 抓取失敗或空列表時，該 provider 會被跳過

## 14. 實作批次順序

**Batch 1**：Cloudflare Worker API（8 endpoints + KV binding）→ 語言：JavaScript
**Batch 2**：`runner.py` + GHA workflow YAML
**Batch 3**：Admin UI（Assets 模式，`public/` 目錄靜態檔案 + `GET /api/env`）
