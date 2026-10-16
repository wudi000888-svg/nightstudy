# Alpha API 契约

对应当前0.11源码接口；最终版本的测试、发行与线上验收范围见 [README](../README.md) 和 [每日任务](DAILY_TASKS.md)，已记录的较早结果保留为历史证据。业务前缀为 `<basePath>/api/v2`，下表省略此前缀。根站basePath为空，子路径如/school-a；认证为 `<basePath>/api/auth`，手动初始化为 `<basePath>/setup`。

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

### H5 首页聚合

`GET /app/home` 要求当前站点登录，返回 `Cache-Control: no-store`。同一 serializable 事务及学习设置行锁内读取服务器时间、每日唯一词计划、可继续任务和学习日历；允许初始化/刷新当天计划，但不会签发学习组、写评价或制造签到。`userId` 等请求参数不能改变认证身份。

响应包含 `asOf/localDate/timeZone/startsAt/endsAt`、`checkedIn`、`dailyGoalComplete`、`plan`、`learn/review` 和 `calendar`。`plan` 提供计划 id/revision、词书、每日总词数、已完成唯一词数、待新学/复习、待拼写与短期巩固数；新学与复习共用每日总额，复习优先占位。`learn/review` 为 `{state,count,sessionId,sessionRevision,phase,availableAt}`；state 为 `setup/resume/ready/waiting/review_first/other_task/complete/empty`。`resume` 恢复原组与阶段；`waiting` 表示真实到期或延期时间，不能提前造题；`other_task` 明确另一现行组，客户端不另外创建冲突任务。

`calendar.days` 为含今天的最近 30 个学习日，提供 `localDate/checkedIn/completedGroups`，`calendar.streak` 按实际历史连续天数计算，不截断为 30 天。仅服务器已保存为 `completed` 的完整组，且每项已评价并完成该组签发时要求的拼写，才点亮完成时所在学习日；空组、只揭晓、待拼写与客户端待同步事件不算签到。关闭拼写的组不要求虚构练习记录。学习日使用计划记录的时区与 04:00 边界；跨日完成按完成时所在学习日计。签到与每日总目标达成分别判断，仍需短期巩固或拼写时不能显示整日完成。

