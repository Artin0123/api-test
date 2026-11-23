# 決策說明（最後更新 2026-11-24）

**本文件持續維護**，記錄「失效密鑰分頁」、「錯誤訊息改造」、「單一 Key 連跑兩輪」、「API 認證」、「KV → D1 與輪詢轉發」以及「直連上游轉發、記憶體快照與 D1 請求記錄」中各項設計的**取捨理由、實作陷阱與承受代價**。修改上述行為時請同步更新本文件，並將檔名日期改為當次更新日。

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

`api_key` 在同一個服務商作用域（`fp`）下不重複；`error_detail` 依 `(fp, error_code)` 僅於同組第一筆保留（不同 `provider_type` 即便同主機域名也不互相覆蓋或繼承詳情）。刪除或換碼離組時，若原本持有 `error_detail` 的列離開該組，必須透過 `rebalanceErrorDetail()` 將 `error_detail` 轉移給同組下一筆列，否則同組剩餘列會因 `error_detail: null` 而集體遺失詳情資料。

### 2.3 自動對帳與「來源設定」連動清理

`POST /api/results` 上傳時透過 `syncDeadKeysFromResults()` 以該服務商的 **`fp`** 為作用域自動對帳：來源設定該卡片內仍存在且失敗的 Key 自動寫入（附帶 `fp` 與 `provider_host`），已恢復（`valid_keys`）的 Key 自動刪除。**新增與刪除必須成對實作**：有了自動恢復刪除，系統才敢於紀錄 429／500 等暫時性失敗，而不會將正常 Key 永久釘在清單上。

- **嚴禁重複服務商與取消手動編輯**：前端 `saveEditor()` 與後端 `POST /api/settings` 皆拒絕相同 `(provider_type, api_base)` 的重複卡片（`400`），徹底移除早年為容忍重複卡片而存在的 `_uiKey`（`fp#0`）與同主機聯集（`collectConfiguredKeysForHost()`）；同步移除「`失效密钥`」單筆編輯彈窗與 `PUT /api/dead-keys` 端點，將清單嚴格收斂為來源對帳與批次刪除。
- **刪卡／刪 Key 連動清理**：於「`来源设定`」刪除卡片、更改 `api_base`/`provider_type` 或從編輯區刪除部分金鑰時，`POST /api/settings` 會一併刪除已消失卡片的 `results:{fp}`，並從 `dead_keys` 移除已不在該卡片清單內的紀錄（同時執行 `rebalanceErrorDetail()`），免去以往刪卡後殘留幽靈死鑰的問題。
- **兩階段狀態碼同步**：因 Python 上傳與現存的 `error_detail` 持有者可能不同，先於換碼階段對變更 `error_code` 的列執行舊組交棒與清空自身 detail，再於 `(fp, error_code)` 群組刷新階段比對本次非空 detail 決定是否更新 KV（空本文不覆寫既有詳情）。

### 2.4 批次刪除與前端實作注意細節

- **批次刪除**：`DELETE /api/dead-keys` 支援 `ids: string[]`，讀一次、執行一次 `rebalanceErrorDetail()`、寫回一次並直接回傳更新後陣列，避免 N 筆逐一刪除。
- **常駐篩選、右上角紅底白字刪除鈕與響應式金鑰遮罩**：將「`删除密钥`」按鈕移至「`失效密钥`」右上角 `.panel-head-actions` 並採用紅底白字 `.btn-danger-solid`（與其他頁面右上角主按鈕風格一致）；移除「`清除筛选`」按鈕（刷新或切頁即重置）與「`失效时间（起）`」，僅保留「`供应商`」、「`状态码`」、「`Key 搜寻`」與「`时间早于`」四項常駐篩選（固定欄寬 `table-layout: fixed`）。由於 `dead_keys` 100% 源自每日檢測腳本 `async_test_keys.py`（每筆皆必帶整數狀態碼：上游 HTTP 狀態碼、超時 `499` 或連線異常 `500`），不再存在早期手動新增時代的 `null`（無狀態碼），故同步移除前端 `DK_CODE_NONE` 與 `null` 置底排序分支。桌機採用 `maskKey()`（左 6 ＋ 1～3 `*` ＋ 後 3），手機端採用 `maskKeyMobile()`（左 6 ＋ 1～3 `*` ＋ 後 1）；篩選下拉選單統一與輪詢轉發相同格式，依 `fp` 以 `providerFormatLabel()` 呈現「`名稱 - 格式`」，表格欄位則維持單卡顯示 `providerDisplayName()`（`別名 || host`）、同主機多卡加註 `名稱 - 格式`。
- **桌機乾淨平面下拉選單增強（手機保留原生）**：`enhanceSelect()` 於桌機漸進強化為 `.custom-select-trigger` 搭配依實測寬度鎖定的 `.custom-select-menu`，手機與觸控端退回原生 `<select>`（樣式比較預覽頁已於 2026-11 移除）。

