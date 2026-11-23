# Pages 直連轉發 + D1 背景紀錄遷移說明與實測報告（2026-11-23）

## 一、背景與改動動機

目前 `/proxy/:alias/*` 與手動探測 `/api/proxy/test` 均固定透過 **Cloudflare AI Gateway (`custom-{alias}`)** 轉發至上游供應商。最初採用 AI Gateway 是為了直接取得請求日誌與流量統計，但實際使用與壓測後發現三個明確痛點：

1. **冷啟動延遲偏高**：久未請求的第一發常額外多出 **`~600ms ~ 1400ms`**，體感上有明顯卡頓。
2. **熱態多一層轉發開銷**：即使在連續請求的熱態下，AI Gateway 層仍會額外吃掉 **`~120ms ~ 180ms`**。
3. **維運繁瑣**：每新增或更改供應商，都必須額外到 Cloudflare AI Gateway 後台同步維護對應的 Custom Provider `alias`、設定 `ai_gateway_logs_url` 與 `ai_gateway_token`。

因此計畫將轉發架構調整為：**由 Cloudflare Pages Worker 直接轉發至上游 `provider.api_base`，並透過 `ctx.waitUntil(...)` 在背景非同步將精簡請求紀錄寫入 D1**（不阻塞主回應路徑）。

---

## 二、實測過程與驗證數據

### 2.1 測試環境與方式

- **測試日期**：2026-11-23
- **發起端與節點**：由台灣本機發起 HTTPS 請求；Cloudflare Pages 落點透過回應標頭 `cf-ray` 確認皆為 **`TPE`（台北邊緣節點）**；D1 為線上生產庫。
- **對照組**：現有部署於 Railway 美西（`SJC`）＋ Supabase 的 `GPT_LOAD`。
- **拆解方法**：
  1. **Pages 邊緣層開銷**：連續 4 次請求 `/api/health`（不讀寫 D1），分別記錄第 1 次冷啟動與第 2–4 次熱態 RTT。
  2. **Pages + D1 讀取開銷**：登入取得 Session Cookie 後，連續 4 次請求 `/api/settings`（讀取 D1），扣除純邊緣 RTT 估算 D1 單次讀取耗時。
  3. **端點實測對比（`Direct` 本機直連 vs `API_TEST` 現況 Pages+D1+AIG vs `GPT_LOAD`）**：
     - 針對 6 組已設定供應商（`groq`、`google`、`deepseek`、`alibaba-cn`、`nvidia`、`vercel`），統一使用極短生成請求（`max_tokens: 8` / `maxOutputTokens: 8`；`google` 走 `/v1beta/models/{model}:generateContent` + `x-goog-api-key`，其餘走 `/v1/chat/completions` + `Bearer`）。
     - **第一階段（6 端點 × 3 輪）**：依序對每個端點跑 3 輪，區分第 1 次冷啟動與第 2–3 次熱態平均。
     - **第二階段（`google` 專項 8 輪統計）**：因第一階段 3 次樣本中 `Direct` 與 `API_TEST` 出現單次 5.7s 尖峰、而 `GPT_LOAD` 剛好未遇到，為確認是否為測試樣本數過少造成的誤差，對 `google`（`gemini-3.5-flash-lite`）連續執行 8 輪交替實測，統計 `min`、`P50`（中位數）、`max`、`avg`。

### 2.2 基礎層延遲拆解實測

| 測試路徑 | 冷啟動（第 1 次） | 熱態穩定值 | 拆解估算 |
| :--- | :--- | :--- | :--- |
| **純 Pages Edge**（`/api/health`） | `137ms` | **`20 ~ 24ms`** | Edge 本身冷啟動僅多 ~115ms |
| **Pages + D1 讀取**（`/api/settings`） | `126ms` | **`74 ~ 90ms`** | 扣除 Edge 後，**D1 讀取約 `55 ~ 65ms`** |

