# 決策說明（最後更新 2026-08-16）

**本文持續維護**，記錄「失效密鑰分頁 + 錯誤訊息改造 + 單一 Key 連跑兩輪 + API 認證」及其後續調整中，每個決策的**背景、選項、取捨理由與實測依據**。改動這幾塊行為時請一併更新本文，並把檔名的日期後綴改成當次更新的日期。

搭配 `docs/new_plan-0812.md`（功能規劃草案，細節已被本文取代）閱讀。

---

## 一、測試結果的錯誤訊息

### 1.1 用供應商原文取代人工歸類文字

| | |
|---|---|
| **問題** | 原本群組標題是人工歸類的說明，例如 `Key 专属硬伤 (Hard Failure - 401)`。402（餘額不足）沒有專屬分類，會落入 `Unknown Error`，使用者看不出真正死因。 |
| **決策** | `error_reason` 改成供應商回傳的真實訊息，由 `parse_error_body()` + `pick_error_message()` 取得。 |
| **Fallback** | 只有在連 body 都拿不到（純連線失敗、空 body）時，才退回原本的說明文字。行為與改造前一致，不會出現空白標題。 |
| **順帶移除** | per-model 的 `failed_models_details`；死因已由原文表達，逐模型清單只是雜訊。 |

**改造前後對照**

| Status | 改造前 | 改造後 |
|---|---|---|
| 401 | `Key 专属硬伤 (Hard Failure - 401)` | `401 · Incorrect API key provided: sk-xxxx...` |
| 402 | `Unknown Error` | `402 · 余额不足，请充值后重试` |
| 429 | `频控限流或响应超时 (429)` | `429 · Rate limit reached for requests` |

### 1.2 解析時機：**截斷之前**

- **踩到的坑**：原本先存 `error_body = err[:512]`，事後才解析。大於 512 字元的 JSON body 被切斷後就不再是合法 JSON，`json.loads` 失敗 → 退回 `{"raw": ...}` → 顯示半截 JSON 字串，正好毀掉這次改造的目的。OpenAI 的 401 body（含說明網址與 request id）長度已經逼近這個門檻。
- **決策**：在 record 產生當下、`err` 還完整時就解析，記錄改存結構化的 `error_detail`，不再存 `error_body`。
- **界線控制**：改在「每個欄位」上限 512 字元，而不是限制整個 body，避免 KV 無限膨脹。
- **向下相容**：舊 checkpoint 沒有 `error_detail`，讀取時退回解析 `error_body` / `error`。

### 1.3 分組與去重鍵：`error_code` + **正規化後的訊息**

**問題**：許多供應商把 Key 尾碼寫進訊息，例如 `Authentication Fails, Your api key: ****2fb7 is invalid`。逐字比對會讓每一支 Key 各自成組；只比 `error_code` 又會把同一個碼底下兩種真正不同的原因合併掉。

**實測**（66 支無效 Key，內含 4 種真正不同的原因）

| 策略 | 產生組數 | 被吃掉的原因數 |
|---|---|---|
| 逐字比對 | 64 | 0 |
| 只比 `error_code` | 2 | **2** |
| 取前 30 字元比對 | 11 | 0 |
| **正規化後比對（採用）** | **4** | **0** |

**決策**：`normalize_message()`（Python）／`normalizeMessage()`（JS）遮蔽會變動的片段後再比對：

| 遮蔽對象 | 樣式 | 取代為 |
|---|---|---|
| Key 本體 | `sk-xxxx`、`api_xxxx` | `<key>` |
| 遮罩尾碼 | `****2fb7` | `<key>` |
| hex id / uuid 片段 | 8 位以上十六進位 | `<id>` |
| 任何數字 | `1234` | `<n>` |

```
Authentication Fails, Your api key: ****2fb7 is invalid
Authentication Fails, Your api key: ****df45 is invalid
  → 同一組 "authentication fails, your api key: <key> is invalid"

Your account has been deactivated. Please contact support.
  → 維持獨立一組（同樣是 401，但確實是不同原因）
```

**為什麼不用「取前 X 字元」**：變動片段不在固定位置（A 供應商的 `sk-<tail>` 在第 28 字元，B 供應商的 `****<tail>` 在第 36 字元），實測裂成 11 組；而把 X 縮短到能合併它們，就會開始誤併 `Your account has been deactivated` 與 `Your account has been suspended for abuse` 這種共用開頭的不同原因。X 得逐家供應商調，兩個方向都脆弱。

**接受的副作用**：只差在數字的兩種原因會被併起來（例如 `quota 100/min` 與 `quota 1000/min`）——這本來就是同一種原因。

