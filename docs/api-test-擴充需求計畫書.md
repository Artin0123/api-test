# api-test 擴充計畫：輪詢轉發、黑名單與 D1 儲存

## 1. 擴充目標與路徑規則

既有的 `api-test` 為「API 金鑰定期檢測平台」（登記多個服務商與金鑰、每日排程測試並通知）。本次擴充讓同一批金鑰同時對外提供 API 請求轉發服務，並新增對應的管理與維護工具：

```text
呼叫方（外部軟體） ──請求──> api-test（轉發閘道） ──轉發──> OpenAI / Gemini 等上游服務
（例如聊天用戶端）            ├─ 依網址別名對應服務商
                              └─ 輪流選用金鑰、避開失效金鑰與記錄失敗次數
```

```text
軟體送出  POST https://<站台網址>/proxy/<服務商別名>/chat/completions
轉發為    POST https://api.openai.com/v1/chat/completions
```

- **路徑拼接規則**：上游網址嚴格等於 `api_base` ＋ 呼叫方路徑（`targetUrl()`），系統**不自動補上任何版本前綴**。
- **常見填寫慣例**：OpenAI、Gemini 與 Anthropic 的 `api_base` 通常已包含版本前綴（`…/v1`、`…/v1beta`），因此呼叫端送出路徑不得重複包含 `/v1`。

| 服務商 | 僅填根目錄（錯誤） | 實際發出的請求網址 | 填寫至版本前綴（正確） |
|---|---|---|---|
| OpenAI | `https://api.openai.com` | `https://api.openai.com/chat/completions` → **404** | `https://api.openai.com/v1` |
| Gemini | `https://generativelanguage.googleapis.com` | `…/models/gemini-2.5-pro:streamGenerateContent` → **404** | `…/v1beta` |
| Anthropic | `https://api.anthropic.com` | `https://api.anthropic.com/messages` → **404** | `https://api.anthropic.com/v1` |

| Provider 類型 | 建議呼叫路徑 |
|---|---|
| openai | `/chat/completions` |
| gemini | `/models/{model}:streamGenerateContent?alt=sse` 或 `:generateContent` |
| anthropic | `/messages` |

除了目標網址改寫與認證標頭替換之外，請求本文與上游回覆內容皆維持原樣轉傳。

系統角色分工：
- **呼叫方（用戶端）**：能自訂 API 網址的軟體，負責發出請求。
- **本專案（Cloudflare Pages）**：提供管理網頁、排程介面、轉發閘道與金鑰狀態帳本。
- **上游服務**：OpenAI、Gemini、Anthropic 或其他相容供應商。

## 2. 既有功能與異動邊界

原則上保留既有的管理介面與運作行為，新功能以獨立分頁與端點方式疊加；唯一影響既有部署與行為的調整如下：

1. **預設後端改為 `d1`**：未設定 `STORAGE_BACKEND` 時預設使用 `d1`，純 KV 站台升級時須依固定順序搬移上線（見 R0）。
2. **`POST /api/settings` 輸入驗證**：別名格式錯誤／重複或 `provider_type` 不在白名單內（見 R9）皆會回傳 400。
3. **本機開發預設模式**：`npm run dev` 固定帶入 `--binding STORAGE_BACKEND=kv`；使用本地 D1 測試轉發請改用 `npm run dev:d1`。

| 既有模組 | 現況說明 |
|---|---|
| 「来源设定」分頁 | 維持既有服務商卡片與每行一把金鑰的純文字框操作方式 |
| 自訂請求參數 | 每個服務商的 `Extra Body` 與 `Custom Headers` 在轉發時同樣套用 |
| 每日定期檢測與通知 | GitHub Actions 排程、Discord 通知與 `async_test_keys.py` 邏輯維持不變（僅移除 `ollama` 分支） |
| 「测试结果」／「失效密钥」分頁 | 維持原有功能；`dead_keys` 與轉發用的禁用帳本 `key_state` 完全獨立互不混用 |
| 服務商資料欄位 | Provider 新增選填欄位 `alias`（轉發別名）與 `gateway_provider`（AI Gateway Custom Provider slug） |
| 登入門禁與介面規範 | 沿用 `ADMIN_PASSWORD` 30 天 HttpOnly session cookie、深淺色主題、RWD、嚴格 CSP 與 `?mock` 模式 |

