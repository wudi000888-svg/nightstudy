# 第三方依赖与内容

仓库根 MIT License 适用于本工程新写代码。第三方库、数据、音频、字体、图片和其他内容保留各自许可；不能因为被应用引用就改为 MIT。

## 依赖清单

本工程直接使用 React、TypeScript、Vite、Fastify、Prisma、Better Auth 与 ts-fsrs 实现。安装版本以 pnpm 锁文件为准；构建发行时应从锁定包生成依赖及许可清单，并保留包内 LICENSE/NOTICE。开发工具、生产运行依赖和可选基础设施分别列明。

| 项目           | 上游许可入口                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| React          | [facebook/react LICENSE](https://github.com/facebook/react/blob/main/LICENSE)                                 |
| TypeScript     | [microsoft/TypeScript LICENSE](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt)                 |
| Vite           | [vitejs/vite LICENSE](https://github.com/vitejs/vite/blob/main/LICENSE)                                       |
| Fastify        | [fastify/fastify LICENSE](https://github.com/fastify/fastify/blob/main/LICENSE)                               |
| Prisma         | [prisma/prisma LICENSE](https://github.com/prisma/prisma/blob/main/LICENSE)                                   |
| Better Auth    | [better-auth/better-auth LICENSE.md](https://github.com/better-auth/better-auth/blob/main/LICENSE.md)         |
| ts-fsrs        | [open-spaced-repetition/ts-fsrs LICENSE](https://github.com/open-spaced-repetition/ts-fsrs/blob/main/LICENSE) |
| React Router   | [remix-run/react-router LICENSE.md](https://github.com/remix-run/react-router/blob/main/LICENSE.md)           |
| TanStack Query | [TanStack/query LICENSE](https://github.com/TanStack/query/blob/main/LICENSE)                                 |
| Lucide icons   | [lucide-icons/lucide LICENSE](https://github.com/lucide-icons/lucide/blob/main/LICENSE)                       |
| Zod            | [colinhacks/zod LICENSE](https://github.com/colinhacks/zod/blob/main/LICENSE)                                 |
| node-postgres  | [brianc/node-postgres LICENSE](https://github.com/brianc/node-postgres/blob/master/LICENSE)                   |

这些链接用于来源追溯，不替代锁定发行版本的许可清单。可选 Redis、PgBouncer、Postgres、代理入口及容器基础镜像也应按实际发行版本保留对应声明。

## 演示内容与大数据包

公开仓库使用新编写的演示内容，不包含原部署的编译产物、完整服务端快照、真实词库或账户数据。演示例句应标记为原创教学内容；结构校验与自动规则检查不等于人工语义审核。

后续安装的大词典或媒体包必须提供独立版本、来源、许可/署名、摘要和文件校验；其许可与代码分开列明。未完成来源核验的资产不应出现在公开 Git、发行镜像或 Release 中。

## 设计参考

产品保留雨夜学习方向，界面和资源重新实现。多站部署方案只参考通用工程原则，见 [参考证据](docs/architecture/multisite-reference.md)；不复制 guangyue-panel 的代理业务、产品标识或代码。其许可证不由本仓库 MIT 重新授权。
