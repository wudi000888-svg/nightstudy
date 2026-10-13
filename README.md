# NightStudy · 夜读英语

[![CI](https://github.com/wudi000888-svg/nightstudy/actions/workflows/ci.yml/badge.svg)](https://github.com/wudi000888-svg/nightstudy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

雨夜里的语境背词与间隔复习。NightStudy 是可自行部署的多用户英语学习应用，围绕语境词书、FSRS 复习、熟词测试、记忆曲线、用户中心与基本管理后台建设。

![NightStudy 雨夜自习室](docs/media/preview.png)

[查看个人记忆页面](docs/media/memory-preview.png) · [开发路线与问题](https://github.com/wudi000888-svg/nightstudy/issues) · [部署指南](docs/DEPLOYMENT.md)

**当前状态：`0.2.0-alpha.1`，已在本机完整导入 770,611 条 ECDICT 词典数据。** 中文释义、多词义详情、独立英美音标数据、设备语音朗读与在线翻译面板已实现。上一版 PG17/Docker/Compose [CI 已通过](https://github.com/wudi000888-svg/nightstudy/actions/runs/38452093122)；本版完整内容安装与网关容器由新 CI 验收，结果见上方 CI。Render、目标 VPS 实际部署和高并发容量尚未验证。具体变化见 [CHANGELOG](CHANGELOG.md)。

## 产品与边界

- 保留雨夜背景、专注卡片和简洁学习节奏，支持桌面与手机。
- 普通用户拥有本站词书选择、学习进度、复习记录、熟词声明、生词本及设置。
- 固定会话先回忆、再评价、再拼写；动作去重与版本冲突保护避免重复评价。个人曲线使用真实 FSRS 状态，无数据时显示空态。
- 每日新词目标约束新组预约；已签发的一组可继续完成，降低目标不会把学习中途锁住。同词预约去重，并发新组由服务端事务保护。
- 管理员维护本站用户和学习内容；部署 operator 管理站点域名与数据库映射。
- 同一份源码可独立部署多站，也可由共享后端按可信 host 选择每站独立 Postgres/认证 Realm。
- 真租户默认使用独立域名或子域名。同域子路径只用于同一信任域内的共存，不能作为浏览器强隔离。

统一技术栈：React + TypeScript + Vite、Fastify、Prisma 7、Better Auth、Postgres 17、Node.js 24 与 pnpm 11 workspace。同一 Node 容器提供 Web/API；默认学习体验无需付费 AI、OAuth 或对象存储。

完整初次安装下载固定版本的独立内容包，校验 SHA-256，再在各站数据库事务内发布。词典有 770,611 条词目、768,739 条上游中文释义和 160,884 条英文释义；现代美音 IPA 匹配 83,424 个词，英音匹配 64,321 个词，至少一种匹配 104,261 个词。原音标保真保留，未覆盖词不伪造 IPA。发音使用设备真实可用的英美语音，当前无真人录音库。数据没有提供的例句保持为空。

五本新词书：常用英语 3,277 词、高考方向 3,677 词、四级方向 3,849 词、六级方向 5,407 词、雅思方向 5,040 词。它们完整导入固定源的对应频率规则或标签，不宣称等于当前官方考试大纲。原 40 词演示书保留，已有用户进度与词 ID 不变。来源、授权、音标局限见 [内容包](docs/CONTENT.md) 与 [发音数据](docs/PHONETICS.md)。

在线翻译面板可经私密 VPS 网关访问 Google 网页兼容接口，原文不写数据库。该接口非官方、可能限流，错误会显示给用户并提供 Google 官方网页入口；Google 网页不支持直接 iframe。本机目前实际遇到上游 429，不能把网关代码可运行当成目标 VPS 已连通或已加速。部署和验收见 [在线翻译](docs/TRANSLATION.md)。

## 构建与部署

Docker Compose 路径：复制配置，在私有 `.env` 填入不同的 PG 密码、认证密钥与初始化口令，再启动。每个随机值可单独运行 `openssl rand -hex 32` 生成。

```sh
cp .env.example .env
mkdir -p .local/sites
# 编辑 .env：POSTGRES_PASSWORD、BETTER_AUTH_SECRET、BOOTSTRAP_TOKEN
docker compose config --quiet
docker compose up --build --detach --wait --wait-timeout 600 app
```

访问 `http://127.0.0.1:5198`，通过首次初始化页面，用本站初始化口令创建管理员，然后登录。`init` 独立任务负责迁移、种子和完整内容安装；PG 与内容源缓存各在 named volume。首次下载约 71 MB，数据库还需要词条、词义和索引的空间；安装耗时取决于 VPS。`CONTENT_PACK=demo` 可显式选择 40 词最小体验。完整变量、HTTPS、备份、多站与 scale 扩展见 [部署文档](docs/DEPLOYMENT.md)。不要对需要保留数据的安装使用 `down --volumes`。

Native 开发使用 Node 24 与 pnpm 11.25.0，并自行准备可访问的 PG 数据库。在 `.env` 填入真实 DATABASE_URL 与两个随机密钥后：

```sh
pnpm install --frozen-lockfile
pnpm db:prepare
pnpm build
pnpm dev
```

Web 开发地址 `http://127.0.0.1:5173`，API 开发地址 `http://127.0.0.1:5198`。生产同进程启动用 `pnpm start`；app 自带启动后/60秒有界 PG lease 维护，额外 worker 可用 `pnpm worker` 竞争同一 lease。检查命令为 `pnpm format:check`、`pnpm sites:check`、`pnpm typecheck`、`pnpm build`、`pnpm test`；真实 PG 集成测试需额外配置独立且名称以 `_test` 结尾的 TEST_DATABASE_URL，见 [贡献指南](CONTRIBUTING.md)。

[在 Render 审阅部署配置](https://render.com/deploy?repo=https://github.com/wudi000888-svg/nightstudy) 使用仓库 `render.yaml`，只创建首站 Web/PG 描述，采用付费资源规格；自行审阅费用与构建结果。默认无额外付费维护 worker；显式 render-public IP profile 仅适用于 Render 受控公网入口，私网/自托管使用 socket 模式。此入口尚未做平台实测，不自动创建无限租户。

架构约定见 [架构](docs/architecture/ARCHITECTURE.md)、[多站与并发方案](docs/architecture/MULTISITE_AND_SCALING.md)。真人录音、PgBouncer、Redis provider、跨主机 HA 和实测高并发容量仍待实现/验收。当前 API 契约见 [API.md](docs/API.md)。词典/词书分页和学习选词不再被前 500/1,000 词截断；熟词导出以游标分批流式输出全部记录。

## 本机验证与待验收项

以下记录对应 2026-10-14 本机验证，使用合成账户。完整词库导入与测试 fixture 分开验收，不能据此推断生产容量。

| 验证项                | 结果与范围                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 格式与类型            | format:check、typecheck 全部通过，包含 API 测试与工具脚本                                                          |
| 真实数据库与 provider | PG18.4 核心集成、provider、网关和内容 parser 检查；包括 11,001 条熟词完整导出、学习跨过首 1,000 词、鉴权及错误处理 |
| 完整内容              | 实际安装 770,611 词、1,113,723 条新增源词义、五本源词书及独立英美音标包；原 40 词 ID 和学习历史保留                |
| 桌面浏览器实测        | 注册、管理员/普通用户、两组学习与拼写、刷新恢复、复习、生词本、熟词批次、目标测试报告/计划、个人曲线完成           |
| 手机尺寸实测          | 390 × 844 布局与学习流程完成                                                                                       |
| 断网恢复实测          | 揭晓动作本地暂存后恢复，PG 确认回执恰好 1 条，无 Review；只验证该场景                                              |
| PG17 / 容器 / Compose | 上一版已通过；本版 CI 包含完整字典与英美音标安装、catalog 数量校验、闭合网关容器鉴权 smoke                         |
| Google / VPS          | 首次公共接口返回真实结果，之后本机 Node 和 curl 实测均被 Google 限流；目标 VPS 未提供连接信息                      |
| Render                | Blueprint 已准备，实际创建/部署/恢复未执行                                                                         |
| 容量与正式镜像        | 尚无高并发基准与正式发行容器                                                                                       |

后续进展见公开 [Issues](https://github.com/wudi000888-svg/nightstudy/issues) 与 [Milestones](https://github.com/wudi000888-svg/nightstudy/milestones)。上一版 CI 对应源码 commit `a2d8e7d`；本版证据以新 run 为准，Render 与高并发容量仍按路线逐项验收。

## 内容与许可

本仓库公开新工程、原创演示内容，以及外部内容包的固定版本清单、校验与安装工具。大型词典、音标源和各自许可证作为独立数据下载，不复制原部署词库或打进应用镜像。原服务端快照、编译产物、账户库、密钥与运行数据不在公开仓库中。应用代码 MIT 不会改变英美音标等数据的原有许可。

新写代码采用 [MIT License](LICENSE)。第三方依赖、内容、媒体与数据保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 参与

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不在公开 issue 附上凭据或个人数据。
