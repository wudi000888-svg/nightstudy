# Alpha 运行与部署

本文对应应用版本 `0.13.0-alpha.1`。完整文本与音频的隔离冷安装、数据库独立检查、[18 书真实账号与 HTTP / H5 分项验收](https://github.com/wudi000888-svg/nightstudy/actions/runs/39277036602) 及 [101 包与全局内容绑定验收](https://github.com/wudi000888-svg/nightstudy/actions/runs/39263429979) 各有独立记录；[固定句音媒体](https://github.com/wudi000888-svg/nightstudy/releases/tag/media-sentence-v4-014-20261019) 单独发行。源码、镜像与站点部署分别验收，分项通过不表示整轮 CI 成功或既有站点已经升级。

0.13 的固定镜像摘要及最终 main / 发行结果以 [该版本发行页](https://github.com/wudi000888-svg/nightstudy/releases/tag/v0.13.0-alpha.1) 记录为准；本源码文档不预写未验收的镜像摘要。安装时核对所选发行的版本、源码 revision 和固定 digest，下文的历史 0.12 镜像不作为本版新站安装目标。

Native / VPS 最近核验的部署仍为 [`0.12.0-alpha.1`](https://github.com/wudi000888-svg/nightstudy/releases/tag/v0.12.0-alpha.1)，运行源码为 [`b8cde5bb`](https://github.com/wudi000888-svg/nightstudy/commit/b8cde5bb8283da2f2f0b20daffd86515b9d2270f)。该版 [main CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38881203417) 与 [发行 CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38881311451) 均成功，公开镜像已匿名核验；两端的数据保护与部署事实见 [0.12 H5 记录](REAL_DEVICE_H5_ROADMAP.md#6-本轮实施与验收记录)。

历史 0.12 两端各完成 347 项公开 HTTP 断言、123 次匿名请求，包括 PWA 完整摘要和成品音频。Native 通过 6 项匿名浏览器检查；VPS 通过 12 项公开页面、音频和导航检查，其浏览器保留既有登录，不称为匿名。隔离环境完成 32 项浏览器交互及小屏、横屏和桌面悬停检查；没有在生产创建测试账户或进行收藏、偏好、评分写请求。这些不包含实体手机、Safari、主屏幕安装态或逐条专家听辨，也不是 0.13 的验收结果。

0.13 覆盖 18 本书、18,767 个有效词目与 69,840 条书成员关系，95 个文本叶共含 49,992 个原子义项、99,984 条中英双语语境例句记录。原 35 词 / 98 义 / 196 例固定基线保留；0.10 词级内容继续作为来源或未绑定候选，不借给另一个意思。范围不是基础词典 770,611 词的全部义项，不代表专家全面校对。新增复习焦点指针迁移后源码共有 21 个迁移；从 0.12 的 20 个迁移升级没有因该迁移新增业务表。实际生产迁移尚未执行，早期范围和部署记录保留在 [0.11 记录](LOOKUP_SENSES_011.md#15-发行与保数据升级状态) 与 [0.12 记录](REAL_DEVICE_H5_ROADMAP.md#6-本轮实施与验收记录)。

Render、主机断电恢复、异机/密钥灾备、高并发容量及音源逐条专家听辨未验收。下文保留各历史版本的对应证据，标明版本的旧镜像与检查结果不代表当前运行版本。

## Docker Compose minimal

需要Docker Engine、现代Docker Compose及openssl。标准首次安装：

```sh
bash scripts/install.sh
```

脚本仅在不存在.env时生成配置，分别生成随机PG密码、认证密钥及初始化口令，并持久化所选Compose project、端口和PUBLIC_URL。已有.env保留，升级前按自己的配置审阅；脚本不改Nginx/TLS。自定义公开域名可在首次执行前设置 `PUBLIC_URL=https://english.example.com`，相应HTTPS入口由operator配置。

默认PUBLIC_URL为 `http://127.0.0.1:5198`，app内部监听3000，PG不发布主机端口。已自行填写私有.env的部署也可手动执行准备与导出：

```sh
docker compose config --quiet
docker compose up --build --detach --wait --wait-timeout 1800 app
# 用install.sh完成私密凭据导出；直接compose启动不会在宿主机生成导出文件。
```

`init` 是新站完整初始化入口，运行 `pnpm db:prepare`：generate、逐站迁移、seed、首次管理员准备，再按 `CONTENT_PACK` 安装内容、按 `AUDIO_PACK` 安装音频并刷新音标覆盖统计。默认 `ecdict` 依次准备完整 ECDICT、考试词书、独立英美 IPA、词组、v1/v2 双语文本及 `learning-senses-collection-v2` 的 95 个义项叶。默认有效目录为 18 本、18,767 个词目与 69,840 条成员关系；原子义项和双语例句范围见本页开头。文本全集先预校验，再逐叶有界读取、在同一事务内顺序导入，最终文件身份检查在提交前执行；精确重放不重写原内容。安装成功后 app 启动，请求进程不重复运行迁移或初始化管理员。

`AUDIO_PACK=standard` 先安装 word-audio-v2、sentence-audio-v1、sentence-audio-v2、sentence-audio-v3，再安装 `data/sentence-audio-v4.collection.json` 中的 101 个新句音子包，总共 105 个归档。安装逐包核对完整媒体与当前内容绑定；缺少 collection 或显式 `AUDIO_PACK=none` 的文本首装不算完整音频安装通过。应用只播放已发布并验证的静态成品。

`scripts/install.sh` 的等待上限默认 1800 秒，可用 `NIGHTSTUDY_INSTALL_WAIT_SECONDS` 设置为 60..7200 秒。手动 Compose 的 `--wait-timeout` 单独设置；上限不是安装耗时保证，慢下载应检查 init 日志、网络和实际资源后再决定是否调整。

安装和运行不下载语音引擎或模型，不进行服务端即时合成、浏览器语音兜底。默认 `ADMIN_BOOTSTRAP=auto`，新站用户名 admin、密码各站随机生成；已初始化站点不重置账号。`manual` 模式保留 `BOOTSTRAP_TOKEN` 和 `/setup`；`CONTENT_PACK=demo` 显式跳过完整包，基础测试使用 manual/demo。既有站点升级按本页“备份与升级”选择增量步骤，不以重新 seed 代替内容升级。

## 初始管理员凭据

自动模式先在私密目录持久化候选凭据，再提交账号；失败重试复用候选，既有管理员不改密。候选必须与已初始化本站、对应admin用户及自动初始化审计匹配，才可导出；未确认候选留私密记录，不作为有效登录凭据交付。

Compose的admin-credentials卷仅init挂载到 `/app/.local/admin`，Web/app/worker不挂载。install.sh在成功准备后导出已确认的当前Realm记录到宿主机 `.local/admin/credentials.json`，目录0700、文件0600。只由operator读取并备份，不通过Web下载或提交Git。多站每站生成独立随机密码与 `<siteId>.credentials.json`；Native默认保存于本机.local/admin。单站可私有设置INITIAL_ADMIN_PASSWORD/INITIAL_ADMIN_EMAIL；多Realm拒绝共用这两个覆盖值。

这些文件记录创建时的**初始密码**，用户之后改密不会同步更新明文记录；维护既有站点也不会强制重置。既有手工管理员没有自动生成的初始文件，继续用其原账号。恢复业务DB时同时保管对应认证密钥与初始交付资料，密码哈希不能反推出明文。

PG 业务数据、内容源缓存与音频分别保存在 postgres-data、content-cache、audio-cache named volume；内容缓存挂载 `/app/.local/content`，音频缓存挂载 `/app/.local/audio`。init 与 app 共用校验后的成品媒体，app 不挂载初始管理员凭据卷。大型词典、音频和模型不塞入 Git 或应用镜像。

默认音频安装保留以下四个不可变的历史成品包，逐项校验字节数和 SHA-256：

| 成品包            | 固定附件版本   |  压缩字节数 | 音频条数 |
| ----------------- | -------------- | ----------: | -------: |
| word-audio-v2     | 0.9.0-alpha.1  | 208,218,687 |   37,550 |
| sentence-audio-v1 | 0.9.0-alpha.1  | 304,612,309 |   16,808 |
| sentence-audio-v2 | 0.10.0-alpha.1 | 369,105,500 |   18,878 |
| sentence-audio-v3 | 0.11.0-alpha.1 |   7,758,221 |      392 |

上述四包压缩总量为 889,694,717 字节；新 v4 的 101 个子包实际压缩总量为 4,008,058,272 字节，105 个归档合计 4,897,752,989 字节。真实来源 URL 和摘要以对应 data descriptor 为准，旧公开包保持不可变。这些是固定压缩附件的字节数，不是解包成品的稳定占用或安装峰值；词典、其他文本/音标包、数据库索引、WAL、备份及升级暂存另计。独立验证档案和语境/计划镜像不属于安装音包。

完整冷安装与数据库检查后，`du -sb /app/.local/audio` 实测稳定逻辑占用为 5,643,375,385 字节，包含该音频目录内的成品及安装元数据。它不是文件系统实际分配量，也不是安装期间的峰值；PG、词典内容缓存与备份不在此数内。该观测来自隔离 Compose 环境，不能推导 Render 可用容量或性能保证。

v4 已完成当前内容根的全局核对：99,940 组去重英文句子 / 199,880 个英美口音键，由 199,377 条本轮新选择、32 条既有 v1/v2 明确复用、392 条 v3 基线及 79 个暂缓键组成；当前可用为 199,801 个口音键，当前纠音记录为 1,758 条。79 键涉及 18 组双口音暂缓和 43 组单口音暂缓；已批准的另一口音不受影响。全局暂缓侧件不能按每包重复携带的数量累加。199,377 是口音条目数，不必等于物理 MP3 文件数；这些结果不表示生产数据库已经安装新媒体。

`AUDIO_RETAIN_ARCHIVES=false` 为默认：本包完整媒体验证通过后，仅删除其已核身份的压缩缓存，解包成品保留；失败缓存保留供排查。`true` 显式保留验证成功的 tar 以便离线修复，磁盘须额外预算全部压缩包。清理失败时保留已安装文件和归档并明确报错，不静默当作安装成功。缓存删除、留存和失败保留的 10 项云端边界回归已通过；安装空间峰值未据稳定目录观测进行推断。

本次全量句音经授权使用已有英美声线在 GitHub 免费环境离线生成，全量生成期间本机不运行模型，没有下载新模型或调用付费内容接口；早期本机小批试验不选入本轮全量新包。安装与运行无需 Piper、声学模型或翻译权重，线上不即时合成，也不使用浏览器设备语音兜底。完整 WAV / MP3 解码、质量与身份检查不是逐句专家听审；复用的旧 32 条也是合成成品，不称真人录音。

0.10的v1/v2两个句音包合计存储35,686条；该版有效词书当时引用17,814条去重英文，对应35,628条英美目标，其余58条是29条旧句的双口音成品。0.11另新增196句/392条v3音频；旧词级句仍待逐义绑定，不以全部媒体行数冒充已发布原子义项的例句数。音频包安装逐站事务更新媒体与来源记录，保留既有合格真人录音优先级，只补空IPA；文本v2的精确更正有独立源绑定与严格事务规则，不能把音频安装规则概括成所有文本原值永远不变。

重跑验证媒体和包身份；默认删掉压缩缓存后，修复可能需要重新取得对应固定包，显式保留归档可供离线修复。摘要失败停止安装，不改成从其他来源补齐。完整内容、严格安装与边界见 [CONTENT.md](CONTENT.md)、[PHONETICS.md](PHONETICS.md) 和 [0.13 记录](ALL_BOOK_SENSES_AUDIO_013.md)。

基础词典的源规模为 770,611 个词目，与 18 本默认学习词书的有效范围是不同口径。历史 Native / VPS 验收核对过词书目录与当时内容，不代表本轮全义项已部署；0.13 的完整 95 叶文本与真实辨义流程在独立云端临时数据库验收。不能只凭 `/health/ready` 或 ContentPack 的 ready 标记断言内容齐备。

旧版词典体量与 IPA 统计在下文标作历史，不作为本版最小磁盘、内存或容量要求。每站各存一份核心词义与进度，另需预算索引、WAL、备份、内容缓存、解压媒体及升级暂存。

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

后台的检测更新只读取固定NightStudy GitHub Release。当前运行预发布版本选prerelease渠道，否则stable仅正式；严格SemVer排序，空发布返回no-release，不把main代码版本冒充最新Release。PG保存各Realm状态、60秒冷却和检查锁，跨进程竞争只覆盖该Realm；同进程固定上游请求合并/短时缓存。失败保留上次成功结果与错误，不刷新成功时间。功能只给发布链接，升级仍由 operator 按目标版本执行备份、明确的迁移及必要内容增量；新站 init 不作为既有站点升级入口；不提供网页一键升级或shell入口。

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

根 `render.yaml` 描述一个 Docker Web 与一个 PG17 首站数据库，使用付费资源规格、内部 DB URL、随机认证/初始化密钥、`AUDIO_PACK=none pnpm db:prepare` pre-deploy、2GB Web计算实例、10GB音频持久磁盘及 ready 检查；PG 磁盘仍为 5GB。默认 `autoDeployTrigger: off`，不因上游 push 自动升级所有使用者实例。

本轮仅将源码模板的音频盘从 5GB 调为 10GB，没有创建或扩容 Render 资源，也没有验证 10GB 足够。隔离 Compose 音频目录的稳定逻辑占用为 5,643,375,385 字节；若保留全部压缩归档，还需额外预算 4,897,752,989 字节及安装暂存，数据库和备份另计。容量须结合 `AUDIO_RETAIN_ARCHIVES` 策略、文件系统实际占用与安装峰值审阅；Render 创建、首装与恢复不因模板更改而视为已验收。

该文件不会自行创建云资源。部署者在Render审阅费用、创建资源并检查构建/ready/catalog；PUBLIC_URL从RENDER_EXTERNAL_URL引用。INITIAL_ADMIN_PASSWORD使用平台generateValue独立生成，部署者从Render私有环境保管，避免依赖临时pre-deploy文件；不是所有实例共用默认密码，既有管理员也不因重部署重置。pre-deploy默认准备完整词典/音标，临时内容缓存可能重新下载，已提交词义/用户保存在PG。Render的pre-deploy不能访问运行磁盘，因此dockerCommand在启动前单独执行audio:prepare，将成品媒体保存在/app/.local/audio持久磁盘；后续重启校验并复用。持久磁盘仅供一个实例，不支持此模板多副本或零停机更新；费用与平台实测由部署者确认。参见[Render磁盘限制](https://render.com/docs/disks)。实际首装、耗时、负载与恢复仍待平台实测。[Render Blueprint规范](https://render.com/docs/blueprint-spec)、[Docker部署](https://render.com/docs/docker)

新增站点由 operator 准备另一独立 DB/连接，再登记 Realm；不承诺免费数据库长期保存、无限租户或生产 SLA。Render 平台实际创建与恢复尚未验证，不展示已可一键使用的成功徽章。

Blueprint 显式设置 `CLIENT_IP_PROFILE=render-public`。该模式启动要求平台 `RENDER=true`，只适用于公网 Render Web 的 Cloudflare/Render 受控入口：PG 限流使用受入口覆盖、经单值合法 IP 校验的 CF-Connecting-IP，缺失/无效/链值 API 与初始化请求返回403；固定根 health 探测例外。服务端覆盖供认证库使用的内部客户端 IP 头，不信任用户传入的同名头，也不打开全局 trustProxy。Host 选站始终取 wire Host。

此模式不能用于 Render 私网服务、直连容器或自托管入口；不要手动伪装 `RENDER=true` 来启用。那些部署使用默认 `socket` profile，按受控代理 CIDR 处理真实 IP。上线前通过实际公网入口核验两个客户端不会聚合限流，并检查伪造 XFF/内部 IP 头不能改变计数。[Render 公网/私网客户端 IP 说明](https://render.com/articles/host-pocketbase-on-render)

## 翻译网关与目标VPS

历史0.5验收时运行镜像 `nightstudy-english:0.5.0-alpha.2-2918aa9`，代码与成功CI一致，init退出0、app/PG/网关健康。切换前另保存私密数据库归档、可读catalog和原.env；本次只核验catalog，未重复执行实际恢复演练。自动准备保留原管理员、词库770,611、4个ready包、五书去重8798词及17596条音源；8条媒体样本检查通过。初始凭据仍在VPS私密文件中，不通过Web交付。

165项真实HTTPS断言通过，验证两普通账户隔离、私有词书和原子计划确认、命令幂等、主任务共享额度、暂停恢复、降目标/切书保留原组、实际到期巩固、历史分页及七日负担。三词产生四次真实评分、一次复习，每日仍计三词；未手工修改dueAt或生产时钟。2用户、1私有书、1导入、2计划、3任务、4评分、3进度和24个已接受回执已按精确ID、归属及创建窗口清理，公共内容和其他用户受事务保护。自然04:00跨日未遇到，跨日及DST只归入隔离回归证据。生产浏览器另验证即时悬停、英美真人及合成播放完成；真实更新检测返回up-to-date及0.5.0-alpha.2发布链接。

本轮升级新增DailyPlan/DailyPlanWord和会话、日志、设置的附加字段，保留旧会话与原始评分。旧dailyNewLimit数值转换成1–100范围的每日总目标，客户端旧字段成为总量镜像；计划语义已变化，详见 [DAILY_TASKS.md](DAILY_TASKS.md)。已有Word检索索引保留。回滚应用镜像不会撤销这些数据库变更，升级前保管业务备份。下面0.4/0.3/0.2内容仅记录各自历史验收。

保留Google官方网页入口和私密VPS备用网关，暂不接收费Cloud API；网页不支持本站iframe。网关请求非官方网页兼容接口，本机及目标VPS真实请求均遇到429，不能宣称站内结果已可用或实现加速。生产配置、同机Compose override与独立网关入口见 [TRANSLATION.md](TRANSLATION.md)。应用不保存翻译历史，网关ready仅表示进程就绪，鉴权401只验证入口关闭；上游可用性仍取决于真实鉴权翻译请求。

0.4运行镜像为 `nightstudy-english:0.4.0-alpha.1-b784133`，代码与成功CI一致，init退出0、app/PG/网关健康。升级前保存私密数据库归档、catalog和原配置；只核验本次新归档catalog，不替代下段历史实际恢复试验。完整音频先由init准备，再切换app；原管理员凭据和770,611词保留，五书8798词/17596音源及两种音标完整性、8条媒体样本检查通过。78项真实HTTPS断言覆盖三格式模板与上传、合格/失败/重复预览、失败导出、确认幂等、生词本精确读写、私有书跨账户/admin/访客读选权限和未揭晓学习状态。测试2用户/1书/4导入/1会话及对应账号和回执已按精确ID和归属清理，原admin、其他用户、SiteState、公共内容不变。生产浏览器另验证rain英美真人录音和water点词卡合成播放；更新检测返回up-to-date及0.4 Release链接。不将浏览器播放或文件校验说成逐词专家听辨。

历史0.3运行镜像为 `nightstudy-english:0.3.0-alpha.1-86afefa`，init退出0，app/PG/网关健康，原770,611词及3个ready包保留。升级前另保存私密数据库归档与原配置；这份新归档只做catalog核验，不冒充下段早期实际恢复试验。首次auto init创建admin，初始凭据导出到VPS私密文件，权限600，应用容器不挂载凭据卷；实际用户名/随机密码HTTPS登录和已初始化setup409通过。42项真实HTTP断言涵盖管理授权、双站公网TLS、分页、用户启停、注册开关、公告去重、子站检测与撤销后本站session保持。临时主站记录、子站容器/DB/凭据卷与nginx入口均已清理；注册策略保留。Release发布后另测up-to-date及正确版本链接。本机桌面完成新版登录、系统与群站页检查，未执行新版手机或生产浏览器完整流程。

以下为0.2历史验收：目标VPS的独立PG17/私密网关/内容缓存与22项HTTPS HTTP检查通过，含主页资产/CSP、770,611词/3包/完整检索、认证权限、5词学习与真实FSRS、官方翻译链接/网关429及退出/登录；临时账号已清理。这些检查不说明Google上游可用。

2026-10-14生产镜像 `nightstudy-english:0.2.0-alpha.1-577f48b` 发布成功，运行代码与 [成功CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38486206457) 的基线相同，包含HEAD SPA修复。app/gateway容器重建后健康，init退出0，Word770611/3个ready包及内容缓存保留。外网HEAD `/` 返回200/HTML/CSP/no-store，HTTP→HTTPS301，site接口version=0.2.0-alpha.1/publicUrl正确。验收/交付时initialized=false，尚未初始化，管理员由部署者使用私有初始化口令自行创建；生产测试账号已删除。这次发布证明容器重建与已有卷保留，未执行主机断电恢复或跨机HA验证。

## 环境变量

DeepSeek不是部署必填环境变量。各站管理员从本站后台可选配置加密API key；保存不发请求，仅手动test/preview调用固定官方上游。未配置不产生AI费用，配置后的主动调用由该key所属账户承担费用，结果仍不自动入库。轮换本站认证secret可能使已有DeepSeek与群站密文不可读，需同时规划重新配置和撤销/配对。详细限制和测试边界见 [AI_CONFIGURATION.md](AI_CONFIGURATION.md)。

| 变量                                                 | 用途                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DATABASE_URL                                         | 默认 site 的 PG URL；Compose 空值时使用内网 postgres，native 开发必须设真实 URL                                                                                                           |
| BETTER_AUTH_SECRET / BOOTSTRAP_TOKEN                 | 认证 secret 至少32字符，bootstrap token 32–256字符；每个 Realm 使用自己的随机值                                                                                                           |
| PUBLIC_URL / BASE_PATH                               | 规范公开地址与挂载路径；root basePath 是空字符串                                                                                                                                          |
| REGISTRATION_OPEN                                    | `true` / `false`；false 关闭普通注册，不代替初始化管理员                                                                                                                                  |
| HOST / PORT                                          | 进程监听；容器使用 `0.0.0.0:3000`，主机映射由 Compose 配置                                                                                                                                |
| TRUST_PROXY_CIDRS                                    | socket模式的明确可信代理IP/CIDR，逗号分隔、默认空；不用于Realm Host选站                                                                                                                   |
| CLIENT_IP_PROFILE                                    | 默认socket；render-public仅在Render受控公网Web入口启用，health例外，私网服务不适用                                                                                                        |
| SITES_FILE                                           | operator 的私有站点数组文件，路径不是用户可控路由参数                                                                                                                                     |
| DB_POOL_SIZE / MAX_ACTIVE_SITES                      | 每 Realm 池上限和活动 Realm 上限；副本增加时审核全 cluster 预算                                                                                                                           |
| NIGHTSTUDY_HTTP_PORT                                 | Compose 主机回环端口，默认 5198                                                                                                                                                           |
| NIGHTSTUDY_IMAGE                                     | 可选已核验发行镜像；空值从当前 checkout 构建本地镜像                                                                                                                                      |
| CONTENT_PACK                                         | 默认 ecdict：完整源词典、考试词书、独立 IPA、词组、v1/v2 双语文本与 95 叶原子义项 collection；有效默认目录18本；demo 显式选择最小测试内容，音频另由 AUDIO_PACK 选择                       |
| AUDIO_PACK / AUDIO_CACHE_DIR / AUDIO_PYTHON          | AUDIO_PACK 空时 ecdict 用 standard、demo 用 none；standard 校验旧四包与 v4 collection 的 101 子包；none 跳过音频；Docker 缓存 /app/.local/audio；Native 用 Python 3.11+受限解包，无需模型 |
| AUDIO_RETAIN_ARCHIVES                                | 默认 false，完整媒体验证通过后删除本包压缩缓存；true 显式保留归档供离线修复，失败缓存保留；留存时额外预算全部 tar 空间                                                                    |
| NIGHTSTUDY_INSTALL_WAIT_SECONDS                      | install.sh 等待上限默认 1800 秒，范围 60..7200；不代替手动 Compose 的 --wait-timeout，也不是安装耗时保证                                                                                  |
| CONTENT_FILE                                         | operator的本地ECDICT源文件；必须匹配固定大小/SHA256，缺失时不自动换源                                                                                                                     |
| ADMIN_BOOTSTRAP                                      | 默认auto，仅首次创建admin；manual保留/setup，既有管理员不重置                                                                                                                             |
| ADMIN_CREDENTIALS_DIR                                | Native私密目录；Compose init固定/app/.local/admin，不挂给Web/worker                                                                                                                       |
| INITIAL_ADMIN_PASSWORD / INITIAL_ADMIN_EMAIL         | 单站私有初始覆盖；Render密码generateValue保管，多Realm不可共用                                                                                                                            |
| TRANSLATION_MODE                                     | 默认website-official；gateway用于生产站内结果，direct仅本机开发                                                                                                                           |
| TRANSLATION_GATEWAY_URL / TRANSLATION_GATEWAY_SECRET | 固定网关地址与独立私密token，不返回浏览器；详细约束见TRANSLATION.md                                                                                                                       |

## 备份与升级

各站DB分别做一致性逻辑备份，含核心词典、管理编辑与学习记录；另保留registry/密钥与映射。不要只复制正在写的PG volume。内容与成品媒体可按固定摘要重新取得，不替代业务DB备份。保管历史音频缓存可保留旧媒体；运行时不按需合成；0.10 新增句音仍是固定成品。WordAudio、SentenceAudio及其来源记录随对应站点DB备份，自定义站点壁纸随SiteAppearance备份。加密DeepSeek key与群站授权需要同时保管对应认证secret和安装实例身份，数据库密文不是独立可恢复的凭据。恢复到新DB核验身份、内容pack、进度和统计后再切换。`pg_dump/pg_restore` 与固定PG版本匹配，备份移到另一机器并定期恢复演练。[Postgres备份](https://www.postgresql.org/docs/current/backup-dump.html)

默认单站 Compose 的逻辑备份示例，在本地私有目录保留 dump：

```sh
set -eu
umask 077
mkdir -p .local/backups
chmod 700 .local/backups
TASK_DUMP=".local/backups/nightstudy-$(date -u +%Y%m%d_%H%M%S).dump"
docker compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$TASK_DUMP.partial"
docker compose exec -T postgres pg_restore --list < "$TASK_DUMP.partial" > "$TASK_DUMP.catalog"
mv "$TASK_DUMP.partial" "$TASK_DUMP"
```

dump成功且归档目录检查通过才保留最终文件；失败的partial不作为有效备份。`--list` 仅检查归档可读，不能替代恢复演练。保持上述shell中的TASK_DUMP指向该份备份，恢复演练创建独立临时 DB，不覆盖原库：

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" nightstudy_restore'
docker compose exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" --exit-on-error --no-owner -d nightstudy_restore' < "$TASK_DUMP"
```

多 Realm 的每个业务 DB 单独导出和恢复，外部托管 PG 使用其受控连接与匹配客户端；不要把默认 `$POSTGRES_DB` 的备份当成所有站备份。演练后核对迁移状态、SiteState/siteId、用户/进度/审计计数和一次隔离环境的登录/学习请求，另验证 registry/密钥的安全恢复；不把 dump 提交 Git 或上传公开 issue。

2026-10-14已完成目标VPS的首份生产数据库备份与独立临时DB恢复：归档140,510,271字节，私有目录0700/文件0600；pg_restore --list通过，实际restore使用 --exit-on-error --no-owner成功，恢复后Word=770611、readyPacks=3、SiteState singleton=1且siteId与原库一致。临时DB已删除，主库未修改，应用未因这次恢复检查重启。该证据只覆盖本次数据库归档和独立库恢复，不代表异机灾备、registry/密钥恢复或整个服务恢复已验收；实际归档路径保持私有。

升级先保留可恢复备份、私有配置和当前应用/镜像身份，再按具体来源版本审阅代码、schema、内容包与安装器差异。不要把新站的 `db:prepare` 或默认 seed 命令直接当作既有站点升级脚本；不要假定回滚镜像会撤销数据库变更。

- 0.12→0.13 尚未在 Native / VPS 执行。需要先确认站点、Realm、数据库和应用身份，准备可恢复备份与实际剩余空间，核验完整媒体预置，再审阅新增复习焦点指针迁移以及文本、媒体的严格增量/精确重放。文本全集的提交前身份复核或任一数据库步骤失败须整事务回滚。新站 init、db:prepare、seed、清卷或业务库 restore 都不能代替该升级；具体停写、安装、切换与保护验收顺序需按实际来源版本另行确认，不复用历史 PID。源码和资源公开发行不代表既有站点已自动升级。

- 历史 0.11 alpha.3→0.12 alpha.1：先绑定明确的源码、镜像、站点/数据库身份与剩余空间，隔离构建并核验媒体和源文件；只停止身份已确认的本站 API，保留 PG 与网关。停写窗口内生成新备份、核 catalog 和 50 表原列/原行指纹，使用已审的迁移入口执行新增一个 SQL，再核增量与零变更重放，最后切冻结应用或固定镜像。不得运行新站 init、db:prepare、seed、业务库 restore 或内容/媒体安装；Compose 最后只更新 app 并使用 `--no-deps --no-build`。Native 与 VPS 均已完成，原 PG 与 VPS 网关保持；新备份仅核 catalog，真实旧备份另在独立库做过恢复演练。本轮 4 个隔离测试库、6 份临时凭据与仅 55443 测试集群已精确清理/停用，生产和备份保留。详见 [本轮 H5 记录](REAL_DEVICE_H5_ROADMAP.md#发行与保数据升级)。

- 历史 0.11 alpha.1→alpha.3：schema、19条迁移、data与Compose配置逐字节相同，先生成新备份并核catalog，再只切Native冻结产物与VPS app；不运行init、迁移、seed、恢复或媒体导入。学习进度与今日完成数保留，正常切书只结束未完成任务并重排。两端原PG、VPS网关与媒体卷保持；新备份本轮未实际restore，不声称启动后数据库逐行相等。详见[切书修复记录](BOOK_SWITCH_TASKS_FIX.md)。

- 历史0.10→0.11 alpha.1：审阅并应用四个新迁移（原子义项、查询索引、绑定失效、例句版本外键），仅安装固定learning-senses-v1和sentence-audio-v3增量。媒体先预置；明确站点/库/OID/instance后，停本站写入、做新备份和before指纹，再迁移/严格安装/after/零变更重放，最后只切换应用。Native原环境/PG进程、VPS原PG/网关容器保持。允许接口不兼容不等于清库；本轮没有seed/reset或业务库restore。Native旧备份在独立测试库实际恢复并演练，VPS新备份仅核catalog。具体范围见[0.11记录](LOOKUP_SENSES_011.md#152-真实旧库演练与两端增量)。

- 历史0.9升至0.10：无新增 SQL 迁移，但有严格文本 v2 与 sentence-audio-v2 增量；按核对过的站点身份、源绑定和成品摘要安装，验证全部有效词书及用户/业务保护，再切换应用。公开的纯内容入口为 `pnpm bilingual:prepare --pack v2 --site <configured-site-id>` 与 `pnpm audio:prepare`，它们不能代替已有生产站的备份、停服窗口与保护验收。
- 历史0.10 alpha.1内容升级后切换alpha.3：文字、媒体和 schema 不变，仅更换已核对的应用产物；不重复执行 seed、迁移或内容/音频导入。只停止确认身份的本站 API；PG 和未知进程保持运行。运行中的应用可执行正常维护，因此不把纯应用切换说成做过数据库全行重验。

0.10当时VPS从0.9完成文本与音频增量安装，47 表精确预期及文本、音频各一次重复安装验证通过；新私密备份为 153,408,086 字节，归档目录可读性检查通过；本轮没有重复独立恢复演练，也未向业务库恢复。升级未执行 seed、迁移或恢复，PG 与翻译网关保留原容器身份。

0.10当时Native先在alpha.1完成完整内容安装及 47 表保护核验，再以纯应用替换升级到 alpha.3；补丁阶段未运行数据库安装器、未重导内容，也未重新做数据库全行散列。两端具体内容覆盖及验证范围见 [0.10 交付记录](CONTENT_BILINGUAL_POLISH_010.md)。

0.10收尾按固定身份清理8个临时数据库、8 个表空间、3 个冷安装角色及 19 个临时备份/环境文件，共移除 765,651,082 字节私密文件；未使用强制删除数据库或终止未知客户端。清理未触及源站或生产数据，全部生产备份、验收证据与内容资产保留。该清理不构成业务库恢复演练或异机灾备证明。

alpha 不提供自动无损跨版本恢复保证；0.10的“无新增迁移”不能推广到其它版本。

## CI 与镜像发行

### 0.13 验证与发行记录

[隔离真实账号验收](https://github.com/wudi000888-svg/nightstudy/actions/runs/39277036602) 在完整内容安装后，以 18 个独立普通账号经真实选书、目标确认、偏好、发题、揭晓和重试，共 360 次请求。90 道自然发题包括 84 道辨义（81 道来自原 35 词之外）和 6 道回忆，每本书均有新内容辨义题。实际 GET 确认评分、FSRS、完成数和未评分游标未推进；没有评分、AI 或支付调用。该临时站点不能指向生产，账号和 cookie 不进入公开收据。收据为 181,094 字节，SHA-256 `db314c75d1f4e50fd393615118d1da2e236c45f2d1a120219401e81338bf314e`。

完整 101 包的独立成品校验、明确选择、全局内容引用和 79 个暂缓键的分区已在 [全量媒体任务](https://github.com/wudi000888-svg/nightstudy/actions/runs/39263429979) 通过，并保留公开语境及不可变计划镜像。当前根精确闭合为 199,377 新选择 + 32 既有复用 + 392 基线 + 79 暂缓，当前可用 199,801；媒体与全局收据、语境清单公开后，完整文本和 105 个音包的隔离冷安装及数据库独立检查也已有通过记录。

[应用验收的独立收据](https://github.com/wudi000888-svg/nightstudy/actions/runs/39277036602) 确认 548 项匿名 HTTP 检查 / 101 次 GET 与 HEAD、18 本书的当前词义与例句抽样通过；HTTP 收据为 176,778 字节，SHA-256 `1fbde415971ddb8aa5682b5164e3db3b2b29656d04fbc3b3617ac949e150c544`。Chromium H5 收据为 65,592 字节，SHA-256 `fc4521d566e4950bfdce1744925c2973fb1df322084d916db9a13949245e1a05`，323 项检查通过，含两个不同多义词的真实前后切换与例句重置、两条句子的四次英美播放事件及四幅截图；浏览器业务写入尝试为零。此结果涵盖隔离手机视口与桌面悬停，不代替实体手机、Safari 或主屏幕安装态验收。分项收据不等于整轮工作流终态；最终 main / 发行 CI 与固定镜像摘要统一见 [版本发行页](https://github.com/wudi000888-svg/nightstudy/releases/tag/v0.13.0-alpha.1)，GitHub 发行不表示 Native / VPS 已部署。

媒体使用独立、非 latest 的资源 prerelease [`media-sentence-v4-014-20261019`](https://github.com/wudi000888-svg/nightstudy/releases/tag/media-sentence-v4-014-20261019)，旧公开附件不覆盖。媒体选择与全局校验、完整应用 CI、版本匹配的源码与镜像分别留存证据。`release.yml` 只为 `v` 前缀的应用版本进入验证/镜像任务，资源标签不触发应用容器发布。GitHub 公开源码不保证 GHCR package 自动公开，发行镜像仍须匿名核验。安装等待默认 1800 秒，完整安装耗时与磁盘峰值不以压缩体积代替。

### 0.12 已部署历史基线

`0.12.0-alpha.1` 对应源码 [`b8cde5bb8283da2f2f0b20daffd86515b9d2270f`](https://github.com/wudi000888-svg/nightstudy/commit/b8cde5bb8283da2f2f0b20daffd86515b9d2270f)；[main CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38881203417) 与 [发行 CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38881311451) 均成功。发行 verify 完成后才发布镜像，不以 main 通过代替镜像发行结果。

该版本机冻结基线为 107 份测试文件 / 918 项、类型检查、格式与隔离构建通过；CI 另完成 Python 与检查器自测。CI 在双 PG17 测试库执行回归，另外在独立 Compose project 完成默认 ecdict 首装、原始内容快照保护、严格增量/重放及四包音频检查；基础测试配置显式 demo/manual。该版新站共 20 个迁移，不在启动请求中执行迁移。

历史 0.12 已公开匿名核验、VPS 实际运行的固定 OCI index：

```text
ghcr.io/wudi000888-svg/nightstudy@sha256:884c62d81a69f243f370fa30c3b563ffe6dc4eee776cc9848a2e33380d5b43b5
```

匿名请求的 index body SHA 与 digest 响应头一致，version、revision 和 linux/amd64 均匹配，压缩层摘要与解包 diffID 也独立核验。流水线保留 provenance/SBOM；一个 attestation 条目不表示存在 arm64 镜像。VPS 使用空 Docker 认证配置实际拉取并核对运行身份、源码和 Prisma；正式运行固定为上述摘要。公开 OCI 身份证据及部署收据保存在本轮私密交付记录中。

该版完整首装保留 770,611 基础词典、18 本书 / 69,840 有效成员和 0.10 文本来源与候选，再安装 35 词 / 98 原子义项 / 196 独立语境及 392 句音身份。独立检查原源行不变、来源摘要、同词同版、每义两个语境及成品文件；不把保留的旧词级句当成全部义项配句完成。随机初始 admin 实际登录和闭合网关未鉴权 401 另验，它们不证明 Google 上游可用。该版清理只针对 CI 的独立 project，不是本轮 0.13 完整媒体或站点验收。

上述 digest 仅保留为 0.12 部署历史，不是 0.13 新站安装推荐。`release.yml` 在发布 `v` 前缀的 GitHub 应用 Release 时验证 tag 与 package.json 版本，再执行完整验证与镜像发布。新站准备私有 `.env`、密钥与 HTTPS 后，从目标版本的发行页取得已验收的固定 digest，设置 `NIGHTSTUDY_IMAGE` 并使用 `docker compose up --detach --no-build --wait app`；init 准备新站管理员与内容。已有站点按前文增量，不重新 seed。`scripts/install.sh` 为源码构建入口，使用发行镜像时不加 `--build`，不依赖浮动 latest；公开仓库不保证 GHCR package 自动公开，仍需匿名核验。[GitHub镜像发布文档](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)

以下保留旧版发行记录，分别对应当时的源码与验收范围。

### 0.7 历史运行与恢复记录

历史 0.7 发布为 [`0.7.0-alpha.1`](https://github.com/wudi000888-svg/nightstudy/releases/tag/v0.7.0-alpha.1)，运行源码为 [`1ff2986`](https://github.com/wudi000888-svg/nightstudy/commit/1ff298678355debf533433f5a61550b2bc98438a)。本机 Native 与目标 VPS 已升级并通过健康检查；移动浏览器已核验首页、内容入口与学堂页面。62 份测试文件、563 项测试及类型、格式、构建检查通过，[main CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38729429192) 与 [发行 CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38729521782) 均成功。该版本移动端交互及隔离环境的学习流程验收见 [MOBILE_REDESIGN.md](MOBILE_REDESIGN.md)。

2026-10-15 该轮 VPS 升级前备份已在独立测试库恢复：40 张业务表的行与列及 13 条迁移记录与备份基线一致，随后按数据库身份与零连接条件清理测试库；未向业务库执行恢复或终止未知客户端。此次证明不包含所有权、ACL、注释、安全标签及表空间位置。升级新增四张表，迁移后为 44 张业务表、14 条迁移记录；已有 40 张表在升级窗口摘要一致。数据库与翻译网关保持运行，只重新创建应用容器。

0.7 当时核验的不可变发行摘要，仅供历史追溯，不作为 0.10 部署目标：

```text
ghcr.io/wudi000888-svg/nightstudy@sha256:e3739407152aeee0dccb1eaac33b4392226b1486e6c94200991195ba723af28f
```

### 其他历史发行记录

0.5.0-alpha.2代码2918aa9的 [main CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38517645764) 与 [发行CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38517674566) 全部成功，覆盖162项测试、9项Python回归、双PG17、默认完整内容与音频安装、随机admin登录及闭合翻译网关。

公开linux/amd64镜像经匿名OCI索引访问及VPS空Docker认证配置实际拉取通过；实际响应体SHA与digest头一致。无网络、只读容器核对版本0.5.0-alpha.2、revision2918aa9、私密运行文件不存在、Piper引擎源码和许可摘要及运行版本匹配，音频/模型另在持久卷。索引包含amd64和attestation条目，不宣称arm64发行。

历史0.5.0-alpha.2已验收的固定发行摘要：

```text
ghcr.io/wudi000888-svg/nightstudy@sha256:1017b3171738e1cf08f9537127cf6f8a79bf242f6e2ef442ff5a6cc8c8b52dc5
```

0.4代码 `b784133` 的 [CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38508645895) 通过133项测试和9项Python提取器回归，默认完整Compose安装核对770,611词、五书去重8,798词/17,596音源及英美IPA，并实际检查8条真人/合成文件。随机admin登录与闭合网关401通过；不将媒体校验说成逐条人工听辨或上游Google可用。

[0.4发行流水线](https://github.com/wudi000888-svg/nightstudy/actions/runs/38509383608) 全部通过，发布linux/amd64容器及provenance/SBOM。匿名OCI index请求的digest与实际body SHA一致；VPS以空Docker认证配置实际拉取成功。无网络运行核对version=0.4.0-alpha.1/x64、私有.env与管理员文件不存在、固定引擎源码与许可随镜像保留；大型音频与模型另放持久卷。index另含attestation，不代表arm64镜像。

0.6新增验收约束以实际数据库为准：先记录原canonical词/义项/词书焦点和非空原文摘要，再安装补充包；检查8,798词的独立中英文解释、manifest对应的8,786词例句与12个源异常、437词组及874条实际音源文件。报告真实的成对义项/焦点数量，不把所有源Sense假装成对，不把补充包条目叠加到770,611词典数量。旧会话、练习题、用户进度与既有音源行保留；这些是持续使用的验收要求，具体通过范围以对应commit、CI与部署记录为准。

0.3代码86afefa的 [CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38491439614) 通过13文件86项测试、双PG17回归和Compose默认全量安装；明确断言installedDictionary/declaredEntryCount=770611，私密导出后实际登录随机admin，网关健康及无鉴权401通过。US/UK数值和3包数量由本机/VPS验证，未写成CI的独立数值断言。VPS管理员与公网双站42项断言另列，不混用测试环境与生产容量证据。

历史 0.3 发行证据：[v0.3.0-alpha.1预览版](https://github.com/wudi000888-svg/nightstudy/releases/tag/v0.3.0-alpha.1) 的 [发行流水线](https://github.com/wudi000888-svg/nightstudy/actions/runs/38492073891) 已成功，完整86项/Compose检查后发布 [公开容器](https://github.com/wudi000888-svg/nightstudy/pkgs/container/nightstudy)。匿名manifest访问和VPS空Docker认证配置实际pull通过；无网络运行核对version=0.3.0-alpha.1/x64，镜像无.env或私密管理员文件。镜像含linux/amd64与attestation条目，不宣称有arm64发行。

历史0.4固定发行摘要：

```text
ghcr.io/wudi000888-svg/nightstudy@sha256:061e117fb448e973813849679a154844118f74c3c38a2e562252b3460e3e805b
```

### 0.8 H5 发布验证

v0.8.0-alpha.1 源码 `1fc25daf4a15322c2a3b445d4ed4fa4119f22dbf` 的[双PG17/Compose发行验证](https://github.com/wudi000888-svg/nightstudy/actions/runs/38769173777)通过，固定镜像为 `ghcr.io/wudi000888-svg/nightstudy@sha256:17b96c68bb342d74e38df7257ac46ffb84c8804c9ffd2cfc039e4ab6cd78418b`。本轮与0.7保持完全相同的Prisma schema、14份SQL迁移及Compose描述；目标VPS只重启app，未运行init、迁移或内容准备，44表/14账本停服核对一致。不能将本例“不需要迁移”用于其他版本。

本轮新VPS备份已恢复到独立随机测试库并核对44表全部行列及14条账本，测试库清理、无业务库恢复。原收尾回执经独立核验补记，详细范围见 [H5部署记录](H5_APP_REDESIGN.md#发布与部署记录)。保留私密备份与环境配置，禁止通过Web发布备份、凭据或原始检查文件。Native本轮未重新备份数据库，仅在启动前核对保留数据。

### 早期基础安装体量记录（历史）

以下数字只对应早期采样数据库，保留原始统计以便追溯，不作为 0.10 现状或最低资源要求：

本机全量库实测Word770,611、追加源Sense1,113,723、5本新目标词书，原40词ID和历史保留。本机/VPS查询US IPA匹配83,424词、UK匹配64,321词及3个ready包；至少一种现代IPA匹配104,261词；含原始音标的任一种音标覆盖256,047词。该安装数据库约974,468,799字节（约975MB）；这是一次本机数据体量记录，不能推断最小磁盘、内存或并发容量。各站各存一份核心词义和进度，另需预算WAL、索引、备份及升级空间。
