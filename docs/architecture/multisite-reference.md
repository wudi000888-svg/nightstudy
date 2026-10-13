# 多站兼容的通用工程参考

只读核验日期：2026-10-14。参考用户指定的 [guangyue-panel](https://github.com/wudi000888-svg/guangyue-panel)，固定快照为 `7002036692caa6b9d54d3fa19983a076c737445f`。读取了 README、五份指定部署文档和 deploy 源码/测试；没有运行仓库脚本、安装程序、测试或改动任何服务器配置。临时读取内容只保存在 `/tmp`。

这不是同类学习产品；本文不规划 NightStudy 主站控制远程子站，也不移植代理协议、配对、网络调优或支付。参考范围为共存、显式边界、预检查、版本与回滚。

## 证据与采用范围

| 已读证据 | NightStudy 采用的通用原则 |
| --- | --- |
| README 明确排除同站多主 HA、组织租户隔离与服务等级承诺。[README:25](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/README.md#L25) | 不把“多站”或使用 PG/Redis 写成 SaaS 隔离与高并发容量已被证明；独立实现并验收。 |
| NGINX 文档区分公网 TCP 443 的 SNI 分流和回环 HTTPS 监听，要求 PROXY 链一致；已有 stream 需要显式合并。[NGINX:5](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/docs/NGINX.md#L5)、[NGINX:55](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/docs/NGINX.md#L55) | 复用已有入口；不创建第二个抢占 443 的代理，不自动覆盖共享配置。 |
| CONFIGURATION 列出内部回环端口与公开 URL 边界。[CONFIGURATION:37](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/docs/CONFIGURATION.md#L37) | 每份 installation 显式记录 host/base path、内部端口、可信代理、DB 与密钥引用。 |
| INSTALL 使用固定包及 SHA256 检查，再进行 preflight；源码拒绝已存在受管路径、服务、stream 和域名冲突，在临时配置上检查 Nginx。[INSTALL:108](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/docs/INSTALL.md#L108)、[install.py:88](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/deploy/install.py#L88) | 先只读清点与生成审阅片段；发现冲突停在检查阶段。采用固定镜像/dataset digest 与独立回滚计划。 |
| render 源码显式生成已有站点域名映射、PROXY 发送/接收配置；测试声明覆盖已有站点及配置注入。[render.py:69](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/deploy/render.py#L69)、[test_deploy.py:93](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/deploy/tests/test_deploy.py#L93) | 为 host/path 注入、端口冲突、入口共存建立自己的回归；静态测试存在不等于本次已执行通过。 |
| EDITIONS 描述安装升级失败的恢复边界；BUSINESS-SITES 描述独立站点保留本地数据库，并明确没有自动跨站负载均衡。[EDITIONS:75](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/docs/EDITIONS.md#L75)、[BUSINESS-SITES:29](https://github.com/wudi000888-svg/guangyue-panel/blob/7002036692caa6b9d54d3fa19983a076c737445f/docs/BUSINESS-SITES.md#L29) | 采用“本站数据有明确归属、失败不清空别站”的原则；不移植其主控/子站产品结构。 |

部分部署文档沿用较早版本号；本次证据以固定 commit 中的文字与代码为准，未据此确认其实际生产部署状态或性能。

## 本项目的兼容方案

已有普通 Nginx/Caddy/ALB 时，只增加学习站点自己的 host/location/upstream 片段；应用绑定空闲回环端口或受控内部网络。预检查记录既有 listener、证书、站点路径、include 与健康基线，生成差异和备份/回滚步骤。修改后验收其他已有站点，不能只看新首页。

已有广月的 TCP 443 SNI → 回环 HTTPS 体系时，NightStudy 保持现入口和原路由，只把明确学习域名接到现有 `127.0.0.1:10443` 虚拟主机。PROXY protocol 在 stream → TLS listener 两端匹配；HTTPS Nginx → Node 使用普通 HTTP 与校验过的来源头。SNI 只用于域名分流；同域 base path 在解密后的 HTTP 层路由。现有共享入口需要 operator 审阅接入，不套用另一产品安装器。

NightStudy 自己实现两种部署：独立 installations 各有 Compose project/PG/密钥；共享 backend 由 operator SiteRegistry 选择每站独立 PG DB 与固定 Realm。真租户默认不同 domain/subdomain；同 origin 的子路径只作同信任域共存，Cookie Path/prefix 不构成强隔离。高并发使用无状态 Web、副本入口、独立 worker、有界队列与数据库连接预算，吞吐只在压测后报告。

完整施工选择见 [部署方案](deployment-design-notes.md)。本文只是参考证据附录，不是安装指令。
