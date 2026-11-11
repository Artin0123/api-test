# 架構簡化與實作重構計畫（2026-11-11）

> **文件狀態**：已最終確認待執行計畫（規劃基準對照現行程式碼與 [docs/api-test-擴充需求計畫書.md](./api-test-%E6%93%B4%E5%85%85%E9%9C%80%E6%B1%82%E8%A8%88%E7%95%AB%E6%9B%B8.md)）  
> **目標**：消除歷次疊加留下的冗餘變數、冗餘防線與介面重複控件，讓「設定集中前端管理」、「測試與轉發路徑一致」、「資料庫同步原子化」、「全站統一圖示複製按鈕」與「測試引擎純非串流簡化」一次到位。

---

## 一、拍板項目總覽與分階段執行順序

### Phase 1：本次立即實作項目

| 編號 | 主題 | 現行作法 | 本次改造決策 | 主要影響模組 |
|---|---|---|---|---|
| **P1** | 禁止重複服務商 ＋ `dead_keys` 改以 `fp` 同步 | 允許存兩張相同 `(api_base, provider_type)` 卡片；前端用 `fp#0` 區分，`dead_keys` 取同 host 聯集；刪整張卡片仍留著舊失效鑰 | 前後端存檔一律阻擋重複 `(api_base, provider_type)`；刪除 `_uiKey`／`fp#0`；`dead_keys` 改以 `fp` 隔離（移除跨卡聯集），**刪除服務商卡片時一併清理該 `fp` 的 `results:{fp}` 與 `dead_keys` 紀錄** | `app.js`、`_worker.js` |
| **P2** | 移除分頁冗餘「`重新读取`」按鈕 | 「`测试结果`」「`失效密钥`」「`轮询转发`」頁首皆有「`重新读取`」按鈕 | 移除三處「`重新读取`」按鈕（切換分頁自動重拉，整頁刷新以 `F5` 取代） | `index.html`、`app.js` |
| **P3** | 移除「`失效密钥`」編輯功能 | 表格每列含「`✏️`」編輯按鈕、`#dkedit-overlay` 彈窗與 `PUT /api/dead-keys` | 全面移除編輯介面與 `PUT /api/dead-keys`，只保留自動對帳與批次刪除 | `index.html`、`app.js`、`_worker.js`、`style.css` |
| **P4** | 輪詢單把探測請求改為非串流真實格式 | `testRequestFor()` 送出 `"ping"` 與 `max_tokens: 1` | 改為明確指令 `"only reply 1."`、輸出上限 **`8`**（`max_tokens: 8`／`maxOutputTokens: 8`），維持非串流並併入服務商 `extra_body`（不覆寫用戶的 `extra_body` 設定） | `_worker.js` |
| **P5** | 全域單一「`⏳ 执行中`」膠囊 ＋ 搬移「`立即执行`」 | 每 200 筆與各家上傳 `checkpoint:{fp}`，前端逐家展開進度條；「`立即执行`」放在頂部導覽列 | 改為**單一全域執行狀態**（`/api/run-status`，整批巡檢開始掛上、全部完成後統一清除）；GHA 加掛 `if: always()` 主動清除，並於讀取該狀態的 `GET` 內附帶 **90 分鐘惰性過期**；「`测试结果`」標題旁顯示全域「`⏳ 执行中`」膠囊，並將頂部「`立即执行`」移至「`测试结果`」右上角（對齊「`Gateway 记录 ↗`」樣式） | `async_test_keys.py`、`main.yml`、`_worker.js`、`index.html`、`app.js` |
| **P6** | 消除設定與 `key_state` 脫節漏洞 | `POST /api/settings` 用 `try/catch` 吃掉 `syncKeyState` 錯誤，轉發再做「幽靈刪除」與「首發補列」補救 | 在 D1 模式下使用 `db.batch()` 將寫入 `app_settings` 與同步 `key_state` 包成原子批次（失敗直接報錯不靜默脫節），移除轉發熱路徑上的過度邊界補救程式 | `_worker.js` |
| **P7** | 轉發與單把測試統一強制走 Cloudflare AI Gateway | 沒填 Gateway 變數或 `gateway_provider` 時會靜默退回直連 `api_base` | **移除轉發直連退回模式**：外部 `/proxy/*` 與「`轮询转发`」的「`测试`」按鈕**統一強制經由 Cloudflare AI Gateway** 轉發（未設好 Gateway 直接回 `503` 提示）；`async_test_keys.py` 每日巡檢維持直連 | `_worker.js`、`app.js`、`index.html` |
| **P8** | 用 `alias` 取代 `gateway_provider`（slug） | 服務商編輯器分開填寫 `alias`（給 `/proxy/{alias}`）與 `gateway_provider`（給 `custom-{slug}`） | **移除 `gateway_provider` 欄位**，統一直接以服務商的 `alias` 作為 Cloudflare AI Gateway Custom Provider 的 `slug`（`custom-${alias}`） | `index.html`、`app.js`、`_worker.js`、`mock.json` |
| **P9** | 手動測試成功順便歸零與解除禁用 | 「`轮询转发`」手動「`测试`」／批量測試成功不改 `fail_count` 與 `disabled` | 測試成功時直接執行 `fail_count = 0, disabled = 0`，讓卡片狀態與實際測試結果一致 | `_worker.js`、`app.js` |
| **P10** | 轉發設定全面搬入「`设定`」並從 Logs URL 反拆雙 ID | 轉發密碼、Gateway 帳密／ID／日誌 URL、失敗門檻、重試次數、超時毫秒全散落在環境變數 | 將 `proxy_password`、**單一「`AI Gateway Logs URL`」**（由程式自動拆出 `{account_id}` 與 `{gateway_id}`）、`ai_gateway_token`、`proxy_fail_threshold`、`proxy_max_retries`、`proxy_upstream_timeout_ms` 全部移入網頁「`设定`」彈窗存於 `app_settings`（無須舊環境變數 fallback）；一舉消滅 `AI_GATEWAY_ACCOUNT_ID` 與 `AI_GATEWAY_ID` 兩個獨立欄位 | `index.html`、`app.js`、`_worker.js` |
| **P11** | 全站所有複製按鈕統一為圖示按鈕（含轉發網址） | 「`测试结果`」有 3 處用「`一键复制`」文字鈕、轉發網址為 1.2 秒自創變字、其餘用圖示鈕 | **全站統一改為同一個複製圖示按鈕（`COPY_ICON_SVG`）＋ 共用 `copyText()`（1.5 秒變綠色勾勾）**；轉發網址框單純展示，右側接標準複製圖示鈕，並移除 `copyProxyUrl()` 與文字複製鈕分支 | `index.html`、`app.js`、`style.css` |
| **P12** | 簡化 `async_test_keys.py`：全非串流、僅分 2xx、只於 `401` 熔斷、僅保留 `Ctrl+C` 存檔 | 優先串流＋降級非串流、計量 TTFT、429/408 等 2 秒重測、401/403/balance/quota 熔斷、每 200 筆寫 `checkpoint.json` | **全面改為純非串流（`stream=False`、Gemini 改 `:generateContent`）**，徹底刪除串流解析與 **TTFT（含介面「`avg TTFT`」欄）**；維持 `TOTAL_TIMEOUT = 20.0` 並依原本方式合併 `extra_body`（不強蓋）；移除 `429/408` 重試，**僅區分「`2xx` 成功 vs 非 `2xx` 失敗」**；熔斷跳過收斂為**僅 `HTTP 401`**（免於 `403` 單模型誤殺）；移除 200 筆自動存檔，僅在**單機 `Ctrl+C` 中斷時**即時寫入本機 `checkpoint.json` 供續跑 | `async_test_keys.py`、`app.js`、`mock.json` |
| **P13** | `cf-aig-metadata` 直接傳送完整明文 Key | 傳入 `metadataKeyTag(apiKey)`（前 4 後 4、短於 16 碼改 `a***z`） | 移除 `metadataKeyTag()` 與遮罩邏輯，直接送出 `{"key": apiKey, "provider": alias}`（僅保留過濾換行與非 ASCII 控制字元以免 HTTP 標頭拋錯） | `_worker.js` |

