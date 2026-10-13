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

公开Git包含新源码、原创演示/测试内容、固定来源manifest与许可声明；大型源CSV通过工具下载到忽略目录。原部署的编译产物、完整服务端快照、旧ZIP词库、账户数据和密钥没有作为公开资产或完整内容输入。演示例句标记为原创教学内容；结构校验与自动规则检查不等于人工语义审核。

词典或媒体包提供独立版本、来源、许可/署名、摘要和文件校验；其许可与代码分开列明。未完成来源核验的资产不应出现在公开 Git、发行镜像或 Release 中。

## ECDICT 完整基础词典

采用 [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT) 固定commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b` 的基础CSV。源大小65,933,428字节，SHA256与覆盖率见 [manifest](data/content-ecdict.manifest.json) 和 [CONTENT.md](docs/CONTENT.md)。保留 Copyright (c) 2025 Linwei 与 [原MIT许可全文](data/content-ecdict.LICENSE.txt)。新代码的MIT不作为推断所有数据授权的唯一依据。

上游关于商业APP/随包离线词库分发的直接问题，在2026-09-30得到仓库OWNER `skywind3000` [明确许可使用且无额外要求的回复](https://github.com/skywind3000/ECDICT/issues/134#issuecomment-5902723743)。该授权关联和链接随manifest保存。[源README](https://github.com/skywind3000/ECDICT/blob/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/README.md) 披露 EDictAZ、cdict、WordNet、爬取资料及网友贡献等混合历史来源，本项目未承诺逐条完成第三方原始资料清权。

数据处理包括规范词形、拆分原始义项、识别明示词性及相同内容去重；未生成不存在的释义、音标、例句或录音。上游考试标签保持来源名称，不宣称完整当前官方考试大纲。原始音标有旧式写法，现代区域IPA属于下述独立数据许可。

## 独立区域 IPA 数据

美式IPA采用 [open-dict-data/ipa-dict固定版本](https://github.com/open-dict-data/ipa-dict/tree/43c3570eb3553bdd19fccd2bd0091534889af023) 的en_US.txt，保留ipa-dict（dohliam）、cmudict-ipa（Lingliang Zhang）的MIT通知与CMUdict BSD-style通知；ContentPack许可为 `MIT AND BSD-2-Clause`。英式en_UK.txt派生自ipacards（源仓库现为melissaboiko/ipacards），依据上游credits保留 `GPL-3.0-only` 独立数据许可，应用代码MIT不重新许可该数据。

音标工具在 `.local/content/phonetics` 分别保留source.tsv、固定SHA256 manifest、NOTICE及原许可全文，大源文件不进入Git或应用镜像。音标自动/半自动处理可能有误，不包含商业原声录音。数据来源、修改与再分发说明见 [PHONETICS.md](docs/PHONETICS.md)。

## 设计参考

产品保留雨夜学习方向，界面和资源重新实现。多站部署方案只参考通用工程原则，见 [参考证据](docs/architecture/multisite-reference.md)；不复制 guangyue-panel 的代理业务、产品标识或代码。其许可证不由本仓库 MIT 重新授权。
