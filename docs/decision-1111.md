# 決策說明（最後更新 2026-11-11）

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

| 語法 | Python `re` | JavaScript `RegExp` | 實測差異 |
|---|---|---|---|
| `\d` | 匹配全形數字 `１２３４` | 僅匹配 ASCII `0-9` | 中文訊息含全形數字時兩端遮蔽結果相反 |
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

### 2.2 雙重去重與結構交棒（再平衡）

`api_key` 全域去重（重複回傳 409），`error_detail` 依 `(provider_host, error_code)` 僅於第一筆保留。刪除或編輯（`provider_host`／`error_code` 變更）時，若原本持有 `error_detail` 的列離開該組，必須透過 `rebalanceErrorDetail()` 將 `error_detail` 轉移給同組下一筆列，否則同組剩餘列會因 `error_detail: null` 而集體遺失詳情資料。

### 2.3 自動對帳與狀態碼同步

`POST /api/results` 上傳時透過 `syncDeadKeysFromResults()` 自動對帳：來源設定內仍存在且失敗的 Key 自動寫入，已恢復（`valid_keys`）的 Key 自動刪除。**新增與刪除必須成對實作**：有了自動恢復刪除，系統才敢於紀錄 429／500 等暫時性失敗，而不會將正常 Key 永久釘在清單上；同時移除前端手動新增列與 `POST /api/dead-keys` 端點，將清單嚴格收斂為權威測試結果對帳，僅保留表格內的編輯與批次刪除，絕不連動修改「来源设定」測試名單。對帳過程包裹 `try/catch`，失敗僅寫 log 以免讓上傳端誤判結果遺失而重跑；無實質變動時不執行 KV 寫入。

- **殘留紀錄（幽靈 Key）處理**：平行讀取 `app_settings` 並將同 host 所有卡片的 `keys` 取聯集為 `configuredKeysForHost`（不以單次上傳的 `invalid_records` 覆蓋整個 host，以免同 host 多卡片串行上傳時互相誤刪）。若 `app_settings` 缺失或解析失敗則不清空清單，僅在確定為 `{providers: []}` 時清空。
- **兩階段狀態碼同步**：因 Python 上傳與 KV 現存的 `error_detail` 持有者可能不同，先於換碼階段對變更 `error_code` 的列執行舊組交棒與清空自身 detail，再於群組刷新階段比對本次非空 detail 決定是否更新 KV（空本文不覆寫既有詳情）。

### 2.4 批次刪除與前端實作注意細節

- **批次刪除**：`DELETE /api/dead-keys` 支援 `ids: string[]`，讀一次 KV、執行一次再平衡、寫回一次並直接回傳更新後陣列，避免 N 筆逐一刪除觸發 KV 每秒 1 次寫入限制。
- **常駐篩選面板與表格細節**：移除獨立的篩選收合按鈕與手動新增列後，將 `.dk-filter-panel` 改為常駐顯示以減少一層互動；起訖時間改為純數字文字欄（無預設 `yyyy/mm/dd` 佔位文字，自動格式化為 `YYYY/MM/DD`）搭配隱藏原生 `<input type="date">` 日曆按鈕以支援手動輸入與日曆選取，縮窄時間欄位寬度，並將「供应商」欄位固定加寬至 `17rem`（略縮窄「Key 搜寻」），篩選框底部左右分放「删除密钥」與「清除筛选」。在 `table-layout: auto` 下直接對 `<td>` 設 `max-width` 會被瀏覽器忽略，須設於儲存格內層元素；`dead_keys` 表格改用 `table-layout: fixed` ＋ `min-width` 並僅讓錯誤訊息欄吃剩餘寬度；Code 篩選以 `value="__none__"` 區分「無 Code」與「全部」；排序直接重排資料陣列並重新渲染（而非搬移 DOM `<tr>`），使序號與勾選狀態不致錯亂，且無日期／無 Code 列無論升序降序一律置底（測試結果效能表排序亦採相同「缺值永遠置底」慣例）。切換至失效密鑰分頁時比照其餘分頁重新讀取最新清單（僅重刷時結束多選模式，切分頁保留仍存在紀錄的勾選集合），避免外部測試結果對帳後看見過期快取。
- **供應商標籤統一與響應式金鑰遮罩**：失效密鑰的篩選下拉、表格「供应商」欄（含表頭排序與刪除確認清單）及編輯彈窗統一依 `別名 || host` 顯示（若原服務商已遭刪除則退回 `provider_host`），不附加「- 格式」後綴，並於 `title` 保留完整名稱與 `api_base`；資料鍵與 API 仍維持 `provider_host` 不變，以相容現有對帳與儲存結構。表格與確認清單中的 KEY 改以純 CSS 斷點（`640px`）切換顯示格式：桌機採用與 `maskKey()` 相同之前 6 ＋ 1～3 個 `*` ＋ 後 3（≤9 字元原樣顯示，欄寬縮為 `10.5rem`），手機端採用 `maskKeyMobile()` 之前 6 ＋ 1～3 個 `*` ＋ 後 1（≤7 字元原樣顯示，欄寬縮為 `8.75rem`），並同步將手機端供應商欄寬縮至 `7.5rem`；複製按鈕與 `title` 仍保留完整明文以利檢視與複製。
- **桌機乾淨平面下拉選單增強（手機保留原生）**：原生 `<select>` 在桌機展開時會依最長 `<option>` 自動撐寬而與固定寬度按鈕對不齊，且帶有系統內建陰影／內陷外觀。`enhanceSelect()` 於桌機（`min-width: 641px` 且具備精準指標與懸停能力）漸進強化為 `.custom-select-trigger`（`--bg-3` 平面底）搭配依觸發器實測寬度鎖定的 `.custom-select-menu`（過長項目以 `...` 截斷並附完整 `title`），而手機與觸控裝置則透過 CSS 斷點自動退回原生 `<select>`，保留各平台原生選取器體驗；另提供 `public/select-preview.html` 供比較不同平面／底線／微浮起／`base-select` 樣式。