## 3. 擴充項目總表

| 編號 | 項目名稱 | 簡述 |
|---|---|---|
| R0 | 儲存層切換 | 新增環境變數切換 D1 或 KV 模式（預設 D1），並提供搬移／備份／還原工具 |
| R1 | 透明請求轉發 | 新增 `/proxy/{別名}/...` 端點，原樣轉發請求並套用 `Extra Body` 與 `Custom Headers` |
| R2 | 金鑰輪詢機制 | 同一服務商多把可用金鑰時，優先選用最久未被使用的一把 |
| R3 | 失敗計數與自動禁用 | 遇非 2xx 回應時累加失敗次數，達門檻禁用；依每日測試結果自動恢復或手動恢復 |
| R4 | 換鑰自動重試 | 請求失敗時排除本次已試過的金鑰，自動換下一把重試（最多 3 次） |
| R5 | 即時單鑰與批量測試 | 於「轮询转发」分頁支援單把與有效／無效批量即時測試 |
| R6 | 新增「轮询转发」分頁 | 上方為服務商選單與工具列，下方為每把金鑰一張狀態卡片 |
| R7 | 查看 AI Gateway 紀錄 | 不自建紀錄頁面；於「轮询转发」頁首提供連結開啟已依服務商篩選的 AI Gateway 日誌頁 |
| R8 | 「来源设定」輔助工具 | 編輯視窗新增金鑰搜尋高亮、匯出 `.txt`、三段排序與刪除前數量減少確認 |
| R9 | 移除 `ollama` 型別 | `provider_type` 僅保留 `openai`、`gemini`、`anthropic` |

## 4. 與 Cloudflare AI Gateway 的整合方式

Cloudflare AI Gateway 的代理與日誌額度獨立計算（外部呼叫請求不消耗本專案 Pages 額度，唯有本專案向 AI Gateway 發出的上游 `fetch` 計入本專案請求數）。

| 帳號建立 Gateway 時間 | 日誌儲存系統 | 免費額度 | 保存期限 |
|---|---|---|---|
| 2026-09-24（含）之後 | Workers Logs | 每日 20 萬筆 | 3 天 |
| 2026-09-24 之前 | Legacy Logs | 跨所有 Gateway 總量 10 萬筆 | 依方案上限保留（須定期清理） |

本計畫整合兩者分工：

| 職責 | 負責系統 |
|---|---|
| 轉發密碼門禁、輪詢選鑰、失敗計數與黑名單、換鑰重試、`Extra Body`／`Custom Headers` 注入 | 本專案 |
| 請求日誌與分析（成功／失敗、模型、Token、成本、狀態碼、耗時、金鑰標註）與逾時控制 | AI Gateway |

所需部署變數：

| 變數名稱 | 用途 |
|---|---|
| `AI_GATEWAY_ACCOUNT_ID` | Cloudflare 帳號 ID（網址 `{帳號}`） |
| `AI_GATEWAY_ID` | AI Gateway 名稱（網址 `{gateway}`） |
| `AI_GATEWAY_TOKEN` | AI Gateway 認證權杖（寫入 `cf-aig-authorization`，僅存伺服端） |
| `AI_GATEWAY_LOGS_URL` | AI Gateway 儀表板日誌頁深連結模板，支援 `{key}` 與 `{provider}` 佔位符 |

當四個變數皆設定且服務商填有 `gateway_provider` 時，轉發流量會經過 AI Gateway；否則退回直連 `api_base`（不送出任何 Cloudflare 控制標頭）。經由 AI Gateway 轉發時會附加 `cf-aig-authorization`、`cf-aig-skip-cache: true`（預設關閉快取以免回放舊回應或使金鑰時間戳失真）、`cf-aig-max-attempts: 1`、`cf-aig-request-timeout` 與 `cf-aig-metadata`（格式 `{"key":"abcd-wxyz","provider":"別名"}`，短金鑰用 `a***z`；值僅限 ASCII，避開全形字元導致 HTTP 標頭拋錯）。系統會預先剝除呼叫端傳入的所有 `cf-aig-*` 標頭，防止偽造標註或權杖。

