# 失效密鑰 Code 篩選與表格欄位正倒序排序規劃

本規劃針對「失效密鑰 (Dead Keys)」分頁，解答關於 Code 篩選的實作評估與 KV 讀寫影響，並針對表格 5 個欄位（編號、域名供應商、KEY、失效時間、CODE）增加正/倒序箭頭排序功能進行詳細規劃。

---

## 問題 1 回答：Code 篩選方式評估與 KV 讀寫成本

### 1. KV 讀寫次數：兩者皆為 0 次（零讀寫）
- **原因**：當使用者進入失效密鑰分頁時，前端已一次性呼叫 `GET /api/dead-keys` 將所有失效記錄全量快取至前端記憶體變數 `state.deadKeys`。
- 所有的篩選條件（供應商域名、Key 模糊搜尋、日期區間、以及新增的 Code 篩選）都是在**瀏覽器端記憶體陣列（In-Memory Array Filter）**過濾。
- 不管使用下拉選單還是輸入框，**均不消耗任何 Cloudflare KV 讀取或寫入配額**。

### 2. 下拉選單 vs. 直接輸入框 優缺點比較

| 比較項目 | 方案 A：動態下拉選單（推薦） | 方案 B：直接文字/數字輸入框 |
| :--- | :--- | :--- |
| **運作方式** | 自動掃描 `state.deadKeys` 提取出現過的代碼（如 400, 401, 403, 429, 500, 无 Code） | 提供 `<input type="text">` 讓使用者手動輸入代碼 |
| **KV 讀寫次數** | **0 次** | **0 次** |
| **使用者操作體驗 (UX)** | **極佳**。一鍵點擊展開即可選取，在手機與電腦端均不需手動打字喚起鍵盤。 | **普通**。需手動輸入 3 位數字，在行動裝置上需切換輸入法/數字鍵盤。 |
| **防呆與準確度** | **極高**。只列出當前資料中「確實存在」的代碼，不會因手誤打錯代碼而搜尋無果。 | **較低**。使用者可能打錯代碼或輸入當前無記錄的狀態碼。 |
| **無代碼記錄處理** | **支援完善**。可提供「无 Code (-)」選項，一鍵篩選 `error_code == null`（手動新增或尚未更新代碼）的記錄。 | **困難**。輸入框難以直觀表達篩選「沒有 Code」的記錄。 |
| **介面一致性** | **完全一致**。與目前篩選面板的「供應商域名」下拉選單風格及交互完全統一。 | 與其他下拉選單風格不一致，且易與旁邊的 Key 模糊搜尋混淆。 |

> [!TIP]
> **結論**：推薦採用 **動態下拉選單（Dropdown）** 方案。

---

## 規劃項目 2：表格五項標頭正倒序排序

### 支援排序欄位
1. **编号 (Index)**：
   - 預設（正序）：維持原有的供應商順序 + 插入順序（`sortByProviderOrder`）。
   - 倒序：反轉供應商順序。
2. **域名供应商 (Provider Host)**：
   - 正序：域名字母 A 到 Z 排序。
   - 倒序：域名字母 Z 到 A 排序。
3. **KEY (API Key)**：
   - 正序：API Key 字母 A 到 Z 排序。
   - 倒序：API Key 字母 Z 到 A 排序。
4. **失效时间 (Expired At)**：
   - 正序：日期由舊到新（升序），無日期項目排在最後。
   - 倒序：日期由新到舊（降序），無日期項目排在最後。
5. **CODE (Error Code)**：
   - 正序：代碼數字由小到大（如 400 -> 401 -> 403 -> 429 -> 500），無代碼排最後。
   - 倒序：代碼數字由大到小（如 500 -> 429 -> 403 -> 401 -> 400），無代碼排最後。

---

## 預計修改檔案清單

### 1. [index.html](file:///c:/Users/artin/Sync/coding/api-test/public/index.html)
- 在 `#dk-filter-panel` 篩選面板中新增「錯誤代碼 (Code)」的 `<select id="dk-f-code">` 下拉選單。

### 2. [app.js](file:///c:/Users/artin/Sync/coding/api-test/public/app.js)
- **DOM 參考綁定**：在 `dom` 物件中新增 `dkFCode: $("dk-f-code")`。
- **排序狀態管理**：在 `state` 物件中新增 `dkSort: { col: "index", dir: "asc" }`（預設為編號正序）。
- **Code 下拉選單生成**：新增 `fillCodeSelect()` 函式，掃描 `state.deadKeys` 產生 `全部 Code`、各出現過的狀態碼（如 400、401、403、429 等）、以及 `无 Code` 選項。
- **篩選邏輯擴充**：在 `filteredDeadKeys()` 中加入 `dom.dkFCode.value` 的過濾判斷；在 `activeFilterCount()` 與 `dk-f-reset` 重設邏輯中納入 `dkFCode`。
- **排序邏輯升級**：
  - 新增 `sortDeadKeyRows(rows)` 函式，根據 `state.dkSort` 對過濾後的列進行排序（支援 `index`、`host`、`key`、`expired_at`、`code` 五項的正倒序）。
  - 在 `renderDeadKeys()` 中調用 `sortDeadKeyRows(filteredDeadKeys())`。
  - 在 `renderDeadKeysTable()` 標頭增加 `data-sort` 屬性與 `<span class="sort-indicator">`（目前使用中排序顯示 `▲` 或 `▼`）。
- **事件監聽綁定**：
  - 在 `bindEvents()` 中監聽 `dom.dkFCode` 的 `change` 事件。
  - 在 `dom.dkTableWrap` 的點擊委派中監聽 `th[data-sort]` 點擊，切換 `asc` / `desc` 並調用 `renderDeadKeys()`。

### 3. [style.css](file:///c:/Users/artin/Sync/coding/api-test/public/style.css)（如需調整樣式）
- 檢查現有 `.data-table th[data-sort]` 與 `.sort-indicator`，確保在深色與淺色模式下均有清晰的箭頭與懸停高亮。

---

## 驗證方案

### 語法與規範檢查
- 執行 `npm run check`（確保 `node --check` 通過，無語法錯誤）。
- 嚴格遵守 `AGENTS.md` 規範（不使用內聯樣式、不使用 Lookbehind 正則）。

### 手動功能驗證
- 使用 `http://127.0.0.1:8788/?mock` 進入 Mock 模式驗證：
  1. 測試 Code 下拉選單：切換至 401、429、无 Code 等，確認列表正確過濾且篩選計數正確。
  2. 點擊「清除篩選」，確認 Code 下拉選單回到「全部 Code」。
  3. 分別點擊 编号、域名供应商、KEY、失效时间、CODE 的標頭，確認 `▲`（正序）與 `▼`（倒序）正確切換且資料排序正確。
  4. 在特定排序狀態下勾選核取方塊與編輯記錄，確認功能正常無偏移。