> 結論：Pages Worker + D1 選 Key 本身合計僅約 **`~80ms`**（冷啟動也僅約 `~130ms`），並非造成延遲的主因。

### 2.3 第一階段：6 端點 × 3 輪實測結果

| 端點 | 模型 | 本機直連 Direct（熱態均） | API_TEST 現況（冷啟動 / 熱態均） | GPT_LOAD（熱態均） |
| :--- | :--- | :--- | :--- | :--- |
| **`groq`** *(快模型最準)* | `qwen/qwen3.8-27b` | **231ms** (`203 / 258`) | 冷 `1007~1500ms` / **430ms** (`440 / 419`) | **281~608ms** *(穩時 ~280ms)* |
| **`deepseek`** *(亞洲)* | `deepseek-flash` | **749ms** (`855 / 642`) | 冷 `1321~1662ms` / **980ms** (`775 / 1185`) | **954~1003ms** |
| **`alibaba-cn`** *(亞洲)* | `deepseek-v4.1-flash-1017` | *(首把 Key 403)* | 冷 `2366~2667ms` / **1231~1304ms** | **863~891ms** |
| **`google`** *(美西)* | `gemini-3.5-flash-lite` | **3447ms** (`5979 / 914`) | 冷 `1502ms` / **3378ms** (`5721 / 1034`) | **982ms** (`1065 / 898`) |
| **`nvidia`** | `meta/muse-glimmer-30b` | **21618ms** *(上游波動大)* | 冷 `6845ms` / **2773~3351ms** | **3256ms** *(偶發慢)* |
| **`vercel`** | `meta/muse-ember` | **1514ms** (`1922 / 1106`) | 冷 `2332~2991ms` / **1247~1393ms** | **961~1044ms** |

以回應最快的 `groq` 拆算：`API_TEST` 熱態 `430ms` 扣除本機直連 `231ms` 與 Pages+D1 `~80ms`，**AI Gateway 熱態額外開銷約 `~120ms`**；而第 1 發 `1007~1500ms` 相較純 Pages 冷啟動（`~130ms`）則多出了 **`~800~1000ms`** 的 AIG 冷啟動開銷。

### 2.4 第二階段：`google`（`gemini-3.5-flash-lite`）8 輪統計驗證

| 路線 | 成功率 | 最小值 (min) | **中位數 (P50)** | 最大值 (max) | 平均值 (avg) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **本機直連 Direct** | 8/8 | **514ms** | **718ms** | `5577ms` *(4s+ 抽風 2 次)* | `1807ms` |
| **`API_TEST`（含 AIG）** | 8/8 | **721ms** | **1144ms** | `4648ms` *(4s+ 抽風 1 次)* | **`1547ms`** |
| **`GPT_LOAD`（SJC）** | 8/8 | **737ms** | **1139ms** | `5888ms` *(5s+ 抽風 2 次)* | **`2151ms`** |

- **推翻 3 輪樣本誤判**：拉長至 8 輪後，`GPT_LOAD` 同樣出現 `5888ms` 與 `5438ms` 的尖峰，證明 `4~6 秒` 抖動是 **Google 上游模型端自身的偶發排隊波動**，與 Cloudflare 或台灣網路地域無關。
- **常態速度（P50）比較**：本機直連 P50 僅 **`718ms`**，加上 Pages + D1 讀 Key 的 **`~80ms`**，若改為 Pages 直連，常態 P50 預估落在 **`~800ms`** 左右，將明顯優於目前含 AIG 的 **`1144ms`** 以及 `GPT_LOAD` 的 **`1139ms`**。

### 2.5 實測總結

改為 **Pages 直連上游 + `ctx.waitUntil` 寫 D1** 後：
- **冷啟動額外延遲**：由 `+600ms ~ +1400ms` 降至 **`+50ms ~ +110ms`**。
- **熱態額外延遲**：由 `~200ms ~ 260ms` 降至 **`~80ms`**（D1 背景寫入不計入回應耗時）。
- **整體效能**：不論 `groq`、`deepseek` 或 `google`（P50），常態速度均可追平甚至優於 `GPT_LOAD`，且架構完全收斂回 Pages + D1，無須再維護 AI Gateway Custom Provider。

