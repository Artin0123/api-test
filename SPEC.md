# API Key Tester — SPEC

当前系统规范。描述架构、数据模型、API 契约、KV 设计、脚本行为、前端交互和部署流程。

---

## 1. 总体架构

```
[GitHub Actions]  (定时 / 手动触发)
  │
  ├─ 1. GET  /api/settings          ← 从 KV 读取所有 providers 设定
  ├─ 2. 逐 provider 计算 fingerprint，跑 async_test_keys.py 核心逻辑
  ├─ 3. POST /api/results           ← 每个 provider 单独上传结果（覆盖旧值）
  └─ 4. POST Discord Webhook        ← 可选，webhook URL 从 settings 读取

[Cloudflare Pages]  (_worker.js)
  ├─ GET  /api/settings                   ← 读 KV app_settings，需认证
  ├─ POST /api/settings                   ← 写 KV app_settings，需认证
  ├─ GET  /api/results?fp={fingerprint}   ← 读 results:{fp}，公开
  ├─ POST /api/results                    ← 写 results:{fp}，需认证
  ├─ GET  /api/checkpoint?fp={fp}         ← 读 checkpoint:{fp}，需认证
  └─ /*                                   ← 静态前端

[前端]  (index.html / app.js)
  ├─ 来源设定 Tab（首页）
  │   └─ 各 provider 卡片（新增 / 编辑 / 删除）
  └─ 测试结果 Tab
      └─ 各 provider 折叠区块
          ├─ Checkpoint 进度摘要（若正在执行中）
          ├─ 有效 Key（复制）
          ├─ 有效模型（复制）
          ├─ 模型性能列表
          ├─ 无效 Key（按死因分组折叠）
          └─ 失效模型列表
```

---

## 2. 多 Provider 设计

### 2.1 什么是 Provider

一个 Provider 代表**一个 API 服务商节点**，由以下两个字段唯一确定：

- `provider_type`：`openai` | `ollama` | `gemini`
- `api_base`：API 根地址（如 `https://api.openai.com/v1`）

> 旧系统的 `mode`（thinking / vision）字段已移除，视觉模式不再支援。

### 2.2 Provider 数据结构

```json
{
  "provider_type": "openai",
  "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "keys": "sk-aaa\nsk-bbb\nsk-ccc",
  "models": "qwen-max,qwen-plus,qwen-turbo"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider_type` | string | `openai` / `ollama` / `gemini` |
| `api_base` | string | API 根地址，trailing slash 会被 trim |
| `keys` | string | 多个 API Key，**换行分隔**，原始字符串存储，由脚本 `splitlines()` 拆分 |
| `models` | string | 多个模型名，**逗号分隔**，原始字符串存储，由脚本 `split(",")` 拆分 |

`keys` 和 `models` 均以字符串原样存储，后端不做 split / validate，解析逻辑在脚本里。前端 textarea 的值直接存入、读出后直接填回，零转换。

### 2.3 Provider Fingerprint

```
fingerprint = SHA-256( JSON.stringify({ api_base, provider_type })  // key 按字母排序
```

**只依赖 `provider_type` + `api_base`**，不含 `keys` / `models`，确保 keys 或 models 变动不会产生新 fingerprint，旧结果仍可被正确覆盖。

Fingerprint 是系统内部路由用的标识符，**不在任何 JSON 内容中存储，也不在前端展示**。前端识别 provider 用 `api_base` 主域名 + `provider_type`。

---

## 3. KV 键位设计

| KV key | 内容 | 说明 |
|---|---|---|
| `app_settings` | `app_settings` 对象（见第 4 节） | 前端写，GHA 读 |
| `results:{fingerprint}` | 单 provider 最新测试结果（见第 5 节） | GHA 写，前端读 |
| `checkpoint:{fingerprint}` | 单 provider 进行中 checkpoint（见第 6 节） | GHA 读写，前端只读摘要 |

`ADMIN_PASSWORD` 留在 Cloudflare Secrets（门禁，不可存 KV 自举）。

`PAGES_URL` 留在 GHA Secrets（鸡生蛋：读 KV 之前必须知道 KV 所在的 Pages URL）。`pages_url` 字段从 `app_settings` 中移除，因为 GHA 已经通过 Secret 知道，前端也知道自己的域名（`window.location.origin`），不需要再从 KV 读。

---

## 4. `app_settings` 结构

```json
{
  "providers": [
    {
      "provider_type": "openai",
      "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "keys": "sk-aaa\nsk-bbb",
      "models": "qwen-max,qwen-plus"
    },
    {
      "provider_type": "gemini",
      "api_base": "https://generativelanguage.googleapis.com/v1beta",
      "keys": "AIza-xxx",
      "models": "gemini-2.5-pro,gemini-2.0-flash"
    }
  ],
  "github_url": "https://github.com/owner/repo/actions/workflows/main.yml",
  "discord_webhook_url": "https://discord.com/api/webhooks/..."
}
```

`POST /api/settings` 全量替换整个对象。`providers[]` 顺序由前端维护，后端不排序。

---

## 5. 测试结果结构（KV key: `results:{fingerprint}`）