| 方法与相对路径                      | 访问      | 主要参数与响应                                                                                                          |
| ----------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /books`                        | 访客/本人 | 公开已发布词书及登录用户本人的私有书；wordCount/learnedCount/coveredCount/claimedKnownCount/isDemo/visibility/ownedByMe |
| `GET /books/:id`                    | 访客/本人 | 公开书或本人私有书的book/items/page；limit 1–200，默认100；cursor按ordinal继续读取完整词书                              |
| `POST /books/:id/select`            | 用户      | JSON `{}`；更新 currentBookId 与 goal，返回 settings                                                                    |
| `GET /dictionary?q=rain&limit=20`   | 访客      | q/match/sort/limit/cursor；精简items、page、query、revision及显式拼写suggestions，规则见下文                            |
| `GET /dictionary/resolve?text=rain` | 访客      | 点词精确解析；word/queried/matchedLemma/matchType，未命中word=null                                                      |
| `GET /dictionary/stats`             | 访客      | ready数据包元数据；installedDictionary/countBasis/declaredEntryCount/packs                                              |
| `GET /dictionary/credits?q=rain`    | 访客      | 全部ready包来源与可选精确词条的原始来源/用法说明；不把独立语言义项冒称翻译对照                                          |
| `GET /words/:id`                    | 访客      | 已发布word详情：学习senses及各自examples、dictionarySenses原词典释义、可用英美音标/词音                                 |
| `GET /me/settings`                  | 用户      | settings                                                                                                                |
| `PATCH /me/profile`                 | 用户      | name；不允许修改 role/email/其他用户                                                                                    |
| `PATCH /me/settings`                | 用户      | 可选 goal/currentBookId/dailyTotalGoal/groupSize/timeZone/expectedRevision；旧dailyNewLimit仅作兼容                     |
| `GET /wordbook?limit=50&cursor=...` | 用户      | 本人词本；status=active/consolidated/all，支持q/match/sort/limit/cursor，默认最近更新                                   |
| `GET /wordbook/:wordId`             | 用户      | 读取本人精确收藏项或null，不用列表首批推断收藏状态                                                                      |
| `POST /wordbook`                    | 用户      | wordId与可选note；已有活动项返回added=false/alreadySaved=true，不覆盖笔记；重新加入毕业项恢复活动状态                   |
| `PATCH /wordbook/:wordId`           | 用户      | 可选 note/favorite/paused                                                                                               |
| `DELETE /wordbook/:wordId`          | 用户      | JSON `{}`；移除生词本项，保留学习进度                                                                                   |
| `GET /announcements`                | 访客      | 最近 20 条已发布公告                                                                                                    |

Word DTO保持canonical ID和实际collocations。`senses` 优先返回经来源核验的原子学习义项，每义有kind、contentVersion、bindingHash和仅属于自己的 `examples[]`；每句有稳定id、learningSenseId、contentVersion、contextLabel及英中句文。不再提供词级examples供前端拼接到任意义项。尚未关联的原句保留为candidate，不进入当前义项。无已核验学习义项时senses返回词典释义且examples为空；dictionarySenses另保留全部可见原词典释义。中英文若分属不同源Sense，不能假定为逐义配译。`meaningCoverage`区分实际原子义项、配句义项及词典源义项，不声称穷尽覆盖。`pronunciationCompatible=false`时音标和词音为空，独立媒体GET/HEAD也拒绝播放；它不影响正确绑定的整句音频。原始来源保留在credits及管理归档，普通学习界面不展示技术字段。

`GET /wordbook/:wordId`还返回collection：`inWordbook`为活动收藏状态，known为manual/automatic/null。生词本删除、软毕业和熟词来源均不删除FSRS历史；具体自动规则见 [内容与个人词本](CONTENT.md#生词本与熟词本)。

goal 取 `daily`、`ielts`、`cet4`、`cet6`、`high-school`。默认安装固定版ECDICT的770,611词及5本源目标词书；0.4生产内容准备归档旧演示书，40词身份、原创内容、历史学习和会话快照仍保留。目标书按上游标签/词频规则建立，不是官方完整考试大纲。`CONTENT_PACK=demo` 用于显式最小开发/测试数据。内容版本、许可和覆盖见 [CONTENT.md](CONTENT.md)。dailyTotalGoal 1–100，是每天复习与新学的不同词总目标；groupSize 1–20。timeZone 必须是有效 IANA 时区，学习日按当地04:00交接；时区改变返回pendingTimeZone/timeZoneEffectiveAt，下个学习日生效，不重切今日窗口。settings有revision；建议PATCH携带expectedRevision，过期返回409 `settings_conflict` 和最新settings。Settings中的旧dailyNewLimit兼容字段现在镜像总目标，不能继续理解为独立新词配额；与dailyTotalGoal同时提交但不相等时返回400 `conflicting_daily_goal`。网页选书使用下述原子计划确认入口，旧book select保留兼容。

`/dictionary/resolve` 接受text长度1–80，当前执行规范化精确匹配，返回 `matchType=exact` 或 `not-found`；没有前缀近似替代、后缀猜测或未经证实的原形推断。客户端可兼容未来有词典关系证据的 `inflection` 类型，但本轮不能把它描述为已实现的词形分析。未命中示例：`{ "word": null, "queried": "…", "matchedLemma": null, "matchType": "not-found" }`。

公共字典和本人生词本使用独立的查词契约：q最多160字符、按既有规则规范化，拒绝NUL；match=smart（默认）/exact/prefix/contains。contains必须能提取至少一段连续3个字母或数字，否则400 `query_too_short`；smart在此情况下退回prefix，并在query.effectiveMatch如实标出。sort=relevance/az/za，私人列表另有updated-desc；公共字典和带q的私人查询默认relevance，无q的私人列表默认updated-desc。公共字典limit默认20、范围1–50，私人列表默认50、范围1–100。公共字典不接受status或updated-desc。全部排序在完整匹配集的服务端执行，列表只带词形、精简定义、词性、匹配层和本人收藏摘要，不读取音频/例句完整图。

响应为items、`page={total,hasMore,nextCursor}`、规范条件query、revision和最多数个suggestions。total为当前主匹配集合精确计数，建议不混入总数；错拼建议不会自动替换q或打开近似词，systme可显式选择system。q只检索词形，不支持中文语义查询或词形还原。

查词游标有效15分钟，由服务端HMAC签名，绑定实例、站点、账户、公开/私人范围、关键词、匹配/排序/分类及catalog/collection revision。篡改、跨条件或跨身份400 `invalid_cursor`，过期410 `cursor_expired`，内容/收藏变化409 `list_changed`，客户端从第一页重新加载。每页RepeatableRead不代表跨HTTP事务快照；不在已变集合上继续旧游标。词书详情和admin检索保留各自keyset规则，不能与查词游标互用。完整词条由 `/words/:id` 独立读取。

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
| `GET /pronunciation/:wordId`               | 访客 | pronunciation：text/phonetics/audio/recordedAudioAvailable                                  |
| `GET /pronunciation/:wordId/audio/:accent` | 访客 | US或UK同源音频，验证文件/MIME头/SHA-256后返回媒体；ETag支持304                              |
| `GET /translation/provider`                | 访客 | provider的mode/transport/configured/unofficial/bestEffort/maxTextLength等，无网关URL或token |
| `POST /translation/website`                | 访客 | text/sourceLanguage/targetLanguage；返回Google官方网页链接及iframeSupported=false           |
| `POST /translation/text`                   | 用户 | 同一文本契约；配置后返回translation与website；本站用户共享PG限流20次/分钟                   |

发音接口只提供已安装音标、ready成品音源和recordedAudioAvailable，不返回generationAvailable或speech设备能力。`audio=[{id,accent,kind,url,status,sourceName,sourceUrl,license,attribution,mimeType}]`，accent为US/UK，kind为recorded/synthesized；URL是未添加挂载前缀的 `/api/v2/pronunciation/:wordId/audio/:accent`，客户端用本站mountUrl添加basePath，不接受任意外部字符串作为播放器源。WordDTO也有可选audio；旧会话快照没有该字段时读取fresh发音接口，不附带词义、不提前揭晓答案。

0.9删除实时prepare接口，缺音由维护者本机离线生成、验证并打包后安装；不提供浏览器语音备用入口。真人录音优先，合成不能覆盖现有recorded条目；没有可用文件时保持空列表与禁用播放状态。运行时逐项校验SHA/MIME及目录边界；32MiB字节缓存仍在每次打开描述符后核对inode、尺寸和纳秒时间戳，不能凭ETag绕过损坏或符号链接检查。音源范围见 [PHONETICS.md](PHONETICS.md)。

词音与句音支持单段 `Range: bytes=start-end`、开放结尾和后缀范围，成功返回206与Content-Range；不可满足的范围返回416。过长、格式不符或多段范围按整文件200处理。If-Range仅在当前强ETag匹配时采用范围；If-None-Match匹配返回304。HEAD返回整文件头而不返回媒体体。以上所有路径均先完成文件验证，适配移动浏览器的分段媒体加载。

翻译文本最多1,000个Unicode字符，sourceLanguage为auto/en/zh-CN（默认en），targetLanguage为en/zh-CN（默认zh-CN）。默认website-official仅提供官方网页入口，站内text返回503 `translation_not_configured`；生产站内结果使用带私密token的固定VPS网关，direct仅供本机开发。网页兼容provider返回 `google-web-compat` / `unofficial=true` / `bestEffort=true`，不是受支持的Google Cloud API。本机真实调用已遇到上游429；失败显示明确错误，不把离线词义冒充翻译。Google网页不能直接iframe，本站返回链接。原文会传送至配置网关/Google，不写翻译历史。配置、鉴权、超时的验证范围与尚待项见 [TRANSLATION.md](TRANSLATION.md)。

## 学习偏好、学习库、句库与笔记

以下接口均要求本站用户登录。用户与 Realm 由服务端会话决定；请求不能传入另一个 `userId` 或 `siteId`。列表使用 `items/page:{total,hasMore,nextCursor}`，游标绑定站点实例、用户和查询条件。

| 方法与相对路径                     | 主要参数与响应                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /learning-preferences`        | `{preferences}`；没有已保存偏好时返回默认值，不创建数据库行                                                    |
| `PUT /learning-preferences`        | `expectedRevision` 加需修改的偏好字段；返回 `{preferences}`，首次保存为 revision=1                             |
| `GET /library/words`               | view=learning/recent/learned，q、limit、cursor 可选；返回本人真实学习词条和进度                                |
| `GET /sentences`                   | q、wordId、limit、cursor 可选；本人收藏快照列表                                                                |
| `GET /sentences/status?wordId=...` | 返回 `{wordId,items:[{sourceType,sourceId,saved,sentenceId}]}`，一次核对当前源的精确收藏状态，不依赖列表第一页 |
| `POST /sentences`                  | `{sourceType:'word-example',sourceId,wordId?}`；只接受当前发布义项的同版双语例句，返回 `{sentence,duplicate}`  |
| `DELETE /sentences/:id`            | 无请求体或 `{}`；仅删除本人收藏，返回 `{deleted:true}`                                                         |
| `GET /notes`                       | q、wordId、limit、cursor 可选；本人笔记列表                                                                    |
| `GET /notes/:id`                   | 返回 `{note}`，其他用户或不存在的笔记返回404                                                                   |
| `POST /notes`                      | `{title,body,wordId?}`；返回 `{note}`                                                                          |
| `PATCH /notes/:id`                 | `{expectedRevision,title?,body?,wordId?}`；wordId 可设为 null，返回 `{note}`                                   |
| `DELETE /notes/:id`                | `{expectedRevision}`；返回 `{deleted:true}`                                                                    |