---

## 三、單一 Key 連跑兩輪、純非串流與狀態簡易化

當服務商只有 1 把 Key 時缺乏交叉驗證，因此設 `runs_per_pair = 2`（兩輪間隔 `SINGLE_KEY_RERUN_DELAY = 2.0` 秒）。

- **為何不用「佇列塞入兩次」**：併發 ≥ 2 時兩輪會同時發出而使 2 秒間隔失效，須在單一 worker 迴圈內依序執行。
- **純非串流與 `2xx`／非 `2xx` 二分法（超時統一記為 `499`）**：串流模式下不支援串流的端點常回報與總耗時完全相同的假性 TTFT，失去辨別意義；改採純非串流（`stream=False`、Google 改打 `:generateContent`，維持 `TOTAL_TIMEOUT = 20s`），移除 `TTFT_TIMEOUT`、`parse_stream`、`429`/`408` 重試與串流降級，嚴格以 **HTTP `200..299` 且含正文／思考內容為成功**，本地超時主動切斷統一記為 **`499`**（與 Worker 轉發／手動探測超時一致），並自結果頁移除 `avg TTFT` 欄。
- **熔斷與本機 `Ctrl+C` 續跑規則**：為避免單一模型權限或配額誤殺整把金鑰，熔斷僅限明確的 **`HTTP 401`**（取消 `403`／`balance`／`quota` 跳過），觸發後立即跳過第二輪與後續模型；移除每 200 筆寫檔與 `/api/checkpoint`，改由單一全域 `/api/run-status`（`test_run_status`）在「`测试结果`」標題旁呈現全局 `⏳ 执行中`（GHA 結束一律透過 `if: always()` 清除並附 `GET` 90 分鐘惰性過期保底），本機執行僅在 **`Ctrl+C` 中斷**時將未完進度存至 `checkpoint.json` 供單機手動重跑接續。

---

## 四、樣本長度上限

`MAX_OUTPUT_TOKENS = 512` 無法約束忽略該參數或另計推理 Token 的供應商。採 `SAMPLE_MAX_LEN = 2048`（`content` 與 `thinking` 分開計算）作為安全網：

- **保留頭尾各 1024 字元**：推理模型結論常落在結尾，只留前段會將最終答案裁切掉。
- **為何不放寬 `MAX_OUTPUT_TOKENS`**：放寬會讓長輸出模型轉為觸發 `TOTAL_TIMEOUT = 20s`，由內容被截斷惡化為整筆超時失敗。
- **驗證與冪等順序**：`answer_verified` 必須於截斷前以完整回應判斷；帶 `CLIP_MARK` 字串直接原樣返回，防止舊 checkpoint 恢復匯總時被二次截斷。
- **本機斷點 `401` 續跑保真**：從 `checkpoint.json` 恢復時同步保留該服務商 `dead_keys` 的 `401` 錯誤紀錄，並僅清除吻合當前服務商的暫存檔，避免續跑後遺失錯誤碼或誤刪其他服務商中斷檔。

---

## 五、KV 操作稽核

- **寫入量（免費上限 1,000／日）**：單一服務商 600 任務約 5～6 次寫入，10 個服務商每日排程約 60 次（穩定無異動時約 50 次）。
- **讀取量（免費上限 100,000／日）**：KV 模式下無任何背景自動輪詢（無 `setInterval`／`visibilitychange` 刷新），僅使用者主動切換／重讀與排程對帳時讀取，10 個服務商每次瀏覽結果頁約 20 次讀取。
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

