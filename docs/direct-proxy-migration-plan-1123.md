# Pages 直連轉發 + isolate 內選鑰 + D1 事後寫入：設計與實測依據（2026-11-23）

> 狀態：尚未實作。本文件說明目標架構、記憶體快照與事後寫入在並發下為何安全、與現有設計的差異、請求紀錄與批量測試設計、寫入成本估算，以及支持設計的實測數據。

---

## 一、目標與核心概念

### 1.1 改什麼

外部轉發 `/proxy/:alias/*` 與面板手動探測 `/api/proxy/test` 改為：

1. **Worker 直連上游 `provider.api_base`，完全移除 Cloudflare AI Gateway（AIG）**。原本 AIG 承擔的四件事改由 Pages Worker 自己做：
   - **轉發**：直接請求 `api_base + 路徑 + query`。
   - **重試**：沿用現有「非 2xx 換下一把 Key」迴圈（原本就已關閉 AIG 重試，由 Worker 控制）。
   - **逾時**：沿用現有 `AbortController` 計首字時間（TTFB），收到回應標頭即清除計時器，不切斷串流。
   - **請求紀錄**：固定全量寫入 D1 `proxy_logs`（含請求／回應 Payload 與實際使用的 Key，保留最新 `1980` 筆），並在頂部導航列新增第 5 個分頁「**請求紀錄**」直接檢視。
2. **回應前 0 次同步 D1 讀寫**：把設定與 `key_state` 快取在 Worker isolate 記憶體中，選鑰與失敗計數直接在記憶體完成，所有 D1 寫入（失敗計數、歸零、`last_used_at`、請求紀錄）一律放到回應送出後的 `ctx.waitUntil()` 背景單次 `db.batch()` 執行。
3. **面板測試模型並行寫入 ＋ 批量測試立即全併發、完成後寫一次 D1**：將測試模型獨立存成 `store` 的 `proxy_test_models`（不再改寫 `app_settings` 與遞增 `version`）。單把或批量測試時，若測試模型有變動，保存模型與發起探測**同時並行**互不等待；批量測試期間零 D1 讀寫，整批完畢後一次 `db.batch()` 寫回 `key_state`，且測試不影響「最近使用」時間、不進 `proxy_logs`。
4. **「最近使用」每秒即時顯示（0 次額外 D1）＋ 順手清掉專案舊殘留**：前端改為每秒本地自算跳字（`1 秒前`～`59 秒前`），並在停留在「輪詢轉發」分頁時透過記憶體序號 `stateSeq` 輕量感知外部新呼叫即時刷新；同時一併修復現有代碼、測試與文檔中的 6 組矛盾與殘留 Bug（見第九節 9.2）。

### 1.2 為什麼這樣改（實測數據見第六節）

- **省掉 AIG 延遲**：AIG 閒置後冷啟動第一發比熱態多約 `1000ms`；熱態每次也多約 `25 ~ 75ms`。
- **省掉同步 D1 往返**：現行熱路徑每個請求串行 3 次同步 D1 往返（讀設定、選鑰寫入、成功歸零），跨海（台灣 `TPE` ↔ 東京 `NRT`）共耗掉約 `200ms`。
- **省掉雙邊後台維護**：不再需要每新增一家服務商就去 Cloudflare Dashboard 建 AIG Custom Provider，也不必在網頁維護 `AI Gateway Logs URL` 與 `AI Gateway Token`。

### 1.3 快照機制三句話總覽（先看懂這段，第二節就很好懂）

- Worker isolate 用一個全域變數保存 `snapshot`（含解析後的 `app_settings` 與各服務商的 `key_state` 清單 + 輪詢游標 `cursor`）。
- **軟過期 `10s`、硬上限 `60s`**：快照建立未滿 10 秒直接用；介於 10～60 秒之間**先用舊快照立即回應**，同時在背景更新快照；超過 60 秒無流量才在請求前同步重載一次。
- 在同一台 isolate 上儲存設定、手動禁用／恢復、測試或上傳每日結果時，會立即更新或清除本機快照，不會等 10 秒。

---

## 二、並發輪詢下：哪些要先查 D1，哪些可以事後寫

核心問題：多個請求同時進來時，回應前真正需要知道的只有「目前有哪些設定與哪些 Key 可用」，這件事靠記憶體快照就能回答；其餘所有寫入都可以在回應後再落庫。

| 狀態／動作 | 回應前要先查 D1？ | 並發下為什麼正確 | 何時寫入 D1 |
| :-- | :-- | :-- | :-- |
| 讀取設定（`api_base`、alias、Key 清單、代理密碼） | 否，讀記憶體快照（僅冷啟動或超過 60 秒才同步讀 D1） | 快照內容就是 D1 內容，差別只在讀取時間點 | 使用者儲存設定時（維持現有同步寫入） |
| 決定本次用哪一把 Key | 否 | 單一 isolate 內是單執行緒，「取游標 `cursor` → `+1`」之間沒有 `await`，同時進來的多個請求必然拿到不同的下一把 Key | 不寫（選鑰不再依賴 `last_used_at` 排序） |
| 避開已禁用／本次已試過的 Key | 否 | 禁用狀態讀快照；本次請求試過的記在該請求自己的 `Set` | — |
| 失敗計數 `fail_count + 1` 與達門檻禁用 | 否 | 本 isolate 記憶體當場 `+1` 並標記 `disabled`，下一毫秒進來的請求立即避開；D1 背景執行原子 `fail_count + 1`（帶 `< threshold` 上限保護） | 事後（`waitUntil` 背景批次） |
| 成功後將 `fail_count` 歸零 | 否 | 只有原本 `fail_count > 0` 的髒 Key 才需要歸零 | 事後（同一個背景批次） |
| 更新「最近使用」`last_used_at` | 否 | 僅外部轉發會更新（手動／批量測試不碰），僅供顯示；面板直接讀本機記憶體即時時間戳＋記憶體序號同步 | 事後，同一把 Key 至多每 `60s` 節流寫 D1 一次 |
| 寫入請求紀錄 `proxy_logs` | 否 | 只寫不讀（串流回應等串流結束收齊內容後寫入） | 事後（同一個背景批次） |

並發邊界說明：

- 同一把壞 Key 在第 1 個請求尚未收到失敗回應前，已經同時發出去的其他並發請求會各自失敗並各自換下一把 Key（現行設計也一樣）；背景寫入 D1 時靠 `WHERE disabled = 0 AND fail_count < ?` 確保不會超額累加。
- 若全球多個地區有多個 isolate 同時服務，各自持有獨立游標與快照，禁用狀態在下次快照重載後同步；單一地區單一使用者實測高並發下只會用到 1 個 isolate（見 6.5）。

---

## 三、與現有設計的差異與取捨

