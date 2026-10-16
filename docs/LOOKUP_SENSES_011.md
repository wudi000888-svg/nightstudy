# 夜读英语：查词、原子义项与语境例句设计

日期：2026-10-16　状态：用户已批准全量施工，不兼容旧版；功能实现及本机隔离验收完成，发行/部署状态另列，不把内容首包当全词书逐义完成。源码审计基点：`5e3f7023df8edd5e97ee87a246f6abe5c3235a18`。

本稿把“查到正确词形—辨认具体词义—在匹配语境中理解—听对应句音—收藏或继续学习”连成移动 H5 流程。产品保持浅青学习背景、清晰内容面与独立页面栈；首页四区、既有学习调度及数据保护规则继续遵循仓库 AGENTS.md 和 H5_APP_REDESIGN.md。

本次依据本地源码、已有发布文档及公开内容的静态投影设计，没有连接生产数据库，也没有重新核验生产内容或线上性能。上述为方案评审时状态；本轮已开始实现模型、检索与移动界面，具体完成范围与测试证据将在末尾记录，不能把设计目标当成验收事实。

## 1. 已确认的问题与边界

| 事实                                                                                                                | 对设计的影响                                                         |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Sense` 每行只有一对 exampleEn/exampleZh；`WordExample` 只关联 wordId，没有 senseId。                               | 当前“一个词有例句”不等于“每个具体词义有匹配例句”。                   |
| `studyExamples()` 每次切义都拼入整个 word.examples；界面已区分“本义项例句/单词用法”，但不能保证当前词义的语境一致。 | 新详情与学习页只消费当前原子义项的例句集合。                         |
| 静态投影中 bank 的某源释义混有“银行、堤、岸”；charge 名词源释义混有多义，词级例句却用于手机充电。                   | 必须先拆分词义并审核关联，不能只给混合长释义多配几条例句。           |
| 公共 dictionary 只做规范化前缀查询，固定 A→Z；resolve 只做精确匹配。                                                | contains 与错拼建议属于新能力，不能称现有功能。                      |
| `/lookup`、`/wordbook` 共用 LookupPage；q 会强制切到查词；来源只保存在 ref。                                        | `/wordbook?q=sys&entry=…` 刷新后可能变成公共查词详情，返回语义改变。 |
| 生词本接口只有分类和分页，固定 updatedAt DESC、id DESC；UserWord 无收藏创建时间。                                   | 增加服务端搜索与排序；当前只能称“最近更新”，不能称“最近加入”。       |

本次静态投影为 18,767 个有效词、70,124 行 eligible Sense、18,896 行双语定义、39 对内嵌双语例句、18,769 条词级句。这些是该投影的统计口径，不是生产库现状，也不是独立词义/语境总数。`70,124 - 39 = 70,085` 不能当作待补原子义项数：必须先拆分、合并重复、排除不可发布条目，再按真实绑定关系计数。既有 0.10 发布文档也明确只保证学习焦点与词级用法，未承诺全部源义项逐义配对。

首版检索仅面向英文单词、词组的词形，不承诺中文反向释义、中文语义搜索、词形还原或语义向量搜索。大小写、全角字符、引号及空白继续统一规范化；保留合法连字符、撇号和词组边界，不把不同词形随意合并。

## 2. 内容模型：原始词典与学习义项分层

保留原 `Word.id` 及原始 `Sense.id`、文本、来源和内容版本。新增独立 `LearningSense` 作为可展示、可审核的原子学习义项；这是一项内容模型改造，不是旧接口兼容层。原始行用于证据与历史，不能靠覆盖原文把加工稿冒充源词典。

| 拟议实体           | 最小职责                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| LearningSense      | id、wordId、明确词性、单一语义的英中定义、必要语域/领域、顺序、状态、内容版本、作者和审核证据。                                                      |
| SenseSourceBinding | learningSenseId、sourceSenseId、wordId、exact/narrower/corrected-from 关系、原 POS/EN/ZH 的 UTF-8 字节摘要、来源版本、拆分/合并/纠错理由和审核决定。 |
| WordExample 扩展   | 稳定 id、wordId、learningSenseId、contextLabel、英中句文、顺序、状态、内容版本、字段级来源。旧的词级句作为未绑定候选保留。                           |

数据库用复合外键确保 LearningSense、来源 Sense 与例句都属于同一个 wordId。一个学习义项可以绑定多个确实同义的来源行；一个混合来源行可以拆成多个 narrower 学习义项。源释义或词性错误后的纠错使用 corrected-from，并保留独立纠错理由与证据，不伪造 exact/narrower 对应。空字符串、空值、标点和原文空格均进入明确的摘要口径；来源漂移使绑定失效，不能继续套用旧审核。

原子义项的标准是“用户能判断在这一个用法里表达什么”。同词不同词性、明显不同含义、不同及物关系或不可互换的固定表达分开；同义改写与重复来源合并。分号、逗号和共享词性都只是线索，禁止机械切段、按数组序号对齐或把相邻英文解释当中文翻译。

发布状态区分候选、待复核、可发布、挂起和被新版本替代；结构校验通过与逐条语义审核分别记录。Codex 制作内容保留实际作者/工具与 `review: pending` 等证据，不标成专家认证。学习界面只显示词性、定义、语境与可用音频，不展示加工协议、代码路径、供应商或许可字段。

## 3. 逐义、逐语境的双语例句

目标是每个发布学习义项都有自己的多语境例句。默认验收每义覆盖至少两个真实语境，每个声明语境至少一条双语例句，即每义至少两句；不是每个语境都必须两句。特殊固定表达若要只保留一条，须作为明确例外评审，不能由程序自动豁免。首批排产覆盖18本内置词书涉及的18,767个有效词，先完成原子义项盘点，再报告需要制作的真实义项和句数；不能用这一范围代替约77万词全词典完成。词典其他尚未完成关联的义项如实保留缺句状态，不拿词级句补齐外观。

每条例句应：准确使用该义项、语法自然、主客体与介词关系正确、英中语义对应；contextLabel 只写能帮助理解的真实场景，如“办理账户”“修理设备”。换人名、替换无关名词或重排同一句不算不同语境。可以出现合理屈折形式，但这不表示词形解析接口已经支持原形推断。

旧词级例句先进入候选池，逐条核对后绑定；不按相同 lemma 自动挂到所有义项。无法确定对应义项时继续保留原记录，暂不混入某义项的学习语境。现有 Sense 内嵌例句也须核对，迁入独立例句身份后保留原文与来源。

新词条 DTO 以 `senses[*].examples[]` 表达所属关系；不再由前端把 `word.examples` 追加到当前义项。切义时例句序号重置为该义项首条，播放停止；返回该义项时可在当前页面会话内恢复已看的例句。没有完成内容时明确显示缺口，不借用另一义项句子填空。

内容制作继续使用可追溯公开语料与 Codex 分批撰写，不调用付费 AI 内容接口或下载语言模型。发布包保存词义拆分台账、候选句、原句/译文摘要、审核决定、改写关系、许可与来源；逐包严格验证、冲突回滚、重放零变更。

## 4. 静态句音与历史保护

词音优先可核对的现成录音；缺词音和新句音可按既有约定在本机离线制作、校验、封包。线上只播放成品，不现场合成、不用浏览器 speech、不自动下载模型。

句音继续按规范化英文的 textHash 和明确 US/UK 口音关联，文件按 SHA-256 校验。规范化沿用当前 NFKC、弯引号统一、空白合并与首尾去空格，保留大小写及实际标点。规范化发音文本改变时生成新 textHash；规范化后相同且审核确认发音等价，或仅更正中文而英文未变时，可复用句音。发音或含义发生实质变化不能用旧音频补覆盖。同一词的不同义项使用不同句子，禁止复用含混句子充当逐义覆盖。不同目标词或不同来源若确实引用相同英文，可以去重音频字节，但各自的例句身份和义项审核保持独立。缺音或失败保持不可播放，不能跨句、跨口音替代。

新包验证完整解码、时长/静音异常、manifest 与字节摘要，再对专名、多音、标点和代表性长句抽听；文件有效不等于语音语义专家审核。UI区分读取中、可播放、失败可重试及确认缺音，只有真实播放事件才能显示播放态。切义、切句、切词、切后台和退出页面终止旧音频。

FSRS 的学习身份继续使用 `(userId, wordId)`；增加义项不会创建多份词进度，不重新评分、不重置记忆、不重复占每日词数。BookItem 可显式选择新的 LearningSense；历史 focusSenseId、contentSnapshot、questionJson、回答、ReviewLog、CommandReceipt、收藏和笔记保留原记录与可追溯映射。

已签发题目及其判断依据不能因内容升级悄悄改变。历史快照只读；需要补充显示时，仅允许相同义项版本与来源绑定 hash 核对通过的补充，禁止把新词级句批量塞入旧快照。歧义拆分不猜历史义项，保留原快照并在明确边界开始新版本任务；未同步命令有可核对处置，不静默丢弃。例句收藏使用稳定 exampleId、义项与句文版本快照；源句修改不回写用户已收藏文本。

## 5. 移动 H5 页面与返回

查词与生词本是两个独立屏幕，共用词条展示组件而不共用会改变页面身份的 Tab。网页翻译从既有独立入口进入。列表顶部使用一个紧凑标题、搜索框和筛选/排序入口；不增加宣传大标题。

- `/lookup?q=sys&match=smart&sort=relevance`：公共已发布词形列表。
- `/wordbook?status=active&q=sys&match=smart&sort=updated-desc`：仅本人对应分类的收藏集合。
- 在各自 URL 增加 `entry=<wordId>&sense=<learningSenseId>` 打开详情，完整保留列表条件；路由的 pathname 始终决定公共/私人范围，q 不再切换页面。

详情首屏为返回、词形、收藏、对应英美音标/词音和精简义项目录；当前义项显示成对定义、语境标签、当前例句与句音。义项和例句都可点目录选择及前后切换，按钮具有可读名称；详情主体只有一个主要滚动区，安全区和软键盘遵循现有壳。长词换行，320像素宽不横向溢出，触区至少44像素。

同一次列表会话中，打开详情使用 PUSH；回到有证据的前一列表用同一次历史 POP，恢复关键词、排序、分类、已加载页和原词行锚点。先关闭最上层弹层，再返回列表，再回模块上层；浏览器后退、顶栏返回和详情返回接入同一规则，不能各写一套。关闭模块保持回 Home。

直接深链没有本机列表历史时，不伪造可恢复的列表位置：壳返回遵循既定 Home 回退；详情可提供明确的“查看匹配词”动作，按 URL 条件重建第一页。刷新仍保持正确页面身份、词条及义项；无效或已停用 entry/sense 显示对应状态，不能换成第一个近似词。

列表与详情独立请求：有 entry 时立即按稳定 ID 读取详情，不等公共列表或 resolve。输入约300ms防抖、识别中文输入法 composition，回车立即查询；搜索中可继续改字，取消旧请求并忽略迟到响应。搜索、追加页、详情、某条收藏分别管理 pending 状态，避免一个 busy 禁用整屏。

弱网保留已加载内容和可用锚点，初次失败、加载更多失败、详情失败分别重试；空结果与请求失败分别展示。改变查询条件时旧结果可暂留，但必须标明正在更新，不能把旧结果计成新查询结果。账户/站点切换取消请求、停止音频、卸载私有状态，旧响应不能填入新页面。首版不承诺离线词典或连续离线学习。

## 6. 匹配方式、错拼建议与排序

| 控件             | 行为                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| 智能匹配（默认） | 主结果按完整一致、开头一致、词中包含分层；每层使用规范词形稳定排序。    |
| 开头匹配         | 返回 literal prefix；1–2字符也可用。                                    |
| 包含匹配         | 返回 literal contains，至少3字符启用；例如 sys 可匹配 ecosystem。       |
| 可能想查         | 独立的有界错拼建议，至少4字符；用户点击后才查询建议词，不冒充确切词义。 |

智能主结果是可完整分页的词形匹配集合；错拼建议单列最多10项，不加入主结果总数。出现清楚的精确匹配时不主动干扰；无匹配或结果稀少时显示建议。零建议不表示输入一定错误。

`systme → system` 必须作为验收夹具：先对长度受限的单词生成有界相邻换位候选，批量走规范词形唯一键精确查找，再联合 trigram 候选并复核编辑关系、长度差和词形。词组不做无界字符重排。不能只凭 trigram 相似度承诺此类短错拼召回，也不能对全词库逐行计算编辑距离。

| 范围           | 首版排序                   | 默认与限制                                         |
| -------------- | -------------------------- | -------------------------------------------------- |
| 公共主结果     | 相关度、A→Z、Z→A           | 默认相关度；相关度仅指词形层级，不能称语义相关度。 |
| 生词本无关键词 | 最近更新、A→Z、Z→A         | 默认最近更新。                                     |
| 生词本有关键词 | 相关度、最近更新、A→Z、Z→A | 新搜索默认相关度；明确选择后保留用户排序。         |

A→Z/Z→A 对当前主匹配全集执行全局排序，而非每层单独排，也不是前端对已加载词排序。相关度键为 `(matchTier, normalizedLemma, wordId)`；同一个词只属于一个最高匹配层，避免重复。最近更新键为 `(updatedAt DESC, userWordId DESC)`。排序使用明确且一致的字符串排序规则和游标比较规则。

UserWord 当前无 savedAt，不推出“最近加入”。如以后增加，历史未知时间不得伪造成真值。暂不开放缺少可靠字段的“最常用/最难/掌握最差”；dueAt 排序如后续加入，须明确未学、暂停与已巩固项的处理，且不能改写调度。

## 7. PostgreSQL 查询与接口契约

保留 PostgreSQL/Prisma 栈和现有 normalizedLemma 唯一键、text_pattern_ops 前缀索引；拟增加已发布词条上的部分 GIN `gin_trgm_ops` 索引。1–2字符仅精确/前缀；contains 至少3字符，错拼至少4字符且有长度与候选上限。SQL参数化，输入 `%`、`_`、反斜杠视作普通字符并正确转义，匹配和排序参数为白名单枚举。

PostgreSQL 官方文档说明 trigram 的 GIN/GiST 支持相似度及 LIKE/ILIKE 索引；若模式无法提取有效 trigram，可能退化为全索引扫描。详见 [PostgreSQL 17：pg_trgm 索引支持](https://www.postgresql.org/docs/17/pgtrgm.html#PGTRGM-INDEX)。本次已通过 agent-reach 的网页阅读方式核对官方文档，尚未验证目标数据库扩展、执行计划或性能。索引能用不等于所有查询必然快；不能把“加 LIMIT”当作计算成本已有上界。相似度阈值只能事务内设置，不能污染连接池的下一请求。

拟扩展现有 `/dictionary` 和 `/wordbook` 的 q/match/sort/cursor 参数；接口可不兼容替换，但不增加旧客户端适配层。主响应为精简 `items/page`、规范化查询条件、内容/集合版本及有界 suggestions。总数若计算则明确为主匹配集的精确值；可只在首屏或显式要求时计算，未计算时返回未知，不能拿候选上限冒充总数。

列表 DTO 只带 wordId、lemma、词性、短释义、必要分类/收藏状态与匹配层，不读取完整例句、音频、搭配后再裁剪。详情按 entry 独立取 `senses[*].examples` 与必要音频摘要；来源证据保留在管理/归档接口。本人收藏状态批量合并，避免每行一个请求；私人信息不进入公共缓存。

所有排序和分页在服务端全量匹配集合上执行。内容索引建造、精简投影与查询计划先在完整隔离夹具测量；只有实际计划证明需要时再考虑 GiST KNN 或额外索引，不无依据引入外部搜索服务。

## 8. 稳定游标、版本与权限

使用 keyset，禁止 offset 深翻页。游标包含版本、有效期、实例/站点、规范关键词、match、sort、分类、排名算法版本、内容版本、完整末项排序键；私人集合再绑定当前用户与集合版本。签名防篡改，但权限始终由可信服务端上下文和查询条件保证，不能相信游标自述的 userId/siteId。

公共列表的可搜索内容变更递增 catalog revision；私人集合的收藏、移除、备注、暂停和毕业变化递增 collection revision。接口在同一事务视图内验证版本并读页；版本不符返回明确的列表已更新状态，从第一页重新加载并尽可能定位原词。若以后提供基于进度的排序，还需把影响排序的进度变化纳入版本。

每页 RepeatableRead 只保证该页读一致，不能当作跨HTTP稳定快照。本稿首版选择版本变化即失效，不维持跨HTTP长事务，也不在修改后的集合上继续旧游标而宣称恰好一次。当前 base64 JSON 游标是编码而非签名，需配合新契约调整。

站点数据库/auth realm 由已验证入口确定，所有私有 WHERE 都约束当前用户；请求字段不能选择数据库或账户。客户端 query key 同时包含现有完整 scope 与全部搜索条件；账户退出、站点/实例变化清理私有缓存和历史。404/空集合不得泄露另一用户的收藏、备注或例句快照。

## 9. 原评审的分阶段施工与交付门槛

本节保留已获施工授权的原评审门槛，不能将其清单当作全部验收已经通过。实际内容交付与隔离验证记录见后附第13节；查询、界面、音频及发布的结果按各自后续实测记录判断。

| 阶段             | 施工清单                                                                                                | 进入下一阶段的门槛                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A 内容盘点与冻结 | 冻结公开源投影；生成拆/合/排除台账、原文摘要、实际义项/语境缺口；选 bank、charge、词组及专业义作试点。  | 试点逐义审核通过；明确首批范围和真实工作量，不按源行数承诺完成量。 |
| B 模型与包安装   | LearningSense、来源绑定、例句关联和复合约束；严格增量安装、回滚、重放、原记录保护；签发与收藏快照版本。 | 同词约束、来源漂移拒绝、零变更重放与历史保护通过。                 |
| C 内容与静态句音 | 分批逐义释义、至少两语境双语例句、审核与缺口清单；生成缺失英美成品句音并封包。                          | 覆盖统计按词/义/语境/口音分别计算；未完成项目如实列出。            |
| D 查询与移动UI   | 独立路由/详情、当前义项例句、输入与弱网状态；精简DTO、检索模式、全局排序、签名游标与版本。              | 正确性、隐私、返回、键盘及完整词库查询计划通过。                   |
| E 回归与发布准备 | 保留 wordId FSRS、命令幂等、进行中任务/离线命令处理；完整冷安装、已有数据升级演练、并发与实体设备验收。 | 保存可复现证据、不可变包与回滚方案，再按明确施工/发布指令处理。    |

重大新方案须先评审。本稿已获得本轮施工授权；不包含主动清空生产数据的授权，不得用重新 seed/初始化替代保数据增量升级。

## 10. 可执行验收清单

- **词义关系**：bank 的金融与河岸义分开；charge 名词义不展示手机充电动词句；相同词性不自动配译；更改源 POS/EN/ZH 任一字节会拒绝旧绑定。例句跨 wordId 外键被数据库拒绝。
- **逐义语境**：每个发布义项满足约定的语境数，英中成对且逐条绑定；切义只出现该义项例句；未绑定候选不自动发布；义项/例句计数不包含重复和挂起项。
- **音频**：每条已发布英文按目标口音单独校验；换句后旧句不复播；缺音/失败无成功态；规范化发音文本改变则不沿用旧句音；所有新增成品解码及摘要通过并保留抽听记录。
- **历史**：旧源行、用户进度、笔记、收藏、回答与日志按预期指纹不变；拆义不增加FSRS身份/评分/每日计数；进行中题目与未同步命令明确处理；重复安装与重复命令不重写数据。
- **检索**：精确词排在前缀/包含前；sys 的开头与包含不同；systme 能通过相邻换位夹具找到 system；短查询不触发无效大扫描；词组、大小写、全角、引号、通配符字面量及空输入验证通过；中文输入不冒称语义查询。
- **排序分页**：三个以上页面在服务端全局 A→Z/Z→A；相关度跨层无重复；同键ID稳定；切关键词/分类/匹配/排序拒绝旧游标；篡改、过期、跨用户/站点/实例、版本变化均明确失败，无内容泄露。
- **移动交互**：分别核对 lookup 和 wordbook 深链、刷新、顶栏/页内/浏览器返回、列表锚点及分类；320×568、390×844、横屏无溢出；实体 iOS/Android 软键盘与安全区另验，桌面模拟不冒充通过。
- **故障并发**：旧搜索迟到、详情失败、追加页失败、断网后恢复、隐藏屏、快速切词/义/账户、重复收藏与内容同时更新均有真实夹具；主匹配失败不阻断明确entry详情，失败不清空已确认内容。
- **性能证据**：使用约77万词的隔离完整数据、大小不同的私人生词本；分别记录prefix/contains/换位建议/trigram候选/详情在并发1、10、25下的p50/p95/p99、错误率、请求字节、SQL次数、计划和缓冲；区分冷/热、TCP/TLS与app.inject条件。以相同夹具对照旧版，原有前缀不得明显退化；contains/建议的时延预算在基线测量后定稿，未达到时不得写成“高性能已验收”。

## 11. 本地证据索引

以下行号为上述源码基点的静态定位，施工后应重新核对；已有文档中的历史验收只证明其注明范围。

- [路由绑定 App.tsx:111](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/web/src/App.tsx:111)；[q/entry恢复与强制切Tab Lookup.tsx:270](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/web/src/pages/Lookup.tsx:270)；[详情来源仅ref Lookup.tsx:603](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/web/src/pages/Lookup.tsx:603)。
- [前缀查询 content.ts:272](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/api/src/modules/content.ts:272)；[精确解析 dictionary-resolver.ts:8](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/api/src/modules/dictionary-resolver.ts:8)；[生词本分页 content.ts:388](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/api/src/modules/content.ts:388)；[当前游标 pagination.ts:3](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/api/src/modules/pagination.ts:3)。
- [Sense与WordExample schema.prisma:266](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/prisma/schema.prisma:266)；[切义拼入全词例句 StudyWordDetails.tsx:18](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/web/src/components/study/StudyWordDetails.tsx:18)；[独立英义不冒充配译 UI.tsx:339](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/web/src/components/UI.tsx:339)。
- [签发快照内容补充 content-presentation.ts:159](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/api/src/modules/content-presentation.ts:159)；[例句收藏状态 learning-library.ts:313](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/api/src/modules/learning-library.ts:313)；[收藏来源与快照 learning-library.ts:380](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/api/src/modules/learning-library.ts:380)。
- [wordId复习写入 study.ts:658](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/api/src/modules/study.ts:658)；[UserWord时间与索引 schema.prisma:382](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/prisma/schema.prisma:382)；[句音模型 schema.prisma:116](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/prisma/schema.prisma:116)；[句文规范化 audio.ts:27](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/api/src/audio.ts:27)。
- [全关系读取 shared.ts:29](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/api/src/modules/shared.ts:29)；[既有前缀索引迁移](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/prisma/migrations/20261014010000_content_packs/migration.sql:18)；[同路径查询替换模块栈顶 app-navigation-state.ts:121](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/apps/web/src/lib/app-navigation-state.ts:121)。
- [0.10内容范围与保护 CONTENT_BILINGUAL_POLISH_010.md:21](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/docs/CONTENT_BILINGUAL_POLISH_010.md:21)；[H5持久设计约定](/Users/wan/Documents/Codex/2026-10-14/ni/outputs/nightstudy/docs/H5_APP_REDESIGN.md)。

## 12. 交互设计预览校验

预览采用少量原创示例数据，初始为 bank 的两个意思，可切换查看不同语境；返回后可搜索 sys 或 systme，切换匹配方式、排序以及生词本。收藏仅影响预览状态；音频按钮不播放，不连接真实账户或业务接口。它展示方案，不表示后端新能力已经上线。

已有 Chromium 隔离浏览器校验记录：[preview-check.json](/Volumes/XXX/Codex/work/nightstudy/sense-search-design/preview-check.json)。28项预览检查通过：义项与句子同步、不同语境、收藏/移除反馈、范围隔离、sys前缀与包含、换位错拼建议及显式确认、A→Z/Z→A、返回保留查询及排序、320/390/736宽度与深浅主题无横向溢出、无JavaScript异常。该记录不是生产接口测试，不证明数据库检索、并发性能、页面栈完整实现或实体iOS/Android通过。

## 13. 已实施的内容工程与隔离数据库验证

本轮新增 `LearningSense` 原子学习义项、同词复合关联、原始词义来源绑定、逐义语境例句、严格安装器和独立只读验收器。首个原创内容包实际交付 **35个单词或词组、98个原子义项、196条中英对照例句**；每个发布义项至少两个不同的真实语境，各有一条明确匹配本义的双语句。它覆盖 bank、charge、light、water、claim、run、set、system、book、match、fair、record、present、mean、spring、apply、bear、address、right、current、figure、issue、cover、date、point、stand、subject、fine，以及 take off、look up、break down、turn down、get over、in charge of、by accident。

这不是18本词书全量逐义内容完成：18,767个有效词全部进入制作队列，**18,732个词仍待原子义项审核**，已有内容的35词也不声称穷尽了所有词义。公开投影的70,124行可用源 Sense 不是独立义项数，不能据此伪算还需多少句；实际剩余原子义项和语境总数保持未知。18,808条原词级及源义项内嵌旧句保留为未绑定候选，不自动发布到新义项，也不用换人名或机械切逗号的方式填满覆盖率。

三个原创建稿为 `data/learning-senses-authored.json`、`data/learning-senses-authored-batch2.json`、`data/learning-senses-authored-batch3.json`。每义保留单义英中定义、词性、语义键、明确来源关系、两个语境及逐句审稿理由。制作仅使用既有固定公开源与 Codex 原创，没有调用付费 AI 内容接口或下载语言模型。来源选择器中的引文用于核对原始身份，继续遵循现有来源许可；不把源引文宣称为原创定义。

独立 Codex 双语复核读完35词、98义、196句后纠正了三处边界：record 的成就义改用工厂单日产量纪录场景，subject 的话题义改用研究课题而不混照片描绘对象，run 管理俱乐部的中文改为持续“运营”。审核说明随修稿同步。它是作者与独立代理的编辑审核，**不是词典专家认证、全词库认证或发音专家认证**。record、present、address、subject 共12义另有明确的 `wordAudioCompatible:false` 安全标记；没有义项或词性证据的现成词级音标、音频不强配这些义项，继续留空。对应整句音频按最终英文逐条另行制作和验证。

### 13.1 不可变包与源身份

当前内容包 `data/learning-senses-v1.jsonl.gz` 为94,530字节，SHA-256：

```text
1984c9aedcd97241ee50d90ee34b68da1542c55ecd17a281af9bb3e5c03182db
```

解压 JSONL 摘要为 `d2c75b59ec8e0e2c7fc937c60fe07420dbcce71193a4e2274095028086354944`。源公开投影摘要为 `614374f14db7a11141877e3a38c8f1e1f419ad49ca686cc1a23516195f5ce19c`，先精确合并 pinned bilingual-v2 补丁 `bafce91547bcb181520fbde8f595cd9a924e5addb614f978e5969bfb6a6f552e`，再核对原 POS、中文定义、英文定义的原始 UTF-8 字节摘要；空字符串与空格不混为一谈。

学习义项 ID 根据 canonical wordId 与明确语义键稳定生成。`bindingHash` 对义项 ID、wordId、词性、英中定义、内容版本及按 sourceSenseId 排序的来源绑定计算规范 JSON 摘要。JSON 对象键递归排序，保留中文字符、数组顺序及文本原字节；例句另保存英中字段摘要与规范化英文 `textHash`。单词义项不因增句而创建新的 FSRS wordId，也不修改原始源行。

安装器在站点绑定和事务锁内核对每个源字段、同词关系与稳定身份，只插入明确的新行。来源漂移、既有内容被编辑、身份冲突或中途缺失会拒绝整包并回滚。重复安装不仅检查 ContentPack 标记，还逐行核对已安装义项、绑定和例句；正确重放没有内容写入。严格 PostgreSQL 集成测试覆盖错站点、零变更重放、POS漂移、站点编辑保护与后续绑定失败时的原子回滚。

### 13.2 完整隔离库的增量与重放证据

验证只在端口55441的独立 `nightstudy011_full_test` 完成。最终包新增98条 LearningSense、98条 SenseSourceBinding、196条 WordExample；再次安装三者均新增0条。独立验收器同时核对35词、229条原始源义项的快照、逐义两语境、目标词形、绑定摘要和双语字段摘要。

安装前、安装后、重放后的完整排序行指纹一致，比较范围为以下所有旧行，而非仅抽查35个词：

| 原始表                         |  全行数量 |
| ------------------------------ | --------: |
| Word                           |   770,611 |
| Sense                          | 1,114,069 |
| 未绑定旧 WordExample           |    18,769 |
| Book                           |        18 |
| BookItem                       |    69,840 |
| 既有 ContentPack，不含本次新包 |         5 |

为了补齐 address/subject 发音安全标记，曾在同一可丢弃测试库精确撤回未发布的旧测试包 `e7ce25a7…`。撤回前核对旧包完整摘要、98/98/196个确切ID和行内容，并确认任务、测评、命令回执、复习日志、收藏句等9类引用聚合均为0；事务只删除这些新行及该包标记。撤回后的旧表指纹也与最初完全相同，再安装最终 `1984c9ae…` 包并重放验证。没有覆盖已安装行来冒充重放，也未修改旧字典、旧候选或用户记录。

本机详细证据保存在 `/Volumes/XXX/Codex/work/nightstudy/learning-senses-v1/`：`final-validation/full-install-replay-receipt.json`、`withdrawn-unpublished-test-pack/withdrawal-receipt.json`、`independent-semantic-review.json`。它们证明注明的内容与隔离验证范围，不表示CI、线上升级、实体设备或生产部署已经完成。

### 13.3 可复现命令与后续制作

公开源投影可从既有0.10原创建稿归档中的 `content-source.jsonl` 取得；使用前必须核对上述源摘要。大文件和编译输出放在已挂载且可写的外置盘：

```sh
python3 scripts/learning-senses-compile.py \
  --source /path/to/public/content-source.jsonl \
  --source-sha256 614374f14db7a11141877e3a38c8f1e1f419ad49ca686cc1a23516195f5ce19c \
  --bilingual-manifest data/bilingual-v2.manifest.json \
  --drafts data/learning-senses-authored.json \
  --drafts data/learning-senses-authored-batch2.json \
  --drafts data/learning-senses-authored-batch3.json \
  --output /Volumes/XXX/Codex/work/nightstudy/learning-senses-reproduction

