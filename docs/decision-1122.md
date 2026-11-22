# 決策說明（最後更新 2026-11-22）

**本文件持續維護**，記錄「失效密鑰分頁」、「錯誤訊息改造」、「單一 Key 連跑兩輪」、「API 認證」以及「KV → D1 與輪詢轉發」中各項設計的**取捨理由、實作陷阱與承受代價**。修改上述行為時請同步更新本文件，並將檔名日期改為當次更新日。

---

## 一、測試結果的錯誤訊息

### 1.1 以供應商原文取代人工歸類文字

- **問題與決策**：原本人工分類標題會讓未預先對應的狀態碼（如 402 餘額不足）全數落入 `Unknown Error`。改為由 `parse_error_body()` ＋ `pick_error_message()` 擷取供應商原文作為 `error_reason`，僅在完全取不到回應本文（如連線失敗）時退回系統說明；同時移除冗餘的逐模型 `failed_models_details`。

### 1.2 解析時機：截斷之前

- **實作陷阱**：早期先執行 `error_body = err[:512]` 再解析，導致超過 512 字元的 JSON（如 OpenAI 401 回應）被切斷而 `json.loads` 失敗、畫面只剩半截原始字串。改為在錯誤本文仍完整時先解析成結構化 `error_detail`，再將其中**每個欄位**限制上限 512 字元；讀取舊版 checkpoint 缺少 `error_detail` 時退回解析 `error_body`／`error`。

### 1.3 分組與去重鍵：`error_code` ＋ 正規化訊息

**問題**：供應商常在錯誤訊息中嵌入 Key 尾碼（如 `****2fb7`），逐字比對會讓每把 Key 各自成組，只比對 `error_code` 則會把同狀態碼的不同原因誤併（66 把無效 Key 實測含 4 種獨立原因：逐字比對裂成 64 組、只比狀態碼縮成 2 組吃掉 2 種原因、取前 30 字元裂成 11 組、正規化後準確分成 4 組）。

**決策**：`normalize_message()`（Python）與 `normalizeMessage()`（JS）先將 Key 本體／遮罩尾碼換為 `<key>`、8 位以上 hex ID 換為 `<id>`、數字換為 `<n>` 後再比對。

- **不採用「取前 X 字元」的原因**：動態片段位置不固定（第 28 與第 36 字元皆有實例），縮短 X 又會誤併開頭相同的不同原因（如 `deactivated` 與 `suspended`）。
- **可接受副作用**：僅差在數字的兩種原因（如 `100/min` 與 `1000/min`）會合併為同一組。

### 1.4 保留各自 `error_reason`，僅對 `error_detail` 去重

覆寫整組 `error_reason` 會永久抹除同組其他失敗原因。單一供應商 66 把 Key 實測顯示：保留各自 `error_reason` ＋ 對多欄位物件 `error_detail` 去重（13,717 bytes），僅比全部覆寫多 1,736 bytes（佔 KV 單值上限 25 MB 的 0.0069%），並較完全不去重（22,816 bytes）省下近 40% 空間。

### 1.5 跨語言正規化差異與相容限制

Python 負責寫入時保留哪筆 `error_detail`，JS 負責渲染時即時分組（讓 KV 內舊結果不需重跑即可套用新規則）。兩端規則必須同步，且須避開兩個引擎的語法差異：

| 語法 | Python `re`                           | JavaScript `RegExp`            | 實測差異                               |
| ---- | ------------------------------------- | ------------------------------ | -------------------------------------- |
| `\d` | 匹配全形數字 `１２３４`               | 僅匹配 ASCII `0-9`             | 中文訊息含全形數字時兩端遮蔽結果相反   |
| `\b` | CJK 算 word 字元，`码abcdef12` 無邊界 | CJK 不算 word 字元，該處有邊界 | 中文後緊接 hex ID 時兩端遮蔽範圍不一致 |

- **解法**：兩邊皆改用明確字元類別 `[0-9０-９]`，邊界使用捕獲前導字元 `(^|[^a-z0-9])` ＋ 前瞻 `(?![a-z0-9])`（經 27 組非 ASCII／邊界測試驗證一致）。
- **不用 lookbehind `(?<!...)`**：Safari 16.4 以下版本會在解析期直接報錯導致整份 `app.js` 無法執行，遠高於其餘程式碼要求的 Safari 13.1 門檻。
- **不共用的原因與容錯**：專案維持無建置步驟，無法共用模組；若兩邊規則暫時不同步，前端在找不到對應 `error_detail` 時會退回以該組錯誤訊息組成 `{message}`，確保 📋 詳情視窗仍有原文可看。

### 1.6 顯示截斷與 `error_code` 來源對齊

群組標題截斷至 120 字元（完整原文置於 `title` 與詳情視窗），Python 端將 `error_reason` 壓在 200 字元並去除換行。進入備援說明分支時，`error_code` 必須取該備援文字自身的狀態碼，避免併發下先 429 後 401 時顯示成 `429 · ... 401`。