| 面向 | 現有設計（經 AIG） | 新設計（Pages 直連） | 影響與取捨 |
| :-- | :-- | :-- | :-- |
| 上游通道 | 強制經 Cloudflare AI Gateway（`custom-{alias}`） | Worker 直接請求 `provider.api_base` | 免配 AIG 後台、省冷熱延遲；失去 AIG 自動計算的費用估算；`api_base` 必須可直接連通 |
| 設定讀取時機 | 每個請求同步讀 D1（約 `62 ~ 84ms`） | 讀記憶體快照（軟過期 `10s` 背景更新、硬上限 `60s` 同步更新） | 同一 isolate 改設定立即生效；若有跨區其他 isolate，最多延遲 10～60 秒同步 |
| 選鑰順序 | D1 `UPDATE … RETURNING` 取 `last_used_at` 最久未用 | isolate 記憶體內每個服務商一個隨機起點游標輪詢 | 不跨 isolate 對齊嚴格順序；isolate 重建後從新隨機起點輪流，長期依然均勻 |
| 失敗計數與禁用 | 每次失敗同步 `UPDATE` D1 後才換下一把 | 記憶體立即生效並換鑰，D1 事後背景寫入 | 重試迴圈零 D1 等待 |
| 事後寫入可靠性 | 同步寫完 D1 才回傳回應 | `ctx.waitUntil` 背景寫入（回應後約 30 秒內） | 極少數 isolate 異常崩潰時可能少記一次失敗或少一筆日誌，不影響呼叫端收到的回應 |
| 冷啟動 D1 次數 | 3 條逐一 DDL + 讀設定 + 選鑰 + 歸零 = **6 次往返** | **1 次 `db.batch`**（DDL + 讀設定 + 讀 `key_state`） | 冷啟動 D1 時間大幅縮短 |
| 「最近使用」時間 | 每次選鑰強制寫 D1（含索引共 2 rows）；前端 60 秒內固定顯示「`60 秒前`」 | 僅外部轉發更新記憶體即時時間與 `stateSeq`（D1 每把 Key 至多每 `60s` 節流寫 1 row）；前端本地每秒讀秒（`1 秒前`～`59 秒前`）＋停留頁面時比對記憶體序號即時跳動 | 雙螢幕測試時畫面每秒即時跳動，且額外 D1 讀寫為 **0** |
| 請求紀錄與位置 | 外部跳轉 Cloudflare AIG Dashboard | 導航列第 5 分頁「**請求紀錄**」（D1 `proxy_logs`，全量記錄含 Payload 與可複製 Key，最多保留 `1980` 筆） | 不必離開本站即可查看請求／回應內容與複製 Key；單筆 Payload 設 `64 KB` 截斷保護以防塞爆 D1 |
| 手動／批量測試 | 換模型先單跑第 1 支（超時會等兩輪 20s），每把各自讀寫 D1 | `proxy_test_models` 獨立儲存並與探測**同時並行**；按下立即全併發，整批跑完 **1 次 `db.batch`** 寫回 `key_state`（不改 `last_used_at`、不進 `proxy_logs`） | 換模型超時不再翻倍成 40 秒；批量測試不再逐把刷 D1 |
| 重導向處理 | `redirect: "follow"` | `redirect: "manual"`，3xx 視為失敗換鑰 | 防止跨來源重導向洩漏 `x-api-key`／`x-goog-api-key`／自訂標頭 |
| D1 二級索引 | `idx_key_state_pick (fp, disabled, last_used_at)` | 移除（`DROP INDEX IF EXISTS`） | 記憶體選鑰不再需要此索引，之後每次更新 `last_used_at` 或 `disabled` 少寫 1 row |
| 「設定」彈窗欄位 | 必填 `AI Gateway Logs URL`、`AI Gateway Token` | **移除這兩欄，且不新增任何新欄位**（全記與 `1980` 筆上限固定為系統常數） | 只要填好 `代理转发密码` 即可啟用轉發；過渡期底層保留舊 AIG 欄位值以便隨時一鍵回滾 |
| 文件與舊殘留對齊 | `README`、`architecture.md`、`decision-*.md`、`mock.json` 與 Python 測試存在多處舊版矛盾 | 隨本案一併清理對齊 | 實作完成當日同步更新 `docs/decision-*.md`（改當日檔名）、`docs/architecture.md` 與 `README.md` |

---

## 四、請求與測試流程

### 4.1 現有轉發流程（成功路徑）

1. `rejectIfProxyDisabled`（KV 模式直接拒絕）
2. **同步 D1 讀** `app_settings`（冷 isolate 先逐條跑 3 次 DDL）
3. 檢查 `proxyConfigError` + 驗證代理密碼
4. 比對 `alias` 找服務商，計算 `fp`
5. 讀取請求本體、合併 `extra_body`
6. 迴圈：**同步 D1 寫** `pickKeyRow` → 組標頭（含 `cf-aig-*`）→ `fetch` AIG → 2xx：**同步 D1 寫** `resetKeyFailure` → 回傳；非 2xx：**同步 D1 寫** `recordKeyFailure` → 換下一把

熱路徑共 **3 次同步 D1 往返**（冷啟動 **6 次**）。

### 4.2 新轉發流程（`/proxy/:alias/*`）

1. `rejectIfProxyDisabled`（KV 模式直接拒絕）
2. `getSnapshot(env, ctx)`：
   - 未滿 `10s`（軟 TTL）：直接回傳記憶體快照（**0 次 D1**）。
   - `10s ~ 60s`：直接回傳現有快照（**0 次同步 D1**），並以 `ctx.waitUntil(refreshSnapshot())` 背景增量更新。
   - 超過 `60s`（硬上限）：同步 `await refreshSnapshot()` 後回傳。
   - 冷 isolate（尚無快照）：同步執行 **1 次 `db.batch`**（建立 `store`、`key_state`、`proxy_logs`、移除舊索引 `idx_key_state_pick`、讀取 `app_settings` 與 `proxy_test_models`、全量讀取 `key_state`）。
3. 用快照檢查 `proxyConfigError`（僅檢查 D1 模式與 `proxy_password`）並驗證呼叫端密碼。
4. 由快照取得對應 `alias` 的服務商與預先算好的 `fp`。
5. 讀取請求本體、合併 `extra_body`，同時提取紀錄所需的 `model`、`stream` 與截斷保護後的 `req_body`。
6. 重試迴圈（最多 `maxRetries + 1` 次）：
   1. **記憶體選鑰**：在該 `fp` 的清單推進游標 `cursor`，跳過 `disabled` 與本次已試過的 `tried`，同步更新記憶體 `lastUsedAt`（若距上次寫庫 `>= 60s` 則排入待寫佇列）。
   2. 組裝直連標頭（清除入站敏感標頭、套用供應商認證與自訂標頭，不帶任何 `cf-aig-*`）。
   3. `fetch` 直連上游 `api_base + subPath + search`（`AbortController` 計 TTFB，收到標頭即 `clearTimeout`；`redirect: "manual"`）。
   4. **收到 2xx**：
      - 若該 Key 快照 `failCount > 0`，本地歸零並排入待寫佇列。
      - **非串流**：複製或讀取回應文字供紀錄截斷保存，立即回傳 `Response`，並於 `ctx.waitUntil` 執行單次 `db.batch` 寫入佇列與 `proxy_logs`。
      - **串流（SSE）**：以 `TransformStream` 將上游 `response.body` **立即透傳回傳給呼叫端**（首字延遲零增加），同時在流經時收集片段；`ctx.waitUntil` 等待串流結束、重組為可讀內容後，執行單次 `db.batch` 寫入佇列與 `proxy_logs`。
   5. **非 2xx 或網路／逾時例外**：本地 `failCount + 1`（達門檻立即標記 `disabled = true`）並記錄 `localMutatedAt`，排入待寫佇列、記錄本次失敗摘要，換下一把 Key。
7. 若全部嘗試皆失敗，將最終錯誤回應連同待寫佇列與 `proxy_logs` 交由 `ctx.waitUntil` 單次 `db.batch` 寫入，並回傳最後一次上游錯誤（無可用 Key 則回 `503 NO_KEYS` 並寫入紀錄）。

熱路徑 **0 次同步 D1 往返**；回應後背景 **1 次 `db.batch`**。

### 4.3 快照增量重載與防競態合併規則

背景 `refreshSnapshot` 以單一 `db.batch` 讀取：

