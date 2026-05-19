# API Test Spec

这是一份当前系统的主规范，描述现在的 Pages 架构、资料模型、API、runner 流程、前端行为和部署方式。

## 1. 架构

```text
[Cloudflare Pages]
  public/ static assets       -> GET /, /style.css, /app.js
  public/_worker.js           -> Pages advanced mode API entry
  GET /api/env                -> GITHUB_ACTIONS_URL
  GET /api/config             -> providers_config
  POST /api/config            -> providers_config
  GET /api/checkpoint         -> stage-specific checkpoint
  POST /api/checkpoint        -> stage-specific checkpoint
  DELETE /api/checkpoint      -> stage-specific checkpoint
  POST /api/results           -> latest_tester:{provider_fingerprint}
                                latest_benchmark:{provider_fingerprint}
  GET /api/results            -> per-provider latest tester / benchmark

[GitHub Actions Runner]
  1) GET /api/config?full=1
  2) 逐 provider 计算 provider_fingerprint
  3) tester / benchmark 分开跑
  4) 各自写 checkpoint
  5) 每个 provider 单独上传结果
```

## 2. Provider Config

`providers_config.providers[]` 当前格式：

```json
{
  "provider_type": "openai",
  "mode": "thinking",
  "api_base": "https://api.openai.com/v1",
  "api_key": "sk-xxx",
  "tester_enabled": true,
  "benchmark_enabled": true,
  "models_list": ["gpt-4o", "gpt-4.1"]
}
```

规则：
- `provider_type` 只允许 `openai | ollama | gemini`
- `mode` 只允许 `thinking | vision`
- `models_list` 是唯一模型清单输入
- 后端会对 `models_list` 做 trim、去空、去重、排序、长度限制
- `models_endpoint` 已移除
- `endpoint_path` 已移除，endpoint 由 `provider_type` 固定补齐

## 3. Fingerprint

`provider_fingerprint` 只由以下字段计算：
- `provider_type`
- `mode`
- `api_base`

不包含：
- `api_key`
- `tester_enabled`
- `benchmark_enabled`
- `models_list`

这样 models 清单变动不会制造新的 fingerprint。

## 4. KV 设计

当前只保留这些 key：
- `providers_config`
- `tester_checkpoint:{provider_fingerprint}`
- `benchmark_checkpoint:{provider_fingerprint}`
- `latest_tester:{provider_fingerprint}`
- `latest_benchmark:{provider_fingerprint}`

## 5. Checkpoint

checkpoint 已改成分 stage：
- `tester_checkpoint:{fp}`
- `benchmark_checkpoint:{fp}`

checkpoint 内会保存：
- 已完成的模型
- 已完成的部分结果 items

目的：
- 中断后可以无损续跑
- 不是只保存“跑到哪里了”

## 6. Runner 行为

### 6.1 tester

- 只跑 `tester_enabled=true` 的 provider
- 每 3 个模型写一次 checkpoint
- checkpoint 里会同时保存已完成 items

### 6.2 benchmark

- 只对 `benchmark_enabled=true` 的 provider 跑 benchmark
- 若该 provider 本次没有 tester 结果，但 benchmark 需要历史 tester，就读取 `latest_tester:{provider_fingerprint}`
- benchmark checkpoint 也会保存部分结果

### 6.3 上传

- 每个 provider 单独 `POST /api/results`
- 成功后删除对应 stage checkpoint

## 7. API 契约

### 公开

| Endpoint | 说明 |
| :-- | :-- |
| `GET /api/env` | 回传 `{ github_actions_url }` |
| `GET /api/results?fingerprint=...` | 读取单个 provider fingerprint 的最新 tester / benchmark |

### 管理

| Endpoint | 说明 |
| :-- | :-- |
| `GET /api/config` | 读取 `providers_config`，默认 masked `api_key` |
| `GET /api/config?full=1` | 仅在有效 token 下回传完整 `api_key` |
| `POST /api/config` | 写入 `providers_config` |
| `GET /api/checkpoint?stage=tester|benchmark&fingerprint=...` | 读取对应 stage checkpoint |
| `POST /api/checkpoint?stage=tester|benchmark&fingerprint=...` | 写入对应 stage checkpoint |
| `DELETE /api/checkpoint?stage=tester|benchmark&fingerprint=...` | 删除对应 stage checkpoint |
| `POST /api/results` | 上传单个 provider 的 tester / benchmark 结果 |

## 8. 安全与验证

- 管理 API 一律要求 `Authorization: Bearer <ADMIN_PASSWORD>`
- `POST /api/results` 只接受当前 `providers_config` 中存在的 provider
- `models_list` 只接受 array，且每个元素都要是有效字串
- `GET /api/config` 默认遮罩 `api_key`

## 9. 前端

### Config 页

- 用 `models_list` 输入框手动维护模型清单
- 输入会正规化成 `a, b, c`
- 提交时送出 `string[]`

### Results 页

- 先读 `providers_config`
- 再逐 provider 读取 `GET /api/results?fingerprint=...`
- 结果用对齐表格显示
- 详情用独立 drawer / overlay 显示，不改变行高

## 10. 部署

### Cloudflare Pages Dashboard

- `ADMIN_PASSWORD`
- `GITHUB_ACTIONS_URL`
- `KV_STORE`：手动绑定 KV namespace，沿用现有 namespace 即可，清空 KV 后重跑

`public/_worker.js` 是 Cloudflare Pages advanced mode 规定的入口档名。非 `/api/*` 请求会 fallback 到 Pages 静态资源服务。

本项目不使用 `wrangler.toml` 管理 Pages 环境变量与 KV 绑定；这些设定以 Dashboard 为准。

### GitHub Actions

- `PAGES_URL`
- `ADMIN_PASSWORD`

### 流程

1. 清空旧 KV 或改用新 namespace
2. 部署 Cloudflare Pages 项目
3. 写入新的 `providers_config`
4. 重跑 tester / benchmark
