# 失效密鑰自動對帳邏輯改造計畫（Plan B：結合來源設定雙向對帳）

**狀態：已於 2026-08-17 完成實作並合入代碼庫**（Commit: `c50da0d`）實作程式碼位於 `public/_worker.js`，後續維護與決策依據請參閱 `docs/decision-0817.md`。

## 一、背景與問題

### 1.1 現有機制
目前在每次測試結果上傳（`POST /api/results`）時，後端會執行 `syncDeadKeysFromResults` 進行失效密鑰（`dead_keys`）的自動對帳：
- **新增**：將本次測試失敗的 Key（`invalid_records`）寫入 `dead_keys` 清單。
- **刪除（現狀）**：只將本次測試「判定有效」的 Key（`valid_keys`）從 `dead_keys` 移除。

### 1.2 現況產生的問題
使用者在「來源設定」中主動刪除或更換某支失效 Key 後：
- 該 Key 不會再被送入測試，因此下次測試時它**既不會在 `valid_keys` 也不會在 `invalid_records`**。
- 現有機制不會觸發刪除，導致該 Key 變成「幽靈失效密鑰」永久殘留在 `dead_keys` 清單中，使用者必須手動進入失效密鑰分頁勾選批量刪除。

### 1.3 為什麼不採用「單次結果覆蓋全 Host 快照」（Plan A）？
若單純以「本次測試的 `invalid_records` 判定留存，其餘一律 drop」，在同一個 Host（例如聚合網關 `my-proxy.com`）配置了多張卡片（例如 `/v1` 與 `/anthropic`）時，排程依序上傳時會產生「後上傳的卡片將前面卡片的失效 Key 當成幽靈誤刪」的互相覆蓋問題。

### 1.4 目標架構（Plan B：結合來源設定 `app_settings`）
將 `dead_keys` 清單的語意徹底收斂為：**「反映來源設定中目前測試依然失敗的 Key（來源為唯一標準）」**，同時具備「同 Host 多卡片相容性」：
1. **成功恢復**：在本次測試中判定為有效（`valid_keys`）的 Key $\rightarrow$ 自動刪除。
2. **來源已移除（幽靈清空）**：比對當前 `app_settings`，只要該 Key **已從該 Host 的所有 Provider 卡片中被移除** $\rightarrow$ 自動刪除。
3. **失敗維持**：仍存在於來源設定中且未通過測試的 Key $\rightarrow$ 維持保留。

---

## 二、作用範圍與專有名詞定義（Scope & Terminology）

| 項目名稱 | 範圍與定義 | 說明 |
|---|---|---|
| `provider_host` | `new URL(api_base).hostname`（字串） | 失效密鑰的作用域與隔離邊界（例如 `api.openai.com`）。單次對帳僅影響該 host 下的記錄。 |
| `app_settings` | KV Key: `"app_settings"`（JSON 物件） | 全域設定，包含 `providers[]`（每項有 `api_base`, `api_keys[]` 等）。 |
| `dead_keys` | KV Key: `"dead_keys"`（JSON 陣列） | 全域單一陣列，儲存所有 Provider 的失效記錄：`[{ id, provider_host, api_key, expired_at, error_code, error_detail, created_at }, ...]`。 |
| `configured_host_keys` | `Set<string>` | 從 `app_settings.providers` 中提取所有符合該 `provider_host` 的 Provider 設定的 Key 聯集。 |
| `recovered_keys` | `Set<string>` | 本次測試中通過檢測的 Key 清單（來自 `valid_keys`）。 |
| `invalid_records` | 上傳 payload 中的陣列 | 本次測試中失敗的記錄陣列，每筆包含 `api_key`, `error_code`, `error_detail` 等。 |

---

## 三、技術設計與對帳邏輯（Plan B）

### 3.1 對帳核心流程（`syncDeadKeysFromResults`）

當某個 Provider 呼叫 `POST /api/results` 時：

1. **解析作用域**：
   自 `api_base` 取得 `provider_host`。若 URL 解析失敗或為空，則直接返回 `{ added: 0, removed: 0 }`。
2. **平行讀取 KV**：
   同時讀取 `dead_keys` 與 `app_settings`：
   ```js
   const [rawDeadKeys, rawSettings] = await Promise.all([
     kv.get(DEAD_KEYS_KEY),
     kv.get(SETTINGS_KEY),
   ]);
   let list = parseJsonOrNull(rawDeadKeys);
   if (!Array.isArray(list)) list = [];
   const settings = parseJsonOrNull(rawSettings) || {};
   ```