### Phase 2：正式線上環境實測驗證項目

| 編號 | 實測確認項目 | 預期驗證內容 |
|---|---|---|
| **V1** | Cloudflare AI Gateway 真實轉發標頭與日誌 | 於真實帳號建立對應 `alias` 的 Custom Provider（`base_url` 填 `api_base`）後，驗證：① 經真實 Gateway 轉出時上游實收標頭（`cf-*` / `x-forwarded-for` / `cf-aig-*` 是否妥善剝除與注入）；② `cf-aig-metadata`（完整 `key` 與 `provider`）在 Logs 頁能否直接搜尋篩選；③ 從設定拆出的 `account_id` ＋ `gateway_id` 組合轉發網址與開啟日誌頁皆正確無誤 |
| **V2** | `cf-aig-max-attempts: 1` 與轉發重試 | 故意帶一把無效 Key 與一把有效 Key，確認 Gateway Dashboard 只出現 1 筆失敗紀錄後立刻由 Worker 換下一把成功（不會同把壞鑰連打） |
| **V3** | D1 高併發序列挑鑰 | 同時發送 4 筆併發請求，確認在線真實 D1 能正確分配 4 把不同金鑰 |

### Phase 3：確認搬移完成後的退場清理（不立即於 Phase 1 刪除）

