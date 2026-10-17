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

## 双语内容与例句

早期 `bilingual-v1` 的精选例句来自 Tatoeba 固定英语导出，依据 **CC-BY-2.0-FR**（法国版）逐句保留作者用户名、句子编号、原句链接和许可；中文机器翻译属于改编，保留原来源并说明修改。为准确区分法国版，容器声明使用 `LicenseRef-CC-BY-2.0-FR`，其准确许可全文和来源保存在 [bilingual-licenses](data/bilingual-licenses) 及 [来源manifest](data/bilingual-source.manifest.json)。应用MIT不重新许可社区语料。

上述早期制作使用的 Helsinki-NLP 中英两个方向模型分别为 CC-BY-4.0 和 Apache-2.0，不混同许可。固定卡片、原始权重SHA和模型作者留存；模型用于独立离线制作任务，发行源码/运行镜像不含这些模型权重，也不以模型许可覆盖原文许可。少量缺口例句是NightStudy贡献者的Codex辅助原创，依据MIT分发，明确生成与待校对。范围、质量边界和逐字段来源见 [双语内容说明](docs/BILINGUAL_CONTENT.md)。

0.10 的 `bilingual-v2` 使用固定公开语料及 Codex 直接撰写：9,546 条新增独立双语例句中，212 对沿用公开英中句子，5,186 条沿用公开英文并新增中译，4,148 条为 Codex 辅助原创双语用法。公开语料沿用逐句作者、编号、链接与 CC-BY-2.0-FR；新译属于改编，不把公开原文改标 MIT。新增释义对应、学习纠错义项、例句译写及原创内容层由 NightStudy 贡献者制作并按 MIT 分发，原有词典内容仍保留其来源与许可。17 条既有例句的精确更正保留原英中全文和完整原元数据，新的译写与必要的英文更正另记来源。

本轮文本制作不使用付费 API 或本地翻译模型；早期包的模型制作声明不能套用于 v2。新的文字保留待校对状态，结构校验与 Codex 语义抽查不等于逐条专家认证。范围与字段数见 [0.10 内容说明](docs/CONTENT_BILINGUAL_POLISH_010.md)，固定制作清单见 [v2 来源 manifest](data/bilingual-v2.sources.manifest.json)。

制作档案 `bilingual-v2-authoring.tar.gz` 包含公开源投影、候选台账、制作稿和源绑定审核决定，不含用户数据、数据库备份、密钥或模型。档案中的原创层与各公开来源许可分别保留。固定字节数与 SHA-256 见 [v2 来源 manifest](data/bilingual-v2.sources.manifest.json)，本地复现和公开附件验收按交付记录补充。

## 辨义选项的公开词汇关系索引

辨义选项的排除索引派生自 Princeton University 的 WordNet 3.0 数据，保留 [WordNet 原许可和版权通知](data/recognition-wordnet.LICENSE.txt)。原始压缩包、独立词条目标和派生文件的摘要见 [固定 manifest](data/recognition-confusables-v1.manifest.json)。参考 [官方许可说明](https://wordnet.princeton.edu/license-and-commercial-use) 与 [WordNet 引用说明](https://wordnet.princeton.edu/citing-wordnet)：Princeton University “About WordNet.” WordNet. Princeton University, 2010。

此索引仅保守排除同一 synset 及直接上下位、相似关系的词对，并显式记录少量 Codex 补充排除项；它没有沿所有祖先递归扩展，也不提供完整的语义重叠认证。派生数据经过规范词形、按固定内置词表投影和关系对称化；未把 WordNet 的许可改为工程代码的 MIT。新写的逐义双语释义和例句另按实际作者与逐字段来源登记，不借该索引声称其文本来自 WordNet。

## 设计参考

产品保留雨夜学习方向，界面和资源重新实现。多站部署方案只参考通用工程原则，见 [参考证据](docs/architecture/multisite-reference.md)；不复制 guangyue-panel 的代理业务、产品标识或代码。其许可证不由本仓库 MIT 重新授权。
