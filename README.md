# NightStudy · 夜读英语

[![CI](https://github.com/wudi000888-svg/nightstudy/actions/workflows/ci.yml/badge.svg)](https://github.com/wudi000888-svg/nightstudy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

雨夜里的语境背词与间隔复习。NightStudy 是可自行部署的多用户英语学习应用，围绕语境词书、FSRS 复习、熟词测试、记忆曲线、用户中心与基本管理后台建设。

![NightStudy 雨夜自习室](docs/media/preview.png)

[查看个人记忆页面](docs/media/memory-preview.png) · [开发路线与问题](https://github.com/wudi000888-svg/nightstudy/issues) · [部署指南](docs/DEPLOYMENT.md)

**当前状态：`0.1.0-alpha.1` 首版 alpha 已在本机运行验证，尚未正式发行容器。** 原创演示词表的核心学习、账户与管理流程可运行；PG17/Docker/Compose 已在 [GitHub CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38452093122) 通过验证。Render 实际部署尚未执行，高并发容量尚未测量。具体代码变化见 [CHANGELOG](CHANGELOG.md)。

## 产品与边界

- 保留雨夜背景、专注卡片和简洁学习节奏，支持桌面与手机。
- 普通用户拥有本站词书选择、学习进度、复习记录、熟词声明、生词本及设置。
- 固定会话先回忆、再评价、再拼写；动作去重与版本冲突保护避免重复评价。个人曲线使用真实 FSRS 状态，无数据时显示空态。
- 每日新词目标约束新组预约；已签发的一组可继续完成，降低目标不会把学习中途锁住。同词预约去重，并发新组由服务端事务保护。
- 管理员维护本站用户和学习内容；部署 operator 管理站点域名与数据库映射。
- 同一份源码可独立部署多站，也可由共享后端按可信 host 选择每站独立 Postgres/认证 Realm。
- 真租户默认使用独立域名或子域名。同域子路径只用于同一信任域内的共存，不能作为浏览器强隔离。

统一技术栈：React + TypeScript + Vite、Fastify、Prisma 7、Better Auth、Postgres 17、Node.js 24 与 pnpm 11 workspace。同一 Node 容器提供 Web/API；默认学习体验无需付费 AI、OAuth 或对象存储。内置 **40 个原创演示词、五个目标演示词书**，测试结论只覆盖演示内容，不能当作完整考试词汇量。

## 构建与部署

Docker Compose 路径：复制配置，在私有 `.env` 填入不同的 PG 密码、认证密钥与初始化口令，再启动。每个随机值可单独运行 `openssl rand -hex 32` 生成。

```sh
cp .env.example .env
mkdir -p .local/sites
# 编辑 .env：POSTGRES_PASSWORD、BETTER_AUTH_SECRET、BOOTSTRAP_TOKEN
docker compose config --quiet
docker compose up --build --detach --wait app
```

访问 `http://127.0.0.1:5198`，通过首次初始化页面，用本站初始化口令创建管理员，然后登录。`init` 独立任务负责迁移和版本种子；PG 数据在 named volume。完整变量、HTTPS、备份、多站与 scale 扩展见 [部署文档](docs/DEPLOYMENT.md)。不要对需要保留数据的安装使用 `down --volumes`。

Native 开发使用 Node 24 与 pnpm 11.25.0，并自行准备可访问的 PG 数据库。在 `.env` 填入真实 DATABASE_URL 与两个随机密钥后：

```sh
pnpm install --frozen-lockfile
pnpm db:prepare
pnpm build
pnpm dev
```

Web 开发地址 `http://127.0.0.1:5173`，API 开发地址 `http://127.0.0.1:5198`。生产同进程启动用 `pnpm start`；app 自带启动后/60秒有界 PG lease 维护，额外 worker 可用 `pnpm worker` 竞争同一 lease。检查命令为 `pnpm format:check`、`pnpm sites:check`、`pnpm typecheck`、`pnpm build`、`pnpm test`；真实 PG 集成测试需额外配置独立且名称以 `_test` 结尾的 TEST_DATABASE_URL，见 [贡献指南](CONTRIBUTING.md)。

[在 Render 审阅部署配置](https://render.com/deploy?repo=https://github.com/wudi000888-svg/nightstudy) 使用仓库 `render.yaml`，只创建首站 Web/PG 描述，采用付费资源规格；自行审阅费用与构建结果。默认无额外付费维护 worker；显式 render-public IP profile 仅适用于 Render 受控公网入口，私网/自托管使用 socket 模式。此入口尚未做平台实测，不自动创建无限租户。

架构与后续施工约定见 [架构](docs/architecture/ARCHITECTURE.md)、[多站与并发方案](docs/architecture/MULTISITE_AND_SCALING.md)。完整词典 pack、媒体 provider、PgBouncer、Redis provider 和实测高并发容量仍待实现/验收。当前 API 契约见 [API.md](docs/API.md)。

## 本机验证与待验收项

以下记录对应 2026-10-14 首版源码验证，使用合成账户与原创演示内容；不能据此推断生产容量。

| 验证项                | 结果与范围                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 格式与类型            | format:check、typecheck 全部通过，包含 API 测试与工具脚本                                                                                       |
| 真实数据库测试        | PG18.4，3 个文件、28 项测试全部通过；含双站 DB/Cookie、初始化/角色保护、FSRS 幂等、熟词撤销、测试与 Review 分离、目标中途降低及同书并发预约限额 |
| 桌面浏览器实测        | 注册、管理员/普通用户、两组学习与拼写、刷新恢复、复习、生词本、熟词批次、目标测试报告/计划、个人曲线完成                                        |
| 手机尺寸实测          | 390 × 844 布局与学习流程完成                                                                                                                    |
| 断网恢复实测          | 揭晓动作本地暂存后恢复，PG 确认回执恰好 1 条，无 Review；只验证该场景                                                                           |
| PG17 / 容器 / Compose | [CI 通过](https://github.com/wudi000888-svg/nightstudy/actions/runs/38452093122)：双独立 PG17、28 项测试、镜像构建与 Compose 启动               |
| Render                | Blueprint 已准备，实际创建/部署/恢复未执行                                                                                                      |
| 容量与正式镜像        | 尚无高并发基准与正式发行容器                                                                                                                    |

后续进展见公开 [Issues](https://github.com/wudi000888-svg/nightstudy/issues) 与 [Milestones](https://github.com/wudi000888-svg/nightstudy/milestones)。上述 CI 对应源码 commit `a2d8e7d`；Render 与高并发容量仍按路线逐项验收。

## 内容与许可

本仓库只公开新工程、原创演示内容和可确认来源的资源。原部署的完整服务端快照、编译产物、真实词库、账户库、密钥与运行数据不在公开仓库中。大型词典可在后续版本作为独立、带来源和校验摘要的数据包选择安装，不能默认把缺失资产当作完整词典。

新写代码采用 [MIT License](LICENSE)。第三方依赖、内容、媒体与数据保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 参与

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不在公开 issue 附上凭据或个人数据。
