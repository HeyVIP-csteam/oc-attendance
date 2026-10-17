# TG Attendance — Telegram 考勤管理系统

员工在 Telegram 超级群组（Forum Topics）里自己的 Topic 发送 `IN / BREAK / RESUME / OUT`，系统自动记录考勤、计算迟到、早退、休息和净工时，管理员在网页后台查看、修正和导出。

- **后端**：Cloudflare Workers（Hono + Zod），Telegram Webhook，一个 Cron（每 15 分钟）
- **数据库**：Cloudflare D1（SQLite），版本化 SQL Migration
- **前端**：React + TypeScript（Vite），界面按已确认的 preview 制作，中文 / English
- **部署**：一个 Worker 同时提供 `/api/*` 和静态网页；GitHub + Cloudflare Workers Builds（或 GitHub Actions）

> 时间一律以 **斯里兰卡时间（Asia/Colombo）** 显示，数据库内以 UTC 毫秒保存。
> 打卡时间 = Telegram 的 `message.date`；员工自己打的时间（例如 `IN 08:30`）不会被采用。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | **从零部署到 Cloudflare 的完整步骤**（你需要亲自执行的命令） |
| [docs/TELEGRAM_CHECKLIST.md](docs/TELEGRAM_CHECKLIST.md) | Bot、Privacy Mode、群组权限、上线前验证清单 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、数据流、数据表分类、状态机、计算公式、时间可信度说明、免费额度设计 |
| [docs/TESTING.md](docs/TESTING.md) | 自动化测试清单（18 项需求对照）与端到端验收流程 |

## 本地开发（5 分钟）

```bash
npm install
npm run setup:local                 # 生成 .dev.vars（本地专用 ENCRYPTION_KEY，不会提交）
npm run db:migrate:local            # 建立本地 D1
npm run admin:create -- --local     # 建立管理员（密码以隐藏方式输入）
npm run db:seed:demo:local          # （可选）40 名示范员工 + 本月 A/B/C 排班
npm run dev                         # 构建网页并启动 http://127.0.0.1:8787
npm run simulate -- --demo          # （可选）另开终端：模拟最近 7 天的 Telegram 打卡
```

前端热更新：一个终端 `npm run dev:api`，另一个终端 `npm run dev:web`，打开 http://localhost:5173 。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm test` | 运行全部自动化测试（Vitest；用真实 migration 建立的 SQLite） |
| `npm run typecheck` | Worker + 网页 TypeScript 检查 |
| `npm run build` | 构建网页到 `web/dist` |
| `npm run db:migrate:remote` | 对生产 D1 套用**尚未执行**的 migration（不会清空资料） |
| `npm run admin:create -- --remote` | 建立 / 重设生产管理员 |
| `npm run deploy` | 构建并部署 |
| `npm run logs` | 查看线上实时日志（`wrangler tail`） |

## 项目结构

```
migrations/            D1 版本化 migration（0001 结构、0002 默认设置）
src/shared/            Worker 与网页共用：时间工具、关键词解析、状态机与计算、代码表
src/worker/            Cloudflare Worker
  index.ts             入口：路由、错误处理、cron
  cron.ts              每 15 分钟：缺卡/未出勤检测、自我修复、按默认班次生成排班
  lib/                 ingest(Webhook 处理)、sessions(归属与重算)、roster、auth、crypto、telegram …
  routes/              auth、webhook、attendance、employees、shifts、exceptions、settings
web/                   React 管理后台（Vite）
test/                  单元测试 + 集成测试（D1 适配器 test/d1-shim.ts）
scripts/               create-admin、setup-local、demo-seed（本地）、simulate（本地）
.github/workflows/     ci.yml（测试）、deploy.yml（可选，手动部署）
```

## 安全重点

- 机密只放 Cloudflare Secrets：`ENCRYPTION_KEY`（必填）、`TELEGRAM_BOT_TOKEN_<货币>`（可选）。仓库里没有任何真实 Token / 密码。
- 在后台输入的 Bot Token 以 AES-256-GCM 加密存入 D1，永远不会回传到浏览器；Audit Log 只记录 `••••末4位`。
- 每个 Bot 的 Webhook `secret_token` 由 `ENCRYPTION_KEY` 推导，不存数据库；错误的 secret 一律 401。
- 管理员密码 PBKDF2-SHA256（100,000 次）；连续 5 次失败锁定 15 分钟；Session 存 HttpOnly + SameSite=Strict Cookie，数据库只存 SHA-256。
- 原始消息、考勤事件、修正记录、Audit Log 由数据库 Trigger 保护，不能被改写或删除。
- 只读账号（role = viewer）只能查看。
