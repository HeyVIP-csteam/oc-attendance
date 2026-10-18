# Telegram 上线前验证清单

## A. 群组

- [ ] 群组类型是 **Supergroup**，已开启 **Topics**（群组设置 → Topics）
- [ ] 每位员工一个 Topic。Topic 名称只是给人看的，系统**只用 Chat ID + `message_thread_id` 识别员工**，改名不影响
- [ ] 取得 Chat ID（`-100` 开头）与每个 Topic 的 `message_thread_id`：
  - 方法：在 Topic 内任一消息点右键 → Copy Message Link，链接形如 `https://t.me/c/2233445566/1001/1234`
    → Chat ID = `-1002233445566`，`message_thread_id` = `1001`
- [ ] 不要让员工在 General 打卡（会被记为 NO_TOPIC 异常，不计入考勤）

## B. 每个货币的 Bot（@BotFather）

- [ ] `/newbot` 建立 Bot，Token 只贴在后台「Bot 设置」或 `wrangler secret put`，不要贴到聊天或文件
- [ ] **`/setprivacy` → 选该 Bot → Disable**。Privacy Mode 开启时 Bot 只收得到指令和 @提及，**收不到普通文字 IN/OUT**
- [ ] **关闭 Privacy Mode 之后，把 Bot 移出群组再重新加入**（设定只对之后加入的群组生效）
- [ ] `/setjoingroups` 保持 Enable
- [ ] Bot 在群组中**不需要管理员权限**；只需要能发消息（用于回复确认）。不需要删除消息、管理 Topics 等权限
- [ ] 同一群组有多个货币 Bot 时没问题：系统按员工的货币决定由哪个 Bot 处理，另一个 Bot 收到同一条消息会忽略，不会重复记录

## C. Webhook（后台自动完成，这里是检查）

- [ ] 后台 → 设置 → Bot 设置：状态「运行中」，「可读取群消息」= 是
- [ ] Webhook URL 是 `https://…/api/telegram/webhook/<货币小写>`，每个 Bot 不同
- [ ] `allowed_updates` 只有 `message`、`edited_message`（减少无关请求）
- [ ] 每个 Bot 有独立的 secret_token，Telegram 每次请求都带 `X-Telegram-Bot-Api-Secret-Token`；不符一律 401
- [ ] 「检查」按钮显示「待处理更新」为 0、没有「最后错误」

## D. 实际收讯测试（测试群）

1. 建一个测试 Supergroup（开启 Topics），加入 Bot，新增一个测试员工并绑定其 Topic
2. 在该 Topic 发 `IN` → 应在 1–2 秒内收到 Bot 回复 `✅ Clock In recorded · HH:MM (Sri Lanka time)`
3. 后台「异常与审计 → 原始消息」应看到这条消息，Status = PROCESSED
4. 依序测试：

| 发送 | 位置 | 预期 |
|---|---|---|
| `BREAK` → `RESUME` → `OUT` | 自己的 Topic | 考勤明细显示休息 1 次、净工时 |
| `good morning` | 自己的 Topic | 不回复；原始消息 IGNORED |
| `IN 08:30` | 自己的 Topic | 回复「Not recognised」；异常 UNRECOGNIZED；不产生打卡 |
| `IN` | General | 回复「Not counted」；异常 NO_TOPIC |
| `IN` | 未绑定的 Topic | 异常 WRONG_TOPIC_UNMAPPED |
| 转发别人的 `IN` | 自己的 Topic | 异常 UNTRUSTED_SOURCE |
| 编辑已发出的 `IN` | 自己的 Topic | 原打卡不变；异常 EDITED_MESSAGE |
| 再发一次 `IN` | 自己的 Topic | 回复「Duplicate clock in」，不影响原记录 |

5. 若没有任何回复：Bot 设置 → 检查；看「最后错误」；`npm run logs` 看是否有 `webhook` 日志

## E. 限制说明（请告知管理层）

- **Bot 加入群组前的历史消息读不到**；Webhook 只收到设定之后的新消息。
- Telegram 时间（`message.date`）由 Telegram 服务器给出，比员工自己写的时间可信，但：
  - 它只证明「消息何时送达 Telegram」，**不能证明员工的实际位置或身份**（帐号可被他人使用）；
  - 网络不佳时消息可能晚送达，系统会以 Telegram 时间计算并标记 DELAYED_DELIVERY（>5 分钟）；
  - 系统无法防止员工请他人代发。若需更强证明，需要另加位置、照片或设备打卡，不在本系统范围。
- Webhook 失败时 Telegram 会保留并重试最多 24 小时；系统以 `update_id` 与 `(chat_id, message_id)` 去重，不会重复计算。

## 一个 Bot 用于多个货币

- 同一个 Bot 可以在 Bot 设置里同时设给多个货币（例如 INR、PHP、PKR 都填同一个 Token），三行看起来一样。
- Telegram 规定一个 Bot 只能有一个 Webhook，所以三行显示同一个网址；系统按 Bot 的密钥认消息，员工仍按 Topic 识别，货币不会混。
- 停用、启用、清除、换 Bot 都只影响那一个货币。
- 系统不会自动重新连接任何 Bot：只有在网页按「保存」「启用」「更换密钥」时才会设置 Telegram。没有任何货币再用某个 Bot 时，才会断开它，而且只断开连到 oc-attendance 的连接（连在其他系统的不碰）。
- 记得把这个 Bot 拉进每个考勤群，并设为管理员。
- 不要使用其他系统（例如 TBC 客服系统）正在用的 Bot：保存时如果发现 Bot 连在其他系统，会先警告。
