# 测试与验收

```bash
npm test          # 78 个测试：test/engine.test.ts（纯计算）+ test/api.test.ts（整个 Worker）
```

集成测试直接呼叫真正的 Worker（Hono 路由、Webhook、重算、Cron），数据库是用 **真实 migration** 建立的 SQLite（`test/d1-shim.ts`，与 D1 一样强制外键、batch 原子执行，并可模拟写入失败）。Telegram API 以假服务器替代。时间以 `vi.setSystemTime` 控制。

## 需求第 14 节 18 项对照

| # | 需求 | 测试 |
|---|---|---|
| 1 | 正常 Clock In / Out | engine「test 1」；api「end-to-end acceptance flow」 |
| 2 | 多次 Break / Resume | engine「test 2」 |
| 3 | 迟到计算 | engine「test 3」（宽限内 0、超 1 秒 = 1 分、20 分 = 15） |
| 4 | 早退计算 | engine「test 4」 |
| 5 | 轮班分配 | api「test 5: rotating shifts」、「default shift assignment generates future instances」、「roster import」 |
| 6 | 跨午夜班次 | engine「test 6」；api「test 6: overnight C shift」 |
| 7 | 排班临时调整 | api「test 7」、「template edits apply to future instances only」 |
| 8 | 缺少 Clock Out | engine「test 8」；api「test 8」（Cron 随时间判定） |
| 9 | 未结束休息 | engine「test 9」；api「test 9」 |
| 10 | 重复 Telegram Update | api「test 10」（重试 + 第二个 Bot） |
| 11 | 错误 Topic | api「test 11 / 12」 |
| 12 | 未登记员工 | api「test 11 / 12」、「inactive employees and migrated topics」 |
| 13 | Webhook Secret 错误 | api「test 13」 |
| 14 | 无效状态转换 | engine「state machine」；api「test 14」 |
| 15 | 时区处理 | engine「time zones」（含夏令时时区） |
| 16 | 管理员修正及审计 | api「admin corrections and audit」（含 Trigger 禁止改写原始资料） |
| 17 | 未授权 API | api「security」（无 Session、只读账号、跨来源、登录锁定、Token 加密） |
| 18 | 重复 Webhook 与写入失败 | api「test 18」、「recompute failure … healed by the cron job」 |

## 重要计算的输入与预期（摘自测试）

| 情境（A 班 07:00–15:00，宽限 5 分） | 输入 | 预期 |
|---|---|---|
| 准时 | IN 06:55、OUT 15:02 | 迟到 0、早退 0、净工时 8h07m |
| 三次休息 | 09:00–09:15、12:00–12:30、14:00–14:10 | 休息 3 次、55 分；净工时 7h05m |
| 迟到 | IN 07:05:00 / 07:05:01 / 07:20 | 0 / 1 / 15 分 |
| 早退 | OUT 14:55 / 14:30 | 0 / 25 分 |
| C 班跨午夜 | IN 22:58、休息 02:00–02:30、OUT 07:03（隔天） | 考勤日 = 开始那天；净工时 7h35m |
| 缺下班卡 | 只有 IN 07:00 | 19:00 前 = 工作中；19:01 后 = 数据不完整 / MISSING_OUT |
| 休息中下班 | IN、BREAK 12:00、OUT 15:00 | 数据不完整、无净工时、休息未结束 |

## 端到端验收流程（已自动化：api「end-to-end acceptance flow」）

员工发送 IN → Webhook 收到 → 验证员工与 Topic → D1 保存事件 → 总览「工作中」= 1 → 发送 BREAK →「休息中」= 1 → RESUME → OUT → 休息 25 分、净工时 7h41m → 考勤明细与报表显示一致；明细抽屉显示 Telegram 时间、接收时间、处理时间。

## 实际执行过的验证（制作时）

- `npm test`：2 个文件、78 个测试全部通过
- `npm run typecheck`、`npm run build`：通过
- `wrangler dev`（真实 workerd + 本地 D1）：migration 套用成功（含 Trigger）；以 `npm run simulate -- --demo` 送入 899 个 Telegram update，全部 HTTP 200，正确分类（重复休息、休息中下班、General、未绑定 Topic、其他货币 Bot）；Cron 端点执行成功；管理员补录（`last_insert_rowid()` 在 D1 batch 内）与跨来源拒绝已验证
- 无头 Chromium：中文 1440px 与英文 390px 下逐页浏览，无前端错误、无水平溢出（Google Fonts 在测试环境被挡，属正常）

## 尚未验证（需要你的环境）

- 真实 Telegram（Bot Token、Privacy Mode、群组）与真实 Cloudflare 生产环境 —— 依 [TELEGRAM_CHECKLIST.md](TELEGRAM_CHECKLIST.md) 第 D 节测试
- XLSX 导入 / 导出在你的浏览器实际开启（写入与读回已在 Node 验证）
- 生产 D1 的查询读取行数：上线一周后到 D1 → Metrics 确认