偏好默认值为 `theme:'day'`、`accent:'us'`、`autoPlay:false`、`spellingEnabled:true`、`fontScale:1`、`reminderEnabled:false`、`reminderTime:'20:00'`、`revision:0`。theme 可选 day/night/system，accent 可选 us/uk，fontScale 只接受 1/1.125/1.25，reminderTime 为24小时制 HH:mm。PUT 使用独立于每日计划设置的 revision；过期或并发首次保存返回409 `learning_preferences_conflict`，details.preferences 是当前值。提醒仅是打开页面时的本地偏好，不代表服务器推送能力。拼写开关只影响之后签发的新学习组，现有组保留签发时的值。

学习库、句库、笔记列表默认50条、最多100条，q 最长120字符。学习库只列存在真实 firstLearnedAt 的已发布词；learning 排除本人暂停的词，recent 限最近30天有真实评价的词，learned 列全部已学词。每项含 word、progress、reviewedAt、dueAt、learnedAt、reviewCount、paused；reviewCount 不包含首学评价，学习库摘要只带有限释义与例句。

句库新收藏仅接受当前已发布词的WordExample，必须绑定同词、同内容版本、来源摘要仍核对通过的published LearningSense，且语境及英中句文均非空；旧词级句和内嵌Sense句不能新加入。历史收藏只读保留，不接受客户端提交自写例句或伪造来源。收藏保存句文、对应义项及版本快照，源编辑不会回写已有快照。同源同内容并发收藏去重；源正文或归因变化后，当前版本可能显示未收藏，旧快照仍在句库中。状态接口最多读取1000个有效源，超限返回413 `sentence_sources_limit`，不会静默截断。每人最多5000句，超限429 `sentence_limit`；源不可见、空句、挂起或被排除时404 `sentence_source_not_found`。收藏项包含 id、wordId、sourceType/sourceId、exampleEn/exampleZh、metadata、createdAt；源词被删除后 wordId 可为 null。