---

## 二、失效密鑰分頁（`dead_keys`）

### 2.1 儲存結構：單一 `dead_keys` 陣列

將清單存為單一 KV 鍵，避免拆成多鍵後每次列表讀取都得執行 `list()` ＋ N 次 `get()`。代價是每次 CRUD 皆為「讀取—修改—寫入」（無並發寫入鎖、受同一鍵每秒 1 次寫入限制），在單一管理員情境下接受。

### 2.2 雙重去重（依 `fp` 隔離）與結構交棒（再平衡）

`api_key` 在同一個服務商作用域（`fp`，舊資料無 `fp` 時退回 `provider_host`）下不重複；`error_detail` 依 `(fp, error_code)` 僅於同組第一筆保留（不同 `provider_type` 即便同主機域名也不互相覆蓋或繼承詳情）。刪除或換碼離組時，若原本持有 `error_detail` 的列離開該組，必須透過 `rebalanceErrorDetail()` 將 `error_detail` 轉移給同組下一筆列，否則同組剩餘列會因 `error_detail: null` 而集體遺失詳情資料。

### 2.3 自動對帳與「來源設定」連動清理

`POST /api/results` 上傳時透過 `syncDeadKeysFromResults()` 以該服務商的 **`fp`** 為作用域自動對帳：來源設定該卡片內仍存在且失敗的 Key 自動寫入（附帶 `fp` 與 `provider_host`），已恢復（`valid_keys`）的 Key 自動刪除。**新增與刪除必須成對實作**：有了自動恢復刪除，系統才敢於紀錄 429／500 等暫時性失敗，而不會將正常 Key 永久釘在清單上。

- **嚴禁重複服務商與取消手動編輯**：前端 `saveEditor()` 與後端 `POST /api/settings` 皆拒絕相同 `(provider_type, api_base)` 的重複卡片（`400`），徹底移除早年為容忍重複卡片而存在的 `_uiKey`（`fp#0`）與同主機聯集（`collectConfiguredKeysForHost()`）；同步移除「`失效密钥`」單筆編輯彈窗與 `PUT /api/dead-keys` 端點，將清單嚴格收斂為來源對帳與批次刪除。
- **刪卡／刪 Key 連動清理**：於「`来源设定`」刪除卡片、更改 `api_base`/`provider_type` 或從編輯區刪除部分金鑰時，`POST /api/settings` 會一併刪除已消失卡片的 `results:{fp}`，並從 `dead_keys` 移除已不在該卡片清單內的紀錄（同時執行 `rebalanceErrorDetail()`），免去以往刪卡後殘留幽靈死鑰的問題。
- **兩階段狀態碼同步**：因 Python 上傳與現存的 `error_detail` 持有者可能不同，先於換碼階段對變更 `error_code` 的列執行舊組交棒與清空自身 detail，再於 `(fp, error_code)` 群組刷新階段比對本次非空 detail 決定是否更新 KV（空本文不覆寫既有詳情）。

### 2.4 批次刪除與前端實作注意細節

- **批次刪除**：`DELETE /api/dead-keys` 支援 `ids: string[]`，讀一次、執行一次 `rebalanceErrorDetail()`、寫回一次並直接回傳更新後陣列，避免 N 筆逐一刪除。
- **常駐篩選、移除重讀鈕與響應式金鑰遮罩**：移除獨立篩選收合、手動新增列與「`重新读取`」／單筆編輯鈕，保留常駐 `.dk-filter-panel`、純數字日期格式化（起訖日期預設留空以顯示全部紀錄，需縮小範圍時再填入或點「`清除筛选`」重置）、固定欄寬 `table-layout: fixed`（無日期／無 Code 置底）與切換分頁自動重拉。桌機採用 `maskKey()`（左 6 ＋ 1～3 `*` ＋ 後 3），手機端採用 `maskKeyMobile()`（左 6 ＋ 1～3 `*` ＋ 後 1）；篩選下拉選單統一與輪詢轉發相同格式，依 `fp` 以 `providerFormatLabel()` 呈現「`名稱 - 格式`」，表格欄位則維持單卡顯示 `providerDisplayName()`（`別名 || host`）、同主機多卡加註 `名稱 - 格式`。
- **桌機乾淨平面下拉選單增強（手機保留原生）**：`enhanceSelect()` 於桌機漸進強化為 `.custom-select-trigger` 搭配依實測寬度鎖定的 `.custom-select-menu`，手機與觸控端退回原生 `<select>`（樣式比較預覽頁已於 2026-11 移除）。

---

## 三、單一 Key 連跑兩輪、純非串流與狀態簡易化

當服務商只有 1 把 Key 時缺乏交叉驗證，因此設 `runs_per_pair = 2`（兩輪間隔 `SINGLE_KEY_RERUN_DELAY = 2.0` 秒）。