3. **收集該 Host 在來源設定中的全部 Key（`configuredKeysForHost`）**：
   ```js
   const configuredKeysForHost = new Set();
   const providers = Array.isArray(settings.providers) ? settings.providers : [];
   for (const p of providers) {
     if (!p || typeof p.api_base !== "string" || !Array.isArray(p.api_keys)) continue;
     try {
       if (new URL(p.api_base).hostname === provider_host) {
         for (const k of p.api_keys) {
           if (typeof k === "string" && k.trim()) {
             configuredKeysForHost.add(k.trim());
           }
         }
       }
     } catch {}
   }
   ```
4. **劃分留存與刪除（Partitioning & Pruning）**：
   ```js
   const recovered = new Set(
     (Array.isArray(validKeys) ? validKeys : [])
       .filter((k) => typeof k === "string")
       .map((k) => k.trim())
       .filter(Boolean),
   );

   const keep = [];
   const dropped = [];

   for (const r of list) {
     // 其他 Host 的記錄完全不動
     if (!r || r.provider_host !== provider_host) {
       keep.push(r);
       continue;
     }

     const key = r.api_key;
     const isRecovered = recovered.has(key);
     const isRemovedFromSettings = !configuredKeysForHost.has(key);

     // 滿足任一條件即自動刪除：測試已通過 OR 使用者已自來源設定移除
     if (isRecovered || isRemovedFromSettings) {
       dropped.push(r);
     } else {
       keep.push(r);
     }
   }
   ```
5. **錯誤詳情再平衡（`rebalanceErrorDetail`）**：
   若有記錄被刪除（`dropped.length > 0`），執行 `rebalanceErrorDetail(dropped, keep)`，將被刪除記錄所持有的 `error_detail` 轉交給同群組留存的記錄。
6. **寫入新失敗記錄**：
   檢查 `invalidRecords` 中的每一筆，若尚未存在於 `keep` 清單中（依 `api_key` 全域查重），則新建記錄放入清單，並套用錯誤詳情去重邏輯。
7. **條件寫入 KV**：
   計算 `removed = dropped.length` 與 `added = 新增筆數`。
   **只有在 `added > 0 || removed > 0` 時才執行 `kv.put("dead_keys", ...)`**。
8. **回傳結果統計**：
   返回 `{ added, removed }` 給主流程。

---

## 四、健全性考量與邊界路徑（Robustness & Safe Paths）

### 4.1 KV 操作配額控制（Audit & Quota Safety）
- **讀取成本（免費 100,000 次/日）**：每次對帳 2 次 `get`（`dead_keys` + `app_settings`）。10 個 Provider 排程一天多 10 次讀取，佔每日免費額度的 0.01%，成本幾近於 0。
- **寫入成本（免費 1,000 次/日）**：只有在名單發生實質變動（`added > 0 || removed > 0`）時才執行 1 次 `put`。穩定排程無變動時 **0 寫入**。

### 4.2 支援「同 Host 多卡片」架構
- 即使有多個 Provider 卡片使用同一個 Gateway Host（例如不同路由或協議），由於判定準則是「比對該 Host 下所有卡片的 Keys 總和」，卡片 A 上傳不會誤刪卡片 B 尚在來源中的失效 Key。

### 4.3 錯誤詳情交棒（`rebalanceErrorDetail` 安全性）
- 系統對同 `provider_host` + 同 `error_code` 的錯誤詳情進行去重（只在第一筆存完整物件，其餘為 `null`）。
- 當使用者在來源設定中刪除持有 `error_detail` 的 Key 時，該 Key 會被 drop。透過 `rebalanceErrorDetail` 自動將詳情指派給同群組內留下的其他失效 Key，確保前端 📋 按鈕內容不丟失。

### 4.4 容錯與非阻塞（Best-effort Isolation）
- `syncDeadKeysFromResults` 在 `handlePostResults` 中被 `try/catch` 包裹。
- 若 `app_settings` 讀取異常，安全回退（不拋出例外），不會導致 `POST /api/results` 回傳 500。

### 4.5 Python 測試端與 Observability 相容性
- `handlePostResults` 回傳格式保持不變：`{ ok: true, fingerprint, dead_keys_added, dead_keys_removed }`。
- Python 測試端日誌自然印出新增與移除筆數，無需修改 Python 端程式碼。

---

## 五、後續決策文件維護
實作完成並驗證通過後，將同步更新 `docs/decision-0816.md` 並重新命名為 `docs/decision-0817.md`（依據 AGENTS.md 規範）。
