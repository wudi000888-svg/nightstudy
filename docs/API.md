# Alpha API 契约

对应 `0.1.0-alpha.1` 新工程。本文按当前代码描述接口；本机验证与尚未执行的平台验证见 [README](../README.md)。业务前缀是 `<basePath>/api/v2`；下表省略此前缀。root 站点 `basePath` 为空，子路径站点如 `/school-a`。认证使用 `<basePath>/api/auth`，初始化使用 `<basePath>/setup`。

请求由可信 Host 与规范 basePath 选择 operator 配置的 Realm，随后只访问该站独立认证/业务 PG DB。客户端不能通过 `siteId`、`userId`、数据库 URL 参数切换身份。真正互不信任的站点使用不同 origin；同 origin 子路径属于同一信任域。

## 请求、认证与错误

业务请求返回 JSON；写请求必须使用 `Content-Type: application/json`。浏览器携带本站 session Cookie，使用 `credentials: include`。Cookie 是 host-only、HttpOnly、SameSite=Lax，每站独立 prefix/path；HTTPS 生产站启用 Secure。应用拒绝不可信 Origin 及显式 cross-site 写请求，不允许任意 CORS 来源。

应用层 PG 原子限流以 site/IP/分钟计数：认证和初始化 30 次，普通 API 600 次。429 返回 `Retry-After: 60`。这不是已实测容量数字。Better Auth 还有自己的附加限流及错误格式。

默认 socket profile 只按明确可信代理 CIDR 解析客户端 IP；Realm 始终取 wire Host，不接受 X-Forwarded-Host 切换站点。Render Blueprint 的 render-public profile 要求平台标记与受控公网入口，使用经单值 IP 校验的 CF-Connecting-IP；缺失、无效或链值的 API/初始化请求返回403 `trusted_client_ip_required`，固定根 health 探测例外。该 profile 不适用于私网服务或自托管。认证内部 IP 头由服务器覆盖，不能由客户端自行声明。

默认 app 启动后及每60秒执行有界 PG lease 维护；独立worker复用同入口。过期记录清理有每表批次上限，失败任务至多5次后标 failed，先核验SiteState/site绑定。该机制只描述维护任务，不是通用内容导入队列。

业务错误结构：`{ "code": "session_conflict", "message": "…", "details": { } }`，details 可省略。常见状态：400 输入有误，401 未登录，403 缺权限/来源不可信，404 本站资源不存在，409 版本或动作冲突，415 非 JSON 写请求，429 限流，503 DB 未准备/暂不可用。冲突后读取最新资源，保留原动作编号用于同内容重试，不能改内容后复用编号。

## 站点初始化与登录

| 方法与路径                     | 访问         | 契约                                                                                                       |
| ------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `GET /health/live`             | 无认证       | 进程存活，返回 status/version；固定根路径                                                                  |
| `GET /health/ready`            | 无认证       | 固定根路径，不依赖业务 Host/basePath；检查全部配置 Realm 的 DB 与 SiteState，返回 status/siteCount/version |
| `GET /api/v2/site`             | 访客         | siteId/title/basePath/publicUrl/version/contentVersion/initialized/registrationOpen                        |
| `POST /setup`                  | 初始化口令   | token、email、name、password；创建本站首位 admin，201；再次初始化 409                                      |
| `POST /api/auth/sign-up/email` | 注册开放时   | name/email/password，普通用户注册；客户端不能设置 role                                                     |
| `POST /api/auth/sign-in/email` | 访客         | email/password；建立本站 session                                                                           |
| `POST /api/auth/sign-out`      | 当前 session | JSON 空对象，退出                                                                                          |
| `GET /api/auth/get-session`    | 当前 Cookie  | Better Auth 原生 session 响应                                                                              |
| `GET /api/v2/me`               | 任意         | `{ user, siteId }`，未登录 user=null；user 只有 id/name/email/role                                         |

表中 `/api/v2`、`/api/auth`、`/setup` 均添加本站 basePath，health 固定根路径，子路径专用安装也可探测。初始化前 operator 必须已完成迁移与 seed。token 至少 32 字符，name 1–80 字符，password 8–128 字符；不提供固定默认管理员或默认密码。初始化操作在 DB 事务与锁内保护，成功后使用登录接口登录。当前没有邮件找回、邮箱验证、OAuth 或通用管理员提升权限接口。

初始化 JSON 示例使用占位符，须由调用者在自己的私有环境填写：

```json
{
  "token": "<operator 提供的本站随机初始化口令>",
  "email": "admin@example.com",
  "name": "本站管理员",
  "password": "<自行设置且至少8字符的密码>"
}
```

