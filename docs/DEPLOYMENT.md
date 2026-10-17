# 部署指南（GitHub + Cloudflare Workers + D1 + Telegram）

> 我没有你的 GitHub / Cloudflare 权限，以下每一步都需要你亲自执行。每一步后面都有「检查」，确认成功再往下走。
> 全程不需要把任何 Token 或密码写进文件或贴到公开地方。

## 0. 准备

- Node.js 22.13 以上：`node -v`
- 一个 Cloudflare 账号（你现在的 Workers Paid 账号即可）
- 一个 GitHub 账号
- 每个货币一个 Telegram Bot（在 @BotFather 用 `/newbot` 建立），以及一个开启 Topics 的超级群组

```bash
unzip tg-attendance.zip && cd tg-attendance
npm install
npm test                 # 检查：显示 80 passed
npx wrangler login       # 浏览器会打开 Cloudflare 授权页面
```

## 1. 建立 GitHub Repository

```bash
git init
git add .
git commit -m "Initial commit"
# 在 GitHub 网页建立一个 **Private** repository（例如 tg-attendance），然后：
git remote add origin git@github.com:<你的账号>/tg-attendance.git
git branch -M main
git push -u origin main
```

检查：`git status` 干净；GitHub 上看不到 `.dev.vars`、`.wrangler/`、`node_modules/`（已在 `.gitignore`）。

## 2. 建立生产 D1 数据库

```bash
npx wrangler d1 create tg-attendance
```

把输出里的 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases[0].database_id`（这个 ID 不是机密，可以提交），然后：

```bash
git commit -am "Set D1 database id" && git push
npm run db:migrate:remote        # 套用 0001、0002
npm run db:migrations:list       # 检查：两个 migration 都已套用
```

## 3. 设定机密（Cloudflare Secrets）

```bash
# 产生 32 bytes 随机金钥并直接交给 wrangler（不会出现在文件里）
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put ENCRYPTION_KEY
```

> ⚠️ **ENCRYPTION_KEY 不能遗失或随意更换**：它用来加密 Bot Token 和推导 Webhook secret。更换后需要在后台重新输入每个 Bot Token。请另存在你的密码管理器。

再设定一个**一次性设置码**，用来在网页上建立第一个管理员（自己想一串不容易猜的字，例如 20 个字符以上）：

```bash
npx wrangler secret put SETUP_CODE
```

> 也可以不用命令：Cloudflare Dashboard → Workers & Pages → `tg-attendance` → Settings → Variables and Secrets → Add → 类型选 **Secret**，名称 `SETUP_CODE`。`ENCRYPTION_KEY` 也可以这样加（值用上面命令产生的随机字串）。

（可选）若不想在后台输入 Bot Token，可改用 Secret：`npx wrangler secret put TELEGRAM_BOT_TOKEN_LKR`（每个货币一个）。

## 4. 第一次部署

```bash
npm run deploy
```

输出会显示网址，例如 `https://tg-attendance.<你的子域>.workers.dev`。把它填进 `wrangler.jsonc` 的 `vars.PUBLIC_ORIGIN`，提交并再部署一次。

检查：`curl https://tg-attendance.<你的子域>.workers.dev/api/health` → `{"ok":true,"env":"production"}`

## 5. 建立第一个管理员（网页）

1. 打开你的网址。系统还没有任何管理员时，登录页会自动变成「建立第一个管理员」
2. 输入第 3 步的 **设置码（SETUP_CODE）**、账号、密码（至少 10 个字符）→「建立管理员并登录」
3. 建立后这个页面永久关闭（只要已有任何一个管理员，设置码就不再有效）。之后可以到 Cloudflare 把 `SETUP_CODE` 删除

之后的账号全部在网页管理：**设置 → 管理员账号**
- 新增账号：管理员（可修改）或只读（只能查看）
- 编辑：重设密码、改权限、停用（会登出该账号所有装置）；不能停用自己，也至少要保留一个启用中的管理员
- 自己改密码：右上角用户名 → 更改密码

账号都保存在 D1 的 `admin_users` 表，密码只存 PBKDF2 hash；每次新增 / 修改都写入 Audit Log。

> 备用方法（例如所有管理员都忘记密码）：`npm run admin:create -- --remote --username owner` 直接在 D1 建立或重设账号。

## 6. 自动部署（二选一）