- `SELECT k, v FROM store WHERE k IN ('app_settings', 'proxy_test_models')`
- `SELECT id, fp, api_key, last_used_at, fail_count, disabled, updated_at FROM key_state WHERE updated_at >= ?`（使用 `keyStateSeen - 2000` 的 2 秒安全重疊窗，徹底避免同毫秒並發或批次延遲落庫造成的漏讀）

合併與失效保護：

- 當 `app_settings.version` 與快照不同時（代表新增／刪除過服務商或 Key），改為全量讀取 `key_state`。
- **防死鑰短暫復活與保留節流狀態**：記憶體內每個 Key 項目維護 `localMutatedAt` 與 `lastWritten`。增量或全量重載合併同一把 Key 時，保留既有游標 `cursor`、`lastWritten` 與較新的 `lastUsedAt`；僅當 D1 列的 `updated_at >= entry.localMutatedAt` 時才以 D1 的 `fail_count` / `disabled` 覆蓋記憶體，避免在途 `waitUntil` 尚未落庫前被剛回來的舊讀取覆蓋。
- 同一 isolate 處理完 `POST /api/settings`、`POST /api/results`、`/api/proxy/recover`、`/api/proxy/disable`、`/api/proxy/test`、`/api/proxy/test-model`、`/api/proxy/test-commit` 後，立即更新或使本機快照失效，並推進 `stateSeq`。

### 4.4 手動單把測試與批量測試流程（不改 `last_used_at`、不進 `proxy_logs`）

- **`proxy_test_models` 拆離 `app_settings` 並與探測並行**：改存於 `store` 表的獨立鍵 `proxy_test_models`（讀取時若尚未建立則相容回退讀取舊 `app_settings.proxy_test_models`）。更新測試模型不再變動 `app_settings.version`，消除 `409 Conflict` 與無謂的全表重載。
- **模型變更並行保存（單把與批量共通）**：當使用者在下拉選單換了不同於已存值的測試模型並按下「测试」或「测试有效／无效密钥」時，前端在按下當下**同時並行**發出 `POST /api/proxy/test-model`（寫入 D1 `proxy_test_models` 並同步更新快照）與上游探測請求，兩者互不等待、不阻塞探測半毫秒。
- **單把測試（點擊卡片「测试」）**：`POST /api/proxy/test` 透過記憶體快照取得設定與 Key（0 次 D1 讀），直連上游發送 `"only reply 1."` 非串流探測，完成後立即更新記憶體快照（僅改 `failCount` / `disabled` 與 `stateSeq`，**絕不修改 `lastUsedAt`**）並寫入該把 Key 的 `key_state`。
- **批量測試（點擊「测试有效密钥／测试无效密钥」）**：
  1. 前端移除舊版「換模型時先單獨跑第 1 支」的等待邏輯，按下瞬間即以併發池（預設 5 或服務商 `max_concurrency` 上限）同時發出 `POST /api/proxy/test`（帶 `defer_write: true`）。即使換了新模型且上游全部 20 秒超時，第一批 5 支也是同時跑完 20 秒，不會變成 40 秒。
  2. `defer_write: true` 模式下，Worker 讀快照打上游並即時更新本 isolate 記憶體快照（**不改 `lastUsedAt`**），探測期間 **0 次 D1 讀取、0 次 D1 寫入**。
  3. 整批跑完後（置於 `finally` 確保中途異常也會執行），前端呼叫一次 `POST /api/proxy/test-commit` 送出本次批量探測結果，後端以**單一 `db.batch`** 一次把整批所有 Key 的失敗累加／成功歸零寫入 D1。

---

## 五、D1 寫入次數與讀寫優化

### 5.1 實測：D1 單條 SQL 語句消耗的 `rows_written`（正式環境量測）

| SQL 語句型態 | 消耗 `rows_written` |
| :-- | :-- |
| `INSERT`（無二級索引、無 `AUTOINCREMENT`） | 1 |
| `INSERT`（有 `AUTOINCREMENT`） | 2 |
| `INSERT`（有二級索引 + `AUTOINCREMENT`） | 3 |
| `UPDATE` 含二級索引的欄位（如舊版 `last_used_at`、`disabled`） | 2 |
| `UPDATE` 無索引欄位（移除舊索引後的 `fail_count`、`last_used_at`、`disabled`） | 1 |
| `UPDATE` 無匹配列（`WHERE` 不成立） | 0 |
| `DELETE` 刪除 n 列（無二級索引） | n |
| 單條語句多列 `INSERT` 3 列 | 3 |

### 5.2 每個轉發請求的讀寫成本對照

| 項目 | 現有設計 | 新設計（固定全量紀錄 `all`、上限 `1980` 筆） |
| :-- | :-- | :-- |
| 請求回應前同步 D1 往返 | **3 次**（讀設定 + 選鑰寫入 + 成功歸零） | **0 次**（熱態全走記憶體） |
| 成功請求寫入列數（穩態） | 選鑰更新含索引 **2 rows** | `proxy_logs` INSERT **1 row** + 攤提舊紀錄清理 DELETE **1 row** = **2 rows**（全部在背景單次 batch） |
| 每次失敗重試額外寫入 | 選鑰 2 rows + 失敗更新 1～2 rows（皆同步） | `fail_count` 更新 **1 row**（與日誌合併在同一個背景 batch） |
| 成功且原本 `fail_count > 0` | 歸零 1 row（同步） | 歸零 **1 row**（合併在同一個背景 batch） |
| `last_used_at` 更新 | 每次請求必寫（含在選鑰 2 rows 內） | 每把 Key 至多每 `60s` 才順便寫 **1 row** |
| 設定與狀態讀取 | 每請求讀 1 次 | 有流量時至多每 `10s` 背景增量讀 1 次 |

### 5.3 全量記錄 Payload 下的讀寫與容量優化

既然固定採用全量記錄（不靠關閉日誌省寫入），改從資料表結構與查詢方式把成本壓到最低：

1. **`proxy_logs` 無 `AUTOINCREMENT`、無二級索引**：由 5.1 實測可知，拿掉 `AUTOINCREMENT` 與二級索引可讓每筆日誌從 3 rows 降為最低極限的 **1 row**；穩態加上淘汰舊列的 1 row DELETE，每請求合計 **2 rows**，與現有「完全沒存日誌」的設計消耗相同的免費額度（D1 免費版每日 `100,000` rows 約可支撐每日 **45,000 ～ 50,000 次**轉發請求；目前實測 24 小時僅約 `2,286` rows）。
2. **同表存放、列表與詳情讀寫分離（避免拆表讓寫入翻倍）**：
   - 若拆成「元資料表 + Payload 表」，每次請求要 `INSERT` 兩張表（寫入直接翻倍）。
   - 放在同一張 `proxy_logs` 表，寫入維持 `1 row`；而列表 API `GET /api/proxy/logs` **只 `SELECT` 輕量欄位，不讀取 `req_body`、`res_body`、`attempts_detail`**（SQLite 超過頁大小的大型字串存於 overflow pages，不選取就不會去讀，也不佔回傳頻寬）。只有使用者點擊某筆紀錄右側的「**查看**」按鈕時，才以主鍵 `WHERE id = ?` 單筆查詢（只讀 `1 row`）取回完整 Payload。
