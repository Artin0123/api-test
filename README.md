# API Key Tester

多 Provider、多 Key × 多 Model 并发测试工具。

Cloudflare Pages（存储设定与结果）+ GitHub Actions（定时执行）+ `async_test_keys.py`（测试核心）。

架构与数据模型的背景说明见 [docs/SPEC-0813.md](./docs/SPEC-0813.md)（2026-08-13 封存的快照，不含失效密钥相关功能，以代码为准）。选型与取舍的理由见 `docs/decision-*.md`（当前为 [decision-1110.md](./docs/decision-1110.md)）。

<img src="https://i.ibb.co/BVkvnvCW/Pix-Pin-2026-08-18-14-08-57.jpg" alt="Pix Pin 2026 08 18 14 08 57" border="0">

---

## 这个项目做什么

- **管理多个 API 服务商**（支持 OpenAI / Gemini / Anthropic 架构的端点）。
- **动态端点后缀**：前端只需填入 API Base URL（如 `https://api.openai.com/v1`），系统在测试时会自动根据 Provider 类型补全正确的路径（如 `/chat/completions`、`/api/chat` 或 Gemini 的专属模型路径）。
- 每个 Provider 独立执行多 Key × 多 Model 矩阵并发测试（**支援随时切换「启用 / 停用」状态来控制要测试的服务商，并可通过勾选框批量操作**）。
- 自动判定有效 Key、无效 Key 死因、模型健康状态、性能指标、以及是否具备「思考 (Thinking)」能力。
- 结果存 Cloudflare KV（可切换 D1），前端（RWD 手机自适应设计、全屏居中 Modal、自动化清洗多余空白与符号）实时查看。
- **轮询转发**：同一批 Key 可对软件提供转发服务（`/proxy/{别名}/...`），自动轮用、失败换钥、连续失败禁用，状态另存 D1。
- 每日定时执行，完成后自动发 Discord 通知（前端支援一键发送测试通知）。

## 系统流程

```
前端设定 providers（keys / models / api_base）
      ↓  POST /api/settings → KV 或 D1
GitHub Actions 定时触发
      ↓  GET  /api/settings → 读取所有 providers
async_test_keys.py 逐 provider 测试
      ├─ 每 20 个请求 POST /api/checkpoint → KV 或 D1（前端显示「执行中」进度）
      └─ 最终 POST /api/results  → KV 或 D1（每个 provider 按 fingerprint 单独存储）
前端展示各 provider 测试结果
      ↓  GET  /api/results?fp=... (结果) & GET /api/checkpoint?fp=... (进度)

呼叫方（软件）
      ↓  POST /proxy/{别名}/chat/completions
api-test 依 fingerprint 挑一把未禁用、最久没用的 Key
      ↓  换钥重试（最多 3 次）+ 失败计数/禁用
上游 API（或 AI Gateway custom provider）
```

## 目录