轉發端點須發給外部軟體使用，因此轉發密碼嚴格不可與 `ADMIN_PASSWORD` 相同（存入時與執行期皆拒絕同值）。`proxy_password`、`proxy_fail_threshold`、`proxy_max_retries` 與 `proxy_upstream_timeout_ms` 統一於前端「`设定`」彈窗管理並存於 `app_settings`（不再使用任何 `PROXY_*` 或 `AI_GATEWAY_*` 環境變數；舊版殘留於 D1 的 `ai_gateway_logs_url` 與 `ai_gateway_token` 於存檔時保留底層原值供一鍵回滾，但於 `GET /api/settings` 出口主動剝除以防外洩）。入站驗證支援 `Authorization: Bearer`、`x-api-key` 與 `x-goog-api-key`。

---

## 七、瀏覽器端防護與設定並發

### 7.1 安全標頭寫入 Worker 出口

Cloudflare `_headers` 檔案不套用於 Pages Functions 回應（且 `env.ASSETS.fetch()` 行為於官方文件中有衝突），故於 worker 出口統一以 `withSecurityHeaders()` 附加 CSP、`nosniff`、`X-Frame-Options`、`Referrer-Policy` 與 `Permissions-Policy`。

### 7.2 嚴格 CSP 的實作陷阱

- **主題預載腳本**：將防閃爍 inline script 獨立至 `public/boot.js`，避免每改一行就得重算 CSP hash。
- **禁用 `style=""` 與 CSS 特異性回歸**：將所有行內樣式改為 class（CSSOM `_mirror.style` 不受 CSP 限制）。轉換後 `.topbar-menu-close` 曾因宣告順序早於 `.btn-ghost` 而退回有框按鈕，須提升選擇器特異性為 `.btn-ghost.topbar-menu-close` 才能穩定生效。
- **白名單例外**：`connect-src` 僅放行 `discord.com`／`discordapp.com`（供瀏覽器端測試通知）；`img-src` 須保留 `data:` 以載入 SVG favicon 與下拉箭頭。

### 7.3 設定並發控制與不設登入限流

- **`app_settings` 樂觀鎖**：以 `version` 欄位將跨分頁同時存檔的靜默覆蓋轉為看得見的 `409 Conflict`（前端收到後重拉最新設定）；刻意放行不帶 `version` 的請求以利 `curl` 手動搶修；「`设定`」彈窗僅回傳自身管理的全域／轉發設定欄位避免夾帶過時 `providers[]`。此外，`canonicalProviderForCompare()` 已納入 `test_path` 並移除廢棄的 `gateway_provider`，確保單獨修改 `test_path` 時不會被誤判為 `unchanged: true`。
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

| 取捨項目                    | 採用方案                                                                               | 承受代價                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 瀏覽器認證與儲存            | HttpOnly Cookie（無狀態 HMAC）                                                         | 依賴 `SameSite=Strict` 防 CSRF；無法撤銷單一 cookie；更換 `ADMIN_PASSWORD` 會使所有已登入瀏覽器失效         |
| 安全標頭位置                | Worker 出口統一附加                                                                    | 多一層包裝（因 `_headers` 對 `_worker.js` 無效）                                                            |
| `app_settings` 並發         | 樂觀鎖 `version` ＋ 409；`proxy_test_models` 獨立拆鍵                                  | 仍存在毫秒級競爭窗，但不再靜默覆蓋；切換測試模型不再誤遞增 `version`                                        |
| `dead_keys` 並發與生命週期  | 單一 KV 陣列、每日結果依 `fp` 對帳 ＋ 刪卡清理                                         | 不保留已恢復歷史；刪卡與刪除金鑰時由 `POST /api/settings` 同步掃除並交棒 `error_detail`                     |
| 錯誤分組與樣本裁切          | 正規化訊息去重；樣本各限 2048 字元掐頭留尾                                             | 僅數字不同的原因會合併；超長回應中段省略；Python／JS 正規化須手動同步                                       |
| 單一 Key 測試次數           | 純非串流連跑兩輪；`Ctrl+C` 本機斷點＋全局 `run-status`                                 | 單 Key 服務商請求數加倍；正常跑完不寫進度檔，改靠全局執行狀態指示與 90 分鐘過期保底                         |
| 儲存後端預設值              | 未填 `STORAGE_BACKEND` ＝ `d1`                                                         | KV 模式隱藏並停用「轮询转发」與「请求记录」（回 `503 PROXY_DISABLED`）                                      |
| `store`、`key_state` 與日誌 | `store` 存 JSON、`key_state` 存帳本、`proxy_logs` 存轉發日誌（上限 1,980 筆）          | 全透過 `db.batch()` 交易執行；`proxy_logs` 不建次要索引以消除寫入放大，列表查詢掃描最多 1,980 列            |
| 轉發與手動探測通道          | Worker 直連服務商 `api_base`（`redirect: "manual"` ＋ 剝除 `Location`）                | 省去 AI Gateway 中繼延遲與雙邊重複設定；3xx 一律視為失敗換鑰，不跟隨跨網域重定向                            |
| 記憶體快照與 `last_used_at` | 10s Soft TTL / 60s Hard TTL 快照 ＋ 游標輪詢 ＋ 60s D1 寫入節流                        | 多邊緣節點間 `last_used_at` 與禁用狀態最多有 10 秒軟同步窗，換取熱路徑零同步 D1 查詢與極低寫入額度消耗      |
| 請求記錄與串流重組          | `response.body.tee()` 背景重組 SSE ＋ Base64 省略 ＋ `65,536` 字元頭尾裁切             | 首字節零阻塞，但客戶端若中途斷流則僅記錄已產出片段；超長回應與大型圖片 Base64 不保留完整原文                |