Custom Providers 路徑拼接規則：

```text
Gateway 請求 URL：https://gateway.ai.cloudflare.com/v1/{帳號}/{gateway}/custom-{slug}/{廠商路徑}
轉發至上游 URL：  {base_url}/{廠商路徑}
```

每個服務商於 AI Gateway 登記為 Custom Provider 時將 `base_url` 設為該服務商的 `api_base`，轉發時將呼叫方路徑作為 `{廠商路徑}` 送出，使三種 Provider 型別皆適用一致的路徑規則。Guardrails 與 DLP 功能與金鑰管理無關且 Guardrails 會依 Token 計費，均不啟用。

## 5. 明確不做的範圍

- 不實作多會員註冊、多租戶隔離、計費、金鑰權重分配或多節點分發。
- 不將來源設定改為逐筆表單式新增／刪除介面，維持純文字框編輯模式。
- 不實作暫時性冷卻機制：禁用後僅能由每日測試自動恢復或人工點擊「恢复」。
- 不變更 `async_test_keys.py` 每日測試核心邏輯；不開放跨網域網頁直接呼叫管理或轉發 API。
- 不改寫非 JSON 格式請求內文（`Extra Body` 注入僅適用於 `Content-Type: application/json`）。
- 不引入 Redis 或常駐伺服器；`kv` 模式下停用轉發功能。

## 6. 功能需求規格

### R0　儲存層切換（KV ⇄ D1）

- **`STORAGE_BACKEND`**：接受 `d1`（預設）或 `kv`；填寫無效值或未綁定 `DB` 時，每個 `/api/*` 與 `/proxy/*` 請求回傳可讀的 500 錯誤，同時維持靜態管理頁面正常載入。D1 首次存取前透過 `ensureSchema()` 自動建表。
- **搬移與備份還原工具**：提供 `/api/storage/export`、`migrate`、`restore` 端點與 `npm run migrate`（支援 `--dry-run`、`--restore <file>`、`--allow-empty`、`--yes`）。執行順序為「先建立權限 `0600` 的本機 JSON 備份（含 `entries` 與 `key_state`）→ 執行冪等搬移（遍歷 KV 所有分頁）→ 驗證一致性」。
- **精準還原與上限**：`--restore` 前會先備份當前 D1，先 upsert 備份資料再刪除多餘列，確保還原後狀態與快照一致（退回 KV 模式直接改環境變數即可，不需 restore）。`export` 與 `restore` 共用 `STORAGE_MAX_ENTRIES = 20000` 上限。
- **安全上線順序**：① 建立 D1 並綁定 `DB` → ② 設 `STORAGE_BACKEND=kv` 部署新版 → ③ 執行 `npm run migrate` → ④ 改設 `STORAGE_BACKEND=d1`（或移除）再部署。

### R1　透明轉發

- 端點格式：`/proxy/{別名}/{相對於 api_base 的路徑與查詢字串}`。`alias` 限 `^[a-z0-9][a-z0-9-]{0,63}$` 且全站唯一，設定儲存時即校驗（錯誤回 400）；停用服務商回傳 503；未設別名不可轉發。
- 標頭處理順序：剝除呼叫端 `Cookie`、跳躍式標頭與 `cf-aig-*` → 依類型注入金鑰認證標頭（`openai`: `Authorization: Bearer`；`gemini`: `x-goog-api-key`；`anthropic`: `x-api-key` ＋ `anthropic-version: 2023-06-01`）→ 套用 `Custom Headers`（可覆蓋前項）→ 若走 AI Gateway 寫入系統自有 `cf-aig-*`。
- 原樣轉傳請求與 SSE 串流回覆；JSON 請求併入 `Extra Body`。
- 轉發密碼 `PROXY_PASSWORD` 接受 `Authorization: Bearer`、`x-api-key`、`x-goog-api-key`（錯誤或攜帶 `ADMIN_PASSWORD` 回 401；未設定或與 `ADMIN_PASSWORD` 相同回 503 `PROXY_DISABLED`；`kv` 模式回 503）。
- 上游等待標頭逾時由 `PROXY_UPSTREAM_TIMEOUT_MS` 控制（1 秒～10 分鐘，預設 120000 毫秒）。

