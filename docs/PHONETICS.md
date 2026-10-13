# 英美 IPA 数据包

NightStudy 应用代码使用 MIT。外部数据保留各自许可证，不因写入 PostgreSQL 而改为 MIT。这两个音标包不含音频；网页发音使用设备上实际可用的浏览器语音。

本工具固定使用 [open-dict-data/ipa-dict 的 43c3570eb3553bdd19fccd2bd0091534889af023 提交](https://github.com/open-dict-data/ipa-dict/tree/43c3570eb3553bdd19fccd2bd0091534889af023)。该项目提供音位层面的 IPA，并注明数据来自人工和半自动处理；不是每个词都经过人工校对，多个可能读音也未必与某个词义一一对应。工具保留源串中的全部变体，不猜测未覆盖词的读音，也不将 ECDICT 旧式音标冒充现代 IPA。

| 数据包                | 来源行数 | SHA-256                                                            | 许可                           |
| --------------------- | -------: | ------------------------------------------------------------------ | ------------------------------ |
| `ipa-us-43c3570eb355` |  125,927 | `2af6f154a5c363275f052d1f85acedef38ed185ca9745aa4314be77f6b70de67` | MIT；保留 CMUdict BSD 风格通知 |
| `ipa-uk-43c3570eb355` |   65,119 | `221394caef0cf723b4f2df81a98ac33191293257b88aed5b1fb89466d3a0dc77` | GPL-3.0-only，独立数据包       |

上表是源条目数。站点已有词条的匹配数量以导入结果及 `ContentPack.tagCounts` 为准，不能把音标条目数加到词典词汇数量中。

## 下载与导入

先执行词库导入，再准备 IPA。多个站点分别导入各自数据库。

```sh
pnpm exec tsx scripts/phonetics-prepare.ts --fetch-only
pnpm exec tsx scripts/phonetics-prepare.ts --site default
```

默认下载和导入两种口音；使用 `--locale us` 或 `--locale uk` 可以只处理一个数据包。`--directory` 指定源文件缓存目录，默认 `.local/content/phonetics`。单站点配置可省略 `--site`，多个站点必须显式指定。工具读取项目 `.env` 和站点配置，确认数据库的 `SiteState.siteId`，不接受网页传入数据库地址。

每个缓存目录包含原始 `source.tsv`、机器可读 `manifest.json` 和准确上游许可文本。下载必须通过固定 SHA-256 和行数校验，缓存通过同样校验后才可复用。缓存是外置数据，不提交 Git，也不随应用镜像分发。

导入在一个 PostgreSQL 事务内完成。工具用临时表分批写入，按标准化词形匹配已有 `Word`，分别更新 `phoneticUs`、`phoneticUk` 和 `phoneticSource`；保留原 `phonetic`、词条 ID、释义、学习进度、固定任务快照及评价历史。重跑同一版本不会重复追加来源。末尾只扫描一次词表，保存实际英美 IPA 覆盖统计；在线查词读取元数据，不逐次全库统计。

已有任务的内容快照继续保留签发时的音标。新词条或新词库导入后，可再次运行本工具补齐匹配和更新覆盖统计。

## 来源与许可保留

美式 IPA 来自 ipa-dict 的 `en_US.txt`。其 [Credits](https://github.com/open-dict-data/ipa-dict/blob/43c3570eb3553bdd19fccd2bd0091534889af023/README.md#credits) 指向 [lingz/cmudict-ipa](https://github.com/lingz/cmudict-ipa)，该上游 [MIT 许可](https://github.com/lingz/cmudict-ipa/blob/629483e9a7fa5b9ff11bb83e3fda6dcc25c5c511/LICENSE) 的版权人为 Lingliang Zhang。缓存同时保存 ipa-dict 的 dohliam MIT 通知及 [Carnegie Mellon CMUdict 原始许可](https://github.com/cmusphinx/cmudict/blob/74790861f652b15e4ac49015a90074ad62a27690/LICENSE)，保留其再分发通知和免责声明。

英式 IPA 的 Credits 指向 [ipacards](https://github.com/melissaboiko/ipacards)。其 [GPL 3.0 许可文本](https://github.com/melissaboiko/ipacards/blob/ac25f24df0712562b3c4762e21880fced2ae0b92/LICENSE) 与 ipa-dict README 对第三方许可的说明，意味着不能仅依据 ipa-dict 总目录的 MIT 文件把英式数据标为 MIT。ipacards 的说明还明确音标由 eSpeak 自动产生、可能存在错误，本项目同样保留这一限制。

若再分发英式源数据或其修改版本，应保留 GPL 3.0 许可、来源与修改说明，并提供对应可修改源数据。本工具原样缓存带固定版本和校验值的 TSV，便于作为独立数据包提供源材料。导出的数据库或自制镜像包含外部数据时，也需一并处理这些许可和来源；应用代码的 MIT 标签不替代数据包义务。

Google 网页兼容翻译输出及浏览器合成语音不写入这些 IPA 数据包。没有把 Google 语音、商业词典录音或未授权媒体打包分发。