- **為何不用「佇列塞入兩次」**：併發 ≥ 2 時兩輪會同時發出而使 2 秒間隔失效，須在單一 worker 迴圈內依序執行。
- **純非串流與 `2xx`／非 `2xx` 二分法**：串流模式下不支援串流的端點常回報與總耗時完全相同的假性 TTFT，失去辨別意義；改採純非串流（`stream=False`、Gemini 改打 `:generateContent`，維持 `TOTAL_TIMEOUT = 20s`），移除 `TTFT_TIMEOUT`、`parse_stream`、`429`/`408` 重試與串流降級，嚴格以 **HTTP `200..299` 且含正文／思考內容為成功**，並自結果頁移除 `avg TTFT` 欄。
- **熔斷與本機 `Ctrl+C` 續跑規則**：為避免單一模型權限或配額誤殺整把金鑰，熔斷僅限明確的 **`HTTP 401`**（取消 `403`／`balance`／`quota` 跳過），觸發後立即跳過第二輪與後續模型；移除每 200 筆寫檔與 `/api/checkpoint`，改由單一全域 `/api/run-status`（`test_run_status`）在「`测试结果`」標題旁呈現全局 `⏳ 执行中`（GHA 結束一律透過 `if: always()` 清除並附 `GET` 90 分鐘惰性過期保底），本機執行僅在 **`Ctrl+C` 中斷**時將未完進度存至 `checkpoint.json` 供單機手動重跑接續。

---

## 四、樣本長度上限

`MAX_OUTPUT_TOKENS = 512` 無法約束忽略該參數或另計推理 Token 的供應商。採 `SAMPLE_MAX_LEN = 2048`（`content` 與 `thinking` 分開計算）作為安全網：

- **保留頭尾各 1024 字元**：推理模型結論常落在結尾，只留前段會將最終答案裁切掉。
- **為何不放寬 `MAX_OUTPUT_TOKENS`**：放寬會讓長輸出模型轉為觸發 `TOTAL_TIMEOUT = 20s`，由內容被截斷惡化為整筆超時失敗。
- **驗證與冪等順序**：`answer_verified` 必須於截斷前以完整回應判斷（`async_test_keys.py:542-544`）；帶 `CLIP_MARK` 字串直接原樣返回，防止舊 checkpoint 恢復匯總時被二次截斷。
- **本機斷點 `401` 續跑保真**：從 `checkpoint.json` 恢復時同步保留該服務商 `dead_keys` 的 `401` 錯誤紀錄，並僅清除吻合當前服務商的暫存檔，避免續跑後遺失錯誤碼或誤刪其他服務商中斷檔。

---

## 五、KV 操作稽核

- **寫入量（免費上限 1,000／日）**：單一服務商 600 任務約 5～6 次寫入，10 個服務商每日排程約 60 次（穩定無異動時約 50 次）。
- **讀取量（免費上限 100,000／日）**：無任何背景自動輪詢（無 `setInterval`／`visibilitychange` 刷新），僅使用者主動切換／重讀與排程對帳時讀取，10 個服務商每次瀏覽結果頁約 20 次讀取。
- **已知限制**：`dead_keys` 為單一鍵讀改寫，理論受限於每秒 1 次寫入，目前因每日排程依序執行各服務商且耗時數分鐘而不會衝突；若日後改為多服務商並行上傳結果，須重新評估鎖定機制。

---

## 六、API 認證與權限隔離

### 6.1 `GET /api/results` 改為需認證

`results` 含明文 Key，且查詢鍵 `fp = SHA-256(api_base + provider_type)` 皆為公開可窮舉資訊；加上頁面載入本就須先驗證 `/api/settings`，補上 `requireAuth` 屬零功能損失的安全修正。

### 6.2 瀏覽器憑證採用無狀態 HttpOnly Session Cookie

| 候選方案                           | 不採用或採用理由                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `localStorage` ＋ Bearer           | 直接存放 `ADMIN_PASSWORD`，一次 XSS 即永久外洩且無法在網址列直接檢視 API                                                                                                                                     |
| HTTP Basic Auth                    | 缺乏標準登出語意，憑證會被快取至關閉瀏覽器且無法使用 `SameSite`                                                                                                                                              |
| 簽章 Query Token                   | 會暴露於瀏覽器歷史、Referer 與 Cloudflare 存取日誌                                                                                                                                                           |
| Cloudflare Access                  | 強綁 Dashboard 額外設定，GHA 端須改用 Service Token                                                                                                                                                          |
| **無狀態 HttpOnly Cookie（採用）** | XSS 無法竊取、支援即時登出與網址列直開 JSON；採 `<到期毫秒>.<HMAC>` 避免每次請求多讀一次 KV（及受最終一致性影響）。代價是無法個別撤銷單一 cookie，全域撤銷須更換 `ADMIN_PASSWORD` 或調升 `SESSION_VERSION`。 |

`localStorage` 僅保留不具認證效力的 `atk_signed_in` 旗標，供 `index.html` 在首次繪製前預先隱藏登入遮罩避免畫面閃爍；真正驗證於 `bootstrap()` 請求 `/api/settings` 完成。供腳本與 GHA 使用的 Bearer 路徑維持不變。

