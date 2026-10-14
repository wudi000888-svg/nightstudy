# Alpha 运行与部署

本文件描述 `0.3.0-alpha.1`、Node24、pnpm11.25、Prisma7与Postgres17。自动管理员、群站与更新检测已按源码接入，本轮完整测试、CI和VPS验收尚待记录。历史0.2代码577f48b的55项 [CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38486206457)、完整安装、生产HTTP和限定恢复证据见本文后段，不能当作0.3通过。Render、主机断电恢复、异机/密钥灾备、高并发容量和真人录音也未验收。

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

`init` 运行 `pnpm db:prepare`：generate、全站迁移、seed、首次管理员准备，再按CONTENT_PACK安装内容。默认ecdict会校验完整ECDICT及独立英美IPA并逐站事务安装；成功后app启动，请求进程不重复迁移/创建管理员。默认ADMIN_BOOTSTRAP=auto，新站用户名admin、独立随机密码；已初始化站点不重置账号。manual模式跳过自动创建，保留BOOTSTRAP_TOKEN和/setup。CONTENT_PACK=demo显式跳过完整包，CI基础测试用manual/demo。

## 初始管理员凭据

自动模式先在私密目录持久化候选凭据，再提交账号；失败重试复用候选，既有管理员不改密。候选必须与已初始化本站、对应admin用户及自动初始化审计匹配，才可导出；未确认候选留私密记录，不作为有效登录凭据交付。

Compose的admin-credentials卷仅init挂载到 `/app/.local/admin`，Web/app/worker不挂载。install.sh在成功准备后导出已确认的当前Realm记录到宿主机 `.local/admin/credentials.json`，目录0700、文件0600。只由operator读取并备份，不通过Web下载或提交Git。多站每站生成独立随机密码与 `<siteId>.credentials.json`；Native默认保存于本机.local/admin。单站可私有设置INITIAL_ADMIN_PASSWORD/INITIAL_ADMIN_EMAIL；多Realm拒绝共用这两个覆盖值。

这些文件记录创建时的**初始密码**，用户之后改密不会同步更新明文记录；维护既有站点也不会强制重置。既有手工管理员没有自动生成的初始文件，继续用其原账号。恢复业务DB时同时保管对应认证密钥与初始交付资料，密码哈希不能反推出明文。

PG业务数据与内容源缓存分别保存在postgres-data、content-cache named volume；源缓存挂载 `/app/.local/content`，不塞入Git或应用镜像。首次源下载约71MB，安装耗时取决于网络与机器。等待600秒是CI smoke等待上限，不是承诺安装时间；超时先检查init日志再决定增加等待。重复准备验证缓存与已安装pack，保留历史和管理编辑；摘要失败停止安装。离线内容导入、来源许可与目标书规则见 [CONTENT.md](CONTENT.md)，独立音标见 [PHONETICS.md](PHONETICS.md)。

本机全量库实测Word770,611、追加源Sense1,113,723、5本新目标词书，原40词ID和历史保留。本机/VPS查询US IPA匹配83,424词、UK匹配64,321词及3个ready包；至少一种现代IPA匹配104,261词；含原始音标的任一种音标覆盖256,047词。该安装数据库约974,468,799字节（约975MB）；这是一次本机数据体量记录，不能推断最小磁盘、内存或并发容量。各站各存一份核心词义和进度，另需预算WAL、索引、备份及升级空间。

检查 `/health/live`、`/health/ready` 和 `/api/v2/dictionary/stats`；子路径API添加basePath。ready不代替内容数量验收。查看init/app日志，分享前移除凭据和个人数据。`docker compose down` 保留named volume；`down --volumes` 删除业务DB、内容缓存与初始凭据卷，仅用于可丢弃测试。

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

相应环境变量写在私有 `.env`，Compose传给init/app/worker。每站DB和密钥单独准备；新增站点不是一个按钮自动创建数据库。`pnpm db:deploy` 按配置串行迁移各DB，`pnpm db:seed` 写各站原创版本种子，`pnpm db:prepare` 顺序执行generate/deploy/seed与所选内容安装；默认完整词典/音标逐站安装，共享校验后的源缓存，站点私有编辑与学习数据保存在各自DB。不能只准备一站就上线整个registry。再核对 `pnpm sites:check`。站点管理员不修改全局host或数据库映射。