### 1.4 保留每支 Key 自己的訊息，只對 `error_detail` 去重

曾經一度把整組的 `error_reason` 覆寫成第一支 Key 的訊息，**這是錯的**：第二種原因會被永久抹除，連 modal 都救不回來。

**空間實測**（66 支 Key／單一供應商）

| 方案 | payload |
|---|---|
| 完全不去重 | 22,816 bytes |
| 覆寫 reason + 依 code 去重 | 11,981 bytes |
| **保留各自 reason + 正規化去重（採用）** | 13,717 bytes |

保留每支 Key 自己訊息的代價是 **1,736 bytes，佔 KV 單值上限 25 MB 的 0.0069%**。用這個代價換「不遺失任何一種死因」明顯划算。真正值得去重的是 `error_detail` 這個物件（單欄位上限 512 字元 × 多欄位），它讓 payload 從 22.8 KB 降到 13.7 KB。

**結論**：短字串（`error_reason`）保留，重物件（`error_detail`）每種原因只存一份。

### 1.5 正規化邏輯同時存在於 Python 與 JS

- **分工**：Python 端的正規化決定「哪一筆保留 `error_detail`」（儲存），JS 端的決定「畫面怎麼分組」（顯示）。
- **理由**：前端自己算，已經存在 KV 裡的舊結果不必重跑測試就能正確重新分組。
- **兩邊規則刻意寫成完全相同**，不是一邊寬一邊嚴。但「寫起來一樣」不等於「跑起來一樣」：

| 語法 | Python `re` | JavaScript RegExp | 實測差異 |
|---|---|---|---|
| `\d` | 認得全形數字 `１２３４` | 只認 ASCII `0-9` | `余额 １２３４ 元` → Python 遮成 `<n>`，JS 原樣保留 |
| `\b` | CJK 算 word 字元，`码abcdef12` 之間**沒有**邊界 | CJK 不算 word 字元，該處**有**邊界 | `错误代码abcdef12` → Python 只遮數字，JS 整段遮成 `<id>` |

  兩個差異方向相反（一個 Python 較寬、一個 JS 較寬），而且**只在非 ASCII 文字上出現**——正好就是這些供應商會回的中文訊息。
- **修正**：兩邊都不再用 `\b` 與 `\d`，改成明確字元類別 `[0-9０-９]`，邊界則用「捕獲前導字元」`(^|[^a-z0-9])` + lookahead `(?![a-z0-9])`。27 組對照案例（中文、全形數字、西里爾字母、emoji、空白摺疊、相鄰 token 共用邊界、字串頭尾 token）在兩個引擎下輸出完全一致。順帶讓全形數字也能正確遮蔽。
- **為什麼不用 lookbehind**：`(?<!...)` 在 Safari 16.4 以下是**解析期語法錯誤**，整個 `app.js` 會直接掛掉（不只是這個函式）。這個檔案其餘語法只需要 Safari 13.1（`?.`／`??`），沒必要為了可讀性把門檻拉高三年。
- **為什麼不共用同一份程式碼**：本專案刻意沒有 build step（Python 跑測試、JS 跑瀏覽器），無法共用實作。若日後想根絕，可由 Python 把正規化後的 key 一併寫進結果，前端優先採用該欄位、只有舊資料才自行計算。
- **兩邊判斷不一致時會怎樣**（僅在有人改了其中一邊、忘了改另一邊時發生）：

| 情況 | 後果 | 嚴重度 |
|---|---|---|
| Python 判「同一種」→ 只存一份 detail；JS 判「不同種」→ 拆成兩組 | 被拆出去的那組裡沒有任何一筆帶 detail | 該組原本會沒有 📋 按鈕 → **已加保護**：改成退回用該組訊息本身組出 `{message}`，只要標題被截斷就仍然給得出 📋，看得到完整原文，只是少了 `type`／`code` 這些結構化欄位 |
| Python 判「不同種」→ 存了兩份 detail；JS 判「同一種」→ 併成一組 | 多存一份 detail（約數百 bytes），畫面顯示第一筆 | 純浪費空間，無功能影響 |

- **與 fingerprint 的差別**：fingerprint 三處不同步會直接查不到測試結果（功能壞掉）；正規化不同步只影響分組粒度與結構化欄位的有無，且下次重跑測試就會自我修正。

### 1.6 顯示層截斷

- 群組標題 `{error_code} · {truncate(message, 120)}`，超長加 `...` 後綴。
- 完整原文放 `title` 屬性（hover 可見）與 📋 錯誤詳情 modal（不截斷）。
- Python 端另外把 `error_reason` 壓在 200 字元，並壓平換行避免標題破版。

