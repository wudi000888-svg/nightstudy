# Alpha API 契约

对应 `0.5.0-alpha.2` 开发接口。此文说明当前实现契约，本轮统一验收、发行和部署结果另行记录；0.4及更早的验证仍是各自版本的历史证据，见 [README](../README.md)。业务前缀为 `<basePath>/api/v2`，下表省略此前缀。根站basePath为空，子路径如/school-a；认证为 `<basePath>/api/auth`，手动初始化为 `<basePath>/setup`。

请求由可信 Host 与规范 basePath 选择 operator 配置的 Realm，随后只访问该站独立认证/业务 PG DB。客户端不能通过 `siteId`、`userId`、数据库 URL 参数切换身份。真正互不信任的站点使用不同 origin；同 origin 子路径属于同一信任域。

## 请求、认证与错误

业务接口通常返回JSON；音频、模板和失败清单下载返回对应媒体或文本。写请求必须使用 `Content-Type: application/json`，词书文件也按base64放入JSON，不使用multipart。浏览器携带本站 session Cookie，使用 `credentials: include`。Cookie 是 host-only、HttpOnly、SameSite=Lax，每站独立 prefix/path；HTTPS 生产站启用 Secure。应用拒绝不可信 Origin 及显式 cross-site 写请求，不允许任意 CORS 来源。

应用PG原子限流以site/IP/分钟计数：认证、初始化与配对票据兑换30次，普通API600次，429返回Retry-After。数字是请求门槛，不是实测容量；Better Auth另有附加限流。

默认 socket profile 只按明确可信代理 CIDR 解析客户端 IP；Realm 始终取 wire Host，不接受 X-Forwarded-Host 切换站点。Render Blueprint 的 render-public profile 要求平台标记与受控公网入口，使用经单值 IP 校验的 CF-Connecting-IP；缺失、无效或链值的 API/初始化请求返回403 `trusted_client_ip_required`，固定根 health 探测例外。该 profile 不适用于私网服务或自托管。认证内部 IP 头由服务器覆盖，不能由客户端自行声明。

默认 app 启动后及每60秒执行有界 PG lease 维护；独立worker复用同入口。过期记录清理有每表批次上限，失败任务至多5次后标 failed，先核验SiteState/site绑定。该机制只描述维护任务，不是通用内容导入队列。

业务错误结构：`{ "code": "session_conflict", "message": "…", "details": { } }`，details 可省略。常见状态：400 输入有误，401 未登录，403 缺权限/来源不可信，404 本站资源不存在，409 版本或动作冲突，415 非 JSON 写请求，429 限流，503 DB 未准备/暂不可用。冲突后读取最新资源，保留原动作编号用于同内容重试，不能改内容后复用编号。

浏览器只对本站401 `authentication_required` 通知本地会话失效。子站401 `fleet_grant_revoked` 等仅代表远端授权问题，不退出控制站账户；前置代理401无法确认远端grant撤销时返回 `fleet_remote_authorization_unconfirmed`，不能假报已解绑。

## 站点初始化与登录

| 方法与路径                        | 访问         | 契约                                                                                                       |
| --------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `GET /health/live`                | 无认证       | 进程存活，返回 status/version；固定根路径                                                                  |
| `GET /health/ready`               | 无认证       | 固定根路径，不依赖业务 Host/basePath；检查全部配置 Realm 的 DB 与 SiteState，返回 status/siteCount/version |
| `GET /api/v2/site`                | 访客         | siteId/title/basePath/publicUrl/version/contentVersion/initialized/registrationOpen                        |
| `POST /setup`                     | 初始化口令   | token、email、name、password；创建本站首位 admin，201；再次初始化 409                                      |
| `POST /api/auth/sign-up/email`    | 注册开放时   | name（1–80字）/email/password，普通用户注册；客户端不能设置 role                                           |
| `POST /api/auth/sign-in/email`    | 访客         | email/password；建立本站 session                                                                           |
| `POST /api/auth/sign-in/username` | 访客         | username/password；自动管理员用户名admin                                                                   |
| `POST /api/auth/sign-out`         | 当前 session | JSON 空对象，退出                                                                                          |
| `GET /api/auth/get-session`       | 当前 Cookie  | Better Auth 原生 session 响应                                                                              |
| `GET /api/v2/me`                  | 任意         | `{ user, siteId }`，未登录 user=null；user 只有 id/name/email/role                                         |