| 編號 | 清理項目 | 執行條件 |
|---|---|---|
| **C1** | 移除 `/api/storage/export`、`/api/storage/migrate`、`/api/storage/restore`、`scripts/migrate-kv-to-d1.mjs`、`tests/migrate-script.test.mjs`、`package.json` 的 `migrate` 指令 | 正式站台已確認完成 KV → D1 搬移且穩定運行後再執行 |
| **C2** | 評估移除 KV 模式相容分支（`STORAGE_BACKEND=kv` 與 `KV_STORE` 綁定） | 確認再也不需回滾至 KV 後再清理，讓後端徹底純化為 D1 |

---

## 二、各項關鍵設計與實作細節說明

### 2.1 服務商唯一性、移除 `fp#0` 與卡片刪除連動清理（P1）

1. **存檔唯一性防線**：
   - 前端 `saveEditor()` 與後端 `POST /api/settings` 皆以 `(provider_type, api_base 去尾斜線)` 計算唯一識別（即 `fp`），若發現與其他服務商重複則拒絕儲存（後端回傳 `400` 並清楚提示重複位置，前端於編輯視窗直接顯示錯誤訊息）。
2. **簡化前端與 `dead_keys` 雙向清理**：
   - 刪除 `assignProxyUiKeys()`、`_uiKey`、`syncProxyPlainKeys()` 內針對同 `fp` 多張卡片的匹配邏輯；「`轮询转发`」下拉選單與明文複製配對皆直接使用 `fp`。
   - `dead_keys` 每筆紀錄補入並以 `fp`（同時保留 `provider_host` 供舊紀錄相容或介面搜尋參考）作為對帳與同組詳情去重邊界，徹底移除 `collectConfiguredKeysForHost()` 跨卡片取聯集邏輯。
   - **刪卡／改址同步清除**：當 `POST /api/settings` 偵測到某個 `fp` 已不在最新服務商清單中（代表該卡片被刪除，或更改了 `api_base`/`provider_type`），後端同時清理其 **`results:{fp}`** 與 **`dead_keys` 中對應的紀錄**（若編輯既有卡片刪掉其中幾把金鑰，亦於存檔或下次對帳順手清理，讓「`来源设定`」「`测试结果`」「`失效密钥`」三邊完全同步）。

---