### 1.7 `error_code` 要跟著實際採用的說明文字走

`error_code` 原本固定取「第一筆失敗記錄」的狀態碼，但 fallback 文字取的是「最後一次看到的 401/403」。併發下一支 Key 先 429 再 401，就會顯示 `429 · Key 专属硬伤 (Hard Failure - 401)`。**決策**：走 fallback 分支時，`error_code` 改用該 fallback 自己的狀態碼。

---

## 二、失效密鑰分頁

### 2.1 KV 結構：單一 `dead_keys` 陣列

- **決策**：整份記錄存成一個 KV key 的陣列，而非 `dead_key:{id}` 多筆。
- **理由**：列表頁一定要全撈；多筆 key 會需要 `list()` + N 次 `get`，讀取放大。單一陣列 1 次讀取解決。
- **代價**：每次新增／編輯／刪除都是 read-modify-write（1 get + 1 put）。實際量級（數百筆、每日一次自動對帳加上零星手動編輯）完全無壓力，但這代表**不具並發安全**——兩個人同時寫會覆蓋彼此，且同一個 key 有每秒 1 次寫入的限制。單一管理者情境下接受。

### 2.2 雙重去重

| 對象 | 規則 | 理由 |
|---|---|---|
| `api_key` | 全域比對，重複則 409，保留最早那筆 | 同一支 Key 不該有兩筆失效紀錄 |
| `error_detail` | 同 `provider_host` + 同 `error_code` 只留第一份 | 同一家、同一個碼＝同一段訊息 |

### 2.3 去重後的「再平衡」

只做去重不做再平衡會出事：

- **DELETE**：刪掉持有 detail 的那筆，同組其他筆的 detail 都是 `null`，整組訊息就消失了 → 刪除時把 detail 交棒給同組的下一筆。
- **PUT**：編輯 host 或 code 等於把記錄移出原組，原組會被孤兒化；移入的新組又可能變成兩份 detail → 兩個方向都要處理。
- 三個 handler 共用 `sameDedupGroup()`，避免邏輯各自漂移。

### 2.4 前端顯示

- 被去重掉（`error_detail: null`）的列，📋 會自動借用同組第一筆的內容，使用者不需要自己去找第一筆在哪。
- 表格欄位在 `<td>` 上設 `max-width` **無效**（auto table layout 會忽略），必須改設在內層元素上，才做得出單行 + `...` 省略。

### 2.5 自動對帳：清單語意是「當前正在失敗」，不是永久帳本

（2026-08-13 追加，commit `3dcc7d4`／`1bc79f5`。初版只有手動 CRUD，維護成本落在使用者身上。）

**決策**：每次 `POST /api/results` 都拿該次結果對帳一遍（`syncDeadKeysFromResults`）——`invalid_records` 裡的 Key 自動記入，`valid_keys` 裡的 Key 自動從該 `provider_host` 移除。

**關鍵在於這兩件事必須成對做**。只做「自動記入」的話，記錄什麼樣的失敗碼就變成一個危險的判斷：429 或 500 這種暫時性失敗會把一支好 Key 永久釘在清單上，於是只敢記 401/403。加上「自動移除」之後，任何失敗碼都可以記——判斷錯了，下一次跑成功就自我修正。清單因此不是歷史帳本，而是「上一次跑完之後，現在還在失敗的 Key」。

| 決策點 | 選擇 | 理由 |
|---|---|---|
| 移除範圍 | 連手動新增的記錄一起移除 | 該記錄現在斷言了一件不成立的事（這支 Key 是死的），來源是人或機器不影響它已經錯了 |
| 是否連帶改 `来源设定` | 否，維持手動 | 從測試清單裡拿掉一支 Key 是使用者的決定，不該由一次測試結果代勞 |
| 失敗時的處理 | `try/catch` 包住，只 `console.error` | 結果已經寫進 KV 了；對帳失敗若讓整個 `POST /api/results` 回錯，上傳端會以為整批結果掉了而重跑 |
| 寫入時機 | 只在 `added \|\| removed` 時 `put`（`_worker.js:459`） | 穩定狀態下每日排程不會產生任何 dead-keys 寫入 |
| `expired_at` 格式 | 當日 UTC 午夜（`toIsoDay` 的形狀） | UI 當日期讀；精確時刻另存在 `created_at` |

**沿用既有規則**：`api_key` 全域去重（已在清單裡就跳過）、`error_detail` 依 `sameDedupGroup()` 只留一份、移除記錄時把 detail 交棒給同組下一筆——與 §2.2／§2.3 完全同一套邏輯，沒有第二份實作。取不到 `error_detail` 時退回 `{message: error_reason}`，確保 📋 至少有東西可看。