3. **累積批次清理（取代每筆跑子查詢）**：isolate 內維護寫入計數器，每累積 `50` 筆日誌寫入（以及冷啟動後第 1 筆寫入）才在同一個背景 `db.batch` 附加一次主鍵範圍刪除 `DELETE FROM proxy_logs WHERE id <= (SELECT id FROM proxy_logs ORDER BY id DESC LIMIT 1 OFFSET 1980)`；同時列表 API 查詢範圍固定鎖在最新 `1980` 筆（99 頁 × 20 筆）內，既省去 98% 的清理語句執行次數，又保證前端畫面永遠不會超過 99 頁。
4. **容量安全網（64 KB 截斷 + Base64 縮略）**：D1 免費版單庫上限 `500 MB`、單列硬上限 `1 MB`。對 `req_body` 與 `res_body` 先將多模態圖片等大型 `data:...;base64,...` 字串替換為 `<base64 略，共 N 字元>`，若單欄仍超過 `64 KB` 則掐頭留尾各保留 `32 KB`。即使 `1980` 筆全滿且每筆都塞滿上限，總容量最多約 `250 MB`，絕不觸發 D1 容量或單列報錯。

---

## 六、實測數據與依據

### 6.1 測試環境與五條對照路徑說明

- **發起端與邊緣節點**：台灣本機發起；Cloudflare Pages 經 `cf-ray` 確認落點為台北 `TPE`。
- **D1 資料庫位置**：`api-test`（`running_in_region: APAC`，由東京 `NRT` primary 服務，`read_replication: disabled`），SQL 執行本身 `sql_duration_ms ≈ 0.43`，單次網路往返（`TPE ↔ NRT`）約 `62ms`。
- **上游服務商位置**：`groq`（美西 Cloudflare）、`deepseek`（西雅圖 AWS）、`google`（美西 Mountain View）、`alibaba-cn`（北京）。
- **五條受測路徑（下表皆以此對照）**：
  1. **本機直連（D）**：台灣本機直接打上游 API（理論最低延遲基準）。
  2. **本機經 AIG（G）**：台灣本機 → Cloudflare AI Gateway → 上游（同一把 Key，不經 Pages 與 D1，用來單獨量出 AIG 本身的延遲）。
  3. **Worker 直連目標（W）**：台灣本機 → Pages Worker（無同步 D1、無 AIG）→ 上游（**即本計畫目標架構的實測表現**）。
  4. **現行 Pages 經 AIG（P）**：台灣本機 → 現行 Pages `/proxy`（3 次同步 D1）→ AIG → 上游。
  5. **Railway `GPT_LOAD` 對照（L）**：台灣本機 → 部署於 Railway 的既有輪詢服務 `GPT_LOAD`（`153.52.255.34` anycast，回應 `x-railway-edge: hnd1` 東京邊緣、美西源站）→ 上游。
- **量測方法與金鑰背景**：每輪以隨機順序交替呼叫五條路徑，`max_tokens: 8` 非串流，僅統計 HTTP 200。單把 Key 的 D、G、W 偶遇 `429`，P 與 L 因輪詢不受影響；系統內原本就有達門檻停用的失效 Key（例如 `alibaba-cn` 25 把中 21 把、`deepseek` 16 把中 13 把處於停用），因此 D、G、W 取能回 200 的有效 Key，P 與 L 沿用系統輪詢。

### 6.2 熱態延遲 P50 對照（毫秒，n = 12）

| 上游服務商 | 本機直連 (D) | 本機經 AIG (G) | **Worker 直連目標 (W)** | 現行 Pages 經 AIG (P) | Railway GPT_LOAD (L) |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `groq` | 194 | 233 | **216** | 434 | 284 |
| `deepseek` | 579 | 705 | **695** | 800 | 1292 |
| `google` | 848 | 886 | **830** | 1069 | 878 |
| `alibaba-cn` | 1294 | 819 | **914** | 1032 | 1222 |

現行 Pages（P）與 Railway `GPT_LOAD`（L）另做兩輪獨立重測（n = 12～20）確認穩定度：

| 上游服務商 | 現行 Pages 經 AIG（三次 P50） | Railway GPT_LOAD（三次 P50） |
| :-- | :-- | :-- |
| `groq` | 432 / 419 / 434 | 304 / 291 / 284 |
| `deepseek` | 900 / 795 / 800 | 969 / 1212 / 1292 |
| `google` | 1233 / 1109 / 1069 | 1084 / 1066 / 878 |
| `alibaba-cn` | 1025 / 969 / 1032 | 1001 / 1061 / 1222 |

關鍵結論：

- **Worker 直連（W）幾乎貼齊本機直連（D）**：`groq` 只多 `+22ms`（剛好是一段台北邊緣往返）；連北京 `alibaba-cn` 走 Cloudflare 骨幹（`914ms`）甚至比台灣本機直連（`1294ms`）更快。
- **AIG 熱態額外開銷**（G − D，n = 20，min / P50）：`groq` `+39 / +24ms`、`deepseek` `+75 / +62ms`、`google` min `+25ms`。
- **現行 3 次同步 D1 額外開銷**（P − G，n = 12～20，min / P50）：`groq` `+171 / +178ms`、`deepseek` `+216 / +262ms`、`google` `+192 / +210ms`。
- `vercel`、`nvidia`：單 Key 直連幾乎全回 `429` 且上游波動大，無可靠樣本。

### 6.3 拆解單次 D1 往返耗時

| 測試端點 | P50 耗時 | 同步 D1 次數 |
| :-- | :-- | :-- |
| `GET /api/nope`（直接回 404） | 21ms | 0 次 |
| `GET /proxy/groq/x`（密碼錯誤回 401，僅讀設定） | 83ms | 1 次（讀） |
| `GET /api/settings` | 84ms | 1 次（讀） |

扣掉邊緣基礎回應 `21ms`，**每多 1 次同步 D1 往返就多約 `62ms`**；現行熱路徑 1 讀 2 寫剛好對應實測多出來的約 `200ms`。

### 6.4 閒置後冷啟動耗時（`groq`，閒置 240 秒後第一發）

| 路徑 | 冷啟動 P50 | 熱態 P50 | 冷啟動額外開銷 |
| :-- | :-- | :-- | :-- |
| 本機直連 (D) | 252ms | 183ms | +69ms（新建 TLS） |
| Railway GPT_LOAD (L) | 553ms | 295ms | +258ms |
| **本機經 AIG (G)** | **1208ms**（1195～1528） | 226ms | **+982ms（AIG 冷啟動約 1 秒）** |
| 現行 Pages (P，量測時 AIG 已被 G 暖過) | 638ms | 428ms | +210ms（重跑 3 條 DDL） |

D1 第一次讀取相對熱態的額外時間（不同閒置秒數後以無 D1 的 `404` 與 `D1 讀` 交替量測）：

| 閒置時間 | 5s | 60s | 180s | 420s | 600s | 900s |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 額外耗時 | 36ms | 24ms | 131ms | 172ms | 50ms | 17ms |

熱態 D1 讀取 `75 ~ 91ms`；D1 本身沒有隨閒置時間拉長而變慢的現象，偶爾多出的 `130 ~ 170ms` 純粹對應 isolate 重建後重跑 3 條 `CREATE … IF NOT EXISTS`——改為單次 `db.batch` 後即可壓低。

### 6.5 單一地區並發下的 isolate 數量與輪詢均勻度

在臨時 Pages 專案放入隨機起點記憶體計數器輪詢 4 把 Key 的實測結果：

| 測試情境 | 總請求數 | 實際命中的 isolate 數 | 4 把 Key 分配次數 |
| :-- | :-- | :-- | :-- |
| 循序請求（Keep-Alive） | 60 | 1 個 | `15 / 15 / 15 / 15` |
| 循序請求（每次新連線） | 40 | 1 個 | `10 / 10 / 10 / 10` |
| 並發 3 / 5 / 10（各 8 批） | 24 / 40 / 80 | 1 個 | 完全均勻 |
| 同時 5 / 20 / 50 / 100 個長請求在途（各佔 2 秒） | 至多 100 | **1 個** | `1/2/1/1`、`5/5/5/5`、`12/12/13/13`、`25/25/25/25` |
| 閒置 60 秒、240 秒後再打 | — | 同一個未回收（age 114s、354s） | 游標接續遞增 |

