# Alpha 运行与部署

本文件描述已部署的 `0.5.0-alpha.2`。代码2918aa9的25文件162项测试、9项Python回归、格式/类型/构建及 [双PG17/Compose CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38517645764) 通过；本轮VPS165项真实HTTPS任务检查通过。下面保留各历史版本的对应证据。Render、主机断电恢复、异机/密钥灾备、高并发容量及音源逐条专家听辨未验收。

## Docker Compose minimal

需要Docker Engine、现代Docker Compose及openssl。标准首次安装：

```sh
bash scripts/install.sh
```

脚本仅在不存在.env时生成配置，分别生成随机PG密码、认证密钥及初始化口令，并持久化所选Compose project、端口和PUBLIC_URL。已有.env保留，升级前按自己的配置审阅；脚本不改Nginx/TLS。自定义公开域名可在首次执行前设置 `PUBLIC_URL=https://english.example.com`，相应HTTPS入口由operator配置。

默认PUBLIC_URL为 `http://127.0.0.1:5198`，app内部监听3000，PG不发布主机端口。已自行填写私有.env的部署也可手动执行准备与导出：

```sh
docker compose config --quiet
docker compose up --build --detach --wait --wait-timeout 600 app
# 用install.sh完成私密凭据导出；直接compose启动不会在宿主机生成导出文件。
```

`init` 运行 `pnpm db:prepare`：generate、全站迁移、seed、首次管理员准备，再按CONTENT_PACK安装内容，并运行audio:prepare安装所选音频包与模型。默认ecdict会校验完整ECDICT及独立英美IPA并逐站事务安装；成功后app启动，请求进程不重复迁移/创建管理员。默认ADMIN_BOOTSTRAP=auto，新站用户名admin、独立随机密码；已初始化站点不重置账号。manual模式跳过自动创建，保留BOOTSTRAP_TOKEN和/setup。CONTENT_PACK=demo显式跳过完整包，CI基础测试用manual/demo。

## 初始管理员凭据

自动模式先在私密目录持久化候选凭据，再提交账号；失败重试复用候选，既有管理员不改密。候选必须与已初始化本站、对应admin用户及自动初始化审计匹配，才可导出；未确认候选留私密记录，不作为有效登录凭据交付。

Compose的admin-credentials卷仅init挂载到 `/app/.local/admin`，Web/app/worker不挂载。install.sh在成功准备后导出已确认的当前Realm记录到宿主机 `.local/admin/credentials.json`，目录0700、文件0600。只由operator读取并备份，不通过Web下载或提交Git。多站每站生成独立随机密码与 `<siteId>.credentials.json`；Native默认保存于本机.local/admin。单站可私有设置INITIAL_ADMIN_PASSWORD/INITIAL_ADMIN_EMAIL；多Realm拒绝共用这两个覆盖值。

这些文件记录创建时的**初始密码**，用户之后改密不会同步更新明文记录；维护既有站点也不会强制重置。既有手工管理员没有自动生成的初始文件，继续用其原账号。恢复业务DB时同时保管对应认证密钥与初始交付资料，密码哈希不能反推出明文。

PG业务数据、内容源缓存与音频分别保存在postgres-data、content-cache、audio-cache named volume；源缓存挂载 `/app/.local/content`，不塞入Git或应用镜像。词典源首次下载约71MB；默认英美音频另下载固定校验的audio-v1预生成包与约229MB的两份模型，具体音频包大小以data/audio-pack.manifest.json为准，安装耗时取决于网络与机器。音频卷挂载/app/.local/audio，init与app共用；它包含来源清单、逐条许可、校验后的媒体和模型，不含初始管理员凭据。重跑会校验缓存，媒体丢失或摘要失败时从固定包恢复；数据库逐站事务导入，仅补空IPA，不改已有音标、词义、状态或学习进度。等待600秒是CI smoke等待上限，不是承诺安装时间；超时先检查init日志再决定增加等待。重复准备验证缓存与已安装pack，保留历史和管理编辑；摘要失败停止安装。离线内容导入、来源许可与目标书规则见 [CONTENT.md](CONTENT.md)，独立音标见 [PHONETICS.md](PHONETICS.md)。