**可觀測性**：handler 回傳 `dead_keys_added` / `dead_keys_removed`，Python 端印出來（`async_test_keys.py:988`）。舊版 worker 沒有這兩個欄位，取不到就只印上傳成功，不會炸。

### 2.6 批量刪除與單次 KV 寫入

（2026-08-16 追加）

| 決策點 | 選擇 | 理由 |
|---|---|---|
| 移除單行刪除鈕 | 表格內操作欄位只留「編輯 ✏️」，移除「刪除 🗑️」 | 避免誤觸單筆刪除，統一透過批量選取與二次確認操作 |
| 批量刪除按鈕 | 位於「篩選」右側，紅底白字，未勾選時為「批量刪除」，勾選 ≥1 筆時切換為「確認刪除」 | 流程直觀，動態引導使用者完成刪除 |
| 勾選框欄位 | 點擊「批量刪除」後在操作欄右側動態展開紅色半透明框勾選列 | 預設不佔據表格寬度，批量模式下可逐筆或表頭全選 |
| 二次確認彈窗 | 點擊「確認刪除」時彈出視窗，顯示選中數量與 Key 預覽 | 遵循既有 modal 樣式，防止使用者誤刪 |
| 後端批次刪除 | `DELETE /api/dead-keys` 支援一次傳入 `{ ids: [...] }` | 一次性過濾與完成 `error_detail` 交棒再平衡，**將 KV 操作從 N 次讀寫縮減為單次 1 get + 1 put**，消除並發競爭與 quota 浪費 |

---

## 三、單一 Key 連跑兩輪

| | |
|---|---|
| **問題** | 只有一支 Key 時沒有交叉驗證的餘地——沒有別的 Key 能證明模型是健康的，單次抖動就會讓模型被判死。 |
| **決策** | `len(keys) == 1` 時 `runs_per_pair = 2`，同一個 `(Key, Model)` 連跑兩輪，中間間隔 `SINGLE_KEY_RERUN_DELAY = 2.0` 秒。 |
| **為什麼不用「把 pair 塞進佇列兩次」** | 併發度 ≥ 2 時兩輪會同時發出，間隔形同虛設。改成在 worker 內依序執行，才能保證順序與暫停。 |
| **判死就不跑第二輪** | 第一輪觸發熔斷（401/403、balance/quota）後再打一次只是浪費額度，也符合既有「死 Key 跳過所有剩餘模型」的邏輯。實測：死 Key 只發 1 次請求、不浪費 2 秒等待。 |
| **兩輪都記錄** | 模型要兩輪都失敗才算失敗；Key 只要有一輪成功就算有效；效能統計也多一個樣本。 |

**斷點續跑連帶調整**：原本「有一筆成功就跳過該 pair」會讓中斷後的續跑悄悄退化成只跑一輪。改成要累積到 `runs_per_pair` 筆成功才算完成；未滿額的 pair 連同舊紀錄一起丟棄重跑，避免舊樣本與新兩輪疊成 3 筆。

---

## 四、樣本長度上限

（2026-08-13 追加，commit `5a5cc2d`。）

**問題**：`MAX_OUTPUT_TOKENS = 512` 攔不住所有供應商——有的直接無視，有的把推理 token 排除在上限之外。樣本原樣進 KV，單一模型的 sample 就可能膨脹到數十 KB。

| 決策點 | 選擇 | 理由 |
|---|---|---|
| 上限值 | `SAMPLE_MAX_LEN = 2048`（content 與 thinking 各一份） | 這是安全網，不是常態裁切線。守規矩的供應商在 512 token 內根本碰不到 2048 字元，只有失控的才會被切 |
| 切法 | 掐頭留尾，各 1024 | 推理模型想很久、結論落在最後一句。只取前段會把「= 323」切掉，看起來像沒答完 |
| 不改 `MAX_OUTPUT_TOKENS` | 維持 512 | 放寬只是讓話多的模型改成撞 `TOTAL_TIMEOUT = 20s`，從「被切短」變成「整筆失敗」，更糟 |
| `answer_verified` 的時機 | **截斷之前**用完整文字判定 | 順序反過來，落在被省略中段的 `323` 會讀成答錯（`async_test_keys.py:754`） |
| 可重複套用 | 帶 `CLIP_MARK` 的字串原樣返回 | 從舊 checkpoint 恢復的紀錄是加上限之前寫的，進 KV 前會再過一次；沒有這個保護會疊上第二層省略 |