### 6.3 CSRF 防護：`SameSite=Strict`

因寫入端點 `request.json()` 不檢查 `Content-Type`（跨站 `<form enctype="text/plain">` 仍可送出 JSON 並帶上 cookie），系統完全依賴 `SameSite=Strict; Path=/api` 阻擋跨站請求攜帶 cookie（代價是從外部站點點連結跳轉 `/api/...` 會見 401，刷新即可）。

### 6.4 獨立的轉發密碼（`proxy_password`）與設定集中管理

轉發端點須發給外部軟體使用，因此轉發密碼嚴格不可與 `ADMIN_PASSWORD` 相同（存入時與執行期皆拒絕同值）。為避免調整門檻、輪換密碼或貼上 Gateway 網址時每次都要重設 Cloudflare 環境變數與重部署，`proxy_password`、`ai_gateway_logs_url`、`ai_gateway_token`、`proxy_fail_threshold`、`proxy_max_retries` 與 `proxy_upstream_timeout_ms` **已統一移入前端「`设定`」彈窗並存於 `app_settings`**（不再讀取舊版環境變數）；後端直接從 `ai_gateway_logs_url` 解析 `{account_id}` 與 `{gateway_id}` 並拒絕不符格式的 URL（`400`）。入站驗證仍支援 `Authorization: Bearer`、`x-api-key` 與 `x-goog-api-key`。

---

## 七、瀏覽器端防護與設定並發

### 7.1 安全標頭寫入 Worker 出口

Cloudflare `_headers` 檔案不套用於 Pages Functions 回應（且 `env.ASSETS.fetch()` 行為於官方文件中有衝突），故於 worker 出口統一以 `withSecurityHeaders()` 附加 CSP、`nosniff`、`X-Frame-Options`、`Referrer-Policy` 與 `Permissions-Policy`。

### 7.2 嚴格 CSP 的實作陷阱

- **主題預載腳本**：將防閃爍 inline script 獨立至 `public/boot.js`，避免每改一行就得重算 CSP hash。
- **禁用 `style=""` 與 CSS 特異性回歸**：將所有行內樣式改為 class（CSSOM `_mirror.style` 不受 CSP 限制）。轉換後 `.topbar-menu-close` 曾因宣告順序早於 `.btn-ghost` 而退回有框按鈕，須提升選擇器特異性為 `.btn-ghost.topbar-menu-close` 才能穩定生效。
- **白名單例外**：`connect-src` 僅放行 `discord.com`／`discordapp.com`（供瀏覽器端測試通知）；`img-src` 須保留 `data:` 以載入 SVG favicon 與下拉箭頭。

### 7.3 設定並發控制與不設登入限流

- **`app_settings` 樂觀鎖**：以 `version` 欄位將跨分頁同時存檔的靜默覆蓋轉為看得見的 `409 Conflict`（前端收到後重拉最新設定）；刻意放行不帶 `version` 的請求以利 `curl` 手動搶修；「`设定`」彈窗僅回傳自身管理的全域／轉發設定欄位避免夾帶過時 `providers[]`。
- **`dead_keys` 規模**：因同一把 Key 不重複新增，清單上限僅等於來源設定不重複 Key 總數，不會隨天數膨脹，故不做筆數截斷。
- **登入不設速率限制**：WAF 免費版只有 1 條 10 秒窗規則效果極弱，而 KV 計數反而會讓攻擊者用幾百次錯誤登入耗盡每日 1,000 次寫入額度（把認證問題變為可用性故障），故依賴高熵密碼防護。

---

## 八、依賴管理與開發環境注意

專案遵守 `AGENTS.md` 約束，不建立 `wrangler.toml`，所有正式設定皆走 Dashboard；本機執行 `npm run dev` 若遇 `workerd` 支援日期比當天慢一天，須手動補充 `--compatibility-date`。此外本機根目錄執行時若受 `.wrangler/` 殘留快取影響，曾觀察到 `/api/*` 未進 worker 而落入靜態 404 的現象（乾淨目錄下正常），異常時可清理本地狀態後重試。

---

## 九、自定義請求頭（Custom Headers）

- **陣列格式 `[{ key, value }]`**：維持 UI 輸入順序並避免編輯同名或特殊字元時發生 JSON 鍵衝突。
- **後置覆蓋**：於預設標頭（含協定認證標頭）建立完成後注入，使特殊供應商能覆蓋預設 `User-Agent` 或認證標頭。
- **RFC 7230 與 CRLF 消毒**：前端阻擋不合規範的標頭名稱並移除值內 `\r\n`；Python 端再次過濾並僅略過非法項而不中斷整輪測試。

---

## 十、已知取捨總表