### 6.6 初測對照資料（本機單次初測，僅作參考）

| 上游服務商 | 本機直連（熱均） | 現行 Pages 經 AIG（冷 / 熱均） | Railway `GPT_LOAD`（熱均） |
| :-- | :-- | :-- | :-- |
| `groq` | 231ms | 冷 `1007~1500` / 430 | 281~608 |
| `deepseek` | 749ms | 冷 `1321~1662` / 980 | 954~1003 |
| `alibaba-cn` | — | 冷 `2366~2667` / 1231~1304 | 863~891 |
| `google` | 3447ms（含 5.9s 尖峰） | 冷 1502 / 3378 | 982 |
| `nvidia` | 21618ms | 冷 6845 / 2773~3351 | 3256 |
| `vercel` | 1514ms | 冷 `2332~2991` / 1247~1393 | 961~1044 |

`google` 8 輪（min / P50 / max）：本機直連 `514 / 718 / 5577`、現行 Pages `721 / 1144 / 4648`、Railway `GPT_LOAD` `737 / 1139 / 5888`；三條路徑皆偶發上游自身的 4～6 秒尖峰。

### 6.7 預期加速效果

改版後熱態延遲即等於 **Worker 直連（W）**。相較現行 Pages（P）的 P50 改善幅度：`groq` **快 218ms**（`434 → 216ms`）、`deepseek` **快 105ms**、`google` **快 239ms**、`alibaba-cn` **快 118ms**；且全面優於 Railway `GPT_LOAD`（快 `48 ~ 597ms`），同時徹底消除閒置後 AIG 多卡 1 秒的冷啟動。

---

## 七、詳細規格

### 7.1 直連 URL、驗證與標頭規則

- **直連位址**：`api_base.trim().replace(/\/+$/, "") + subPath + url.search`（外部轉發透傳呼叫端路徑；手動測試使用服務商的 `test_path` 或 Google 固定路徑）。
- **`api_base` 驗證（於 `handlePostSettings` 與前端編輯器同步檢查）**：
  - 正式上游必須為 `https://`；**例外放行本機迴路 `http://127.0.0.1`、`http://localhost`、`http://[::1]`**（供本地 `npm run dev:d1` 連接 mock 上游測試轉發與執行 `npm test` 離線測試套件）。
  - 拒絕含帳號密碼（`url.username || url.password`）、查詢參數（`url.search`）或 `#fragment`（`url.hash`）的 `api_base`。
- **標頭處理**：移除所有 `cf-aig-*` 與 `sanitizeHeaderAscii`；維持既有 `DROP_UPSTREAM_HEADERS`（盡可能剝除入站 `cf-*`、`x-forwarded-*`、hop-by-hop 標頭）與 `CALLER_CREDENTIAL_HEADERS`，依序填入供應商金鑰標頭與服務商 `Custom Headers`。
- **逾時與重導向**：`AbortController` + `setTimeout` 計首字標頭到達時間（收到標頭即 `clearTimeout`，不中斷長串流）；`redirect: "manual"`，任何 `3xx` 皆視為非 `2xx` 失敗並換下一把 Key。

### 7.2 記憶體快照與「最近使用」每秒即時顯示（方案 B：本地讀秒 ＋ 記憶體序號同步）

```js
snapshot = {
  loadedAt: 0,              // 上次完成載入的毫秒時間戳
  stateSeq: Date.now(),     // 記憶體狀態單調序號：每次外部選鑰/失敗/恢復時 stateSeq = Math.max(stateSeq + 1, Date.now())
  settingsVersion: 0,       // app_settings.version，變動時全量重讀 key_state
  keyStateSeen: 0,          // 已讀取的 key_state.updated_at 最大值
  settings: null,           // 解析並套用預設值後的 app_settings
  testModels: {},           // 解析後的 proxy_test_models ({ [fp]: model })
  providersByAlias: Map,    // alias -> { provider, fp, apiBase, providerType, extraBody }
  providersByFp: Map,       // fp -> { keys: KeyEntry[], cursor: number }
};

// KeyEntry:
// { id, apiKey, disabled, failCount, lastUsedAt, lastWritten, localMutatedAt }
```

「最近使用」與即時面板狀態設計（**0 次額外 D1 讀寫**）：

1. **僅外部呼叫更新 `lastUsedAt`**：只有外部客戶端呼叫 `/proxy/:alias/*` 選鑰時才會更新 `memEntry.lastUsedAt = Date.now()`（並推進 `stateSeq`；若距上次寫入 D1 `>= 60s` 才排入背景節流寫庫）。面板單把／批量測試、恢復、禁用均**不修改** `lastUsedAt`。
2. **`GET /api/proxy/state` 讀記憶體快照並支援 `?since_seq=<n>`**：
   - 先透過 `getSnapshot(env, ctx)` 取得記憶體快照（暖態下 **0 次 D1 查詢**）。
   - 若請求帶有 `?since_seq=<n>` 且 `Number(n) === snapshot.stateSeq`，直接回傳 `{ ok: true, unchanged: true, state_seq: snapshot.stateSeq }`（幾十 bytes，0 次 D1）。
   - 若首次載入或 `stateSeq` 已推進，直接由記憶體快照組裝回傳（每把 Key 的 `last_used_at` 取記憶體即時毫秒時間戳），並附帶 `state_seq: snapshot.stateSeq`。因 `stateSeq` 以啟動毫秒時間戳為底並單調遞增，即使 isolate 重建也不會與前端舊序號誤撞。
3. **前端每秒讀秒跳動 ＋ 可見時輕量序號比對**：
   - `proxyTimeLabel(ms)` 解除舊版「60 秒內一律顯示 `60 秒前`」的鎖定，改為 `< 60s` 顯示實際秒數（`Math.max(1, diffSec)` → `1 秒前` ～ `59 秒前`，滿 60 秒依序為 `X 分钟前` / `X 小时前` / `X 天前`），並在卡片元素標記 `data-last-used="${ms}"`。
   - 當使用者停留在「輪詢轉發」分頁且頁面可見（`!document.hidden`）時：
     - **每秒本地跳字（`1000ms`）**：純前端遍歷當前頁最多 9 張卡片，以 `Date.now() - Number(dataset.lastUsed)` 即時刷新文字與 `title`（0 次網路請求、0 次 D1）。
     - **輕量記憶體同步（`2000ms`）**：在非測試忙碌（`!state.proxyBusy`）時呼叫 `/api/proxy/state?since_seq=${state.proxyStateSeq}`；收到 `unchanged: true` 不做任何 DOM 操作，若有外部新呼叫則以 `preserveOrder: true` 無閃爍刷新卡片時間戳、失敗次數與有效／無效膠囊統計。一旦切離「輪詢轉發」分頁或縮小／切換瀏覽器視窗（`visibilitychange`），兩個計時器立即停止。

### 7.3 請求紀錄資料表 `proxy_logs` 與 Payload 處理

