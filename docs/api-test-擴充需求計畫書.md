# api-test 擴充計畫：輪詢轉發、黑名單與 D1 儲存

## 1. 這個專案現在是什麼、要做什麼

現有的 `api-test` 是一個「API 金鑰體檢站」：
在網頁上登記多個 API 服務商（Provider）和一批金鑰，GitHub Actions 每天跑一輪測試，
把哪些金鑰可用、哪些模型的表現如何，展示在網頁上，並發 Discord 通知。

這次要擴充的方向用一句話說：**把「體檢報告」升級成「體檢＋值日」**——
同一批金鑰能直接對外提供轉發服務，並在網頁上多兩個頁面管理它們：

```
呼叫方（軟體） ──請求──> api-test（轉發站） ──往外轉發──> OpenAI / Gemini 等
（例如聊天軟體）          ├─ 依呼叫方指定的服務商轉發
                          └─ 金鑰輪用、避開壞鑰、記錄，都在這裡
```

```
軟體送出  POST https://我的網址/proxy/服務商別名/chat/completions
轉發成    POST https://api.openai.com/v1/chat/completions
```

別名之後的路徑是**相對於該服務商 `api_base` 的路徑**，原樣接在 `api_base` 後面（實作在 `targetUrl()`）。

先把「規則」跟「慣例」分清楚：

- **規則（程式事實）**：上游網址逐字等於 `api_base` ＋ 呼叫方路徑，**不自動補任何一段**。
- **慣例（各家填法）**：OpenAI／Gemini／Anthropic 的既有填法都把版本前綴放在 `api_base` 裡
  （`…/v1`、`…/v1beta`）；Ollama 不帶（但這個型別要移除了，見 R9）。
- **我上一版寫錯的地方**：把「慣例」寫成「規則」（「既有的 `api_base` 都已經含 `/v1`」）。
  程式不依賴這件事——中轉站可以把版本藏在任意前綴，所以文件只能說「以 `api_base` 為準」。

「填到根目錄」與「填到版本前綴」差在哪，用實際結果說：

| 服務商 | 填根目錄（錯） | 實際打出去的網址 | 填版本前綴（對） |
|---|---|---|---|
| OpenAI | `https://api.openai.com` | `https://api.openai.com/chat/completions` → **404** | `https://api.openai.com/v1` |
| Gemini | `https://generativelanguage.googleapis.com` | `…/models/gemini-2.5-pro:streamGenerateContent` → **404** | `…/v1beta` |
| Anthropic | `https://api.anthropic.com` | `https://api.anthropic.com/messages` → **404** | `https://api.anthropic.com/v1` |

（`get_full_endpoint()` 只補 `/chat/completions`、`/messages` 這種尾巴，版本前綴不在它的責権裡。）
呼叫端同理：`api_base` 是 `…/v1` 時送 `/proxy/別名/v1/chat/completions`，
上游會收到 `…/v1/v1/chat/completions`（第 11 節 E10）。

> 發現的措詞衝突：README 第 16 行的範例寫 `https://api.openai.com/v1`（帶版本前綴），
> 但同份 README 第 68 行寫「`api_base` 只需填到根目錄」，編輯器的 Provider Type 提示又只列後綴。
> 三處合起來很容易被讀成「版本前綴會自動補」。要不要把這兩處措詞改成
> 「填到版本前綴（端點尾巴之前的那一段），例如 `…/v1`」——這是改既有 README 與 UI 文案，**待確認**。

各類型服務商的建議呼叫路徑（與既有 `get_full_endpoint()`、`SAMPLE_PATHS` 一致；Ollama 移除後只剩三種）：

| Provider 類型 | 建議呼叫路徑 |
|---|---|
| openai | `/chat/completions` |
| gemini | `/models/{model}:streamGenerateContent?alt=sse` 或 `:generateContent` |
| anthropic | `/messages` |
（ollama 的 `/api/chat` 隨 R9 一起移除。）

網址以外的部分（請求內容格式、回覆格式）一律不修改、不重新打包。

三個角色（沿用既有架構的位置）：

- **呼叫方（客戶端）**：任何能自己填 API 網址的軟體，例如聊天軟體、命令列工具。只負責發出請求。
- **本專案（Cloudflare Pages）**：既有的網頁、API 和測試排程都在這裡；這次在其上加「轉發」這個新職責。
- **上游服務**：OpenAI、Gemini 等真正的 AI 服務。

## 2. 既有的、這次不動的

原則：**現有的管理介面與功能一律不改行為**，新東西全部用「新增」的方式疊上去。
唯一會改變既有部署行為的是 R0 的預設儲存層（`STORAGE_BACKEND` 沒填時改成 `d1`），
因此上線順序是固定的：先建好 D1 資料庫並綁定 `DB`、跑完搬移指令，再讓新版本生效（見 R0）。
另一個例外是儲存時的輸入驗証：別名格式／重複與 `provider_type` 白名單現在會回 400（見 R9、§12.2）。

| 既有能力 | 現況說明 |
|---|---|
| 來源設定頁（記事本 UI） | Provider 卡片＋金鑰一行一個的文字框，**照舊使用**；金鑰的新增與刪除就靠編輯這個文字框，不做單筆管理介面 |
| 自訂內容 | 每個 Provider 可設定 Extra Body（JSON）與 Custom Headers（同名覆蓋）；**轉發時同樣生效**（見 R1） |
| 定期檢查 | GitHub Actions 每日定時＋手動觸發；`async_test_keys.py` 測試邏輯不改 |
| 測試結果網頁 | 測試結果 Tab：有效／無效金鑰、模型性能、執行進度，照舊 |
| 失效金鑰機制 | 既有黑名單（`dead_keys`）與相關端點，由每日測試結果自動同步、可人工編輯；**這次完全不動**，也與轉發的禁用狀態無關（轉發的禁用另記在 `key_state`，見 R3、第 7 節） |
| 轉發新欄位 | Provider 物件新增兩個欄位：`alias`（轉發別名）與 `gateway_provider`（AI Gateway 的 custom provider slug，留空＝直連）；舊資料沒有這兩個欄位時視為未設定，行為不變 |
| 登入門禁 | `ADMIN_PASSWORD`（管理用），登入後 30 天 session cookie |
| 通知 | Discord Webhook（每日測試完成後） |
| 網頁外觀 | 深淺色模式、手機版自適應、Mock 開發模式等既有 UI 慣例，新頁面跟著走 |

## 3. 這次要做的（總表）

| 編號 | 名稱 | 一句話說明 |
|---|---|---|
| R0 | 儲存層切換 | 加一個設定變數決定用 D1 還是 KV；沒填就預設 D1 |
| R1 | 透明轉發 | 新增轉發網址：按呼叫方指定的服務商，原樣轉發到上游，並沿用該服務商的自訂 body／header |
| R2 | 輪流使用 | 同一服務商多把金鑰時，優先用最久沒用過的那把 |
| R3 | 失敗計數與禁用 | 金鑰類的失敗（401／402／403／429／5xx…）記一次失敗；累計到門檻就禁用，恢復一律手動 |
| R4 | 換鑰重試 | 遇到可重試的失敗時，自動換下一把金鑰再試 |
| R5 | 即時單鑰測試 | 網頁上按按鈕立刻測單把金鑰，馬上知道可用與否 |
| R6 | 新頁面「輪詢轉發」 | 每個服務商一張卡片：轉發網址、金鑰狀態、測試與恢復按鈕 |
| R7 | 查看 Gateway 紀錄 | 不自建紀錄頁；卡片上提供按鈕直接開到 AI Gateway 儀表板的對應紀錄 |
| R8 | 來源設定的小增補 | 編輯面板加搜尋；儲存時金鑰變少要先確認，防止手滑刪錯 |
| R9 | 移除 ollama 型別 | Provider Type 只留 openai／gemini／anthropic，相關程式與文件一起清 |

## 4. 與 Cloudflare AI Gateway 的關係（本計畫採用混搭）

Cloudflare 有個官方的「AI Gateway」服務，也是做 AI 請求代理，核心功能免費且額度獨立
（不佔本專案的 Pages 請求額度；請求本身不算你的 Workers 請求，只有你在 Pages 上打的 `fetch` 才計入）。
日誌保留依帳號建立第一個 gateway 的時間分兩種制度（2026-11 查證官方文件）：

| 帳號 | 日誌存放 | 免費額度 | 保留 |
|---|---|---|---|
| 2026-09-24（含）之後建立第一個 gateway | Workers Logs | 20 萬筆／天 | 3 天 |
| 之前就建過 gateway | Legacy Logs | 10 萬筆**總量**（跨所有 gateway） | 依方案儲存上限 |

以每天 100～1,000 次轉發估算，兩種制度都夠用（見第 9 節）；
但「每天 20 萬筆」只對新帳號成立，舊帳號是「總共 10 萬筆」，要定期清理才不會打滿。
本計畫採用**混搭**：本專案當腦（門禁、輪詢、黑名單、換鑰、UI），
AI Gateway 當轉發的最後一程（上游），白拿它的加值能力。

| 工作 | 誰負責 |
|---|---|
| 門禁（轉發密碼）、輪詢選鑰、失敗計數與黑名單、換鑰重試、自訂 body／header | 本專案 |
| 請求紀錄與分析（成功與失敗、模型、token 用量、成本、狀態碼、耗時，含金鑰標註）與逾時保護（快取預設關閉） | AI Gateway |

接上去的方法：本專案轉發時，上游網址填 AI Gateway 的 custom provider 網址
（它的認證用 Cloudflare API token 只存在本專案的部署設定裡，呼叫方永遠碰不到，
之前「token 太重不適合發給呼叫方」的疑慮就不存在），
並在每筆請求加一個標註（`cf-aig-metadata`）寫明「這次用了哪把金鑰（頭尾幾碼）」與服務商別名，
它的日誌就會記下每把金鑰的使用情況，可在它的儀表板搜尋、篩選（每個請求最多 5 筆標註）。

實作上的四個部署變數（程式碼用的是這組名字）：

