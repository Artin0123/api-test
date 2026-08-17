# 失效密鑰狀態自動更新計畫（二段式群組同步方案）

**文件日期**：2026-08-18  
**狀態**：已實作（二段式群組同步；`public/_worker.js` 的 `syncDeadKeysFromResults`）  
**目標**：在不影響失效時間（`expired_at`）與建檔時間（`created_at`）的前提下，精確同步最新測試的錯誤碼（`error_code`）與錯誤訊息（`error_detail`），並解決 Python 端去重 holder 與 KV 既有 holder 不一致的邊界問題。

---

## 一、背景與關鍵技術挑戰

### 1.1 現有問題
在 `POST /api/results` 自動對帳（`syncDeadKeysFromResults`）中：
- 既有邏輯以 `if (known.has(api_key)) continue;` 整筆跳過所有已在清單中的 Key。
- 當某支 Key 先前因餘額不足（`402`）被記錄，後續測試變更為無效授權（`401`）時，錯誤碼與訊息會永遠停留在最初的 402。

### 1.2 為什麼不能「逐筆比對 `rec.error_detail`」？（核心陷阱）
Python 測試腳本在產生 `invalid_records` 時，同一個 `(error_code, 正規化訊息)` **只有第一筆**帶有 `error_detail` 物件，其餘兄弟 Key 均為 `null`（見 `async_test_keys.py:971-976`）。

這導致 Python 端選出的 holder 與 KV 中既有的 holder **經常不是同一支 Key**：
1. **若將 `rec.error_detail === null` 視為「訊息變更」**：當既有 holder 在新一輪測試中排在第二位，其 `rec.error_detail` 為 `null`，若直接覆寫會導致整組的 📋 錯誤詳情被清空。
2. **若將 `null` 視為「無新訊息」而跳過**：當新一輪測試的錯誤訊息確實改變，但新訊息帶在非 holder 的 Key 上，若僅比對既有 holder，會導致新訊息永遠無法更新進來。
3. **多筆同時跨狀態碼移轉**：若多筆 Key 同時從 402 轉為 401，若未在移出當下即時交棒，同組其他留在 402 的 Key 可能會被清空訊息或接到錯誤的 detail。

---

## 二、目標不變量（System Invariants）

1. **元數據不可變**：`id`（UUID）、`expired_at`（最初判定失效日期）、`created_at`（初次建檔時刻）維持原值不變。
2. **嚴格去重保證**：同 `provider_host` + 同 `error_code` 全域**僅保留一份** `error_detail`（由該組唯一 holder 持有，其餘一律為 `null`）。
3. **空值不沖刷（Null Safety）**：若新一輪測試未能抓取到 body（例如超時或網路錯誤），不得沖掉既有 holder 的 📋 內容。
4. **零變動 0 寫入**：當狀態碼與錯誤訊息內容均無實質變化時，`updated = 0` 且不觸發 `kv.put`。
5. **作用域隔離**：僅處理屬於當前 `provider_host` 的 `keep` 記錄，絕對不修改其他 Host 的資料。

---

## 三、二段式對帳演算法設計 (Two-Stage Reconciliation)

為徹底解耦「單筆狀態碼遷移」與「群組層級錯誤訊息同步」，對帳流程改為二段式處理：

```
                ┌────────────────────────────────────────────────────────┐
                │             POST /api/results 傳入 invalid_records      │
                └───────────────────────────┬────────────────────────────┘
                                            │
                                            ▼
                ┌────────────────────────────────────────────────────────┐
                │ 準備：提取 newGroupDetails Map: code -> freshDetail      │
                │       (優先取 error_detail，fallback 至 error_reason)    │
                └───────────────────────────┬────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 第一階段：逐筆同步 error_code (Per-Key Status Code Migration)                              │
│ - 比對 keep 中屬於本 Host 的記錄                                                         │
│ - 若 error_code 發生變更 (如 402 -> 401):                                                │
│     1. 即時交棒：若原為舊組 holder，立即將舊 detail 交棒給原組留存的任一兄弟                │
│     2. 更新 code: r.error_code = newCode; r.error_detail = null; (待第二階段賦值)        │
│     3. 標記 codeChanged = true                                                          │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 第二階段：群組層級 detail 刷新 (Group-Level Detail Refresh)                              │
│ - 針對本 Host 下的每個 error_code 群組:                                                  │
│     1. 鎖定當前唯一 holder (既有持著者 or 群組首筆)，其餘兄弟強制設為 null                   │
│     2. 若 newGroupDetails 有新 detail:                                                  │
│        - 以有序鍵值比對 areErrorDetailsEqual(holder.error_detail, freshDetail)           │
│        - 內容不同則更新 holder.error_detail = freshDetail 並標記 detailChanged = true    │
│     3. 若 newGroupDetails 無 detail: 保留 holder.error_detail 現狀不覆寫                  │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 第三階段：處理真正新增的 Key (New Dead Keys Insertion)                                    │
│ - 未在 known 中的失敗 Key 寫入 listNext (added++)                                        │
│ - 若該群組已有 holder 則設為 null，否則賦予 detail 作為該組新 holder                       │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │
                                            ▼
                ┌────────────────────────────────────────────────────────┐
                │ 判斷：if (added || removed || updated) await kv.put()  │
                └────────────────────────────────────────────────────────┘
```

