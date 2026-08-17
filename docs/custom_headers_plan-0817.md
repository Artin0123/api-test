# 自定義請求頭 (Custom Headers) 功能設計與實現方案

**狀態：已於 2026-08-17 完成實作並合入代碼庫**，實作程式碼位於 `public/app.js`、`public/index.html`、`public/style.css`、`async_test_keys.py`，後續維護與決策依據請參閱 `docs/decision-*.md` §十。

## 1. 需求背景與目標

在「编辑服务商 / 新增服务商」弹窗中新增「**自定义请求头 (Custom Request Headers)**」功能：
- **UI 呈现**：在服务商配置弹窗内提供「+ 添加请求头」按钮，点击后动态新增一行表单项：
  - **左侧字段**：请求头名称（Key / Name，如 `X-Custom-Auth`、`User-Agent`、`HTTP-Referer` 等）。
  - **右侧字段**：对应的变量 / 值（Value / Variable，如自定义 Token、代理特征等）。
  - **最右侧操作**：红色垃圾桶图标删除按钮，点击可立即移除该行。
- **功能效果**：在执行测试（`async_test_keys.py`）向供应商 API 发起 HTTP 请求时，自动带上用户配置的所有自定义请求头。

---

## 2. 架构设计与数据流

```
[前端 UI] (app.js / index.html)
   │
   ├─ 用户点击「+ 添加请求头」→ 动态生成 [名称] [变量/值] [🗑️删除] 行
   ├─ 保存时收集有效请求头列表: [{ key: "...", value: "..." }]
   │
   ▼
[Cloudflare KV (app_settings.providers)]
   │ 存储格式:
   │ provider = {
   │   provider_type: "openai",
   │   api_base: "https://...",
   │   keys: "...",
   │   models: "...",
   │   extra_body: "...",
   │   max_concurrency: 2,
   │   custom_headers: [
   │     { key: "X-My-Header", value: "MyValue" }
   │   ]
   │ }
   │
   ▼
[测试执行端] (async_test_keys.py)
   │
   ├─ GET /api/settings 读取 providers[].custom_headers
   ├─ 在 test_single_request() 构建基础 headers（如 Authorization / x-api-key）
   └─ 合并 custom_headers（支持覆盖或追加）发起 aiohttp 请求
```

---

## 3. 具体修改方案

### 3.1 前端结构：`public/index.html`
在服务商弹窗（`#editor-overlay .modal-body`）中，于 `Extra Body` 与 `Max Concurrency` 之间新增自定义请求头区块：

```html
<div class="field">
    <div class="field-label-row">
        <span class="field-label">
            自定义请求头
            <small class="muted">选填，请求时附加的 HTTP Headers</small>
        </span>
        <button
            id="ed-add-header-btn"
            class="btn btn-secondary btn-xs"
            type="button"
        >
            + 添加请求头
        </button>
    </div>
    <div id="ed-headers-container" class="custom-headers-container">
        <!-- 动态生成自定义请求头行 -->
    </div>
</div>
```

### 3.2 样式设计：`public/style.css`
遵循 CSP（禁止 inline `style=""`）与现存设计系统（Dark / Light Mode、变量色系）：
- `.field-label-row`：水平对齐 Label 与「+ 添加」按钮。
- `.custom-headers-container`：纵向排列各个请求头条目。
- `.custom-header-row`：水平弹性盒，包含两列输入框与删除按钮。
- `.btn-danger-icon`：红色垃圾桶样式（`--fail` 红色图标、Hover 浅红背景微动效、无障碍 aria-label）。
- 响应式处理（移动端自适应排版）。

### 3.3 前端逻辑：`public/app.js`
1. **DOM 绑定**：在 `dom` 对象中增加 `edAddHeaderBtn` 与 `edHeadersContainer`。
2. **行组件生成与销毁**：
   - `createHeaderRow(key = "", value = "")`：生成包含两个 input（Key 与 Value）和删除按钮的 DOM 结构，绑定删除事件。
   - `renderEditorHeaders(headers = [])`：清空容器并根据 Provider 数据渲染现有请求头行。
   - `getEditorHeaders()`：提取并过滤容器内输入，返回 `[{ key, value }, ...]` 数组（剔除 key 为空的无效行）。