| 變數 | 用途 |
|---|---|
| `AI_GATEWAY_ACCOUNT_ID` | Cloudflare 帳號 ID（網址裡的 `{帳號}`） |
| `AI_GATEWAY_ID` | 网关名稱（網址裡的 `{gateway}`） |
| `AI_GATEWAY_TOKEN` | gateway 認證權杖，會寫入 `cf-aig-authorization` |
| `AI_GATEWAY_LOGS_URL` | 儀表板日誌頁的網址模板，支援 `{key}`、`{provider}` 兩個佔位符 |

四個都設好才算「gateway 就緖」（`upstreamReady()`）；Provider 沒填 `gateway_provider` 或四個沒齊，
該服務商就退回直連 `api_base`（卡片上會標「直連」）。轉發時送入的 gateway 標頭：
`cf-aig-authorization`、`cf-aig-skip-cache: true`、`cf-aig-max-attempts: 1`、
`cf-aig-request-timeout`（取自 `PROXY_UPSTREAM_TIMEOUT_MS`）、
`cf-aig-metadata`（內容是 `{"key":"abcd-wxyz","provider":"別名"}`；8 字以内的短金鑰用 `a***z`，
避免在日誌裡把整把金鑰拼出來）。

兩個必須遵守的細節（都已查證）：

- **標註值只能是 ASCII**。標註走 HTTP 標頭，值只能是 Latin-1；
  用「…」之類的全形字元會讓 `fetch` 直接拋錯（離線實測：`TypeError … value of 8230`）。
  一律用 ASCII 連字號，例如 `abcd-1234`，不要用 `sk-a…1`。
- **標註與控制標頭由本專案自己寫**。呼叫方自帶的 `cf-aig-*` 一律丟掉，
  否則任何人都可以偽造「這次用了哪把金鑰」或塞入自己的 gateway 權杖。

它能取代的：

- **請求層級的完整紀錄**：成功**與失敗**都有（日誌含狀態碼，儀表板可按錯誤類型與金鑰標註篩選），
  含模型、token、成本、耗時；保留期見上面的表。因此本專案不再自建紀錄頁（見 R7）。
- **超時保護**：上游太久沒回應就提前切斷，用 `cf-aig-request-timeout` 逐筆指定（毫秒）。
- **它沒有、也替代不了的**：失敗計數與禁用的狀態帳本——這是即時的控制資料，
  只能記在本專案的資料庫（key_state 表），與「給人看的紀錄」是兩回事。

它預設**不啟用快取**（本計畫的選擇）：快取會讓同一段對話拿到上一次的舊答案，
而且命中快取時請求不會到上游，金鑰標註與「最近使用」就跟實際情況對不上。
轉發時帶 `cf-aig-skip-cache: true`（已實作，逐筆送出）；真有需要省 token 再逐筆打開（`cf-aig-cache-ttl`）。

它不能取代的（本計畫照做）：

- 自動輪詢（它預設永遠用同一把金鑰，不會輪）。
- 失敗換鑰重試（它的重試都是同一把金鑰，不會跳下一把）。
- 黑名單、失敗計數、手動恢復。
- 門禁密碼（給呼叫方的還是單純的轉發密碼）。
- 自訂 body 注入、批量測試、匯出、排序、自訂網頁。

自訂上游：它的「Custom Providers」功能支援任何 HTTPS 的 OpenAI 相容網址
（例如第三方中轉站），在它的儀表板登記一次即可。路徑拼接規則官方已經寫明，不是黑箱：

```
請求 URL：  https://gateway.ai.cloudflare.com/v1/{帳號}/{gateway}/custom-{slug}/{廠商路徑}
上游 URL：  {base_url}/{廠商路徑}
```

也就是 `custom-{slug}/` 之後的路徑**原樣接在 `base_url` 後面**，且 `base_url` 只放網域（或固定前綴）。
因此本計畫的做法是：**每個服務商都登記成 Custom Provider，`base_url` 填該服務商的 `api_base`**，
轉發時把「呼叫方路徑」當作 `{廠商路徑}` 送出——結果就等於 `api_base` ＋ 呼叫方路徑，
與直連時的規則完全一致，不需要為 openai／gemini／anthropic 各寫一套拼接邏輯。
登記不了的（例如本機自架、不對外的端點），該服務商的上游維持直連 `api_base`，不經過 AI Gateway。

不啟用的功能：Guardrails（內容審查，用 AI 掃描對話內容是否有害）與 DLP（掃描個資）
與本專案的金鑰管理無關，而且 Guardrails 會依 token 計費，不開。

## 5. 明確不做的範圍

- 不做多會員註冊、多租戶、計費功能（維持單管理員）。
- 不做權重分配與多機器分發（只做輪流使用）。
- 不改現有的記事本式金鑰 UI：不做單筆新增／刪除／匯入介面；金鑰管理就在來源設定的文字框完成，
  R8 只加「搜尋、儲存前確認、匯出 txt、排序」四個小增補，不新增任何 FORM 式的金鑰管理頁。
- 不做冷卻機制：失敗不禁用前照常參與輪用，禁用後一律手動恢復，沒有自動恢復計時。
- 不改寫 `async_test_keys.py` 的測試邏輯（每日測試行為維持原樣）。
- 轉發與管理功能不開放「其他網站的網頁」直接呼叫（呼叫方是軟體或程式；自家管理網頁同域，沒有跨域問題）。
- 不修改非 JSON 的轉發內容（需要補欄位的請求限 JSON 格式；純轉發的內容不受限）。
- 不使用 Redis 或任何常駐伺服器；KV 模式下不提供轉發（原因見 R0、R1；紀錄本就交給 AI Gateway）。

## 6. 功能需求

每條都附「怎麼算通過」的驗收方式。

### R0　儲存層切換（KV ⇄ D1）

- 新增部署設定變數 `STORAGE_BACKEND`，可填 `d1` 或 `kv`；**沒填時預設 `d1`**；填其他值直接報錯，不靜默回退。
- 既有的全部功能（設定、測試結果、進度存檔、失效金鑰、登入）在兩種模式下都能正常運作：
  - `kv` 模式：維持現狀（每天只跑一次測試，寫入量低，現有功能正常）。
  - `d1` 模式：D1 新增資料庫連結（綁定名稱 `DB`）；現有的每一種資料在 D1 裡有對應的存放方式（見第 7 節）。
    實作上的關鍵：**`_worker.js` 一行都不用改**——它只對儲存層做 `get`／`put`／`delete`／`list`，
    在 D1 上包一層同樣介面的轉接層即可（已用未修改的 `_worker.js` 跑完整回歸驗證，見第 11 節）。
- 提供搬移與備份工具（已實作）：
  - 網頁 API：`GET /api/storage/export`（只讀 KV，先抽一份備份、又不需要 D1 可用）、
    `POST /api/storage/migrate`、`POST /api/storage/restore`。
  - 命令列：`npm run migrate`（`scripts/migrate-kv-to-d1.mjs`），
    參數 `--base-url` / `--password` / `--backup-dir` / `--dry-run` / `--restore <backup.json>` / `--allow-empty` / `--yes`。
  - 行為：**先寫備份、再搬、最後驗証**；KV 沒有任何資料時預設中止（要加 `--allow-empty`）；
    置換（restore）前會再備份一次當前 D1；重跑安全（upsert＋`DO NOTHING`）。
  - `key_state` 初始列也一併从 `app_settings` 的金鑰清單產生（全部正常、未禁用）。
  - 真實 KV 的 `list()` 是分頁的（`cursor` / `list_complete`），搬移已確認會跑完所有分頁。
- **備份到底是什麼（先前沒寫）**：備份不是新功能，它就是「搬移前先把 KV 抄一份」的產物，
  檔名 `backups/kv-backup-YYYYMMDD-HHMMSS.json`（已 gitignore、權限 `0600`）。內容是兩個東西：
  - `entries`：`store` 表的鍵值對，也就是 `app_settings`（來源設定）、`results:{指紋}`（測試結果）、
    `checkpoint:{指紋}`（進度）、`dead_keys`（失效金鑰）這四種 KV 值；
  - `key_state`：轉發帳本的每一列（`fp`、`api_key`、`last_used_at`、`fail_count`、`disabled`、`updated_at`）。
  換句話說，備份就是「來源設定 ＋ 測試資料 ＋ 轉發狀態」的完整快照。
- **restore 是精準回滾（已定案、已實作）**：備份定義的就是「那一刻的完整狀態」。實作順序是
  **先 upsert 備份內容、再刪掉備份裡沒有的列**（`store` 與 `key_state` 各一次），
  這樣中途失敗只會留下超集（安全），成功後 D1 完全等於備份那一刻；回應多兩個數字
  `store_removed`、`key_state_removed`。
  具體差異：備份後才新增的 provider「X2」，它的 `results:{指紋X2}`、`checkpoint:{指紋X2}`、
  `key_state` 列都會被刪掉——不會出現「設定回到舊版、但新資料還留著，哪天把同一個 `api_base` 加回來就復活」的情況。
  注意：如果你只是想退回舊的儲存模式，**不需要 restore**，把 `STORAGE_BACKEND` 設回 `kv` 就好（KV 仍綁著）。
- **兩端統一的筆數上限（本次修正）**：`export` 與 `restore` 都限 20000 筆（`STORAGE_MAX_ENTRIES`）。
  先前只有 restore 有上限，所以可能匯出一份「存得出來、還原不了」的備份；現在匯出就會先回 400 並說明。
- 選錯模式時行為明確，但要注意 Pages Functions **沒有啟動階段**——它只在請求進來時執行，
  所以「部署時檢查」做不到；做法是在每一筆 `/api/*`、`/proxy/*` 請求前先檢查設定，
  不對就回 500 ＋明確訊息（例：`STORAGE_BACKEND=d1（未設定時的預設值）但沒有綁定 D1 資料庫 DB`），
  同時靜態資源（網頁本體）照常載入，人看得到錯誤訊息而不是空白頁。
- 資料表不需要手動初始化：`ensureSchema()` 會在每次 D1 存取前執行（以 binding 物件為單位做了 memoize），
  新綁定的空資料庫第一筆請求就能用。