```sql
CREATE TABLE IF NOT EXISTS proxy_logs (
  id              INTEGER PRIMARY KEY,    -- 無 AUTOINCREMENT、無二級索引（每筆 INSERT 固定 1 row）
  ts              INTEGER NOT NULL,       -- 請求開始毫秒時間戳
  alias           TEXT    NOT NULL,       -- 服務商轉發別名
  provider_type   TEXT    NOT NULL,       -- openai / google / anthropic
  method          TEXT    NOT NULL,
  path            TEXT    NOT NULL,       -- 呼叫路徑（不含敏感 query 如 ?key=...）
  model           TEXT,                   -- 解析自 JSON body.model 或 Google 路徑
  stream          INTEGER NOT NULL DEFAULT 0,
  status          INTEGER NOT NULL,       -- 最終回應狀態碼；0 代表網路錯誤或逾時
  ttfb_ms         INTEGER,                -- 最後一次嘗試送出至收到標頭耗時
  duration_ms     INTEGER,                -- 整筆請求完成總耗時（含串流完整收畢）
  attempts        INTEGER NOT NULL,       -- 總嘗試次數（1 = 一次成功）
  key_id          INTEGER,                -- 最終使用的 key_state.id
  api_key         TEXT,                   -- 最終使用的完整 API Key（僅管理員認證 API 可讀，供遮罩顯示與一鍵複製）
  colo            TEXT,                   -- request.cf?.colo
  error           TEXT,                   -- 失敗簡短摘要（列表預覽用，<= 300 字元，遮罩 Key）
  attempts_detail TEXT,                   -- JSON 陣列：每次嘗試的 { attempt, key_masked, status, ms, error }
  req_body        TEXT,                   -- 轉發送出的請求 Payload（經 Base64 縮略與 64 KB 掐頭留尾保護）
  res_body        TEXT                    -- 回應 Payload（串流重組為可讀內容；經 64 KB 掐頭留尾保護）
);
```

記錄與處理規則：

- **固定全量記錄、上限 `1980` 筆**：常數 `PROXY_LOG_PAGE_SIZE = 20`、`PROXY_LOG_MAX_PAGES = 99`、`PROXY_LOG_MAX_ROWS = 1980`。
- **記錄範圍**：所有通過 `proxy_password` 驗證且 `alias` 存在的外部 `/proxy/:alias/*` 請求（含 `2xx`、非 `2xx`、逾時、`503 NO_KEYS`）一律記錄。未通過密碼驗證（`401`）、未知別名（`404`）、KV 模式停用（`503`）與面板手動／批量測試（`/api/proxy/test`）**不寫入** `proxy_logs`。
- **串流回應重組（不卡首字延遲）**：當 `stream === 1` 且回應為 `text/event-stream` 時，透過 `TransformStream` 原樣把每個 chunk 推給呼叫端，旁路解碼 SSE `data:` 行，依 `provider_type`（OpenAI delta、Anthropic content_block_delta、Google candidates parts）重組為結構化 JSON `{ content, thinking, usage, finish_reason }` 存入 `res_body`（若解析無內容則退回保存原始文字）。
- **64 KB 截斷與多模態圖片保護**：寫入 `req_body` / `res_body` 前，先將 `data:[^;]+;base64,[A-Za-z0-9+/=]{256,}` 替換為 `<base64 omitted (N chars)>`；若字串長度仍超過 `65536` 字元，保留前 `32768` 與後 `32768` 字元並在中間標註省略字數。

### 7.4 請求紀錄 API（`/api/proxy/logs`）

所有端點皆需 `requireAuth` 管理員驗證，KV 模式下回傳 `503 PROXY_DISABLED`：

1. **列表查詢 `GET /api/proxy/logs`**：
   - 查詢參數：`page`（`1 ~ 99`，預設 `1`）、`alias`（選填，精確匹配）、`status`（選填：支援 `"ok"` = `200..299`、`"fail"` = 非 `2xx`、或具體數字狀態碼如 `"429"`、`"0"`）、`key`（選填，子字串不分大小寫匹配 `api_key` 或 `maskKey(api_key)`）、`model`（選填，子字串不分大小寫匹配 `model`）。
   - 查詢最新 `1980` 筆範圍內符合條件的列，**僅選取輕量列表欄位**（`id, ts, alias, provider_type, method, path, model, stream, status, ttfb_ms, duration_ms, attempts, key_id, api_key, colo, error`），回傳每筆包含 `key_masked: maskKey(api_key)` 與 `api_key`（供複製鈕使用），以及 `{ ok: true, page, page_size: 20, total, total_pages, logs: [...] }`。
2. **單筆詳情 `GET /api/proxy/logs?id=<id>`**：
   - 以主鍵 `SELECT * FROM proxy_logs WHERE id = ?` 讀取單列（消耗 1 row 讀取），回傳完整欄位（含 `req_body`、`res_body`、解析後的 `attempts_detail`），供點擊「查看」彈窗時載入。
3. **清空紀錄 `DELETE /api/proxy/logs`**：
   - 執行 `DELETE FROM proxy_logs` 清空全部紀錄（或帶 `?alias=xxx` 清空指定服務商），回傳 `{ ok: true, deleted }`。

### 7.5 導航列第 5 分頁「請求紀錄」UI 規格

- **導航列頁籤**：於 `public/index.html` 頂部 `.tabs` 第 5 個位置新增 `<button class="tab-btn" data-tab="logs" type="button">请求记录</button>`，於 `STORAGE_BACKEND=kv` 時與「輪詢轉發」同步隱藏；移除「輪詢轉發」頁首原本的 `Gateway 记录 ↗` 按鈕。
- **上方常駐篩選列（比照「失效密鑰」`.dk-filter-panel` 視覺與控制項高度）**：
  - `供应商` 下拉選單（預設「全部」，列出已設別名的服務商與歷史紀錄中的別名）
  - `状态` 下拉選單（預設「全部」，含 `2xx 成功`、`失败 / 异常` 及實際出現過的狀態碼）
  - `Key 搜寻` 等寬輸入框（`placeholder="sk-..."`，支援搜明文片段或遮罩片段）
  - `模型搜寻` 輸入框
  - 右側操作區：`清空记录`（紅色危險鈕 `btn-danger`，點擊跳出確認後執行）與 `清除筛选`（`btn-secondary`）
- **列表（一行一筆，每頁 `20` 筆，最多 `99` 頁）**：
  - 欄位：時間、供應商（別名）、模型、狀態碼（綠／紅徽章，重試過顯示嘗試次數如 `2次`）、耗時（TTFB / 總耗時）、使用金鑰（等寬顯示 `maskKey` 脫敏文字 ＋ 旁附 `.copy-btn` 一鍵複製完整明文 Key）、最右側「**查看**」按鈕（`btn-secondary btn-xs`）。
  - 右下角分頁控制項：複用與「輪詢轉發」完全一致的 `<` `[頁碼 / 總頁數]` `>` 分頁框（支援輸入頁碼與滑鼠滾輪切換，最多 2 位數 `99`）。
- **詳細內容視窗（點擊「查看」開啟）**：
  - 採用與現有 `sample-overlay` / `errdetail-overlay` 一致的寬版彈窗 `.modal-panel--wide`（支援 `Esc` 與背景點擊關閉，遵守嚴格 CSP 無行內 `style=""`）。
  - 顯示內容：基本資訊列（時間、方法與完整路徑、模型、串流與否、狀態碼、TTFB／總耗時、邊緣節點 `colo`、脫敏 Key + 複製鈕）、重試過程明細（若有多次嘗試，列出每次用的是哪把遮罩 Key、狀態碼與錯誤）、`Request Payload`（格式化 JSON 區塊 + 右上複製鈕）、`Response Payload`（格式化內容或錯誤原文區塊 + 右上複製鈕）。

---

## 八、其他加速選項評估（結論：維持不做）

