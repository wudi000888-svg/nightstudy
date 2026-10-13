# NightStudy · 夜读英语

雨夜里的语境背词与间隔复习。NightStudy 正在建设为可自行部署的多用户英语学习应用，提供词书学习、FSRS 复习、熟词测试、记忆曲线、用户中心与基本管理后台。

**当前状态：alpha 施工中。** 这是新建的 React/TypeScript 与 Node 工程。架构已确定，功能、部署描述和自动化验证正在逐项实现；目前不承诺生产可用性、具体吞吐或所有规划功能已完成。

## 产品与边界

- 保留雨夜背景、专注卡片和简洁学习节奏，支持桌面与手机。
- 普通用户拥有独立词书选择、学习进度、复习记录及设置。
- 管理员维护本站用户和学习内容；部署 operator 管理站点域名与数据库映射。
- 同一份源码可独立部署多站，也可由共享后端按可信 host 选择每站独立 Postgres/认证 Realm。
- 真租户默认使用独立域名或子域名。同域子路径只用于同一信任域内的共存，不能作为浏览器强隔离。

统一技术栈：React + TypeScript + Vite、Fastify、Prisma、Better Auth、Postgres、Node.js 24 与 pnpm 11 workspace。部署入口将提供 Docker Compose 和 Render Blueprint；默认学习体验无需付费 AI、OAuth 或对象存储。

## 构建与部署

构建脚本和启动契约正在建立。可运行的命令、环境变量与验证结果会随首个 alpha 构建补齐；当前请先阅读 [架构](docs/architecture/ARCHITECTURE.md)、[多站与并发方案](docs/architecture/MULTISITE_AND_SCALING.md) 和 [部署设计](docs/architecture/deployment-design-notes.md)。这些文件中的未来命令或拓扑是施工约定，不表示已经部署。

计划交付 minimal Compose（应用、Postgres、独立迁移任务）与 scale 扩展（多 Web/worker、连接池、可选共享队列）。Render 入口只描述首站资源，不自动创建无限租户，也不会替使用者开通付费资源。

## 内容与许可

本仓库只公开新工程、原创演示内容和可确认来源的资源。原部署的完整服务端快照、编译产物、真实词库、账户库、密钥与运行数据不在公开仓库中。大型词典可在后续版本作为独立、带来源和校验摘要的数据包选择安装，不能默认把缺失资产当作完整词典。

新写代码采用 [MIT License](LICENSE)。第三方依赖、内容、媒体与数据保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 参与

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不在公开 issue 附上凭据或个人数据。