### 2.2 全域單一「`⏳ 执行中`」狀態與雙重防殘留機制（P5）

1. **單一全域鍵取代逐家 `checkpoint:{fp}`**：
   - 儲存層不再為每個 `fp` 單獨存進度，改用**單一全域鍵** `test_run_status`（`{ started_at: "<ISO時間>" }`）與單組端點 `GET / POST / DELETE /api/run-status` 代表「目前是否有一輪巡檢正在執行中」。
   - **何時設定**：`async_test_keys.py` 開始執行前呼叫一次 `POST /api/run-status` 寫入（不再每 200 筆或逐家上傳）。
   - **何時清除（雙保險，無需任何定時器）**：
     1. **正常／中斷即時清除**：`async_test_keys.py` 全部服務商跑完後於 `finally` 呼叫 `DELETE /api/run-status`；且於 [.github/workflows/main.yml](../.github/workflows/main.yml) 加上 `if: always()` 清除步驟——**即使測試腳本中途報錯、手動取消工作流或到達 90 分鐘超時上限，GHA 仍會在結束當下立刻通知站台刪除該鍵**。
     2. **90 分鐘讀取時惰性過期（Lazy TTL 保底）**：`GET /api/run-status` 讀取當下直接檢查 `Date.now() - Date.parse(started_at) > 90 * 60 * 1000`；若已超過 90 分鐘，後端當場刪除該過期鍵並直接回傳 `{ running: false }`，完全不需要背景定時任務。
2. **介面配置簡化**：
   - 「`测试结果`」頁首左側標題旁在執行期間顯示單一「`⏳ 执行中`」膠囊（移除原本每張卡片內的 `checkpoint-bar` 明細列與置頂重排）。
   - 將原本頂部導覽列的「`立即执行`」按鈕移至「`测试结果`」頁首右上角（樣式對齊「`轮询转发`」的「`Gateway 记录 ↗`」，依 `app_settings.github_url` 啟用／停用）。

---

### 2.3 D1 設定同步原子化：消滅「漏建」與「殘留」（P6）

- 在 D1 模式下，`handlePostSettings` 直接將「寫入 `store (app_settings)`」、「刪除消失服務商／已移除金鑰的 `key_state` 列」、「補入新增金鑰的 `key_state` 列」整併進 D1 的 **`env.DB.batch([...])` 單一原子批次**執行！
- 批次失敗則全部一起失敗並回傳錯誤給前端提示，**不再用 `try/catch` 吃掉錯誤，從根源消滅設定與帳本不同步的中間狀態**。
- 隨之移除 `handleProxy()` 內的「幽靈清理 5 次迴圈」與「首發 `COUNT(*)` 補列」邏輯，轉發挑鑰流程回歸乾淨單純的「原子挑鑰 → 送出請求」。

---

### 2.4 強制 Cloudflare AI Gateway 與從 Logs URL 自動反拆雙 ID（P7、P8、P10、P13）

1. **僅填寫一個 `AI Gateway Logs URL`，後端自動反拆雙 ID**：
   - 使用者在「`设定`」彈窗貼上 Cloudflare AI Gateway 日誌頁網址：
     ```text
     https://dash.cloudflare.com/{account_id}/ai/ai-gateway/gateways/{gateway_id}/logs
     ```
   - 儲存設定與轉發組裝時以正規表示式驗證並萃取出 `{account_id}` 與 `{gateway_id}`（網址格式不符時於存檔當下回 `400` 提醒）：
     - 轉發端點自動組為：`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/custom-{alias}{剩餘路徑與 Query}`
     - 「`Gateway 记录 ↗`」按鈕直接使用該組 `AI Gateway Logs URL`。
   - **唯一轉發通道**：外部 `/proxy/{alias}/...` 與「`轮询转发`」的 `POST /api/proxy/test` 統一經由 Cloudflare AI Gateway 送出，移除 `gateway_provider` 欄位並一律直接以 `alias` 作為 slug；若設定未填齊或服務商無 `alias`，回傳 `503`／`400`／`404` 明確錯誤。