---

## 三、單一 Key 連跑兩輪

當服務商只有 1 把 Key 時缺乏交叉驗證，因此設 `runs_per_pair = 2`（兩輪間隔 `SINGLE_KEY_RERUN_DELAY = 2.0` 秒）。

- **為何不用「佇列塞入兩次」**：併發 ≥ 2 時兩輪會同時發出而使 2 秒間隔失效，須在單一 worker 迴圈內依序執行。
- **熔斷與續跑規則**：第一輪觸發不可重試熔斷（如 401/403）時立即停止，不浪費第二輪額度與 2 秒等待；斷點續跑須累計滿 `runs_per_pair` 筆成功才算完成，未滿額組合會捨棄舊紀錄重跑兩輪。

---

## 四、樣本長度上限

`MAX_OUTPUT_TOKENS = 512` 無法約束忽略該參數或另計推理 Token 的供應商。採 `SAMPLE_MAX_LEN = 2048`（`content` 與 `thinking` 分開計算）作為安全網：

- **保留頭尾各 1024 字元**：推理模型結論常落在結尾，只留前段會將最終答案裁切掉。
- **為何不放寬 `MAX_OUTPUT_TOKENS`**：放寬會讓長輸出模型轉為觸發 `TOTAL_TIMEOUT = 20s`，由內容被截斷惡化為整筆超時失敗。
- **驗證與冪等順序**：`answer_verified` 必須於截斷前以完整回應判斷（`async_test_keys.py:754`）；帶 `CLIP_MARK` 字串直接原樣返回，防止舊 checkpoint 恢復匯總時被二次截斷。

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

| 候選方案 | 不採用或採用理由 |
|---|---|
| `localStorage` ＋ Bearer | 直接存放 `ADMIN_PASSWORD`，一次 XSS 即永久外洩且無法在網址列直接檢視 API |
| HTTP Basic Auth | 缺乏標準登出語意，憑證會被快取至關閉瀏覽器且無法使用 `SameSite` |
| 簽章 Query Token | 會暴露於瀏覽器歷史、Referer 與 Cloudflare 存取日誌 |
| Cloudflare Access | 強綁 Dashboard 額外設定，GHA 端須改用 Service Token |
| **無狀態 HttpOnly Cookie（採用）** | XSS 無法竊取、支援即時登出與網址列直開 JSON；採 `<到期毫秒>.<HMAC>` 避免每次請求多讀一次 KV（及受最終一致性影響）。代價是無法個別撤銷單一 cookie，全域撤銷須更換 `ADMIN_PASSWORD` 或調升 `SESSION_VERSION`。 |

`localStorage` 僅保留不具認證效力的 `atk_signed_in` 旗標，供 `index.html` 在首次繪製前預先隱藏登入遮罩避免畫面閃爍；真正驗證於 `bootstrap()` 請求 `/api/settings` 完成。供腳本與 GHA 使用的 Bearer 路徑維持不變。

