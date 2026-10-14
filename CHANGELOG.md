# Changelog

## 0.3.0-alpha.1 — 自动管理员与群站管理（验收中）

- 默认首次init创建用户名admin及本站随机初始密码；私密候选文件先落盘，再提交账号，支持失败后继续准备。既有管理员不被覆盖，manual模式保留/setup。完整初始凭据交付与恢复边界待本轮验证。
- Compose管理员凭据使用仅init挂载的独立卷，install.sh导出到服务器私密 `.local/admin/credentials.json`；Render首次密码由INITIAL_ADMIN_PASSWORD平台generateValue生成和保管。
- 仅导出DB身份、管理员账号与自动初始化审计匹配的凭据，未确认候选隔离留痕；明文记录保存初始密码，不随之后改密更新。
- 群站10分钟单次配对票据，事务消耗后换取独立长期grant；目标端保存hash，控制端AES-GCM加密保存，绑定实例/Realm/连接/目标地址/授权。状态、用户停用、注册开关、公告与更新检测按批准scope运行，保留审计和写动作去重。
- HTTPS公网外连、DNS检查及实际地址固定、响应/超时边界；每请求核对目标tuple。撤销与远端断开分开，未确认远端撤销时保留disconnect_pending，不假报已断开。
- 管理员明确确认后可仅本地忘记连接：清密文、停止远程动作并审计，remoteRevocationConfirmed=false；同URL可用新票重配，旧远端grant仍需独立处理。
- 固定仓库GitHub Release检测，严格SemVer与稳定/预发布渠道；无Release显示no-release，失败保留上次结果并标错误。PG保存各Realm结果与检查冷却；不会执行shell更新、自动安装或数据库降级。
- 参考广月的显式权限、配对与版本检测思路；NightStudy独立实现，没有复制其产品代码，证据见 [工程参考](docs/architecture/multisite-reference.md)。

本轮完整测试、CI、VPS发布与浏览器结果尚待验收。下面0.2的55项测试、容器与HTTP检查是历史基线，不代表0.3已经通过。

## 0.2.0-alpha.1 — 完整词典与在线翻译接入

- 固定版本 ECDICT 下载、SHA-256 校验、流式 CSV 解析、每站原子导入、来源许可元数据和五本目标词书；默认 Compose 初装完整内容，显式 demo profile 用于最小体验与测试。
- 实际导入 770,611 个词、1,113,723 条源词义；40 个已有词条 ID、原创例句、固定任务快照和学习历史保留，站点编辑不被字典安装覆盖。
- 独立 US/UK IPA 数据包，保留 MIT/BSD 与 GPL 3.0 源文件、许可证和版本校验；本机/VPS查询匹配 83,424 美音与 64,321 英音词及3个ready包。设备语音使用可用英美 voice，监听真实播放开始/结束/失败；不宣称真人录音。
- 词典前缀游标分页、完整多义项详情及词义/例句来源；词书和后台词条分页。大词书学习不再被前 1,000 词截断，熟词约每五个新组词抽查一个，熟词导出分批流式完整输出。
- 目标水平测试从完整目标范围按难度分层抽样，记录真实总体范围；不把小样本结论当标准化考试分数，不改写未测试词和 FSRS 历史。
- 站内 Google 网页兼容翻译面板、官方网页退路；固定上游 VPS 网关、私密鉴权、本站用户与网关总预算、8 并发上限、超时、响应边界、短时内存缓存及到期清理。
- 本机PG18.4及本版CI的55项测试通过，包括完整导出11,001条、超过首1,000词学习、熟词混合、空白释义保护、内容失败回滚/幂等和网关边界。[源码577f48b的CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38486206457) 同时通过格式/类型/构建、真实PG17/Compose完整内容安装、声明数量770,611核对、网关健康与未鉴权401检查。
- 目标VPS已部署0.2镜像、独立PG17、私密翻译网关及内容缓存，22项HTTPS生产HTTP检查通过：首页CSP/静态资产、完整词典/分页/英美IPA、Secure/HttpOnly注册Cookie、角色防提权/admin403、空曲线、5词固定会话及真实FSRS记录、官方翻译链接/网关429、退出与重新登录。临时学习账号已删除。共享TLS入口按精确Web域名登记，保留既有站点分流。
- 修复SPA的HEAD请求处理，`577f48b` 为本次已验收代码基线，本机及CI的格式/类型/构建、55项测试通过。VPS发布镜像 `nightstudy-english:0.2.0-alpha.1-577f48b` 成功，app/gateway容器重建健康、init退出0，770,611词和3包保留。外网HEAD首页200/HTML/CSP/no-store、HTTP→HTTPS301和site版本/公开地址检查通过；2026-10-14验收/交付时尚未初始化，管理员由部署者自行创建。
- 首份生产数据库归档140,510,271字节，文件权限0600/目录0700；实际恢复到独立临时DB后770,611词、3个ready包、SiteState singleton及siteId与主库一致，临时DB已删除。未修改主库，未因这次检查重启应用；不等于异机或密钥灾备验收。
- 0.2本机桌面额外验证词典分页、完整词义/来源、英美设备语音事件与Google错误展示。390×844手机学习实测属于0.1基线；0.2目前仅静态CSS检查，尚未新版手机或生产live验收。