| 候選想法 | 對熱路徑延遲的幫助 | 評估結論 |
| :-- | :-- | :-- |
| 把代理密碼搬去 Pages 環境變數 | **0ms**（密碼已在記憶體快照內，本來就不查 D1） | 改密碼還得去 Dashboard 重新部署，違反「全部在網頁設定」。**不做** |
| 快照另外存一份到 Cache API / KV 加速冷啟動 | 僅影響冷啟動約 `60 ~ 130ms`（15 分鐘內多半保溫） | KV 為最終一致，且單次 `db.batch` 已夠快。**不做** |
| 非串流請求超時前發第 2 把 Key 競速（Hedging） | 可壓低偶發長尾尖峰 | Token 用量與 `429` 風險加倍。**預設不做** |
| 請求本體不緩衝直接串流給上游 | 小請求無感 | 失敗重試換 Key 時必須重放請求本體，因此必須保留緩衝。**不做** |

---

## 九、預計改動範圍與既有矛盾清理清單

### 9.1 直連架構與請求紀錄改動檔案

1. **`src/storage.js`**：`ensureSchema` 改為單次 `db.batch`；新增 `proxy_logs` 資料表 DDL 與 `DROP INDEX IF EXISTS idx_key_state_pick`；新增 `PROXY_TEST_MODELS_KEY = "proxy_test_models"` 常數。
2. **`src/proxy-state.js`（新增）**：記憶體快照結構（含單調序號 `stateSeq`）、`getSnapshot`、`refreshSnapshot`（含 `updated_at >= seen - 2000` 增量查詢與 `localMutatedAt` 防覆蓋合併）、`invalidateSnapshot`、隨機起點記憶體選鑰（僅外部選鑰更新 `lastUsedAt`）、背景 `flushWrites`（含計數滿 50 筆批次清理舊日誌，清理間隔可由測試注入）。於 `scripts/build-worker.mjs` 排在 `proxy.js` 之前。
3. **`src/proxy-logs.js`（新增）**：Payload Base64 縮略與 `64 KB` 掐頭留尾、SSE 串流旁路重組器、`GET /api/proxy/logs`（列表輕量查詢與 `?id=` 單筆詳情查詢）、`DELETE /api/proxy/logs`。
4. **`src/entry.js`**：`fetch(request, env, ctx)` 接收並傳遞 `ctx`；註冊 `GET /api/proxy/logs`、`DELETE /api/proxy/logs`、`POST /api/proxy/test-commit`。
5. **`src/proxy.js`**：改為由 `provider.api_base` 組裝直連網址、`redirect: "manual"`、移除 `cf-aig-*` 與 `sanitizeHeaderAscii`；`proxyConfigError` 移除 AIG 欄位檢查；`handleProxy` 改用記憶體快照選鑰、串流旁路收集與 `ctx.waitUntil` 背景批次寫入。
6. **`src/proxy-handlers.js`、`src/results.js`**：
   - `handleGetProxyState`：改讀記憶體快照（暖態 0 次 D1），支援 `?since_seq=` 未變動短路回傳 `{ unchanged: true, state_seq }`；移除 `via_gateway`、`gateway_ready`、`logs_url`、`logs_url_template`、`sample_path`；由獨立鍵讀取 `proxy_test_models`（向下相容舊 `app_settings.proxy_test_models`）。
   - `handleProxyTestModel`：改寫入獨立鍵 `store('proxy_test_models')`，不再改動 `app_settings` 與 `version`。
   - `handleProxyTest`：直連上游、不改 `lastUsedAt`、不寫 `proxy_logs`；支援 `defer_write: true` 供批量測試零 D1 探測；新增 `handleProxyTestCommit` 於整批完成後單次 `db.batch` 寫入所有 Key 的 `fail_count` / `disabled`。
   - `handleProxyRecover`、`handleProxyDisable`、`recoverKeysFromResults`（`src/results.js`）：完成後同步更新或使本 isolate 快照失效並推進 `stateSeq`。
7. **`src/settings.js`、`src/settings-handlers.js`**：移除 `ai_gateway_*` 格式驗證與 `parseGatewayLogsUrl`，**過渡期內原樣保留既有 `ai_gateway_*` 值回寫**（供一鍵回滾舊版）；新增 `validateProviderApiBases`（強制 `https://`，放行 `http://127.0.0.1` / `localhost` / `[::1]`，拒絕 userinfo、`?query`、`#fragment`）；儲存後使快照失效。
8. **前端（`public/index.html`、`public/style-proxy.css`、`public/js/*`、`public/mock.json`）**：
   - 「設定」彈窗：移除 `AI Gateway Logs URL` 與 `AI Gateway Token` 欄位及相關驗證（不新增任何欄位）。
   - 「輪詢轉發」分頁：移除頁首 `Gateway 记录 ↗`；`proxyTimeLabel` 改顯示即時秒數（`1 秒前`～`59 秒前`），新增分頁可見時的每秒本地讀秒計時器與每 2 秒 `?since_seq` 輕量記憶體同步；單把／批量測試若模型變動則並行呼叫 `POST /api/proxy/test-model`，批量測試移除首支等待並於 `finally` 單次呼叫 `POST /api/proxy/test-commit`。
   - 新增第 5 分頁「請求紀錄」（`public/js/proxy-logs.js`，於 `index.html` 依序載入）：常駐篩選列、每頁 20 筆表格（含遮罩 Key 與 `.copy-btn` 複製明文 Key）、最多 99 頁滾輪分頁器、「查看」寬版詳情彈窗；同步支援 `?mock` 離線模式與 KV 模式自動隱藏。全程遵守既有 CSP（無行內 `style=""`、無行內 `<script>`）。
9. **測試（`tests/worker.test.mjs`、`tests/frontend.test.mjs`、`tests/test_async_engine.py`）**：將假 AIG 攔截器改為直連本機 mock 上游斷言，覆蓋第十節全部自動化測試案例。
10. **文件**：實作完成當日同步更新 `docs/decision-*.md`（改當日檔名）、`docs/architecture.md` 與 `README.md`。

### 9.2 既有代碼、測試與文檔矛盾／殘留一併清理清單（盤點確認項）

實作時同步清掉以下 6 組現存問題，避免舊殘留繼續誤導或漏測：

1. **修復全數報錯的 Python 離線測試 `tests/test_async_engine.py`**：為測試內的 `openai` 案例補齊 `test_path="/v1/chat/completions"`（並對齊 `api_base` 為不含重複 `/v1` 的根網址），修復目前 `python -m unittest tests/test_async_engine.py` 3 項全敗的錯誤。
2. **修復 `src/settings-handlers.js` 漏比對 `test_path` 的存檔 Bug 與舊欄位殘留**：於 `canonicalProviderForCompare()` 補上 `test_path`（修正單獨改測試路徑按儲存會被誤判為 `unchanged: true` 而跳過寫入的問題），並刪除早已廢棄的 `gateway_provider` 分支。
3. **修正 `public/js/settings.js` 與 `tests/frontend.test.mjs` 的過期參數名**：將 `loadProxyState({ preserveResults: true })` 修正為實際生效的 `loadProxyState({ preserveOrder: true })`，並同步更新對應測試斷言。
4. **清理 `public/mock.json`、`public/js/{mock,results,dead-keys}.js` 與 `async_test_keys.py` 的舊格式與 `/v1` 重複**：
   - `public/mock.json` 與 `async_test_keys.py` 單機預設常數：修正 `dashscope`（改為 `api_base: "https://dashscope.aliyuncs.com/compatible-mode"` + `test_path: "/v1/chat/completions"`）與 `claude-off`（改為 `api_base: "https://api.anthropic.com"` + `test_path: "/v1/messages"`），消除 `/v1/v1` 誤導範例。
   - 將 `public/mock.json` 的 `results` 改以 `fp` 為鍵、`dead_keys` 補齊對應 `fp`（並補入數筆 `proxy_logs` 範例供 `?mock` 預覽第 5 分頁），同時移除 `results.js` 以 `host` 查 mock 結果以及 `mock.js` / `dead-keys.js` 殘留的無 `fp` `provider_host` fallback（真正落實全站純 `fp` 對帳）。