### 6.3 CSRF 防護：`SameSite=Strict`

因寫入端點 `request.json()` 不檢查 `Content-Type`（跨站 `<form enctype="text/plain">` 仍可送出 JSON 並帶上 cookie），系統完全依賴 `SameSite=Strict; Path=/api` 阻擋跨站請求攜帶 cookie（代價是從外部站點點連結跳轉 `/api/...` 會見 401，刷新即可）。

### 6.4 獨立的轉發密碼（`PROXY_PASSWORD`）

轉發端點須發給外部軟體使用，因此必須與 `ADMIN_PASSWORD` 隔離，且後端明文比對後**明確拒絕兩者設為相同值**（回傳 503）。認證標頭同時支援 `Authorization: Bearer`、`x-api-key`（Anthropic SDK）與 `x-goog-api-key`（Gemini SDK）。

---

## 七、瀏覽器端防護與設定並發

### 7.1 安全標頭寫入 Worker 出口

Cloudflare `_headers` 檔案不套用於 Pages Functions 回應（且 `env.ASSETS.fetch()` 行為於官方文件中有衝突），故於 worker 出口統一以 `withSecurityHeaders()` 附加 CSP、`nosniff`、`X-Frame-Options`、`Referrer-Policy` 與 `Permissions-Policy`。

### 7.2 嚴格 CSP 的實作陷阱

- **主題預載腳本**：將防閃爍 inline script 獨立至 `public/boot.js`，避免每改一行就得重算 CSP hash。
- **禁用 `style=""` 與 CSS 特異性回歸**：將所有行內樣式改為 class（CSSOM `_mirror.style` 不受 CSP 限制）。轉換後 `.topbar-menu-close` 曾因宣告順序早於 `.btn-ghost` 而退回有框按鈕，須提升選擇器特異性為 `.btn-ghost.topbar-menu-close` 才能穩定生效。
- **白名單例外**：`connect-src` 僅放行 `discord.com`／`discordapp.com`（供瀏覽器端測試通知）；`img-src` 須保留 `data:` 以載入 SVG favicon 與下拉箭頭。

### 7.3 設定並發控制與不設登入限流

- **`app_settings` 樂觀鎖**：以 `version` 欄位將跨分頁同時存檔的靜默覆蓋轉為看得見的 `409 Conflict`（前端收到後重拉最新設定）；刻意放行不帶 `version` 的請求以利 `curl` 手動搶修；設定彈窗僅回傳自身管理的兩個欄位避免夾帶過時清單。
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

| 取捨項目 | 採用方案 | 承受代價 |
|---|---|---|
| 瀏覽器認證與儲存 | HttpOnly Cookie（無狀態 HMAC） | 依賴 `SameSite=Strict` 防 CSRF；無法撤銷單一 cookie；更換 `ADMIN_PASSWORD` 會使所有已登入瀏覽器失效 |
| 安全標頭位置 | Worker 出口統一附加 | 多一層包裝（因 `_headers` 對 `_worker.js` 無效） |
| `app_settings` 並發 | 樂觀鎖 `version` ＋ 409 | 仍存在毫秒級競爭窗，但不再靜默覆蓋 |
| `dead_keys` 並發與生命週期 | 單一 KV 陣列、每日結果對帳 | 手動編輯與對帳同時發生會遺失單次編輯；不保留失效歷史；若整個 host 無卡片則殘留須手動刪 |
| 錯誤分組與樣本裁切 | 正規化訊息去重；樣本各限 2048 字元掐頭留尾 | 僅數字不同的原因會合併；超長回應中段省略；Python／JS 正規化須手動同步 |
| 單一 Key 測試次數 | 依序連跑兩輪、滿額才算續跑完成 | 單 Key 服務商測試耗時與請求數加倍 |
| 儲存後端預設值 | 未填 `STORAGE_BACKEND` ＝ `d1` | 僅綁定 KV 的舊站台直接升級新版會全數 500；須按 README 順序搬移上線 |
| `store` 與 `key_state` 分工 | `store` 存 JSON、`key_state` 為關聯表 | 無法對設定內容下 SQL 篩選，換取 KV／D1 共用大部分讀寫邏輯 |
| 搬移與還原備份 | 先備份 KV 才搬移；`--restore` 前再備份 D1 | 本機備份檔含明文 Key，須由管理員妥善保管權限 |
| 轉發失敗與恢復 | 非 2xx 一律計數換鑰；每日測試 `valid_keys` 自動恢復 | 上游全面故障會使當次選用 Key 計數禁用；手動「测试」只記失敗不代替恢復，避免成為繞過門檻後門 |
| Gateway 日誌與快取 | 深連結前往儀表板；預設帶 `cf-aig-skip-cache: true` | 深連結 URL 需先於真實帳號抄錄設定；不啟用快取確保標註與最近使用時間不失真 |