笔记 title 去空白后1–120字符，body 为1–20000字符纯文本，不接受 NUL；每人最多1000篇，超限429 `note_limit`。可关联本站已发布 canonical word，不能借关联读取他人的私有词书关系。每项含 id、wordId、title、body、revision、createdAt、updatedAt；更新或删除时版本冲突返回409 `note_conflict`，details.note 为当前笔记。错误游标或多余请求字段返回400；本人不存在或非本人资源返回404。

## 学堂与独立练习记录

学堂为原创入门短课，提供 reading、shadowing、listening、topic 四类，不代表完整考试课程。所有下列接口要求本站登录。

| 方法与相对路径                      | 主要参数与响应                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /academy`                      | 可选 category；返回课程摘要 items，含 completedAttempts、lastCompletedAt、audioAvailable |
| `GET /academy/:id`                  | `{lesson}`，含原创双语 body、vocabulary、版本、类别和完成方式                            |
| `POST /academy/:id/attempts`        | `{commandId,accent?:'us'或'uk'}`；返回 `{attempt,duplicate}`，固定本次课程与题目快照     |
| `GET /academy/attempts`             | limit 默认20、最多100，cursor 可选；返回本人练习历史 items/page                          |
| `GET /academy/attempts/:id`         | `{attempt}`；刷新或跨端恢复同一次练习                                                    |
| `POST /academy/attempts/:id/submit` | `{commandId,expectedRevision,answers?:[{itemId,answer}]}`；返回 `{attempt,duplicate}`    |

attempt 含 id、lessonId/lessonVersion、kind、status、revision、startedAt/completedAt、lesson 快照、items、result。status 为 in_progress/completed；开始时 result 为 null。听力题只返回 id、prompt、audioUrl、accent 和随机选项 `{id,text}`；answer 必须是该题的选项 ID，所有题都作答后才能提交。服务器使用固定快照评分，完成后才返回 objective-listening 的 score/total/correct/feedback。创建听力练习会实际核验所选口音音源，缺失或损坏返回503 `academy_audio_not_ready`，不创建假练习记录。

阅读、跟读、专题只记录完成，result.assessmentKind 为 completion-only，score/total/correct 均为 null，不接受选择题答案；设备跟读功能不提供服务器口语评分。学堂完成不写 FSRS、ReviewLog、每日计划或熟词证据。开始和提交均使用稳定 commandId 去重；同编号不同内容409 `idempotency_conflict`，已提交练习再次使用其他动作编号409 `academy_already_submitted`，过期 revision 返回409 `academy_attempt_conflict`。听力未完整作答400 `academy_answers_incomplete`；非听力提交答案400 `academy_answers_not_applicable`。每人最多1000条练习记录，超限429 `academy_attempt_limit`；非本人练习返回404。

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
| pendingSpellingCount                             | 本人开启拼写的未完成固定组中已评分、尚未完成拼写的不同词；跨书重复项不重复计数          |
| newRemaining / reviewRemaining                   | 可新增安排的新学量、未评分复习与巩固待办量；不能直接相加视为今日剩余unique预算          |
| nextDueAt / activeTaskId                         | 本学习日下一次未来到期时间、当前进行中的主任务ID，均可为null                            |
| recommendedTotal                                 | 当前总目标建议值；诊断推荐另见assessment.suggestedPlan                                  |

学习日保存为用户时区04:00到下一次04:00的实际startsAt/endsAt，使用左闭右开窗口，不假定始终24小时。变更时区从当前窗口结束后生效，新的窗口不与旧窗口重叠。session返回planId/taskKind、签发计划的learningDate/timeZone、createdAt/updatedAt/completedAt、pausedAt/deferredUntil及原revision/phase/cursor/step/currentItemId/items。无计划的legacy任务timeZone可为null，客户端应明确其显示时区。SessionItem新增bucket=new/review，legacy可为null。

mode=daily为可混合复习与新学的主任务；mode=extra-review为主动额外复习，不增加新学额度。额外复习的真实评分仍计入当日不同词数，允许超过主目标；同词再次评分不重复计unique。旧mode=learn/review和taskKind参数保留兼容，新客户端使用正式mode。服务端同类已有进行中组时返回该固定组，不创建副本；恢复暂停组须显式state/resume。任务列表游标绑定站点、用户与status，不能跨账户或查询复用。

pause保留固定内容、历史与未评分预约；deferUntil须为未来且不超过七天，任务变为paused，词条延后选择，真实FSRS dueAt和已有ReviewLog不修改。resume恢复同一任务并清除延期；同类另一组正在进行时返回409 `another_task_active`。降低目标、换书和跨日都不取消已签发组；昨日已经评分只剩拼写的项不会占新学习日词数，尚未评分的保留组仍按当前计划显示预约。

没有可立即签发项时session=null，reason可能为planned_reviews_pending（预留的复习稍后到期）、daily_goal_complete、no_new_words或nothing_due。这不代表所有已签发任务或未安排逾期词已经完成，客户端继续展示真实待办。

评分流程仍是当前item先reveal，再rate（again/hard/good/easy，必须含expectedProgressRevision）。session.spellingEnabled 为签发时偏好快照；开启时整组评分后进入practice，当前题用answer；关闭时最后一次真实评分后直接completed，exerciseDone 保持 false，不伪造已完成拼写。phase保持recall/practice/completed，step为prompt/revealed/exercise/completed。拼写只记录练习，不能写FSRS或伪造评分。巩固是到达真实FSRS dueAt后再回忆并评分，产生真实ReviewLog，不是重复增加当日词数，也不是将点击看答案当作复习成功。

接受真实rate时同步返回collection：inWordbook、known及本次transition（graduated/auto-known/auto-known-withdrawn/restored/null）。自动分层只依真实FSRS Review状态、stability与最近Again之后的不同学习日Good/Easy复习，不把首学、拼写或重复回执当作新证据；14天/3日与90天/5日规则见 [内容说明](CONTENT.md#生词本与熟词本)。

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

| 方法与相对路径                          | 主要参数与响应                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /known-words?limit=50&cursor=...`  | 本人熟词列表；默认50、最多100；items/page，manual与automatic同词去重且manual优先       |
| `POST /known-words/imports`             | format=text/csv/json，text；生成 preview，不立即标为熟词                               |
| `GET /known-words/imports`              | 最近最多 50 个本人批次                                                                 |
| `POST /known-words/imports/:id/confirm` | JSON `{}`；只确认 matched，重复确认安全                                                |
| `POST /known-words/imports/:id/revoke`  | JSON `{}`；撤销声明，保留已有学习进度                                                  |
| `GET /known-words/exports?format=json`  | json/csv；本人已确认手动声明与活动自动熟词按wordId去重，每1000行keyset批次流式完整导出 |
| `POST /assessments`                     | goal、size 1–20（抽样词数，每词拼写与认知两题）                                        |
| `GET /assessments/:id`                  | 本人题目顺序/当前项；完成后 report                                                     |
| `POST /assessments/:id/answers`         | commandId/itemId/answer；只接受当前题，动作去重                                        |
| `POST /assessments/:id/finish`          | JSON `{}`；全部答完才结算 report/plan                                                  |
| `GET /mastery/plan?goal=daily`          | 本人对应目标的诊断证据与建议                                                           |
| `POST /activity`                        | eventId/startAt/endAt；仅近期 1–60 秒前台心跳，去重                                    |
| `GET /stats`                            | 今日/30日趋势、学习/复习/熟词声明数与达标天数                                          |
| `GET /memory/curve`                     | 可选 bookId 或 goal；FSRS 预测、真实自评观察及 dataLimited                             |