---

## 四、詳細實作規格與輔助函式

### 4.1 輔助函式定義

#### 1. 深度鍵值排序比較：`areErrorDetailsEqual(a, b)`
避免因 JSON 鍵值插入順序不同產生虛假更新：
```javascript
function areErrorDetailsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (k !== keysB[i]) return false;
    if (String(a[k]) !== String(b[k])) return false;
  }
  return true;
}
```

#### 2. 提取單筆錯誤詳情（含 fallback）：`extractRecordDetail(rec)`
```javascript
function extractRecordDetail(rec) {
  if (!rec) return null;
  const detail = normalizeErrorDetail(rec.error_detail);
  if (detail) return detail;
  if (rec.error_reason) {
    return { message: String(rec.error_reason) };
  }
  return null;
}
```

### 4.2 `syncDeadKeysFromResults` 核心演算法

```javascript
async function syncDeadKeysFromResults(kv, api_base, validKeys, invalidRecords, uploadedAt) {
  // ... [既有前置邏輯：解析 provider_host, 讀取 KV, 收集 configuredKeysForHost, 產生 dropped 與 keep, 執行 rebalanceErrorDetail(dropped, keep)] ...

  const invList = Array.isArray(invalidRecords) ? invalidRecords : [];
  const invMap = new Map();
  const newGroupDetails = new Map(); // Map<normalized_code, error_detail>

  for (const rec of invList) {
    if (!rec || typeof rec.api_key !== "string" || !rec.api_key.trim()) continue;
    const key = rec.api_key.trim();
    invMap.set(key, rec);

    const code = normalizeErrorCode(rec.error_code);
    if (!newGroupDetails.has(code)) {
      const d = extractRecordDetail(rec);
      if (d) newGroupDetails.set(code, d);
    }
  }

  let codeUpdates = 0;
  let detailUpdates = 0;

  // ─── 第一階段：逐筆同步 error_code 與即時舊組交棒 ───────────────────────
  for (let i = 0; i < keep.length; i++) {
    const r = keep[i];
    if (!r || r.provider_host !== provider_host) continue;

    const newRec = invMap.get(r.api_key);
    if (!newRec) continue; // 可能是同 host 其他卡片未在本次測試的 Key

    const prevCode = normalizeErrorCode(r.error_code);
    const nextCode = normalizeErrorCode(newRec.error_code);

    if (prevCode !== nextCode) {
      // 舊群組交棒：若自身持有 detail，交棒給舊群組內的第一個無 detail 兄弟
      if (r.error_detail) {
        const heir = keep.find(
          (other, oi) =>
            oi !== i &&
            other &&
            other.provider_host === provider_host &&
            normalizeErrorCode(other.error_code) === prevCode &&
            !other.error_detail,
        );
        if (heir) heir.error_detail = r.error_detail;
      }
      r.error_code = nextCode;
      r.error_detail = null; // 清空，待第二階段由群組統一指派
      codeUpdates++;
    }
  }

  // ─── 第二階段：群組層級 detail 刷新與唯一 holder 規範 ─────────────────
  // 找出本 host 目前涉及的所有 error_code
  const hostCodes = new Set(
    keep
      .filter((r) => r && r.provider_host === provider_host)
      .map((r) => normalizeErrorCode(r.error_code)),
  );

  for (const code of hostCodes) {
    const siblings = keep.filter(
      (r) => r && r.provider_host === provider_host && normalizeErrorCode(r.error_code) === code,
    );
    if (!siblings.length) continue;

    // 確定當前唯一 holder：優先取既有持著者，若無則取首筆
    let holder = siblings.find((s) => s.error_detail) || siblings[0];

    // 確保其餘兄弟 detail 一律為 null (去重不變量)
    for (const s of siblings) {
      if (s !== holder && s.error_detail) {
        s.error_detail = null;
      }
    }

    // 若本次測試有該 code 的新 detail，進行比對與刷新
    if (newGroupDetails.has(code)) {
      const fresh = newGroupDetails.get(code);
      if (!areErrorDetailsEqual(holder.error_detail, fresh)) {
        holder.error_detail = fresh;
        detailUpdates++;
      }
    }
  }

  // ─── 第三階段：新增新失敗 Key ─────────────────────────────────────────
  const listNext = keep;
  const known = new Set(listNext.map((r) => r && r.api_key));
  let added = 0;
  const expired_at = `${String(uploadedAt).slice(0, 10)}T00:00:00.000Z`;

  for (const rec of invList) {
    if (!rec || typeof rec.api_key !== "string" || !rec.api_key.trim()) continue;
    const api_key = rec.api_key.trim();
    if (known.has(api_key)) continue;
    if (settingsAvailable && !configuredKeysForHost.has(api_key)) continue;

    const error_code = normalizeErrorCode(rec.error_code);
    const hasHolder = listNext.some(
      (r) => r && r.error_detail && sameDedupGroup(r, { provider_host, error_code }),
    );

    let error_detail = null;
    if (!hasHolder) {
      error_detail = newGroupDetails.get(error_code) || extractRecordDetail(rec);
    }

    listNext.push({
      id: crypto.randomUUID(),
      provider_host,
      api_key,
      expired_at,
      error_code,
      error_detail,
      created_at: uploadedAt,
    });
    known.add(api_key);
    added++;
  }

  const updated = codeUpdates + detailUpdates;
  const removed = dropped.length;

  if (added || removed || updated) {
    await kv.put(DEAD_KEYS_KEY, JSON.stringify(listNext));
  }

  return { added, removed, updated };
}
```