## 用户内容与设置

| 方法与相对路径                    | 访问 | 主要参数与响应                                                            |
| --------------------------------- | ---- | ------------------------------------------------------------------------- |
| `GET /books`                      | 访客 | 已发布词书；wordCount/learnedCount/coveredCount/claimedKnownCount/isDemo  |
| `GET /books/:id`                  | 访客 | book 与 items，当前最多 500 词                                            |
| `POST /books/:id/select`          | 用户 | JSON `{}`；更新 currentBookId 与 goal，返回 settings                      |
| `GET /dictionary?q=rain&limit=20` | 访客 | 规范化前缀查词；limit 1–50，items/source/completeDictionary               |
| `GET /words/:id`                  | 访客 | 已发布 word、senses、双语释义及例句字段                                   |
| `GET /me/settings`                | 用户 | settings                                                                  |
| `PATCH /me/profile`               | 用户 | name；不允许修改 role/email/其他用户                                      |
| `PATCH /me/settings`              | 用户 | 可选 goal/currentBookId/dailyNewLimit/groupSize/timeZone/expectedRevision |
| `GET /wordbook`                   | 用户 | 本人生词本，当前最多 500 条，含 note/favorite/paused/progress             |
| `POST /wordbook`                  | 用户 | wordId 与可选 note；加入/收藏已发布词                                     |
| `PATCH /wordbook/:wordId`         | 用户 | 可选 note/favorite/paused                                                 |
| `DELETE /wordbook/:wordId`        | 用户 | JSON `{}`；移除生词本项，保留学习进度                                     |
| `GET /announcements`              | 访客 | 最近 20 条已发布公告                                                      |

goal 取 `daily`、`ielts`、`cet4`、`cet6`、`high-school`，这些名称是学习目标入口，alpha 内容都是同一批原创演示词。dailyNewLimit 1–100，groupSize 1–20，timeZone 必须是有效 IANA 时区。settings 有 revision；建议 PATCH 携带 expectedRevision，过期返回 409 `settings_conflict` 和最新 settings。字典返回 `source=original-demo`、`completeDictionary=false`；当前没有完整 ECDICT 数据包适配器。

## 固定学习会话与 FSRS

| 方法与相对路径                      | 主要参数与响应                                                         |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `GET /study/plan`                   | plan：目标、词书、到期数、今日新词剩余及本地日期                       |
| `GET /study/sessions`               | 最近最多 10 个进行中的本人会话                                         |
| `POST /study/sessions`              | mode=learn/review，可选 bookId、size 1–20；返回 session 或 null/reason |
| `GET /study/sessions/:id`           | 本人固定会话、revision、cursor/currentItemId、内容快照                 |
| `POST /study/sessions/:id/commands` | commandId/itemId/action/expectedSessionRevision，以及动作参数          |

以上均要求登录。先对当前 item 发 `reveal`，再发 `rate`（again/hard/good/easy，必须含 expectedProgressRevision）；整组评价后进入 practice，对当前题发 `answer`。拼写答题只记练习结果，FSRS 调度由此前评价决定，不能跳过 reveal 或操作别人的 item。命令示例：

```json
{
  "commandId": "<本次动作独立UUID>",
  "itemId": "<session.currentItemId>",
  "action": "rate",
  "rating": "good",
  "expectedSessionRevision": 1,
  "expectedProgressRevision": 0
}
```

commandId 8–120 字符，对同一用户全局去重。同内容重试不重复记录 review；同编号不同内容返回 `idempotency_conflict`。session/progress 的 stale revision 返回 409 并给出最新状态。每次成功以后使用响应中的 revision；rating 同时更新 FSRS 状态、dueAt、ReviewLog。服务端不接受客户端自行修改 dueAt/记忆参数。

`GET /study/plan` 的 `reservedNewCount` 是今日已签发但尚未首次评价的新词预约数，按 wordId 去重，区别于 `learnedToday` 已实际学过的词。`newRemaining = max(0, dailyNewLimit - learnedToday - reservedNewCount)` 表示新增预约额度，日期按用户 timeZone 计算。客户端应同时展示待完成组，不能将 newRemaining=0 当作已签发组不可继续。

创建 learn 会话在事务内锁定本人设置行、读取预约，再分配固定组。同书并发创建会排除当日已预约词；不同词书共享 wordId 的当日预约不重复占配额，评价仍受 progress revision 保护。额度用尽且没有可复用预约时返回 session=null/reason=daily_goal_complete。预约不是 Review，也不增加 learnedToday；首次成功评价才记录学习。

