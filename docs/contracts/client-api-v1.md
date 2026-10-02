# Client API v1 — M-002 静态兼容契约

- 版本：v1，2026-10-02；状态：静态契约/合成 golden fixtures 已落地，运行兼容性未验证。
- 原客户端冻结提交：`e60ae223687d536d43febf133aca76d5008e9a2b`。原 DTO/调用证据不取本轮并行修改后的工作树。
- 服务端唯一原基线：`v1.0.0-rc.37` → `385d2dfd10d821b25c8a6766bd16eea248cb1652`。只在 D:/Projects/agent-server 用固定 tag 的 git show/git grep 读取；没有把当前 develop 当基线。
- 本轮写集：docs/contracts/** 与 docs/tasks/M-002/task.md。没有改审计/计划/其他任务、生产代码或 server；没有生产访问或真实凭据读取。
- `C:` 为上述冻结客户端路径/行号，`S:` 为上述固定 tag 的服务端路径/行号。路径 SHA256 与读取方法见 [source-evidence.json](source-evidence.json)。行号只对固定版本有效。

## 1. 范围、证据与分类

本契约覆盖原托管账户、支付、浏览器登录交付、模型 key 与相关 Native/CLI/图像调用，不新增管理端或聊天云同步。35 个调用/调用族 = 16 个账户 + 6 个支付 + 3 个浏览器/本地 + 10 个中继/CLI/图像；图像 generation/edit 与不同 period/group/model 参数属于同一调用族，不把35误解为35个唯一HTTP路径。任意用户自定义服务、完整供应商流事件和独立CLI内部协议不在此声明穷举。

分类是静态兼容判断，不是部署或 runtime 结论：

| 分类 | 含义 |
| --- | --- |
| DIRECT_STATIC | tag 中存在对应中继路由；仍需验证渠道、模型、鉴权和响应/流事件 |
| FIELD_MAPPING | 有可映射字段，但组合字段/外链等仍须补证，不表示直接解码成功 |
| SEMANTIC | 有相近能力，但认证、单位、数据结构或操作语义不等价 |
| MISSING_TAG | 在本次固定 tag 检索的 router/controller/protocol 中未定位原路径；不证明外部桥不存在 |
| UNVERIFIED | 外部服务或等价数据来源未证实 |
| LOCAL | 客户端本地交付，不是服务端 API |

机器可读调用目录：[calls-v1.json](calls-v1.json)；字段库存：[client-dto-v1.json](client-dto-v1.json)。后者明确保存**原冻结基线**，其中 Envelope.code.default_on_missing=true、TokenPair 字段默认值描述原始宽松反序列化，**不是本轮目标规范**。M-003 的严格变更在第2节优先定义，不回写库存冒充原行为。


## 2. 数字 code envelope 与本轮严格 refresh 边界

### 2.1 原行为 vs 本轮目标（不得混用）

| 项目 | 原冻结行为 | 本轮 M-003 目标/主线程报告 |
| --- | --- | --- |
| Envelope.code | i64 带 serde(default)，缺失误当0 | **必需的显式整数 code**；缺失、null、字符串、布尔等类型错误必须拒绝，不能默认成功 |
| Native success envelope | 缺失code时可能解出默认DTO | **拒绝无code的 {success:true,message,data}**；不加native认证转换或宽松双协议推断 |
| TokenPair | access_token/refresh_token/expires_in 原有默认值 | 三字段都必需；两token非空白；expires_in为相对秒数且必须>0 |
| refresh空refresh_token | lib.rs原有沿用旧token路径 | refresh严格边界拒绝；不能依靠沿用旧token把非法响应变成成功 |
| JSON解析诊断 | http.rs原会截取200字符body | 不echo原始response body，避免token/订单/账户内容进入错误日志 |

账户接口（A01–A16）目标只接受数字 envelope：code:i64（required）、message:String（原默认空串）、reason:Option<String>、data:Option<T>。未知额外字段不是严格禁止项；不能单凭存在success字段判失败，关键是显式code和目标DTO满足约束。code=0仍要求非null data；业务code!=0即使HTTP200也失败。注销/公告已读虽然返回unit，原实现实际先解serde_json::Value，也要求非null data；不能拿native无data成功直接套用。证据 C:crates/sub2api/src/client.rs:15–49,827–845,715–722,780–787。

refresh请求为JSON {refresh_token:String}，不携带模型key；响应为code=0 + data TokenPair。expires_in是从收到有效响应起算的**relative seconds**，不是Unix绝对时间；不得直接赋 native access_expires_at，也不得接受0/负数或字符串。应验证非空白token后才更新凭据/安排到期，不以默认零值、空DTO或空token报告登录/刷新成功。本节的正expiry和required字段针对 refresh TokenPair，不宣称所有历史DesktopSession字段已在本轮统一加严。

主线程已报告 client.rs 移除Envelope.code/TokenPair字段default，并加入 frozen_refresh_fixtures_match_the_client_boundary 测试；本契约记录意图与共同样例，不替代Rust执行证明，也不表示native认证桥已完成。当前授权M-003最小生产写集只包括 client.rs/http.rs 严格拒绝边界。

有效refresh body（纯合成）：
```json
{
  "code": 0,
  "message": "",
  "data": {
    "access_token": "FIXTURE_ONLY_ACCOUNT_ACCESS",
    "refresh_token": "FIXTURE_ONLY_ACCOUNT_REFRESH",
    "expires_in": 900
  }
}
```

## 3. 全调用分类与触发点

表内示例用户/组/公告/订单ID和token均为合成占位；带参数路径表示原调用语义而非真实账户。每项DTO/认证、请求、客户端来源与rc.37候选来源继续见第4节及calls-v1.json。


### 3.1 账户

| ID | 原 method/path | 触发 | 分类 | rc.37候选 / 差异 |
| --- | --- | --- | --- | --- |
| A01 | `GET /api/v1/auth/me` | 启动/登录后/账户刷新 | SEMANTIC | GET /api/user/self; S:controller/user.go:489-520；quota 单位、role/status、allowed_groups 来源 |
| A02 | `GET /api/v1/groups/available` | 账户详情 | SEMANTIC | GET /api/user/self/groups; S:controller/group.go:26-52；稳定数值 group_id、platform、subscription_type/窗口无等价来源；auto.ratio 是字符串 |
| A03 | `GET /api/v1/subscriptions/progress` | 账户/订阅页/路由窗口 | SEMANTIC | GET /api/subscription/self; S:controller/subscription.go:49-74; S:model/subscription.go:253-297；单一额度/reset 不等于日周月 USD 窗口 |
| A04 | `GET /api/v1/keys?page=1&page_size=50` | ensure_api_key/按组补 key | SEMANTIC | GET /api/token/?p=1&page_size=50; POST /api/token/:id/key; S:controller/token.go:55-69,188-205；列表 masked key 不可用于中继；需要完整分页与显式取明文 |
| A05 | `POST /api/v1/keys` | 首次或按组补 key | SEMANTIC | POST /api/token/; S:controller/token.go:278-358；创建不返回 id/key；并发可靠定位、quota 默认与 group 映射待定 |
| A06 | `POST /api/v1/auth/refresh` | 到期前约120秒/支付 session_token | SEMANTIC | POST /api/user/auth/refresh; S:controller/auth_session.go:17-44；cookie + X-Auth-Session / 绝对 access_expires_at 不是 JSON refresh + expires_in |
| A07 | `POST /api/v1/auth/desktop-session/exchange` | 浏览器回调/粘贴 code | MISSING_TAG | S:router/api-router.go; no matching path located；现有桥是否存在 UNKNOWN；必须保留 PKCE 原交互 |
| A08 | `POST /api/v1/auth/logout` | 本地退出后 best-effort | SEMANTIC | POST /api/user/auth/logout; S:controller/auth_session.go:47-95；原要求非 null data；native 某些成功无 data；session/key revoke 不是一回事 |
| A09 | `GET /api/v1/models/catalog` | 模型广场/路由刷新 | SEMANTIC | GET /api/pricing; S:controller/pricing.go:38-76; S:model/pricing.go:28-51；enriched catalog、官方参考/有效 USD、分组/上下文/媒体阶梯来源待证 |
| A10 | `GET /api/v1/group-status` | 模型广场/失败回退 | UNVERIFIED | S:router/api-router.go; /api/perf-metrics* not established equivalent；平滑状态/组id/24h7d 可用率未找到等价源 |
| A11 | `GET /api/v1/usage/stats?period=today` | 用量页 today/week/month | SEMANTIC | GET /api/log/self/stat; S:controller/log.go:130-154；quota/rpm/tpm 不是原八项总计；period 时区/窗口与成本口径待定 |
| A12 | `GET /api/v1/usage?page=1&page_size=20&model=fixture%2Fmodel%20%2B&group_id=101` | 用量页分页/模型与组筛选 | SEMANTIC | GET /api/log/self; S:controller/log.go:41-59; S:model/log.go:59-80；model_name、group string、Unix秒/use_time秒、other可选、actual_cost无已证等价 |
| A13 | `POST /api/v1/redeem` | 兑换按钮 | SEMANTIC | POST /api/user/topup {key}; S:controller/user.go:1190-1192,1235-1265；scalar quota 需配置单位与后续余额；payment compliance gate |
| A14 | `GET /api/v1/referral/info` | 账户详情 | FIELD_MAPPING | GET /api/user/aff + self; S:controller/user.go:437-457,489-520；code/aff_count 可组合；referral_link origin/path 未证 |
| A15 | `GET /api/v1/announcements` | 启动/公告面板 | SEMANTIC | GET /api/notice; S:controller/misc.go:179-183；全局字符串不等于有 id/title/账户已读/created_at 的集合 |
| A16 | `POST /api/v1/announcements/301/read` | 打开公告后标已读 | MISSING_TAG | S:router/api-router.go; no per-announcement read endpoint located；未定位账户已读写入；不能伪造 read_at |


### 3.2 支付（plain JSON）

| ID | 原 method/path | 触发 | 分类 | rc.37候选 / 差异 |
| --- | --- | --- | --- | --- |
| P01 | `GET /pay/api/orders/my?page=1&page_size=20&lang=zh-CN` | 支付 modal 配置步骤1 | UNVERIFIED | /api/user/topup/self exists; S:router/api-router.go:114；外部 pay 服务未证；user 与 summary.pending 不是 topup 历史等价 |
| P02 | `GET /pay/api/user?user_id=101&lang=zh-CN` | 支付 modal 配置步骤2 | UNVERIFIED | /api/user/topup/info exists; S:router/api-router.go:113；methodLimits/汇率/待支付数/stripe 开关未证等价 |
| P03 | `GET /pay/api/subscription-plans?lang=zh-CN` | 套餐页 | UNVERIFIED | GET /api/subscription/plans; S:controller/subscription.go:32-46；CNY + 数值 group_id + features/platform 等不等价 |
| P04 | `POST /pay/api/orders?lang=zh-CN` | 充值/购买套餐 | UNVERIFIED | /api/user/pay, /stripe/pay, /subscription/* payment; S:router/api-router.go:116-124,168-178；统一订单与 statusAccessToken/撤销/对账状态未证；写操作不可盲重试 |
| P05 | `GET /pay/api/orders/fixture-order?access_token=FIXTURE_ONLY_ORDER_STATUS&lang=zh-CN` | 订单轮询 | UNVERIFIED | S:router/api-router.go; original order-status token interface not established；订单 token 非账号 token；支付成功与充值入账不同 |
| P06 | `POST /pay/api/orders/fixture-order/cancel?lang=zh-CN` | 取消订单 | UNVERIFIED | S:router/api-router.go; original cancellation contract not established；取消及竞态未证；不伪装已取消 |


### 3.3 浏览器与本地回调

| ID | 原 method/path | 触发 | 分类 | rc.37候选 / 差异 |
| --- | --- | --- | --- | --- |
| B01 | `GET /auth/paseo?endpoint={encoded-origin}&redirect_to={encoded-loopback}&code_challenge={challenge}&code_challenge_method=S256` | 登录/端口失败改粘贴 code | MISSING_TAG | S:router/api-router.go; no bridge path located；外部桥存在性/TTL/单次/账户绑定 UNKNOWN |
| B02 | `LOCAL http://127.0.0.1:{port}/callback; /session` | 浏览器回传 | LOCAL | Not a server route；Origin/endpoint/attempt 验证与 legacy fragment；不读取真实凭据 |
| B03 | `GET /pay?token={encoded-account-token}&theme=dark&ui_mode=standalone&lang={lang}` | 浏览器充值 URL helper | UNVERIFIED | S:router/api-router.go; external service unknown；仅记录 URL 传 token，非新 gateway 入口 |


### 3.4 中继、CLI与图像

| ID | 原 method/path | 触发 | 分类 | rc.37候选 / 差异 |
| --- | --- | --- | --- | --- |
| R01 | `GET /v1/models` | group_models/模型发现 | DIRECT_STATIC | S:router/relay-router.go:19-31；直接路由证据；实际组/模型/权限需隔离验收 |
| R02 | `POST /v1/messages` | Native/Claude/模型 test | DIRECT_STATIC | S:router/relay-router.go:90；CLI 附加路径/认证 header 与 SSE 未验收 |
| R03 | `POST /v1/chat/completions` | Native/Grok/模型 test | DIRECT_STATIC | S:router/relay-router.go:98；工具/usage/断流事件未验收 |
| R04 | `POST /v1/responses` | Native/Responses/模型 test | DIRECT_STATIC | S:pkg/jsplugin/routing.go:81-85; S:router/task-plugin-protocol-router.go:13-36; S:router/main.go:19；不是缺失；driver/channel/model 能力未知 |
| R05 | `POST /responses (managed Codex base root)` | managed Codex CLI root 假设 | MISSING_TAG | S:router/relay-router.go; S:pkg/jsplugin/routing.go:81-85；root alias 未定位；真实CLI版本追加方式/反代未知 |
| R06 | `GET /models (managed Codex base root)` | managed Codex CLI root 假设 | MISSING_TAG | S:router/relay-router.go:19-31；同 R05，不能断言所有 Codex 必败 |
| R07 | `POST /v1/images/generations; /v1/images/edits` | 图像同步 fallback | DIRECT_STATIC | S:router/relay-router.go:116-121；generation JSON/edit multipart；图片能力/stream/返回扩展未验证 |
| R08 | `POST /v1/images/generations/async; /v1/images/edits/async` | 图像异步优先 | MISSING_TAG | git grep tag router/controller/pkg/jsplugin: no matching async route located；保留 AsyncUnavailable fallback，不把其他 video/task 协议当图像接口 |
| R09 | `GET /v1/images/tasks/{id}` | 图像任务轮询 | MISSING_TAG | same fixed-tag path search as R08；task owner/生命周期/404 TaskLost 未证服务端等价 |
| R10 | `GET {image-result-storage-url}` | 图像结果下载到本地 | UNVERIFIED | Not a fixed New API path；URL/重定向/授权范围待核；不自动携带账号/model key |


## 4. 请求、DTO和源码逐项索引

账户请求默认JSON；GET无body。账户GET/POST以account-access表示Bearer账户access token；refresh-body只指JSON refresh_token，code-verifier只指一次性code + PKCE verifier。pay使用独立鉴权规则，见第7节；model-key不能替换账户鉴权。

| ID | 鉴权语义 | 请求body（示例） | 返回DTO/解析 | 客户端来源 |
| --- | --- | --- | --- | --- |
| A01 | account-access | 无body / 请求由路径参数或调用者构造 | `User` | C:crates/sub2api/src/client.rs:656; C:src/app/cloud_account.rs:294,508 |
| A02 | account-access | 无body / 请求由路径参数或调用者构造 | `Vec<Group>` | C:crates/sub2api/src/client.rs:661; C:src/app/cloud_account.rs:719 |
| A03 | account-access | 无body / 请求由路径参数或调用者构造 | `Vec<SubscriptionProgress>` | C:crates/sub2api/src/client.rs:667; C:crates/sub2api/src/lib.rs:428; C:src/app/plans_page.rs:130 |
| A04 | account-access | 无body / 请求由路径参数或调用者构造 | `Paginated<ApiKey>` | C:crates/sub2api/src/client.rs:673; C:crates/sub2api/src/lib.rs:214-241 |
| A05 | account-access | `{"name":"fixture-client-key","group_id":101}` | `ApiKey` | C:crates/sub2api/src/client.rs:679; C:crates/sub2api/src/lib.rs:226,303 |
| A06 | refresh-body | `{"refresh_token":"FIXTURE_ONLY_ACCOUNT_REFRESH"}` | `TokenPair` | C:crates/sub2api/src/client.rs:694; C:crates/sub2api/src/lib.rs:148-207 |
| A07 | code-verifier | `{"code":"FIXTURE_ONLY_ONE_TIME_CODE","code_verifier":"FIXTURE_ONLY_VERIFIER"}` | `DesktopSession` | C:crates/sub2api/src/client.rs:705; C:crates/sub2api/src/auth.rs:751-755 |
| A08 | refresh-body | `{"refresh_token":"FIXTURE_ONLY_ACCOUNT_REFRESH"}` | `serde_json::Value` | C:crates/sub2api/src/client.rs:715; C:src/app/cloud_account.rs:1023-1026 |
| A09 | account-access | 无body / 请求由路径参数或调用者构造 | `ModelCatalog` | C:crates/sub2api/src/client.rs:725; C:src/app/model_plaza.rs:242 |
| A10 | account-access | 无body / 请求由路径参数或调用者构造 | `Vec<raw-group-status>` | C:crates/sub2api/src/client.rs:420-453,730; C:src/app/model_plaza.rs:245; C:src/app/cloud_failover.rs:55 |
| A11 | account-access | 无body / 请求由路径参数或调用者构造 | `UsageStats` | C:crates/sub2api/src/client.rs:736; C:src/app/cloud_usage.rs:91 |
| A12 | account-access | 无body / 请求由路径参数或调用者构造 | `Paginated<UsageLog>` | C:crates/sub2api/src/client.rs:741-758; C:src/app/cloud_usage.rs:92 |
| A13 | account-access | `{"code":"FIXTURE_ONLY_REDEEM_CODE"}` | `RedeemResult` | C:crates/sub2api/src/client.rs:761; C:src/app/cloud_account.rs:766 |
| A14 | account-access | 无body / 请求由路径参数或调用者构造 | `ReferralInfo` | C:crates/sub2api/src/client.rs:770; C:src/app/cloud_account.rs:720 |
| A15 | account-access | 无body / 请求由路径参数或调用者构造 | `Vec<Announcement>` | C:crates/sub2api/src/client.rs:775; C:src/app/announcements.rs:71 |
| A16 | account-access | `{}` | `serde_json::Value` | C:crates/sub2api/src/client.rs:780; C:src/app/announcements.rs:145 |
| P01 | pay-account-read | 无body / 请求由路径参数或调用者构造 | `PayOrdersContext` | C:crates/sub2api/src/pay.rs:529-550; C:src/app/cloud_pay.rs:198 |
| P02 | pay-account-read | 无body / 请求由路径参数或调用者构造 | `PayUserConfig` | C:crates/sub2api/src/pay.rs:552-604 |
| P03 | pay-account-read | 无body / 请求由路径参数或调用者构造 | `PayPlans` | C:crates/sub2api/src/pay.rs:609-625; C:src/app/plans_page.rs:128 |
| P04 | pay-account-body | `{"token":"FIXTURE_ONLY_ACCOUNT_ACCESS","amount":2,"payment_type":"fixture-method","is_mobile":false}` | `PayOrder` | C:crates/sub2api/src/pay.rs:223-239,629-648; C:src/app/cloud_pay.rs:331 |
| P05 | order-status-token | 无body / 请求由路径参数或调用者构造 | `OrderStatus` | C:crates/sub2api/src/pay.rs:653-662; C:src/app/cloud_pay.rs:464 |
| P06 | pay-account-body | `{"token":"FIXTURE_ONLY_ACCOUNT_ACCESS"}` | `serde_json::Value` | C:crates/sub2api/src/pay.rs:666-674; C:src/app/cloud_pay.rs:575 |
| B01 | browser-login | 无body / 请求由路径参数或调用者构造 | `browser-page` | C:crates/sub2api/src/auth.rs:614-631; C:src/app/cloud_account.rs:362-373 |
| B02 | local-login-delivery | 无body / 请求由路径参数或调用者构造 | `code-or-legacy-session` | C:crates/sub2api/src/auth.rs:479-599,668-693 |
| B03 | browser-pay-account | 无body / 请求由路径参数或调用者构造 | `browser-page` | C:crates/sub2api/src/client.rs:801-807; C:crates/sub2api/src/pay.rs:716 |
| R01 | model-key | 无body / 请求由路径参数或调用者构造 | `OpenAIModels` | C:crates/sub2api/src/lib.rs:328-346 |
| R02 | model-key | 无body / 请求由路径参数或调用者构造 | `Anthropic JSON/SSE` | C:crates/sub2api/src/global_config/claude.rs; C:crates/sub2api/src/model_test.rs:47-98 |
| R03 | model-key | 无body / 请求由路径参数或调用者构造 | `OpenAI Chat JSON/SSE` | C:crates/sub2api/src/gateway.rs:76-97; C:crates/sub2api/src/model_test.rs:47-98 |
| R04 | model-key | 无body / 请求由路径参数或调用者构造 | `Responses JSON/SSE` | C:crates/sub2api/src/model_test.rs:47-98; C:crates/sub2api/src/global_config/native.rs:180-185 |
| R05 | model-key | 无body / 请求由路径参数或调用者构造 | `Responses JSON/SSE` | C:crates/sub2api/src/global_config/codex.rs:64-73,418-447 |
| R06 | model-key | 无body / 请求由路径参数或调用者构造 | `OpenAIModels` | C:crates/sub2api/src/global_config/codex.rs:64-73 |
| R07 | model-key | 无body / 请求由路径参数或调用者构造 | `Image JSON/SSE` | C:crates/sub2api/src/images.rs:648-703,809-827 |
| R08 | model-key | 无body / 请求由路径参数或调用者构造 | `Image task id` | C:crates/sub2api/src/images.rs:707-725 |
| R09 | model-key | 无body / 请求由路径参数或调用者构造 | `Image task state` | C:crates/sub2api/src/images.rs:736-803 |
| R10 | none | download bytes | `image bytes` | C:crates/sub2api/src/images.rs:892-912 |


### 4.1 冻结原wire DTO（32种）

以下是**真实原客户端Rust wire字段**，非为New API随意补出的DTO。String为JSON string；i64/u64为有符号/无符号整数；f64为JSON number；bool为布尔；Vec<T>为数组；Option<T>允许缺失/null；嵌套类型按此表展开。价格的Option<f64>代表未知/不存在可保持null，不能换成0。

每字段的缺失默认、null_to_default、lenient_strings与Rust名见client-dto-v1.json。只有标记null_to_default的容器接受显式null转默认，不应把所有数字/字符串null都当默认。features/supportedModelScopes原lenient_strings可从string或{text}数组提取、trim并跳过无效项；ValidityUnit只认week/month/day，未知按原serde(other)落day。这些是原容错记录，不是“服务器已有这些业务值”的证据。目标required code/strict refresh优先于下表原default记录。

| 原DTO | wire字段 : Rust类型 | 固定客户端来源 |
| --- | --- | --- |
| `Envelope` | `code: i64`; `message: String`; `reason: Option<String>`; `data: Option<T>` | C:crates/sub2api/src/client.rs:15 |
| `Paginated` | `items: Vec<T>`; `total: i64` | C:crates/sub2api/src/client.rs:27 |
| `User` | `id: i64`; `email: String`; `username: String`; `role: String`; `balance: f64`; `status: String`; `allowed_groups: Vec<i64>` | C:crates/sub2api/src/client.rs:53 |
| `Group` | `id: i64`; `name: String`; `description: String`; `platform: String`; `rate_multiplier: f64`; `status: String`; `subscription_type: String`; `daily_limit_usd: Option<f64>`; `weekly_limit_usd: Option<f64>`; `monthly_limit_usd: Option<f64>` | C:crates/sub2api/src/client.rs:72 |
| `UserSubscription` | `id: i64`; `group_id: i64`; `starts_at: String`; `expires_at: String`; `status: String`; `group: Option<Group>` | C:crates/sub2api/src/client.rs:107 |
| `SubscriptionWindow` | `limit_usd: f64`; `used_usd: f64`; `remaining_usd: f64`; `percentage: f64`; `resets_in_seconds: i64` | C:crates/sub2api/src/client.rs:125 |
| `SubscriptionUsage` | `group_name: String`; `expires_at: String`; `expires_in_days: i64`; `daily: Option<SubscriptionWindow>`; `weekly: Option<SubscriptionWindow>`; `monthly: Option<SubscriptionWindow>` | C:crates/sub2api/src/client.rs:142 |
| `SubscriptionProgress` | `subscription: UserSubscription`; `progress: Option<SubscriptionUsage>` | C:crates/sub2api/src/client.rs:159 |
| `ApiKey` | `id: i64`; `key: String`; `name: String`; `group_id: Option<i64>`; `status: String` | C:crates/sub2api/src/client.rs:211 |
| `Price` | `input_per_mtok_usd: Option<f64>`; `output_per_mtok_usd: Option<f64>`; `cache_write_per_mtok_usd: Option<f64>`; `cache_read_per_mtok_usd: Option<f64>`; `per_request_usd: Option<f64>`; `per_image_usd: Option<f64>`; `source: String`; `has_reference: bool` | C:crates/sub2api/src/client.rs:228 |
| `Comparison` | `savings_percent: Option<f64>`; `is_cheaper_than_official: bool` | C:crates/sub2api/src/client.rs:250 |
| `GroupRef` | `id: i64`; `name: String`; `rate_multiplier: f64`; `rate_source: String` | C:crates/sub2api/src/client.rs:259 |
| `PriceInterval` | `min_tokens: i64`; `max_tokens: Option<i64>`; `tier_label: String`; `input_per_mtok_usd: Option<f64>`; `output_per_mtok_usd: Option<f64>`; `cache_write_per_mtok_usd: Option<f64>`; `cache_read_per_mtok_usd: Option<f64>`; `per_request_usd: Option<f64>`; `per_image_usd: Option<f64>` | C:crates/sub2api/src/client.rs:273 |
| `PricingDetails` | `supports_prompt_caching: bool`; `has_long_context_multiplier: bool`; `long_context_input_threshold: i64`; `intervals: Vec<PriceInterval>`; `media_tiers: Vec<MediaTier>`; `media_unit: String` | C:crates/sub2api/src/client.rs:296 |
| `MediaTier` | `tier: String`; `official_usd: Option<f64>`; `effective_usd: Option<f64>`; `is_default_tier: bool` | C:crates/sub2api/src/client.rs:316 |
| `GroupCompanion` | `group: GroupRef`; `effective_pricing_usd: Price`; `comparison: Comparison` | C:crates/sub2api/src/client.rs:329 |
| `ModelCatalogItem` | `model: String`; `display_name: String`; `platform: String`; `billing_mode: String`; `best_group: GroupRef`; `available_group_count: i64`; `official_pricing: Price`; `effective_pricing_usd: Price`; `comparison: Comparison`; `pricing_details: PricingDetails`; `other_groups: Vec<GroupCompanion>`; `context_window: Option<u64>` | C:crates/sub2api/src/client.rs:342 |
| `CatalogSummary` | `total_models: i64`; `token_models: i64`; `non_token_models: i64`; `max_savings_percent: f64` | C:crates/sub2api/src/client.rs:374 |
| `ModelCatalog` | `items: Vec<ModelCatalogItem>`; `summary: Option<CatalogSummary>` | C:crates/sub2api/src/client.rs:386 |
| `RedeemResult` | `message: String`; `value: f64`; `new_balance: Option<f64>` | C:crates/sub2api/src/client.rs:458 |
| `ReferralStats` | `total_referrals: i64` | C:crates/sub2api/src/client.rs:468 |
| `ReferralInfo` | `referral_code: String`; `referral_link: String`; `stats: ReferralStats` | C:crates/sub2api/src/client.rs:475 |
| `Announcement` | `id: i64`; `title: String`; `content: String`; `read_at: Option<String>`; `created_at: Option<String>` | C:crates/sub2api/src/client.rs:486 |
| `UsageStats` | `total_requests: i64`; `total_input_tokens: i64`; `total_output_tokens: i64`; `total_cache_tokens: i64`; `total_tokens: i64`; `total_cost: f64`; `total_actual_cost: f64`; `average_duration_ms: f64` | C:crates/sub2api/src/client.rs:515 |
| `UsageLog` | `id: i64`; `model: String`; `input_tokens: i64`; `output_tokens: i64`; `cache_creation_tokens: i64`; `cache_read_tokens: i64`; `total_cost: f64`; `actual_cost: f64`; `stream: Option<bool>`; `duration_ms: i64`; `first_token_ms: Option<i64>`; `rate_multiplier: f64`; `long_context_billing_applied: bool`; `image_count: i64`; `request_type: Option<String>`; `created_at: String`; `group: Option<Group>` | C:crates/sub2api/src/client.rs:536 |
| `TokenPair` | `access_token: String`; `refresh_token: String`; `expires_in: i64` | C:crates/sub2api/src/client.rs:585 |
| `DesktopSession` | `access_token: String`; `refresh_token: String`; `expires_in: i64`; `api_key: Option<String>`; `claude_api_key: Option<String>`; `codex_api_key: Option<String>` | C:crates/sub2api/src/client.rs:598 |
| `MethodLimit` | `available: bool`; `remaining: Option<f64>`; `singleMin: Option<f64>`; `singleMax: Option<f64>`; `feeRate: Option<f64>` | C:crates/sub2api/src/pay.rs:30 |
| `PlanLimits` | `daily_limit_usd: Option<f64>`; `weekly_limit_usd: Option<f64>`; `monthly_limit_usd: Option<f64>` | C:crates/sub2api/src/pay.rs:129 |
| `SubscriptionPlan` | `id: String`; `groupId: i64`; `groupName: Option<String>`; `name: String`; `description: Option<String>`; `price: f64`; `originalPrice: Option<f64>`; `validityDays: i64`; `validityUnit: ValidityUnit`; `features: Vec<String>`; `productName: Option<String>`; `platform: Option<String>`; `rateMultiplier: Option<f64>`; `limits: Option<PlanLimits>`; `defaultMappedModel: Option<String>`; `supportedModelScopes: Vec<String>` | C:crates/sub2api/src/pay.rs:142 |
| `PayOrder` | `orderId: String`; `amount: f64`; `payAmount: Option<f64>`; `status: String`; `paymentType: String`; `payUrl: Option<String>`; `qrCode: Option<String>`; `clientSecret: Option<String>`; `expiresAt: String`; `statusAccessToken: String` | C:crates/sub2api/src/pay.rs:345 |
| `OrderStatus` | `id: String`; `status: String`; `expiresAt: String`; `paymentSuccess: bool`; `rechargeSuccess: bool`; `rechargeStatus: String`; `failedReason: Option<String>` | C:crates/sub2api/src/pay.rs:373 |


### 4.2 动态JSON/非struct形状（不得用占位类型掩盖字段）

- A10 GroupStatusItem的原归一化接受flat或{summary,group}。group_id按顶层→summary.group_id→group.id；group_name按顶层→group.name→summary.group_name；latest_status/stable_status按顶层→summary；latency_ms按顶层→summary；availability_24h或availability24、availability_7d或availability7d只在顶层取。有效状态优先非空stable_status，否则latest_status。可选测量缺失保持None，不能捏造24h/7d正常率。C:client.rs:394–453。
- P01 PayOrdersContext并非Rust wire struct：消费user.id（正整数）、user.displayName / user.username / user.email、user.balance、summary.pending；P02 PayUserConfig消费config.enabledPaymentTypes、methodLimits、minAmount、maxAmount、maxPendingOrders、balanceCreditCnyPerUsd、stripePublishableKey非空与balanceDisabled。原PayConfig是两端点组装的内部DTO，原fallback min=1/max=1000/maxPending=3只代表客户端旧默认，不证明新部署政策。C:pay.rs:529–604。
- P03 PayPlans是{plans:[SubscriptionPlan]}，原客户端跳过无法解码、id空或groupId<=0的条目；P04套餐请求除token/payment_type/is_mobile外带order_type:"subscription"、plan_id与正amount，充值请求amount是USD余额入账数，套餐price展示为CNY，不能混算。详见pay-golden.json。C:pay.rs:223–239,609–648。
- R01/R06模型发现消费OpenAI风格{data:[{id:String}]}，列出不等于模型可调用。模型探测R02 {model,max_tokens:1,messages:[{role:"user",content:"hi"}]} + anthropic-version/x-api-key；R03使用Bearer与messages/stream:false/max_tokens，仅当400明确要求max_completion_tokens才原有探测重试；R04 {model,input:"hi",max_output_tokens:16} + Bearer。真正对话/工具/SSE请求由provider/CLI构造，不由账户DTO解析。C:lib.rs:328–346；C:model_test.rs:17–119。
- R07/R08 generation为JSON，edit为multipart；model/prompt/n必带，size/quality/background/output_format等按格式选用，参考图为multipart image[]，stream/response_format按模型决定。同步响应消费{data:[{b64_json或url,revised_prompt?}]}或图像SSE；async submit消费id或task_id；poll消费status（processing/queued/running/failed/completed）、http_status/error、result.data或image_url。空data/无有效图像不应报告生成完成。C:images.rs:510–620,648–827。
- 本轮golden主要证明账户、支付和上述边界的**合成形状**，不包含全供应商SSE排序、完整多模态流或CLI实际HTTP抓包；这项覆盖缺口明确保留。


## 5. rc.37 真实wire形状与映射禁止项

rc.37的普通账户/API多数是{success:bool,message?:String,data?:T}，不是原/api/v1数字code envelope。下面是**源码字段形状**；[rc37-golden.json](fixtures/rc37-golden.json)仅为这些字段的合成selected projections，非真实抓包、不保证每字段对所有请求可见。

| rc.37路径/操作 | 真实关键字段 | 与原契约差异 / 来源 |
| --- | --- | --- |
| GET /api/user/self | data.id/username/display_name/email；role/status为整数；group为String；quota/used_quota/request_count/aff_code/aff_count等 | 无原balance:USD与allowed_groups:[i64]；C User.role/status为String，native数值不能直接解。S:controller/user.go:489–520 |
| GET /api/user/self/groups | data为group-name键对象；每组{ratio,desc}；auto.ratio为字符串“自动” | 不可强解所有ratio:f64，或以枚举顺序/hash生成id；platform/订阅窗口不是同义字段。S:controller/group.go:26–52 |
| GET /api/subscription/self | data.{billing_preference,subscriptions,all_subscriptions}；元素{subscription:{id,user_id,plan_id,status,start_time,end_time,amount_total,amount_used,next_reset_time,...}} | 单一配额/reset不等于原progress的同时daily/weekly/monthly USD窗口；upgrade_group也不是三窗口。S:controller/subscription.go:49–74；S:model/subscription.go:253–297 |
| GET /api/token/ | data.{page,page_size,total,items:[{id,name,key,status,group,remain_quota,used_quota,expired_time,unlimited_quota,...}]} | key是mask；group为String、status为数值；原列表只有第一页50。S:controller/token.go:55–69,130–141；S:model/token.go:63–81 |
| POST /api/token/ | 请求为Token字段，如name/group/remain_quota/expired_time/unlimited_quota等；成功{success:true,message:""} | 成功无id/key/data；原create_key必须得到ApiKey，不能造id=0/猜latest。S:controller/token.go:278–358 |
| POST /api/token/:id/key | 成功data.{key:String}；GetTokenByIds(id,userId)验证所属账户 | 需要显式授权取明文；GetFullKey不承诺sk-前缀，不擅自加前缀。mask不能进入CLI或relay。S:controller/token.go:188–205；S:model/token.go:63–81 |
| POST /api/user/auth/refresh | 读new_api_refresh cookie，X-Auth-Session可选；成功data.{access_token,token_type,access_expires_at,user,session}，cookie轮换 | access_expires_at绝对秒；body无refresh_token，不能解成TokenPair。不在client转换认证。S:controller/auth_session.go:17–44 |
| POST /api/user/auth/logout | native refresh cookie或native access/SID注销；成功有分支无data | 账户session revoke不等于全部模型key revoke，不自动变成原refresh-body协议。S:controller/auth_session.go:47–95 |
| GET /api/pricing | data:[Pricing]；**顶层**vendors/group_ratio/usable_group/supported_endpoint/auto_groups/pricing_version | 不只取data丢其余元数据；不等于ModelCatalog.items/summary。S:controller/pricing.go:38–76 |
| Pricing item | model_name/quota_type/model_ratio/model_price/owner_by/completion_ratio，cache_ratio/create_cache_ratio/image_ratio等可选；enable_groups/supported_endpoint_types；billing_expr/billing_mode/billing_usage_schema和plugin variants | 未证明official/effective USD价格、savings、context_window、媒体阶梯或最佳组等价；endpoint enum、ratio和表达式不能当固定USD价格。S:model/pricing.go:18–51 |
| GET /api/log/self | data分页；item.created_at Unix秒、model_name/prompt_tokens/completion_tokens/quota/use_time/is_stream/group/other | use_time单位秒；other为JSON字符串且普通用户可见字段经过filter；原created_at:String/duration_ms需转换。**self id重写成startIdx+i+1的展示序号，不是稳定DB主键**。S:model/log.go:59–80,110–122,560–605 |
| log.other | 可含cache_tokens/cache_creation_tokens/group_ratio/frt等；frt毫秒 | 这些字段有源码来源，但provider/日志类型条件性，不能承诺所有日志都有；缺失不等于真实0。S:service/log_info_generate.go:97–107,280–297；S:model/log_other.go |
| GET /api/log/self/stat | data.{quota,rpm,tpm} | 不能充当原UsageStats八项总计；actual_cost/时区/期间/平均耗时未证。S:controller/log.go:130–154 |
| POST /api/user/topup | 请求{key:String}；成功data为兑换quota标量；受payment compliance gate约束 | 原请求{code}、响应RedeemResult对象；quota单位/后读余额须权威配置与账户来源。S:controller/user.go:1190–1192,1235–1265 |
| GET /api/user/aff | data为邀请code标量；self提供aff_count | referral_code/计数可组合；referral_link的origin/path未证明。S:controller/user.go:437–457,489–520 |
| GET /api/notice | data为全局字符串 | 无Announcement集合id/title/created_at/read_at与账户已读写入；不生成假的已读成功。S:controller/misc.go:179–183 |

角色/状态固定常量证据：S:common/constants.go，UserRole common=1/admin=10/root=100；用户enabled=1/disabled=2；模型token状态enabled=1/disabled=2/expired=3/exhausted=4。它们不授权UI扩大到管理端，也不能不经决策把所有状态翻成active。QuotaPerUnit源码默认500000但可配置（S:common/utils.go）；这不是可硬编码的USD换算保证，余额/售价/实际成本必须由部署权威口径与计费配置确认。

## 6. 身份、endpoint与模型key边界

1. **保留原认证交互，不原地替换成New API登录。** 原B01浏览器/auth/paseo携endpoint、loopback redirect_to、S256 challenge；端口不可用走粘贴code（无redirect_to）。A07用code+verifier换DesktopSession；legacy fragment/session交付只是原行为记录，不许可扩展新绕过通道。loopback为127.0.0.1临时端口；Origin/endpoint/attempt绑定、一次性code TTL/PKCE、replay/失败清理需安全owner核验。C:auth.rs:479–599,614–631,668–693,751–755。
2. **账户access/refresh、native dashboard access/PAT、模型key、order status token分离。** S:middleware/auth.go:158–186的UserAuth先校验native dashboard access/session，再走管理PAT ValidateAccessToken；PAT无浏览器SID。它不是模型key也不是原desktop session桥。本任务不要求用户提供管理员PAT，不拿relay key访问账户，不把native cookie放进原TokenPair。
3. **native refresh仅作为不兼容证据。** S:service/auth_session.go:16,33–49,308–325：cookie名new_api_refresh，Path=/api/user/auth，HttpOnly，SameSite=Strict，Secure配置驱动；session包含sid/current/login_method/ip/user_agent/created_at/last_active_at/expires_at。若既有桥/T007要兼容原refresh body，cookie/native session绑定与refresh rotation须由server owner设计，绝非只减时间戳或改Nginx路径。
4. **model key是可调用明文，不是列表mask。** 首先完整列出普通用户自己的keys并绑定稳定group，再显式按所有权取key；create无返回id的问题必须由已批准桥或可靠关联解决，不能以name/latest/首条猜测并发创建结果。key仅交付该组对应relay/CLI配置；不进入错误body/UI明文/fixtures实际秘密。
5. **原account endpoint与gateway origin分开。** account用/api/v1，relay在gateway用/v1（Anthropic/Claude根base、OpenAI/Grok versioned base）。改托管入口URL不自动迁移已保存Credentials.endpoint。client.tsyqapi.top等拟定入口须由配置owner单独确认，不当作已验证relay/pay/update同源。C:gateway.rs；C:global_config/mod.rs。
6. **CLI边界保持原方案。** Codex managed base为根路径，假设/responses与/models；custom为/v1。tag已注册/v1/responses（S:pkg/jsplugin/routing.go:81–85、task-plugin-protocol-router.go:13–36、router/main.go:19），不能误报缺失；root alias未定位且CLI版本/反代追加方式未知，不推断所有Codex必失败。Claude/Grok/Native分别遵守原base生成；OpenCode/Pi原custom-only，不默认自动云接管。不扩大为所有CLI全局配置迁移。
7. **本地状态不等于服务器会话。** C:lib.rs与cloud_account.rs里的session_id是后台结果generation guard，不当服务器SID。原凭据是本地JSON，Unix chmod失败被忽略，Windows ACL/加密未核；未读取任何真实凭据。注销清理本地并best-effort调用远端，不保证所有key吊销、所有CLI停用。本地聊天/工作区/转录无本次云同步授权。


## 7. 错误、分页、支付与超时语义

### 7.1 错误分层（不把格式错误当成功或强行注销）

- transport/curl/TLS/超时是可重试读取故障，不是账户撤销证据。原账户HTTP非2xx在Response.json先生成ApiError；HTTP2xx再要求code并解DTO。HTTP200+code非0为业务拒绝；code=0但无data/null data仍失败。原非2xx无code时ApiError用HTTP状态兜底，这与成功Envelope.code.required是不同路径，不能混为“允许缺code成功”。C:http.rs:38–102；C:client.rs:827–845。
- 原is_auth_rejection判据：HTTP401/403，或reason为REFRESH_TOKEN_INVALID / REFRESH_TOKEN_EXPIRED / REFRESH_TOKEN_REUSED / TOKEN_REVOKED / SESSION_BINDING_MISMATCH / USER_NOT_ACTIVE。普通429、5xx、解析错误本身不是该判据；应保留已有读取状态/错误并允许重试，不能默认清空账户。此账户规则不移植到模型请求403去注销账户。
- native auth错误的reason/status有其自身含义，只作为错误形状证据；native成功仍不能通过严格数字envelope。新native adapter如果未来被批准，必须显式解success=false与message/reason，而非补code=0。
- 本轮JSON解析诊断不得echo原始body。原ApiError的服务端message/error回显与原非2xx body fallback也是安全核验点；本契约的Bun sanitizedParse只测离线参考函数，**不证明所有production error/log路径已脱敏**。未知服务端message、URL query、pay order token、key或自定义provider body仍需安全owner核验，不把fixture无secret当生产安全已通过。
- 网络读取可以明确重试；创建key、下单、兑换、取消等写操作不得因超时盲目重放或伪造成功，幂等/回执/重放策略留给服务端owner。

### 7.2 分页与筛选

| 项目 | 原客户端 | rc.37 / 最小映射要求 |
| --- | --- | --- |
| key列表 | page=1&page_size=50；Paginated<ApiKey>{items,total}；原只取首50 | /api/token/?p=1&page_size=50；必须完整遍历/检测重复或停滞，不能把第一页当全部；取明文是另一步 |
| 用量列表 | page/page_size，model百分号编码、group_id数值；页为1-based | /api/log/self使用p/page_size、model_name、group字符串；通过权威映射转换group_id，保留筛选，不能静默丢筛选 |
| native PageInfo | 原只消费items/total | data包含page/page_size/total/items；common/page_info.go:41–81使用p而非page；兼容ps/size；默认ItemsPerPage=10，大于100截100；不声称负数被可靠clamp |
| log时间 | 原period=today/week/month；原日志created_at:String | native start_timestamp/end_timestamp为Unix秒；时区/周起点/区间端点/日志类型需决策；model_name含%走wildcard，否则明确匹配（model/log.go:19–30），参数映射不能无意把原字面量变通配搜索 |
| log身份与排序 | 原UsageLog.id:i64 | self返回的id是页位置展示号；普通DB按id desc，ClickHouse按created_at/request_id desc。不能拿展示id做跨页稳定dedupe或永久标识；request_id可用性/最终身份策略须owner确认 |
| total与完整性 | 原total:i64，原缺省/部分null容忍只属解码规则 | self Count源码有Limit(logSearchCountLimit=10000).Count；实际数据库count-limit/并发分页一致性未测试，不能保证全部历史或假定上限语义 |

建议的未来遍历策略须验证1-based正页/正size、合理total、按真实key id检查重复、未达total却空页/停滞则报不完整，并设最大页数/取消/会话generation保护；这是边界建议，不声称client目前已实现。fixture的collectPageIds仅模拟固定合成页，不能证明live并发一致性或日志count完整性。

### 7.3 /pay 是独立 plain JSON 契约

所有Pxx成功是**plain JSON，非账户数字envelope**；不要强行共用strictEnvelope。失败由HTTP非2xx与{error,message,code}的pay错误字段解析，code可为String。请求追加lang并设置Accept-Language；原PayClient注释lang为zh/en/ja的bare tag，golden中的zh-CN仅合成参数例，不证明服务端locale支持。

- P01/P02/P03首次GET使用账户access Bearer；**仅400/401一次**退回query token，不因403/429/5xx/解析失败任意重试，不把query token写日志。B03浏览器/pay URL原有token参数，只记录兼容与泄露风险，不新增新gateway入口。
- P01必须得到user.id>0才调用P02；P02构成PayConfig。原字段缺省容忍可能把未证数据掩盖为默认，native topup info不能未经验证替代这些来源。
- P04请求body是账户access token；返回orderId和statusAccessToken都必非空。P05仅用**订单独有statusAccessToken**查询，不发送账户Bearer、不换成model key；P06取消用账户token body。
- 充值amount=USD余额入账；套餐price/originalPrice是CNY，PlanLimits是snake_case USD窗口。真实汇率/费率/可用方式/余额入账与订单所有权均未证，不能从native pay路径名称推导等价。
- 原OrderStatus.is_terminal只对FAILED/CANCELLED/EXPIRED/COMPLETED（不区分大小写）停止轮询；is_settled是rechargeSuccess或status=completed。**PAID/paymentSuccess不必然表示充值到账**。显示/刷新余额依据到账事实，取消竞态与幂等未证，不先造COMPLETED。C:pay.rs:373–414。

### 7.4 超时与UI调用位置

| 调用族 | 原超时证据 |
| --- | --- |
| 账户Axx、pay Pxx | 默认curl请求20s；C:http.rs:29。没有把它提升为服务端SLA |
| R01模型列表 | 15s；C:lib.rs:328–346 |
| R02–R04最小模型探测 | 每次30s；Chat满足明确400错误时最多第二次；C:model_test.rs:17–119 |
| R07图像sync / R08 async submit / R09 poll / R10 download | 分别960s / 180s / 30s / 300s；C:images.rs超时常量及648–912 |
| B01–B03浏览器/loopback、外部CLI正式流 | 不套账户20s；浏览器、等待登录/取消、CLI/provider streaming的实际生命周期需单独隔离验证 |

所有阻塞HTTP、curl、凭据/文件读写放后台执行，不进render/row builder/测量热路径；结果按原账户session generation guard丢弃过期响应。保留键盘操作/减少动效，不需为本静态任务启动watcher或视觉测试。


## 8. 最小适配位置与逐文件建议（与本轮授权分开）

### 8.1 当前M-003已明确的最小写集

仅C:crates/sub2api/src/client.rs（显式code、TokenPair required字段及非空token/正相对expiry、直接消费六fixture的Rust测试）与C:crates/sub2api/src/http.rs（解析诊断不echo body）。不在这里实施native认证转换、账户数据桥、全量key分页、支付迁移、全局CLI接管或认证重写。严格拒绝证明“不会误当成功”，**不是协议兼容已经实现**。M-002本身只写本文档、fixtures/测试和任务卡，不修改这两生产文件。

### 8.2 待owner决策的协议适配位置

优先保留原浏览器/PKCE交互与数据范围。若现有桥存在，先固定其版本、contract和权威数据再复用；否则由server T007/认证owner评估薄兼容模块，负责desktop exchange、session/cookie/refresh rotation/账户绑定、可靠key create关联、权威组ID/额度/金融数据、公告已读等。M-002不创建第三项目或授权server写入。

只存在路由且协议本来一致的relay直接用，不强套账户envelope。native普通用户数据若需要client侧字段适配，应在crates/sub2api边界内私有native DTO/小mapping模块中显式选择协议，输出既有领域DTO；先确认缺口，不能serde(default)+补code=0跨协议伪造成功。认证/财务/权限决策不放UI或Nginx路径重写里。暂未证数据以明确unknown/失败或已有缓存+错误状态呈现，不未经批准砍原功能，也不承诺功能可用。

### 8.3 未来逐文件候选（**条件性建议，不是本轮写授权/已实现清单**）

| 客户端文件 | 最小候选变更 / 当前边界 | 先决条件 / owner |
| --- | --- | --- |
| crates/sub2api/src/client.rs | 当前严格code/refresh；未来仅在契约批准后调用版本化桥或私有native data mapper，保留原public DTO/业务错误 | M-003当前严格边界；未来API owner签署缺口映射 |
| crates/sub2api/src/http.rs | 当前解析诊断不带body；未来明确各协议错误映射、允许安全reason/status，不泄露query/key/body | 安全owner；不能凭格式错误删除账户 |
| crates/sub2api/src/lib.rs | 未来完整key分页、取明文、按稳定group建group_keys；明确UNKNOWN订阅与session generation、失效处理，不把mask或空key缓存成可用 | T007给可靠create id/所属账户/组映射；非当前授权 |
| crates/sub2api/src/auth.rs | 保持PKCE浏览器/粘贴回调；只在安全审计后补attempt/endpoint/Origin校验与失败清理；不主动换native auth | 认证owner固定桥与TTL/单次/replay策略 |
| crates/sub2api/src/pay.rs | 原plain JSON/Bearer一次fallback/order token分离不动；未来只接已证明原语义的pay bridge | payment owner确认汇率/订单状态/取消/幂等/对账 |
| crates/sub2api/src/gateway.rs | 仅批准后的account/relay origins及root/versioned base归一化，不夹带account token | 部署owner确认relay/proxy、模型/组隔离 |
| crates/sub2api/src/global_config/codex.rs | 若实际CLI/proxy证实，则最小修正managed base为真实路径；不修改CLI用户custom endpoint | CLI版本/最终请求路径隔离证据 |
| crates/sub2api/src/global_config/{claude,grok,native}.rs、mod.rs | 尊重既有credential格式、模型key和各自base；不把账号token导出CLI、不扩大OpenCode/Pi托管范围 | 同格式provider/CLI验收；当前无必要批量改 |
| crates/sub2api/src/model_test.rs | 留在后台；继续协议原样探测、错误区分，不拿models listing当生成/SSE通过 | provider/schema/stream验收 |
| crates/sub2api/src/images.rs | 保留async unavailable→sync fallback；区分task lost/权限/内容政策/限流/到账问题；download不送account/model Bearer | image owner证实async协议、URL/redirect策略；不是其他task/video路由等价 |
| src/app/cloud_account.rs | 接受领域DTO及明确数据错误/unknown；保留本地注销best-effort、旧endpoint提示、账户generation防旧结果回写；不render发网络 | 账户/安全owner；不改认证交互 |
| src/app/cloud_usage.rs | 保留分页/模型/组/period筛选；时间/单位转换与日志稳定身份在边界完成，UI不自行汇总造actual_cost | stats owner确定计费/时间口径与count完整性 |
| src/app/model_plaza.rs | 消费真实enriched catalog与health optional，未知价不显示0价、未知健康不标绿；保持后台加载 | catalog/health owner给权威来源 |
| src/app/cloud_failover.rs | 仅用已证明状态决定可选回退，不用虚构group-health字段触发切组 | health owner、group稳定绑定与key可用性 |
| src/app/announcements.rs | 保留账户公告及已读交互；无来源则明确未支持/错误而非把notice标记账户已读 | announcement owner提供id/created_at/read写入 |
| src/app/plans_page.rs | 原套餐范围/三窗口语义不缩减；已批准计划字段适配在边界做 | subscription/payment owner确认group/窗口/计价 |
| src/app/cloud_pay.rs | 保留配置→下单→订单token轮询/取消→到账刷新链；不把PAID当到账、不在render做I/O | payment owner，退款/竞态/对账测试 |

所有新增模块/候选文件须由主线程在独立M-003写集审查后接纳；其他并行agent负责的品牌/发行等不在这里重写或回滚。缺数据时优先owner决策，不能仅换域名宣称兼容。

## 9. 未证实缺口与验收门槛

| 缺口 | 当前证据与不可作的推论 | 责任/需要的隔离证据 |
| --- | --- | --- |
| 既有/auth/paseo与desktop-session桥 | tag检索未定位；外部桥是否存在UNKNOWN，不写“生产不存在” | T007/认证owner给固定版本、非secret配置概要与协议、PKCE/TTL/replay/绑定测试 |
| native→原账户refresh/logout | cookie/session/绝对expiry与原JSON token pair不等价；本轮仅拒绝误成功 | auth owner签署桥边界与rotation/reuse/revoke/绑定测试；不索要真实token |
| quota↔USD与actual_cost | 默认QuotaPerUnit不是部署保证；原实际成本不等于native quota | billing owner给隔离计费配置与标注单位、请求/退款/订阅口径案例 |
| 稳定group_id及platform/limits | native string group、auto字符串ratio，无可证明数值ID/三窗口metadata | API/subscription owner给稳定可逆映射与版本、窗口/配额来源 |
| key create/分页 | native创建无id/key，list masked；原首50不足 | API owner给并发/重名/归属/幂等案例及>50/>100 key测试；不猜最新 |
| enriched catalog / health | native pricing不是完整ModelCatalog；group-status/latency/24h7d等价未证 | catalog/health owner给字段数据来源、null/unknown规则与范围 |
| 用量与日志 | 原八项stats未完整映射；native self展示id非稳定身份、count-limit/并发完整性未知、other条件性 | stats owner给数据库类型、期间/时区/日志类型/身份及计费一致性测试 |
| 公告/已读/邀请链接 | notice为全局字符串，已读write未定位，referral origin/path未证 | announcement/referral owner提供真实契约与账户隔离测试 |
| /pay全部原链 | rc.37有topup/payment/subscription能力但非原配置/orders/statusAccessToken/cancel证据 | payment owner确认既有pay服务、普通用户测试账户、非生产账与幂等/取消/对账 |
| CLI/providers/图像 | /v1/responses已有静态注册；root alias/driver/SSE/async/下载URL安全未验证 | relay/CLI owner给具体版本、组/模型、最终URL/header/流顺序/限流与fallback隔离证据 |
| 凭据与注销 | 原本地JSON/Unix chmod/Windows ACL、CLI持久key/legacy callback有待审；strict JSON诊断不等于全路径无泄露 | 安全owner确认保存/ACL/撤销/日志脱敏；不读真实凭据、不扩大账户或管理权限 |
| 测试账户与环境 | 没有运行独立实例、真实API请求或真实订单；域名/低配机器不是隔离证明 | 主线程/运维确认普通用户测试账户、独立实例与数据/账隔离、安全控制、回滚窗口，再授权M-006 |

最小功能范围仍为原账户身份/刷新退出、组与订阅、按组可用model key与原CLI路由、原模型目录/状态与用量、兑换/邀请/公告已读、原支付链以及本地会话边界。静态发现缺口不等于默认删掉范围；可发布功能集必须由owner决定和隔离验收，不能以空数组/0值/默认DTO伪造“同步成功”。


## 10. Golden fixtures、共享Rust输入与实际验证范围

所有JSON为人工构造的合成值（FIXTURE_ONLY_*、.invalid地址、合成ID/金额/时间），没有真实secret、真实账户或生产response捕获。Golden在这里指固定参考形状，不是已获server认可的兼容数据。fixtures文件不需credentials/network即可读取。

| 文件 | 用途 |
| --- | --- |
| [account-golden.json](fixtures/account-golden.json) | A01–A16原数字envelope请求/DTO，健康flat/nested与unit响应 |
| [pay-golden.json](fixtures/pay-golden.json) | P01–P06原plain JSON和套餐下单请求，账户/订单token分离 |
| [rc37-golden.json](fixtures/rc37-golden.json) | 14个native selected wire projection；证明结构差异而非真实返回/可用性 |
| [boundary-cases.json](fixtures/boundary-cases.json) | code/refresh非法输入、null容忍、分页停滞、显式组映射、auth错误、pay fallback与状态 |
| native-auth-error.json、envelope-business-error.json、envelope-empty-data.json | 拒绝/error/缺data边界body |
| refresh-empty-refresh-token.json、refresh-negative-expiry.json、refresh-string-expiry.json | 额外refresh拒绝body |

### 10.1 必须保持路径的六个Rust共享body

以下JSON直接是response body，不套fixture描述层；可供Rust include_str!/serde直接消费。主线程报告client.rs已加入frozen_refresh_fixtures_match_the_client_boundary直接使用它们：

| 固定路径（repo-relative） | 预期 |
| --- | --- |
| docs/contracts/fixtures/refresh-valid.json | 接受：code=0、token非空、expires_in=900相对秒 |
| docs/contracts/fixtures/native-refresh-success.json | 拒绝：native success envelope无显式code，且不是TokenPair协议 |
| docs/contracts/fixtures/native-self-success.json | 拒绝：native success无显式code，不能默认解User/TokenPair |
| docs/contracts/fixtures/refresh-missing-fields.json | 拒绝：TokenPair必需字段缺失 |
| docs/contracts/fixtures/refresh-empty-token.json | 拒绝：空白/空access token |
| docs/contracts/fixtures/refresh-nonpositive-expiry.json | 拒绝：expires_in=0（非正relative expiry） |

从crates/sub2api/src/client.rs源文件位置，include_str相对路径为../../../docs/contracts/fixtures/<filename>.json；也可结合CARGO_MANIFEST_DIR定位../../docs/contracts/fixtures。文件名保持与主线程报告一致，本次收尾不改这六文件内容。

### 10.2 Bun离线验证与Rust/runtime的区别

在repo根目录运行：

```powershell
bun test ./docs/contracts/fixtures.test.ts
```

fixtures.test.ts只使用bun:test与本地JSON，**独立离线规格检查**，无生产模块import、无HTTP、无Rust编译或运行。它检查调用ID覆盖/DTO合成值、strict code/refresh参考函数、native拒绝、null/健康归一化、分页停滞、错误分类与pay状态；不能证明Rust/serde与JS完全等价（JS只覆盖safe-integer子集，也不保留整数/浮点JSON token所有区别），不能证明client实际HTTP行为、安全日志、UI、CLI/SSE或真实后端。

2026-10-02本任务实际验证：Bun 1.4.0，76 pass / 0 fail / 236 expect calls（收尾复跑见任务卡）。主线程另报告270项集成离线测试及TS/YAML/Bash/diff检查通过，非本M-002独立测试统计，不作为runtime证据。

**Rust直接消费同fixture，测试已接入是主线程报告；本机PATH没有Rust/cargo，尚未执行Rust/Cargo测试。** 未构建/启动应用、未启动watcher、无视觉测试、无server/生产/真实支付请求。源码路由存在、合成样例和Bun通过均不等于runtime兼容通过。M-002静态交付完成；测试账户/独立环境/认证与数据安全核验和兼容验收仍待owner。