以上均要求登录。熟词每批 1–1,000 行、UTF-8 256 KiB 以内。text 每行一词；CSV 必須有 `lemma`/`word`/`单词` 列，可选 wordId/language；JSON 为字符串数组、对象数组或含 rows 的对象。预览区分 matched/unknown/duplicate。确认前如内容状态改变会要求重新预览。跨站导出是声明内容，不迁移账号、session、FSRS 状态或能力结论。

列表每项提供wordId、word、origin=manual/automatic、knownAt和progress，page含total/hasMore/nextCursor，游标绑定本站及本人。自动熟词在Again时撤回，但手动声明独立保留；撤销手动批次也不顺带删除仍有效的自动来源。统计区分总去重熟词、手动熟词与仅自动来源，不把导入或自动分类当作新增ReviewLog。

导出没有10,000行总量截断。JSON含 `consistency=cursor_export`、exportedAt和最终rowCount；CSV是UTF-8 BOM的声明表。导出不是跨批次事务快照，并发确认/撤销可能影响后续批次；需要稳定结果时在导出期间停止修改声明。

熟词声明降低新学优先级、保留抽查，不等于客观掌握。已有普通新词时，按累计预约/学习量约每5词安排1个熟词抽查，避免小组持续不抽查；只剩熟词候选时仍可抽查，均受每天不同词总预算的安排约束。目标测试按已安装goal范围和difficulty分层抽样，report包含totalCandidates/coveredPopulation/byStratum/accuracy/estimateScope；完整内容标 `limited_sample`，演示模式标 `limited_demo`。仅已测且全部答对的词进入验证证据，新报告suggestedPlan包含dailyTotalGoal/newWordSuggestion/reviewPressure/groupSize/countBasis=daily-unique-words，总量建议与新学建议分开；不自动改设置。历史报告的dailyNewLimit仅是当时的新学建议，不能直接当作总量。测试不产生ReviewLog或修改FSRS。报告不推断标准化考试能力。记忆曲线只使用真正评价后的状态，未产生复习数据时empty=true；阴影为词间分布，不是准确率保证或置信区间。stats超过20,000日志/区间、curve超过2,000 progress时会标dataLimited。