---

## 五、KV 操作稽核

**寫入（免費額度 1,000/日）**

| 觸發 | 次數 |
|---|---|
| `POST /api/checkpoint` | 每 200 個任務 1 次 + 每個供應商結束 1 次 |
| `POST /api/results` | 每個供應商 1 put + 1 delete，外加對帳的 1 get；清單有變動時再 1 put |
| `POST /api/settings` | 使用者儲存時 1 put + N delete（僅清理已移除的供應商 checkpoint） |
| dead-keys 增／改／批次刪 | 各 1 get + 1 put |

單一供應商 600 個任務 ≈ 5–6 次寫入；10 個供應商的每日排程約 60 次，遠低於額度。穩定狀態下（沒有 Key 狀態變化）對帳不寫入，回到約 50 次。

**讀取（免費額度 100,000/日）**

- 測試結果頁：每個供應商 2 次讀取（results + checkpoint），每次切換分頁或按「重新讀取」都會重跑。10 個供應商 = 每次瀏覽 20 次讀取。
- 來源設定頁：每次切換 1 次讀取。
- 失效密鑰頁：首次載入 1 次，之後快取，只有「重新讀取」或整頁重載才會再讀。
- **無任何輪詢**：全專案沒有 `setInterval`／visibilitychange 自動刷新，所有讀取都由使用者動作觸發。
- **認證不佔用量**：session 驗證是純運算（HMAC），不讀 KV；`GET /api/results` 改為需認證後，讀取次數也沒有變化。

**一個已知但不處理的點**

1. `dead_keys` 是單一 key 的 read-modify-write，撞得到「同一 key 每秒 1 次寫入」限制。目前唯一的程式寫入是每個供應商上傳結果時對帳一次，而供應商是串行處理、每個都要跑幾分鐘，不會連續寫。若日後改成並行跑供應商，這裡要重新評估。

---

## 六、API 認證

### 6.1 `GET /api/results` 從公開改為需認證

| | |
|---|---|
| **問題** | 該端點回傳的是明文 Key —— `valid_keys` 全清單，加上 `invalid_records[].api_key`。唯一的門檻是 `fp`，而 fingerprint = `SHA-256(api_base + provider_type)`，兩個輸入都是公開資訊，任何人離線就能算出來窮舉。 |
| **關鍵事實** | 這個公開性沒有換到任何功能：結果頁本來就要登入才渲染得出來（`loadResults()` 第一件事就是帶憑證打 `/api/settings`）。 |
| **決策** | 加上 `requireAuth`，前端該筆呼叫補上 `auth: true`。功能零損失。 |

### 6.2 瀏覽器憑證：session cookie，而不是 Bearer

**問題**：全部端點都要認證之後，手動檢查任何 API 都得靠會改 header 的工具（Postman、擴充套件）。網址列送不出 `Authorization`。

| 選項 | 優點 | 為何不選 |
|---|---|---|
| 維持 localStorage + Bearer | CSRF 免疫（跨站無法附加自訂 header） | 存的就是 `ADMIN_PASSWORD` 本人，JS 可讀，一次 XSS 即永久外洩且無法撤銷；網址列仍然不能用 |
| HTTP Basic | 程式碼最少，瀏覽器自動帶 | HTTP 沒有登出語意，憑證由瀏覽器快取到整個關閉為止，做不出可用的登出按鈕；登入 UI 變成原生彈窗，現有 `authOverlay` 與 `?mock` 流程都要重排；沒有 `SameSite` 可用 |
| 簽章 query token（`?t=...`） | 可分享 | 會進瀏覽器歷史、Referer 與 CF 日誌，等於把憑證灑出去 |
| Cloudflare Access | 零程式碼，順帶擋掉暴力破解 | 綁定 dashboard 設定，GHA 要改用 Service Token |
| **cookie session（採用）** | HttpOnly 讓 XSS 偷不走可離線重用的憑證；有到期；登出由伺服器清除，即時可靠；網址列直接開 `/api/...` 就看得到 JSON | 需自行處理 CSRF（見 6.4） |

Bearer 路徑原樣保留給 `async_test_keys.py` 與 GHA，兩者不受影響。

### 6.3 session 為何是無狀態的

cookie 值為 `<到期毫秒>.<HMAC(ADMIN_PASSWORD, 版本.到期)>`。

