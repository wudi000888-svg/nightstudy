# 完整词典与目标词书

默认完整内容是 **ECDICT 固定基础 CSV 的全部 770,611 个词条**，另保留原来的原创演示词书、例句和既有学习记录。这是完整导入一个公开数据版本，不能称为所有英语词汇、ECDICT 另一个340万增强版、完整现代英美IPA或最新官方考试大纲。

## 版本、数据授权与校验

源仓库固定 commit `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`。原 CSV 为65,933,428字节，SHA256：

```text
1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf
```

原 Git blob SHA1 `c4ade63ea08cf39d9c3475e96929036d64d94c94` 也在首次获取时与官方 API 核对一致。小型 [manifest](../data/content-ecdict.manifest.json) 固定 URL、commit、SHA256、文件大小、许可、授权证据、统计和词书规则；大 CSV 下载到 `.local/content`，不进入 Git 或应用镜像。导入之前必须校验大小与 SHA256，拒绝换源、截断文件或同名错误缓存。

采用依据并非只有仓库的代码 MIT 标记。[上游 issue134](https://github.com/skywind3000/ECDICT/issues/134#issuecomment-5847668998) 明确询问词库用于商业 APP、随安装包提供离线查词及额外授权要求；2026-09-30仓库 OWNER `skywind3000` [回复许可使用且无额外要求](https://github.com/skywind3000/ECDICT/issues/134#issuecomment-5902723743)。作者关联、时间、链接及短回复已保存到 manifest。保留 [固定版 MIT 原文](../data/content-ecdict.LICENSE.txt) 与 Copyright (c) 2025 Linwei。

[固定版 README](https://github.com/skywind3000/ECDICT/blob/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b/README.md) 同时描述了 EDictAZ、cdict、WordNet、资料爬取及网友贡献等混合历史来源。我们如实保留这项来源说明；维护者许可不等于本项目逐条复核了所有第三方原始资料。原 ZIP 的词库和完整旧服务器快照没有作为输入。

## 原 CSV 实测覆盖

| 项目                    | 实测                             |
| ----------------------- | -------------------------------- |
| 总词条 / 规范化唯一词条 | 770,611 / 770,611；0个规范化重复 |
| 非空中文释义            | 768,739，约99.76%                |
| 非空英文释义            | 160,884，约20.88%                |
| 非空原始音标            | 218,065，约28.30%                |
| 可用例句 / 音频         | 0 / 0                            |

音标保留上游原文，其中有旧式写法；不猜测英美地区，也不把原始写法转换为未经验证的IPA。现代美式/英式音标来自独立许可与版本的数据包，详见 [PHONETICS.md](PHONETICS.md)；这些来源与旧 `phonetic` 字段分开。缺音标、中文或英文时保持缺失，不通过生成文本伪装覆盖。CSV `detail` 仅有1个空对象，不能当作已有例句。

中文 `translation` 和英文 `definition` 各自按原始行拆成独立源 Sense。只识别原文明确的行首词性；原始 `pos` 列全空，不猜词性。中文和英文行数、意义范围不一定一致，因此不按行号强行配成双语义项。相同规范词、语言、词性、原文的 Sense 用内容 hash 去重。源例句和音频为空，保留原有原创例句也不意味着全词库都有例句。

## 目标词书范围

全部对应源词均有中文释义，没有40/1000的总量截断。排序使用上游正数 frq/bnc 中的较小排名，再按规范词稳定排序。

| 目标入口             | 词数  | 选择规则                |
| -------------------- | ----- | ----------------------- |
| 通用常用英语 daily   | 3,277 | frq或bnc的正数排名≤3000 |
| 高考方向 high-school | 3,677 | 上游gk标签              |
| 四级方向 cet4        | 3,849 | 上游cet4标签            |
| 六级方向 cet6        | 5,407 | 上游cet6标签            |
| 雅思方向 ielts       | 5,040 | 上游ielts标签           |

这些是固定版数据的考试方向标签/通用词频规则。没有标记为官方完整大纲、CEFR等级或当前考试能力评估。源标签计数还包括zk1603、ky4801、toefl6974、gre7504，保留在 ContentPack 元数据；本轮未额外建立这些目标入口。新增词书可由用户选择，不自动改已有 currentBookId、目标或学习进度。

## 下载与安装命令

Node24/pnpm11与环境变量按 [部署文档](DEPLOYMENT.md) 配置。先完成本站 schema 迁移和 seed，ContentPack/SiteState 必须存在。工具只按 operator 的 readConfig().sites 安装到固定 Realm，不接受来自 Web 用户的数据库 URL。

```sh
pnpm content:fetch
pnpm content:import
```

`content:fetch` 下载或验证默认缓存；`content:import` 只验证已存在的本地文件并导入，不联网。`pnpm content:prepare` 顺序执行两者。root `db:prepare` 按 CONTENT_PACK 选择内容：默认ecdict，`CONTENT_PACK=demo` 保留演示模式并跳过完整内容；CI单元/集成库显式demo，完整Compose smoke按ecdict另行验证。`db:prepare`重复执行会验证缓存、识别已安装版本，不无条件重新下载原CSV。

离线环境可由 operator 先在受控机器取得相同文件，再设置私有 `CONTENT_FILE=/absolute/path/ecdict.csv` 运行 import；同样必须通过钉住的摘要。自定义 CONTENT_FILE 不存在时 fetch不会偷偷换为别的文件。多站逐站事务安装；一站失败不会假装全部成功。数据库备份和缓存卷彼此独立，下载缓存不代替业务备份。

## 安装的兼容与事务边界

- 每站一个PG连接、事务和advisory lock，stream解析CSV、默认1000行JSON参数批次写SQL。批次数受限，**总量不截断**；所有词、义项、词书和元数据成功后一次commit，失败rollback。
- 新Word以 `sha256(normalizedLemma)` 作为默认ID。已有相同规范词保留旧ID，所以 Review、进度、熟词和旧固定会话仍引用原身份。
- 未被改动的原创demo Word（原sourceRef且contentVersion为demo-*）可补入源音标、目标标签和词频等级并标记新来源，但原Sense、原创例句与历史快照保留。管理编辑或其他自建Word不覆盖字段，新源Sense后置以保持原管理内容优先。
- 已有源Sense不覆盖，原文内容hash保证重复定义不重复创建。新词书ID含pack/goal版本；同ID已有词书不改编排，保留管理修改。
- 成功写入 ContentPack 的ready记录与原源SHA/统计，并更新SiteState.contentVersion。重复相同安装直接返回alreadyInstalled；同ID不同SHA/状态拒绝。统计是输入源的实测范围，站点私有编辑可使当前展示内容与原源不同。
- 本轮不写 phoneticUs/phoneticUk/phoneticSource 的现代音标列，独立音标工具只补相应区域字段，避免把旧式原文当作现代IPA。

首次本机全量安装实际结果：770,611源词、新增Word770,571、更新40个demo Word、追加1,113,723个去重源Sense、新建5词书。原ID/旧Sense保持兼容。此记录来自真实PG18.4安装；PG17/完整Docker/Compose结果以对应CI为准，不将本机安装当作云部署通过。

## 测试与夹具

`scripts/content-fixture.ts` 生成原创合成CSV/manifest，仅用于解析和安装回归，不是学习内容、真实音标或另一个ECDICT版本。纯工具检查可运行：

```sh
pnpm test:content
```

不配置CONTENT_TEST_DATABASE_URL时只跑纯解析/摘要检查。真实PG夹具仅允许名称以 `_test` 结尾的可丢弃库，需预先迁移/seed；它使用3行、自己独占的fixture命名空间，不全量再导入770k。测试完成精确删除自己的词书/词/Sense/pack，恢复原 SiteState contentVersion、initialized和initializedAt。

本机独立执行16项工具检查通过：9项纯解析/来源检查与7项真实PG检查，覆盖大小/SHA失败不写DB、UTF8/引号/跨chunk、多义不伪配对、原ID/原创Sense保留、admin字段与优先级保留、安装幂等、错误site拒绝、错误统计的实际SQL回滚。Vitest的 `scripts/content-lib.test.ts` 另有8个case，本机8个全部通过，其中PG case复用同一受限夹具。未设置测试DB时PG case跳过，不能将此写为PG通过。