`async_test_keys.py` 完成一个 provider 测试后 POST 上传，由 worker 写入 `results:{fingerprint}`。

```json
{
  "provider_type": "openai",
  "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "uploaded_at": "2026-05-20T02:15:00Z",
  "elapsed_seconds": 183.4,
  "valid_keys": ["sk-aaa", "sk-bbb"],
  "invalid_records": [
    {
      "api_key": "sk-ccc",
      "error_reason": "Key 专属硬伤 (Hard Failure - 401)",
      "failed_models_details": null
    }
  ],
  "proven_working_models": ["qwen-max", "qwen-plus"],
  "failed_models": ["qwen-turbo"],
  "model_performance": {
    "qwen-max": {
      "sample_count": 2,
      "thinking_only_count": 0,
      "content_ever_seen": true,
      "has_thinking_ratio": 1.0,
      "avg_ttft": 1.234,
      "avg_total": 8.567,
      "timeout_count": 0,
      "total_tested": 2,
      "timeout_rate": 0.0,
      "sample": { "thinking": "...", "content": "..." }
    }
  }
}
```

注意：
- JSON 内容中**不存储 fingerprint**，fingerprint 已体现在 KV key 名称中
- `provider_type` 和 `api_base` 必须保留，前端展示时需要用来匹配对应 provider
- 每次上传**覆盖**旧值，始终只保留最新一次结果

---

## 6. Checkpoint 结构（KV key: `checkpoint:{fingerprint}`）

脚本执行中途每 N 个任务写一次，用于中断后续跑。续跑完成并成功上传结果后删除。

```json
{
  "provider_type": "openai",
  "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "saved_at": "2026-05-20T02:10:33Z",
  "total_tasks": 150,
  "completed_tasks": 87,
  "dead_keys": ["sk-ccc", "sk-ddd"],
  "results": {
    "sk-aaa": [
      {
        "model": "qwen-max",
        "success": true,
        "status": 200,
        "avg_ttft": 1.2,
        "avg_total": 8.5,
        "has_thinking": true,
        "has_content": true,
        "sample_content": "...",
        "sample_thinking": "..."
      }
    ]
  }
}
```

注意：
- JSON 内容中**不存储 fingerprint**，fingerprint 已体现在 KV key 名称中
- `dead_keys` 是完整列表（续跑时需要恢复为 `set`）
- `results` 是完整半成品 dict（续跑时恢复，跑完后直接用来生成最终报告，不是"接在一起"而是**本来就是同一份**）
- 前端只读 `provider_type` / `api_base` / `saved_at` / `total_tasks` / `completed_tasks` / `dead_keys`（取 `.length`）显示进度摘要，不展示 `results` 内容

前端 Checkpoint 摘要显示示例：

```
dashscope.aliyuncs.com  [openai]  ⏳ 执行中
进度：87 / 150 任务
已判死 Key：2 个
最后存档：02:10:33
```

---

## 7. API 契约

### 公开端点（无需认证）

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/api/results?fp={fingerprint}` | 读取单 provider 最新结果 |

返回：
```json
{ "exists": true, "results": { /* 第5节结构 */ } }
// 或
{ "exists": false }
```

### 管理端点（需 `Authorization: Bearer <ADMIN_PASSWORD>`）

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/api/settings` | 读取完整 app_settings（含明文 keys） |
| `POST` | `/api/settings` | 全量写入 app_settings |
| `POST` | `/api/results` | GHA 上传单 provider 结果，body 须含 `provider_type` + `api_base` 以计算 fingerprint |
| `GET` | `/api/checkpoint?fp={fingerprint}` | 读取单 provider checkpoint 摘要（前端用） |

`POST /api/results` 处理逻辑：
1. 从 body 的 `provider_type` + `api_base` 计算 fingerprint
2. 写入 `results:{fingerprint}`

---

## 8. `async_test_keys.py` 行为

### 8.1 本地模式（不设 `PAGES_URL` 环境变量）

- 从本地文件读 keys / models（配置区 `INPUT_FILE_PATH` / `MODELS_FILE_PATH`）
- Checkpoint 写本地 `checkpoint_{fingerprint}.json`
- 结果写本地 `async_test_results.json`，不上传

### 8.2 GHA 模式（设有 `PAGES_URL` + `ADMIN_PASSWORD`）

```
1. GET /api/settings
2. 对 providers[] 逐个：
   a. 计算 fingerprint
   b. GET /api/checkpoint?fp=... 尝试恢复进度
   c. 执行多 Key × 多 Model 矩阵测试
      - Checkpoint 每 N 任务写一次（POST KV 或本地文件，两种模式统一处理）
   d. 完成后 POST /api/results
   e. 删除 checkpoint（DEL /api/checkpoint?fp=...，或删本地文件）
3. 所有 provider 跑完后通知 Discord（由 GHA workflow YAML 负责）
```

GHA log 中所有涉及 API Key 的输出均使用 `masked = f"{key[:6]}...{key[-4:]}"` 格式，明文 key 不出现在日志里。

### 8.3 核心测试逻辑摘要（不因多 provider 改变）