本机全量库实测Word770,611、追加源Sense1,113,723、5本新目标词书，原40词ID和历史保留。本机/VPS查询US IPA匹配83,424词、UK匹配64,321词及3个ready包；至少一种现代IPA匹配104,261词；含原始音标的任一种音标覆盖256,047词。该安装数据库约974,468,799字节（约975MB）；这是一次本机数据体量记录，不能推断最小磁盘、内存或并发容量。各站各存一份核心词义和进度，另需预算WAL、索引、备份及升级空间。

检查 `/health/live`、`/health/ready` 和 `/api/v2/dictionary/stats`；子路径API添加basePath。ready不代替内容数量验收。查看init/app日志，分享前移除凭据和个人数据。`docker compose down` 保留named volume；`down --volumes` 删除业务DB、内容/音频缓存与初始凭据卷，仅用于可丢弃测试。

默认 app 监听启动后及每 60 秒执行有界 PG lease 维护，清理过期限流/session/verification与旧任务；先核验本站 DB 绑定，同一任务由 lease 竞争执行。重试耗尽标记 failed，各表每次清理有批次上限。minimal 与 Render 无需额外维护 worker；scale/独立 worker 可复用同一维护入口，不重复消费同一个有效 lease。它仍只是维护任务入口，未实现大型内容异步导入。

生产使用已配置的 HTTPS 入口转发到回环端口，设置真实 `PUBLIC_URL=https://...` 并明确可信代理 CIDR。已有网站占用 443 时不启用第二个抢占端口的入口；先清点配置、生成审阅片段和回滚计划。[官方 Compose 启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)

可信入口须保留或显式设置实际请求的规范 `Host`，并覆盖或按已核验的链规则处理来自客户端的 forwarded IP/proto；不能仅因为 app 信任某个 CIDR 就透传外部任意值。Realm 始终按 wire Host 选择，不使用 X-Forwarded-Host；socket IP profile 使用 Fastify 按 TRUST_PROXY_CIDRS 解析后的 IP。额外反代接在 scale Caddy 前时，也需配置 Caddy 的可信链；否则 Caddy 默认将该反代当作客户端，正常用户可能共享同一限流桶。伪造 forwarded host 不应切换站点，伪造 forwarded IP 不应绕过限流。

## 共享TLS入口与已有站点共存

服务器已有443 TLS/SNI分流时，新Web域名必须同时登记在上层入口的精确域名映射与Web反代中；仅新增Nginx的server_name不能让上层分流自动识别它。保留已有域名、默认分流和监听边界，先保存可恢复配置，再检查入口/反代配置并分别探测新旧站点。数据库和应用仍由自己的Compose project维护，入口共存不合并认证Realm。

当前公开Web域名为 `english.minminlove.top`。若重新生成已有广月stream入口，须保留原完整配置参数及 `--web-domain english.minminlove.top`，让这个域名继续转入Web TLS入口；参数丢失会使上层SNI路由失去该站映射。按已安装生成器版本核对参数，检查配置后再加载，并验证HTTPS health及既有站点。公开文档只记录域名和通用共存规则，不包含连接凭据或主机私有配置。

## 独立多站部署

在同一服务器部署多份时，每份使用不同 Compose project、主机端口、密钥及 PUBLIC_URL，例如通过 `docker compose -p school-b ...` 选择另一 project，并在其私有配置中设置 `NIGHTSTUDY_HTTP_PORT=5199`。每份 project 拥有自己的 PG volume；不要克隆运行数据库和密钥来创建新身份。

真正互不信任的站点使用不同 domain/subdomain。同 origin 的 `/a`、`/b` 只用于同信任域内的共存，不能提供浏览器强隔离。Cookie Path、prefix 和 storage key 可防止无意混用，但不改变浏览器 origin 边界。

## 共享后端多 Realm

