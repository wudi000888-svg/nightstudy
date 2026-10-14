# 英美 IPA 与发音来源

NightStudy 应用代码使用MIT。外部音标、引擎、声学模型和录音分别保留来源许可，不因写入PostgreSQL而改为MIT。下述两个ipa-dict包本身不含音频；0.4另准备同源英美音频，明确区分真人录音、Piper服务器合成和设备语音备用。

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

## 0.4缺失地区音标的算法补充

原词典US/UK字段优先，只对缺失地区字段补充。五书去重范围本轮需要补147个US字段、719个UK字段；这是地区字段数量，同一个词可能同时缺两种，不能相加作为独立词数或全词库覆盖量。

算法来源为 `piper-tts@1.8.0 bundled eSpeak-NG`，US使用en-us，UK使用en-gb-x-rp；机器可读来源说明记录 `method=algorithmic`、`overridesExistingTypedIPA=false`、`expertValidated=false` 和 `audioModelConfigChanged=false`。区域音标与原ECDICT字符串、原ipa-dict结果分开溯源，不为生成音频擅自修改声学模型配置。

这些音标未经专家逐词审核。同形异音、重音、缩略词、人名及特殊词形可能出错，算法音标和合成声不能被表述为专家认证的标准读音。字段及来源标识随音源metadata保留，新的站点覆盖统计应以实际安装结果为准。

## 英美音频目标与生成状态

五本源目标词书去重后为8,798词，目标每词US/UK各一条，共17,596条。目标计划使用3条已核验真人录音与17,593条Piper 1.8.0合成音频；当前仍在生成，不能把目标数当作全部ready、已播放验证或已部署数量。公开 [音源manifest](../data/audio-voices.manifest.json) 固定引擎、模型、来源、摘要、许可和限制；最终生成包另记录逐条文件、类型及统计。

来源manifest保留4个已核验候选真人录音，目标词书使用数量另算。它们分别是rain-US、abacus-US、abandon-US和rain-UK；具体纳入记录按目标词形与口音选择，不把候选来源总数当作目标包真人覆盖量。

| 来源层     | 固定选择与许可依据                                                               |
| ---------- | -------------------------------------------------------------------------------- |
| 合成引擎   | piper-tts 1.8.0，GPL-3.0-or-later；固定源提交与官方包摘要，保留COPYING与源码来源 |
| US声学模型 | en_US-ljspeech-high，模型发布者MIT声明，固定模型/配置/模型卡摘要                 |
| UK声学模型 | en_GB-cori-high，模型发布者MIT声明，固定模型/配置/模型卡摘要                     |
| US真人候选 | Dvortygirl的rain/abacus/abandon Commons文件，各自CC-BY-SA-3.0                    |
| UK真人候选 | Association Shtooka / Judith Franck的rain文件，CC-BY-3.0-US                      |

声学模型使用 [rhasspy/piper-voices固定版本](https://huggingface.co/rhasspy/piper-voices/tree/c10ece1aade47bb51c153c893d14e5bf8e5b7117)。该版本以README front-matter声明MIT，manifest保存发布者声明、模型作者与模型卡；仓库根目录没有完整LICENSE文件。标准MIT文本只提供条款，不独立授予模型权利，也不能用Piper引擎的GPL或应用MIT替代模型声明。模型卡声明训练数据为public domain，这项声明随来源保留，不扩大为所有声音或源材料的统一许可。

真人文件保持原始字节，并分别保留Commons来源页、录音者归属、地区证据、具体CC许可与摘要。例如 [US rain](https://commons.wikimedia.org/wiki/File:En-us-rain.ogg) 属CC-BY-SA-3.0，[UK rain](https://commons.wikimedia.org/wiki/File:En-uk-rain.ogg) 属CC-BY-3.0-US。每条录音的license/attribution/sourceUrl以实际来源记录为准，不能统一标为MIT。

## 网页播放与按需补齐

Word及发音API中的audio记录区分 `kind=recorded` 与 `kind=synthesized`，提供accent、status、sourceName/sourceUrl/license/attribution/mimeType。同源URL按站点basePath挂载，服务前核对文件、MIME头和SHA-256；不把任意外部URL直接作为本站音源。旧会话快照可读最新发音metadata，而不额外返回或提前揭晓词义。

网页默认优先就绪本站音源，录音与服务器合成按实际类型标注。设备en-US/en-GB是独立备用选项，依赖浏览器实际voice，不假装服务器标准录音。没有来源例句时保持为空。

已登录、generationAvailable且缺口音音源时，可显式“补齐本站英美合成发音”；缺任一地区IPA先说明并禁生成。界面显示真实等待时间，成功只更新音源选项，需要再次点击播放，避免移动端网络等待后自动播放。处理中、限流、模型不可用、生成超时、文件校验/解码失败各自说明，允许刷新metadata后重试。服务与缓存部署参数以最终 [部署文档](DEPLOYMENT.md) 为准；本轮没有将生成中的目标包描述为已全部部署。
