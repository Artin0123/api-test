# API Key Tester

多 Provider、多 Key × 多 Model 并发测试工具。

Cloudflare Pages（存储设定与结果）+ GitHub Actions（定时执行）+ `async_test_keys.py`（测试核心）。

完整规范见 [SPEC.md](./SPEC.md)。

---

## 这个项目做什么

- **管理多个 API 服务商**（支持 OpenAI / Ollama / Gemini 架构的端点）。
- **动态端点后缀**：前端只需填入 API Base URL（如 `https://api.openai.com/v1`），系统在测试时会自动根据 Provider 类型补全正确的路径（如 `/chat/completions`、`/api/chat` 或 Gemini 的专属模型路径）。
- 每个 Provider 独立执行多 Key × 多 Model 矩阵并发测试（**支援随时切换「启用 / 停用」状态来控制要测试的服务商**）。
- 自动判定有效 Key、无效 Key 死因、模型健康状态、性能指标、以及是否具备「思考 (Thinking)」能力。
- 结果存 Cloudflare KV，前端（RWD 手机自适应设计、全屏居中 Modal、自动化清洗多余空白与符号）实时查看。
- 每日定时执行，完成后自动发 Discord 通知（前端支援一键发送测试通知）。

## 系统流程

```
前端设定 providers（keys / models / api_base）
      ↓  POST /api/settings → KV
GitHub Actions 定时触发
      ↓  GET  /api/settings → 读取所有 providers
async_test_keys.py 逐 provider 测试
      ├─ 每 20 个请求 POST /api/checkpoint → KV（前端显示「执行中」进度）
      └─ 最终 POST /api/results  → KV（每个 provider 按 fingerprint 单独存储）
前端展示各 provider 测试结果
      ↓  GET  /api/results?fp=... (结果) & GET /api/checkpoint?fp=... (进度)
```

## 目录

```
public/
  _worker.js     Cloudflare Pages API 网关
  index.html     前端
  style.css      样式
  app.js         前端逻辑
async_test_keys.py   测试核心脚本
.github/
  workflows/
    main.yml     GHA 定时执行 + Discord 通知
SPEC.md          完整系统规范
```

## 快速开始

### 1. 部署 Cloudflare Pages

1. 仓库连接 Cloudflare Pages，输出目录填 `public`
2. Dashboard → Environment Variables → 添加 `ADMIN_PASSWORD`
3. Dashboard → Functions → KV namespace bindings → 绑定名称填 `KV_STORE`

### 2. 配置 GitHub Actions

Repo → Settings → Secrets 添加两个值：
- `PAGES_URL`：Pages 域名，如 `https://xxx.pages.dev`
- `ADMIN_PASSWORD`：与 Pages 一致的同一个密码

### 3. 填入设定

1. 访问 Pages URL，用 `ADMIN_PASSWORD` 登录
2. 来源设定 Tab → 新增 Provider → 填入 `api_base`（只需填到根目录）、Keys（一行一个）、Models（逗号分隔）
   > 系统保存时会自动去除无效的空白、空行或连续逗号。
3. Topbar「设定」→ 填入 GitHub Actions URL（跳转「立即执行」按钮）与 Discord Webhook URL（可按旁边按钮真实发送测试通知）。

### 4. 执行测试

手动触发 GHA workflow，或等待每日定时任务（UTC 02:00）。完成后测试结果 Tab 即可查看。

## 本地运行与 Mock 开发模式

### 本地测试

不设环境变量时，`async_test_keys.py` fallback 读本地文件，并固定使用代码顶部 `API_BASE` 设定的单一家服务商：

```bash
pip install aiohttp
python async_test_keys.py
```

结果写入 `async_test_results.json`，不会上传至 Pages。

### 前端 Mock 模式

前端加入 URL 参数 `?mock` 即可进入离线开发模式（无需登入验证）：

```
http://127.0.0.1:8788/?mock
```
此时前端将不再打 API，而是直接读取 `public/mock.json` 渲染全部设定、进度与测试结果画面，方便开发调整 UI。

## Secrets 一览

| Secret | 存放位置 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | Cloudflare Pages + GHA | API 认证门禁 |
| `PAGES_URL` | GHA only | GHA 启动时必须知道 Pages 地址，才能读 KV — 鸡生蛋问题，无法从 KV 读 |
| Discord Webhook URL | KV（前端设定填入） | 不需要放 Secret |
| GitHub Actions URL | KV（前端设定填入） | 不需要放 Secret |