- **上線順序是硬性要求**：預設值改成 `d1` 後，既有只用 KV 的部署如果直接強制部署，
  每一個 API 請求都會 500。順序必須是：① 建 D1、綁定 `DB`；② 跑搬移；③ 設 `STORAGE_BACKEND=d1`（或不設）；
  ④ 部署新版本。若想先部署再搬，就先明確把舊部署設成 `STORAGE_BACKEND=kv`。

驗收：兩種模式各部署一次，每日測試、網頁查看、登入全部正常；搬移指令把 KV 資料搬到 D1 後切換，資料一致；
`d1` 但只綁 KV 時每一筆 API 請求都回可讀的錯誤，網頁本身打得開。

### R1　透明轉發

- 轉發功能放在同一個 Pages 專案裡，新網址格式：`/proxy/{服務商別名}/{相對於 api_base 的路徑與查詢字串}`。
  每個 Provider 在編輯面板多一個「轉發別名」欄位（例：`openai-main`），呼叫方的網址填
  `https://我的網址/proxy/openai-main/chat/completions`（`api_base` 已含 `/v1`，見第 1 節）。
- **別名格式與唯一性**：只允許小寫英數與連字號（`^[a-z0-9][a-z0-9-]{0,63}$`），整份設定不可重複；
  儲存時驗證失敗就回 400，不要留到轉發時才 404。未設別名的服務商在卡片上顯示提示，不可轉發。
- **已停用的服務商不轉發**：`enabled: false` 的 Provider 對轉發請求回 503（與既有「已停用」不參與每日測試的語意一致）。
- 只把網址的前段換成該 Provider 的上游網址——預設為該服務商對應的 AI Gateway 網址（見第 4 節；
  AI Gateway 登記不了的服務商退回直連 `api_base`），路徑與查詢字串原樣接在後面；
  其餘全部原樣傳遞，包括串流回覆（已驗證：SSE 分多個 chunk 抵達，安全標頭包裝不會把它緩衝成一次性回應）。
- 轉發請求加 `cf-aig-metadata` 標註（金鑰頭尾幾碼＋服務商別名，**只能 ASCII**，見第 4 節），
  讓 AI Gateway 的日誌能識別每筆請求用了哪把金鑰。**只在走 AI Gateway 時加**：
  直連時不把 Cloudflare 的控制標頭與權杖送給第三方中轉站。
- **標頭處理（必須）**：丟掉呼叫方的 `Cookie`、跳躍式標頭（`Host`、`Content-Length`、`Connection` 等）
  與所有 `cf-aig-*`；協定標頭換成選中金鑰後，才套用 Custom Headers，
  最後由本專案寫入自己需要的 `cf-aig-*`。
- 上游回什麼狀態碼，就原樣回給呼叫方（內部另依 R3 分類處理，不改回覆內容）。
- **沿用來源設定**：該 Provider 的 Extra Body（與請求 JSON 合併，同名鍵覆蓋）與 Custom Headers（同名覆蓋）
  在轉發時同樣生效；認證標頭由本專案換上當次選中的金鑰，依 Provider 類型決定：

  | Provider 類型 | 認證標頭 |
  |---|---|
  | openai | `Authorization: Bearer 金鑰` |
  | gemini | `x-goog-api-key: 金鑰` |
  | anthropic | `x-api-key: 金鑰` ＋`anthropic-version: 2023-06-01` |

  Custom Headers 在認證標頭**之後**套用，所以同名時可以覆蓋（與 `async_test_keys.py` 的順序一致）。