| 取捨項目                    | 採用方案                                                                      | 承受代價                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 瀏覽器認證與儲存            | HttpOnly Cookie（無狀態 HMAC）                                                | 依賴 `SameSite=Strict` 防 CSRF；無法撤銷單一 cookie；更換 `ADMIN_PASSWORD` 會使所有已登入瀏覽器失效           |
| 安全標頭位置                | Worker 出口統一附加                                                           | 多一層包裝（因 `_headers` 對 `_worker.js` 無效）                                                              |
| `app_settings` 並發         | 樂觀鎖 `version` ＋ 409                                                       | 仍存在毫秒級競爭窗，但不再靜默覆蓋                                                                            |
| `dead_keys` 並發與生命週期  | 單一 KV 陣列、每日結果依 `fp` 對帳 ＋ 刪卡清理                                | 不保留已恢複歷史；刪卡與刪除金鑰時由 `POST /api/settings` 同步掃除並交棒 `error_detail`                       |
| 錯誤分組與樣本裁切          | 正規化訊息去重；樣本各限 2048 字元掐頭留尾                                    | 僅數字不同的原因會合併；超長回應中段省略；Python／JS 正規化須手動同步                                         |
| 單一 Key 測試次數           | 純非串流連跑兩輪；`Ctrl+C` 本機斷點＋全局 `run-status`                        | 單 Key 服務商請求數加倍；正常跑完不寫進度檔，改靠全局執行狀態指示與 90 分鐘過期保底                           |
| 儲存後端預設值              | 未填 `STORAGE_BACKEND` ＝ `d1`                                                | 僅綁定 KV 的舊站台直接升級新版會全數 500；須按 README 順序搬移上線                                            |
| `store` 與 `key_state` 分工 | `store` 存 JSON、`key_state` 為關聯表；D1 批次交易                            | 設定更新、過期結果／死鑰清除與 `key_state` 同步由 `db.batch()` 原子執行，失敗直接回滾不留幽靈列               |
| 搬移與還原備份              | 先備份 KV 才搬移；`--restore` 前再備份 D1                                     | 本機備份檔含明文 Key，須由管理員妥善保管權限                                                                  |
| 轉發與手動探測通道          | 100% 強制經 Cloudflare AI Gateway（`custom-{alias}`）                         | 未設定 Gateway 或缺 `alias` 時禁止轉發與手動測試（無直連退回，確保流量可觀測）；手動成功即歸零並解禁          |
| Gateway 日誌與快取          | 由 Logs URL 反拆雙 ID；`cf-aig-max-attempts: 1` ＋ `skip-cache` ＋ 明文 `key` | 需於 CF Dashboard 將 Custom Provider `slug` 對齊 `alias`；`cf-aig-metadata.key` 送完整 ASCII 金鑰以便日誌追查 |

---

## 十一、KV → D1 與輪詢轉發設計演進（2026-11-09 至 2026-11-10）

### 11.1 後端架構與原子性取捨

- **預設採用 D1 ＋ `db.batch()` 原子設定同步**：輪詢要求每筆請求精準更新 `last_used_at` 與 `fail_count`，因此採用 D1 單條 `UPDATE … RETURNING`。設定儲存（`app_settings`）、過時 `results:{fp}`／`dead_keys` 清除與 `key_state` 增刪改為透過單一 `env.DB.batch([...])` 原子交易一次完成，失敗直接回滾，故**已移除舊版熱路徑的 B′ 幽靈列清除迴圈與 `COUNT(*)=0` 延遲補建防線**，讓外部轉發請求路徑保持單純高速。
- **100% 經由 Cloudflare AI Gateway（`custom-{alias}` 取代 `gateway_provider`）**：專案依賴 Gateway 承擔可觀測性與請求日誌，取消無日誌的直連模式，亦讓 `alias` 直接對應 Custom Provider `slug`，刪除冗餘的 `gateway_provider` 欄位；同時強制關閉 Gateway 重試（`cf-aig-max-attempts: 1`），把「換下一把不同金鑰」的主控權留在 Worker 迴圈。
- **非 2xx 單一失敗規則與手動探測（「`only reply 1.`」、成功立即恢復）**：不同供應商對無效金鑰回傳碼不一（Gemini 回 400），轉發重試維持非 2xx 即換鑰。手動「`测试`」採用最小非串流探測（提示詞 `"only reply 1."`、`max_tokens: 8`／`maxOutputTokens: 8`，按原順序淺合併 `extra_body`），並改為**探測收到 2xx 即當場將 `fail_count = 0, disabled = 0`** 並即時更新介面狀態，消除測通卻仍顯示已失效的落差。
- **移除 `ollama`**：無實際使用配置且其 `api_base` 不含版本前綴，移除後所有服務商皆一致遵守「填至版本前綴」規則，儲存時對 `ollama` 直接回 400。
- **標頭淨化順序與明文 Metadata 標籤**：清除呼叫端 `Cookie`、跳躍式標頭與所有 `cf-aig-*` → 換上金鑰認證標頭 → 套用 `Custom Headers`（可覆蓋認證） → 最後寫入系統自有 `cf-aig-*`。`cf-aig-metadata` 移除 `metadataKeyTag()` 的遮罩／短金鑰縮短邏輯，改送完整 ASCII 金鑰 `{ key, provider }`（僅保留去除 CRLF 與非 ASCII 控制字元，確保 `fetch()` 不拋 `TypeError`）。`--restore` 仍維持先 upsert 再刪多餘列的精準快照還原。