---

## 十一、KV → D1 與輪詢轉發設計演進（2026-11-09 至 2026-11-10）

### 11.1 後端架構與原子性取捨

- **預設採用 D1 的理由**：輪詢要求每筆請求精準更新最近使用時間與失敗計數，KV 最終一致性與每日 1,000 次寫入上限無法負荷。D1 以單一條 `UPDATE … RETURNING` 同時完成選鑰與推進時間戳；時間戳於**取用當下**寫入並取 `MAX(now, 全域最大值 + 1)`，防止重試迴圈或同毫秒並發選中同一把 Key（`NULL` 在 `ORDER BY ASC` 排最前，讓新金鑰優先輪用）。
- **無跨語句交易的因應**：每個狀態異動皆設計為單一原子 SQL 語句，中斷最多少記一次帳，不致損壞帳本。
- **非 2xx 單一失敗規則**：不同供應商對無效金鑰回傳碼不一（Gemini 回 400），依狀態碼分流會讓無效 Key 永不被換掉；重試用完時原樣回傳最後一次上游回應並使用原始位元組重送。
- **移除 `ollama`**：無實際使用配置且其 `api_base` 不含版本前綴，移除後所有服務商皆一致遵守「填至版本前綴」規則，儲存時對 `ollama` 直接回 400。
- **標頭淨化順序**：清除呼叫端 `Cookie`、跳躍式標頭與所有 `cf-aig-*` → 換上金鑰認證標頭 → 套用 `Custom Headers`（可覆蓋認證） → 最後寫入系統自有 `cf-aig-*`（其中 `cf-aig-metadata` 嚴格限 ASCII，因 HTTP 標頭僅支援 Latin-1，全形字會讓 `fetch` 拋出 `TypeError`）。
- **同步失敗防護（B′）與精準還原**：選鑰後立即以 `provider.keys` 複核，已從來源刪除的列即刻刪除重挑（不採「先帳本後設定」以免未存入設定先生效）；僅整個指紋一列都沒有時才自動補列，部分缺列顯示 `synced: false`。`--restore` 採先 upsert 再刪多餘列的精準快照還原，與 `export` 共用 20000 筆上限。

### 11.2 轉發頁版面與元件設計決策

- **上方外框工具列＋每把金鑰小卡**：`.proxy-toolbar` 採與下方 `.proxy-key-card` 一致的 `--bg-2`／`--border`／`--radius` 外框並保留內距（桌機 `1.25rem`、手機 `1rem`），使內部控件與外框維持明確間距；下方改以每把金鑰小卡呈現（右上保留與表格一致的 `.copy-btn` 複製明文、右下以 `margin-left: auto` 固定擺放「测试」／「恢复」按鈕、卡片資料簡化為「失败」與相對時間「最近使用」— 60 秒內固定顯示 `60 秒前`，其餘依分鐘／小時／天往上累計且最高單位為天；失效卡片則比照「来源设定」採整卡灰階降不透明度並於左下顯示純粗體文字「已失效」，正常金鑰不再加膠囊徽章），`maskKey()` 採左 6 ＋ 1～3 個 `*` ＋ 右 3（≤9 字元直接顯示），並維持四個分頁一致的卡片語言與 `--control-h`（`2.5rem`）控制項高度。
- **測試模型選單來自來源設定，但選擇獨立保存**：候選清單直接讀取 `providers[].models` 避免重複輸入，預設選取第一個模型，但仍須按下「保存模型」寫入獨立的 `app_settings.proxy_test_models` 才啟用測試，防止調整來源設定模型順序時意外更改探測對象。
- **工具列「恢复所有密钥」按指紋批次恢復**：在「测试无效密钥」旁新增「恢复所有密钥」，於後端 `POST /api/proxy/recover` 支援 `{ fp, all: true }` 執行單條 `UPDATE key_state SET disabled = 0, fail_count = 0 ... WHERE fp = ? AND disabled = 1`，僅恢復當前選中服務商已禁用的金鑰而不影響該服務商仍有效金鑰的 `fail_count` 或其他服務商狀態；按鈕本身不依賴測試模型即可操作，僅於轉發啟用且當前服務商存在已禁用金鑰時可點擊。
- **統計配色與對齊層級**：`有效` 與 `无效` 採用比 `14px` 正文大一級的 `--text-base`（桌機 `16px`／`700`）而不搶成第二標題，數字右對齊固定 2 位數寬度（與標籤保持至少 1 個空格、1 位數自然補成 2 個空格視覺對齊、3 位數以上保持 1 個空格並將 `无效` 往右延伸而維持 8 個空格間距），並改用柔和的 `--ok-soft`／`--fail-soft`（淺色主題下反向調整飽和度與亮度以保持白底對比度）。
- **單一頁首 Gateway 按鈕**：移至頁首 `重新读取` 右側，因其檢視整家服務商流量而非探測單把金鑰；箭頭 `↗` 使用 `aria-hidden="true"` 保持無障礙名稱為「Gateway 记录」，無可用網址時保持停用不隱藏，維持頁首位置穩定。