```
public/
  _worker.js     Cloudflare Pages API 网关（含转发与 KV/D1 转接层）
  index.html     前端
  style.css      样式
  app.js         前端逻辑
scripts/
  migrate-kv-to-d1.mjs  KV → D1 搬移（先备份、后搬移、再验证）
tests/
  worker.test.mjs       离线回归测试（假 D1/KV + 本机 mock 上游）
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
4. 要使用轮询转发时：Functions → D1 database bindings → 绑定名称填 `DB`，并按下方「存储后端与搬移」设置 `STORAGE_BACKEND`

> **上线顺序是硬性要求。** `STORAGE_BACKEND` 未填时预设 `d1`；已经只用 KV 的站台如果直接部署新版，每个 `/api/*` 请求都会回 500。
> 安全顺序：① 建 D1 并绑定 `DB`（`KV_STORE` 保留）→ ② 设 `STORAGE_BACKEND=kv` 部署本版 → ③ `npm run migrate`（会先备份 KV）→ ④ 改设 `d1`（或移除）再部署。

### 1.1 存储后端与搬移（KV → D1）

`STORAGE_BACKEND` 可填 `d1` 或 `kv`，没填时预设 `d1`；填其他值会在每个 API 请求回 500 并说明原因。

搬移指令会先下载并写入本机备份，才发出写入 D1 的请求；完成后逐笔比对 KV 与 D1 的内容：

```bash
# 先准备好环境变量（或改用 --base-url / --password）
export PAGES_URL=https://你的站台.pages.dev
export ADMIN_PASSWORD=...

npm run migrate                 # 备份 → 搬移 → 验证
npm run migrate -- --dry-run    # 只读取与备份，不写入
npm run migrate -- --restore backups/kv-backup-YYYYMMDD-HHMMSS.json
```

- 备份默认写到 `./backups/`（已 gitignore），档名带时间戳，权限 `0600`。**备份内含明文 Key**，不要上传或提交。
- 回复前会再备份一次当前 D1（`d1-pre-restore-*.json`），所以回复错档也能退回。
- 搬移是幂等的：`store` 与 `key_state` 都用 `DO NOTHING`，重跑不会覆盖搬完后产生的失败计数或禁用状态。
- 真实 KV 的 `list()` 是分页的，指令与伺服端都会跑完所有 `cursor` 页。

### 1.2 轮询转发（选用）

需要的部署设定（Secrets / Variables）：

| 名称 | 用途 |
|---|---|
| `PROXY_PASSWORD` | 给呼叫方软体的转发密码；必须与 `ADMIN_PASSWORD` 不同，未设定时转发功能停用（503） |
| `AI_GATEWAY_ACCOUNT_ID` / `AI_GATEWAY_ID` / `AI_GATEWAY_TOKEN` | 选用：走 Cloudflare AI Gateway 时的帐号、gateway 名称与 API token |
| `AI_GATEWAY_LOGS_URL` | 选用：Gateway 日志页的深连结范本，支援 `{key}` 与 `{provider}` 占位符 |
| `PROXY_FAIL_THRESHOLD` | 选用：连续失败几次后禁用，预设 3 |
| `PROXY_MAX_RETRIES` | 选用：失败后最多换几把 Key（上限 3），预设 3 |
| `PROXY_UPSTREAM_TIMEOUT_MS` | 选用：上游逾时毫秒，预设 120000 |

用法：在来源设定编辑服务商，填「转发别名」（只能小写英文、数字、连字号，全站唯一）。「轮询转发」页上方是
一整排控制项（服务商下拉选单、可用数、转发网址＋复制、范例路径、**测试模型**、测试全部／只测有效／只测无效、
统一的 Gateway 记录按钮），下方每把 Key 一张小卡（遮罩后金钥、状态、连续失败、最近使用、测试／恢复）。
**测试模型是这一页自己的设定**（存在 `app_settings.proxy_test_models`，以指纹为键），不继承来源设定的 Models：
留空时测试按钮停用，填好按「保存模型」才会写进设定。呼叫方把 API 网址填成：

```
https://你的站台.pages.dev/proxy/{别名}
```

路径接在别名之后，且**不要再写一次 `/v1`**：`api_base` 已经带了版本前缀。

| Provider 类型 | 呼叫路径范例 |
|---|---|
| openai | `/chat/completions` |
| gemini | `/models/{model}:streamGenerateContent?alt=sse` |
| anthropic | `/messages` |

转发密码可放在 `Authorization: Bearer`、`x-api-key` 或 `x-goog-api-key`（三种 SDK 风格都接受），带管理密码一律 401。

`AI_GATEWAY_*` 有填、且服务商填了「AI Gateway Provider」slug 时，上游走 AI Gateway；否则直连 `api_base`。直连时不会把任何 Cloudflare 控制标头送出去。

走 AI Gateway 前，先在 Gateway 仪表板把每个服务商登记成 **Custom Provider**：`base_url` 填该服务商的 `api_base`（例如 `https://api.openai.com/v1`），slug 填进来源设定的「AI Gateway Provider」。请求路径会原样接在 `base_url` 后面，因此与直连的路径规则一致。

### 1.3 来源设定的密钥工具

编辑面板的密钥框上方提供：搜索（标出符合的行号，金钥仅显示头尾）、导出 `.txt`（一行一把，可再贴回）、三段排序（原序／A→Z／Z→A，纯 ASCII 比较，储存时不自动排序）。按储存时若金钥数量变少，储存列会就地拉高显示「即将删除 X 支」与遮罩后的清单，确认后才写入。

### 2. 配置 GitHub Actions

Repo → Settings → Secrets 添加两个值：
- `PAGES_URL`：Pages 域名，如 `https://xxx.pages.dev`
- `ADMIN_PASSWORD`：与 Pages 一致的同一个密码

### 3. 填入设定

1. 访问 Pages URL，用 `ADMIN_PASSWORD` 登录（登录后浏览器持有一个 30 天有效的 HttpOnly session cookie，密码本身不会存进浏览器）
2. 来源设定 Tab → 新增 Provider → 填入 `api_base`（**填到版本前缀**，例如 `https://api.openai.com/v1`；只需去掉端点尾巴 `/chat/completions` 这类部分）、Keys（一行一个，**至少要保留一把**，要停用请用卡片的 `enabled`）、Models（逗号分隔）
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

`npm run dev` 起 `wrangler pages dev`，并用 `--binding STORAGE_BACKEND=kv` 维持 KV 模式（`STORAGE_BACKEND` 没填时预设是 `d1`，本机没有 `DB` 会每个 API 请求都 500）。要本机试转发，改用：

```bash
npm run dev:d1          # 本机 D1（--d1=DB=local-dev-db），首次会自动建表
```

要能登录，repo 根目录得有一个 `.dev.vars`（已 gitignore）：

```
ADMIN_PASSWORD=随便一个本地密码
PROXY_PASSWORD=另一个本地密码   # 只在试 npm run dev:d1 的转发时需要
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
| `ADMIN_PASSWORD` | Cloudflare Pages + GHA | 管理门禁，同时是 session cookie 的签章密钥 |
| `PROXY_PASSWORD` | Cloudflare Pages | 转发门禁，必须与 `ADMIN_PASSWORD` 不同 |
| `AI_GATEWAY_TOKEN` | Cloudflare Pages | 选用，AI Gateway 的 API token（只留在部署设定，呼叫方拿不到） |
| `PAGES_URL` | GHA only | GHA 启动时必须知道 Pages 地址，才能读 KV — 鸡生蛋问题，无法从 KV 读 |
| Discord Webhook URL | KV/D1（前端设定填入） | 不需要放 Secret |
| GitHub Actions URL | KV/D1（前端设定填入） | 不需要放 Secret |

## 测试与检查

```bash
npm run check   # node --check，语法检查（没有 linter/type checker）
npm test        # 离线回归：假 D1/KV + 本机 mock 上游，不会打真 Key
```