`basePath` 使用空字符串或 `/school-a` 等规范路径，无尾斜杠；`publicUrl` 路径与其一致。配置站点数不得超过 MAX_ACTIVE_SITES，超出会启动失败；每站池也有硬上限。当前没有自动 LRU 淘汰。`/health/ready` 位于固定根路径并检查所有配置站点，因此也支持只有子路径的安装，但任一站 DB 异常会使整个副本 unready。总连接预算计算所有 Web/worker 副本的全部配置站点池，并预留迁移/运维连接。子路径认证、跨站点隔离及生产代理要按当前测试证据验收。

## 群站与版本检测

独立站点可在各自后台生成10分钟单次配对票据，再由控制站管理员输入受控站的规范HTTPS公开URL与票据。消费后换取独立长期grant；受控站存hash，控制站加密保存，绑定双方实例/Realm及连接/目标地址。账号、DB与学习数据保持独立，站点ID可能同名，因此身份由instanceId+siteId组成。受控站授予status:read及可选用户/注册/公告scope，控制站不能铸造更多目标凭据或改变Host/DB/secret。

外连只支持公共HTTPS443及规范basePath，验证DNS并固定实际拨号地址，不跟随重定向；本进程有资源上限，不能写成整个fleet共享并发承诺。目标每次校验身份与凭据；本地状态刷新/断开用条件写保护新绑定。目标管理员可直接撤销长期授权；控制站断开只有在目标确认后才报remoteRevoked，离线时disconnect_pending并保留上次状态。密钥/域名/实例身份改变须经受控恢复流程，不将未知网络状态当作已经撤销。

保存群站密文时使用本站认证secret派生密钥；备份需同时保管对应DB身份和密钥。secret变更会使已保存连接不可读，须处理撤销/重新配对，不通过Web返回长期凭据。仅允许固定管理动作，写操作应保留commandId重试；没有远端shell、自动部署或通用请求代理。

受控站重装、身份变化或离线时，旧授权可能无法确认撤销。管理员明确确认远端grant可能仍存在后可本地forget：清密文、标forgotten、停止远程操作并审计，返回remoteRevocationConfirmed=false；同URL可用新票重配。它不等于远端撤销。每站最多20张活跃票据，每张10分钟有效；最多100条活跃grant，连接记录总量最多100条（含revoked/forgotten）。

后台的检测更新只读取固定NightStudy GitHub Release。当前运行预发布版本选prerelease渠道，否则stable仅正式；严格SemVer排序，空发布返回no-release，不把main代码版本冒充最新Release。PG保存各Realm状态、60秒冷却和检查锁，跨进程竞争只覆盖该Realm；同进程固定上游请求合并/短时缓存。失败保留上次成功结果与错误，不刷新成功时间。功能只给发布链接，升级仍按备份/迁移/独立init程序由operator执行；目前没有公开GHCR发行镜像或自动安装入口。