| | |
|---|---|
| **替代方案** | KV 存 `session:{id}`，可個別撤銷 |
| **不選的理由** | 每個認證請求多一次 KV 讀取，等於把第五節記的用量直接翻倍（結果頁每次瀏覽 20 → 40 次）；另外新寫入的 session 受 KV 最終一致性影響，登入偶發失敗 |
| **代價** | 單一 cookie 無法個別撤銷，登出只是叫瀏覽器丟掉它；若 cookie 值事先被複製，它在到期前仍然有效 |
| **全域撤銷手段** | 換 `ADMIN_PASSWORD`，或把 `_worker.js` 的 `SESSION_VERSION` 加一（不必動密碼） |

簽章密鑰直接用 `ADMIN_PASSWORD`，不另外開一個 secret：多一個 secret 就多一處要在 dashboard 與 GHA 同步，而它的外洩後果與密碼本身相同，分開存放並沒有換到隔離性。

### 6.4 CSRF：靠 `SameSite=Strict`，不做 token

寫入端點都用 `request.json()` 解析，而它**不檢查 `Content-Type`**——跨站的 `<form enctype="text/plain">` 送出的 body 一樣會被當成 JSON 吃下去，且瀏覽器會自動附上 cookie。`SameSite=Strict` 是這裡唯一的防線：任何跨站發起的請求都不帶 cookie，而在網址列輸入或按書籤屬於同站導航，照常帶上。代價是從外部網站點連結進 `/api/...` 會看到 401，重新整理即可。

`Path=/api` 讓 cookie 不會跟著每個靜態資源送出去。

### 6.5 前端不再持有任何憑證

localStorage 只剩 `atk_signed_in` 旗標，它不是憑證，唯一用途是讓 `index.html` 在首次繪製前決定要不要藏登入卡片，否則已登入者每次重整都會閃一下登入畫面。真正的驗證由 `bootstrap()` 打一次 `/api/settings` 完成。`api()` 的 `auth: true` 參數改變語意：不再是「加 header」，而是「這支呼叫需要 session，收到 401 就把登入遮罩叫回來」，順帶把 session 過期處理掉。

### 6.6 實測

本機 `wrangler pages dev`，七項全過：無認證讀 `/api/results` → 401；錯誤密碼 → 401；正確密碼 → 200 且 `Set-Cookie` 屬性完整；帶 cookie 讀 results／settings → 200；Bearer 讀 settings → 200；錯誤 Bearer → 401。

> 過程中發現：在 repo 根目錄跑 `npm run dev`，`/api/*` 會全部落到靜態資源 404（body 是 `404 Not Found` 加 `Vary: Origin`），worker 根本沒被呼叫；同一份檔案複製到乾淨目錄跑就正常，改動前的版本也一樣。疑似 `.wrangler/` 殘留狀態，**未驗證**。

---

## 七、瀏覽器端防護與設定寫入

### 7.1 安全標頭放在 worker，不用 `_headers`

Cloudflare 文件明確指出，`_headers` 定義的標頭**不會**套用到 Pages Functions 產生的回應，並點名 advanced mode 的 `_worker.js`；`env.ASSETS.fetch()` 轉手回來的靜態資源算不算例外，文件兩處敘述互相矛盾，**無法從文件確認**。因此不放 `_headers`，改在 worker 出口統一 `withSecurityHeaders()`，靜態資源、API 回應、404 與 500 全部涵蓋。