- 認證：呼叫方帶**轉發密碼**（部署設定變數 `PROXY_PASSWORD`），與管理用的 `ADMIN_PASSWORD` 互相獨立——
  拿到轉發密碼的人不能進管理網頁，帶管理密碼來轉發也一律 401。
  密碼接受的位置：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key` 三者任一（用哪一種由 SDK 決定——
  Anthropic SDK 只送 `x-api-key`、Gemini SDK 只送 `x-goog-api-key`，只認 `Authorization` 就會把官方 SDK 全部擋掉）。
  `PROXY_PASSWORD` 未設定 → 503 `PROXY_DISABLED`；
  **`PROXY_PASSWORD` 與 `ADMIN_PASSWORD` 相同也直接 503**（兩個密碼同値等於沒有分権，已實作）。
- 上游逾時：`PROXY_UPSTREAM_TIMEOUT_MS`（毫秒，預設 120000，夾在 1 秒～10 分鐘），
  每一筆上游請求都包 `AbortSignal.timeout`；走 gateway 時同一個值也寫進 `cf-aig-request-timeout`。
- 轉發功能需要 D1 模式：`kv` 模式時轉發端點回 503 並說明要切換模式（原因見 R0、第 9 節）。

驗收：同一請求分別打官方網址與轉發網址，回覆內容與格式完全相同；串流逐步出字；
設了 Extra Body／Custom Headers 的服務商，轉發時上游實際收到這些內容；
未帶密碼、帶錯密碼、帶管理密碼都會被拒（401）；
三種 SDK 風格的密碼標頭都能過；呼叫方自帶的 `cf-aig-metadata` 與 Cookie 不會到達上游。

### R2　輪流使用

- 同一 Provider 有多把可用金鑰時，優先用「最久沒用過」的那把（效果等同輪流）。
- 被禁用（黑名單）的金鑰不參與輪用；失敗但尚未達禁用次數的金鑰**照常參與**（沒有冷卻）。
- 「最近使用時間」在**取用金鑰的當下**就更新，不是等成功才更新——
  否則重試迴圈會一直挑到剛剛失敗的那一把，而且壞鑰會永遠排在最前面。
- 選鑰與更新最近使用同一個原子語句完成，避免兩個並發請求挑到同一把：

  ```sql
  UPDATE key_state
     SET last_used_at = MAX(?1, COALESCE((SELECT MAX(last_used_at) FROM key_state WHERE fp = ?2), 0) + 1),
         updated_at   = ?1
   WHERE id = (SELECT id FROM key_state
                WHERE fp = ?2 AND disabled = 0
                  /* 重試時跳過已試過的 id */
                ORDER BY last_used_at, id
                LIMIT 1)
  RETURNING id, api_key, fail_count;
  ```

  兩個要點：① SQLite／D1 的 `ORDER BY … ASC` 把 `NULL` 排在最前面，所以剛搬過來的金鑰（從沒用過）
  自然先被挑到，不需要額外條件；② `MAX(now, 同一 fp 的最大值 + 1)` 保證同一毫秒內的兩次取用也會得到
  嚴格遞增的值，否則重試可能拿到同一個時間戳而挑回同一把。實作在 `pickKeyRow()`，
  位置參數依序是 `(now, fp, now, fp, ...排除的 id)`。
- 已知限制：上述原子性依賴 D1 對寫入的序列化；本機 SQLite 的語意已驗證，
  但「兩個並發請求真的不會拿到同一把」仍需在部署後用並發請求實測（見第 11 節）。

驗收：連續打 N 次請求（N 等於可用金鑰數量的兩倍），每把金鑰被用的次數相差不超過 1；
並發打 N 次時結果同樣平均（已離線驗證：3 把金鑰、6 個並發請求 → 2/2/2）。

### R3　失敗計數與禁用（黑名單）

- **判定規則（已定案、已實作）：任何非 2xx 都算一次失敗，並換下一把。**
  不再看狀態碼分死因。理由：同一個「金鑰無效」，OpenAI／Anthropic 回 401、**Gemini 回 400
  （`API_KEY_INVALID`）**、中轉站可能回 402／403／429；按狀態碼分類等於替每家寫一份例外，
  而且會讓 gemini 的死鑰永遠不被換掉（400 被判成「請求錯」→ 不重試、不計數）。
- 這個選擇的代價也寫清楚：一次上游故障（全部 500）或一個壞 body（全部 400），
  會把本次被挑到的金鑰全部計數，門檻 3 的話三輪就全部禁用。
  接住這個代價的是下一條「恢復」——每日測試結果會把誤記的帳抹平。
- 每次失敗把該金鑰的「連續失敗次數」加一；達到門檻（預設 3，環境變數 `PROXY_FAIL_THRESHOLD`）
  就把金鑰**禁用**，不再參與輪用。
- 成功一次（2xx）就把連續失敗次數歸零；`resetKeyFailure()` 只在 `fail_count <> 0` 時才寫，
  成功請求不多花一次寫入。
- **恢復規則（已定案、已實作）：每日測試的結果是權威。**
  `POST /api/results` 上傳後，`valid_keys` 裡的每一把金鑰都會被清成
  `disabled = 0、fail_count = 0`（`recoverKeysFromResults()`），回應多一個 `keys_recovered` 數字。
  所以「被轉發禁用、但其實還活著」的金鑰，最多等一輪每日測試（或手動觸發 GHA）就自己回來。
  卡片上的「恢復」按鈕仍然保留，給不想等的人用。
  **手動的「測試」按鈕：失敗會計數（達門檻禁用），成功不寫帳本**（不代替恢復，見 R5）。
  它是診斷工具，不是恢復管道；否則按鈕會變成繞過門檻的後門。
- 被禁用的金鑰在來源設定的記事本裡**仍然存在**（文字框不動它），只是 `key_state.disabled` 被標記為 1；
  金鑰從記事本被移除、或整個服務商被刪、或 `api_base`／`provider_type` 被改（指紋變了）時，
  對應的 key_state 列一併清除。觸發點是**「來源設定」頁按「儲存」那一刻**
  （`POST /api/settings` → `syncKeyState()`），不是每日測試、也不是轉發；轉發只讀不掃。
  **同步失敗的防護（B′，已實作）**：挑到金鑰後，會用同一份 `provider.keys`（就是「API Keys」文字框那份，
  本來就為了找 provider 讀進來了，不再多打一次 API）驗一次；不在名單裡就刪掉那一列並重挑。
  所以就算 `syncKeyState()` 失敗（目前只寫 `console.error`），**已刪的金鑰也永遠不會被送去上游**。
  反方向要先把三種情況分開（先前寫得太省略）：
  1. **網址上的別名找不到 provider** → 直接 404，根本不會走到挑鑰。
  2. **provider 存在，但「API Keys」文字框是空的** → 儲存就被擋（前端 `app.js` 與後端
     `validateProviderKeys()` 都要求至少一把，後端回 400）。所以「沒有 key 的 provider」不該存在；
     真的被 curl 寫進去也是 503 `NO_KEYS`，不會被自動補。
  3. **provider 有 keys，但 `key_state` 對這個指紋「一列都沒有」**（D1 全新沒搬移、或同步的 INSERT
     半步失敗）→ 這就是 B′ 會自動補的情況：把 `provider.keys` 補成列，下一個請求就能用。
  只有第 3 種算「整組缺列」。**部分缺列**（3 把只有 2 列）不會自動補，因為挑選會成功、偵測不到；
  但那把金鑰只是暫時不參與輪用（安全方向），卡片上會顯示 `synced: false`，重新存一次即可。
  為什麼不改成「先同步帳本、再寫設定」（方案 F）：那會讓沒能存成功的設定先被使用（未提交的金鑰先跑），
  而且改 `api_base` 時若設定寫入失敗，現行指紋會一列都沒有 → 轉發暫時 503；B′ 在使用點擋掉就沒有這些副作用。
- 與既有的「失效金鑰」（`dead_keys`）的關係：
  - 它是**另一份獨立的紀錄**，在「失效金鑰」頁可人工新增／編輯／刪除；
    每日測試上傳結果時會自動增刪（`valid_keys` → 移除該筆；已不在同 host 來源設定 → 移除；`invalid_records` → 新增）。
  - **轉發不看它**：轉發只認「來源設定」裡的金鑰，以及自己維護的 `key_state`。
  - 已定案：**不要把兩者接起來**。`dead_keys` 是紀錄，不是門檻；互相寫入只會讓兩份人工維護的清單糾纏、
    歸因變模糊。
- 同一個金鑰字串出現在兩個服務商時：`dead_keys` 是全域去重（只留一筆，重複新增回 409），
  `key_state` 則依指紋分開記。同一把金鑰可能在一邊顯示可用、另一邊已被禁用，這是設計上的取捨。

驗收：一把金鑰連續失敗 3 次後自動禁用、不再被選用；中間夾一次成功則計數歸零；
按「恢復」後金鑰重新參與輪用；**每日測試把某把金鑰回報為 `valid_keys` 後，它自動恢復並重回輪用**；
連送三次 400 壞請求，三把金鑰的 `fail_count` 都會累加（單一規則），但每日測試跑完後歸零。

### R4　換鑰重試

- 遇到任何非 2xx 的回應（見 R3）時，自動換下一把可用金鑰重發同一個請求。
- 最多換 3 次（連第一次共嘗試 4 把金鑰，環境變數 `PROXY_MAX_RETRIES`，上限就是 3）：
  可用金鑰少於 4 把時自然更早停；試過的 id 必須排除，不可循環挑回同一把。
- 重試時把原始請求內容以**原始位元組**（`arrayBuffer`）保存，每次重試用它重建請求；
  只有 `Content-Type: application/json` 的請求才併入 Extra Body，其他內容原樣重送。
- 每次失敗的換鑰都依 R3 計數（重試中失敗的金鑰也會被記帳）。
- 搭配 AI Gateway 時，轉發請求帶 `cf-aig-max-attempts: 1`（逐筆指定，不用去改 gateway 設定）：
  同一把金鑰的反覆重試沒有價值，失敗就該換下一把，換鑰的節奏才不被拖慢。
- 重試用完時，把**最後一次**的上游回覆原樣傳回（不是合成一個 500）；
  重試期間失敗的回應先讀成文字暫存（失敗回應都是小 JSON），最後一次再原樣送出。
- 上游逾時：`PROXY_UPSTREAM_TIMEOUT_MS`（毫秒，預設 120000，夾在 1 秒～10 分鐘）；
  **只涵蓋「等到回應標頭」**，收到標頭就清掉計時器，所以串流可以流得比 120 秒更久；
  逾時算一次可重試的失敗（與連線失敗相同）。走 gateway 時同一個值也寫進 `cf-aig-request-timeout`。
- 額度：一次轉發最多 4 個子請求，遠低於免費方案每請求 50 個子請求的上限；
  同時開啟的上游連線數始終為 1（依序重試，不並發）。

驗收：準備一把會失敗的金鑰與一把正常的金鑰，同一請求應自動跳過前者並成功返回；
5 把全壞時只打 4 次上游、第 5 把的計數不變；
在 AI Gateway 的日誌中可看到整個過程（失敗嘗試與成功嘗試各一筆，金鑰標註不同）。

### R5　即時單鑰測試（含批量測試）

- 在「輪詢轉發」頁的每把金鑰旁放「測試」按鈕：當場對該 Provider 的網址發一筆最小請求（
  模型從**轉發頁的測試模型下拉選單**選，選項來自來源設定該服務商的 Models；實際選了哪一個存在
  `app_settings.proxy_test_models`，以指紋為鍵，路徑後綴與第 1 節的表相同），
  回報結果：可用（附回應毫秒數）／不可用（附上游狀態碼）。
- **API 只收金鑰的列 id，不收回金鑰字串**：`POST /api/proxy/test` 的請求本體是 `{ id, fp }`，
  伺服器自己從 `key_state` 把金鑰取出來用。瀏覽器從頭到尾不需碰明文金鑰，
  也就沒有「前端持有明文金鑰」這個外洩面。回應是 `{ ok, status, ms, model, error?, fail_count?, disabled? }`，
  `status: 0` 代表根本沒連上；`fail_count`／`disabled` 只在失敗時回傳。
  前置條件：`d1` 模式（否則 503）、該服務商要有 Models（否則 400）、
  該列必須屬於這個指紋（否則 404）；**測試模型未設定時回 400**（「尚未设定测试模型」），不會偷偷用來源設定的第一個模型。
- **批量測試**：轉發頁工具列提供兩個按鈕（本條的「有效／無效」專指**轉發帳本**的狀態，
  與「失效金鑰」頁的 `dead_keys` 無關）：
  - 「測試有效密鑰」：只測 `disabled = 0`（目前未被禁用）的那些。
  - 「測試無效密鑰」：只測目前被禁用（`disabled = 1`）的那些，用來確認哪幾把已經救得回來。
  - 執行中逐筆顯示進度與結果（可用／不可用＋狀態碼），全部完成後彙整一次。
- **手動測試的帳本規則（已定案、已實作）**：失敗 → **計一次失敗**（達門檻就禁用，回應帶 `fail_count`／`disabled`）；
  成功 → 不寫帳本（不歸零、不恢復）。
  所以「金鑰什麼時候會變無效」只有兩條路：**手動測試失敗**，或**轉發失敗累計到門檻**；
  每日測試只負責把「無效但實測可用」的恢復，不會把原本有效的變成無效。
  代價：連按三次測試一把被限流的金鑰，就會把它禁用——按鈕本身是會寫帳本的動作，UI 會即時回報「已達門檻、已禁用」。
- 即時測試只驗「金鑰可不可用」，不做多模型矩陣測試（那是每日 GHA 的職責）。
- 批量測試逐把依序進行（不提高併發，避免被上游風控）；結果即時反映在卡片上，
  詳細的請求紀錄可在 AI Gateway 儀表板查看（即時測試的請求同樣經過它）。
- 計量：每一把的測試都是一次真實請求，會計入 Pages 請求額度與 Gateway 日誌（量很小，見第 9 節）；
  上游沒回應時仍要有逾時上限，不能讓按鈕永遠轉圈。

驗收：分別對正常與假金鑰各按一次測試，結果正確（狀態碼與毫秒數都對）；
連續按同一個壞金鑰到門檻，它會被禁用（回應與卡片都要看得到）；
對一把被禁用的金鑰按測試但上游回 2xx，它**不會**自動恢復（恢復只靠每日結果或「恢復」按鈕）；
批量測試的三種按鈕各跑一輪，進度與彙整結果與金鑰實際狀態一致。

### R6　新頁面「輪詢轉發」

- 在現有網頁新增一個 Tab（與「來源設定」「測試結果」「失效金鑰」並列），登入後可用；
  `kv` 模式或設定不完整時，Tab 仍存在，但顯示 `/api/proxy/state` 回傳的 `proxy_message`
  （例：「转发需要 STORAGE_BACKEND=d1」「PROXY_PASSWORD 未设定」），測試／恢復按鈕停用。
- **版面（2026-11-10 改版）**：上方是一整排控制項，下方每把金鑰一張小卡；服務商本身是**下拉選單**，
  不再做成大卡片（一個服務商十幾把金鑰時，卡片會變成又高又長的柱子）。

  ```
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

  **2026-11-10 修訂（控制項那一排，上圖已改）**：

  - 控制項那一段**不再包成一張卡片**：標題、控制項、下方金鑰小卡都直接落在頁面上，
    只靠行距分開（原本多一層底色＋邊框，看起來像另一個面板塞在面板裡）。
  - 服務商選單固定成**一個來源設定卡片的寬度**（工作區 1100px、三欄時為 340px），不隨右邊網址伸縮；
    選項直接把 API 格式接在名稱後面，寫成 **`別名 - 格式`**（沒有別名時用網域名稱），
    例如 `dashscope - openai`。原本選單底下那顆格式膠囊因此移除。
  - 轉發網址在選單**右邊**，是一顆和一般文字框同高的可點區塊：整塊點下去（或 Tab 聚焦後按 Enter／空白）就複製，
    所以**複製按鈕與「范例路径」小字都拿掉**。複製後欄位自己顯示「已复制」約一秒多再換回網址；
    服務商沒設別名時整塊變淡、不可點（沒有網址可複製）。**手機版**不再硬撐成一行：網址會自動換行，
    不必靠截斷才塞得下。
  - 第二列改成「**左：統計；右：測試模型與動作**」：左邊是 `有效 X 无效 Y`，**字級與字重為 16px 粗體**
    （`--text-base`／700），顏色改用一組較淡的綠與紅（`--ok-soft`／`--fail-soft`）——原本那兩個豔色是給 13px 徽章用的，
    放到 16px 粗體就變成紅綠燈；舊的 `可用 X / Y` 與斜線移除。右邊從 `测试模型` 文字開始，接著下拉選單、保存模型、
    `测试有效密钥`、`测试无效密钥`，整組靠右對齊（按下「保存模型」顯示「已保存」時按鈕寬度不收窄）。
  - **「Gateway 记录」搬到頁首**，緊接在 `重新读取` 右邊：它是整個服務商的流量檢視，不屬於這一列的探測控制；
    按鈕沿用既有的主色（紫，`.btn-primary`），文字右上方加一顆 `↗`（用 `aria-hidden` 的 `span`，
    讀屏唸到的名字仍是「Gateway 记录」），表示會另開頁面。連結仍跟著選中的服務商走，
    切換選單就換目標；沒有服務商時停用。
  - **測試模型**的候選清單直接讀來源設定該服務商的 **Models 文字框**，用下拉選單顯示；
    這裡只保留「選了哪一個」的記憶（`app_settings.proxy_test_models`，以指紋為鍵），不再重複輸入模型名稱。
    **選單預設就是 Models 的第一個**，沒有「請選擇模型」的空白選項；按「保存模型」後測試按鈕才會啟用。
    Models 為空時選單停用並提示。選單與旁邊的按鈕都與一般文字框同高，間距一致；選單寬度 **15rem**。
  - **移除「测试全部」**，批次測試只留 `测试有效密钥`（測 `disabled = 0`）與
    `测试无效密钥`（測 `disabled = 1`）兩顆，位置在模型選單右邊。

