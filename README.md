# API Key Tester

多 Provider、多 Key × 多 Model 并发测试与轮询转发工具。

Cloudflare Pages（管理界面、API 与转发网关）+ GitHub Actions（每日定时测试）+ `async_test_keys.py`（并发测试脚本）。

完整项目架构与整体流程见 [docs/architecture.md](./docs/architecture.md)；架构背景见 [docs/SPEC-0813.md](./docs/SPEC-0813.md)（2026-08-13 历史快照）；设计决策、取舍与实作注意事项见 `docs/decision-*.md`；扩展需求与资料表规划见 [docs/api-test-擴充需求計畫書.md](./docs/api-test-擴充需求計畫書.md)。

<img src="https://i.ibb.co/BVkvnvCW/Pix-Pin-2026-08-18-14-08-57.jpg" alt="Pix Pin 2026 08 18 14 08 57" border="0">

---

## 核心功能

- **多服务商管理**：支持 OpenAI / Gemini / Anthropic 架构端点，支持启用 / 停用切换与批量勾选。
- **动态端点后缀**：只需填写至版本前缀的 `api_base`（例如 `https://api.openai.com/v1`），测试时依 Provider 类型自动补全端点路径。
- **并发矩阵检测**：独立执行多 Key × 多 Model 测试，判定有效密钥、失败原因、模型健康度、性能指标与思考（Thinking）能力。
- **轮询转发**：通过 `/proxy/{别名}/...` 对外提供转发服务，自动轮用最久未使用的密钥、失败时换密钥重试、连续失败达上限自动禁用（需启用 D1）。
- **定时巡检与通知**：每日定时执行测试并将结果存至 Cloudflare KV 或 D1，完成后自动发送 Discord 通知。

## 系统流程

```text
前端设定 providers（keys / models / api_base / alias）与「设定」（代理密码 / Gateway / 排程网址）
      ↓  POST /api/settings → KV 或 D1（D1 模式以 db.batch() 原子同步 key_state）
GitHub Actions 定时或手动触发
      ├─ POST /api/run-status → 标记全局执行中（结束或 if: always() 清除，90 分钟自动过期）
      ├─ GET  /api/settings   → 读取所有启用中 providers
      └─ async_test_keys.py 逐一非流式并发测试每个 provider
            └─ POST /api/results → 按 fingerprint 保存报告、fp 对账 dead_keys 并恢复有效密钥
前端展示各 provider 测试结果（GET /api/results?fp=... ＋ GET /api/run-status）

调用方软件
      ↓  POST /proxy/{别名}/chat/completions
api-test 按 fingerprint 挑选一把未禁用且最久未使用的 Key
      ↓  非 2xx 失败换密钥重试（最多 3 次）＋ 失败计数／达上限禁用
Cloudflare AI Gateway（custom-{别名}）→ 上游 API
```

## 目录结构

```text
public/
  _worker.js     Cloudflare Pages 网关（API、轮询转发与 KV/D1 转接层）
                 ⚠ 生成文件，不入库：部署时由 Pages 的 build command（npm run build）
                   从 src/*.js 拼接生成；本地由 npm run dev / test 的前置步骤自动生成
                 ⚠ Cloudflare Pages 進階模式規定 _worker.js 必須是單一可執行檔，勿直接編輯
  index.html     前端页面
  404.html       未匹配靜態路徑的錯誤頁（Pages 以 HTTP 404 提供，取代 SPA fallback）
  style.css      页面样式（基础段；样式另拆为 style-forms/modals/deadkeys/proxy/rwd.css，
                 由 index.html 依序加载）
  app.js         前端逻辑入口（事件绑定与启动；其余逻辑拆分于 public/js/*.js，
                 由 index.html 依序加载，均为共享全局作用域的普通脚本）
  js/            前端逻辑分段（mock / state / settings / providers / proxy / results /
                 dead-keys 等，载入顺序必须与拆分前一致）
src/             _worker.js 的源码分段（entry / storage / auth / settings / dead-keys /
                 proxy / proxy-handlers / storage-migrate 等，拼接顺序由
                 scripts/build-worker.mjs 固定）
scripts/
  build-worker.mjs      将 src/*.js 拼接回 public/_worker.js
  check-syntax.mjs      对所有 JS 文件做 node --check
  migrate-kv-to-d1.mjs  KV → D1 迁移与备份恢复工具
tests/                  离线回归测试套件（模拟 KV/D1 与本地 mock 上游）
async_test_keys.py      每日批量并发检测脚本
.github/workflows/      GitHub Actions 定时工作流
docs/                   规范快照、扩展计划与决策记录
```

