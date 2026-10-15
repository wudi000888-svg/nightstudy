# 可选 AI 配置与 CC Switch 兼容

NightStudy 的词书学习、服务器 FSRS、双语内容安装和英美音源不需要 AI。后台提供可选的 DeepSeek 官方或 CC Switch 供应商配置、手动连接测试、单词内容预览和水平测试辅助分析。**默认未配置，水平测试分析也单独默认关闭；词库不自动补齐**。只有管理员启用服务与水平测试开关、学习者选择在完成测试时使用分析，才会尝试该功能。

## 管理员操作

仅本站管理员可以配置。DeepSeek 官方模式保留固定地址 `https://api.deepseek.com` 和当前支持的 `deepseek-flash`、`deepseek-v4-pro`。选择「CC Switch · 自定义服务」后，填写供应商的接口类型、接口地址、实际模型名称、认证方式与真实 API key。保存配置不调用上游；删除密钥同时禁用服务和水平测试分析，关闭服务总开关也会关闭测试分析。

CC Switch 是配置切换器，不发行统一密钥。复制它所管理的供应商配置，需要地址、模型、协议与密钥匹配；仅复制 key 不能转换服务商、协议或套餐权限。NightStudy 不读取用户本机 CC Switch 配置，也不上传其导出文件。参考 [CC Switch 官方添加供应商文档](https://github.com/farion1231/cc-switch/blob/51ac86f1c59abfefabadebd05ec5a5415b8ad72c/docs/user-manual/zh/2-providers/2.1-add.md)。

| 接口类型                | CC Switch 中对应的值                                                                  | 认证方式                                   |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| OpenAI Chat Completions | 供应商地址、实际模型与 `OPENAI_API_KEY`                                               | Bearer                                     |
| OpenAI Responses        | Codex `base_url`、`model` 与 `auth.OPENAI_API_KEY`                                    | Bearer                                     |
| Anthropic Messages      | Claude `ANTHROPIC_BASE_URL`、实际模型与 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` | API key 用 x-api-key；AUTH_TOKEN 用 Bearer |
| Gemini API              | `GOOGLE_GEMINI_BASE_URL`、`GEMINI_MODEL` 与 `GEMINI_API_KEY`                          | x-goog-api-key                             |

输入不限定 `sk-` 前缀，支持 8–4,096 个可打印 ASCII 字符。模型最多 160 字符；地址最多 2,048 字符，不能含用户名、密码、查询参数或片段。Google 账号登录、OAuth 刷新票据及 CC Switch 的 `PROXY_MANAGED` 占位值不作为真实供应商 key 接入。代理注入的密钥应从供应商配置获取，而不是复制客户端被代理覆盖后的占位值；原生 API 兼容不保证任意模型、供应商账户或路由在线。

OpenAI 地址为空路径时默认使用 `/v1`，显式前缀按原样追加 `/chat/completions` 或 `/responses`；例如 `/api/v1` 不会重复加 `/v1`。Anthropic 空路径使用 `/v1/messages`，已有 `/v1` 不重复，其他前缀追加 `/v1/messages`。Gemini 使用 `/v1beta/models/<模型>:generateContent`。填写完整对应端点时也可使用，但端点与接口类型必须一致。

已有密钥时，更换服务商、地址、接口类型或认证方式必须重新输入对应 key，或删除 key 并关闭服务；旧密钥不会自动发往新地址。仅改变同一地址的模型可保留密钥。保存、删除、测试和预览保留本站管理员权限及独立站点隔离。

“测试连接”发送一条有界的 JSON 检查请求。“预览缺失内容”只针对一个已发布词条，发送该词的公开词头、词性、原释义与待补字段；它不把账户信息、私有词书或学习记录作为提示内容。已有双语内容不重新生成，没有缺项时直接返回空候选。

管理员主动测试或预览，以及已启用且由学习者选择的水平测试分析，会使用所配置服务商账户的额度，费用由该账户承担。请先自行查看服务商的计费和账户余额。这里不承诺免费额度、固定单价或指定模型持续可用；限流、余额不足、无效密钥、超时和无效结果会明确失败，不自动重试。

## 水平测试辅助分析

“水平测试智能分析”独立默认关闭。开启后，学习者看到所配置服务的名称与地址来源，并可选择是否使用；前端显式提交 `useAi: true` 才触发，旧客户端省略字段不会外发或调用。服务器先完成原有分层认知、拼写计分与小样本证据，再在数据库事务之外请求所配置的模型。发送内容仅包括本次目标、题目、正确答案、原样用户答案与客观判对结果，不发送账户身份、私有词书或原复习记录。长题文和来源释义按总输入预算缩短并标记，原用户答案不会被截成看似正确的答案。

分析同意绑定页面显示时的配置版本。完成时须同时提交 `expectedAiConfigurationRevision`，与服务器当前配置不一致或缺失时只提供基础成绩，不向新服务发送答案、不自动重新收费。页面发现配置变化会撤销旧勾选，须重新确认；已发出的上游请求不能追溯取消，但返回内容仍需配置和身份复验。

AI 报告补充中文总结、强项、弱项、仅本次测试词的练习建议和学习计划建议。客观正确率、已确认的测试词与本地计划仍保留；AI 不重新判分、不估计未测试词的掌握情况，也不写入真实 FSRS、复习日志、熟词或学习设置。学习者须手动采用建议。建议总目标有 20 词的保守下限，并参考已有复习压力，最大 100；组大小限制 1–20。结构校验不证明模型分析更准确，也不构成标准化考试或专家评估。

每份已完成测试最多发起一次模型请求。持久化 claim 让重复完成、跨实例并发和报告刷新不会再次调用；运行超过 90 秒的旧 claim 显示中断，不自动重试或再收费。模型超时、余额或密钥错误、限流、配置变更、返回结构不合格时，页面仍能显示本地成绩，并说明智能分析不可用。请求期间身份失效时不回传原私有报告。上游的实际计费由服务商决定，失败降级不表示上游一定未计费。

`report.aiAnalysis` 的 `status` 为 `available`、`unavailable`、`disabled` 或 `pending`。只有可用时有 `payload`，包括 `summary`、`strengths`、`weaknesses`、`wordFeedback` 和 `suggestedPlan`。用户报告不回传密钥、claim、模型标识或上游 usage；有界 usage 与耗时仅记录在本站该次测试的内部分析元数据中。

## 候选与写入边界

预览绑定同词的原 `Sense`、源语言、精确原文 SHA-256 和目标空字段。生成例句要求完整原词及两种语言，并保留 `provider`、所选模型、生成时间与 `review: pending`；所选模型名不证明服务商响应背后的具体权重版本。

所有成功预览返回 `applied: false`。当前没有自动批处理或候选应用接口；候选不写入 `Word`、`Sense`、`WordExample` 或学习记录，不能把“预览通过”说成“词条已经补齐”。结构检查也不证明含义和译文正确。内容、配置或管理员权限在请求期间变化时，返回的候选会被丢弃。

管理员如需采用内容，须自行逐项校对，走已有内容编辑流程。站点编辑按本站来源记录，不自动成为可公开分发的词库贡献，也不把上游输出冒称 NightStudy 的 MIT 原创例句。

## 密钥与运行限制

每站密钥以 AES-256-GCM 加密存入该站数据库，密钥材料由本站认证 secret 派生，并绑定站点及安装实例身份。读取接口只返回“已配置”状态和末四位遮罩，不回传原密钥。原有 DeepSeek 密文保持兼容。备份需保管对应数据库、实例身份与认证 secret；轮换认证 secret 后若无法解密，须重新配置 key，不能依赖数据库密文恢复明文。

服务器单次请求限制 20 秒和 64 KiB 响应；官方 DeepSeek 连接测试最多 32 个输出 tokens，自定义服务连接测试最多 512 个，缺项预览最多 2,400 个，水平测试分析最多 1,200 个。通用请求不发送 DeepSeek 专用参数，不跟随重定向、不开启流式输出或自动重试；响应必须完整并通过业务 JSON 校验。数据库限流在管理请求和水平测试之间共用：每站每分钟 20 次、每个调用者每分钟 6 次；请求 lease 限制每站同时 2 次、同一调用者同时 1 次。它们是资源边界，不是服务可用或吞吐保证。

OpenAI 两种请求均显式发送 `store: false`，Responses 使用顶层 instructions/input 和有类型的 output。请求参数不保证第三方转发站执行同样的数据保留策略，实际行为取决于所配置供应商；协议依据 [OpenAI 官方迁移文档](https://developers.openai.com/api/docs/guides/migrate-to-responses)。

默认仅接受公网 HTTPS 地址；请求前验证所有解析 IP 并固定连接地址，阻止解析重绑定、内网与云元数据访问。需要本机/内网代理时，部署者可在私有 `.env` 配置 `AI_PRIVATE_ENDPOINTS_JSON`，只允许精确 origin 与固定 IP，管理员表单不能扩展该权限：

```dotenv
AI_PRIVATE_ENDPOINTS_JSON=[{"origin":"http://127.0.0.1:15721","addresses":["127.0.0.1"]}]
```

此示例仅适用于代理和 Native 服务运行在同一台服务器。VPS 的 `127.0.0.1` 指 VPS，Docker 容器的指容器自身，均不是用户 Mac；不应为兼容而公开桌面代理。Docker 私有代理需要可达的受信任入口、相应固定地址规则及独立真实鉴权。参考 [CC Switch 官方代理服务说明](https://github.com/farion1231/cc-switch/blob/51ac86f1c59abfefabadebd05ec5a5415b8ad72c/docs/user-manual/zh/4-proxy/4.1-service.md)。

只有部署者明确配置了相应受信任 origin 时，才允许 `PROXY_MANAGED` 用作该代理的占位值，由实际代理管理上游密钥；默认公网供应商配置会拒绝此值。NightStudy 不负责从代理反向提取真实上游密钥。

后台契约如下，路径均位于本站 `/api/v2` 下：

| 方法与路径                        | 用途                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/ai/deepseek`          | 启用状态、模型、provider/baseUrl/protocol/authMode、可选类型、key 状态和遮罩                                         |
| `PUT /admin/ai/deepseek`          | 保存 `enabled`、`assessmentEnabled`、`provider`、`baseUrl`、`protocol`、`authMode`、`model`、`apiKey` 或 `removeKey` |
| `POST /admin/ai/deepseek/test`    | JSON `{}`，主动连接检查                                                                                              |
| `POST /admin/ai/deepseek/preview` | `{wordId}`，只读候选及上游 usage                                                                                     |
| `GET /assessments/capabilities`   | 登录后读取 `aiAvailable`、`aiServiceName`、`aiServiceOrigin`、`aiConfigurationRevision`，不调用上游                  |
| `POST /assessments/:id/finish`    | `{useAi?: boolean, expectedAiConfigurationRevision?: string}`，完成本地报告与最多一次分析；未知字段拒绝              |

回归使用隔离 PostgreSQL、受控上游响应与本机临时服务验证鉴权、加密、限流、协议、地址限制、源变更、水平测试一次性分析与降级、不写字典和不造复习历史的边界。没有真实 key 的付费上游调用结果，不将这些测试声称为任意供应商在线可用性或语义质量验收。