- 工具列內容：
  - **服務商下拉選單**：選項為 `別名 - API 格式`（沒有別名時用主域名）；固定一個卡片的寬度；切換即重畫下方卡片。
  - **統計**：`有效 X 无效 Y`，左邊靠左；16px 粗體，有效淡綠、無效淡紅。
  - **轉發網址**：在選單右邊，和一般文字框同高；整塊可點擊複製，未設別名時變淡並停用；手機版自動換行。
  - **測試模型下拉選單＋保存模型**：在統計右邊靠右排列，前面有 `测试模型` 文字；
    選項來自來源設定的 Models 文字框，預設第一個，實際選用的模型存在
    `app_settings.proxy_test_models`（以指紋為鍵），避免改 Models 清單時把既有選擇悄悄換掉。
    尚未保存時，測試按鈕會停用並提示。
  - **兩個批量測試按鈕**：`测试有效密钥`（`disabled = 0`）／`测试无效密钥`（`disabled = 1`）。
  - **一個統一的「Gateway 记录」按鈕**：在頁首 `重新读取` 右邊，紫色主色按鈕，文字右上角帶 `↗`；
    用 `AI_GATEWAY_LOGS_URL` 模板帶入 `{provider}`（別名）；
    不再每個金鑰各一個按鈕（排查時要的是整個服務商的流量，不是逐把 key）。
- 每把金鑰一張卡片（`auto-fill minmax(240px,1fr)`）：遮罩後金鑰、狀態徽章（正常／已禁用）、
  連續失敗次數、最近使用時間、「測試」按鈕；被禁用的另有「恢復」按鈕。卡片高度固定，不會因金鑰數量拉長頁面。
- **金鑰本體不可出現在頁面或 API 回應裡**：卡片與 `/api/proxy/state` 都只輸出遮罩後的值
  （`maskKey()`，少於 16 字元只露頭尾各 1 碼）。
- 頁面外觀沿用既有的深淺色模式、Modal、手機版自適應等慣例；
  新樣式一律加在 `style.css`，不得用 `style="…"`（CSP 的 `style-src 'self'` 會直接讓它失效且不報錯）。

驗收：工具列的元素（左邊字級同標題的 `有效 X 无效 Y`、右邊靠右的「测试模型」＋模型選單＋兩個批量按鈕、
上方固定卡片寬的服務商選單與右邊可點擊複製的轉發網址、頁首 `重新读取` 右邊的紫色 `Gateway 记录 ↗`）都在上方；
選單與按鈕和文字框同高；下方每個金鑰一張卡；切換服務商時卡片、測試模型選單與 Gateway 連結一起換；
`/api/proxy/state` 的回應裡搜不到完整金鑰。

### R7　查看 Gateway 紀錄（不自建紀錄頁）

- 失敗與成功的請求紀錄都由 AI Gateway 的日誌負責（免費額度與保留期見第 4 節），
  本專案**不再自建紀錄資料表與頁面**。
- 本專案的 D1 只存**狀態**（key_state：失敗計數、禁用標記）——這是輪詢與黑名單的即時帳本，
  Gateway 沒有任何 API 能提供，無法省略。
- 「輪詢轉發」頁**只有一個**「Gateway 记录」按鈕，放在頁首 `重新读取` 右邊（紫色主色、帶 `↗`），
  用目前選中的服務商別名（`provider`）預先篩掉其他流量；不再每把金鑰各一顆按鈕——
  排查時要看的是整個服務商的流量，逐把 key 的按鈕只會在頁面上堆出十幾個一樣的入口。
- 實作是用部署變數 `AI_GATEWAY_LOGS_URL` 當模板（支援 `{key}`、`{provider}` 兩個佔位符，
  分別換成 `metadataKeyTag()` 的 ASCII 標註與別名，都會 `encodeURIComponent`）；
  沒設這個變數時按鈕是停用狀態，`title` 會說明要設哪個變數——不會帶你去一個錯的網址。
- **待驗證**：模板本身要在真實帳號上先手動篩一次，把儀表板實際 URL 抄下來填進 `AI_GATEWAY_LOGS_URL`；
  官方文件只保證「可搜尋／可篩選」，沒有保證 URL 形式。
- KV 模式下轉發功能本就關閉，本條隨之不適用。

驗收：發生一次「換鑰重試後成功」的請求時，AI Gateway 儀表板能依金鑰標註篩出對應的失敗與成功請求；
頁首那顆按鈕能開到以目前服務商別名過濾的日誌頁，切換服務商後再點，開到的是新服務商。

### R8　來源設定的小增補（不改動既有操作方式）

- **編輯面板加搜尋**：Provider 編輯視窗裡，金鑰文字框上方加一個搜尋框（`#ed-keys-search`），
  輸入片段後即時標出符合的行（金鑰多時好找特定那一支）。
  實作形式要注意：`<textarea>` 裡的文字無法局部上色，所以做法是
  「搜尋框下方列命中清單（`#ed-keys-search-results`：第幾行、遮罩後的金鑰）」，
  不用把文字框換成 contenteditable（那會推著重寫行號、貼上、驗證等既有行為）。
  比對不分大小寫、以子字串比對；清空搜尋框就清空清單。

  > **後續變更（UI 調整，取代上面這個做法）**：命中清單已移除，`#ed-keys-search-results` 不再存在；
  > 搜尋框 `#ed-keys-search` 保留，但不再列清單，改成把符合的片段就地標成橘底（標在文字框裡，
  > 那裡的內容本來就是明碼，所以沒有「遮罩後清單」那個顧慮）；每一處都標、無圓角，做成瀏覽器
  > 自己的尋找高亮那個矩形樣子（曾短暫改成「每行只標第一處」，覺得反而不好用，已改回全部標）。
  > 搜尋框留空時，改標出在文字框裡選起的那一段。比對規則沿用不分大小寫子字串。
  > 搜尋框右端另加一顆清除鈕（向左的五邊形＋叉，即退格鍵的樣子）：框裡有字時才亮、才可點，
  > 沒字時變暗且 `disabled`。它與瀏覽器自己畫在 `type="search"` 裡的叉位置重疊，
  > 所以用 `::-webkit-search-cancel-button` 把瀏覽器那顆關掉。「不用 contenteditable」的結論不變，也仍是
  > 不動行號／貼上／驗證的原因；繞法是墊一層透明圖層——外層 `#ed-keys-highlight` 只負責裁切且
  > 不位移，內層 `.keys-highlight-inner` 放與文字框同字體、同留白的鏡射文字，只把 `<mark>` 上色，
  > 並隨捲動位移貼著文字框；文字框本身照舊是 `<textarea>`。比對規則沿用不分大小寫子字串。
- **刪除確認保護（不用彈窗）**：按儲存時，若金鑰數量比原本少，
  儲存按鈕那一排的空間直接**拉高**，就地顯示確認內容，一定看得到：
  - 顯示「即將刪除 X 支金鑰」與「將被刪除」的金鑰清單（顯示頭尾幾碼）。
  - 清單最多直接顯示 5 支，超過的部分用捲軸捲動查看。
  - 按確認後才真正儲存；按取消則回到編輯狀態（文字框回到儲存前的內容）。
  - 金鑰沒有變少時，該區域不出現，儲存行為與現在完全相同。
  - 重複的金鑰按**次數**計算：框裡同樣的值出現兩次、新內容只留一次，就是刪了 1 支。
  - 實現細節：必須用 class 切換（`.hidden`），不能用 `style="display:none"`；
    CSP 的 `style-src 'self'` 會讓 inline style 默默失效（已實測：inline 高度 40px 不生效、
   由 JS 寫 `element.style` 才生效）。離線實測：確認區一出來，按鈕排高度由 70px 長到 255px。
- **匯出檔案**：每個 Provider 的金鑰清單可下載成 `.txt` 檔（`#ed-export-keys-btn`，一行一支，與記事本格式相同，可直接再匯入）。
  內容就是文字框的內容（先 `normalizeKeys()`，去頭尾空白、丟空行）再加一個結尾換行；
  檔名用主域名＋`-keys.txt`，非法字元換成連字號。
- **排序按鈕（三段循環）**：金鑰文字框旁的排序按鈕，每按一次切換一個狀態：
  1. **預設**：不排序，保持輸入的原順序。
  2. **小到大**：按 ASCII 小到大排（A-Z，符號與數字也一起排）。
  3. **大到小**：按 ASCII 大到小排（Z-A，符號與數字也一起排）。
  再按一次回到「預設」。純前端排序，改的是文字框本身；**儲存時不做任何自動排序**，存的就是框裡的順序。
  比較基準要寫死：用 JS 預設字串比較（UTF-16 碼元），純 ASCII 金鑰就等於 ASCII 順序（數字 < 大寫 < 小寫），
  不可用 `localeCompare()`（那個會隨系統語系變、大小寫順序也不同）。
  排序**不堆疊、不刪重、不改內容**：只重排非空行；「預設」要能完全回到按下第一次前的樣子（含重複行）。
  按鈕是 `#ed-sort-keys-btn`，旁邊就是匯出。