0.3的db:prepare默认ADMIN_BOOTSTRAP=auto：仅首次创建用户名admin与本站独立随机密码，私密初始文件由operator交付，未通过API提供密码。候选先持久化再事务创建，已有管理员不重置。初始文件不随之后改密更新。单站INITIAL_ADMIN_PASSWORD/EMAIL可私有覆盖，Render密码由平台generateValue保管；详见 [部署文档](DEPLOYMENT.md#初始管理员凭据)。

表中认证/API/setup添加本站basePath，health固定根路径。ADMIN_BOOTSTRAP=manual跳过自动创建，使用/setup的私有token（至少32字符）、name1–80、password8–128；已有初始化返回409。自动与手动初始化共用DB锁，普通注册不能设置admin角色。没有共用默认管理员密码、邮件找回、邮箱验证、OAuth或通用提权接口。

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

| 方法与相对路径                      | 访问      | 主要参数与响应                                                                                                          |
| ----------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /books`                        | 访客/本人 | 公开已发布词书及登录用户本人的私有书；wordCount/learnedCount/coveredCount/claimedKnownCount/isDemo/visibility/ownedByMe |
| `GET /books/:id`                    | 访客/本人 | 公开书或本人私有书的book/items/page；limit 1–200，默认100；cursor按ordinal继续读取完整词书                              |
| `POST /books/:id/select`            | 用户      | JSON `{}`；更新 currentBookId 与 goal，返回 settings                                                                    |
| `GET /dictionary?q=rain&limit=20`   | 访客      | 规范化前缀查词；limit 1–50，cursor；items/page/source/sources/completeDictionary                                        |
| `GET /dictionary/resolve?text=rain` | 访客      | 点词精确解析；word/queried/matchedLemma/matchType，未命中word=null                                                      |
| `GET /dictionary/stats`             | 访客      | ready数据包元数据；installedDictionary/countBasis/declaredEntryCount/packs                                              |
| `GET /words/:id`                    | 访客      | 已发布word的全部senses、音标与来源；每个Sense包含source/exampleSource                                                   |
| `GET /me/settings`                  | 用户      | settings                                                                                                                |
| `PATCH /me/profile`                 | 用户      | name；不允许修改 role/email/其他用户                                                                                    |
| `PATCH /me/settings`                | 用户      | 可选 goal/currentBookId/dailyTotalGoal/groupSize/timeZone/expectedRevision；旧dailyNewLimit仅作兼容                     |
| `GET /wordbook?limit=50&cursor=...` | 用户      | 本人生词本游标分页，默认50条、每页最多100条，items/page含note/favorite/paused/progress                                  |
| `GET /wordbook/:wordId`             | 用户      | 读取本人精确收藏项或null，不用列表首批推断收藏状态                                                                      |
| `POST /wordbook`                    | 用户      | wordId 与可选 note；加入/收藏已发布词                                                                                   |
| `PATCH /wordbook/:wordId`           | 用户      | 可选 note/favorite/paused                                                                                               |
| `DELETE /wordbook/:wordId`          | 用户      | JSON `{}`；移除生词本项，保留学习进度                                                                                   |
| `GET /announcements`                | 访客      | 最近 20 条已发布公告                                                                                                    |

goal 取 `daily`、`ielts`、`cet4`、`cet6`、`high-school`。默认安装固定版ECDICT的770,611词及5本源目标词书；0.4生产内容准备归档旧演示书，40词身份、原创内容、历史学习和会话快照仍保留。目标书按上游标签/词频规则建立，不是官方完整考试大纲。`CONTENT_PACK=demo` 用于显式最小开发/测试数据。内容版本、许可和覆盖见 [CONTENT.md](CONTENT.md)。dailyTotalGoal 1–100，是每天复习与新学的不同词总目标；groupSize 1–20。timeZone 必须是有效 IANA 时区，学习日按当地04:00交接；时区改变返回pendingTimeZone/timeZoneEffectiveAt，下个学习日生效，不重切今日窗口。settings有revision；建议PATCH携带expectedRevision，过期返回409 `settings_conflict` 和最新settings。Settings中的旧dailyNewLimit兼容字段现在镜像总目标，不能继续理解为独立新词配额；与dailyTotalGoal同时提交但不相等时返回400 `conflicting_daily_goal`。网页选书使用下述原子计划确认入口，旧book select保留兼容。

`/dictionary/resolve` 接受text长度1–80，当前执行规范化精确匹配，返回 `matchType=exact` 或 `not-found`；没有前缀近似替代、后缀猜测或未经证实的原形推断。客户端可兼容未来有词典关系证据的 `inflection` 类型，但本轮不能把它描述为已实现的词形分析。未命中示例：`{ "word": null, "queried": "…", "matchedLemma": null, "matchType": "not-found" }`。

词书详情、字典和admin词检索使用keyset分页，返回 `page={total,hasMore,nextCursor}`；词书按ordinal、词检索按normalizedLemma排序。后续请求原样携带nextCursor；游标绑定词书ID或规范化查询词，不能在变更q或词书时复用，否则400 `invalid_cursor`。它是分页位置，不能切换Realm，也不是事务快照。列表仅提供前3个Sense及senseCount/detailAvailable，完整多义项从 `/words/:id` 读取。

字典返回 `source=postgres-catalog`，已安装ready ECDICT时 `completeDictionary=true`；该值只声明固定数据包已安装，不代表覆盖所有英语。`/dictionary/stats` 的 `countBasis=installed-pack-metadata`，declaredEntryCount累计ready词典包声明词数，排除kind=phonetics的独立音标包，不能当作当前已发布Word的实时计数。每个Word及Sense披露来源，原创例句、站点编辑和源释义分开标记；缺失的释义、音标、例句保持缺失。现代US/UK IPA与原始source-transcription分开，参见 [PHONETICS.md](PHONETICS.md)。

## 私有自定义词书

除模板外，下列入口要求本站用户，资源按服务端user身份隔离，不接收ownerId/userId来替换所有者。私有书在本人 `/books`、详情、选择和学习会话中使用；其他用户及访客不能读取或选用。

| 方法与相对路径                                      | 契约                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /custom-books/template`                        | 格式元数据：formatVersion/header/text/limits/requirements/downloadUrls                                |
| `GET /custom-books/templates/:format`               | `txt`、`docx`、`pdf` 的标准模板文件                                                                   |
| `POST /custom-books/imports`                        | title/description?/goal/format/filename/contentBase64；生成本人预览，返回import/items/page，首屏100行 |
| `GET /custom-books/imports/:id`                     | 读取预览；limit1–200/cursor/status=all\|ready\|failed\|duplicate                                      |
| `POST /custom-books/imports/:id/confirm`            | commandId；再次核验原合格项并创建私有词书，返回book/import/duplicate/addedCount/skippedCount          |
| `GET /custom-books/imports/:id/failures?format=txt` | TXT或TSV失败/重复清单，包含原行和具体原因                                                             |
| `GET /custom-books?status=published`                | 本人词书；status=published\|archived\|all，含词数和学习覆盖计数，最近最多100本                        |
| `PATCH /custom-books/:id`                           | title?/description?/status=published\|archived；不改变所有权或公开可见性                              |
| `DELETE /custom-books/:id`                          | JSON `{}`；归档，返回archived/progressRetained/existingSessionsRetainSnapshots                        |

格式版本为 `word-lines-v1`。首个非空文本行必须为 `NIGHTSTUDY-WORDBOOK v1`，随后每行一个英语单词或短语，不接受编号、释义、任意表格或混合语言行。TXT使用UTF-8，原始文件最多262,144字节；DOCX/PDF最多2,097,152字节；每批最多10,000项，PDF最多250页，抽取文本最多512,000字符。上传路由JSON上限4 MiB，原文件限制按base64解码后的字节另查。仅支持DOCX，不把旧DOC当文本读取；PDF需可抽取文本，不做OCR。解析超时、活动内容、布局/编码不支持、过度解压及损坏文档明确失败。

预览import包含id/title/description/goal/filename/format/formatVersion/status/counts/expiresAt/createdAt/confirmedAt/bookId。status为preview或confirmed，预览有效24小时；每人最多20份未到期未确认预览。`counts={totalRows,ready,failed,duplicates,missingPronunciation,notFound,missingDefinition}`；缺音源或IPA按失败行计一次，各原因可以重叠，不相加作为总失败数。

每行返回lineNumber/text/normalizedLemma/status/wordId?/lemma?/reasons/readiness?/duplicateOfLine?。只有精确命中的已发布词、非空中文义、US/UK地区IPA及两口音ready音源记录齐备时才是ready；音源可以是按来源明确标注的真人录音或Piper合成。失败原因包括not_found、missing_definition、missing_phonetic_us/uk、missing_audio_us/uk；重复行单独标duplicate。不会生成虚构词义、猜词形或用设备语音冒充已就绪服务器音源。

确认携带稳定commandId；同内容重试不会重复创建词书。原ready项在确认时再次核验，失效项跳过；若一个合格词都不剩，409 `custom_import_no_ready_words` 的details.import给出最新统计，读取预览可见新失败原因。原failed项不会被静默加入，补齐资料后可重新上传预览。归档只停止新书选择，保留canonical词进度、历史评价和已签发内容快照。

## 发音与在线翻译

| 方法与相对路径                             | 访问 | 主要参数与响应                                                                              |
| ------------------------------------------ | ---- | ------------------------------------------------------------------------------------------- |
| `GET /pronunciation/:wordId`               | 访客 | pronunciation：text/phonetics/audio/recordedAudioAvailable/speech                           |
| `GET /pronunciation/:wordId/audio/:accent` | 访客 | US或UK同源音频，验证文件/MIME头/SHA-256后返回媒体；ETag支持304                              |
| `POST /pronunciation/:wordId/prepare`      | 用户 | JSON `{}`；服务可用且英美IPA齐备时补缺失合成音源，返回最新pronunciation                     |
| `GET /translation/provider`                | 访客 | provider的mode/transport/configured/unofficial/bestEffort/maxTextLength等，无网关URL或token |
| `POST /translation/website`                | 访客 | text/sourceLanguage/targetLanguage；返回Google官方网页链接及iframeSupported=false           |
| `POST /translation/text`                   | 用户 | 同一文本契约；配置后返回translation与website；本站用户共享PG限流20次/分钟                   |

发音接口提供已安装音标、ready音源、recordedAudioAvailable、generationAvailable和设备speech能力。`audio=[{id,accent,kind,url,status,sourceName,sourceUrl,license,attribution,mimeType}]`，accent为US/UK，kind为recorded/synthesized；URL是未添加挂载前缀的 `/api/v2/pronunciation/:wordId/audio/:accent`，客户端用本站mountUrl添加basePath，不接受任意外部字符串作为播放器源。WordDTO也有可选audio；旧会话快照没有该字段时读取fresh发音接口，不附带词义、不提前揭晓答案。

prepare只补缺失音源，不覆盖优先的已就绪真人录音；返回后只更新选项，不自动播放。每用户每分钟最多20次补齐请求，合成运行并发有界。409 `audio_missing_phonetics`/`audio_preparing`、429 `audio_generation_busy`/`audio_generation_rate_limit`、503服务/文件失败与504超时显式报错；处理中可刷新元数据后重试。设备en-US/en-GB需要真实可用voice，是独立备用选项。音源来源许可、算法IPA与目标生成范围见 [PHONETICS.md](PHONETICS.md)。

翻译文本最多1,000个Unicode字符，sourceLanguage为auto/en/zh-CN（默认en），targetLanguage为en/zh-CN（默认zh-CN）。默认website-official仅提供官方网页入口，站内text返回503 `translation_not_configured`；生产站内结果使用带私密token的固定VPS网关，direct仅供本机开发。网页兼容provider返回 `google-web-compat` / `unofficial=true` / `bestEffort=true`，不是受支持的Google Cloud API。本机真实调用已遇到上游429；失败显示明确错误，不把离线词义冒充翻译。Google网页不能直接iframe，本站返回链接。原文会传送至配置网关/Google，不写翻译历史。配置、鉴权、超时的验证范围与尚待项见 [TRANSLATION.md](TRANSLATION.md)。

## 每日总量计划、固定任务与 FSRS

以上业务入口均要求本站登录用户，不接受userId/siteId来替换任务所有者。每天总目标N包含复习与新学，按canonical wordId去重，先给今日到期复习预留预算，剩余才从选定词书补新词。复习覆盖本站全部已学词，不局限于当前书；未安排的逾期词独立显示。今日稍后到期的预留复习不会提前产生评分。

| 方法与相对路径                      | 参数与响应                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /study/plan`                   | 返回`{plan,settings}`；读取或维护本站当前用户的当日计划                                                                     |
| `GET /study/plan/preview`           | 可选bookId/dailyTotalGoal/groupSize/timeZone；只读返回`{preview,settingsRevision}`，不签发任务、不改设置                    |
| `POST /study/plan/confirm`          | bookId/dailyTotalGoal/groupSize/expectedRevision/commandId，timeZone可选；原子确认书与计划，返回`{plan,settings,duplicate}` |
| `POST /study/sessions`              | 正式mode=daily或extra-review，commandId、expectedPlanRevision可选，size 1–20可选；返回`{session,plan,reason?,duplicate}`    |
| `GET /study/tasks`                  | status=active/completed/all，limit默认20、最大50，cursor可选；返回`{items,page:{total,hasMore,nextCursor}}`                 |
| `GET /study/sessions/:id`           | 本人固定任务，返回`{session}`                                                                                               |
| `POST /study/tasks/:id/state`       | action=pause/resume/defer、commandId、expectedSessionRevision；defer须含deferUntil                                          |
| `GET /study/forecast`               | 七个学习日的到期负担；返回days/asOf/assumption                                                                              |
| `GET /study/sessions`               | 兼容列表：最近最多10个in_progress或paused本人组；正式分页用/study/tasks                                                     |
| `POST /study/sessions/:id/commands` | commandId/itemId/action/expectedSessionRevision及动作参数；返回更新后的session                                              |

计划确认示例（expectedRevision来自预览的settingsRevision，字段示例是说明而非实际账户数据）：

```json
{
  "bookId": "<选中的本站词书ID>",
  "dailyTotalGoal": 30,
  "groupSize": 5,
  "timeZone": "Asia/Shanghai",
  "expectedRevision": 0,
  "commandId": "<本次确认独立UUID>"
}
```

preview包含bookId/bookTitle、dailyTotalGoal/groupSize、timeZone/pendingTimeZone、startsAt/endsAt、completedUnique/retainedAssignedCount、reviewPlanned/newPlanned及dueNowCount/dueTodayCount/overdueCount/unplannedOverdueCount。它是当前状态的只读预计，确认时重新核对revision并计算，不能当成已经签发的词组。

plan包含id/revision/localDate/timeZone/startsAt/endsAt、goal/bookId/bookTitle、dailyTotalGoal/groupSize，以及下列计数：

| 字段                                             | 含义                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| completedUnique / completedNew / completedReview | 当日已接受真实评分的不同词及其新学/复习分组；不是全部步骤完成、客观掌握或评分动作总次数 |
| assignedUnique                                   | 已分配到固定任务、尚未当日首次评分的不同词                                              |
| plannedReview / plannedNew                       | 当日复习与新学安排；保留的已签发承诺可能使它们超过降低后的目标                          |
| dueNowCount / dueTodayCount / overdueCount       | 当前已到期、学习日结束前到期（含逾期）、学习日开始前已逾期的词；范围互有包含，不相加    |
| unplannedOverdueCount                            | 仍未被当前计划安排的逾期词                                                              |
| pendingConsolidationCount                        | 今日已评分但FSRS处于学习/重学状态，且本学习日还会到期的不同词；未到期时继续等待         |
| pendingSpellingCount                             | 本人未完成固定组中已评分、尚未完成拼写的不同词；跨书重复项不重复计数                    |
| newRemaining / reviewRemaining                   | 可新增安排的新学量、未评分复习与巩固待办量；不能直接相加视为今日剩余unique预算          |
| nextDueAt / activeTaskId                         | 本学习日下一次未来到期时间、当前进行中的主任务ID，均可为null                            |
| recommendedTotal                                 | 当前总目标建议值；诊断推荐另见assessment.suggestedPlan                                  |

学习日保存为用户时区04:00到下一次04:00的实际startsAt/endsAt，使用左闭右开窗口，不假定始终24小时。变更时区从当前窗口结束后生效，新的窗口不与旧窗口重叠。session返回planId/taskKind、签发计划的learningDate/timeZone、createdAt/updatedAt/completedAt、pausedAt/deferredUntil及原revision/phase/cursor/step/currentItemId/items。无计划的legacy任务timeZone可为null，客户端应明确其显示时区。SessionItem新增bucket=new/review，legacy可为null。

mode=daily为可混合复习与新学的主任务；mode=extra-review为主动额外复习，不增加新学额度。额外复习的真实评分仍计入当日不同词数，允许超过主目标；同词再次评分不重复计unique。旧mode=learn/review和taskKind参数保留兼容，新客户端使用正式mode。服务端同类已有进行中组时返回该固定组，不创建副本；恢复暂停组须显式state/resume。任务列表游标绑定站点、用户与status，不能跨账户或查询复用。

pause保留固定内容、历史与未评分预约；deferUntil须为未来且不超过七天，任务变为paused，词条延后选择，真实FSRS dueAt和已有ReviewLog不修改。resume恢复同一任务并清除延期；同类另一组正在进行时返回409 `another_task_active`。降低目标、换书和跨日都不取消已签发组；昨日已经评分只剩拼写的项不会占新学习日词数，尚未评分的保留组仍按当前计划显示预约。

没有可立即签发项时session=null，reason可能为planned_reviews_pending（预留的复习稍后到期）、daily_goal_complete、no_new_words或nothing_due。这不代表所有已签发任务或未安排逾期词已经完成，客户端继续展示真实待办。

评分流程仍是当前item先reveal，再rate（again/hard/good/easy，必须含expectedProgressRevision）；整组评分后进入practice，当前题用answer。phase保持recall/practice/completed，step为prompt/revealed/exercise/completed。拼写只记录练习，不能写FSRS或伪造评分。巩固是到达真实FSRS dueAt后再回忆并评分，产生真实ReviewLog，不是重复增加当日词数，也不是将点击看答案当作复习成功。

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

commandId为8–120字符，推荐独立UUID，对同一用户全局去重；同内容重试不重复写评分，同编号不同内容返回idempotency_conflict。session/progress/plan的过期revision返回409；读取最新状态后核对再提交。接受评分更新FSRS/dueAt/ReviewLog；服务端不接受客户端自行改dueAt或记忆参数。Plan确认和任务状态也有幂等回执，状态响应含session/plan/duplicate。

forecast的days含localDate/startsAt/endsAt/dueUnique/overdueCarry。dueUnique是该窗口内当前持久dueAt的不同词，overdueCarry是该窗口开始前到期的不同词，两者不重叠，可相加显示单日负担。assumption固定current_due_dates_no_future_reviews：假设后续尚未复习，不计未来新学或预测复习成功。同词会出现在后续多个学习日，不能跨七天求和当作不同词总量。

离线队列只暂存待接受的动作。遇409持久标为冲突，可读取服务器最新任务，并逐条明确确认放弃该条未接受本地操作；不清其他队列、不删除服务器评分、不自动覆盖新revision。只有服务端接受的评分计入completedUnique。详情见 [每日任务](DAILY_TASKS.md) 和 [个性化规则](architecture/PERSONALIZATION.md)。

## 熟词声明、测试与个人统计

| 方法与相对路径                          | 主要参数与响应                                                       |
| --------------------------------------- | -------------------------------------------------------------------- |
| `POST /known-words/imports`             | format=text/csv/json，text；生成 preview，不立即标为熟词             |
| `GET /known-words/imports`              | 最近最多 50 个本人批次                                               |
| `POST /known-words/imports/:id/confirm` | JSON `{}`；只确认 matched，重复确认安全                              |
| `POST /known-words/imports/:id/revoke`  | JSON `{}`；撤销声明，保留已有学习进度                                |
| `GET /known-words/exports?format=json`  | json/csv；本人已确认声明按wordId去重，每1000行keyset批次流式完整导出 |
| `POST /assessments`                     | goal、size 1–20（抽样词数，每词拼写与认知两题）                      |
| `GET /assessments/:id`                  | 本人题目顺序/当前项；完成后 report                                   |
| `POST /assessments/:id/answers`         | commandId/itemId/answer；只接受当前题，动作去重                      |
| `POST /assessments/:id/finish`          | JSON `{}`；全部答完才结算 report/plan                                |
| `GET /mastery/plan?goal=daily`          | 本人对应目标的诊断证据与建议                                         |
| `POST /activity`                        | eventId/startAt/endAt；仅近期 1–60 秒前台心跳，去重                  |
| `GET /stats`                            | 今日/30日趋势、学习/复习/熟词声明数与达标天数                        |
| `GET /memory/curve`                     | 可选 bookId 或 goal；FSRS 预测、真实自评观察及 dataLimited           |

以上均要求登录。熟词每批 1–1,000 行、UTF-8 256 KiB 以内。text 每行一词；CSV 必須有 `lemma`/`word`/`单词` 列，可选 wordId/language；JSON 为字符串数组、对象数组或含 rows 的对象。预览区分 matched/unknown/duplicate。确认前如内容状态改变会要求重新预览。跨站导出是声明内容，不迁移账号、session、FSRS 状态或能力结论。

导出没有10,000行总量截断。JSON含 `consistency=cursor_export`、exportedAt和最终rowCount；CSV是UTF-8 BOM的声明表。导出不是跨批次事务快照，并发确认/撤销可能影响后续批次；需要稳定结果时在导出期间停止修改声明。

熟词声明降低新学优先级、保留抽查，不等于客观掌握。已有普通新词时，按累计预约/学习量约每5词安排1个熟词抽查，避免小组持续不抽查；只剩熟词候选时仍可抽查，均受每天不同词总预算的安排约束。目标测试按已安装goal范围和difficulty分层抽样，report包含totalCandidates/coveredPopulation/byStratum/accuracy/estimateScope；完整内容标 `limited_sample`，演示模式标 `limited_demo`。仅已测且全部答对的词进入验证证据，新报告suggestedPlan包含dailyTotalGoal/newWordSuggestion/reviewPressure/groupSize/countBasis=daily-unique-words，总量建议与新学建议分开；不自动改设置。历史报告的dailyNewLimit仅是当时的新学建议，不能直接当作总量。测试不产生ReviewLog或修改FSRS。报告不推断标准化考试能力。记忆曲线只使用真正评价后的状态，未产生复习数据时empty=true；阴影为词间分布，不是准确率保证或置信区间。stats超过20,000日志/区间、curve超过2,000 progress时会标dataLimited。

## 本站管理员

| 方法与相对路径                    | 主要参数与响应                                                                |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `GET /admin/overview`             | 本站 users/words/books/reviews/imports 计数                                   |
| `GET /admin/users`                | 最近最多 100 位，返回必要管理字段                                             |
| `PATCH /admin/users/:id`          | disabled 布尔值；停用时撤销 session，保护最后一位有效管理员                   |
| `GET /admin/books`                | 本站词书                                                                      |
| `POST /admin/books`               | slug/title/goal/wordIds，description/status 可选，默认 draft                  |
| `PATCH /admin/books/:id`          | 可选 title/description/goal/status/wordIds，保留旧会话快照                    |
| `GET /admin/words?q=rain`         | prefix检索本站词含未发布状态；limit 1–100默认50、cursor，items/page/matchMode |
| `PATCH /admin/words/:id`          | 可选 status/senseId/definitionZh/definitionEn/exampleEn/exampleZh             |
| `GET /admin/announcements`        | 最近最多 100 条                                                               |
| `POST /admin/announcements`       | title/body、可选 status                                                       |
| `DELETE /admin/announcements/:id` | JSON `{}`                                                                     |
| `GET /admin/audit`                | 最近最多 100 条管理审计                                                       |

这些接口必须role=admin，只管理本站；群站跨站能力必须另经目标管理员批准grant。没有配置全局Host/DB/secret的Web API。词书Web编排一次最多500个wordIds，不限制源完整书/分页；旧session保留快照，管理变更记录审计。公告与释义是文本。

词书/字典/生词本/admin词列表已分页，用户/公告/审计等接口仍有上述读取上限。operator可通过固定摘要的工具批量安装源内容；自定义词书使用前述标准文档导入，当前没有管理员通用内容上传、媒体上传或OpenAPI导出。生产客户端应固定版本并在升级时核对 [CHANGELOG](../CHANGELOG.md) 与 [部署文档](DEPLOYMENT.md)。

## 版本检测

| 方法与相对路径                    | 访问      | 契约                                                                        |
| --------------------------------- | --------- | --------------------------------------------------------------------------- |
| `GET /admin/system`               | 本站admin | version/siteId/instanceId/initialized/registrationOpen/update；读取保存状态 |
| `POST /admin/system/check-update` | 本站admin | JSON `{}`；从固定NightStudy GitHub Releases检测，返回update                 |

update包含status/checkedAt/latestVersion/releaseUrl/message/channel，另有cached/stale/lastSuccessfulAt。status为unchecked、up-to-date、available、ahead、no-release或failed。严格SemVer处理预发布数字、稳定版和build metadata；当前带预发布后缀时channel=prerelease，否则stable排除预发布。无该渠道Release时latestVersion=null/no-release，不用main提交冒充发布。失败保存错误与上次结果，lastSuccessfulAt不被失败续期。

各Realm PG记录以60秒冷却与条件锁避免同站副本重复检查；同一进程合并固定上游请求并短时缓存，不能称跨全部实例统一请求预算。接口只给发布说明链接，不提供shell执行、镜像下载安装或数据库降级。

## 群站配对与限权管理

以下入口均要求控制站admin。默认列出最近最多100条，创建票据须包含status:read；可选scope为users:read、users:write、settings:write、announcements:write。默认创建给出全部scope，管理员应按实际用途缩小授权。每站最多20张活跃票据，每张10分钟有效；最多100条活跃grant，连接记录总量最多100条（含revoked/forgotten）。远端用户摘要的name最多80字，历史长名称仅在返回时截断。

| 方法与相对路径                                                | 契约                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/fleet`                                            | pairingTokens/controllers/sites概要；不返回长期凭据                                                                                |
| `GET/POST /admin/fleet/pairing-tokens`                        | 读取票据元数据；POST label/scopes，返回仅本次可见token、10分钟有效期                                                               |
| `DELETE /admin/fleet/pairing-tokens/:id`                      | 撤销未消费票据；已换出的grant需独立撤销                                                                                            |
| `DELETE /admin/fleet/controllers/:id`                         | 在受控站撤销对应长期grant                                                                                                          |
| `GET/POST /admin/fleet/sites`                                 | 读取连接；POST url/token/label，将单次票据换成长授权并加密保存                                                                     |
| `POST /admin/fleet/sites/:id/refresh`                         | 刷新目标状态、版本、counts与更新状态；失败保留上次快照                                                                             |
| `DELETE /admin/fleet/sites/:id`                               | 请求目标撤销；确认后remoteRevoked=true，否则disconnect_pending，不能假报成功                                                       |
| `POST /admin/fleet/sites/:id/forget`                          | JSON `{ "acknowledgeRemoteGrantMayRemain": true }`；仅本地清密文/记forgotten，remoteRevocationConfirmed=false，允许同URL用新票重配 |
| `GET/PATCH /admin/fleet/sites/:id/settings`                   | 查看/设置registrationOpen；写须settings:write                                                                                      |
| `GET /admin/fleet/sites/:id/users`                            | users:read；limit1–100/cursor的用户摘要                                                                                            |
| `PATCH /admin/fleet/sites/:id/users/:userId`                  | users:write；disabled/commandId，保护最后有效管理员，停用撤销session                                                               |
| `GET/POST /admin/fleet/sites/:id/announcements`               | announcements:write；查看/创建title/body/status公告                                                                                |
| `DELETE /admin/fleet/sites/:id/announcements/:announcementId` | announcements:write；删除公告，可带commandId                                                                                       |
| `POST /admin/fleet/sites/:id/check-update`                    | status:read；检测该受控站Release，不安装更新                                                                                       |

跨站机器入口为POST /fleet/pair及/fleet/remote下的status/users/announcements/actions/unpair。兑换票据原子消耗，独立长期credential保存hash；控制端AES-GCM密文绑定本地/远端instanceId+siteId、连接、地址及grant。机器请求携Bearer及X-Nightstudy-Fleet-Instance/Site目标身份，不建立/转发浏览器Cookie。公共HTTPS443、规范basePath、验证DNS与固定实际拨号地址；拒绝私网/redirect/任意上游路径。

写动作registration.set、user.set-disabled、announcement.create/delete使用commandId与持久回执：同grant同编号同内容安全重试，内容变化409；客户端应在首次请求前生成并保留编号。updates.check为固定检测动作，由检查冷却约束。离线断开保留pending和凭据以便后续确认；网络失败不等于撤销。若管理员明确确认远端grant可能仍存在，可本地forget：清除密文、记forgotten并停止全部远程操作，返回remoteRevocationConfirmed=false；同URL可凭新票重配。远端仍可能需要管理员独立撤销旧grant。目标管理员撤销grant或发行管理员失去admin权限后，授权失效。域名/实例改变、密钥更换等恢复情况应按 [部署边界](DEPLOYMENT.md#群站与版本检测) 处理。

生词本列表默认50条、每页最多100条，返回items与page（total、hasMore、nextCursor），按updatedAt/id倒序游标读取全部收藏；游标绑定本站与用户。`GET /wordbook/:wordId`只返回本人精确收藏项或null，词卡不以列表首批推断收藏状态。词书预览和确认按真实媒体文件、摘要及格式检查两口音；每进程最多2场检查、共8个文件读并发，30秒批间期限到达返回book_import_busy以供重试。