## 本站管理员

| 方法与相对路径                    | 主要参数与响应                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/overview`             | 本站 users/words/books/reviews/imports 计数                                                                         |
| `GET /admin/users`                | 最近最多 100 位，返回必要管理字段                                                                                   |
| `PATCH /admin/users/:id`          | disabled 布尔值；停用时撤销 session，保护最后一位有效管理员                                                         |
| `GET /admin/books`                | 本站词书                                                                                                            |
| `POST /admin/books`               | slug/title/goal/wordIds，description/status 可选，默认 draft                                                        |
| `PATCH /admin/books/:id`          | 可选 title/description/goal/status/wordIds，保留旧会话快照                                                          |
| `GET /admin/words?q=rain`         | prefix检索本站词含未发布状态；limit 1–100默认50、cursor，items/page/matchMode                                       |
| `GET /admin/words/:id`            | 本站任意状态的完整原始词条，含全部Sense和held来源，返回word；不用列表摘要代替编辑详情                               |
| `PATCH /admin/words/:id`          | 可选status/senseId/expectedContentVersion/definitionZh/definitionEn/exampleEn/exampleZh；合并后的中英文至少一项非空 |
| `GET /admin/announcements`        | 最近最多 100 条                                                                                                     |
| `POST /admin/announcements`       | title/body、可选 status                                                                                             |
| `DELETE /admin/announcements/:id` | JSON `{}`                                                                                                           |
| `GET /admin/audit`                | 最近最多 100 条管理审计                                                                                             |

这些接口必须role=admin，只管理本站；群站跨站能力必须另经目标管理员批准grant。没有配置全局Host/DB/secret的Web API。词书Web编排一次最多500个wordIds，不限制源完整书/分页；旧session保留快照，管理变更记录审计。公告与释义是文本。

词条编辑先GET完整raw详情并明确选择senseId，不能从最多三义的列表摘要推断默认目标。中文或英文可为空，但两者合并后全空返回400 sense_definition_required；其他词的senseId返回400 sense_not_in_word。提供expectedContentVersion时，过期返回409 word_content_changed且不写词条或审计；重新载入后校对，不自动重试旧编辑。归档词仍可由本站管理员读取，公开详情返回404。

词书/字典/生词本/admin词列表已分页，用户/公告/审计等接口仍有上述读取上限。operator可通过固定摘要的工具批量安装源内容；自定义词书使用前述标准文档导入，当前没有管理员通用内容上传、媒体上传或OpenAPI导出。生产客户端应固定版本并在升级时核对 [CHANGELOG](../CHANGELOG.md) 与 [部署文档](DEPLOYMENT.md)。

## 可选 AI 管理接口

全部要求本站admin。`provider=deepseek`保留官方固定地址与deepseek-flash/deepseek-v4-pro模型；`provider=custom`支持CC Switch供应商的baseUrl、实际model、四种protocol（openai-chat/openai-responses/anthropic-messages/gemini）及匹配的authMode（bearer/x-api-key/x-goog-api-key）。默认无key、不请求，保存配置不调用上游；管理员主动test/preview或学习者选择已启用的测试分析时使用对应供应商额度。

| 方法与相对路径                    | 契约                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/ai/deepseek`          | enabled/assessmentEnabled/configured/provider/model/models/baseUrl/protocol/protocols/authMode/authModes/keyPreview/updatedAt；不返回明文key |
| `PUT /admin/ai/deepseek`          | enabled?/assessmentEnabled?/provider?/baseUrl?/protocol?/authMode?/model?/apiKey?/removeKey?；删除key同时禁用，空key仅在原目的地保留         |
| `POST /admin/ai/deepseek/test`    | JSON `{}`；主动检查，官方最多32、自定义最多512输出tokens，返回ok/provider/model/usage                                                        |
| `POST /admin/ai/deepseek/preview` | `{wordId}`；已发布单词的缺项候选，preview包含definitions/examples/review/applied=false，另有usage                                            |