- 遮罩函式 `maskKey()` **在 `app.js` 與 `_worker.js` 各有一份**（前端卡片／確認清單／測試清單都要一致，
  後端 `/api/proxy/state` 也用它），改一邊就要改另一邊；格式是 `abcd***wxyz`（8 字以内用 `a***z`）。
- 除此之外，來源設定頁的一切照舊。

驗收：搜尋片段能標出正確的行（含大小寫不敏感與空片段的情形）；把金鑰從 5 支改成 3 支後按儲存，
儲存列拉高顯示「即將刪除 2 支金鑰」與清單，取消則不儲存（文字框也回原狀）、確認後才生效；
匯出的 txt 用記事本格式再貼回來可完整還原；
排序按鈕按三次依序呈現「原順序 → ASCII 小到大 → ASCII 大到小」，再按一次與原內容逐字相同；
整個流程不產生 CSP 錯誤。

### R9　移除 ollama 型別（已實作）

- Provider Type 只留 `openai`、`gemini`、`anthropic`；`ollama` 的認證方式、payload 形狀與回應解析分支全部拿掉。
  沒有舊資料要處理，所以**不做任何資料遷移或相容層**。
- 改動的地方：

  | 檔案 | 改了什麼 |
  |---|---|
  | `public/index.html` | 移除 `<option value="ollama">`；Provider Type 提示改寫（順帶把「版本前綴要自己填」講清楚） |
  | `public/app.js` | 卡片示例路徑的對照表移除 `ollama` |
  | `public/_worker.js` | `applyProviderAuth()`、`SAMPLE_PATHS`、`testRequestFor()` 移除 `ollama`；新增 `PROVIDER_TYPES` 白名單 |
  | `async_test_keys.py` | `PROVIDER_TYPE` 註解、`get_full_endpoint()`、`build_payload()`、兩處回應解析分支移除 `ollama` |
  | `README.md` | 支援清單、端點後綴表移除 Ollama |

- 儲存時會擋下不支援的型別：`POST /api/settings` 回 400（`validateProviderTypes()`），
  避免有人用 curl 把 `provider_type: "ollama"` 又塞回來。
- 驗收：下拉只剩三種；儲存 `ollama` 被 400 擋下；`npm test` 有對應案例。

## 7. 資料表設計（D1 模式）

兩張表。金鑰**不見得**只住在 Provider 設定裡：`key_state` 必須留一份金鑰字串，
因為選鑰後要直接拿它去換上游的認證標頭（存雜湊就不能用了）。
這與現況一致——`results`、`dead_keys` 本來就存明文金鑰，也都靠同一個登入門禁守住。
資料庫不存請求和成敗紀錄，那些交給 AI Gateway 的日誌（見第 4 節）。

### store（既有資料的對應儲存）

既有 KV 裡的每一種資料（`app_settings`、`results:{指紋}`、`checkpoint:{指紋}` 等）
在 D1 用同一張表對應存放，名稱照舊，切換模式時程式邏輯幾乎不用改：

| 欄位 | 意思 |
|---|---|
| k | 原 KV 的鍵名（如 `app_settings`） |
| v | 原本的 JSON 內容，第一次搬移時直接複製過來 |

> 為什麼這張表沿用 JSON：這些資料永遠整份讀、整份寫（GHA 整包上傳、前端整份渲染、
> 儲存時全量替換），從不需要查其中某一列或改其中一個欄位——SQL 拆表的優勢在這裡用不上，
> 沿用 JSON 反而讓 KV／D1 兩種模式共用同一套讀寫程式碼。
> 需要 SQL 能力的是「每筆請求都要單列更新與條件挑選」的金鑰狀態，那是下一張表 key_state 的職責。
>
> 「指紋（fingerprint）」是專案裡已有的概念：由 `provider_type`＋`api_base` 算出，
> 用來在內部識別同一個服務商節點，改金鑰或模型不會讓指紋變動。

### key_state（金鑰狀態：輪用與黑名單，本計畫新增）

| 欄位 | 意思 | 型別與說明 |
|---|---|---|
| id | 編號 | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| fp | 所屬服務商的指紋 | `TEXT NOT NULL` |
| api_key | 金鑰字串（與來源設定裡的那支對應） | `TEXT NOT NULL`，與 fp 一起 `UNIQUE` |
| last_used_at | 最近一次被使用的時間（輪詢用） | `INTEGER`（epoch 毫秒），新列為 `NULL` |
| fail_count | 連續失敗次數（成功即歸零；達門檻即禁用） | `INTEGER NOT NULL DEFAULT 0` |
| disabled | 是否禁用（0／1） | `INTEGER NOT NULL DEFAULT 0` |
| updated_at | 最後更新時間 | `INTEGER NOT NULL`（epoch 毫秒） |

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