---

## 十一、KV → D1 與輪詢轉發基礎演進（2026-11-09 至 2026-11-22）

- **預設採用 D1 ＋ `db.batch()` 原子設定同步**：設定儲存（`app_settings`）、過時 `results:{fp}`／`dead_keys` 清除與 `key_state` 增刪透過單一 `env.DB.batch([...])` 原子交易一次完成，失敗直接回滾。
- **非 2xx 單一失敗規則與手動探測（「`only reply 1.`」、成功立即恢復）**：不同供應商對無效金鑰回傳碼不一（Google 常回 400），轉發重試維持非 2xx 即換鑰。手動「`测试`」採用最小非串流探測（提示詞 `"only reply 1."`、`max_tokens: 8`／`maxOutputTokens: 8`，淺合併 `extra_body`），收到 2xx 即將 `fail_count = 0, disabled = 0`。
- **移除 `ollama` 與統一 `google` 格式命名**：`PROVIDER_TYPES` 與前後端／Python 腳本統一採用 `openai`、`google`、`anthropic`；`google` 自動補全 `/v1beta/models/{model}:generateContent`，`openai` 與 `anthropic` 必填相對路徑 `test_path`。
- **「`轮询转发`」只看 `alias`（`enabled: false` 僅跳過每日排程）**：未設定 `alias` 的服務商不進入轉發清單；已設 `alias` 者即使 `enabled: false` 仍可正常轉發與手動測試。金鑰上限每家 999 支（`MAX_PROVIDER_KEYS = 999`），統計以獨立綠／紅膠囊呈現，每頁 9 張小卡搭配支援滾輪與跳頁的 `.proxy-pagination` 控件。

---

## 十二、移除 AI Gateway、記憶體快照輪詢與 D1 請求記錄（2026-11-23）

### 12.1 為什麼移除 Cloudflare AI Gateway 改採 Worker 直連上游？

- **問題**：原架構強制所有轉發與手動測試先繞經 Cloudflare AI Gateway（`custom-{alias}`），管理員每新增一家服務商都必須同時在網頁後台與 Cloudflare Dashboard 兩邊重複設定 `base_url` 與 `slug`，且多一跳中繼延遲與額外權杖維護成本，而 AI Gateway Logs 本身又有查詢筆數與欄位限制。
- **決策**：移除 `ai_gateway_logs_url`、`ai_gateway_token`、`cf-aig-*` 標頭與「`Gateway 记录 ↗`」外連，改由 Worker 直接請求服務商 `api_base`，並在 D1 內自建完整的 `proxy_logs` 與第五個導覽分頁 **「`请求记录`」**。
- **無痛回滾保護**：`POST /api/settings` 在寫入 D1 時若發現舊設定含有 `ai_gateway_logs_url`／`ai_gateway_token` 會原樣保留於底層 JSON，一旦需要退回前一版 Pages 部署即可零設定無縫恢復；同時 `GET /api/settings` 主動刪除這兩個舊欄位，確保權杖絕不對外回傳。

