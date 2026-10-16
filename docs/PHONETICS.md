# 英美 IPA 与发音来源

NightStudy 应用代码使用MIT。外部音标、引擎、声学模型和录音分别保留来源许可，不因写入PostgreSQL而改为MIT。下述两个ipa-dict包本身不含音频。0.9默认安装独立、预先制作的词音与句音包；线上没有语音引擎、模型下载或设备合成备用，录音与离线合成仅在后台来源记录中区分。

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

## 0.9 成品词音与句音

用户最新选择为：单词优先下载已有真人录音，确实缺少的单词以及公开例句由 Codex 在本机构建环境离线制作，再校验、打包、安装。服务器和浏览器只播放成品文件。`POST /pronunciation/:wordId/prepare` 已删除；API 不接受任意文本生成请求，也不把浏览器可用声线当作 ready 音源。

默认 `pnpm audio:prepare` 仅安装 `data/word-audio-v2.manifest.json` 的合并词音包与 `data/sentence-audio.manifest.json` 的句音包。大文件独立发布，仓库只保存固定 URL、字节数和 SHA-256。不会再默认下载旧515MB WAV包、Piper运行时或语音模型。每站在自己的事务中按 canonical Word 身份导入；每个 `(wordId, accent)` 只保留一个可播放音源，真人录音优先，后续合成刷新不能覆盖已就绪真人录音。

现已取得并逐项归档5,332条真人录音，覆盖5,004个词：US 4,917、UK 415。此处是实际可校验文件数，不是8,876条可用候选的数量，也不是全词库双口音覆盖量。独立原始录音包见 `data/recorded-audio.manifest.json`；合并词音最终包含其中符合当前词书的录音，以及已验证旧成品和新增缺口的本机合成。合并词音已完成18,775个词与词组的37,550条双口音MP3（真人5,332条、离线合成32,218条），两口音各18,775条、空缺0条；包大小208,218,687字节。37,550条均具有独立展示音标和声学QC记录，真人优先选择的录音没有被合成覆盖。句音包已完成8,404条去重公开英文句子的16,808条双口音MP3（均为离线合成），包大小304,612,309字节，实际全量声学审核16,808条通过、失败0条。两个默认包共54,358条成品；数量、媒体和来源摘要由各自固定manifest约束，构建或下载失败的项不伪报为 ready。

### 真人录音的绑定与许可

- Commons原始OGG按官方 `imageinfo.sha1`、文件大小和本机SHA-256共同校验，来源类别或描述必须独立证明US或British/London口音，不能只看文件名。
- Shtooka/SWAC存量整包通过Yojik发布镜像取得，保留原始FLAC、完整 `index.tags.txt`、README和整包摘要。`SWAC_TEXT` 必须精确等于规范词，不把 `a plate`、`to clean` 删前缀冒充 `plate`、`clean`。
- US包SWAC标明Betsy Megas / Dvortygirl、US/California；UK包标明Judith Franck、UK/London。US旧README与index的许可声明有差异，因此只收同名同作者、另有明确Commons逐文件许可的条目，未据README放宽许可；256项因缺对应逐项许可被排除。
- 原始审计包保留OGG/FLAC；面向H5的合并词音统一离线转MP3，保留 `originalFileSha256`、原MIME、转码说明、作者和原许可。转码不会把真人录音变成TTS，也不将FLAC摘要冒称为Commons OGG摘要。