完整接口见 [API.md](API.md#群站配对与限权管理)。0.3配对、撤销、首装密码交付与更新缓存的真实测试/CI/VPS结果尚待本轮验收。

## Scale 扩展

```sh
docker compose -f compose.yaml -f compose.scale.yaml config --quiet
docker compose -f compose.yaml -f compose.scale.yaml up --build --detach --scale app=2 --scale worker=2
```

scale 中只有本地 edge 发布回环端口，Web/worker 不映射主机端口，不设置阻止扩容的 `container_name`。Caddy 根据 Docker DNS 动态发现 Web 副本；它是本地 HTTP 演示入口，生产 HTTPS 和域名验证仍属于 operator 的可信入口。默认私有子网 `172.31.27.0/24` 如与已有网络冲突，先调整 NIGHTSTUDY_SCALE_SUBNET 及代理信任范围。[Compose 合并规则](https://docs.docker.com/reference/compose-file/merge/)、[Caddy 动态 upstream](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#dynamic-upstreams)

worker 使用相同镜像的 `pnpm worker` 入口，当前 alpha 实现 PG lease 领取及过期记录维护，不宣称大型导入已异步化。认证/API 使用 PG 原子计数作为跨副本限流，Better Auth 的进程内限流只是附加层。可加 `--profile redis` 创建 Redis 基础设施；当前不会自动切换 PG provider，不宣称完整 Redis 队列或 PgBouncer 已实现。

PgBouncer、完整分布式队列、活动 Realm LRU、公平调度及高并发容量仍按 [多站/并发施工方案](architecture/MULTISITE_AND_SCALING.md) 逐项验收。多副本与连接池不等于已达到特定 QPS，单机 Compose 扩容也不等于跨主机 HA。

## Render 首站描述

根 `render.yaml` 描述一个 Docker Web 与一个 PG17 首站数据库，使用付费资源规格、内部 DB URL、随机认证/初始化密钥、`pnpm db:prepare` pre-deploy 和 ready 检查。默认 `autoDeployTrigger: off`，不因上游 push 自动升级所有使用者实例。

该文件不会自行创建云资源。部署者在Render审阅费用、创建资源并检查构建/ready/catalog；PUBLIC_URL从RENDER_EXTERNAL_URL引用。INITIAL_ADMIN_PASSWORD使用平台generateValue独立生成，部署者从Render私有环境保管，避免依赖临时pre-deploy文件；不是所有实例共用默认密码，既有管理员也不因重部署重置。pre-deploy默认完整内容，临时缓存可能重新下载，已提交词义/用户保存在PG。实际首装、耗时、负载与恢复仍待平台实测。[Render Blueprint规范](https://render.com/docs/blueprint-spec)、[Docker部署](https://render.com/docs/docker)

新增站点由 operator 准备另一独立 DB/连接，再登记 Realm；不承诺免费数据库长期保存、无限租户或生产 SLA。Render 平台实际创建与恢复尚未验证，不展示已可一键使用的成功徽章。

Blueprint 显式设置 `CLIENT_IP_PROFILE=render-public`。该模式启动要求平台 `RENDER=true`，只适用于公网 Render Web 的 Cloudflare/Render 受控入口：PG 限流使用受入口覆盖、经单值合法 IP 校验的 CF-Connecting-IP，缺失/无效/链值 API 与初始化请求返回403；固定根 health 探测例外。服务端覆盖供认证库使用的内部客户端 IP 头，不信任用户传入的同名头，也不打开全局 trustProxy。Host 选站始终取 wire Host。

此模式不能用于 Render 私网服务、直连容器或自托管入口；不要手动伪装 `RENDER=true` 来启用。那些部署使用默认 `socket` profile，按受控代理 CIDR 处理真实 IP。上线前通过实际公网入口核验两个客户端不会聚合限流，并检查伪造 XFF/内部 IP 头不能改变计数。[Render 公网/私网客户端 IP 说明](https://render.com/articles/host-pocketbase-on-render)

## 翻译网关与目标VPS

保留Google官方网页入口和私密VPS备用网关，暂不接收费Cloud API；网页不支持本站iframe。网关请求非官方网页兼容接口，本机及目标VPS真实请求均遇到429，不能宣称站内结果已可用或实现加速。生产配置、同机Compose override与独立网关入口见 [TRANSLATION.md](TRANSLATION.md)。应用不保存翻译历史，网关ready仅表示进程就绪，鉴权401只验证入口关闭；上游可用性仍取决于真实鉴权翻译请求。

以下为0.2历史验收：目标VPS的独立PG17/私密网关/内容缓存与22项HTTPS HTTP检查通过，含主页资产/CSP、770,611词/3包/完整检索、认证权限、5词学习与真实FSRS、官方翻译链接/网关429及退出/登录；临时账号已清理。本轮0.3自动管理员/群站/更新检测尚未生产验收，也未新版手机live，不说明Google上游可用。

2026-10-14生产镜像 `nightstudy-english:0.2.0-alpha.1-577f48b` 发布成功，运行代码与 [成功CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38486206457) 的基线相同，包含HEAD SPA修复。app/gateway容器重建后健康，init退出0，Word770611/3个ready包及内容缓存保留。外网HEAD `/` 返回200/HTML/CSP/no-store，HTTP→HTTPS301，site接口version=0.2.0-alpha.1/publicUrl正确。验收/交付时initialized=false，尚未初始化，管理员由部署者使用私有初始化口令自行创建；生产测试账号已删除。这次发布证明容器重建与已有卷保留，未执行主机断电恢复或跨机HA验证。

## 环境变量

| 变量                                                 | 用途                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| DATABASE_URL                                         | 默认 site 的 PG URL；Compose 空值时使用内网 postgres，native 开发必须设真实 URL    |
| BETTER_AUTH_SECRET / BOOTSTRAP_TOKEN                 | 认证 secret 至少32字符，bootstrap token 32–256字符；每个 Realm 使用自己的随机值    |
| PUBLIC_URL / BASE_PATH                               | 规范公开地址与挂载路径；root basePath 是空字符串                                   |
| REGISTRATION_OPEN                                    | `true` / `false`；false 关闭普通注册，不代替初始化管理员                           |
| HOST / PORT                                          | 进程监听；容器使用 `0.0.0.0:3000`，主机映射由 Compose 配置                         |
| TRUST_PROXY_CIDRS                                    | socket模式的明确可信代理IP/CIDR，逗号分隔、默认空；不用于Realm Host选站            |
| CLIENT_IP_PROFILE                                    | 默认socket；render-public仅在Render受控公网Web入口启用，health例外，私网服务不适用 |
| SITES_FILE                                           | operator 的私有站点数组文件，路径不是用户可控路由参数                              |
| DB_POOL_SIZE / MAX_ACTIVE_SITES                      | 每 Realm 池上限和活动 Realm 上限；副本增加时审核全 cluster 预算                    |
| NIGHTSTUDY_HTTP_PORT                                 | Compose 主机回环端口，默认 5198                                                    |
| NIGHTSTUDY_IMAGE                                     | 可选已核验发行镜像；空值从当前 checkout 构建本地镜像                               |
| CONTENT_PACK                                         | 默认ecdict完整内容；demo显式跳过完整词典/音标，仅保留40词演示                      |
| CONTENT_FILE                                         | operator的本地ECDICT源文件；必须匹配固定大小/SHA256，缺失时不自动换源              |
| ADMIN_BOOTSTRAP                                      | 默认auto，仅首次创建admin；manual保留/setup，既有管理员不重置                      |
| ADMIN_CREDENTIALS_DIR                                | Native私密目录；Compose init固定/app/.local/admin，不挂给Web/worker                |
| INITIAL_ADMIN_PASSWORD / INITIAL_ADMIN_EMAIL         | 单站私有初始覆盖；Render密码generateValue保管，多Realm不可共用                     |
| TRANSLATION_MODE                                     | 默认website-official；gateway用于生产站内结果，direct仅本机开发                    |
| TRANSLATION_GATEWAY_URL / TRANSLATION_GATEWAY_SECRET | 固定网关地址与独立私密token，不返回浏览器；详细约束见TRANSLATION.md                |

## 备份与升级

各站DB分别做一致性逻辑备份，含核心词典、管理编辑与学习记录；另保留registry/密钥与映射。不要只复制正在写的PG volume。内容源缓存可按固定摘要重新下载，不替代业务DB备份。恢复到新DB核验身份、内容pack、进度和统计后再切换。`pg_dump/pg_restore` 与固定PG版本匹配，备份移到另一机器并定期恢复演练。[Postgres备份](https://www.postgresql.org/docs/current/backup-dump.html)

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

CI对PR/main运行锁文件安装、格式、双PG17 migration/seed、sites/typecheck/build与一次 `pnpm test`。测试库显式CONTENT_PACK=demo，CONTENT_TEST_DATABASE_URL启用源码内合成内容PG fixture；不重复执行独立CLI夹具。随后验证基础/scale/翻译Compose描述，构建镜像，并在隔离Compose默认ecdict安装完整字典及英美音标，等待最多600秒，核对ready和catalog声明770,611；另启动闭合网关容器，验证无鉴权请求返回401，不依赖真实Google可用性。清理只针对CI隔离project的卷。

历史0.2代码577f48b的 [CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38486206457) 通过55项、PG17全量安装、770611声明数量断言与网关健康/401。本轮0.3尚待新代码测试/CI/VPS记录；初始密码交付、配对撤销与副本更新缓存要按新功能另行验收，不能沿用旧结果。

`release.yml` 仅在维护者发布GitHub Release时触发，版本tag须为 `v0.2.0-alpha.1` 等格式；先复用完整CI，通过后使用仓库GITHUB_TOKEN推送GHCR（当前目标linux/amd64），保留版本、commit、provenance与SBOM。初次发布后维护者须核对package visibility，公开仓库不意味着镜像自动公开。当前未创建Release或发布发行镜像。部署使用CI输出的 `ghcr.io/...@sha256:...` 固定摘要，不依赖浮动latest。[GitHub官方镜像发布文档](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