> **修改 Worker 程式码**：一律编辑 `src/*.js`；`npm run check`、`npm run dev`、
> `npm run dev:d1` 与 `npm test` 都会先自动拼接生成 `public/_worker.js`
> （该生成档已加入 `.gitignore`，不入库），部署时由 Pages 的 build command 完成。

## 快速开始

### 1. 部署 Cloudflare Pages

1. 将仓库连接至 Cloudflare Pages：**Build command 填 `npm run build`**，构建输出目录填 `public`（Pages 会先 `npm install` 再执行 build，把 `src/*.js` 拼接成部署用的 `public/_worker.js`；拼接脚本只依赖 Node 内建模块，任何默认构建环境皆可执行）。
2. Dashboard → Environment Variables → 添加 `ADMIN_PASSWORD`。
3. Dashboard → Functions → 绑定存储后端（二选一）：
   - **D1 模式（默认，支持轮询转发）**：D1 database bindings → 绑定名称填 `DB`（`STORAGE_BACKEND` 留空或设为 `d1`）。
   - **KV 模式（仅每日测试，隐藏轮询转发）**：KV namespace bindings → 绑定名称填 `KV_STORE`，并设置环境变量 `STORAGE_BACKEND=kv`。

### 1.1 存储后端说明（D1 / KV）

`STORAGE_BACKEND` 可设为 `d1`（默认）或 `kv`；填写其他值或未绑定对应的 `DB` / `KV_STORE` 时，`/api/*` 请求会直接返回 500 提示错误原因。

若需备份、还原或跨账号／跨平台搬移数据，可直接使用本项目 `devDependencies` 已附带的 `wrangler`（执行 `npm install` 后即可使用，首次需 `npx wrangler login` 或配置 `CLOUDFLARE_API_TOKEN`）：

- **D1 备份与还原／跨平台搬移**：可在 Cloudflare Dashboard 使用 **Time Travel** 回溯时间点，或通过 CLI 导出与还原（导出为标准 SQLite `.sql`，亦可直接 `sqlite3 local.db < backup.sql` 导入其他 SQLite 平台；若包含 `_cf_KV` 等系统表，在外部平台执行前删去相关语句、保留 `store` 与 `key_state` 即可）：
  ```bash
  # 导出
  npx wrangler d1 export <DB名称> --remote --output=backup.sql
  # 导入／还原
  npx wrangler d1 execute <目标DB名称> --remote --file=backup.sql
  ```
- **KV 查看、单笔导出与批次导入**：Dashboard 支持单笔查看与修改；Wrangler 无单行整库导出指令，导出需先列出键名再逐笔读取，整包导入则使用 `bulk put`：
  ```bash
  # 列出键名与单笔导出
  npx wrangler kv key list --namespace-id=<KV_ID> --remote
  npx wrangler kv key get "<KEY>" --namespace-id=<KV_ID> --remote --text
  # 整包批次导入（JSON 数组格式：[{"key":"...","value":"..."}]）
  npx wrangler kv bulk put kv-backup.json --namespace-id=<KV_ID> --remote
  ```

### 1.2 轮询转发与 Cloudflare AI Gateway

转发功能**强制经由 Cloudflare AI Gateway**，外部调用参数与 Gateway 配置**全部在网页右上角「设定」中保存**，无需额外配置 Cloudflare 环境变量：

