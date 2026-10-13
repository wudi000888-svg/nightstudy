# Google 在线翻译与 VPS 网关

NightStudy 的翻译面板可展示 Google 的在线翻译结果，并提供带原文的官方网页入口。Google 网页当前返回 `X-Frame-Options: SAMEORIGIN`，不能在本站 iframe 中直接加载；本项目不删除它的安全响应头、不复制 Google 登录页。

站内结果使用固定 `https://translate.googleapis.com/translate_a/single` 的网页兼容接口。这不是受支持的Google Cloud Translation API，可能变更、限流或停止服务。失败返回明确错误，用户仍可打开官方网页；系统不把离线词义冒充在线结果。默认部署只开启网页入口，配置VPS网关后才尝试站内结果。当前选择保留Google官方网页入口和已部署的私密备用网关，暂不接入收费Cloud API。

## 三种运行方式

| 配置                                | 用途       | 行为                                        |
| ----------------------------------- | ---------- | ------------------------------------------- |
| `TRANSLATION_MODE=website-official` | 默认       | Google 官方网页链接；站内请求返回未配置     |
| `TRANSLATION_MODE=direct`           | 本机开发   | 本机 API 直接访问兼容接口；生产配置拒绝此值 |
| `TRANSLATION_MODE=gateway`          | VPS / 生产 | API 经带私密 token 的固定 VPS 地址请求结果  |

网关提供固定上游路径、私密鉴权与请求预算，不改变Google的限流。本机及目标VPS真实请求均遇到上游429；当前不能宣称站内翻译可用或已加速。它不代理用户整个浏览器，官方网页能否打开也取决于用户网络。

## 同一 VPS 的 Compose 安装

在主工程私有 `.env` 内生成至少 32 字符的独立 `TRANSLATION_GATEWAY_SECRET`，不能复用数据库密码或登录密钥。

```sh
docker compose -f compose.yaml -f compose.translation.yaml config --quiet
docker compose -f compose.yaml -f compose.translation.yaml up --build --detach --wait --wait-timeout 600 app
```

override 自动将应用连接到私有网络内的 `http://translation-gateway:3099/translate`。网关不开放公网端口，只接收来自应用的鉴权请求。应用及每个站点的用户仍由各自认证 Realm 决定。

## 独立 VPS 网关

在 VPS 克隆本仓库，使用单独配置；该服务无需应用数据库、用户账户或站点登录密钥。

```sh
cd deploy/translation-gateway
cp .env.example .env
# 在 .env 填入新生成的 TRANSLATION_GATEWAY_SECRET
docker compose config --quiet
docker compose up --build --detach --wait gateway
curl --fail http://127.0.0.1:3099/health/ready
```

服务只监听宿主机 loopback。已有 Caddy/Nginx 可将专用 HTTPS 域名转发到 `127.0.0.1:3099`，示例见本目录 `Caddyfile.example`。保留原站点配置，为网关新增独立域名；不要直接暴露无 TLS 的 3099 端口。

应用私有环境配置：

```dotenv
TRANSLATION_MODE=gateway
TRANSLATION_GATEWAY_URL=https://translate.example.com/translate
TRANSLATION_GATEWAY_SECRET=<与VPS相同的私密token>
```

多站 JSON 可分别配置 `translationMode`、`translationGatewayUrl`、`translationGatewaySecretEnv`。前端 provider 状态只返回是否配置和传输方式，不返回 URL 或 token。远端网关必须使用 HTTPS；本机或固定 Compose 服务名允许内网 HTTP。

## 请求和隐私约束

- 站内结果要求本站登录。最多 1,000 字；应用按本站用户在 PG 中限流 20 次/分钟，多副本共享计数。
- 网关只接受 `POST /translate` 的文本和支持的语言组合，不接受 URL、上游域名、Cookie、任意请求头或任意方法。所有跳转拒绝。
- 每个网关最多 8 个不同文本的并发请求，默认总预算 120 次/分钟，6 秒上游超时、8 秒应用超时、64 KiB 响应上限。总预算可调整，但这不是已验证的高并发容量承诺。
- 成功结果仅在 VPS 内存中缓存最多 200 项、10 分钟；相同并发请求合并。失败不缓存，不写翻译历史，不记录原文或鉴权头。
- 用户点击翻译时，所输入文本会传送到所配置 VPS 和 Google。打开官方网页也会把原文放入网页 URL；请勿在面板输入密码或私密凭据。
- `/health/ready` 只验证网关进程就绪，不证明 Google 上游畅通。应使用真实的鉴权翻译请求检查整条链路。

## 已验证与待验收

[源码577f48b的CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38486206457) 已通过55项测试及真实PG17/Compose完整内容安装；受控provider验证鉴权、缓存、并发合并与失败，网关容器健康及未携鉴权的请求返回401。这些检查不依赖真实Google结果，也不证明上游畅通。

目标VPS的0.2应用镜像、独立PG17、私密网关与内容缓存已运行，22项HTTPS生产HTTP检查全部通过，包括认证Cookie/角色隔离、真实FSRS学习、Google官方deep link与网关鉴权链路；临时账号已删除。网关真实请求返回429 `translation_upstream_limited`，本机也遇到上游429；保留明确错误与官方网页入口，备用网关不宣称加速已完成。

包含HEAD SPA修复的 `577f48b` 在本机及 [CI](https://github.com/wudi000888-svg/nightstudy/actions/runs/38486206457) 通过55项测试；同一代码基线的VPS镜像已发布，app/gateway容器重建健康，完整词典与3个ready包保留。首份数据库归档与独立临时库恢复也已验证。这只覆盖发布重建的数据保留及本次独立库恢复，不代表主机断电恢复、跨机HA或完整灾备，详见 [部署文档](DEPLOYMENT.md)。生产HTTP检查不替代0.2手机live验收；共享TLS入口的精确域名登记与配置再生成要求见 [共存规则](DEPLOYMENT.md#共享tls入口与已有站点共存)。

参考：[Google 翻译网页帮助](https://support.google.com/translate/answer/2534559?hl=en&co=GENIE.Platform%3DDesktop)、[Cloud Translation 官方设置](https://cloud.google.com/translate/docs/setup)。