### 11.3 前端 CSS 與互動陷阱紀錄

- **`aria-disabled` 樣式**：`<a class="btn">` 不受 `:disabled` 匹配，須於 `.btn` 與各 `:hover` 規則補上 `[aria-disabled="true"]` 處理，避免無法點擊的連結仍有懸停高亮。
- **RWD 順序與縱向 `flex-basis`**：轉發樣式必須排在 `── RWD` 區段之前才不會覆蓋手機斷點；`.proxy-toolbar-row` 轉成 `column` 後 `flex-basis` 會變成元素高度，因此 `.proxy-url` 在手機斷點須重設為 `flex: none` 並改為自動換行。
- **模型選單 `flex: none` 固定寬度**：`.proxy-model-select` 必須使用 `flex: none` 配明確 `15rem` 寬度；若使用可縮減的 `flex-basis`，右側群組計算內在寬度時只會量到選項文字寬度，導致後方按鈕提前換行。
- **「保存模型」按鈕寬度穩定**：點擊後文字從「保存模型」（4 字）變為「已保存」（3 字）時，`.proxy-save-model` 以縱向 flex（`gap: 0`）搭配零高度 `::after` 錨定四字實際字體寬度（不硬寫 `rem` 或行內 `style`），並以 `content: "保存模型" / ""` 防止螢幕閱讀器重覆唸出；同時於 `app.js` 使用 `proxySaveModelTimer`（與 URL 複製用的 `proxyUrlTimer`）追蹤計時器，在連點或重畫工具列（切換服務商）時清除舊計時器。
- **控制項高度齊一與手機端按鈕特異性**：`.btn` 統一帶 `1px solid transparent` 邊框使 `.btn-primary`／`.btn-danger-solid` 與有框按鈕完全同高，`.input-select` 與 `.input-text` 一律釘死 `height: var(--control-h)`；在 `@media (max-width: 640px)` 內重新宣告 `.btn-sm`（含 `.dk-filter-actions .btn`）、`.btn-xs` 與 `.btn-icon` 內距與字級，避免手機端 `.btn` 的大內距覆寫小按鈕與複製圖示尺寸；並以 `.dk-filter-panel, .proxy-toolbar`、`.provider-grid, .proxy-key-grid` 及 `.provider-card, .proxy-key-card` 共用外框與間距規則。
- **批量測試保留單卡結果與請求競態防護**：`runProxyBatch()` 與 `testProxyKey()` 在觸發 `loadProxyState({ preserveResults: true })` 時保留 `state.proxyLastResults`，並保證於 `finally` 解鎖工具列與卡片按鈕；所有分頁載入器皆帶遞增請求序號（`state.reqSeq`）丟棄過期回應；各彈窗以 `openModal`/`closeModal` 堆疊支援頂層 `Esc` 關閉（關閉時僅清除彈窗內殘留焦點，不把焦點退回原按鈕，並移除按鈕／頁籤／折疊表頭的預設黑框焦點標註）。

### 11.4 尚待正式線上環境複驗項目

1. **D1 高並發寫入序列化**：線上以真實並發請求確認同一服務商不會重複挑中同一把 Key。
2. **AI Gateway 線上行為**：確認 Custom Provider 路徑拼接、`cf-aig-metadata` 篩選，並於真實帳號抄錄日誌深連結格式填入 `AI_GATEWAY_LOGS_URL`。
3. **每日 GHA 排程、真實 KV `list()` 分頁與真實上游長串流首字延遲**。