-- 選鑰用：找出某服務商未禁用、最久沒用的那一把
CREATE INDEX idx_key_state_pick ON key_state (fp, disabled, last_used_at);
```

- 時間一律存 epoch 毫秒整數，不存 ISO 字串：排序靠它，字串排序會出錯（且 `NULL` 在 ASC 裡排最前，正好是「新金鑰先上」）。
- 金鑰從來源設定移除、服務商被刪、或指紋變了（`api_base`／`provider_type` 被改）時，對應的列一併刪除；
  清理時機是 `POST /api/settings` 成功寫入後的 `syncKeyState()`（新增漏列＋刪除贅列），
  所以搬家後、或早期用 curl 寫進去的設定也能自己補齊。
  **已知弱點**：同步失敗只寫 console（`key_state sync failed`），不回報使用者，也不阻擋儲存——
  此時記事本已經沒有那把金鑰，但 `key_state` 還留著，下次轉發仍會拿它去上游（第 11 節 E6）。
- 選鑰時的「最久沒用優先」用一條 SQL 完成（見 R2 的 `UPDATE … RETURNING`）。
- 注意：**加索引會多算寫入列**（官方說明：索引欄位一寫，就是資料列＋索引列兩列），
  第 9 節的寫入估算已把這個算進去。
- D1 沒有事務 API 可以拿來包「選鑰＋記失敗」；本計畫靠「每步一個原子語句」而非多語句事務，
  所以中間斷掉也只會少記一次帳，不會把帳本寫壞。

## 8. 一筆轉發請求的處理流程

1. 檢查儲存層模式：不是 `d1` 就回 503（說明需切換），結束。
2. 檢查轉發密碼（`Authorization`／`x-api-key`／`x-goog-api-key` 任一），不對就回 401，結束。
3. 由網址中的別名找出對應 Provider；找不到就回 404，服務商已停用回 503，結束。
4. 從該 Provider 的金鑰挑一把：未禁用、最久沒用過的那把（禁用名單與失敗計數在 key_state 表）；
   取的同時就把 `last_used_at` 往後排（見 R2），並記下已試過的 id。
5. 挑不到任何可用金鑰，回覆 503「暫無可用金鑰」，結束。
6. 套用該 Provider 既有的 Extra Body／Custom Headers 規則，並換上選中金鑰的認證標頭。
7. 轉發給上游。
8. 成功（2xx）：失敗計數歸零（本來就是 0 就不寫）、回傳結果，結束。
9. 失敗：按 R3 的表分流——
   - 可重試的失敗（401、402、403、408、425、429、5xx、連線失敗／逾時）：記一次失敗
     （計數加一，達門檻則禁用），回到第 4 步換下一把；已重試 3 次或沒有其他金鑰可試就結束。
     ⚠ 5xx 目前也算在內，因此「上游全域故障」會把整組金鑰打光（R3、第 11 節 E1／E2，待決策）。
   - 不可重試的失敗（400、404、413、422…）：**不記帳、不重試**，直接把上游回覆回給呼叫方，結束。
10. 重試次數用完仍失敗：把最後一次的上游回覆原樣傳回，結束（不是合成一個 500）。

## 9. 額度檢查（免費方案夠不夠用）

以「一天 1,000 次轉發」估算（這是實際用量的上限估計，平時約 100～1,000 次；
這只是**假設的用量**，不是上限）：

> 補充：只有觸發程式的請求（`/api/*`、`/proxy/*`）算額度；
> 打開管理網頁、載入頁面樣式腳本等靜態請求，官方明定「免費且不限次數」（已查證）。
> 另兩個會卡到的硬限：每次請求 CPU 10ms（等網路不算）、子請求 50 個（重試到多 4 個，安全），
> 同時對外連線 6 條（依序重試只用 1 條）。

| 項目 | 每日用量（假設） | 免費上限 | 餘裕 |
|---|---|---|---|
| 動態請求（Pages Functions，與 Workers 共用額度） | 1,000 轉發＋每日測試的少量 API 呼叫＋管理網頁的存取 | 100,000／天 | 約 100 倍 |
| D1 讀取 | 約 2,000 列（**實測每筆轉發 3 個語句、回 2 列**：讀設定＋`pickKeyRow`；失敗歸零只在計數不是 0 時才多一個語句） | 5,000,000 | 約 2,500 倍 |
| D1 寫入 | 約 1,000 列（**實測成功請求寫 1 列**：`last_used_at`；需要歸零時再多 1 列。索引列官方另計，故估 2,000 列）＋每日測試的存檔幾列 | 100,000 | 約 50 倍 |
| AI Gateway 日誌 | 每筆轉發 1 筆（含金鑰標註；重試的那幾次也各算一筆） | 新帳號 200,000／天；舊帳號 100,000 總量 | 新帳號約 200 倍；舊帳號約 100 天量（總量制，要定期清理） |
| KV（僅 kv 模式） | 維持現狀：每天一次測試的寫入，遠低於上限 | 1,000 筆寫入／天 | 充裕 |
| GHA | 維持現狀：每日一輪 | 既有額度 | 不變 |

補充一：kv 模式不能開轉發的原因不是紀錄量（紀錄已交給 AI Gateway），而是
轉發需要每筆請求即時、精準地更新金鑰狀態（輪詢順序、失敗計數）——
KV 是最終一致且寫入上限每天僅 1,000 筆，做不了這種帳本；這正是 D1 的職責。

補充二：手動與批量測試也各算一筆 Pages 請求與一筆 Gateway 日誌；
一個 3 服務商、共 30 把金鑰的站點全量測一輪也才 30 筆，相對於日限可忽略。

補充三：重試會放大上游呼叫（一次轉發最多 4 筆），Gateway 日誌也跟著多；
以「一天 1,000 次轉發、平均 1.2 次嘗試」估算仍是千餘筆，不影響上面的結論。

結論：以每天 100～1,000 次的實際用量，所有額度都有數十倍到數百倍的餘裕，完全不用擔心；
成功與失敗的請求紀錄都交給 AI Gateway，本專案的資料庫只處理狀態（key_state），壓力更小。
就算哪天動態請求打滿 100,000，超過部分當天被拒、隔天重置，不會產生費用；真要擴充，Workers 付費方案每月 5 美元給 1,000 萬次。

## 10. 驗收清單（總整理）

- [ ] 不填 `STORAGE_BACKEND` 時預設使用 D1；填 `kv` 時既有功能一切照舊（R0）
- [ ] 上線順序：先建 D1／綁 `DB`／跑搬移，再部署；否則既有站台會全部 500（R0、第 2 節）
- [ ] 搬移指令把 KV 資料原樣複製到 store（含分頁跑完），並從金鑰清單建立 key_state 初始列，切換後資料一致（R0）
- [ ] kv 模式下呼叫轉發端點，得到清楚的「需切換 D1」訊息；轉發 Tab 也看得到提示（R0、R1、R6）
- [ ] 轉發網址按別名對應服務商，回覆與官方一致，串流逐步輸出（R1）
- [ ] 路徑規則：`api_base` 已含 `/v1` 時，呼叫方用 `/chat/completions` 不會變成 `/v1/v1/…`（R1、第 1 節）
- [ ] 轉發時自動套用該服務商的 Extra Body 與 Custom Headers，並換上選中金鑰的認證（openai／gemini／anthropic 各一種標頭）（R1）
- [ ] 轉發密碼與管理密碼互相獨立，交錯使用一律被拒；三種 SDK 風格的密碼標頭都能過（R1）
- [ ] 呼叫方自帶的 `cf-aig-*` 與 Cookie 不會到達上游；直連時不帶任何 Cloudflare 控制標頭（R1、第 4 節）
- [ ] 別名格式不合或重複時儲存被擋下；未設別名、已停用的服務商不會被轉發（R1、R6）
- [ ] provider 沒有任何 key 時儲存被擋下（400）；全部 key 被禁用時轉發回 503 `NO_KEYS`（R1、R3）
- [ ] 連續請求會輪流使用不同金鑰；並發請求也平均（R2）
- [ ] 可重試的失敗計數並最終禁用；成功歸零；恢復只能手動（R3）
- [ ] 請求本身錯誤（400 等）不計失敗、不重試；連三次也不會把金鑰禁用（R3）
- [ ] 金鑰從記事本移除後，它在 key_state 的列也跟著消失（R3）
- [ ] 失敗時自動換鑰重試，最多 3 次；全壞時只打 4 次上游並回最後一次的狀態碼（R4）
- [ ] 「測試」按鈕：失敗會計數、可達門檻禁用；成功不寫帳本（R5）；**每日測試回報 `valid_keys` 時自動恢復**（R3）
- [ ] 批量測試兩種模式（測試有效密鑰／測試無效密鑰）結果正確，執行中可看進度（R5）
- [ ] 「輪詢轉發」頁：桌面 3 卡、中間 2 卡、手機 1 卡；卡片上可完成測試、禁用、恢復（R6）
- [ ] 卡片與 `/api/proxy/state` 不含明文金鑰（R6）
- [ ] 任一金鑰可從卡片一鍵開到 AI Gateway 已過濾的日誌頁（深連結需先實測抄下來）（R7、第 4 節）
- [ ] 轉發的上游預設經 AI Gateway，加了 ASCII 金鑰標註；登記不了的服務商退回直連（R1、第 4 節）
- [ ] 轉發預設不啟用快取（`cf-aig-skip-cache: true`），不會回放舊答案（第 4 節）
- [ ] `PROXY_PASSWORD` 未設、或與 `ADMIN_PASSWORD` 相同時，轉發端點 503 `PROXY_DISABLED`（R1）
- [ ] 上游逾時可由 `PROXY_UPSTREAM_TIMEOUT_MS` 調整，逾時算失敗且可重試（R1、R4）
- [ ] 搬移工具先備份、再搬、後驗証；`--dry-run` 不寫入；`--restore` 前再備份一次（R0）
- [ ] 同一請求中全部金鑰都回 5xx／非資格類 4xx 時，不會把整組金鑰打光（R3；**目前未實作，需決策**）
- [ ] `syncKeyState()` 失敗時不會把已移除的金鑰送去上游（R3；**目前未實作，需決策**）
- [ ] 編輯面板可搜尋金鑰；金鑰變少時儲存列拉高顯示「即將刪除 X 支」與清單，最多直接顯示 5 支、其餘捲動，取消不改動文字框（R8）
- [ ] 金鑰清單可匯出 txt 檔（格式與記事本相同）且可再匯入；排序按鈕三段循環（原序／小到大／大到小），儲存不自動排序（R8）
- [ ] 新 UI 不使用 inline `style`／inline `<script>`，CSP 下沒有錯誤（R6、R8）
- [ ] 儲存 ollama 型別被擋下；舊 ollama provider 不會被每日測試與轉發實際呼叫，且畫面上看得到原因（R9）
- [ ] `async_test_keys.py`／`_worker.js`／`index.html`／`app.js`／`README.md` 都不再提到 ollama（R9）
- [ ] 現有的來源設定、測試結果、每日 GHA 測試行為全部與改版前一致（第 2 節）

## 11. 現況對照與驗證紀錄（2026-11-09）

計畫書寫的時候只有舊程式碼可看；現在對應的實作已經在 `public/_worker.js`、
`public/app.js`、`public/index.html`、`public/style.css`、`scripts/migrate-kv-to-d1.mjs`
與 `tests/` 裡。這一節記的是「文件寫的 ↔ 程式實際做的」對照，以及還沒對上的地方。

### 11.1 已實作且測試守住的部分（`npm test`，現時 34 個案例全過）

| 需求 | 實作證據 |
|---|---|
| R0 儲存層 | `storageBackendName()`／`storageConfigError()`／`d1Store()`（KV 形狀的 D1 轉接層）；預設 d1；未綁 DB 時 `/api/*` 回可讀 500、靜態頁照常載入；空 D1 免手動建表（`ensureSchema()`） |
| R0 搬移／備份 | `/api/storage/export|migrate|restore` ＋ `npm run migrate`；先備份→搬→驗証，分頁跑完、可重跑、置換前再備份；export 與 restore 共用 20000 筆上限 |
| R1 轉發 | `targetUrl()` = `api_base` ＋ 呼叫方路徑；串流以 `ReadableStream` 原樣回傳；上游 `Set-Cookie`／`cf-aig-*` 不回傳給呼叫方。另有一支**本機測試腳本**（`probe-headers.mjs`，非 AI Gateway 實測）證明：直連時呼叫方的 `cf-connecting-ip`／`cf-ray`／`cf-ipcountry`／`x-forwarded-for`／`x-real-ip` 原本會原樣送到上游（`cookie` 已丟掉），已加進 `DROP_UPSTREAM_HEADERS` |
| R1 認證 | `proxyCredential()` 接受三種標頭；`PROXY_PASSWORD` 未設或與 `ADMIN_PASSWORD` 相同 → 503 `PROXY_DISABLED` |
| R1 設定沿用 | `applyProviderAuth()`（含 anthropic 的 `x-api-key` ＋ `anthropic-version`）、`parseExtraBody()`、custom headers 後套用 |
| R2 輪用 | `pickKeyRow()` 單一原子語句＋`MAX(now, 同 fp 最大值 + 1)`；6 次請求 → 2/2/2 |
| R3 計數 | 任何非 2xx 都計數＋換鑰（`recordKeyFailure()`），`PROXY_FAIL_THRESHOLD` 達門檻禁用；每日測試的 `valid_keys` 透過 `recoverKeysFromResults()` 自動恢復；挑到不在「API Keys」名單裡的金鑰（幽靈列）會刪掉重挑 |
| R4 重試 | 最多 3 次換鑰、排除已試過的列、回最後一次上游回應、`AbortSignal.timeout` |
| R5 測試 | `POST /api/proxy/test`（只收 `{id, fp}`）＋`POST /api/proxy/test-model` 存測試模型；回應 `{ok,status,ms,model,error,fail_count,disabled}`；失敗計數、成功不寫帳本 |
| R6 頁面 | 上方工具列（`別名 - 格式` 的服務商下拉、右邊可點擊複製的轉發網址、左邊 16px 粗體的 `有效 X 无效 Y`、右邊靠右的測試模型選單與兩個批量按鈕；頁首 `重新读取` 右邊是紫色 `Gateway 记录 ↗`）＋下方每把金鑰一張卡；`/api/proxy/state` 只給遮罩後金鑰、`proxy_message` 顯示停用原因 |
| R7 紀錄 | `AI_GATEWAY_LOGS_URL` 模板（`{key}`／`{provider}`），未設時按鈕停用 |
| R8 增補 | `#ed-keys-search`／`#ed-sort-keys-btn`／`#ed-export-keys-btn`／`#editor-confirm` |

### 11.2 我另外補跑的探測（針對文件的疑問）

用同一份假 D1／假 KV／本機 mock 上游，直接驅動**現行**的 `_worker.js`：

| 編號 | 情境 | 結果 |
|---|---|---|
| E1 | 3 把金鑰、上游全部回 500 | 3 次請求後 3 把全禁用（**已定案：接受這個代價**，靠每日測試恢復） |
| E2 | 3 把金鑰、上游全部回 403（地區封鎖） | 同上 |
| E3 | 上游全部回 400 | 計數＋重試（Gemini 的死鑰就是 400）；3 次請求後全禁用 |
| E4 | 上游全部回 401（金鑰被撤銷） | 3 次請求後全部禁用（正確且預期） |
| E5 | 3 把金鑰、6 次成功請求 | 2/2/2（輪用正確） |
| E6 | 記事本已刪、但 `key_state` 還留著的金鑰 | **真的被送去上游**（`sk-gone` 出現在上游請求標頭裡） |
| E7 | `PROXY_PASSWORD` 設成 `ADMIN_PASSWORD` | 503 `PROXY_DISABLED`（正確） |
| E8 | 走 AI Gateway | 上游路徑 `/v1/{帳號}/{gateway}/custom-{slug}/chat/completions`（與第 4 節一致） |
| E9 | 一筆成功轉發的 D1 成本 | 3 個語句、回 2 列、寫 1 列 |
| E10 | 呼叫方多寫一次 `/v1` | 上游收到 `/v1/v1/chat/completions`（所以第 1 節的規則要寫清楚） |

E1／E2／E3 現在都是**已定案的行為**（單一規則：非 2xx 一律計）；剩下兩件事：

1. **E6：同步失敗留下的幽靈金鑰會被送去上游**（待決定）。建議在 `pickKeyRow()` 之後比對一次
   （不在目前金鑰清單就刪列再挑），或在 `POST /api/settings` 的同步失敗時回一個警告欄位。
2. **上游／環境相關的三項**（D1 並發、Gateway 深連結、真實 KV 分頁）見 11.5。

### 11.3 瀏覽器實測（正式 CSP）

- `.proxy-grid`：1262px 寬 → 3 張（各 340px）；390px 寬 → 1 張。
- 刪除確認區出現時，按鈕排高度 70px → 255px；清單只顯示遮罩後金鑰；取消後文字框回到原狀。
- 搜尋 `aaa` → 命中清單標出第 1、5 行。
- 排序按鈕連按：小到大 → 大到小 → 原序，回到原序與原本內容逐字相同。
- CSP 實測：`style="height:40px"` 被擋（實際 25.6px），`element.style.height` 才生效——新樣式只能寫進 `style.css`。

### 11.4 查證過的官方事實

| 說法 | 來源 |
|---|---|
| `cf-aig-metadata` 標註，日誌可搜尋／篩選，每請求上限 5 筆 | developers.cloudflare.com/ai-gateway/observability/custom-metadata/ |
| Custom Provider：上游 URL = `base_url` ＋ `custom-{slug}/` 之後的路徑 | .../ai-gateway/configuration/custom-providers/ |
| 重試與逾時可用逐筆標頭 `cf-aig-max-attempts`、`cf-aig-request-timeout` | .../ai-gateway/configuration/request-handling/ |
| 日誌額度：2026-09-24 後新帳號走 Workers Logs（20 萬/天、3 天）；舊帳號 Legacy Logs 免費 10 萬筆總量 | .../ai-gateway/reference/limits/、.../ai-gateway/reference/pricing/、.../workers/observability/logs/workers-logs/ |
| Workers 免費方案：10 萬請求/天、CPU 10ms、子請求 50、同時對外連線 6；靜態資源免費且不限量 | .../workers/platform/pricing/、.../workers/platform/limits/ |
| D1 免費方案：500 萬列讀/天、10 萬列寫/天，索引欄位寫入會多算一列 | .../d1/platform/pricing/ |

### 11.5 仍必須上線後才能確認的（不是程式問題，是環境問題）

1. **D1 的並發寫入序列化**：選鑰是單一 `UPDATE … RETURNING`，本機 SQLite 語意已驗；真實 D1 要用並發請求打同一把服務商才能確認不會撞號。
2. **AI Gateway 的實際行為**：custom provider 路徑拼接、`cf-aig-metadata` 出現在儀表板、依標註篩選，以及 `AI_GATEWAY_LOGS_URL` 的實際 URL 形式——文件只保證「可搜尋／可篩選」，URL 要在真實帳號抄。
3. **每日 GHA 測試**：本次只驗到「Pages API 與 KV/D1 介面不回歸」，沒有真的跑一輪 GitHub Actions。
4. **真實 KV 的 `list()`**：分頁邏輯已實作，測試用 pageSize 模擬；生產環境第一次搬移仍要看備份檔的人數與筆數是否合理。
5. **上游真實串流與長連線**：本機 mock 用固定間隔模擬，真實 provider 的首字延遲與 keep-alive 行為要另測。

## 12. 實作與計畫書的差異清單（2026-11-09）

把目前的 diff 逐項對回計畫書後，除了前面已經處理的幾處（失敗判定、恢復方式、ollama、`api_base` 措詞），
還有這些「計畫書沒寫、但實作做了」或「寫了但做得更細」的地方。列出來讓文件跟程式對得上。

### 12.1 實作有、計畫書沒寫（屬於加值，不是落差）

| 項目 | 實作內容 | 為什麼值得留下 |
|---|---|---|
| 搬移工具 | `/api/storage/export`／`migrate`／`restore` ＋ `npm run migrate`；**先備份→搬→驗證**、`--dry-run`、`--restore`、`--allow-empty`、`--yes`、備份檔 `0600`、exit code 0/1/2、migrate/restore 要 `confirm` 字串 | 計畫只說「一次性搬移指令」；搬移是破壞性操作，先備份是必要的安全帶 |
| 自動建表 | `ensureSchema()` 在第一次存取 D1 時建表，並以 binding 物件 memoize | Pages Functions 沒有啟動階段，空資料庫也要能第一筆就上手 |
| 上游逾時 | `PROXY_UPSTREAM_TIMEOUT_MS`（1 秒～10 分鐘，預設 120 秒）＋ `AbortSignal.timeout`；走 gateway 時同步送 `cf-aig-request-timeout` | 計畫把逾時交給 Gateway；直連時沒有它會一直等 |
| 兩個密碼不可相同 | `PROXY_PASSWORD === ADMIN_PASSWORD` → 503 `PROXY_DISABLED` | 「互相獨立」寫在計畫裡，但沒有機制強制；同值等於沒有隔離 |
| 標頭清洗 | 丟掉呼叫方 `Cookie`、hop-by-hop、上游回傳的 `Set-Cookie` 與所有 `cf-aig-*`（含上游回的） | 避免把上游 session 或 Cloudflare 控制標頭帶回給呼叫方 |
| 別名解碼 | `decodeURIComponent(alias)`，壞編碼回 400 | 別名是 URL 第一段，不處理會出現半匹配的 404 |
| 前端細節 | 批量測試進度（`x / n，可用 a，不可用 b`）、`via_gateway` 徽章（Gateway／直連）、測試模型顯示、未設別名提示、恢復前的 `confirm()` | 都是操作上必要的回饋 |
| 遮罩一致性 | `maskKey()` 在 `_worker.js` 與 `app.js` **逐字相同**；`metadataKeyTag()` 短金鑰降級 `a***z` | 少一個就會出現「卡片遮罩與日誌標註不一致」 |
| 開發／測試腳本 | `npm run dev` 強制 `STORAGE_BACKEND=kv`、新增 `dev:d1`（本機 D1）、`npm test`（假 D1／KV＋本機上游）、`npm run migrate` | 本機沒有 D1 時，預設 d1 會讓每個 API 都 500，所以 dev 明確選 kv |
| 其他檔案 | `tests/`（現 34 案）、`scripts/migrate-kv-to-d1.mjs`、`mock.json` 加 `alias`、`AGENTS.md` 補新 invariants、decision 文件改名為 `decision-1109.md` | 都是這次功能帶來的配套 |

### 12.2 計畫書「現有行為不改」的例外（要知情）

- `POST /api/settings` 現在會擋下兩種輸入並回 400：別名格式錯誤／重複（計畫有寫）、
  `provider_type` 不在白名單（R9 新增）。這是唯一會讓既有呼叫端收到 400 的變化。
- `npm run dev` 的參數多了 `--binding STORAGE_BACKEND=kv`；直接跑 `wrangler pages dev` 不帶它的話，
  預設 d1 而本機沒有 `DB`，每個 `/api/*` 都會回可讀的 500。
- `async_test_keys.py` 除了移除 ollama 分支之外沒有改動測試邏輯。

### 12.3 已定案並實作（不需再決策）

| 項目 | 決定 | 實作 |
|---|---|---|
| 幽靈金鑰（同步失敗後已刪的 key 被送出去） | **B′：選後驗證**（用 `provider.keys` 比對，不在名單就刪列重挑；整個 provider 缺列才自動補） | `handleProxy()`；測試 `a ghost key_state row is never forwarded and gets deleted` |
| `restore` 語義 | **精準回滾**（先 upsert、後刪除備份裡沒有的列） | `handleStorageRestore()`；測試 `restore writes a backup back including key_state` 加驗殘留列 |
| 轉發把 `cf-*`／`x-forwarded-for` 送給上游 | 加入 `DROP_UPSTREAM_HEADERS`（本機 mock 實測；**不代表 AI Gateway 行為**） | 測試 `extra body, custom headers, cookie and caller cf-aig-* handling` |
| `/api/proxy/state` 全表掃 | 先算指紋清單、`WHERE fp IN (…)` | `handleGetProxyState()` |
| `export`／`restore` 筆數不一致 | 兩端共用 `STORAGE_MAX_ENTRIES = 20000` | 測試 `export refuses more entries than restore can take` |

仍待真環境驗證：D1 並發寫入、AI Gateway 實際行為（深連結 URL、轉發標頭）、真實 KV 分頁、真實 provider 串流。

### 12.4 2026-11-09 追加的兩個行為變更

| 變更 | 內容 | 影響 |
|---|---|---|
| 手動測試會計數 | `/api/proxy/test` 失敗時呼叫 `recordKeyFailure()`，達門檻就禁用；成功不寫帳本（不歸零、不恢復） | 「金鑰變無效」只有兩條路：手動測試失敗、轉發失敗達門檻。每日測試只恢復、不加重 |
| 逾時只算到回應標頭 | 轉發改用 `AbortController`，收到上游標頭就 `clearTimeout` | 聊天串流可以流超過 `PROXY_UPSTREAM_TIMEOUT_MS`（原本 `AbortSignal.timeout` 會把長串流中途切斷） |