pnpm senses:prepare --site default
node scripts/check-learning-senses-install.mjs --self-test
node scripts/check-learning-senses-install.mjs --single-site default
```

`senses:prepare` 在完整字典、词组和 bilingual-v2 准备完毕后执行；标准 `db:prepare` 已接入此顺序。单站验收必须显式写 `--single-site default`，只读取环境中的 DATABASE_URL，并核对真实 SiteState.siteId；多站使用 `--sites-file <配置路径> --site <站点ID>`，测试库可显式使用 `--test-database-env CONTENT_TEST_DATABASE_URL`。三种数据库选择方式互斥，不自动猜测数据库。验收事务只读，正常输出不含连接信息和凭据。

可在本次安装之前用 `--snapshot <新文件>` 保存原始源身份，安装后使用 `--baseline <该文件>` 比较。加 `--audio` 会逐句、逐US/UK口音检查 SentenceAudio 身份和实际文件摘要；尚未安装音频时会如实返回196句、392个目标、392处缺口并非零退出，不把“未检查”写成全覆盖。文件检查包含路径越界、摘要和字节校验，不替代生成阶段的完整解码和抽听。

编译器同时输出 `learning-senses-progress.jsonl`、`learning-senses-progress.summary.json`、`learning-senses-authoring-queue.jsonl`、`learning-senses-candidates.jsonl` 和 `learning-senses-sentences.jsonl`。逐词队列保留原文、字段摘要、来源、现有审核义项及未绑定候选ID；下一批须继续先定义真实原子义，再撰写或核对两个语境，不能自动接受队列或把源行数当成工作量。gzip 使用固定时间和平台无关头，当前包已按相同输入独立重编译并核对字节摘要。

后续新增义项可在独立输出目录使用新的 `--pack-id learning-senses-v2`，再通过 `pnpm senses:prepare --manifest <新包manifest路径> --site <站点ID>` 安装。新包只新增明确的新语义身份；既有行不一致会被拒绝。不要改动已发布的v1文件或把同名包覆盖当成内容升级，后续修订既有义项需保留可追溯的新版本及处置决定。

## 14. 查询、移动界面与静态句音验收

四条新增迁移已在两个最小测试库与完整隔离库应用：新增三个表及例句关联字段、pg_trgm/C排序索引、来源绑定修改后的挂起触发器，以及同词同版例句外键。例句的contentVersion必须等于其LearningSense版本，ON UPDATE RESTRICT禁止改义项时把旧句自动标成新版。源原文字节变化、绑定UPDATE/DELETE均使已发布义项held；运行时仍复核来源摘要，不能仅凭状态展示内容。

查词列表采用精简投影、服务端全局匹配排序、完整匹配数和15分钟签名keyset。scope绑定实例、站点、账户及全部条件，目录/本人集合变化后旧游标明确失效。contains要求可提取的连续三字符，短输入smart退回prefix，NUL输入400；通配符按字面量处理。拼写建议显式选择，不把近似词当原查询答案。后台、原始来源与个人记录不进入公共共享缓存。

页面按pathname区分lookup与wordbook；q不会改变页面身份。列表、详情、追加页及收藏分别处理请求状态，完整条件进入URL与查询键，输入法/防抖/取消旧请求已接入。详情独立加载，重新打开和回前台重新校验；返回以同一次页面栈与列表会话证明恢复真正的H5滚动锚点。阅读模式的“更多词典释义”默认折叠、首次展开才挂载，不追加旧的未绑定句；学习模式保持当前义项。缺句明确留空，卡内不递归弹卡。

已签发题目、回答依据和收藏句文不回写。新句仅在同义项ID、POS、英中定义、内容版本及bindingHash完全相同时补充显示；不把新拆义追加到旧题。当前撤回词音的安全策略独立于题目正文：旧快照也会在只读显示层清除不兼容音标/词音，隐藏词投影保留false；元数据补拉、缓存、GET/HEAD媒体均不能恢复已撤回读音。句音保持按本句英文独立播放。

### 14.1 新句音成品

`sentence-audio-v3`实际新增196条英文、392条US/UK MP3，与v1/v2均无textHash/口音交集。只使用既有缓存声学模型本机离线生成，没有下载模型或调用付费API；线上安装只校验和播放成品。新包为7,758,221字节，SHA-256 `74f7ab46ed20b64014a253bdbca3110c7c80f13de77b0b430a41b14457f021c0`。媒体manifest摘要 `b3c4e96b818acec1eb4fb26cb69220473d557294892bd4281f9897b1602e791b`，来源manifest摘要 `fc2eee233cf73cdda88e69d11dc13af386d9b2422197a42f222aac69e41edd89`。

独立审计确认403个归档成员恰为392媒体、2manifest、9许可；全文、媒体及路径扫描未见私密路径、进度或模型混入。392条全部独立完整解码、重算声学指标及字节摘要通过，两个口音模型/config/cacheKey逐项核验；缓存重封逐字节复现同一归档。隔离库安装后独立checker核对196句/392目标/392文件，缺失和错误均0。此为文件、声学及来源完整性结论，不是逐句发音专家听审。

默认audio准备顺序为word-v2、sentence-v1、sentence-v2、sentence-v3；标准完整内容先安装字典/词书/音标/词组/v1-v2文本，再安装本轮义项包。不修改此前公开包的内容或URL。

### 14.2 实际验证范围

| 检查                  | 实际结果与限制                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 冻结应用构建          | core/API/Web均在外置目录构建成功，未覆盖仍运行的dist；四组TypeScript检查通过。                                                                      |
| JS/TS与PostgreSQL回归 | 最终冻结构建93文件/794项全部通过，含Unicode contains门限、导入确认与听辨签题的当前禁音策略。隔离PG两Realm，未连接业务库执行测试。                   |
| 离线工具              | 12组Python共155项通过；音频checker169项、义项checker17项自测通过，不调用在线模型。                                                                  |
| 隔离浏览器夹具        | 26项，320×568、390×844、横屏无横向溢出，查询/切义/深链/页面栈与滚动恢复通过。                                                                       |
| 真实API移动界面       | 5511应用连接55441完整隔离库，52项通过；两用户收藏/句库隔离、精确义项快照与刷新、20→40无重复翻页、A→Z/Z→A、H5锚点333→333、record禁音和NUL400均核对。 |
| 实际音频事件          | bank双口音句音完成真实HTMLAudio解码与playing，切句/切义产生pause；不以文件存在代替播放事件。                                                        |
| 原始内容              | Word/Sense/旧候选句/Book/BookItem/原ContentPack全行流式指纹不变，最终包重放0写。                                                                    |

真实浏览器的页面/控制台错误、外链尝试和生产请求均0。公开截图来自匿名隔离页面：[查词列表](media/mobile-lookup-0.11.png)、[河岸义项](media/mobile-sense-0.11.png)。上述为桌面Chromium手机视口；实体iOS/Android、真实软键盘与逐句专家听审仍未验收。源词、来源hash、句库、音频撤回及游标隔离另经独立代理只读审查；发现的版本、缓存与旧快照禁音缺口均已修复并回归。

### 14.3 完整目录性能

隔离目录为770,611词、1,114,069源义及98学习义项。最终33组、2,200次warm app.inject请求0错误，目录revision全程稳定，临时用户精确清理。测量覆盖并发1/10/25，保存p50/p95/p99、字节、SQL数及执行计划；25并发部分结果如下：

| 接口/场景               | p95 ms |
| ----------------------- | -----: |
| 旧前缀完整读取图对照    |  20.55 |
| 新前缀精简列表          |  20.20 |
| 包含匹配                |  47.41 |
| 智能匹配                |  36.96 |
| 精确匹配                |  14.97 |
| 错拼建议                |  53.46 |
| 完整词详情              |  26.93 |
| 本人5,000收藏，最近更新 | 121.65 |
| 本人5,000收藏，包含匹配 |  87.49 |

前缀响应从21,221降至5,927字节，SQL从9次减至6次。大生词本精确COUNT曾因planner选择扫描77万词；改为按本人索引集合做Word主键相关校验，最终计划8.91ms，没有旧全词典hash扫描。无法提取trigram的contains直接400且0 SQL，smart短输入走C前缀索引。

两轮含0/98学习义项测量及修复前计划均保留；测试共用本机PG集群，其他测试可能有I/O影响，不完全控制缓存。app.inject使用可信夹具上下文，不包含TCP/TLS、生产认证中间件、真实用户写入或冷缓存，不能据此承诺VPS吞吐或将差值全部归因于SQL。

本机证据：`/Volumes/XXX/Codex/work/nightstudy/011/frozen-validation-receipt.json`、`python-checker-validation.json`、`lookup-performance/final-receipt.json`（SHA-256 `35e2ff6279cc60d1fe1448de4cfc28c9ef83d3332e4dba50205456b97e3e1277`），以及UI目录的`lookup-real-receipt.json`、`independent-contract-review.json`和音频独审目录的`audit-receipt.json`。

## 15. 发行与保数据升级状态

0.11候选已完成上述本机功能与内容验证。现有Native部署的160,073,360字节私密备份已在55441独立随机测试库成功恢复（15条原迁移、770,611词及原2用户），未向业务库恢复或启动该恢复库的应用。四迁移增量、全部原业务表保护及重放演练正在执行；GitHub CI、默认Compose冷安装、镜像发布及生产切换尚待本节以真实结果补记。