| 网页「设定」栏位 | 用途 |
|---|---|
| `代理转发密码` | 外部客户端调用 `/proxy/{别名}` 的认证密码；须与 `ADMIN_PASSWORD` 不同 |
| `AI Gateway Logs URL` | 从 Cloudflare Dashboard 复制日志页网址（`https://dash.cloudflare.com/{account_id}/ai/ai-gateway/gateways/{gateway_id}/logs`），系统自动解析双 ID |
| `AI Gateway Token` | 存取 Cloudflare AI Gateway 的认证 Token（`cf-aig-authorization`） |
| `失败禁用门槛` | 连续失败几次后禁用密钥，默认为 3 |
| `最多重试次数` | 失败后最多换几把密钥重试（上限 3），默认为 3 |
| `上游超时 (ms)` | 等待上游响应标头的超时毫秒数（1000～600000），默认为 120000 |

使用步骤：

1. **配置 Cloudflare AI Gateway Custom Provider**：在 Cloudflare AI Gateway 仪表板的 **Provider Keys**（繁中界面侧栏为「供應商金鑰」、页面标题为「提供者金鑰」，路径 `https://dash.cloudflare.com/{account_id}/ai/ai-gateway/gateways/{gateway_id}/integrations`）页面下，将每个要转发的服务商登记为 **Custom Provider**（无需在 Gateway 填写 Key），`base_url` 填该服务商的 `api_base`，并将 Custom Provider 的 **`slug` 设成与下方「转发别名」相同的名称**。
2. **配置转发别名**：在「来源设定」编辑服务商并填写「转发别名」（仅限小写英文字母、数字与连字号，全站不可重复；同一 `provider_type + api_base` 不可重复建卡）。设置后卡片标题显示别名；未设别名的服务商不会显示在「轮询转发」清单中，也无法转发或手动测试。只要已设别名，即使在「来源设定」停用该服务商（仅跳过每日自动测试），仍可正常使用「轮询转发」与 `/proxy/{别名}`。
3. **管理与即时测试（「轮询转发」分页）**：
   - 工具列可切换服务商（显示为「别名 - API 格式」）、用网址右侧复制按钮复制转发网址、查看「密钥状态」独立绿/红半透明胶囊（每家服务商上限共 999 支密钥，悬停显示有效/无效数量）、从下拉选单（读取自来源设定的 Models）选择探测模型，以及执行「测试有效密钥」／「测试无效密钥」／「恢复所有密钥」（恢复所有密钥不额外弹出提示）。
   - 仅当按下单卡或批量的测试按钮时，所选测试模型才会实际写入 `proxy_test_models`（仅切换下拉选单不写库，且重复测试同一模型不重复写入）；调整来源设定的 Models 清单时，只要原模型仍在清单中就不会被自动替换。
   - 页首右侧提供「Gateway 记录 ↗」按钮；下方每把密钥一张卡片（每页最多 9 把，超过时右下角显示 `<`／页码输入框（支持滚轮）／`>` 分页控件），可查看状态、连续失败次数与最近使用时间，并执行单把「测试」（非流式探测 `"only reply 1."`，失败会计数并可能禁用，**成功会立即归零失败次数并解除禁用**）、手动「禁用」（弹出确认框，不另跳 Toast）或「恢复」。测试中与测试结果会以右上角 Toast 显示（最多同时 3 个结果 Toast，成功 5 秒／失败或超时 20 秒自动淡出，也可手动关闭）。
4. **接入调用端**：将客户端软件的 API 网址设为 `https://<站点域名>.pages.dev/proxy/{别名}`，并在后面接上接口路径（**不要重复加上 `/v1`**，`api_base` 已包含版本前缀）：

| Provider 类型 | 调用路径示例 |
|---|---|
| openai | `/chat/completions` |
| gemini | `/models/{model}:streamGenerateContent?alt=sse` |
| anthropic | `/messages` |

转发密码支持通过 `Authorization: Bearer`、`x-api-key` 或 `x-goog-api-key` 传递；携带 `ADMIN_PASSWORD` 一律返回 401。

> 必须已在网页「设定」填好 `代理转发密码`、`AI Gateway Logs URL` 与 `AI Gateway Token`（且 `STORAGE_BACKEND=d1`），`/proxy/*` 与「轮询转发」手动测试按钮才会启用，否则回传 503 提示所缺配置（不提供无日志直连退回）。

### 1.3 来源设定的密钥工具