2. **「`设定`」彈窗集中管理之轉發參數（直接讀取 `app_settings`，不保留舊環境變數 fallback）**：
   - 既有欄位：`github_url`、`discord_webhook_url`
   - 新增欄位：`proxy_password`（不得等於 `ADMIN_PASSWORD`）、`ai_gateway_logs_url`、`ai_gateway_token`、`proxy_fail_threshold`（預設 `3`）、`proxy_max_retries`（預設 `3`，上限 `3`）、`proxy_upstream_timeout_ms`（預設 `120000`）。
   - 正式環境保留在 Cloudflare 環境變數的僅剩 `ADMIN_PASSWORD`、`STORAGE_BACKEND` 與資源綁定 `DB`（及過渡期 `KV_STORE`）。
3. **Gateway 標頭固定註解與完整金鑰標籤**：
   - 繼續寫入 `cf-aig-max-attempts: 1`，並於程式碼與 `docs/decision-*.md` 明確寫清楚白話原因：**關閉 AI Gateway 對同一把壞鑰的重複重試，把「立即換下一把不同金鑰」的控制權完全留在 Worker 迴圈**。
   - `cf-aig-metadata` 移除 `metadataKeyTag()` 的星號與 `< 16` 字元縮短邏輯，直接傳送 `JSON.stringify({ key: apiKey, provider: alias })`（僅保留清除換行與非 ASCII 控制字元，確保 `fetch()` HTTP 標頭不會拋出 `TypeError`）。

---

### 2.5 探測格式、手動測試恢復、統一圖示按鈕與測試引擎簡化（P4、P9、P11、P12）

1. **「`轮询转发`」單把探測請求（P4）**：
   - `testRequestFor()` 統一改為**非串流**、提示詞 `"only reply 1."`、輸出上限 **`8`**（OpenAI `max_tokens: 8, stream: false`；Anthropic `max_tokens: 8, stream: false`；Gemini `:generateContent` 帶 `maxOutputTokens: 8`），並依原本方式淺合併服務商的 `extra_body`（不做強制覆蓋）。
2. **手動測試成功即清除禁用（P9）**：
   - `POST /api/proxy/test` 收到上游 `2xx` 後執行 `UPDATE key_state SET fail_count = 0, disabled = 0, updated_at = ? WHERE id = ?`，並於回應附帶 `{ fail_count: 0, disabled: false }`，讓「`轮询转发`」卡片立刻恢復正常狀態與更新「有效／无效」計數。
3. **全站統一複製圖示按鈕（P11）**：
   - 將「`测试结果`」裡的 3 處「`一键复制`」文字按鈕（`有效 Key`、`有效模型`、無效 Key 分組標題列），以及「`轮询转发`」的轉發網址列右側，**全數改為使用同一個 `COPY_ICON_SVG` 圖示按鈕（`.copy-btn.btn-icon`）**；刪除 `copyProxyUrl()` 與 `copyText()` 的文字按鈕回饋分支，所有複製操作共用一套 1.5 秒綠色勾勾回饋。
4. **`async_test_keys.py` 簡化與單機 `Ctrl+C` 續跑（P12）**：
   - **請求端**：全面改用 `stream=False`（Gemini 改用 `:generateContent`），維持 `TOTAL_TIMEOUT = 20.0` 秒、`extra_body` 按原順序合併覆蓋；徹底刪除 `parse_stream()`、`extract_stream_chunk()`、`TTFT_TIMEOUT`，並從前端 `renderPerfTable()` 移除「`avg TTFT`」欄。
   - **判定端**：移除 `(401, 403, 404, 400, 429, 408)` 降級與 `429`/`408` 等 2 秒重試分支，統一為 **HTTP `200..299`（且取得正文或思考內容）才算成功，其餘非 `2xx` 與連線／超時異常一律視為失敗**並保留供應商原文。
   - **熔斷跳過收斂**：僅在明確收到 **`status == 401`** 時將該 Key 加入 `dead_keys` 跳過同一服務商後續尚未發出的模型請求（移除 `403`、`balance`、`quota` 判死，避免個別模型權限受限誤殺整把金鑰）。
   - **本機斷點續跑**：刪除每 200 筆自動寫檔，僅保留單機執行途中收到 **`Ctrl+C`（`KeyboardInterrupt`／任務取消）時**即時將記憶體中已完成進度存進 `checkpoint.json`，以便單機手動重跑接續；正常跑完則輸出結果並清除暫存 `checkpoint.json`。

