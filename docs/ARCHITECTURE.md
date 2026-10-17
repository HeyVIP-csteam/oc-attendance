# 架构说明

## 1. 数据流

```
员工在自己的 Topic 发 IN / BREAK / RESUME / OUT
  → Telegram Bot（每个货币一个）→ Webhook POST /api/telegram/webhook/<货币>
  → Worker：验证 secret_token → 去重（update_id / chat_id+message_id）→ Chat 允许名单
  → 身份：只用 (chat_id, message_thread_id) 在「消息时间」有效的 Topic 绑定
  → 关键词解析（只接受完全匹配）
  → D1：原始消息 + 考勤事件（同一个原子 batch）
  → 归属考勤日 → 状态机 + 计算 → 写入 sessions / breaks / exceptions
  → Bot 在 Topic 回复确认（非同步，失败不影响资料）
  → React 后台从受保护的 /api 读取
Cron 每 15 分钟：缺卡 / 未出勤 / 休息未结束、自我修复、按默认班次生成未来 14 天排班
```

**为什么一个 Worker**：API 与网页同源（Cookie 用 SameSite=Strict，不需要 CORS），一次部署、一个网址。网页是静态资源（免费、不计请求、不跑 Worker），只有 `/api/*` 执行 Worker（`run_worker_first`）。

## 2. 资料分类（migrations/0001_init.sql）

| 类别 | 表 | 规则 |
|---|---|---|
| 原始资料（不可改写） | `telegram_messages`、`attendance_events`（Telegram 来源） | 内容、时间由 Trigger 禁止 UPDATE / DELETE；只有处理状态可更新 |
| 管理员修正（只增不改） | `attendance_adjustments`、`audit_logs` | 补录 = 新增 ADMIN 事件；作废 = 标记事件 `is_voided` 并保留原事件；都写 Audit |
| 主资料（可编辑，有审计） | `employees`、`telegram_topic_mappings`、`shift_templates`、`employee_shift_assignments`、`shift_instances`、`currencies`、`telegram_bots`、`system_settings` | 每次修改写 Audit Log；Topic 绑定以有效期保存历史 |
| 计算结果（随时可重建） | `attendance_sessions`、`break_sessions`、`attendance_exceptions`(COMPUTED) | 只由程序从事件 + 修正 + 班次实例重算；异常的「处理状态」可由管理员编辑 |

需求中的 `departments` 依你的确认改为 `currencies`（货币），并且每个货币一个 Bot。员工识别依你的确认**只用 Topic**（不使用 Telegram User ID），User ID 仍存在原始消息中供稽核。

## 3. 排班

- `shift_templates`：A 07:00–15:00、B 15:00–23:00、C 23:00–07:00（Asia/Colombo），迟到 / 早退宽限、休息总时间（预设 60 分钟）
- `shift_instances`：每位员工每天一笔实际班次，**把开始/结束时间、宽限、休息上限快照下来**。之后修改模板只更新「明天以后」的实例，过去的考勤结果不会被悄悄改变
- 来源：`ROSTER_IMPORT`（导入）、`MANUAL`（逐格修改）、`ASSIGNMENT`（员工的默认班次，由 Cron 生成未来 14 天）；`adjustment_status` 记录 SCHEDULED / ADJUSTED / MANUAL / CANCELLED；每次修改写 Audit（含原因）
- 跨午夜：结束 ≤ 开始 视为隔天结束；C 班的考勤日 = 开始那一天（斯里兰卡 23:00 = 当天）

## 4. 考勤日归属（src/worker/lib/sessions.ts → chooseWorkDate）

1. BREAK / RESUME / OUT：若该员工有 20 小时内开始、尚未结束的考勤，归到那一天
2. 否则：找「排班开始前 W 小时 ～ 结束后 W 小时」（W = 班次匹配窗口，预设 4）内的班次，取开始时间最近的
3. 否则：斯里兰卡日历日（未排班打卡，会标记 UNSCHEDULED_PUNCH）

排班修改后，系统会对受影响日期重新归属并重算。

## 5. 状态机与计算（src/shared/engine.ts，纯函数，有测试）

```
NOT_STARTED --IN--> WORKING --BREAK--> ON_BREAK --RESUME--> WORKING --OUT--> COMPLETED
```

不合法的转换不会被丢弃，而是记录在事件上并产生异常：重复 IN、未 IN 就 BREAK、未 BREAK 就 RESUME、休息中 OUT、OUT 后再打卡、未 IN 就 OUT、重复 BREAK、重复 OUT。