### R2　輪流使用（Round-Robin）

- 優先選用 `disabled = 0` 且 `last_used_at` 最小（或為 `NULL`）的金鑰，並於**取用當下**以單一條原子語句推進時間戳（`MAX(now, 同 fp 最大值 + 1)`），確保同一毫秒並發或重試不挑回同一把金鑰：

```sql
UPDATE key_state
   SET last_used_at = MAX(?1, COALESCE((SELECT MAX(last_used_at) FROM key_state WHERE fp = ?2), 0) + 1),
       updated_at   = ?1
 WHERE id = (SELECT id FROM key_state
              WHERE fp = ?2 AND disabled = 0
              ORDER BY last_used_at, id
              LIMIT 1)
RETURNING id, api_key, fail_count;
```

### R3　失敗計數與禁用（黑名單）

- **單一失敗規則**：任何非 2xx 回應或連線／逾時錯誤皆計一次失敗（`fail_count + 1`）並換鑰重試；達 `PROXY_FAIL_THRESHOLD`（預設 3）設為 `disabled = 1`。成功（2xx）且原 `fail_count <> 0` 時歸零。
- **恢復管道**：每日排程上傳 `POST /api/results` 時，由 `recoverKeysFromResults()` 自動將 `valid_keys` 內的金鑰清為 `disabled = 0, fail_count = 0`；轉發頁卡片亦提供手動「恢复」按鈕。
- **來源設定同步與 B′ 選後防護**：`POST /api/settings` 觸發 `syncKeyState()` 增刪帳本列。若取鑰時選中已不在 `provider.keys` 名單內的殘留列，立即刪除並重挑；僅當該指紋完全無列時才自動依 `provider.keys` 補列（無任何金鑰的服務商在儲存時回 400 阻擋）。
- **與 `dead_keys` 隔離**：兩者互不讀寫、互不影響（`dead_keys` 全域去重，`key_state` 依指紋獨立記帳）。

### R4　換鑰重試

- 非 2xx 失敗時排除本次已試過列 ID 換下一把重試，上限 `PROXY_MAX_RETRIES`（固定上限 3 次，含首次最多嘗試 4 把），最多佔用 4 個子請求與 1 條並發連線。
- 使用預先快取的原始位元組重建請求；走 Gateway 時帶 `cf-aig-max-attempts: 1`。
- 重試耗盡仍失敗時，原樣回傳最後一次上游回應。逾時控制僅涵蓋「等待回應標頭」，收到標頭即清除計時器，不中斷長串流。

### R5　即時單鑰測試與批量測試

- **API 契約**：`POST /api/proxy/test` 僅傳 `{ id, fp }`（前端全程不接觸明文金鑰），回傳 `{ ok, status, ms, model, error?, fail_count?, disabled? }`。須滿足 `d1` 模式（否則 503）、服務商已設定 Models 且已保存測試模型（否則 400）以及列歸屬正確（否則 404）。
- **測試模型設定**：候選清單來自「来源设定」該服務商 `Models`，選擇結果獨立存於 `app_settings.proxy_test_models`（`POST /api/proxy/test-model`）。
- **帳本更新規則**：手動單把與批量測試失敗會累加失敗次數並可觸發禁用；測試成功**不異動帳本**（不歸零、不解除禁用）。
- **批量測試**：提供「测试有效密钥」（`disabled = 0`）與「测试无效密钥」（`disabled = 1`），依序逐把測試並顯示即時進度與彙整結果。

### R6　「轮询转发」分頁