- 多 Key × 多 Model → asyncio 并发队列（`MAX_CONCURRENCY = 32`）
- 流式优先 15s → 失败回退非流式 20s
- 429 / 408 触发一次重试（+2s 等待，惩罚时间叠加）
- 401 / 403 → Key 熔断，跳过剩余模型
- 交叉验证：`proven_working_models` 决定软失效判断

---

## 9. 前端行为

### 9.1 来源设定 Tab（首页，默认 Tab）

- 展示所有 provider 卡片，每张卡片显示：
  - `provider_type` badge
  - `api_base` 主域名（截取，过长加省略号）
  - Key 数量（行数统计）、Model 数量（逗号分隔计数）
- **新增 / 编辑**弹出 modal：
  - `provider_type`：下拉选择
  - `api_base`：文字输入
  - `API Keys`：多行 textarea（纵向滚动，一行一个）
  - `Models`：单行 / 横向滚动 textarea（逗号分隔）
- **删除**：卡片删除按钮
- 所有变动 → `POST /api/settings`（全量提交整个 `providers[]`）
- 登录后展示完整明文 key（无需掩码，因为已认证）

### 9.2 测试结果 Tab

- 从 `GET /api/settings` 取 providers 列表
- 对每个 provider 计算 fingerprint，并发调用：
  - `GET /api/results?fp=...`
  - `GET /api/checkpoint?fp=...`
- 每个 provider 显示一个**可折叠区块**，header 显示主域名 + `provider_type`
- 若 checkpoint 存在，在区块顶部显示进度摘要（`completed/total`、死 key 数、最后存档时间）
- 区块展开内容（来自 results）：
  - **有效 Key**：只读 textarea（一行一个，明文）+ 一键复制
  - **有效模型**：只读 textarea（逗号分隔，横向滚动）+ 一键复制
  - **模型性能列表**：表格，每行一个模型，含 sample 弹窗按钮
  - **无效 Key**：按 `error_reason` 分组折叠，含 `failed_models_details`
  - **失效模型**：逗号分隔纯文本

### 9.3 应用设定（topbar modal）

- GitHub Actions URL（「立即执行」按钮跳转目标）
- Discord Webhook URL（已填显示「已接入」badge）
- `pages_url` 字段已移除（GHA 从 Secret 读，前端从 `window.location.origin` 得到）
- 变动 → `POST /api/settings`（merge 更新，不覆盖 providers）

### 9.4 深浅色模式

- topbar 提供切换开关（🌙 / ☀️ 图标）
- 状态优先读 `localStorage`，初始 fallback `prefers-color-scheme`
- CSS 通过 `data-theme="dark" / "light"` 切换

### 9.5 Mock 数据（开发用）

前端 `app.js` 顶部提供 `DEV_MOCK = false` 开关。设为 `true` 时，`loadResults()` 返回硬编码的 mock 数据而不发网络请求，用于快速验证 UI 渲染。

---

## 10. 前端 UI 规范

- **字体**：正文 16px，辅助文字 14px，代码 / key 使用等宽字体，最小不低于 13px
- **间距**：区块间 `gap: 1.5rem`，表单字段间 `gap: 1rem`，label 与 input 间 `gap: 0.5rem`
- **认证卡**：居中卡片，输入框与按钮同行，圆角 border，focus ring 明显
- **过长文字**：非关键区块（api_base 主域名展示、模型名列表等）超长时用 `text-overflow: ellipsis` 截断，不让布局撑破
- **RWD**：断点 `640px`，列布局在手机端改为单列，modal 宽度 `min(90vw, 520px)`
- **上下排版**：表单 label 在上、input 在下，不做 label-inline 布局

---

## 11. GitHub Actions Workflow

GHA Secrets（仅需两个）：
- `PAGES_URL`：Pages 域名（如 `https://xxx.pages.dev`）
- `ADMIN_PASSWORD`：与 Cloudflare Pages 一致

Discord 通知由 GHA workflow YAML 的独立 step 负责，从 `GET /api/settings` 读取 `discord_webhook_url` 后 POST。消息中的 Pages 链接直接用 `$PAGES_URL`（来自 Secret），不需要从 KV 读。

---

## 12. 部署流程

### Cloudflare Pages

1. Pages 项目输出目录：`public`
2. Environment Variables → `ADMIN_PASSWORD`
3. Functions → KV namespace bindings → 变量名 `KV_STORE`

### GitHub Actions

Repo Secrets：`PAGES_URL`、`ADMIN_PASSWORD`

### 首次完整验证顺序

```
1. 部署 Pages
2. 前端登录 → 来源设定 → 添加至少一个 provider（填 keys + models）
3. Topbar 设定 → 填 GitHub Actions URL（可选 Discord Webhook）
4. GitHub Actions 手动触发
5. 测试结果 Tab → 确认结果已上传
```

---

## 13. 不在范围内的内容

- 视觉模式（vision）：已移除
- Tester / Benchmark 分离：已合并为单次执行
- `runner.py`：已废弃
- `wrangler.toml`：不使用
- `pages_url` KV 字段：已移除（GHA 用 Secret，前端用 `window.location.origin`）
- Fingerprint 在任何 JSON 内容中存储或前端展示：不做