原始整档：[SWAC US](https://fsi-languages.yojik.eu/audiocollections/archives/eng-wcp-us_flac.tar.xz)，329,292,924字节，SHA-256 `ded8442282f60855cb0b09a3a5e7693d13c288cbe0b3fe0c950eb9379e5753a1`；[SWAC UK/London](https://fsi-languages.yojik.eu/audiocollections/archives/eng-balm-judith_flac.tar.xz)，34,312,928字节，SHA-256 `645c31fd23e266e6ba18e0b207207dd1d191d3a1c3342df0cd7fd09a293646c1`。

### 离线制作与验证边界

开发工具为 `recorded-audio-pack.py`（Commons元数据与有界下载）、`shtooka-recorded-pack.py`（SWAC精确绑定）、`word-audio-supplement.py`（仅补缺口）、`sentence-audio-pack.py`（公开句子去重）与 `consolidate-audio-pack.py`（录音优先合并）。模型与引擎仅在离线构建机器使用，复用固定Piper 1.8.0及既有US/UK独立声学模型，不下载语言模型。

生成器输入纯英文文本，展示用IPA没有传入合成器作覆盖。两口音各自加载独立模型，模型/配置原样校验，默认 `length_scale=1`；模型官方phonemizer字段均为 `en`，不能仅据声线名称声称所有地区音位、同形异音或词性重音已准确。离线合成也不能表述为真人或专家认证标准读音。

生成WAV先检查单声道、16bit、22.05kHz、非空、非静音、时长范围，再统一MP3 48kbps；编码后的真实文件重新解码，核对非静音与时长差≤0.2秒。最终两个包的每条成品均按固定规则解码检查0.05–30秒、峰值/RMS、削波比例≤1%，记录前后静音时长；保留原语速和padding，不自动裁剪或拉伸。FFmpeg离线工具的版本、可执行文件摘要和质量规则随来源manifest保留，不进入运行时依赖。已有真人录音不做文本重读。首次文件服务仍验证路径边界、文件头与SHA；热播放仅在新O_NOFOLLOW描述符的dev/ino/size/mtimeNs/ctimeNs全一致时复用32MiB/256项内存缓存，篡改及304都不绕过校验。

真人替换合成条目时，独立展示IPA可继承已校验、同规范词形与同口音备选条目的原 `phonetic*` 元数据，并记录引用。仍缺失的展示IPA仅运行固定eSpeak-NG phonemizer，不加载声学模型；录音类型、音频字节和转码选择不因此改变。导入仍只填空的地区IPA，已有typed IPA优先。波形质量、来源地区声明及模型身份都不能证明同形异音、词性重音和每个音素已经人工校对。

句音以 `SHA256(NFKC + 弯引号转ASCII + 折叠空白)` 作为身份，保留大小写。公开词级例句、词组例句、学堂分段及全文、源代码40个原创seed例句纳入固定构建范围；不收私人句库、笔记或用户上传的任意文本。音频覆盖不代表770,611词典条目都具有完整双语释义和双语例句，后者继续按独立内容包统计；新建、上传或临时产生的句子未纳入已发布包时仍保持缺音。句音缺失返回空列表，媒体404，界面保留缺音状态。没有用waveform检查冒充逐句语义或口音人工审听。

## 0.4/0.6 历史产物（非0.9默认安装）

五本源目标词书去重后为8,798词，已生成每词US/UK各一条，共17,596条。实际包使用3条已核验来源与许可的真人录音与17,593条Piper 1.8.0合成音频，全部媒体文件通过摘要与格式校验。本机和PG17/Compose CI完成安装，CI另检查8条真人/合成媒体样本；这些检查不等于逐条人工听辨。公开 [音源manifest](../data/audio-voices.manifest.json) 固定引擎、模型、来源、摘要、许可和限制；生成包另记录逐条文件、类型及统计，固定包摘要见 [音频包清单](../data/audio-pack.manifest.json)。

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

## 0.9 网页播放

Word与发音API仅返回已安装成品的US/UK选项；学习者只看到对应音标与喇叭。词音与句音都从本站basePath内的同源URL播放，缓存键、ETag和源文件摘要绑定。暂停、切换口音、换词及离开页面由同一音频所有权管理器停止旧播放。没有浏览器speechSynthesis、在线TTS、音源生成按钮或技术备用入口。

来源、录音/合成类型及许可记录保留在管理资料和独立内容包中；学习界面不展示引擎、供应商、模型、代码或许可运维细节。未知或缺失口音不会复制另一口音来补数。

## 0.6 词组历史音源

独立词组包覆盖437个常用词组，US/UK各一条，共874条Piper合成音源。词组使用已缓存的固定语音模型制作，不需要下载翻译模型；默认完整安装校验独立 [phrase-audio.manifest.json](../data/phrase-audio.manifest.json) 的大小、摘要与条目数，并保留原已就绪音源。

地区IPA只补空字段，算法转写仍明确标记来源和未逐条专家校验的局限。音源就绪要求真实文件与WordAudio元数据，不能把浏览器可用语音字符串当作服务器音频。词组内容范围为四级方向236、六级方向201，不是官方完整考试词组表。当前包声明与实际文件/数据库安装分别验收，既有0.4音源证据不充当0.6完整安装结果。

## 0.10 句音增量

0.10默认顺序安装 `word-audio-v2`、`sentence-audio-v1`、`sentence-audio-v2`。以上0.9段落保留原版两包安装的历史结果；当前入口以三包为准。新增包仍使用已缓存、已固定的英美声线，仅在本机离线制作，没有下载语言模型或调用付费API。

`sentence-audio-v2` 含9,439条去重英文、18,878条双口音MP3，与v1不重叠。新增文件封包后独立全量解码通过，旧v1全部文件摘要核对通过；这不是专家逐句听审。两个句音包共35,686条成品，覆盖当前内置词书17,814条去重英文的35,628个英美发音目标，另保留29条不再被当前内容引用的旧英文双口音文件。

包大小369,105,500字节，SHA-256 `0ce45f0daa7f5b20e8fddb94e965e3a43c15428861f33207ce2d003a9c26a9b5`。固定下载、媒体与来源摘要见 [v2音包清单](../data/sentence-audio-v2.manifest.json)，实际数据库安装、公开附件与部署结果见 [0.10交付记录](CONTENT_BILINGUAL_POLISH_010.md)。各句文本与声线的原许可、作者和来源保存在独立来源manifest与随包通知中。