```text
┌ 轮询转发 ──────────────────────────────── [重新读取] [Gateway 记录 ↗] ┐
│ [dashscope - openai ▾]    [https://站台/proxy/dashscope          ]    │
│ 有效 3 无效 0      测试模型 [gpt-4o-mini ▾] [保存模型] [测试有效密钥] [测试无效密钥] │
├────────────────────────────────────────────────────────────────────────┤
│ ┌ sk-a***1111  [正常] ┐ ┌ sk-b***2222  [已禁用] ┐ ┌ sk-c***3333 …   │
│ │ 连续失败 0          │ │ 连续失败 3          │ │                   │
│ │ 最近使用 2026/11/9… │ │ 最近使用 从未        │ │                   │
│ │ [测试]              │ │ [测试] [恢复]        │ │                   │
│ │ 可用 · 123 ms       │ │ 不可用 · HTTP 401    │ │                   │
│ └────────────────────┘ └────────────────────┘ └──────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

- **頁首**：右側提供「重新读取」與紫色主色按鈕「Gateway 记录 ↗」（缺少服務商或未設 `AI_GATEWAY_LOGS_URL` 時停用）。
- **工具列第一列**：服務商下拉選單（選項格式 `別名 - API 格式`）與可點擊整行複製的轉發網址（未設別名時停用提示；手機版自動換行）。
- **工具列第二列**：左側顯示 `16px` 粗體 `有效 X 无效 Y`（採用 `--ok-soft`／`--fail-soft`）；右側排列「测试模型」下拉選單（預設第一項，寬度 `15rem`）、「保存模型」（點擊顯示「已保存」期間寬度不變窄）與「测试有效密钥」／「测试无效密钥」。
- **金鑰卡片與安全性**：採 `repeat(auto-fill, minmax(280px, 1fr))` 排列；`/api/proxy/state` 與畫面僅輸出遮罩值（`maskKey()`）；`kv` 模式或環境缺少設定時顯示 `proxy_message` 並停用操作按鈕；嚴禁行內 `style=""` 與 `<script>`。

### R7　查看 AI Gateway 紀錄

不自建紀錄頁面；透過頁首單一「Gateway 记录」按鈕依 `AI_GATEWAY_LOGS_URL` 模板帶入已 URL 編碼的目前服務商別名（`{provider}`）與標註佔位符開啟儀表板。

### R8　「来源设定」輔助工具

- **搜尋高亮（`#ed-keys-search`）**：不分大小寫標出所有符合片段的橘色高亮；搜尋框留空時改標出文字框內反白選取的片段；自訂清除按鈕並隱藏瀏覽器原生清除鈕。
- **行內刪除確認（`#editor-confirm`）**：保存時若金鑰數量減少（重複值按次數計算），就地展開顯示「即将删除 X 支密钥」與遮罩清單（最多直接顯示 5 筆，其餘捲動），取消時文字框復原，切換 `.hidden` class 符合 CSP。
- **匯出與三段排序**：`#ed-export-keys-btn` 匯出清理空白後的 `<主域名>-keys.txt`；`#ed-sort-keys-btn` 依序循環「預設順序 → ASCII 遞增 → ASCII 遞減」（採 UTF-16 碼元比較，保存時不自動重排）。
- **遮罩一致性**：`maskKey()` 同時存在於 `app.js` 與 `_worker.js` 並由測試確保一致。

### R9　移除 `ollama` 型別

自前後端選單、認證／端點對照表、`async_test_keys.py` 與文件全面移除 `ollama`；`POST /api/settings` 透過 `PROVIDER_TYPES` 白名單於儲存時對不支援型別回傳 400。

## 7. 資料表設計（D1 模式）

```sql
CREATE TABLE store (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE key_state (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fp           TEXT    NOT NULL,
  api_key      TEXT    NOT NULL,
  last_used_at INTEGER,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  disabled     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  UNIQUE (fp, api_key)
);

CREATE INDEX idx_key_state_pick ON key_state (fp, disabled, last_used_at);
```

