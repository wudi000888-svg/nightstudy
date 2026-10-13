# 贡献指南

NightStudy 当前处于 alpha 施工阶段。请围绕一个明确的问题提交 issue 或 PR，描述用户操作、预期结果及实际结果；较大架构变更先讨论目标和兼容边界。

## 开发约定

- 使用 Node.js 24、pnpm 11 和仓库锁文件；脚本与环境变量以根 README 和 package.json 为准。
- Web、API、worker/job 共享版本及类型契约。数据库迁移提交到仓库，通过独立部署任务应用。
- 站点由 operator 的 SiteRegistry 选择固定 Realm/数据库。站点管理员不管理全局域名或连接凭据。
- 数据库调用、任务、缓存、Cookie 和浏览器状态保持 site/user scope；不接受来自客户端的任意租户切换。
- 使用原创小型演示内容和合成夹具做测试。完整内容须有独立许可、固定版本、来源及摘要；大CSV/TSV下载到忽略的缓存，不提交原工程快照、真实用户导出、运行数据库或秘密。

## 验证与提交

先按 [README](README.md) 配置和构建，再运行 `pnpm format:check`、`pnpm sites:check`、`pnpm typecheck`、`pnpm build`，最后一次 `pnpm test`。`pnpm format` 可自动格式化；当前没有lint脚本。报告实际结果和尚未验证的部分。认证、权限、进度、迁移和并发问题需要针对触发条件的回归验证；样式与文档修改不要求机械增加测试。

真实PG测试只用于可丢弃数据库，名称必须以 `_test` 结尾；TEST_DATABASE_URL、TEST_DATABASE_URL_B分别指向两个独立已迁移/seed库。使用独立测试配置，不能让生产SITES_FILE或连接进入测试环境。准备测试库时显式 `CONTENT_PACK=demo`，避免默认db:prepare在测试前下载/安装完整内容：

```sh
SITES_FILE= CONTENT_PACK=demo DATABASE_URL="$TEST_DATABASE_URL" pnpm db:prepare
SITES_FILE= CONTENT_PACK=demo DATABASE_URL="$TEST_DATABASE_URL_B" pnpm db:prepare
SITES_FILE= CONTENT_PACK=demo DATABASE_URL="$TEST_DATABASE_URL" CONTENT_TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm test
```

测试环境仍需README要求的独立认证/初始化配置。TEST_DATABASE_URL激活API PG集成，TEST_DATABASE_URL_B激活第二站隔离，CONTENT_TEST_DATABASE_URL激活 `scripts/content-lib.test.ts` 的受限PG夹具；缺变量时对应case跳过，不能将纯单元通过写成PG通过。完整suite已经包括内容parser与PG fixture，不需再重复执行 `pnpm test:content`；该CLI只用于独立排障。

集成suite会创建/删除合成用户、修改SiteState与限流记录，不能指向生产或日常开发库。内容夹具先拒绝非空fixture命名空间，仅安装3行原创合成CSV，验证摘要失败不写库、原ID/旧Sense保留、admin编辑保护、幂等、错误站点与事务回滚；结束精确清理自建词/词义/词书/pack，并恢复SiteState的contentVersion/initialized/initializedAt。它不全量再次导入770k，也不把合成文本或假音标作为学习数据。

CI使用双PG17演示测试库、激活上述源码fixture并只运行一次pnpm test；另在隔离Compose安装完整ECDICT/英美音标、明确核对installedDictionary=true/declaredEntryCount=770611，并做网关健康与401鉴权smoke。代码基线 `577f48b` 的本机55项测试及 [CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38486206457) 均已通过，包括真实PG17/完整Compose安装。VPS也已发布同一版本，完成22项生产HTTP检查、容器重建后的数据保留及独立临时库恢复。记录证据时固定实际验收的代码版本，不把文档后续提交、容器重建或本机结果扩写为未执行的主机断电恢复、手机live、跨机HA或生产容量；详细范围见 [部署文档](docs/DEPLOYMENT.md)。

内容/音标工具贡献遵循 [CONTENT.md](docs/CONTENT.md)、[PHONETICS.md](docs/PHONETICS.md) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。缺例句、IPA或录音时保持缺失；不得猜测数据覆盖、将旧式音标标为验证过的现代IPA，或把上游考试标签写成官方完整大纲。在线翻译的provider、网关与失败契约见 [TRANSLATION.md](docs/TRANSLATION.md)，不能把受控mock通过当作真实Google/VPS链路通过。

PR 说明要包含问题、修改后行为及验证。改变部署、数据结构或外部契约时，同步更新文档和升级步骤。不要用未经测量的 QPS、在线人数或测试夹具结果宣称生产容量。

提交新代码表示你有权贡献该内容，并同意按本仓库 MIT License 分发。第三方内容须注明原许可、来源及必要署名；MIT 不会覆盖其原许可。

参与过程中遵守 [行为准则](CODE_OF_CONDUCT.md)。敏感漏洞按 [安全政策](SECURITY.md) 报告。