每 site 使用独立完整 PG DB（含 Better Auth 与学习数据），operator 通过受控配置把 host/base path 映射到固定连接。`.local/sites` 只读挂载到容器 `/run/nightstudy/sites`。设置 `SITES_FILE=/run/nightstudy/sites/sites.json`；配置文件须由部署进程可读，且不提交。

文件格式为数组，字段如下；这里只展示非秘密映射，连接与 token 通过环境变量引用：

```json
[
  {
    "id": "school-a",
    "title": "夜读英语 A",
    "publicUrl": "https://a.example.com",
    "basePath": "",
    "hosts": ["a.example.com"],
    "databaseUrlEnv": "SITE_A_DATABASE_URL",
    "authSecretEnv": "SITE_A_AUTH_SECRET",
    "bootstrapTokenEnv": "SITE_A_BOOTSTRAP_TOKEN",
    "registrationOpen": true
  }
]
```

相应环境变量写在私有 `.env`，Compose传给init/app/worker。每站DB和密钥单独准备；新增站点不是一个按钮自动创建数据库。`pnpm db:deploy` 按配置串行迁移各DB，`pnpm db:seed` 写各站原创版本种子，`pnpm db:prepare` 顺序执行generate/deploy/seed与所选内容安装；默认完整词典/音标/音频元数据逐站安装，共享校验后的源与媒体缓存，站点私有编辑与学习数据保存在各自DB。不能只准备一站就上线整个registry。再核对 `pnpm sites:check`。站点管理员不修改全局host或数据库映射。

`basePath` 使用空字符串或 `/school-a` 等规范路径，无尾斜杠；`publicUrl` 路径与其一致。配置站点数不得超过 MAX_ACTIVE_SITES，超出会启动失败；每站池也有硬上限。当前没有自动 LRU 淘汰。`/health/ready` 位于固定根路径并检查所有配置站点，因此也支持只有子路径的安装，但任一站 DB 异常会使整个副本 unready。总连接预算计算所有 Web/worker 副本的全部配置站点池，并预留迁移/运维连接。子路径认证、跨站点隔离及生产代理要按当前测试证据验收。

## 群站与版本检测

独立站点可在各自后台生成10分钟单次配对票据，再由控制站管理员输入受控站的规范HTTPS公开URL与票据。消费后换取独立长期grant；受控站存hash，控制站加密保存，绑定双方实例/Realm及连接/目标地址。账号、DB与学习数据保持独立，站点ID可能同名，因此身份由instanceId+siteId组成。受控站授予status:read及可选用户/注册/公告scope，控制站不能铸造更多目标凭据或改变Host/DB/secret。

外连只支持公共HTTPS443及规范basePath，验证DNS并固定实际拨号地址，不跟随重定向；本进程有资源上限，不能写成整个fleet共享并发承诺。目标每次校验身份与凭据；本地状态刷新/断开用条件写保护新绑定。目标管理员可直接撤销长期授权；控制站断开只有在目标确认后才报remoteRevoked，离线时disconnect_pending并保留上次状态。密钥/域名/实例身份改变须经受控恢复流程，不将未知网络状态当作已经撤销。

保存群站密文时使用本站认证secret派生密钥；备份需同时保管对应DB身份和密钥。secret变更会使已保存连接不可读，须处理撤销/重新配对，不通过Web返回长期凭据。仅允许固定管理动作，写操作应保留commandId重试；没有远端shell、自动部署或通用请求代理。

受控站重装、身份变化或离线时，旧授权可能无法确认撤销。管理员明确确认远端grant可能仍存在后可本地forget：清密文、标forgotten、停止远程操作并审计，返回remoteRevocationConfirmed=false；同URL可用新票重配。它不等于远端撤销。每站最多20张活跃票据，每张10分钟有效；最多100条活跃grant，连接记录总量最多100条（含revoked/forgotten）。

后台的检测更新只读取固定NightStudy GitHub Release。当前运行预发布版本选prerelease渠道，否则stable仅正式；严格SemVer排序，空发布返回no-release，不把main代码版本冒充最新Release。PG保存各Realm状态、60秒冷却和检查锁，跨进程竞争只覆盖该Realm；同进程固定上游请求合并/短时缓存。失败保留上次成功结果与错误，不刷新成功时间。功能只给发布链接，升级仍按备份/迁移/独立init程序由operator执行；不提供网页一键升级或shell入口。

