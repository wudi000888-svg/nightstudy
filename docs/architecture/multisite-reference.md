# 多站、配对与更新检测的工程参考

只读核验日期：2026-10-14。用户指定参考 [guangyue-panel](https://github.com/wudi000888-svg/guangyue-panel) 的工程思路；它与英语学习产品不同。NightStudy独立设计与实现，没有复制其产品代码或移植代理协议、资源/支付模型。没有读取私有.env/masterkey、运行其安装/更新脚本或变更服务器。

早期入口共存核验固定commit `7002036692caa6b9d54d3fa19983a076c737445f`；本轮通过Agent-Reach的GitHub/gh只读路径补充公开main快照 `80f32ad3fdb025c35765079e61273986ad7f1075` 的更新/群站实现。授权本地checkout `a0605ed3` 只作差异辅助，不当作最新公开版本。

## 来源与采用原则

| 公开源码证据                                                                                                                                                                                   | NightStudy采用的原则                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [NGINX入口共存](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/docs/NGINX.md) 区分SNI/TLS/内部监听及PROXY链                                    | 精确域名映射，保留旧路由；basePath在解密后的HTTP层处理。                                         |
| [固定包/preflight](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/deploy/install.py) 与失败恢复边界                                            | 固定版本/摘要、先验证配置与冲突；发布重建、独立DB恢复、完整灾备分别记录。                        |
| [版本目录缓存与失败](https://github.com/wudi000888-svg/guangyue-panel/blob/80f32ad3fdb025c35765079e61273986ad7f1075/deploy/update_agent.py#L67) 保留成功时间/目录，错误持久化并标过期          | 检测失败不能显示已最新；NightStudy仅检测固定GitHub Release，PG保存本Realm结果/检查冷却。         |
| [现有长期配对凭据](https://github.com/wudi000888-svg/guangyue-panel/blob/80f32ad3fdb025c35765079e61273986ad7f1075/backend/internal/controlplane/fleet.go) 有scope/hash/撤销；并非单次票据      | NightStudy另建10分钟一次票据与独立长期grant，二者撤销分别处理。                                  |
| [连接凭据包装](https://github.com/wudi000888-svg/guangyue-panel/blob/80f32ad3fdb025c35765079e61273986ad7f1075/backend/internal/controlplane/site_management.go#L24) 需要鉴权核验实例/站点      | 包装不是签名身份；绑定(instanceId,siteId)，保留NightStudy合法basePath，不能只靠同名default站点。 |
| [固定网关白名单/外连验证](https://github.com/wudi000888-svg/guangyue-panel/blob/80f32ad3fdb025c35765079e61273986ad7f1075/backend/internal/httpapi/gateway.go) 拒递归、敏感凭据接口和私网重绑定 | 不转发Cookie，只允许明确管理动作；目标grant限权、可信HTTPS和逐请求tuple核验。                    |

广月最新版非force目录TTL15分钟，手动force直接刷新；较早local版本的60秒复用不能当最新行为。它的版本比较限定稳定x.y.z，NightStudy需要独立支持alpha/beta与完整SemVer。参考 [node-semver官方规则](https://github.com/npm/node-semver)，不使用字符串排序或coerce丢掉预发布后缀。

## NightStudy的边界

本项目有两类部署：独立installation各有Compose/PG/密钥；共享backend按operator配置的可信Host+basePath选择各站独立DB/认证Realm。互不信任租户用独立origin；同源子路径不构成浏览器强隔离。0.3新增自愿授权的远程群站管理，不改变本站数据归属或operator域名/DB配置权。

群站只提供状态、限权用户/注册/公告管理和更新检测。撤销失败保留pending，不假报远端已撤销；管理员明确确认后可仅本地忘记连接并用新票重配同URL，remoteRevocationConfirmed=false，旧远端grant仍需独立撤销。密码、私钥、数据库URL及长期明文credential不通过Web导出。不存在可传任意URL或shell的自动升级接口。GitHub无该渠道Release时明确no-release，当前源版本不冒充已发布版本。

已有共享TLS入口继续精确登记学习域名，不另抢443；当前部署的再生成参数保留要求见 [部署文档](../DEPLOYMENT.md#共享tls入口与已有站点共存)。0.3代码86afefa的86项测试及CI已通过，VPS另完成42项真实公网HTTPS管理员/双站检查，临时独立子站与入口已清理。参考代码和这些限定结果均不替代高并发压测或HA恢复。完整实现契约见 [API](../API.md#群站配对与限权管理)。