每日目标只在创建新组时限制新增预约，已签发组继续按既有固定项完成回忆、评价与拼写。中途降低 dailyNewLimit 或改变计划不回收旧组，不在 rate 阶段以新目标拒绝它；下一次创建按新设置与当前预约额度判断。到期 review 不使用新词配额。当前预约统计只覆盖用户时区当日，跨日保留的旧组仍可完成；没有自动取消/回收未完成组接口。

## 熟词声明、测试与个人统计

| 方法与相对路径                          | 主要参数与响应                                             |
| --------------------------------------- | ---------------------------------------------------------- |
| `POST /known-words/imports`             | format=text/csv/json，text；生成 preview，不立即标为熟词   |
| `GET /known-words/imports`              | 最近最多 50 个本人批次                                     |
| `POST /known-words/imports/:id/confirm` | JSON `{}`；只确认 matched，重复确认安全                    |
| `POST /known-words/imports/:id/revoke`  | JSON `{}`；撤销声明，保留已有学习进度                      |
| `GET /known-words/exports?format=json`  | json/csv；仅导出本人已确认声明，当前读取最多 10,000 claims |
| `POST /assessments`                     | goal、size 1–20（抽样词数，每词拼写与认知两题）            |
| `GET /assessments/:id`                  | 本人题目顺序/当前项；完成后 report                         |
| `POST /assessments/:id/answers`         | commandId/itemId/answer；只接受当前题，动作去重            |
| `POST /assessments/:id/finish`          | JSON `{}`；全部答完才结算 report/plan                      |
| `GET /mastery/plan?goal=daily`          | 本人对应目标的诊断证据与建议                               |
| `POST /activity`                        | eventId/startAt/endAt；仅近期 1–60 秒前台心跳，去重        |
| `GET /stats`                            | 今日/30日趋势、学习/复习/熟词声明数与达标天数              |
| `GET /memory/curve`                     | 可选 bookId 或 goal；FSRS 预测、真实自评观察及 dataLimited |

以上均要求登录。熟词每批 1–1,000 行、UTF-8 256 KiB 以内。text 每行一词；CSV 必須有 `lemma`/`word`/`单词` 列，可选 wordId/language；JSON 为字符串数组、对象数组或含 rows 的对象。预览区分 matched/unknown/duplicate。确认前如内容状态改变会要求重新预览。跨站导出是声明内容，不迁移账号、session、FSRS 状态或能力结论。

熟词声明降低新学优先级、保留抽查，不等于客观掌握。测试只给已测词建立证据，report 标注 `limited_demo`，不推断完整考试词汇量。记忆曲线只使用真正评价后的状态，未产生复习数据时 empty=true；阴影为词间分布，不是准确率保证或置信区间。stats 超过 20,000 日志/区间、curve 超过 2,000 progress 时会标 dataLimited。

## 本站管理员

| 方法与相对路径                    | 主要参数与响应                                                    |
| --------------------------------- | ----------------------------------------------------------------- |
| `GET /admin/overview`             | 本站 users/words/books/reviews/imports 计数                       |
| `GET /admin/users`                | 最近最多 100 位，返回必要管理字段                                 |
| `PATCH /admin/users/:id`          | disabled 布尔值；停用时撤销 session，保护最后一位有效管理员       |
| `GET /admin/books`                | 本站词书                                                          |
| `POST /admin/books`               | slug/title/goal/wordIds，description/status 可选，默认 draft      |
| `PATCH /admin/books/:id`          | 可选 title/description/goal/status/wordIds，保留旧会话快照        |
| `GET /admin/words?q=rain`         | 最多 100 条本站词，含未发布状态                                   |
| `PATCH /admin/words/:id`          | 可选 status/senseId/definitionZh/definitionEn/exampleEn/exampleZh |
| `GET /admin/announcements`        | 最近最多 100 条                                                   |
| `POST /admin/announcements`       | title/body、可选 status                                           |
| `DELETE /admin/announcements/:id` | JSON `{}`                                                         |
| `GET /admin/audit`                | 最近最多 100 条管理审计                                           |

这些接口必须 `role=admin`；没有跨站平台管理员或配置 Host/DB/secret 的 Web API。词书只能引用本站已发布词，每书当前最多 500 个、禁止重复 wordIds。编辑词义增加内容版本，既有 session 保留创建时快照；所有管理变更记录本站审计。公告与释义是文本，不是执行任意 HTML/JS 的扩展入口。

当前接口有硬读取上限，尚无完整分页/OpenAPI 导出/批量内容导入/媒体上传。生产客户端应固定版本并在升级时核对 [CHANGELOG](../CHANGELOG.md) 与 [部署文档](DEPLOYMENT.md)。