- `store` 沿用既有 KV 鍵名（`app_settings`、`results:{fp}`、`checkpoint:{fp}`、`dead_keys`）與 JSON 格式，使 `kv` 與 `d1` 模式共用同一套業務邏輯。
- `key_state` 儲存每把金鑰輪詢與失敗帳本；時間欄位存 epoch 毫秒整數以利數值排序。因需以明文金鑰換取上游認證標頭，`api_key` 須原樣保存於受控管存取的資料表中。

## 8. 單筆轉發請求處理流程

1. 檢查 `STORAGE_BACKEND`：非 `d1` 回傳 503。
2. 驗證 `PROXY_PASSWORD`（`Authorization: Bearer`／`x-api-key`／`x-goog-api-key`）：缺少或錯誤回傳 401（與 `ADMIN_PASSWORD` 相同或未設定則回 503）。
3. 依別名查出服務商：找不到回 404，已停用回 503。
4. 呼叫 `pickKeyRow()` 挑選 `disabled = 0` 且最久未使用金鑰並立即推進 `last_used_at`；若選到已不在來源清單的殘留列則刪除並重選（B′）。
5. 無可用金鑰回傳 503 `NO_KEYS`。
6. 剝除敏感與代理標頭，依順序注入協定認證標頭、`Extra Body`、`Custom Headers` 與（走 Gateway 時）自有 `cf-aig-*`。
7. 以 `AbortController` 控管等待標頭逾時後向目標上游發送請求。
8. **成功（2xx）**：若 `fail_count <> 0` 則歸零，原樣回傳上游回應與串流。
9. **失敗（非 2xx／連線或逾時錯誤）**：呼叫 `recordKeyFailure()` 計數（達門檻即禁用）；未達重試上限（3 次）且尚有未試過金鑰時跳回第 4 步重試。
10. 重試耗盡仍失敗時，原樣傳回最後一次上游回應。

## 9. 免費方案額度估算（以每日 1,000 次轉發為基準）

僅動態請求（`/api/*`、`/proxy/*`）計入額度，靜態頁面與資源免費且不限次數；另須符合單次請求 CPU 10ms、最多 50 子請求（重試最多 4 個）與 6 條並發連線（循序重試僅佔 1 條）上限。

| 資源項目 | 預估每日用量 | Cloudflare 免費上限 | 餘裕 |
|---|---|---|---|
| 動態請求（Pages Functions） | 約 1,000＋ 次（含即時測試與管理操作） | 每日 100,000 次 | 約 100 倍 |
| D1 讀取 | 約 2,000 列（每筆轉發 3 語句、讀 2 列） | 每日 5,000,000 列 | 約 2,500 倍 |
| D1 寫入 | 約 2,000 列（寫 `last_used_at` 1 列 ＋ 索引列） | 每日 100,000 列 | 約 50 倍 |
| AI Gateway 日誌 | 約 1,200 筆（含平均重試嘗試次數） | 新帳號 200,000／天；舊帳號 100,000 總量 | 充裕（舊帳號須定期清理） |
| KV（僅 `kv` 模式） | 維持每日排程寫入 | 每日 1,000 次寫入 | 充裕 |

## 10. 查證事實與尚待線上環境確認項目

**已查證之 Cloudflare 官方規範摘要**：
- `cf-aig-metadata`（限 5 筆／請求）、Custom Providers 路徑拼接（`base_url` ＋ `custom-{slug}/` 後段）、`cf-aig-max-attempts`／`cf-aig-request-timeout`、AI Gateway 日誌兩制額度、Workers 與 D1（含索引列計費）免費方案限制，均已核對官方文件並由離線測試套件（`npm test`，45 項測試全過）驗證邏輯。

**仍須於正式線上環境實測確認**：
1. **D1 高並發寫入序列化**：線上以並發請求驗證 `pickKeyRow()` 不會重複挑中同一把金鑰。
2. **AI Gateway 線上行為**：驗證 Custom Provider 拼接、`cf-aig-metadata` 儀表板篩選、`cf-*`／`x-forwarded-for` 轉發處理，並於真實帳號抄錄日誌網址寫入 `AI_GATEWAY_LOGS_URL`。
3. **每日 GHA 排程、真實 KV `list()` 分頁與真實 AI 供應商長串流連線穩定度**。