5. **清除後端死程式碼**：移除 `src/entry.js` 中已不存在的 `/api/storage/` 路徑豁免判斷，以及 `src/proxy-handlers.js` 中前端完全未使用的 `SAMPLE_PATHS` / `sample_path`。
6. **對齊三份文檔（`README.md`、`docs/decision-*.md`、`docs/architecture.md`）**：
   - `README.md`：修正第 16 行過期的「填至版本前綴自動補全」描述、移除目錄結構中已刪的 `storage-migrate` 與 `migrate-kv-to-d1.mjs`、修正「恢复所有密钥」實際會彈出確認框的說明，並更新為直連與 5 分頁架構。
   - `docs/decision-*.md`：修正舊段「一致遵守填至版本前綴」與新段 `test_path` 的前後矛盾，寫入本次直連、記憶體快照、`stateSeq` 即時顯示、全量 `proxy_logs` 與批量測試改造決策。
   - `docs/architecture.md`：全面同步至最新現況（移除已刪除的搬移腳本與 `/api/storage/*`、將殘留的 `gemini` 統一改為 `google`、補上 `test_path`、第 5 分頁「請求紀錄」、記憶體快照選鑰與事後 `db.batch` 流程圖）。

---

## 十、驗證計畫

### Phase 0：離線自動化測試（模擬 D1 與本機 mock 上游，絕不使用真實 Key）

1. **熱路徑 0 次同步 D1**：快照暖態下，轉發請求回傳前 D1 呼叫數為 `0`；`waitUntil` 完成後恰好 `1` 次 `db.batch`。
2. **快照生命週期與防競態**：冷 isolate 單次 `batch` 完成建表與載入；`10s ~ 60s` 先回舊值再背景增量更新；超過 `60s` 同步更新；在途失敗標記 `disabled` 不會被較早發出的背景 `refresh` 舊結果覆蓋；`recover`／`disable`／`settings`／`results` 後本機快照立即生效。
3. **記憶體選鑰**：隨機起點；跳過 `disabled` 與本次已試過的 `tried`；同事件迴圈並發請求拿到不同 Key；長序列均勻；全禁用時回 `503 NO_KEYS` 並寫入紀錄。
4. **直連與標頭淨化**：正確拼接路徑與 query；無 `cf-aig-*`、無洩漏 `cf-connecting-ip` / `cookie` 等標頭；`3xx` 視為失敗換鑰；`api_base` 拒絕外網 `http://` 與 `?query`/`#fragment`，但允許 `http://127.0.0.1` 與 `http://localhost`。
5. **逾時不切串流**：上游遲不回標頭 → 依逾時中止並計失敗；標頭已回、SSE 串流持續超過逾時毫秒 → 正常傳完不中止，且串流結束後成功重組內容寫入 `proxy_logs.res_body`。
6. **請求紀錄與讀寫分離**：
   - 全量記錄 `2xx`、非 `2xx` 與 `NO_KEYS`；`401` 密碼錯誤、未知 `alias`、手動／批量測試不產生紀錄。
   - 大型 Base64 圖片自動縮略、超過 `64 KB` 正確掐頭留尾。
   - 列表 `GET /api/proxy/logs` 回傳不含 `req_body`/`res_body`，但含 `key_masked` 與可供複製的 `api_key`，分頁最多 99 頁（每頁 20 筆）；`GET /api/proxy/logs?id=` 回傳完整 Payload；篩選（別名、狀態、Key、模型）與 `DELETE` 清空正確運作；累積計數達門檻時自動裁切保留最新 `1980` 筆。
7. **測試模型並行與批量測試最佳化**：換模型後執行單把或批量測試時，`POST /api/proxy/test-model` 與探測請求並行且不變動 `app_settings.version`；批量測試不再先單跑第 1 支，`defer_write: true` 期間 0 次 D1 讀寫，`test-commit` 單次 `db.batch` 寫回失敗計數／解禁；且所有手動／批量測試皆**不改動 `last_used_at`**、**不產生 `proxy_logs`**。
8. **「最近使用」即時顯示與 `?since_seq` 零 D1 同步**：驗證外部轉發推進 `lastUsedAt` 與 `stateSeq`；`GET /api/proxy/state?since_seq=` 在無變動時 0 次 D1 回傳 `unchanged: true`，有變動時 0 次 D1 回傳最新毫秒時間戳；前端 `proxyTimeLabel` 對 1～59 秒回傳對應的 `${n} 秒前`。
9. **既有矛盾回歸測試與前端 DOM 檢查**：驗證單獨修改 `test_path` 可正常儲存寫入（不被誤判為 `unchanged`）；驗證第 5 分頁「請求紀錄」、篩選列、詳情彈窗存在且已移除 `set-gateway-*` 與 `#proxy-logs` 外連鈕、無違反 CSP 的行內 `style=""`；`npm test` 與 `python -m unittest tests/test_async_engine.py` 全數通過。

### Phase 1：Pages 預覽環境實測（操作員手動驗證）

- 在 Dashboard 為預覽分支綁定 D1（不建 `wrangler.toml`）。
- 對既有服務商別名實測直連 P50／P90、SSE 串流對話、「請求紀錄」分頁查看 Payload 與複製 Key 功能，以及非台灣出口的地域連通性。
- 以 `wrangler d1 info` 前後比對 `rows_written_24h`，確認每請求寫入列數符合 5.2 估算。

### Phase 2：正式上線與回滾保險

- 部署後觀察 7 天各別名錯誤率與 D1 寫入量。
- **零風險一鍵回滾**：因過渡期內 `app_settings` 仍原樣保留舊的 `ai_gateway_logs_url` 與 `ai_gateway_token`，且 AIG 後台 Custom Provider 暫不刪除，若遇異常直接在 Pages Dashboard 回滾至上一版部署即可無縫恢復舊架構。確認穩定後再另案清理舊欄位與 AIG 後台資源。

---

## 十一、已知限制

- 實測數據皆自台灣（`TPE`）量測；其他地區請求走當地邊緣節點與出口，需在 Phase 1 抽測是否有上游地域限制（如 `403`／`451`）。
- 第三方公益站／中轉站若同樣架在 Cloudflare 後方，Worker 直連時 Cloudflare 底層會自動附帶 `CF-Worker` 標頭（無法由程式剝除），極少數開啟嚴格防爬規則的中轉站可能攔截，需於 Phase 1 逐一確認。
- 單筆 Payload 超過 `64 KB` 或內嵌大型 Base64 圖片時會執行縮略／掐頭留尾，不保存數 MB 的原始多模態二進位內容。

---

## 十二、明確不做

- 不提供請求紀錄開關或可調筆數欄位（固定全記、固定上限 `1980` 筆／99 頁）。
- 不計算各模型 Token 帳單費用。
- 不在 `STORAGE_BACKEND=kv` 模式提供轉發或請求紀錄。
- 不維護跨地區多 isolate 之間的嚴格全域輪詢順序。
- 不在 `proxy_logs` 新增二級索引或 `AUTOINCREMENT`。
- 不把代理密碼移到 Cloudflare 環境變數。