预览不修改词典或FSRS，也没有候选应用接口。无缺项返回reason=no_missing_content/usage=null，不调用上游；同Sense空字段及原文SHA校验，源文/配置/权限变化时丢弃候选。单次20秒/64KiB、最大2400输出tokens，无自动重试；站点20次/分钟、管理员6次/分钟，site2/actor1并发lease。配置与加密/备份边界、收费责任及受控上游测试范围见 [AI_CONFIGURATION.md](AI_CONFIGURATION.md)。

输入key支持8–4096可打印ASCII字符，不要求sk前缀；baseUrl最多2048字符，model最多160。已有key时更换provider/baseUrl/protocol/authMode必须提供新key或removeKey=true（同时关闭），不能将旧key自动发往新目的地。默认仅公网HTTPS，审核全部DNS并固定连接IP；operator可用部署环境的AI_PRIVATE_ENDPOINTS_JSON授权精确origin+固定IP的代理，HTTP请求不能提供该权限。CC Switch的代理占位值默认拒绝，仅相应operator受信任入口允许；Google OAuth账号授权不属于APIkey兼容范围。

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

### 水平测试可选智能分析

`GET /assessments/capabilities` 要求登录，返回 `{aiAvailable: boolean, aiServiceName: string, aiServiceOrigin: string|null, aiConfigurationRevision: string|null}`，只读取当前站点开关、配key与合法配置状态，不验证上游在线状态；服务来源仅origin，不含key或上游usage。`PUT /admin/ai/deepseek` 的 `assessmentEnabled` 独立默认关闭；关闭服务总开关或删除key会关闭此功能。

