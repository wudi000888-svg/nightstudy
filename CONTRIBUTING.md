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
SITES_FILE= ADMIN_BOOTSTRAP=manual CONTENT_PACK=demo DATABASE_URL="$TEST_DATABASE_URL" pnpm db:prepare
SITES_FILE= ADMIN_BOOTSTRAP=manual CONTENT_PACK=demo DATABASE_URL="$TEST_DATABASE_URL_B" pnpm db:prepare
SITES_FILE= ADMIN_BOOTSTRAP=manual CONTENT_PACK=demo DATABASE_URL="$TEST_DATABASE_URL" CONTENT_TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm test
```

测试环境仍需README要求的独立认证/初始化配置。TEST_DATABASE_URL激活API PG集成，TEST_DATABASE_URL_B激活第二站隔离，CONTENT_TEST_DATABASE_URL激活 `scripts/content-lib.test.ts` 的受限PG夹具；缺变量时对应case跳过，不能将纯单元通过写成PG通过。完整suite已经包括内容parser与PG fixture，不需再重复执行 `pnpm test:content`；该CLI只用于独立排障。

集成suite会创建/删除合成用户、修改SiteState与限流记录，不能指向生产或日常开发库。内容夹具先拒绝非空fixture命名空间，仅安装3行原创合成CSV，验证摘要失败不写库、原ID/旧Sense保留、admin编辑保护、幂等、错误站点与事务回滚；结束精确清理自建词/词义/词书/pack，并恢复SiteState的contentVersion/initialized/initializedAt。它不全量再次导入770k，也不把合成文本或假音标作为学习数据。

CI使用双PG17测试库与manual/demo基线，完整suite仅执行一次；独立bootstrap与群站回归另使用合成命名空间。自动管理员需验证首次凭据可恢复、失败重试/并发、既有管理员不重置；群站需验证单次票据、scope、tuple/密文绑定、撤销/并发与SSRF，更新需区分无发布和源故障。不要在测试输出暴露真实密码、配对票据或长期凭据。

0.3代码86afefa的86项测试及 [CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38491439614) 通过PG17/完整Compose安装、随机管理员密码实际登录及网关健康/401；VPS42项真实HTTPS管理员/双站检查通过并清理临时站点。本机完成桌面管理界面检查。历史0.2的55项/22项HTTP与独立库恢复证据保留。不要扩写为未执行的主机断电、新版手机、跨机HA及容量。提交文档时固定实际验收的代码基线，详见 [部署文档](docs/DEPLOYMENT.md)。

内容/音标工具贡献遵循 [CONTENT.md](docs/CONTENT.md)、[PHONETICS.md](docs/PHONETICS.md) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。缺例句、IPA或录音时保持缺失；不得猜测数据覆盖、将旧式音标标为验证过的现代IPA，或把上游考试标签写成官方完整大纲。在线翻译的provider、网关与失败契约见 [TRANSLATION.md](docs/TRANSLATION.md)，不能把受控mock通过当作真实Google/VPS链路通过。

PR 说明要包含问题、修改后行为及验证。改变部署、数据结构或外部契约时，同步更新文档和升级步骤。不要用未经测量的 QPS、在线人数或测试夹具结果宣称生产容量。

0.6词级双语内容不使用本地翻译模型，保留独立原语言Sense、canonical词条与非空源文；不为了成对数量强行合并义项。真实例句须保留两端句ID、署名角色、许可和文本摘要；Codex辅助原创另标MIT/generated/pending，不伪造语料编号或专家审核。源词形无法确认时保留警告和空例句。制作输入不能含私有用户词书或学习记录，规则见 [BILINGUAL_CONTENT.md](docs/BILINGUAL_CONTENT.md)。

DeepSeek测试使用受控上游响应和隔离测试库，不能把CI测试写成付费真实调用或语义质量通过。不提交真实API key；配置DTO只可回遮罩。新增自动熟词规则须验证首学/拼写/回执重试不生证据、不同学习日去重、Again恢复与手动来源独立，不能回填伪造的复习历史。

提交新代码表示你有权贡献该内容，并同意按本仓库 MIT License 分发。第三方内容须注明原许可、来源及必要署名；MIT 不会覆盖其原许可。

参与过程中遵守 [行为准则](CODE_OF_CONDUCT.md)。敏感漏洞按 [安全政策](SECURITY.md) 报告。