**A. Cloudflare Workers Builds（推荐）**
Cloudflare Dashboard → Workers & Pages → `tg-attendance` → Settings → Builds → Connect → 选 GitHub repository：
- Build command：`npm run build`
- Deploy command：`npx wrangler deploy`
- Production branch：`main`

之后每次 `git push` 到 `main` 都会自动部署。**普通部署不会动数据库。**

**B. GitHub Actions**：在 GitHub repo → Settings → Secrets 加入 `CLOUDFLARE_API_TOKEN`（权限：Workers Scripts Edit、D1 Edit）与 `CLOUDFLARE_ACCOUNT_ID`，到 Actions → Deploy → Run workflow 手动部署。`ci.yml` 会在每次 push / PR 自动跑测试。

## 7. 数据库 Migration 流程（生产）

1. 新增文件 `migrations/0003_xxx.sql`（只用 `ALTER TABLE ADD COLUMN`、`CREATE TABLE/INDEX` 等新增操作；不可修改已套用的旧文件）
2. 本地验证：`npm run db:migrate:local && npm test`
3. 生产前先备份：`npx wrangler d1 export tg-attendance --remote --output backup-$(date +%F).sql`
4. 套用：`npm run db:migrate:remote`（只执行尚未套用的文件）
5. 再部署程序

不会在任何一般部署中自动重建或清空数据库。D1 也提供 Time Travel（30 天内还原）：`npx wrangler d1 time-travel info tg-attendance`。

## 8. 设定 Telegram（每个货币）

先完成 [TELEGRAM_CHECKLIST.md](TELEGRAM_CHECKLIST.md) 的 Bot 设定（关闭 Privacy Mode、加入群组），然后：

1. 后台 → 设置 → **货币**：确认需要的货币（预设 LKR / MYR / USD，可新增、删除）
2. 设置 → **Bot 设置** → 该货币「设置」→ 贴上 Bot Token → Webhook URL 保持预设 → 「保存并启动 Webhook」
   - 系统会呼叫 Telegram `getMe`、`setWebhook`（含 secret_token、`allowed_updates=["message","edited_message"]`）
   - 如果出现「Privacy Mode 仍开启」提醒，按提示处理后按「检查」
3. 员工 → 新增员工：填 Employee ID、姓名、货币、群组 Chat ID、该员工 Topic 的 `message_thread_id`
4. 班次与排班 → 导入排班（CSV/XLSX，格式同「导出」）或逐格点选
5. 在员工 Topic 发 `IN` → Bot 回复「✅ Clock In recorded」→ 后台「考勤明细」出现记录

## 9. 日志与排错

| 情况 | 怎么查 |
|---|---|
| 实时日志 | `npm run logs`（或 Dashboard → Workers → Logs）。日志不含 Token / 密码 |
| Bot 没反应 | 后台 Bot 设置 → 检查：看「待处理更新」「最后错误」；常见是 Privacy Mode 未关、Bot 未重新加入群组、URL 不对 |
| 401 webhook_bad_secret | 有人用错误 secret 呼叫，或 ENCRYPTION_KEY 被更换 → 在 Bot 设置按「编辑 → 保存并启动 Webhook」重新注册 |
| 打卡被拒（REJECTED_IDENTITY） | 异常与审计 → 异常：NO_TOPIC（在 General 发）、WRONG_TOPIC_UNMAPPED（Topic 未绑定员工）、UNTRUSTED_SOURCE（转发） |
| 缺卡 / 未出勤没更新 | 确认 Cron 有执行：Dashboard → Workers → Settings → Triggers；日志里有 `"event":"cron"` |
| 「服务器配置错误：ENCRYPTION_KEY…」 | 第 3 步的 Secret 没设定或格式不对 |
| 用量 | Dashboard → Workers & Pages（请求、CPU）与 D1 → Metrics（读写行数） |

## 10. 免费版 / 付费版说明

系统按免费额度设计：网页只在可见且 10 分钟内有操作时每 60 秒查一次 `/api/version`（读 1 行），有变化才重新读取；报表在数据库汇总；导出在浏览器生成；普通聊天不写入数据库。
注意：免费版每次请求 CPU 上限 10 毫秒，管理员**登录**（PBKDF2 100,000 次）可能超过；你的账号是 Workers Paid，不受影响。