### 12.2 直連模式的安全邊界：`api_base` 驗證、`redirect: "manual"` 與在途禁用保護

- **`api_base` 與路徑儲存期／轉發期限制**：前後端同步攔截非 `https://` 網址（僅允許本機開發 `http://127.0.0.1`、`http://localhost`、`http://[::1]`），並禁止夾帶 userinfo、`?query`、`#fragment`、路徑穿越片段（`..` / `%2e`）、內網保留 IP 字面量及指向當前代理站台自身的網域（防止遞迴扇出）；`test_path` 與 `/proxy/{alias}/...` 子路徑亦同步阻擋路徑穿越。
- **禁止自動跟隨 3xx 重定向**：標準 `fetch` 預設跟隨 301/302 時可能將 `Authorization` 標頭洩漏給第三方主機或導向內網位址。故 `/proxy/{alias}/...` 與 `/api/proxy/test` 一律設 `redirect: "manual"`，將 3xx 視為非 2xx 失敗計數並換下一把金鑰，且在 `DROP_UPSTREAM_HEADERS` 剝除 `location` 標頭。
- **在途 2xx 不覆蓋併發禁用**：正常轉發絕不挑選 `disabled = 1` 的金鑰；若某把金鑰在請求飛行途中被管理員按「禁用」（或由背景刷新同步為已禁用），該筆飛行中請求完成 2xx 時，`stageProxyKeySuccess()` 與底層 SQL（`CASE WHEN disabled = 0 THEN 0 ELSE fail_count END`）只會在未禁用時歸零 `fail_count`，**絕不將 `disabled` 清回 `0`**，避免吃掉管理員的手動禁用操作。

### 12.3 記憶體快照（Soft/Hard TTL + Epoch 防回寫）、游標輪詢與秒級「最近使用」跳動

- **消除熱路徑同步 D1 往返**：過往每筆 `/proxy/*` 都要先查 `store('app_settings')` 再跑 `UPDATE key_state ... RETURNING`，每筆請求固定消耗多次同步 D1 讀寫與邊緣往返延遲。改以 `WeakMap(env.DB)` 維護單執行體快照：冷啟動僅用 **1 次 `db.batch()`**（含首次 DDL 初始化、`store` 與 `key_state`），10 秒內零查庫，10～60 秒回傳快取並在 `ctx.waitUntil` 背景做增量刷新（`updated_at >= keyStateSeen - 2000`），60 秒以上才同步刷新；透過 `localMutatedAt` 防止舊列覆寫本地新狀態，並以遞增 `epoch` 防止 `invalidateSnapshot()` 作廢期間的在途舊查詢回寫過期設定。
- **秒級即時跳動與 `?since_seq=` 原地 DOM 同步**：
  - 過往「最近使用」在 60 秒內固定顯示靜態的 `60 秒前`，無法看出哪把金鑰剛被外部軟體呼叫。現改為 `1 秒前`～`59 秒前` 即時倒數：當使用者停留在「`轮询转发`」且頁籤可見時，前端啟動 `1000ms` 純 DOM 文字刷新計時器，搭配每 `2000ms` 呼叫 `GET /api/proxy/state?since_seq=<seq>`。
  - 若期間無任何轉發或帳本異動，Worker 比對記憶體 `stateSeq` 未變即以 **0 次 D1 查詢**直接回傳 `{ ok: true, unchanged: true, state_seq }`；若僅 `last_used_at` 或未達禁用門檻的 `fail_count` 變動，前端直接在現有卡片節點上原地更新文字與屬性，不重建 `innerHTML` 或分頁輸入框焦點。
  - D1 的 `key_state.last_used_at` 則以 60 秒節流寫入，兼顧 UI 秒級即時感與免費版 D1 寫入配額。

### 12.4 獨立 `proxy_test_models`（JSON1 原子更新）與批量測試單次提交（`test-commit`）