---

## 三、預計改動範圍（Scope）

以下列出遷移所需調整的模組範圍，供實作者依序展開：

1. **D1 Schema 與儲存層（`src/storage-d1.js`，並考量 `STORAGE_BACKEND` 雙後端相容）**
   - 新增請求紀錄資料表（如 `proxy_logs`）：記錄時間戳、供應商 `alias`、`provider_type`、`model`、請求路徑、金鑰遮罩/指紋、HTTP 狀態碼、耗時 `latency_ms`、是否串流與精簡錯誤摘要等。
   - 新增背景寫入、分頁查詢、依條件篩選與自動／手動清理機制（控制保留筆數或天數，避免超過 D1 容量與讀寫額度）。
   - 若需維持 `STORAGE_BACKEND=kv` 相容，KV 模式需決定略過明細 log 或提供降級實作。

2. **轉發與手動探測核心（`src/proxy.js`、`src/proxy-handlers.js`、`src/entry.js`）**
   - 調整 `upstreamFor()` 與目標 URL 組裝：改為直接拼接 `provider.api_base` 與請求路徑（或設計成「可選直連／AIG 雙模式」，預設直連上游）。
   - 移除僅供 AI Gateway 使用的請求標頭（`cf-aig-authorization`、`cf-aig-skip-cache`、`cf-aig-max-attempts`、`cf-aig-request-timeout`、`cf-aig-metadata` 等）。
   - 補上 Worker 端請求逾時控制：原本依賴 `cf-aig-request-timeout`，直連後需使用 `AbortSignal.timeout(proxyTimeoutMs(settings))`（或 `AbortController`）保護每次上游嘗試，並確保不誤斷 SSE 串流讀取。
   - 將 Pages `context.waitUntil` 傳入 `handleProxy()` 與 `handleProxyTest()`，於送出回應後非同步寫入 D1 請求紀錄。

3. **設定與驗證邏輯（`src/settings.js`、`src/settings-handlers.js`）**
   - 放寬或移除 `ai_gateway_logs_url` 與 `ai_gateway_token` 的強制檢核（依最終採用「全面直連」或「雙模式切換」決定）。
   - 確認 `provider.alias` 僅作為 `/proxy/:alias/*` 路由識別與紀錄分組依據，不再依賴 AI Gateway 後台的 `custom-{alias}`。

4. **管理端點 API（`src/entry.js` 與對應 handler）**
   - 新增受登入保護的請求紀錄 API，例如查詢（支援分頁、供應商／狀態碼篩選）與清空／清理紀錄端點（如 `GET /api/proxy/logs`、`DELETE /api/proxy/logs`）。

5. **前端介面（`public/index.html`、`public/js/proxy*.js`、`public/js/settings*.js`、`public/app.js`）**
   - 設定頁調整：移除或弱化 AI Gateway 必填欄位說明，視需要增加紀錄開關或保留上限設定。
   - 新增「請求紀錄」檢視介面（分頁列表、狀態/耗時/錯誤檢視、篩選與清理按鈕），補齊原本依賴 AI Gateway Dashboard 的觀測能力。

6. **測試與文件同步（`tests/worker.test.mjs`、`tests/frontend.test.mjs`、`README.md`、`docs/decision-*.md`）**
   - 更新原本驗證 `gateway.ai.cloudflare.com` 與 `cf-aig-*` 標頭的測試案例，補齊直連 URL 組裝、Worker 端逾時中止、`waitUntil` 背景寫入及 `/api/proxy/logs` 測試。
   - 實作完成後同步更新 `README.md` 與決策文件（`docs/decision-*.md`）。
