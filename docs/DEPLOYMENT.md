# Alpha 运行与部署

本文件对应 Node 24、pnpm 11.25、Prisma 7 与目标 Postgres 17 的新工程。本机 PG18.4 的28项测试、格式/类型与浏览器核心流程已通过，见 [验证记录](../README.md#本机验证与待验收项)。PG17、容器与 Compose 将由 GitHub CI 验证，当前结果 pending；本机没有 Docker。Render 实际创建/部署/恢复未执行，本项目没有创建付费平台资源。

## Docker Compose minimal

需要 Docker Engine 与支持 `!reset` 合并标签的现代 Docker Compose。先准备本地私有配置：

```sh
cp .env.example .env
mkdir -p .local/sites
```

编辑 `.env`，为 `POSTGRES_PASSWORD`、`BETTER_AUTH_SECRET`、`BOOTSTRAP_TOKEN` 分别生成不同随机值。可在自己终端运行 `openssl rand -hex 32`，每次生成一个；不要把输出提交到仓库。PG 密码使用 URL 安全的 hex 值，避免未编码字符破坏连接串。

默认 `PUBLIC_URL=http://127.0.0.1:5198`，内部 app 监听 3000；PG 不发布主机端口。配置完成后：

```sh
docker compose config --quiet
docker compose up --build --detach --wait app
```

`init` 是独立迁移任务，运行 `pnpm db:prepare`（生成客户端、全站迁移与版本种子），成功后 app 才启动。应用请求进程不重复执行迁移。访问 `http://127.0.0.1:5198`；通过应用首次初始化流程，使用自己保管的 BOOTSTRAP_TOKEN 创建首位管理员。示例库是新编写的教学演示内容，不是 12,934 卡或全量 ECDICT。

检查 `/health/live` 与 `/health/ready`，查看 `docker compose logs init app`。日志只用于自己实例排障；分享前移除凭据与个人数据。`docker compose down` 停止服务但保留 named volume；`down --volumes` 会删除本站数据库，仅用于可丢弃测试安装。

默认 app 监听启动后及每 60 秒执行有界 PG lease 维护，清理过期限流/session/verification与旧任务；先核验本站 DB 绑定，同一任务由 lease 竞争执行。重试耗尽标记 failed，各表每次清理有批次上限。minimal 与 Render 无需额外维护 worker；scale/独立 worker 可复用同一维护入口，不重复消费同一个有效 lease。它仍只是维护任务入口，未实现大型内容异步导入。

生产使用已配置的 HTTPS 入口转发到回环端口，设置真实 `PUBLIC_URL=https://...` 并明确可信代理 CIDR。已有网站占用 443 时不启用第二个抢占端口的入口；先清点配置、生成审阅片段和回滚计划。[官方 Compose 启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)

可信入口须保留或显式设置实际请求的规范 `Host`，并覆盖或按已核验的链规则处理来自客户端的 forwarded IP/proto；不能仅因为 app 信任某个 CIDR 就透传外部任意值。Realm 始终按 wire Host 选择，不使用 X-Forwarded-Host；socket IP profile 使用 Fastify 按 TRUST_PROXY_CIDRS 解析后的 IP。额外反代接在 scale Caddy 前时，也需配置 Caddy 的可信链；否则 Caddy 默认将该反代当作客户端，正常用户可能共享同一限流桶。伪造 forwarded host 不应切换站点，伪造 forwarded IP 不应绕过限流。

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

相应环境变量写在私有 `.env`，Compose 传给 init/app/worker。每站 DB 和密钥单独准备；新增站点不是一个按钮自动创建数据库。`pnpm db:deploy` 按配置串行迁移每个目标 DB，`pnpm db:seed` 按配置写各站版本种子，`pnpm db:prepare` 顺序执行 generate/deploy/seed；不能只准备一站就上线整个 registry。再核对 `pnpm sites:check`。站点管理员不修改全局 host 或数据库映射。

`basePath` 使用空字符串或 `/school-a` 等规范路径，无尾斜杠；`publicUrl` 路径与其一致。配置站点数不得超过 MAX_ACTIVE_SITES，超出会启动失败；每站池也有硬上限。当前没有自动 LRU 淘汰。`/health/ready` 位于固定根路径并检查所有配置站点，因此也支持只有子路径的安装，但任一站 DB 异常会使整个副本 unready。总连接预算计算所有 Web/worker 副本的全部配置站点池，并预留迁移/运维连接。子路径认证、跨站点隔离及生产代理要按当前测试证据验收。

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

该文件不会自行创建云资源。部署者在 Render 审阅费用、创建资源并检查首次构建/ready；PUBLIC_URL 从官方 RENDER_EXTERNAL_URL 引用，自定义域名须验证后更新配置。没有挂载 runtime 持久盘，业务持久化在 PG，当前不支持会丢失的本地媒体上传。[Render Blueprint 规范](https://render.com/docs/blueprint-spec)、[Docker 部署](https://render.com/docs/docker)

新增站点由 operator 准备另一独立 DB/连接，再登记 Realm；不承诺免费数据库长期保存、无限租户或生产 SLA。Render 平台实际创建与恢复尚未验证，不展示已可一键使用的成功徽章。

Blueprint 显式设置 `CLIENT_IP_PROFILE=render-public`。该模式启动要求平台 `RENDER=true`，只适用于公网 Render Web 的 Cloudflare/Render 受控入口：PG 限流使用受入口覆盖、经单值合法 IP 校验的 CF-Connecting-IP，缺失/无效/链值 API 与初始化请求返回403；固定根 health 探测例外。服务端覆盖供认证库使用的内部客户端 IP 头，不信任用户传入的同名头，也不打开全局 trustProxy。Host 选站始终取 wire Host。

此模式不能用于 Render 私网服务、直连容器或自托管入口；不要手动伪装 `RENDER=true` 来启用。那些部署使用默认 `socket` profile，按受控代理 CIDR 处理真实 IP。上线前通过实际公网入口核验两个客户端不会聚合限流，并检查伪造 XFF/内部 IP 头不能改变计数。[Render 公网/私网客户端 IP 说明](https://render.com/articles/host-pocketbase-on-render)

## 环境变量

| 变量                                 | 用途                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| DATABASE_URL                         | 默认 site 的 PG URL；Compose 空值时使用内网 postgres，native 开发必须设真实 URL    |
| BETTER_AUTH_SECRET / BOOTSTRAP_TOKEN | 认证 secret 至少32字符，bootstrap token 32–256字符；每个 Realm 使用自己的随机值    |
| PUBLIC_URL / BASE_PATH               | 规范公开地址与挂载路径；root basePath 是空字符串                                   |
| REGISTRATION_OPEN                    | `true` / `false`；false 关闭普通注册，不代替初始化管理员                           |
| HOST / PORT                          | 进程监听；容器使用 `0.0.0.0:3000`，主机映射由 Compose 配置                         |
| TRUST_PROXY_CIDRS                    | socket模式的明确可信代理IP/CIDR，逗号分隔、默认空；不用于Realm Host选站            |
| CLIENT_IP_PROFILE                    | 默认socket；render-public仅在Render受控公网Web入口启用，health例外，私网服务不适用 |
| SITES_FILE                           | operator 的私有站点数组文件，路径不是用户可控路由参数                              |
| DB_POOL_SIZE / MAX_ACTIVE_SITES      | 每 Realm 池上限和活动 Realm 上限；副本增加时审核全 cluster 预算                    |
| NIGHTSTUDY_HTTP_PORT                 | Compose 主机回环端口，默认 5198                                                    |
| NIGHTSTUDY_IMAGE                     | 可选已核验发行镜像；空值从当前 checkout 构建本地镜像                               |

## 备份与升级

各站 DB 分别做一致性逻辑备份，另保留 registry/密钥与映射；不要只复制正在写的 PG volume。恢复到新 DB 核验身份、进度和统计后再切换。`pg_dump/pg_restore` 与固定 PG 版本匹配，备份移到另一机器并定期恢复演练。[Postgres 备份](https://www.postgresql.org/docs/current/backup-dump.html)

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

升级先保存备份和当前镜像版本，再检查迁移、重跑独立 init job、启动新 app。不要假定回滚镜像会撤销数据库变更。正式发行时记录 app/schema/dataset 兼容范围；alpha 当前不提供自动无损跨版本恢复保证。

## CI 与镜像发行

CI 对 PR/main 运行锁文件安装、格式检查、独立双 PG17 migration/seed、类型检查、构建、测试、Compose 配置和镜像启动检查；结果以该 commit 的实际 run 为准。没有本地 Docker 时不能把 YAML 解析当成镜像启动通过。

`release.yml` 仅在维护者发布 GitHub Release 时触发，版本 tag 须为 `v0.1.0-alpha.1` 等格式；先复用完整 CI，通过后使用仓库 GITHUB_TOKEN 推送 GHCR（当前目标 linux/amd64），保留版本、commit、provenance 与 SBOM。初次发布后维护者须核对 package visibility，公开仓库不意味着镜像自动公开。当前未创建 Release 或发布发行镜像。部署使用 CI 输出的 `ghcr.io/...@sha256:...` 固定摘要，不依赖浮动 latest。[GitHub 官方镜像发布文档](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