- **`proxy_test_models` 拆出 `app_settings` 並採 SQLite JSON1 原子更新**：過往保存測試模型會改寫整包 `app_settings` 並遞增 `version`，若管理員同時在另一分頁編輯「来源设定」就會無故撞上 `409 Conflict`。拆為獨立鍵 `store('proxy_test_models')` 並透過 `json_set` / `json_remove` 單鍵原子更新後，不僅不會遞增 `version`，跨執行體併發修改不同服務商的測試模型也不會互相覆寫。單卡測試直接在 `/api/proxy/test` 的 `db.batch()` 內順帶寫入，批量測試則平行呼叫 `/api/proxy/test-model`。
- **取消首把單獨等待、改採 `defer_write: true` ＋ `POST /api/proxy/test-commit`**：批量測試不再先單跑第 1 把金鑰，直接以併發池平行探測全部目標金鑰（各探測請求帶 `defer_write: true`，僅回傳預估計數、不寫 D1；若因本地網路或前置驗證錯誤未實際發出上游探測，標記 `probeSkipped` 不計入扣點），待整批完成後由 `/api/proxy/test-commit` 以**單一 `db.batch()`**（每 90 個 ID 分塊 `IN (...)`）一次寫入 D1 並同步記憶體快照。

### 12.5 D1 `proxy_logs` 設計取捨：零次要索引、無篩選主鍵直掃、列表遮罩最小揭露與串流保護

- **零次要索引 ＋ 無篩選主鍵快速路徑（1,980 筆上限，每頁 20 筆 × 最多保留 99 頁，超出自動清除）**：在 D1 計費模型中，每多建一個次要索引，每次 `INSERT` 與清理 `DELETE` 都會額外計入索引列寫入。`proxy_logs` 僅保留 `id INTEGER PRIMARY KEY`（SQLite rowid 別名），每筆嘗試（含換鑰重試的每一次請求）皆獨立寫入一筆紀錄（我們主動切斷超時記為 `499`、網路連線失敗記為 `502`），每滿 50 筆在同一個背景 `db.batch()` 內順手執行 `DELETE ... ORDER BY id DESC LIMIT -1 OFFSET 1980` 自動清除舊紀錄（不設手動清空紀錄或清除篩選按鈕）。無篩選條件翻頁時直接以主鍵倒序 `LIMIT 20 OFFSET ?` 讀取當頁 20 列，並以最新主鍵 `headId` 校驗記憶體 `logFacets` 快取（第 1 頁僅讀約 21 列）；帶篩選條件時才掃描最新 1,980 列（省略大欄位）完成 `alias`、`status`（`全部`／`成功`／`失败`／指定狀態碼）、`key`（同時匹配明文與遮罩）、`model` 與 `to_ts`（時間早於）過濾。表格欄位與詳情頁統一按「時間、供應商、狀態碼、模型、密鑰、耗時、串流（是/否）、詳情（標題置中）」順序呈現；外部表格耗時僅顯示總耗時，非串流請求的 TTFB 固定顯示為 `-`（如 `- / 610 ms`），詳情頁最上方獨立框格顯示「請求格式」、「請求上游」完整網址與來訪「User Agent」，下方面板標題採用直觀中文「請求內容」與「響應內容」（不重複顯示獨立紅色錯誤橫幅）。
- **列表僅揭露遮罩金鑰，按需取回明文**：`GET /api/proxy/logs` 列表回應只含 `key_masked`、不回傳明文 `api_key`；點擊複製鈕時前端優先從本地已載入設定秒級匹配明文，若該金鑰日後已從設定刪除，才以 `?id=` 單筆端點按需取回歷史明文複製。
- **二進位零緩衝直通與 SSE 串流 `tee()` 重組**：音訊／圖片／影片／PDF 等二進位回應直接原樣串流給客戶端、不呼叫 `tee()` 緩衝進記憶體；非 SSE 文字回應限制最多讀取 2 MB；SSE 回應利用 `response.body.tee()` 零延遲串流，背景分支正規化跨封包 `\r\n` 並重組 OpenAI Chat、OpenAI Responses、Anthropic Messages 與 Google Gemini 的 `content`、`thinking`、`tool_calls`、`finish_reason` 與 `usage`（附帶累積長度軟上限防止超長串流撐爆 Worker 128 MB 記憶體）。
- **Payload 去敏與金鑰遮蔽**：`sanitizeLogBody()` 先將超長 `data:...;base64,...` 與 `"data":"..."` 替換為 `<base64 omitted (...)>`，再對超過 `65,536` 字元的本文保留頭尾各 `32,768` 字元，並透過 `scrubSecrets()` 將錯誤摘要與錯誤回應本文（`res_body`）中可能回顯的明文 API Key 統一遮罩為 `maskKey()`。