3. **弹窗流程串联**：
   - `openEditor(index)`：
     - 若 `index >= 0`，读取 `p.custom_headers` 并渲染；
     - 若 `index < 0`（新增服务商），清空请求头列表。
   - `saveEditor()`：
     - 调用 `getEditorHeaders()` 收集请求头并写入 `entry.custom_headers`；
     - 提交至 `postSettings({ providers })`。
4. **事件委托与监听**：
   - 点击 `edAddHeaderBtn` 新增空白行并自动将焦点置于新行的「名称」输入框。

### 3.4 Python 测试端：`async_test_keys.py`
1. **配置区扩展**：
   - 增加 `CUSTOM_HEADERS = []`（用于本地 fallback 调试）。
2. **主流程与 Provider 解析**：
   - 从 Pages 获取 provider 时读取 `p.get("custom_headers", [])`；
   - 本地 fallback 模式读取 `CUSTOM_HEADERS`；
   - 传递 `custom_headers` 至 `run_provider` → `benchmark_model` → `test_single_request`。
3. **请求头合并**：
   - 在 `test_single_request` 中，生成基础协议头（`Authorization` / `x-goog-api-key` / `x-api-key` / `User-Agent`）后，合并 `custom_headers`，允许用户自定义任意标头或覆盖预设标头。

### 3.5 规范与不变性校验
- **Fingerprint 保持不变**：`providerFingerprint` 依然仅由 `{ api_base, provider_type }` 计算，不受 `custom_headers` 变更影响。
- **CSP 遵守**：无 inline `style=""`，所有图标使用纯 SVG / CSS 类。
- **语法校验**：更新后执行 `npm run check`（`node --check`）。

---

## 4. 验证计划与落实状态

### 4.1 语法与静态检查
- [x] **JS 语法检查**：执行 `npm run check`（`node --check public/_worker.js && node --check public/app.js && node --check public/boot.js`）无报错。
- [x] **Python 语法检查**：执行 `python -m py_compile async_test_keys.py` 编译无报错。

### 4.2 UI 交互验证
- [x] **新增/删除行**：点击「+ 添加请求头」能正确插入两列输入框与红色垃圾桶，点击垃圾桶可单行移除。
- [x] **自动聚焦**：新增行后自动聚焦至新行的「名称」输入框。
- [x] **数据回显与保存**：编辑已有 Provider 时正确加载并回显 `custom_headers`，保存时自动剔除空行。
- [x] **合法性校验**：输入非法标头名称时触发前端错误提示（`请求头名称不合法`）。
- [x] **深浅色模式与 RWD**：图标、边框与按钮适配暗色/亮色主题，移动端（< 640px）自适应换行。

### 4.3 请求与测试执行验证
- [x] **标头注入**：`async_test_keys.py` 的 `test_single_request` 成功在基础协议标头后合并用户配置的 `custom_headers`。
- [x] **CRLF 与名称安全过滤**：`sanitize_custom_headers` 会跳过非法名称并去除 `\r\n`，防止非法标头导致 aiohttp 请求直接抛错。
- [x] **本地/远端双模兼容**：本地开发可使用 `CUSTOM_HEADERS = []`，远端自动从 Pages KV 读取。

---

## 5. 变动文件一览

| 文件 | 变动说明 |
|---|---|
| `public/index.html` | 在 Provider 弹窗内加入「自定义请求头」容器与添加按钮 |
| `public/style.css` | 补充 `.field-label-row`、`.custom-headers-container`、`.custom-header-row`、`.btn.btn-danger-icon` 及 RWD 样式 |
| `public/app.js` | 新增 DOM 元素绑定、RFC 7230 校验正则、行生成与销毁逻辑、编辑回显与保存收集 |
| `public/mock.json` | 补充 `custom_headers` 示例数据用于本地 mock 预览 |
| `async_test_keys.py` | 增加本地配置项、标头清洗函数 `sanitize_custom_headers`，贯穿传参至 `test_single_request` 并覆盖注入 |
| `README.md` | 更新 Provider 配置说明（加入 `Custom Headers` 说明） |
| `docs/custom_headers_plan-0817.md` | 本规划与实施状态文档 |