---

## 三、受影響檔案、測試與文件同步清單

1. **程式碼**：[public/index.html](../public/index.html)、[public/app.js](../public/app.js)、[public/style.css](../public/style.css)、[public/_worker.js](../public/_worker.js)、[public/mock.json](../public/mock.json)、[async_test_keys.py](../async_test_keys.py)、[.github/workflows/main.yml](../.github/workflows/main.yml)。
2. **測試套件（[tests/worker.test.mjs](../tests/worker.test.mjs) 與 [tests/frontend.test.mjs](../tests/frontend.test.mjs)）**：
   - 更新並補齊：重複 `(api_base, provider_type)` 阻擋與刪卡連帶清 `results`/`dead_keys` 測試、移除 `PUT /api/dead-keys` 確認、強制走 Gateway 測試、Logs URL 反拆雙 ID 與無效 URL 阻擋測試、以 `alias` 作為 slug 測試、`cf-aig-metadata` 明文帶出測試、手動測試成功自動歸零解禁測試、全域 `/api/run-status` 與 90 分鐘惰性過期測試，以及前端移除「`重新读取`」／`dkedit` 彈窗／`avg TTFT`、`立即执行` 移位與全站統一圖示複製按鈕的 DOM/CSS 檢查。
3. **文件同步**：
   - 依 [AGENTS.md](../AGENTS.md) 規範更新設計決策紀錄並改名至更新當日日期（`docs/decision-*.md`）。
   - 同步更新 [README.md](../README.md)（精簡環境變數清單與操作步驟）與 [docs/architecture.md](./architecture.md)（更新流程圖與規則表格）。

---

## 四、Phase 1 實作進度追蹤

- [x] **Batch 1（P1, P3, P6, P8）**：禁止重複服務商與移除 `fp#0`、移除 `dead_keys` 編輯功能、改用 `fp` 對帳與刪卡連動清理、`db.batch()` 原子同步設定與 `key_state`（移除熱路徑幽靈／補列防線）、移除 `gateway_provider` 改由 `alias` 取代
- [ ] **Batch 2（P4, P7, P9, P10, P13）**：強制經由 Cloudflare AI Gateway（從 Logs URL 反拆雙 ID）、轉發設定與密碼搬入「`设定`」彈窗、`cf-aig-metadata` 明文送出、`only reply 1.` / `max_tokens: 8` 非串流探測、手動測試成功自動歸零並解除禁用
- [ ] **Batch 3（P2, P5, P11, P12 UI）**：移除各分頁「`重新读取`」、全域 `/api/run-status`（90 分鐘惰性過期）與「`⏳ 执行中`」膠囊、「`立即执行`」移入「`测试结果`」、移除「`avg TTFT`」欄、全站統一為複製圖示按鈕
- [ ] **Batch 4（P5 GHA/Python, P12 Engine）**：`async_test_keys.py` 純非串流、僅分 `2xx`／非 `2xx`、僅 `401` 熔斷、僅保留 `Ctrl+C` 寫入 `checkpoint.json`、前後連動 `/api/run-status` ＋ `.github/workflows/main.yml` 加入 `if: always()` 清除狀態
- [ ] **Batch 5（文件與最終驗證）**：更新並改名 `docs/decision-*.md`、更新 `docs/architecture.md` 與 `README.md`、全套語法與離線測試驗證通過