`POST /assessments/:id/finish` 接受严格 JSON `{useAi?: boolean, expectedAiConfigurationRevision?: string}`。只有显式 `useAi: true`、确认时的64位十六进制配置revision与当前一致且管理员开关与密钥都可用时才尝试；缺失或过期revision只返回基础成绩与configuration_changed，不把答案发往新服务。省略useAi的旧客户端仍只获取本地报告。前端应让学习者明确选择并显示发送本次目标、题目和答案的说明；配置改变后撤销旧勾选，须重新确认。客观计分始终先完成，原 `report.accuracy`、`verifiedWordIds`、`byStratum` 与 `suggestedPlan` 保持；另返回 `report.aiAnalysis`：

```json
{
  "status": "available",
  "payload": {
    "summary": "本次认知较稳，仍需巩固拼写。",
    "strengths": ["能辨认已测试的常见词义。"],
    "weaknesses": ["个别词尾容易遗漏。"],
    "wordFeedback": [
      { "wordId": "本次测试中的词条ID", "lemma": "rain", "suggestion": "听音后独立拼写。" }
    ],
    "suggestedPlan": { "dailyTotalGoal": 24, "groupSize": 5 }
  },
  "reason": null,
  "generatedAt": "ISO时间"
}
```

其它状态为 `pending`、`disabled`、`unavailable`，此时 `payload: null`。`reason` 只使用稳定状态：`not_enabled`、`not_requested`、`busy`、`unavailable`、`invalid_response`、`configuration_changed`、`interrupted` 或 `null`。未知词条、重复词反馈、超限计划或不合格结构均不会成为可用建议。反馈的可选 `lemma` 由服务器对应拼写题快照补入，模型不能提交或替换词形。建议总目标最少 20、最大 100，并保留复习压力下限；组大小为 1–20，需用户自行采用。

每份测试最多一次上游尝试；完成请求重发和 `GET /assessments/:id` 不重新调用。90 秒的旧 claim 只降级为中断，不启动第二次请求。模型失败时返回正常本地成绩；鉴权或所有权失效仍返回 401/404，不能用降级绕过私有报告权限。用户响应不含内部 claim、usage、模型或密钥，AI 不修改客观成绩、学习设置、熟词或真实复习历史。

## 0.9 句子朗读与首页壁纸

| 方法与相对路径                                | 访问   | 契约                                                                                                                             |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /sentence-audio/:textHash`               | 访客   | `{sentence:{textHash,text,audio}}`；textHash为规范英文全文SHA-256，未安装时text=null、audio=[]。                                 |
| `GET /sentence-audio/:textHash/audio/:accent` | 访客   | accent=US/UK，只播放当前站已安装成品，缺音404；字节校验和ETag规则与词音一致。                                                    |
| `GET /appearance`                             | 访客   | `{appearance:{mode,imageUrl,positionX,positionY,overlay,animationEnabled,revision}}`。                                           |
| `GET /admin/appearance`                       | 管理员 | 同上；有图片时即返回本站挂载路径内hash URL，mode只控制当前是否选用。                                                             |
| `PUT /admin/appearance`                       | 管理员 | 严格JSON：expectedRevision以及mode/positionX/positionY/overlay/animationEnabled；不接收imageUrl。                                |
| `POST /admin/appearance/wallpaper`            | 管理员 | expectedRevision/fileName/contentType/dataBase64；仅静态JPEG/PNG/WebP、输入≤4MiB、≤2000万像素；重编码≤1920×2560 WebP并去元数据。 |
| `POST /admin/appearance/reset`                | 管理员 | `{expectedRevision}`；清除本站图片并恢复原创雨夜配置。                                                                           |
| `GET /appearance/wallpaper/:sha256.webp`      | 访客   | 当前图片的内容寻址URL，image/webp、ETag与公开缓存；仅在本站独立数据库查找，支持HEAD。                                            |

句子规范化为NFKC、弯引号转ASCII、折叠空白及去首尾空格，保留大小写；同样规则用于本机生成器、API和浏览器。没有接受任意文本并在线合成的接口。朗读元数据不混入FSRS、收藏、学习完成或口语评分。

外观mode为rain-night/custom，位置0–100，overlay为0–0.85。首次revision=0，成功更新加1；旧版本返回409 appearance_conflict，必须读取新配置，不静默覆盖另一管理员的修改。JSON只影响站点公共外观，客户端不能指定站点、账户或数据库。上传失败不改当前壁纸，恢复默认也要求版本一致。

目标枚举：daily/ielts/toefl/cet4/cet6/tem4/tem8/postgraduate/gre/high-school。社区考试词表是内容集合，不是官方大纲认证；词书安装和词义、句音覆盖分别统计。
