# API Test

Cloudflare Pages + KV + GitHub Actions 的 API 测试与 benchmark 工具。

这份 README 只放最常查的入口信息。更完整的实现细节与契约请看 [SPEC.md](./SPEC.md)。

## 这项目做什么

- 管理多个 provider 的测试配置
- 以 `models_list` 手动指定要跑的模型
- 逐 provider 计算 fingerprint，并保存最新 tester / benchmark 结果
- 支援 tester / benchmark 分开跑
- 前端可直接比较同一 provider 下的模型结果

## 系统流程

```text
1. 前端写入 providers_config
2. GitHub Actions 读取 providers_config
3. runner.py 逐 provider 执行 tester / benchmark
4. tester / benchmark 各自写 checkpoint
5. 结果上传到 Pages API
6. 前端从 Pages API 读取最新结果
```

## 目录说明

- `public/_worker.js`：Cloudflare Pages advanced mode API 入口。`_worker.js` 是 Pages 规定的保留档名
- `runner.py`：GitHub Actions 执行脚本
- `public/`：Admin UI 静态档与 Pages 输出目录
- `SPEC.md`：当前系统主规范，包含 API、KV、流程、部署说明

## 快速开始

1. 在 Cloudflare Pages Dashboard 设定 `ADMIN_PASSWORD` 和 `GITHUB_ACTIONS_URL`
2. 在 Cloudflare Pages Dashboard 绑定 `KV_STORE`
3. 在 `providers_config` 写入 provider
4. 在 GitHub Actions secrets 设定 `PAGES_URL` 和 `ADMIN_PASSWORD`
5. 触发 GitHub Actions 跑 `runner.py`

## 需要查看的资料

- 想看当前架构、KV、API、checkpoint、runner 行为，请看 [SPEC.md](./SPEC.md)
- 想看 Pages 迁移目标、命名调整和接下来的执行顺序，请看 [PAGES_MIGRATION_ARCHITECTURE.md](./PAGES_MIGRATION_ARCHITECTURE.md)