编辑服务商弹窗的密钥框上方提供四项辅助操作：

- **搜索高亮**：输入关键字时在框内标出所有符合片段（不区分大小写）；搜索框留空时改标出在密钥框内反白选取的片段。
- **导出 `.txt`**：导出清理空白后的密钥文件（每行一把，可直接贴回）。
- **三段排序**：循环切换「默认顺序 → ASCII 递增 → ASCII 递减」，保存时不会自动重排。
- **删除确认**：保存时若密钥数量减少，操作区会展开待删除数量与遮罩清单，确认后才会写入。

### 2. 配置 GitHub Actions 与填写设定

1. 在仓库 Settings → Secrets 添加 `PAGES_URL`（如 `https://xxx.pages.dev`）与 `ADMIN_PASSWORD`。
2. 登录网页后，在「来源设定」添加 Provider：填入 `api_base`（填到版本前缀即可，例如 `https://api.openai.com/v1`）、Keys（每行一把，至少保留一把）与 Models（英文逗号分隔；系统保存时会自动清理多余空白与空行）。可选填 `Extra Body`、`Custom Headers`（同名覆盖默认标头）与 `Max Concurrency`。
3. 点击顶部栏「设定」填入 GitHub Actions URL（设定后启用「测试结果」右上角「立即执行 ↗」按钮）、Discord Webhook URL（浏览器端测试通知受 CSP `connect-src` 限制仅放行 `discord.com` 与 `discordapp.com`，使用自架代理域名需同步更新 `_worker.js`），以及 AI Gateway 与转发参数。
4. 在「测试结果」点击「立即执行 ↗」手动触发 GitHub Actions workflow，或等待每日定时任务（UTC 00:00）完成（执行期间全局标题旁显示 `⏳ 执行中`）；完成后至「测试结果」与「失效密钥」查看自动汇总与对账结果。

## 认证与环境变量一览

所有 `/api/*` 端点均须认证，支持 `Authorization: Bearer <ADMIN_PASSWORD>`（供脚本与 GHA 使用）或登录后签发的 30 天 HttpOnly `atk_session` cookie（`SameSite=Strict; Path=/api`）。更换 `ADMIN_PASSWORD` 或调升 `_worker.js` 中的 `SESSION_VERSION` 会使所有已签发 cookie 失效。

> 登录后直接在地址栏访问 `https://<站点域名>/api/results?fp=...` 可查看原始 JSON；若从外部页面跳转过来被拦截 401，刷新页面即可。

| Secret / 配置项 | 存放位置 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | Cloudflare Pages + GHA | 管理门禁密码与 session cookie 签章密钥 |
| `STORAGE_BACKEND` | Cloudflare Pages | `d1`（默认）或 `kv` |
| `DB` / `KV_STORE` | Cloudflare Pages 绑定 | D1 数据库绑定（默认）与 KV 命名空间绑定 |
| `PAGES_URL` | 仅 GitHub Actions | GHA 启动与结束时请求站点读写设定、状态与结果 |
| 转发密码 / Gateway / Webhook / GHA URL | D1 或 KV（前端「设定」填入） | 无需配置为 Cloudflare 环境变量 |

## 本地开发与测试

```bash
# 1. 本地运行单服务商检测（不上传 Pages，结果写至 async_test_results.json；Ctrl+C 可保存 checkpoint.json 续跑）
pip install aiohttp && python async_test_keys.py

# 2. 本地启动 Pages（KV 模式）或带本地 D1 调试轮询转发
npm run dev       # 默认绑定 STORAGE_BACKEND=kv
npm run dev:d1    # 本地 D1（需在根目录 .dev.vars 配置 ADMIN_PASSWORD；转发密码与 Gateway 在前端「设定」中填写）

# 3. 离线开发 UI（免登录，读取 public/mock.json）
# 浏览器打开 http://127.0.0.1:8788/?mock

# 4. 语法检查与离线回归测试（使用模拟 KV/D1 与本地 mock 上游，不请求真实密钥）
#    check 会先执行 npm run build 将 src/*.js 拼接回 public/_worker.js
npm run check
npm test
```
