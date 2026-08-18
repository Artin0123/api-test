# API Key Tester

多 Provider、多 Key × 多 Model 并发测试工具。

Cloudflare Pages（存储设定与结果）+ GitHub Actions（定时执行）+ `async_test_keys.py`（测试核心）。

架构与数据模型的背景说明见 [docs/SPEC-0813.md](./docs/SPEC-0813.md)（2026-08-13 封存的快照，不含失效密钥相关功能，以代码为准）。选型与取舍的理由见 [docs/decision-0816.md](./docs/decision-0816.md)。

<img src="https://i.ibb.co/BVkvnvCW/Pix-Pin-2026-08-18-14-08-57.jpg" alt="Pix Pin 2026 08 18 14 08 57" border="0">

---

## 这个项目做什么

- **管理多个 API 服务商**（支持 OpenAI / Ollama / Gemini / Anthropic 架构的端点）。
- **动态端点后缀**：前端只需填入 API Base URL（如 `https://api.openai.com/v1`），系统在测试时会自动根据 Provider 类型补全正确的路径（如 `/chat/completions`、`/api/chat` 或 Gemini 的专属模型路径）。
- 每个 Provider 独立执行多 Key × 多 Model 矩阵并发测试（**支援随时切换「启用 / 停用」状态来控制要测试的服务商，并可通过勾选框批量操作**）。
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
docs/            规划、决策与已封存的规范快照
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

1. 访问 Pages URL，用 `ADMIN_PASSWORD` 登录（登录后浏览器持有一个 30 天有效的 HttpOnly session cookie，密码本身不会存进浏览器）
2. 来源设定 Tab → 新增 Provider → 填入 `api_base`（只需填到根目录）、Keys（一行一个）、Models（逗号分隔）
   > 系统保存时会自动去除无效的空白、空行或连续逗号。
   >
   > 可选填 `Extra Body`（JSON，用于注入特殊参数如 `{"enable_thinking": true}`）、`Custom Headers`（请求时附加的 HTTP Headers，同名会覆盖预设标头）和 `Max Concurrency`（覆盖该 provider 的并发数，留空使用全局默认值 2）。
3. Topbar「设定」→ 填入 GitHub Actions URL（跳转「立即执行」按钮）与 Discord Webhook URL（可按旁边按钮真实发送测试通知）。
   > 「测试」按钮是从浏览器直接送出的，受 CSP 的 `connect-src` 限制，目前只放行 `discord.com` 与 `discordapp.com`。webhook 若架在其他网域，要在 `_worker.js` 的 `CSP` 里加上该网域，否则测试会被挡（GHA 的定时通知走伺服器端，不受影响）。

### 4. 执行测试

手动触发 GHA workflow，或等待每日定时任务（UTC 02:00）。完成后测试结果 Tab 即可查看。

## 认证

所有 `/api/` 端点都需要认证，没有例外。接受两种凭证：

| 凭证 | 使用者 | 取得方式 |
|---|---|---|
| `Authorization: Bearer <ADMIN_PASSWORD>` | `async_test_keys.py`、GHA workflow | 直接带 header |
| `atk_session` cookie | 浏览器 | `POST /api/login` 带 `{"password": "..."}`；`POST /api/logout` 清除 |

- 有效期 30 天。cookie 是 `HttpOnly; Secure; SameSite=Strict; Path=/api`，密码本身不进浏览器储存。
- 换掉 `ADMIN_PASSWORD` 或 `_worker.js` 里的 `SESSION_VERSION`，已发出的 cookie 全部立即失效；单一 cookie 无法个别撤销。

### 在浏览器直接查看 API

登录后在网址列打开 `https://你的域名/api/results?fp=...` 即可看到 JSON。从别的站点连结过来不会带 cookie（`SameSite=Strict`），那种情况会看到 401，在网址列重新整理一次即可。

fingerprint 可以在浏览器 Console 算：

```js
// 键必须按字母序，api_base 结尾的斜线要先去掉
const p = { api_base: "https://api.example.com/v1", provider_type: "openai" };
crypto.subtle
  .digest("SHA-256", new TextEncoder().encode(JSON.stringify(p)))
  .then((b) => console.log([...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("")));
```

## 本地运行与 Mock 开发模式

### 本地测试

不设环境变量时，`async_test_keys.py` fallback 读本地文件，并固定使用代码顶部配置区设定的单一服务商（`API_BASE` / `PROVIDER_TYPE` / `EXTRA_BODY_JSON`）：

```bash
pip install aiohttp
python async_test_keys.py
```

结果写入 `async_test_results.json`，不会上传至 Pages。

### 本地起 Pages（含 API）

`npm run dev` 起 `wrangler pages dev`。要能登录，repo 根目录得有一个 `.dev.vars`（已 gitignore）：

```
ADMIN_PASSWORD=随便一个本地密码
```

session cookie 带 `Secure`，但浏览器把 `localhost` / `127.0.0.1` 视为安全来源，本地走 HTTP 也收得到。

### 前端 Mock 模式

前端加入 URL 参数 `?mock` 即可进入离线开发模式（无需登入验证）：

```
http://127.0.0.1:8788/?mock
```
此时前端将不再打 API，而是直接读取 `public/mock.json` 渲染全部设定、进度与测试结果画面，方便开发调整 UI。

## Secrets 一览

| Secret | 存放位置 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | Cloudflare Pages + GHA | API 认证门禁，同时是 session cookie 的签章密钥 |
| `PAGES_URL` | GHA only | GHA 启动时必须知道 Pages 地址，才能读 KV — 鸡生蛋问题，无法从 KV 读 |
| Discord Webhook URL | KV（前端设定填入） | 不需要放 Secret |
| GitHub Actions URL | KV（前端设定填入） | 不需要放 Secret |