---

## 五、改動檔案與影響清單

### 1. `public/_worker.js`
- 替換 `syncDeadKeysFromResults` 為上述二段式對帳。
- 在 `handlePostResults` 回應中回傳 `dead_keys_updated: synced.updated`。

### 2. `async_test_keys.py`
- 修改上傳結果日誌打印（約 line 1050-1055）：
  ```python
  added = resp.get("dead_keys_added", 0)
  removed = resp.get("dead_keys_removed", 0)
  updated = resp.get("dead_keys_updated", 0)
  if added or removed or updated:
      parts = []
      if added: parts.append(f"新增 {added} 支")
      if removed: parts.append(f"移除 {removed} 支（本轮已恢复）")
      if updated: parts.append(f"更新状态 {updated} 笔")
      print(f"[Pages] 上传成功。失效 Key 清单：{'、'.join(parts)}。")
  else:
      print("[Pages] 上传成功。")
  ```

### 3. `docs/decision-MMDD.md`
- 將相關改動與 Holder 去重不一致架構決策寫入決策文件，並重命名為更新日期檔名。

---

## 六、測試驗證矩陣（Verification Matrix）

| 測試場景 | 前置狀態 (KV) | 本次測試輸入 (Python) | 預期結果 |
|---|---|---|---|
| **1. 狀態碼轉移 (402 $\rightarrow$ 401)** | Key A (402, holder)<br/>Key B (402, null) | Key A 報 401<br/>Key B 報 402 | - Key B 成為 402 的 holder (接收舊 402 detail)<br/>- Key A 轉為 401，`error_code` 改為 401<br/>- `expired_at` 與 `created_at` 不變<br/>- `updated = 1` |
| **2. Holder 不一致 (Python ≠ KV)** | Key A (401, holder)<br/>Key B (401, null) | Key A: detail=null<br/>Key B: detail={msg:"新401"} | - Key A 仍為 holder，但其 `error_detail` 更新為 `{msg:"新401"}`<br/>- Key B 保持 `error_detail: null`<br/>- 📋 查看正常，未被清空<br/>- `updated = 1` |
| **3. 新測試無 Body (Null Safety)** | Key A (401, holder) | Key A 報 401 (無 body/reason) | - Key A 的 `error_detail` 保持原樣不變<br/>- `updated = 0`，觸發 0 寫入 |
| **4. 零變動 0 寫入** | Key A (401, msg:"error") | Key A 報 401, msg:"error" | - `added=0, removed=0, updated=0`<br/>- 不觸發 `kv.put` |
| **5. 他 Host 資料隔離** | Host X: Key 1 (402)<br/>Host Y: Key 2 (402) | 上傳 Host X (401) | - 僅 Host X 變更為 401<br/>- Host Y 完全不受影響維持 402 |