### 11.2 轉發頁版面與元件設計決策

- **上方外框工具列＋每把金鑰小卡（每頁最多 9 把分頁）**：`.proxy-toolbar` 採與下方 `.proxy-key-card` 一致的 `--bg-2`／`--border`／`--radius` 外框並保留內距（桌機 `1.25rem`、手機 `1rem`），使內部控件與外框維持明確間距；工具列內的 `(i)` 提示框僅水平對齊 `.proxy-toolbar` 左右邊界、垂直方向沿用視窗範圍以免被第 2 行空間擠壓。下方改以每把金鑰小卡呈現（單頁最多 9 把，超過時右下角顯示 `.proxy-pagination` 分頁列：兩顆同尺寸正方形置中 SVG 圖示按鈕預設為 `<`／`>`，中間為將頁碼輸入框與 `/ 總頁數` 包在同一框內的 `.proxy-page-box`，支援鍵入頁碼或滑鼠滾輪調整，數值異動時兩鈕切換為 `×`（取消）／`→`（前往）圖示）；卡片右上保留與表格一致的 `.copy-btn` 複製明文、右下以 `margin-left: auto` 固定擺放「测试」與「禁用」（有效鑰）或「恢复」（失效鑰）按鈕、卡片資料簡化為「失败」與相對時間「最近使用」— 60 秒內固定顯示 `60 秒前`，其餘依分鐘／小時／天往上累計且最高單位為天；失效卡片則比照「来源设定」採整卡灰階降不透明度並於左下顯示純粗體文字「已失效」，正常金鑰不再加膠囊徽章），`maskKey()` 採左 6 ＋ 1～3 個 `*` ＋ 右 3（≤9 字元直接顯示），並維持四個分頁一致的卡片語言與 `--control-h`（`2.5rem`）控制項高度。手動「禁用」與工具列「恢复所有密钥」會先跳出 `confirm` 確認以防誤觸或高頻寫入，單卡「恢复」則直接執行而不彈出 `confirm` 確認框。
- **測試模型選單來自來源設定，按測試時才獨立保存**：候選清單直接讀取 `providers[].models` 避免重複輸入，預設選取目前保存的模型（或清單第一個模型）；介面已移除獨立「保存模型」鈕，並於「`测试模型`」右側以 `(i)` 懸浮提示說明「点击测试按钮后才储存测试模型」（分頁副標題精簡為單句「金钥自动轮用，连续失败达门槛后禁用。」）。切換下拉選單本身不會寫入資料庫，僅於實際按下單卡或批量「测试」按鈕時一併將所選模型寫入 `app_settings.proxy_test_models`（且僅在與已存值不同時才執行寫入，避免重複測試或批量迴圈頻繁寫庫，亦不影響每日排程清單）；另單卡「恢复」鈕改為直接恢復而不彈 `confirm` 確認框，開窗未修改內容直接按「储存」則由前端比對本地設定並於後端先讀取現值確認無變化（`unchanged: true`）時跳過資料庫寫入。
- **工具列「恢复所有密钥」按指紋批次恢復**：在「测试无效密钥」旁新增「恢复所有密钥」，於後端 `POST /api/proxy/recover` 支援 `{ fp, all: true }` 執行單條 `UPDATE key_state SET disabled = 0, fail_count = 0 ... WHERE fp = ? AND disabled = 1`，僅恢復當前選中服務商已禁用的金鑰而不影響該服務商仍有效金鑰的 `fail_count` 或其他服務商狀態；按鈕本身不依賴測試模型即可操作，僅於轉發啟用且當前服務商存在已禁用金鑰時可點擊。
- **統計配色與對齊層級**：工具列第一行於選單與網址前補上「`供应商`」與「`转发地址`」標題，第二行左側依序靠左並排「`测试模型` ＋ 選單」與「`密钥状态`」，四個標籤（`.proxy-toolbar-label`、`.proxy-summary-label`、`.proxy-model-label`）共用與 `失效密钥` `.field-label` 完全一致的樣式（`--text-muted`、`--text-sm`、`font-weight: 600`、不換行）。每個服務商於前後端統一限制最多共 `999` 支密鑰（`MAX_PROVIDER_KEYS = 999`，儲存時去重後超過即提示錯誤並回傳 `400`），因此統計數字絕不超過 `999` 而不需 `+` 號邏輯；膠囊改為兩個獨立的半透明加邊框膠囊（`.proxy-summary-group` 以 `gap: 0.75rem` 對齊文字到膠囊間距，`.proxy-summary-cell` 固定寬度 `calc(3ch + 1.5rem + 2px)` 容納 3 位數、置中對齊、一綠 `.proxy-summary-ok` 一紅 `.proxy-summary-fail`，比照 `.badge-ok`／`.btn-danger`），懸停時透過 `title` 分別顯示「有效数量」／「无效数量」，右側（`.proxy-action-group`）收攏三個測試／恢復操作鈕。
- **單一頁首連結與全站統一複製圖示按鈕**：在「`轮询转发`」頁首保留「`Gateway 记录 ↗`」、在「`测试结果`」頁首放置「`立即执行 / 查看记录 ↗`」（`aria-disabled="true"` 停用未設網址時；箭頭附 `aria-hidden="true"` 保持名稱純淨）；移除所有分頁的「`重新读取`」鈕；將原本文字「一键复制」鈕與整行點擊的轉發網址框（`copyProxyUrl()`）**全面改為統一的 `COPY_ICON_SVG`（`.copy-btn.btn-icon`）與 1.5 秒綠色勾勾回饋**，其中轉發網址列複製鈕採與控制項同高的 `--control-h` 正方形搭配放大圖示，測試結果「`有效 Key`」／「`有效模型`」改將複製鈕置於標題列右側，「`失效 Key`」則僅保留群組標題的整組複製鈕並移除各列個別複製鈕。
- **編輯器與儲存端自動去重（保留首次出現）**：「`编辑服务商`」的 API Keys 與 Models 於失焦與儲存時以 `splitUniqueDelimited()` 去重並保留首次出現順序，後端 `normalizeProviderForStorage()`／`providerKeys()`／`providerModels()` 亦同步去重，避免 D1 `key_state` 重複寫入或殘留重複模型名稱；既有 `diffKeyLines()` 維持原有多重集合比對邏輯。
- **`STORAGE_BACKEND=kv` 模式隱藏轉發介面並全面於後端拒絕**：由 `GET`／`POST /api/settings` 回傳頂層 `storage_backend` 供前端零額外請求判斷後端類型；當為 `kv` 時隱藏頂部「`轮询转发`」分頁籤、`#tab-proxy` 與「`设定`」彈窗內的轉發相關欄位區塊（`#settings-proxy-fields`），`saveSettings()` 亦略過送出未顯示的轉發欄位以避免覆寫既定值或阻止保存；後端則於 `handleProxy()`、`handleGetProxyState()`、`handleProxyTest()`、`handleProxyRecover()` 與 `handleProxyTestModel()` 一律透過 `rejectIfProxyDisabled()` 回傳 `503`（`PROXY_DISABLED`）。
- **「`轮询转发`」只看 `alias`（`enabled: false` 僅跳過每日排程）與卡片排序／批量併發**：`GET /api/proxy/state` 與前端 `proxyProviders()` 皆直接過濾未設定 `alias` 的服務商（全站皆無 `alias` 時前端呈現引導空狀態），工具列亦不再出現「尚未設定別名」提示；只要有設定 `alias`，即使該服務商在「来源设定」停用（`enabled: false`），依然可正常經由 `/proxy/{alias}` 轉發並在「`轮询转发`」執行測試／禁用／恢復操作（`enabled: false` 僅讓每日 GHA 自動測試跳過）。渲染金鑰小卡時依「有效（含仍有失敗紀錄）→ 已失效」兩層自動排前，同層內維持 `来源设定` 原始順序並保留明文複製對應；手動單卡或批量測試完成重載時固定當前卡片位置（`preserveOrder: true`）避免測試途中跳動，待重新進入或外部呼叫重載時再依最新成功／失效狀態重排；批量測試（`runProxyBatch`）先單發第 1 把（確保測試模型變更僅寫庫一次），再以預設 5 併發池（或服務商 `max_concurrency` 上限）平行測試其餘金鑰。
- **移除一次性 KV→D1 遷移與早期舊資料相容程式碼（保留雙後端切換）**：正式站已完成遷移並驗證線上全部項目（D1 高並發選鑰、`custom-{alias}` 路由、標頭淨化、SSE 串流、測試按鈕與 GHA `/api/run-status`），因此移除 `src/storage-migrate.js`、`scripts/migrate-kv-to-d1.mjs`、`/api/storage/*` 端點、`dead-keys.js` 無 `fp` 舊紀錄 fallback、`gateway_provider` 舊欄位清理與缺 Models 防呆提示（來源設定已強制必填 Models）；同時完整保留 `STORAGE_BACKEND=d1`／`kv` 雙後端支援供新站台依需求選用。
- **「`设定`」彈窗欄位順序與機密欄位顯示／複製控制項**：經確認 `github_url` 於全專案僅供結果頁首連結鈕 `#run-now-btn` 使用，將 `Discord Webhook URL` 移至首位並於 `openSettings()` 預設聚焦（次為 `GitHub Actions URL`）；轉發區塊依序調整為 `AI Gateway Logs URL` → `AI Gateway Token` → `代理转发密码` → `.settings-grid-3`。其中 `AI Gateway Logs URL` 的 `(i)` 提示框置前補充完整格式範例（搭配 `.info-tooltip` `overflow-wrap: anywhere` 防止長網址溢出），`AI Gateway Token` 佔位符簡化為 `cfut_...`；`代理转发密码` 與 `AI Gateway Token` 輸入框內建右置眼睛圖示切換明文／密碼（開啟明文時切換為帶斜線眼睛 `EYE_OFF_ICON_SVG`，開／關彈窗重設為密碼狀態，並以 `.input-secret::-ms-reveal` 隱藏瀏覽器內建眼睛防重疊），右側配置共用 `.proxy-url-copy` 幾何規則的 `--control-h` 正方形 `.copy-btn`。