边界：完整指固定ECDICT基础源全部条目；仍存在无中文释义、无音标或无例句的词，考试标签不等于官方完整大纲。Google公共兼容接口非官方，本机与目标VPS均实际遇到上游429；保留官方网页入口和备用网关，暂不接入收费API，不宣称加速可用。生产HTTP检查不等于新版手机live验收，容器重建的数据保留不等于主机断电恢复或跨机HA；异机/密钥灾备、Render、高并发容量和真人录音库尚未验收。容器ready或网关401不证明Google上游可用。

## 0.1.0-alpha.1 — 首版 alpha

首个新工程 alpha 已完成本机核心流程验证，尚未正式发行容器。本机 PG18.4 的 3 文件28测试、格式/类型检查及桌面/手机浏览器流程通过；PG17/Compose CI 与 Render 实际部署状态分别记录在 [README](README.md)，不混用本机与平台证据。

- React/TypeScript 雨夜风格 Web、响应式导航、账户与学习页面；Fastify 同一 Node 进程提供静态 Web 和 API。
- Better Auth 本站邮箱/密码 session；随机初始化口令创建首位管理员，本站用户停用与审计。
- operator 配置多站 host/basePath，每站独立 PG 认证/业务 DB 和密钥；独立 Compose project 可分别部署。独立 origin 才用于互不信任租户。
- 40 个原创演示词、五个目标演示词书；词书选择、固定内容快照学习会话、FSRS 评价与拼写练习。
- 学习动作编号去重、会话/进度 revision 冲突保护、PG 原子跨副本限流。
- 每日新词目标只约束新组的预约配额。已签发的一组可继续评价与拼写，中途降低目标不会阻止完成；同书并发新组排除已预约词，配额按同词去重并由服务端事务保护。计划返回 reservedNewCount，将待完成预约与真正学过的词分开。
- 默认 app 启动后及每60秒执行有界 PG lease 维护，独立worker共用入口；站点DB绑定校验、重试耗尽failed与批次清理。Render显式公网IP profile使用入口覆盖的单值合法CF-Connecting-IP，health探测例外；Realm始终以wire Host选站。
- 熟词 text/CSV/JSON 预览、确认、撤销、导出；声明与客观掌握分开。演示词表的拼写/认知测试及学习建议。
- 个人真实活动统计、FSRS 未来不复习假设曲线及自评回忆观察；无数据不填造趋势。
- 本站基本后台：用户停用、词书编排、词义/例句编辑、公告与审计。
- 同镜像 Web、独立 migration/seed job 和 PG lease worker；Compose minimal、可选 scale scaffold、Render 首站 Blueprint 与包含格式检查的 GitHub CI 描述。
- MIT 新代码许可、贡献/安全/行为文档和 issue/PR 模板。

尚未纳入本次 alpha：完整考试词库、ECDICT 只读 pack、音频/媒体 provider、邮件验证/找回、OAuth、完整内容批量导入、分页/OpenAPI、Redis provider、PgBouncer、活动 Realm LRU、跨主机 HA 与实测高并发容量。Render 资源创建/恢复、Docker/Compose 真机验证和正式镜像发行在完成前不标为通过。