完整接口见 [API.md](API.md#群站配对与限权管理)。0.3的并发首装、票据兑换、权限/撤销、离线解绑与重配、幂等、历史长昵称、更新冷却与失败保留通过真实双PG回归；CI完成随机初始密码实际登录。VPS另使用临时独立子站完成公网HTTPS配对、用户启停、分页、注册开关、公告去重与撤销，未注入transport；临时资源已清理。同源子路径测试不构成互不信任租户的浏览器强隔离证据。

## Scale 扩展

```sh
docker compose -f compose.yaml -f compose.scale.yaml config --quiet
docker compose -f compose.yaml -f compose.scale.yaml up --build --detach --scale app=2 --scale worker=2
```

scale 中只有本地 edge 发布回环端口，Web/worker 不映射主机端口，不设置阻止扩容的 `container_name`。Caddy 根据 Docker DNS 动态发现 Web 副本；它是本地 HTTP 演示入口，生产 HTTPS 和域名验证仍属于 operator 的可信入口。默认私有子网 `172.31.27.0/24` 如与已有网络冲突，先调整 NIGHTSTUDY_SCALE_SUBNET 及代理信任范围。[Compose 合并规则](https://docs.docker.com/reference/compose-file/merge/)、[Caddy 动态 upstream](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#dynamic-upstreams)

worker 使用相同镜像的 `pnpm worker` 入口，当前 alpha 实现 PG lease 领取及过期记录维护，不宣称大型导入已异步化。认证/API 使用 PG 原子计数作为跨副本限流，Better Auth 的进程内限流只是附加层。可加 `--profile redis` 创建 Redis 基础设施；当前不会自动切换 PG provider，不宣称完整 Redis 队列或 PgBouncer 已实现。

PgBouncer、完整分布式队列、活动 Realm LRU、公平调度及高并发容量仍按 [多站/并发施工方案](architecture/MULTISITE_AND_SCALING.md) 逐项验收。多副本与连接池不等于已达到特定 QPS，单机 Compose 扩容也不等于跨主机 HA。

## Render 首站描述

根 `render.yaml` 描述一个 Docker Web 与一个 PG17 首站数据库，使用付费资源规格、内部 DB URL、随机认证/初始化密钥、`AUDIO_PACK=none pnpm db:prepare` pre-deploy、2GB Web计算实例、5GB音频持久磁盘及 ready 检查。默认 `autoDeployTrigger: off`，不因上游 push 自动升级所有使用者实例。

该文件不会自行创建云资源。部署者在Render审阅费用、创建资源并检查构建/ready/catalog；PUBLIC_URL从RENDER_EXTERNAL_URL引用。INITIAL_ADMIN_PASSWORD使用平台generateValue独立生成，部署者从Render私有环境保管，避免依赖临时pre-deploy文件；不是所有实例共用默认密码，既有管理员也不因重部署重置。pre-deploy默认准备完整词典/音标，临时内容缓存可能重新下载，已提交词义/用户保存在PG。Render的pre-deploy不能访问运行磁盘，因此dockerCommand在启动前单独执行audio:prepare，将媒体与模型保存在/app/.local/audio持久磁盘；后续重启校验并复用。持久磁盘仅供一个实例，不支持此模板多副本或零停机更新；费用与平台实测由部署者确认。参见[Render磁盘限制](https://render.com/docs/disks)。实际首装、耗时、负载与恢复仍待平台实测。[Render Blueprint规范](https://render.com/docs/blueprint-spec)、[Docker部署](https://render.com/docs/docker)

新增站点由 operator 准备另一独立 DB/连接，再登记 Realm；不承诺免费数据库长期保存、无限租户或生产 SLA。Render 平台实际创建与恢复尚未验证，不展示已可一键使用的成功徽章。

Blueprint 显式设置 `CLIENT_IP_PROFILE=render-public`。该模式启动要求平台 `RENDER=true`，只适用于公网 Render Web 的 Cloudflare/Render 受控入口：PG 限流使用受入口覆盖、经单值合法 IP 校验的 CF-Connecting-IP，缺失/无效/链值 API 与初始化请求返回403；固定根 health 探测例外。服务端覆盖供认证库使用的内部客户端 IP 头，不信任用户传入的同名头，也不打开全局 trustProxy。Host 选站始终取 wire Host。

此模式不能用于 Render 私网服务、直连容器或自托管入口；不要手动伪装 `RENDER=true` 来启用。那些部署使用默认 `socket` profile，按受控代理 CIDR 处理真实 IP。上线前通过实际公网入口核验两个客户端不会聚合限流，并检查伪造 XFF/内部 IP 头不能改变计数。[Render 公网/私网客户端 IP 说明](https://render.com/articles/host-pocketbase-on-render)

## 翻译网关与目标VPS

当前运行镜像 `nightstudy-english:0.5.0-alpha.2-2918aa9`，代码与成功CI一致，init退出0、app/PG/网关健康。切换前另保存私密数据库归档、可读catalog和原.env；本次只核验catalog，未重复执行实际恢复演练。自动准备保留原管理员、词库770,611、4个ready包、五书去重8798词及17596条音源；8条媒体样本检查通过。初始凭据仍在VPS私密文件中，不通过Web交付。

165项真实HTTPS断言通过，验证两普通账户隔离、私有词书和原子计划确认、命令幂等、主任务共享额度、暂停恢复、降目标/切书保留原组、实际到期巩固、历史分页及七日负担。三词产生四次真实评分、一次复习，每日仍计三词；未手工修改dueAt或生产时钟。2用户、1私有书、1导入、2计划、3任务、4评分、3进度和24个已接受回执已按精确ID、归属及创建窗口清理，公共内容和其他用户受事务保护。自然04:00跨日未遇到，跨日及DST只归入隔离回归证据。生产浏览器另验证即时悬停、英美真人及合成播放完成；真实更新检测返回up-to-date及0.5.0-alpha.2发布链接。

本轮升级新增DailyPlan/DailyPlanWord和会话、日志、设置的附加字段，保留旧会话与原始评分。旧dailyNewLimit数值转换成1–100范围的每日总目标，客户端旧字段成为总量镜像；计划语义已变化，详见 [DAILY_TASKS.md](DAILY_TASKS.md)。已有Word检索索引保留。回滚应用镜像不会撤销这些数据库变更，升级前保管业务备份。下面0.4/0.3/0.2内容仅记录各自历史验收。

保留Google官方网页入口和私密VPS备用网关，暂不接收费Cloud API；网页不支持本站iframe。网关请求非官方网页兼容接口，本机及目标VPS真实请求均遇到429，不能宣称站内结果已可用或实现加速。生产配置、同机Compose override与独立网关入口见 [TRANSLATION.md](TRANSLATION.md)。应用不保存翻译历史，网关ready仅表示进程就绪，鉴权401只验证入口关闭；上游可用性仍取决于真实鉴权翻译请求。

0.4运行镜像为 `nightstudy-english:0.4.0-alpha.1-b784133`，代码与成功CI一致，init退出0、app/PG/网关健康。升级前保存私密数据库归档、catalog和原配置；只核验本次新归档catalog，不替代下段历史实际恢复试验。完整音频先由init准备，再切换app；原管理员凭据和770,611词保留，五书8798词/17596音源及两种音标完整性、8条媒体样本检查通过。78项真实HTTPS断言覆盖三格式模板与上传、合格/失败/重复预览、失败导出、确认幂等、生词本精确读写、私有书跨账户/admin/访客读选权限和未揭晓学习状态。测试2用户/1书/4导入/1会话及对应账号和回执已按精确ID和归属清理，原admin、其他用户、SiteState、公共内容不变。生产浏览器另验证rain英美真人录音和water点词卡合成播放；更新检测返回up-to-date及0.4 Release链接。不将浏览器播放或文件校验说成逐词专家听辨。

历史0.3运行镜像为 `nightstudy-english:0.3.0-alpha.1-86afefa`，init退出0，app/PG/网关健康，原770,611词及3个ready包保留。升级前另保存私密数据库归档与原配置；这份新归档只做catalog核验，不冒充下段早期实际恢复试验。首次auto init创建admin，初始凭据导出到VPS私密文件，权限600，应用容器不挂载凭据卷；实际用户名/随机密码HTTPS登录和已初始化setup409通过。42项真实HTTP断言涵盖管理授权、双站公网TLS、分页、用户启停、注册开关、公告去重、子站检测与撤销后本站session保持。临时主站记录、子站容器/DB/凭据卷与nginx入口均已清理；注册策略保留。Release发布后另测up-to-date及正确版本链接。本机桌面完成新版登录、系统与群站页检查，未执行新版手机或生产浏览器完整流程。

以下为0.2历史验收：目标VPS的独立PG17/私密网关/内容缓存与22项HTTPS HTTP检查通过，含主页资产/CSP、770,611词/3包/完整检索、认证权限、5词学习与真实FSRS、官方翻译链接/网关429及退出/登录；临时账号已清理。这些检查不说明Google上游可用。

2026-10-14生产镜像 `nightstudy-english:0.2.0-alpha.1-577f48b` 发布成功，运行代码与 [成功CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38486206457) 的基线相同，包含HEAD SPA修复。app/gateway容器重建后健康，init退出0，Word770611/3个ready包及内容缓存保留。外网HEAD `/` 返回200/HTML/CSP/no-store，HTTP→HTTPS301，site接口version=0.2.0-alpha.1/publicUrl正确。验收/交付时initialized=false，尚未初始化，管理员由部署者使用私有初始化口令自行创建；生产测试账号已删除。这次发布证明容器重建与已有卷保留，未执行主机断电恢复或跨机HA验证。

## 环境变量

| 变量                                                 | 用途                                                                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DATABASE_URL                                         | 默认 site 的 PG URL；Compose 空值时使用内网 postgres，native 开发必须设真实 URL                                                                                                    |
| BETTER_AUTH_SECRET / BOOTSTRAP_TOKEN                 | 认证 secret 至少32字符，bootstrap token 32–256字符；每个 Realm 使用自己的随机值                                                                                                    |
| PUBLIC_URL / BASE_PATH                               | 规范公开地址与挂载路径；root basePath 是空字符串                                                                                                                                   |
| REGISTRATION_OPEN                                    | `true` / `false`；false 关闭普通注册，不代替初始化管理员                                                                                                                           |
| HOST / PORT                                          | 进程监听；容器使用 `0.0.0.0:3000`，主机映射由 Compose 配置                                                                                                                         |
| TRUST_PROXY_CIDRS                                    | socket模式的明确可信代理IP/CIDR，逗号分隔、默认空；不用于Realm Host选站                                                                                                            |
| CLIENT_IP_PROFILE                                    | 默认socket；render-public仅在Render受控公网Web入口启用，health例外，私网服务不适用                                                                                                 |
| SITES_FILE                                           | operator 的私有站点数组文件，路径不是用户可控路由参数                                                                                                                              |
| DB_POOL_SIZE / MAX_ACTIVE_SITES                      | 每 Realm 池上限和活动 Realm 上限；副本增加时审核全 cluster 预算                                                                                                                    |
| NIGHTSTUDY_HTTP_PORT                                 | Compose 主机回环端口，默认 5198                                                                                                                                                    |
| NIGHTSTUDY_IMAGE                                     | 可选已核验发行镜像；空值从当前 checkout 构建本地镜像                                                                                                                               |
| CONTENT_PACK                                         | 默认ecdict完整内容；demo显式最小测试配置；默认不安装全量音频                                                                                                                       |
| AUDIO_PACK / AUDIO_CACHE_DIR / AUDIO_PYTHON          | AUDIO_PACK空时ecdict用standard、demo用none；standard下载固定音频包/模型，none跳过；Docker缓存/app/.local/audio，Python为/opt/nightstudy-audio/bin/python，Native需自己的Piper venv |
| CONTENT_FILE                                         | operator的本地ECDICT源文件；必须匹配固定大小/SHA256，缺失时不自动换源                                                                                                              |
| ADMIN_BOOTSTRAP                                      | 默认auto，仅首次创建admin；manual保留/setup，既有管理员不重置                                                                                                                      |
| ADMIN_CREDENTIALS_DIR                                | Native私密目录；Compose init固定/app/.local/admin，不挂给Web/worker                                                                                                                |
| INITIAL_ADMIN_PASSWORD / INITIAL_ADMIN_EMAIL         | 单站私有初始覆盖；Render密码generateValue保管，多Realm不可共用                                                                                                                     |
| TRANSLATION_MODE                                     | 默认website-official；gateway用于生产站内结果，direct仅本机开发                                                                                                                    |
| TRANSLATION_GATEWAY_URL / TRANSLATION_GATEWAY_SECRET | 固定网关地址与独立私密token，不返回浏览器；详细约束见TRANSLATION.md                                                                                                                |

## 备份与升级

各站DB分别做一致性逻辑备份，含核心词典、管理编辑与学习记录；另保留registry/密钥与映射。不要只复制正在写的PG volume。内容/预生成媒体和模型可按固定摘要重新下载，不替代业务DB备份。音频卷还包含本站按需合成文件；保管它可避免重新生成，但媒体来源和WordAudio业务记录随对应站点DB备份。恢复到新DB核验身份、内容pack、进度和统计后再切换。`pg_dump/pg_restore` 与固定PG版本匹配，备份移到另一机器并定期恢复演练。[Postgres备份](https://www.postgresql.org/docs/current/backup-dump.html)

默认单站 Compose 的逻辑备份示例，在本地私有目录保留 dump：

```sh
mkdir -p .local/backups
docker compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > .local/backups/nightstudy.dump
docker compose exec -T postgres pg_restore --list < .local/backups/nightstudy.dump
```

第二行完成成功才保留为有效备份；`--list` 仅检查归档可读，不能替代恢复演练。恢复演练创建独立临时 DB，不覆盖原库：

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" nightstudy_restore'
docker compose exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" --exit-on-error --no-owner -d nightstudy_restore' < .local/backups/nightstudy.dump
```

多 Realm 的每个业务 DB 单独导出和恢复，外部托管 PG 使用其受控连接与匹配客户端；不要把默认 `$POSTGRES_DB` 的备份当成所有站备份。演练后核对迁移状态、SiteState/siteId、用户/进度/审计计数和一次隔离环境的登录/学习请求，另验证 registry/密钥的安全恢复；不把 dump 提交 Git 或上传公开 issue。

2026-10-14已完成目标VPS的首份生产数据库备份与独立临时DB恢复：归档140,510,271字节，私有目录0700/文件0600；pg_restore --list通过，实际restore使用 --exit-on-error --no-owner成功，恢复后Word=770611、readyPacks=3、SiteState singleton=1且siteId与原库一致。临时DB已删除，主库未修改，应用未因这次恢复检查重启。该证据只覆盖本次数据库归档和独立库恢复，不代表异机灾备、registry/密钥恢复或整个服务恢复已验收；实际归档路径保持私有。

升级先保存备份和当前镜像版本，再检查迁移、重跑独立 init job、启动新 app。不要假定回滚镜像会撤销数据库变更。正式发行时记录 app/schema/dataset 兼容范围；alpha 当前不提供自动无损跨版本恢复保证。

## CI 与镜像发行

0.5.0-alpha.2代码2918aa9的 [main CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38517645764) 与 [发行CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38517674566) 全部成功，覆盖162项测试、9项Python回归、双PG17、默认完整内容与音频安装、随机admin登录及闭合翻译网关。

公开linux/amd64镜像经匿名OCI索引访问及VPS空Docker认证配置实际拉取通过；实际响应体SHA与digest头一致。无网络、只读容器核对版本0.5.0-alpha.2、revision2918aa9、私密运行文件不存在、Piper引擎源码和许可摘要及运行版本匹配，音频/模型另在持久卷。索引包含amd64和attestation条目，不宣称arm64发行。

当前固定发行摘要：

```text
ghcr.io/wudi000888-svg/nightstudy@sha256:1017b3171738e1cf08f9537127cf6f8a79bf242f6e2ef442ff5a6cc8c8b52dc5
```

0.4代码 `b784133` 的 [CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38508645895) 通过133项测试和9项Python提取器回归，默认完整Compose安装核对770,611词、五书去重8,798词/17,596音源及英美IPA，并实际检查8条真人/合成文件。随机admin登录与闭合网关401通过；不将媒体校验说成逐条人工听辨或上游Google可用。

[0.4发行流水线](https://github.com/wudi000888-svg/nightstudy/actions/runs/38509383608) 全部通过，发布linux/amd64容器及provenance/SBOM。匿名OCI index请求的digest与实际body SHA一致；VPS以空Docker认证配置实际拉取成功。无网络运行核对version=0.4.0-alpha.1/x64、私有.env与管理员文件不存在、固定引擎源码与许可随镜像保留；大型音频与模型另放持久卷。index另含attestation，不代表arm64镜像。

CI对PR/main运行锁文件安装、格式、双PG17 migration/seed、sites/typecheck/build与一次 `pnpm test`。测试库显式CONTENT_PACK=demo，CONTENT_TEST_DATABASE_URL启用源码内合成内容PG fixture；不重复执行独立CLI夹具。另执行有界tar提取的Python回归；随后验证基础/scale/翻译Compose描述，构建镜像，并在隔离Compose默认ecdict安装完整字典、英美音标与预生成音频，等待最多600秒，核对ready、catalog声明770,611、5书去重8798词的17596音源与两口音IPA完整性，并校验真人/合成样本文件；另启动闭合网关容器，验证无鉴权请求返回401，不依赖真实Google可用性。清理只针对CI隔离project的卷。

0.3代码86afefa的 [CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38491439614) 通过13文件86项测试、双PG17回归和Compose默认全量安装；明确断言installedDictionary/declaredEntryCount=770611，私密导出后实际登录随机admin，网关健康及无鉴权401通过。US/UK数值和3包数量由本机/VPS验证，未写成CI的独立数值断言。VPS管理员与公网双站42项断言另列，不混用测试环境与生产容量证据。

`release.yml` 仅在维护者发布GitHub Release时触发，版本tag须为 `v0.3.0-alpha.1` 等格式；先复用完整CI，通过后使用仓库GITHUB_TOKEN推送GHCR（当前目标linux/amd64），保留版本、commit、provenance与SBOM。初次发布须核对package visibility，公开仓库不意味着镜像自动公开。[v0.3.0-alpha.1预览版](https://github.com/wudi000888-svg/nightstudy/releases/tag/v0.3.0-alpha.1) 的 [发行流水线](https://github.com/wudi000888-svg/nightstudy/actions/runs/38492073891) 已成功，完整86项/Compose检查后发布 [公开容器](https://github.com/wudi000888-svg/nightstudy/pkgs/container/nightstudy)。匿名manifest访问和VPS空Docker认证配置实际pull通过；无网络运行核对version=0.3.0-alpha.1/x64，镜像无.env或私密管理员文件。镜像含linux/amd64与attestation条目，不宣称有arm64发行。

历史0.4固定发行摘要：

```text
ghcr.io/wudi000888-svg/nightstudy@sha256:061e117fb448e973813849679a154844118f74c3c38a2e562252b3460e3e805b
```

已按前文准备.env、随机密钥与HTTPS入口后，可将NIGHTSTUDY_IMAGE配置为上方0.5.0-alpha.2的当前摘要，使用 `docker compose up --detach --no-build --wait app` 从发行镜像启动。init仍负责默认首次admin、迁移与完整内容；凭据按前文私密导出。`scripts/install.sh` 是源码构建入口，使用发行摘要时不加--build。源码Compose也可自行构建；不要依赖浮动latest。[GitHub官方镜像发布文档](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