### 11.3 前端 CSS 與互動陷阱紀錄

- **`aria-disabled` 樣式**：`<a class="btn">` 不受 `:disabled` 匹配，須於 `.btn` 與各 `:hover` 規則補上 `[aria-disabled="true"]` 處理，避免無法點擊的連結仍有懸停高亮。
- **RWD 順序與縱向 `flex-basis`**：轉發樣式必須排在 `── RWD` 區段之前才不會覆蓋手機斷點；`.proxy-toolbar-row` 與 `.proxy-provider-group`／`.proxy-url-group`／`.proxy-model-group`／`.proxy-summary`／`.proxy-action-group` 轉成 `column` 後 `flex-basis` 會變成元素高度，因此各群組與 `.proxy-provider-col`／`.proxy-url-wrap`／`.proxy-url` 在手機斷點須重設 `flex: none`（`.proxy-url` 改為自動換行）；另手機端側欄抽屜 `.topbar-actions` 以 `margin-top: auto` 連同上方隔線置底對齊。
- **模型選單 `flex: none` 固定寬度**：`.proxy-model-select` 必須使用 `flex: none` 配明確 `15rem` 寬度；若使用可縮減的 `flex-basis`，右側群組計算內在寬度時只會量到選項文字寬度，導致後方按鈕提前換行。
- **純 ASCII 輸入欄與結果顯示等寬化＋篩選／提示文字精簡**：登入頁管理密碼（`#auth-input`）、`失效密钥` API Key 搜尋（`#dk-f-key`）、`编辑服务商` 搜索密鑰（`#ed-keys-search`）、Headers 名稱／值（`.custom-header-row .input-text`）與 `.input-secret`（Token／代理密碼）皆採用 `var(--mono)` 等寬字體，並移除 `#dk-f-key`（`模糊匹配`）、`#ed-keys-search`（`搜索密钥，标橘色`）與 Headers 值（`值`）之中文 placeholder，維持所有等寬輸入框純 ASCII 呈現；展示端之 `失效密钥` KEY 欄、`测试结果` 有效／失效 Key、有效／失效模型（空狀態為 `(none)`）與模型性能表模型名稱（`code { font-size: 1em }`）亦統一為 `14px` `var(--mono)`（全站下拉選單統一維持預設字體）；`失效密钥` 篩選的「`服务商`」與「`错误码`」預設選項皆統一簡化為「`全部`」。
- **右上角 Toast 通知與請求競態防護**：移除單卡 `.proxy-test-result` 與操作完成後的上方 `#proxy-notice` 橫幅（`#proxy-notice` 僅保留全局代理停用提示）；單把或批量測試改於右上角 `#proxy-toast-root` 堆疊 Toast（最多同時保留 3 個結果／一般 Toast，最新在下方、舊的以 `position: absolute` ＋ FLIP `transform` 向上淡出 `0.3s ease`，帶關閉鈕，成功 5 秒／失敗 20 秒自動淡出，訊息最多兩行超出以 `...` 省略）。進行中 Toast（「正在测试密钥」／「正在测试有效密钥」／「正在测试无效密钥」）採 `pending: true` 獨立計數而不佔用 3 個結果名額，待結果 Toast 進場（`300ms`）後再淡出上推；單把測試與批量測試共用 `state.proxyBusy` 互斥鎖（同時只能進行一種測試）並設 20 秒請求超時（`PROXY_TEST_TIMEOUT_MS = 20000`，超時顯示紅色超時 Toast）；所有分頁載入器皆帶遞增請求序號（`state.reqSeq`）丟棄過期回應；各彈窗以 `openModal`/`closeModal` 堆疊支援頂層 `Esc` 關閉（關閉時僅清除彈窗內殘留焦點，不把焦點退回原按鈕，並移除按鈕／頁籤／折疊表頭的預設黑框焦點標註）。

### 11.4 尚待正式線上環境複驗項目

1. **D1 高並發寫入序列化**：線上以真實並發請求確認同一服務商不會重複挑中同一把 Key。
2. **AI Gateway 線上行為**：確認 `custom-{alias}` Custom Provider 路徑拼接、`cf-aig-metadata` 明文 Key 標籤，以及由「`设定`」中 `AI Gateway Logs URL` 自動解析雙 ID 的實測結果。
3. **每日 GHA 排程、`/api/run-status` 與 `if: always()` 清除機制，以及真實上游長回應執行狀況**。