實測三條路徑（`/`、`/boot.js`、`/api/settings`）都帶到 CSP、`nosniff`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`。

### 7.2 上 CSP 前必須先做的三件事

`script-src 'self'` 與 `style-src 'self'` 不能直接開，會靜默壞掉。

| 障礙 | 處理 | 為何這樣選 |
|---|---|---|
| `index.html` 有一段避免主題閃爍的 inline script | 搬到 `public/boot.js`，仍是 head 內的阻塞式載入，一樣在首次繪製前執行 | 另一條路是算 hash，但那份 hash 在腳本被編輯的當下就失效，而且是靜默失效 |
| 9 處 inline `style=`（`index.html` 6、`app.js` 模板 3） | 全改成 class，新增 `.provider-card-badges`、`.badge-spaced`、`.empty-note`、`.field-row`、`.no-shrink`、`.input-concurrency`、`.input-errcode`、`.topbar-menu-title`、`.topbar-menu-close` | 保留 `'unsafe-inline'` 的話 `style-src` 等於沒設。**注意**：`app.js` 量測用的 `_mirror.style.cssText` 不必改，CSP 不管 CSSOM 寫入，只管標記裡的 style 屬性 |

**這個轉換有一個會靜默壞掉的坑**：inline style 原本永遠贏，換成 class 之後要跟既有規則比特異性與順序。`.topbar-menu-close`（宣告在 Topbar 段）就輸給了後面 Buttons 段的 `.btn-ghost`／`.btn-sm`，關閉鈕從純文字變回有框按鈕——實機量到 `border 1px / padding 6.75px`，而不是預期的 `0 / 3.2px`。改成兩個 class 的選擇器（`.btn-ghost.topbar-menu-close`）後，即使把規則塞到樣式表第 0 條（順序最不利）仍然勝出。其餘 8 處實測都正確。
| Discord 測試按鈕是從瀏覽器直接 POST 到使用者填的網址 | `connect-src` 放行 `discord.com` 與 `discordapp.com` | 代價是走中繼／代理網域的 webhook 會被擋，需要時在此加白名單 |

`img-src` 必須留 `data:`：favicon 是 inline SVG data URI，`style.css` 的下拉箭頭也是 data URI 背景圖。

### 7.3 `app_settings`：版本號，不是分拆儲存

**問題**：整包 full-replace 寫入。兩個分頁從同一份快照存檔，後存的會**靜默**蓋掉先存的，連 provider 與 Key 一起。

| 選項 | 為何不選 |
|---|---|
| KV 條件寫入 / CAS | KV 沒有這個能力，直接排除 |
| 每個 provider 一把 KV key | 消除陣列層級碰撞，但 Python 腳本讀的是單一 blob，屬中型重構 |
| **版本號（採用）** | 約十行。value 帶 `version`，寫入時比對，不一致回 409 |

競爭窗口沒有消失，只是從「分鐘級」縮到「毫秒級」；真正的收穫是**把靜默資料遺失換成看得見的錯誤**。前端收到 409 會先把伺服器上的版本拉回來重繪，再要求使用者重做，避免他對著一份已不存在的快照重存。

**不帶 `version` 的請求放行**是刻意的：唯一的並發寫入者是前端，而它一定會帶；curl 手動修復則不該被版本擋住。

設定 Modal 同時改成只送它自己的兩個欄位，不再回送整包——它手上的 provider 清單可能是舊的。

實測：`v0` → 200（新版本 1）；重送 `v0` → 409；`v1` → 200（2）；不帶 version → 200（3）。

### 7.4 `dead_keys` 全量改寫：查證後維持現狀

先前把它描述成「只增不縮、長期逼近 KV 單值上限」，**查證後這個說法不成立**。`syncDeadKeysFromResults` 用 `known` 集合跳過已存在的 `api_key`（`_worker.js:566`），既有記錄整筆略過，所以：

- 同一支 Key 每天重跑**不會**新增第二筆，`expired_at` 與 `created_at` 維持第一次失敗那天。
- 清單規模的上限是「設定裡不重複的 Key 總數」，與天數無關。

因此不採用筆數／天數上限——那會犧牲記錄完整性，去換一個不存在的成長問題；也不做 host 分片或搬 D1。**仍然存在的**是丟失更新：使用者在 UI 上編輯記錄的同時，上傳結果觸發對帳，窗口幾秒，代價是一次手動編輯被蓋掉。KV 沒有條件寫入，單值方案在 KV 內無解，接受。

### 7.5 未處理：登入嘗試次數

| 方案 | 為何不做 |
|---|---|
| WAF 速率限制規則 | 免費方案上限是 1 條規則、運算式只有 Path 與 Verified Bot、IP 計數、計數窗與封鎖時長都固定 10 秒。5 次/10 秒的設定下，單一 IP 每天仍可嘗試約四萬次 |
| Worker 內用 KV 計數 | 免費寫入額度 1,000/日，而整個每日排程才用約 50 次。每次失敗登入寫一次計數器，等於讓攻擊者用幾百個請求耗盡當日寫入額度，結果上傳跟著失敗——把認證問題換成可用性問題 |
| Turnstile | 唯一能真正擋自動化猜測的低成本手段，但要多一個第三方腳本與 secret，並牽動 CSP |

**決策**：依賴密碼熵。線上猜測的速率與離線字典攻擊差好幾個數量級，而實務上密碼失守多半是外洩而非被猜中，節流對外洩沒有任何幫助。

---

## 八、依賴更新

| 項目 | 版本 | 說明 |
|---|---|---|
| wrangler | 4.95 → 4.121 | 清掉 npm audit 回報的 6 個弱點（2 high / 4 moderate） |
| actions/checkout | v4 → v7 | v5 起改用 node24；v7 擋掉 fork PR checkout，本工作流是 schedule + workflow_dispatch，不受影響 |
| actions/setup-python | v5 → v7 | v6 起改用 node24；v7 移除 `pip-install` input，本專案未使用 |

**推送時遇到的衝突**：遠端已合併 Dependabot 的 wrangler `^4.103.0`。採 rebase，`package.json` 保留較新的 `^4.121.0`，`package-lock.json` 直接以解好的 `package.json` 重新產生，而不是手動合併 380 行 lockfile。

**未處理**：`npm run dev` 仍需手動加 `--compatibility-date`。wrangler 預設帶入「今天」，但內建的 workerd 只支援到前一天，永遠差一天。由於「不放 `wrangler.toml`、Cloudflare 設定一律走 dashboard」是既定約束（見 `AGENTS.md`，出處為 `docs/SPEC-0813.md` §13），此處未自作主張修改。

---

## 九、驗證方式

| 範圍 | 方式 |
|---|---|
| 錯誤解析／去重／單一 Key 兩輪 | Python 腳本對 mock 供應商（本機 aiohttp server）實跑，涵蓋 401 熔斷、flaky 模型第二輪救回、中斷續跑 |
| dead-keys API | Node 腳本打本機 wrangler，涵蓋 409 重複、PUT／DELETE 再平衡四種情境、404／400 邊界 |
| 前端 | jsdom 驅動真實 `index.html` + `app.js`（mock 模式與登入模式），以及 agent-browser 實機 Chrome 檢查版面、RWD、無障礙名稱 |
| API 認證 | curl 打本機 wrangler，涵蓋無憑證／錯誤密碼／登入發 cookie／cookie 讀取／Bearer 讀取／錯誤 Bearer（見 §6.6） |
| 設定版本號 | curl 打本機 wrangler，涵蓋首次寫入、重送舊版本得 409、跟上新版本、不帶版本放行（見 §7.3） |
| 安全標頭 | curl 檢查靜態頁、`/boot.js`、`/api/*` 三條路徑的回應標頭（見 §7.1） |
| CSP 實機 | agent-browser 開已部署站台的 `?mock`，走過三個分頁：console 與 page errors 全空，`script:not([src])` 為 0，唯一殘留的 style 屬性是 `_mirror`（CSSOM 產生，CSP 不管）。逐一比對 9 個改成 class 的元素的 computed style，抓到 `.topbar-menu-close` 的特異性回歸（見 §7.2）。附帶驗證了 CSP 確實在執行：注入 `<style>` 被擋，改用 `insertRule` 才生效 |

實跑時一律指向本機 mock 供應商或 `?mock`，不使用任何真實 Key，測試產物寫在暫存目錄，不污染 repo。

---

## 十、已知取捨總表

| 取捨 | 選擇 | 代價 |
|---|---|---|
| 瀏覽器認證方式 | HttpOnly session cookie | 需靠 `SameSite=Strict` 擋 CSRF，沒有 token 兜底 |
| session 儲存 | 無狀態 HMAC，不進 KV | 無法撤銷單一 cookie；被複製的 cookie 到期前仍有效 |
| session 簽章密鑰 | 沿用 `ADMIN_PASSWORD` | 換密碼會一併踢掉所有已登入的瀏覽器 |
| 登入嘗試次數 | 未設限，依賴密碼熵 | 沒有任何告警，被嘗試也不會知道 |
| 安全標頭位置 | worker 出口統一補，不用 `_headers` | 多一層包裝；`_headers` 對 advanced mode 無效 |
| `connect-src` | 只放行 Discord 兩個網域 | 走中繼網域的 webhook 測試會被 CSP 擋 |
| 設定並發 | 版本號 + 409 | 競爭窗口仍在（毫秒級），只是不再靜默 |
| `dead_keys` 並發 | 接受 | 手動編輯與對帳同時發生會丟一次編輯；KV 無條件寫入，單值方案無解 |
| 訊息去重粒度 | 正規化後比對 | 只差數字的兩種原因會合併 |
| 每支 Key 的訊息 | 保留 | +1.7 KB／66 支 Key |
| 正規化邏輯 | Python 與 JS 各一份 | 需手動同步，但漂移只影響外觀 |
| dead_keys 儲存 | 單一 KV 陣列 | 無並發安全、每次全量改寫 |
| dead_keys 語意 | 當前失敗清單，每次跑完對帳 | 一支 Key 可能今天進、明天出，不留失效歷史 |
| 對帳失敗 | 吞掉錯誤只記 log | 靜默失敗，要靠 `dead_keys_added/removed` 的輸出才看得出來 |
| 樣本長度 | 各 2048 字元掐頭留尾 | 失控的長回應看不到中段 |
| 單一 Key 測試 | 連跑兩輪 | 測試時間與請求數加倍 |
| 續跑判定 | 要求滿額成功 | 中斷後可能重跑已成功的一輪 |
