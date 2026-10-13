# Changelog

## 0.1.0-alpha.1 — 首版 alpha

首个新工程 alpha 已完成本机核心流程验证，尚未正式发行容器。本机 PG18.4 的 3 文件28测试、格式/类型检查及桌面/手机浏览器流程通过；PG17/Compose CI 与 Render 实际部署状态分别记录在 [README](README.md)，不混用本机与平台证据。

- React/TypeScript 雨夜风格 Web、响应式导航、账户与学习页面；Fastify 同一 Node 进程提供静态 Web 和 API。
- Better Auth 本站邮箱/密码 session；随机初始化口令创建首位管理员，本站用户停用与审计。
- operator 配置多站 host/basePath，每站独立 PG 认证/业务 DB 和密钥；独立 Compose project 可分别部署。独立 origin 才用于互不信任租户。
- 40 个原创演示词、五个目标演示词书；词书选择、固定内容快照学习会话、FSRS 评价与拼写练习。
- 学习动作编号去重、会话/进度 revision 冲突保护、PG 原子跨副本限流。
- 每日新词目标只约束新组的预约配额。已签发的一组可继续评价与拼写，中途降低目标不会阻止完成；同书并发新组排除已预约词，配额按同词去重并由服务端事务保护。计划返回 reservedNewCount，将待完成预约与真正学过的词分开。
- 默认 app 启动后及每60秒执行有界 PG lease 维护，独立worker共用入口；站点DB绑定校验、重试耗尽failed与批次清理。Render显式公网IP profile使用入口覆盖的单值合法CF-Connecting-IP，health探测例外；Realm始终以wire Host选站。
- 熟词 text/CSV/JSON 预览、确认、撤销、导出；声明与客观掌握分开。演示词表的拼写/认知测试及学习建议。
- 个人真实活动统计、FSRS 未来不复习假设曲线及自评回忆观察；无数据不填造趋势。
- 本站基本后台：用户停用、词书编排、词义/例句编辑、公告与审计。
- 同镜像 Web、独立 migration/seed job 和 PG lease worker；Compose minimal、可选 scale scaffold、Render 首站 Blueprint 与包含格式检查的 GitHub CI 描述。
- MIT 新代码许可、贡献/安全/行为文档和 issue/PR 模板。

尚未纳入本次 alpha：完整考试词库、ECDICT 只读 pack、音频/媒体 provider、邮件验证/找回、OAuth、完整内容批量导入、分页/OpenAPI、Redis provider、PgBouncer、活动 Realm LRU、跨主机 HA 与实测高并发容量。Render 资源创建/恢复、Docker/Compose 真机验证和正式镜像发行在完成前不标为通过。