| 项目 | 公式 |
|---|---|
| 迟到分钟 | max(0, ⌈(实际上班 − 排班开始 − 迟到宽限) / 1 分钟⌉) |
| 早退分钟 | max(0, ⌊(排班结束 − 早退宽限 − 实际下班) / 1 分钟⌋) |
| 单次休息 | 结束 − 开始（限制在上班～下班之间） |
| 休息总计 | 已结束休息之和（每次只算一次） |
| 班次总时长 | 实际下班 − 实际上班 |
| 净工时 | 班次总时长 − 休息总计（**只有完整且没有未结束休息时才显示**） |

状态：准时 / 迟到 / 早退 / 迟到+早退 / 工作中 / 休息中 / 数据不完整 / 缺勤 / 未打卡 / 未开始 / 未排班。
随时间变化的判定（固定值）：开始后 2 小时仍未打卡 → 缺勤；结束后 4 小时仍未 OUT → 缺少下班卡；休息超过 120 分钟未 RESUME → 休息未结束；接收比 Telegram 时间晚 5 分钟以上 → 消息延迟送达。

## 6. 时间

- 保存：UTC 毫秒；显示与计算考勤日：`Asia/Colombo`（用 Intl 明确指定时区，不依赖 Worker 预设时区；也支持有夏令时的时区）
- 每笔打卡保存三个时间：Telegram 消息时间（`telegram_message_ts`，用于计算）、Worker 接收时间（`received_at`）、处理完成时间（`processed_at`）；另有排班开始/结束时间
- 员工文字中的时间一律不采用；编辑过的消息不改变原事件，只产生 EDITED_MESSAGE 异常

## 7. 幂等与失败处理

| 情况 | 处理 |
|---|---|
| Telegram 重试同一 update | `UNIQUE(bot_id, update_id)` → 200 DUPLICATE |
| 同一消息送到两个 Bot | `UNIQUE(chat_id, message_id)`（原始消息）+ 依员工货币分派 |
| 原始消息 / 事件写入失败 | 两者在同一个 batch，失败全部回滚，回 500 → Telegram 稍后重试 |
| 写入成功但重算失败 | Cron 找出「事件比计算新」的考勤日自动重算 |
| 乱序到达 | 一律按 Telegram 时间排序重算，并标记 OUT_OF_ORDER |

## 8. Cloudflare 免费 / 付费额度设计

| 设计 | 目的 |
|---|---|
| 静态网页由 Assets 提供 | 不计 Worker 请求 |
| 网页轮询 `/api/version`（读 1 行），只在页面可见且 10 分钟内有操作时每 60 秒一次，有变化才重新读取 | 省请求与 D1 读取 |
| General 的普通聊天不写入 D1 | 省写入 |
| 所有查询有索引；报表在 SQL 汇总；分页用 LIMIT | 省读取行数 |
| append-only 表的总数用 MAX(id) | 不做全表 COUNT |
| CSV / XLSX 在浏览器生成 | 避开 Worker CPU 上限 |
| 只有 1 个 Cron；每次最多重算 200 个考勤日 | 每次执行的查询数有上限 |
| 登录 Session 每 10 分钟才更新一次 last_seen | 省写入 |

## 9. API 一览（全部在 /api 下，除标注外都需要登录）

`POST auth/login`（公开）、`POST auth/logout`、`GET auth/me`、`POST auth/password` ·
`POST telegram/webhook/:code`（公开，验证 secret） · `GET meta`、`GET version` ·
`GET overview`、`GET attendance`、`GET attendance/export`、`GET sessions/:emp/:date`、`POST sessions/:emp/:date/adjustments`、`GET breaks`、`GET reports` ·
`GET/POST employees`、`GET/PUT employees/:id`、`POST employees/:id/deactivate` ·
`GET/POST shifts`、`PUT shifts/:id`、`PUT shifts-bulk`、`GET roster`、`GET roster/export`、`GET roster/history`、`PUT roster/cell`、`POST roster/import` ·
`GET exceptions`、`GET exceptions/:id/fix`、`PUT exceptions/:id`、`GET audit`、`GET messages` ·
`PUT settings/keywords`、`PUT settings/rules`、`POST messages/reparse`、`POST currencies`、`DELETE currencies/:code`、`GET bots`、`PUT bots/:code`、`POST bots/:code/{check|stop|start|rotate}`

写入类 API 需要 admin 角色，并检查 Origin。
