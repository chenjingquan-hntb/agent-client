# Client Compatibility Audit — 原认证与 New API 静态兼容审计

- 审计日期：**2026-10-02**。
- 状态：**静态代码盘点完成；非 runtime 验收；作为 M-002 兼容矩阵的输入，不代表 M-002 已完成。**
- 写集：仅新增本文件；不修改业务代码、部署决策、计划、任务索引或发布基线。
- 范围：`crates/sub2api`、桌面 cloud 认证/账户数据、credentials、gateway 与 CLI 路由；必要的服务端 tag 代码对照。
- 用户约束：**账号认证沿用原方案，不等于已有 New API 兼容；不强制切换新认证。原数据范围暂保留，不增加管理端。**
- 方法：先读取 AGENTS.md，按客户端认证/数据、CLI 路由、服务端合同分支并行只读检查。本轮不启动 watcher、不构建、不运行视觉测试、不 push、不读取或打印实际用户凭据，不向业务服务器发送验收请求。
- 收敛原则：已观察的源码事实列为 CONFIRMED；部署、桥服务、真实请求及未穷尽细节统一列为 **UNKNOWN**。UNKNOWN 不等于功能缺失，也不等于漏洞。

## 1. 基线、证据及边界

| 对象 | 本轮实际观察 | 审计使用方式 |
| --- | --- | --- |
| Client | `D:\Projects\agent-client`，branch `main`，HEAD `e60ae223687d536d43febf133aca76d5008e9a2b` | 以下客户端相对路径、行号及符号对应本轮读取的代码 |
| Server 当前 checkout | `D:\Projects\agent-server`，branch **develop**，HEAD `cdbd593a807deceee77b9a38beaae2ce6594f2b8` | 不把 develop 名称或新版 API 当作发布基线 |
| Server 真实基线 | tag **`v1.0.0-rc.37`**，commit `385d2dfd10d821b25c8a6766bd16eea248cb1652` | 服务端合同以 **`git show v1.0.0-rc.37:<path>`** 读取；下文 `S:` 均指这个 tag，而非工作区 |
| 两者关系 | `git describe` 为 `v1.0.0-rc.37-1-gcdbd593a`；`git rev-list --left-right --count v1.0.0-rc.37...HEAD` 为 `0 1` | rc.37 是当前 HEAD 的祖先；唯一后续提交为审计/计划/任务文档 |
| API 源码差异 | `git diff v1.0.0-rc.37 HEAD -- router controller middleware model dto service pkg/jsplugin` 无输出 | 仅说明这些已提交目录在两点间无差异；不能证明生产部署相同 |
| 同时存在的其他工作 | 客户端部署/实施计划、M-002 至 M-006 等文档已由主 agent 落盘；两仓库可见其他文档改动 | 均不属于本文件作者写集；不覆盖、不回退、不将它们计为本轮改动 |
| 实际生产部署 | **UNKNOWN** | 未验证镜像、反代、环境变量、数据库或桥服务 |

证据记法：`C:路径:行号（符号）` 为 client；`S:路径:行号（符号）` 为 server **rc.37 tag**。行号用于定位，符号用于后续代码移动后的复核。本文件不代替主 agent 的部署决策、client 整体任务分解或发布基线修复。

## 2. 原认证流程：保留行为，不误认为协议已兼容

### 2.1 浏览器登录与桌面交付

1. 桌面从 `brand::MANAGED_SERVICE_URL` 选择登录 endpoint。该值使用编译期 `option_env!("SUB2API_MANAGED_SERVICE_URL")`，默认 `https://cheaprouter.cc`；不是所有已保存账户 endpoint 的自动迁移开关。证据：`C:crates/sub2api/src/brand.rs:28–50`；`C:src/app/cloud_account.rs:343–400（sign_in_cloud_account）`。
2. `LoginFlow::start` 先绑定 **127.0.0.1 的临时端口**，生成随机 verifier，challenge 为 base64url(SHA256(verifier))，再打开浏览器。登录入口为 **`/auth/paseo`**，参数包括 `endpoint`、`redirect_to=http://127.0.0.1:{port}/callback`、`code_challenge`、`code_challenge_method=S256`。证据：`C:crates/sub2api/src/auth.rs:58,397–416,481–488,614–631`。
3. loopback 不可用时使用 code-only 入口；桌面也允许粘贴登录码或包含交付信息的 URL。代码归一化为大写，去空格/连字符，并限制为 6–32 位 ASCII 字母数字。证据：`C:src/app/cloud_account.rs:343–477`；`C:crates/sub2api/src/auth.rs:710–768`。
4. loopback relay 读取 URL fragment，以 `POST /deliver` 交付；本地处理器接受 code 或 legacy session。code 会携带原 attempt 的 verifier 调用 **`POST /api/v1/auth/desktop-session/exchange`**，JSON 为 `{code,code_verifier}`。legacy 路径接受 fragment 中的 `access_token,refresh_token,expires_in` 及可选 gateway keys。证据：`C:crates/sub2api/src/auth.rs:554–599,642–693,845–864`；`C:crates/sub2api/src/client.rs:705–711`。
5. `Credentials::from_desktop_session` 要求 access/refresh 非空、`expires_in > 0`，将相对有效期转为本地 Unix 到期时间，生成本地 session generation；后台保存后尝试 `me()`。`me()` 失败不撤销已消耗的登录码。证据：`C:crates/sub2api/src/auth.rs:304–336`；`C:src/app/cloud_account.rs:499–575`。

**UNKNOWN：** `/auth/paseo` 桥的实际服务端实现、登录码 TTL/单次使用、服务端 verifier/challenge 校验及实际部署。客户端发送 PKCE 参数，不能单独证明服务端验证完成；在 rc.37 router 中未定位到同名桥，不排除外置服务或反代。

### 2.2 凭据保存、刷新、退出

| 项目 | 已证实客户端行为 | 证据 |
| --- | --- | --- |
| 文件位置 | 默认 `~/.cheaprouter/cloud-account.json`，品牌 data dir 决定目录 | `C:crates/sub2api/src/brand.rs:69–81`；`C:crates/sub2api/src/auth.rs:146–241` |
| 保存字段 | `access_token,refresh_token,expires_at,endpoint`；通用/Claude/Codex gateway key；group/平台绑定；`group_keys,model_routes,image_groups,model_windows,routing_disabled,session_id` | `C:crates/sub2api/src/auth.rs:146–220（Credentials）` |
| 存储形式 | JSON 经 `std::fs::write` 保存；不是源码可证实的系统钥匙串加密存储 | `C:crates/sub2api/src/auth.rs:267–276（write）` |
| 权限处理 | Unix 尝试 chmod 0600，返回错误被忽略；non-Unix 函数为空，实际 Windows ACL **UNKNOWN** | `C:crates/sub2api/src/auth.rs:364–373（restrict_to_owner）` |
| 本地代际 | `session_id` 用于防止旧登录/后台结果覆盖新账户，不是 New API 服务端 SID | `C:crates/sub2api/src/auth.rs:250–264,304–336`；`C:src/app/cloud_account.rs:232–255` |
| 刷新 | 提前约 120 秒；`refresh_if_needed_with` 协调刷新并检查同一 session；发送无 Bearer 的 `{refresh_token}`；刷新返回空 refresh 时保留旧值 | `C:crates/sub2api/src/auth.rs:61,341–353`；`C:crates/sub2api/src/lib.rs:148–207` |
| 退出 | 清本地账户与缓存、撤除 cloud 路由；后台 best-effort 调用原 logout，传 JSON refresh token | `C:src/app/cloud_account.rs:648–695,1023–1026`；`C:crates/sub2api/src/client.rs:715–722` |
| 退出边界 | 不能据此宣称撤销所有 gateway keys 或立即终止所有在运行 CLI/会话；源码明确运行内置 session 仍持有启动时 key，并重应用选项 | `C:src/app/cloud_account.rs:690–695` |

**凭据角色必须分开：** access/refresh 用于账号 API；gateway API key 用于模型中继及 CLI。两者不是可互换的 Bearer 字符串。证据：`C:crates/sub2api/src/client.rs:677–689`；`C:crates/sub2api/src/lib.rs:775–797（gateway_config_with_origin）`。

## 3. 客户端真实账户路由及 DTO

### 3.1 公共合同

`Client::api_url` 固定拼接 **`{endpoint}/api/v1/{path}`**；GET 使用 access-token Bearer，POST 使用 JSON 和可选 Bearer。账户 API 期望 `Envelope<T>={code,message,reason?,data?}`，`code` 缺失默认 0；`unwrap_envelope` 按 code 判断业务失败，并要求非空 data。分页 DTO 是 `{items,total}`。证据：`C:crates/sub2api/src/client.rs:15–35,631–653,827–846`。

因此不能把 New API 的 `success` 响应仅改路径后直接视为兼容：旧解析器不读取 `success`。同时不能断言所有 New API 成功响应都必然解析失败，因为缺失 code 会默认 0；有些默认字段还可能把缺失信息变成空值/零值，掩盖语义丢失。

### 3.2 原账户请求表

下面路径均为完整客户端请求路径；`A` 指账户 access-token Bearer，`—` 指没有此 Bearer。字段中的 `?` 表示可选。

| 方法 / 路径 | 认证与请求字段 | 返回 data | Client 证据 |
| --- | --- | --- | --- |
| GET `/api/v1/auth/me` | A | `User` | `client.rs:656–658` |
| GET `/api/v1/groups/available` | A | `Vec<Group>` | `client.rs:661–663` |
| GET `/api/v1/subscriptions/progress` | A | `Vec<SubscriptionProgress>` | `client.rs:667–669` |
| GET `/api/v1/keys?page=1&page_size=50` | A；固定第一页 50 条 | `Paginated<ApiKey>` | `client.rs:673–675` |
| POST `/api/v1/keys` | A；`{name,group_id?}` | `ApiKey`，含实际 key | `client.rs:679–690` |
| POST `/api/v1/auth/refresh` | —；`{refresh_token}` | `TokenPair` | `client.rs:694–700` |
| POST `/api/v1/auth/desktop-session/exchange` | —；`{code,code_verifier}` | `DesktopSession` | `client.rs:705–711` |
| POST `/api/v1/auth/logout` | —；`{refresh_token}` | 先按 envelope 取得非空 JSON data，再丢弃 | `client.rs:715–722` |
| GET `/api/v1/models/catalog` | A | `ModelCatalog` | `client.rs:725–727` |
| GET `/api/v1/group-status` | A | 原始对象数组，逐项 normalize 为 `GroupStatusItem` | `client.rs:730–733,420–453` |
| GET `/api/v1/usage/stats?period=...` | A；UI 使用 today/week/month | `UsageStats` | `client.rs:736–738`；`src/app/cloud_usage.rs` |
| GET `/api/v1/usage?page=...&page_size=...&model?=...&group_id?=...` | A；页号/大小至少 1，model URL 编码 | `Paginated<UsageLog>` | `client.rs:741–758` |
| POST `/api/v1/redeem` | A；`{code}` | `RedeemResult` | `client.rs:761–767` |
| GET `/api/v1/referral/info` | A | `ReferralInfo` | `client.rs:770–772` |
| GET `/api/v1/announcements` | A | `Vec<Announcement>` | `client.rs:775–777` |
| POST `/api/v1/announcements/{id}/read` | A；`{}` | JSON data | `client.rs:780–787` |

表中 `client.rs` 均为 `crates/sub2api/src/client.rs`，不是 server controller。

### 3.3 DTO 字段与语义依赖

| DTO | 客户端消费的字段 / 单位 | 证据（均 `C:crates/sub2api/src/client.rs`） |
| --- | --- | --- |
| `User` | `id:i64,email,username,role:String,status:String,balance:f64,allowed_groups:Vec<i64>` | 53–67 |
| `Group` | 数值 id；name/description/platform；rate_multiplier；字符串 status/subscription_type；可选 daily/weekly/monthly_limit_usd | 72–96 |
| `UserSubscription` / `SubscriptionProgress` | subscription 的 id/group_id/starts_at/expires_at/status/group；progress 的 group_name/expires_at/expires_in_days 及 daily/weekly/monthly 窗口 | 107–163 |
| `WindowProgress` | `limit_usd,used_usd,remaining_usd,percentage,resets_in_seconds` | 125–136 |
| `ApiKey` | `id,key,name,group_id?,status:String`；key 需要能真正用于中继，不是展示用掩码 | 211–221；`C:crates/sub2api/src/lib.rs:215–232` |
| `TokenPair` / `DesktopSession` | access_token、refresh_token、**相对秒数 expires_in**；session 可额外提供 api_key/claude_api_key/codex_api_key | 585–610 |
| `ModelCatalog` | items、summary；item 的 model/display_name/platform/billing_mode/best_group/available_group_count；official_pricing/effective_pricing_usd/comparison/pricing_details/other_groups/context_window | 228–390 |
| 价格 / 分组引用 | input/output/cache_write/cache_read 的 per_mtok_usd、per_request/per_image_usd、source/has_reference；group 的 id/name/rate_multiplier/rate_source；summary 的模型数及 max_savings_percent | 228–390 |
| `GroupStatusItem` | group_id/name、latest_status/stable_status、latency_ms、availability_24h/7d；存在字段归一化逻辑 | 395–453 |
| `UsageStats` | total_requests、input/output/cache/total_tokens、total_cost/total_actual_cost、average_duration_ms | 515–531 |
| `UsageLog` | id/model；input/output/cache_creation/cache_read_tokens；total_cost/actual_cost；stream/duration_ms/first_token_ms；rate_multiplier/long_context_billing_applied/image_count/request_type/created_at/group | 536–570 |
| `RedeemResult` | message/value/new_balance | 458–464 |
| `ReferralInfo` | referral_code/referral_link/stats.total_referrals | 475–481 |
| `Announcement` | id/title/content（Markdown）/read_at/created_at | 486–497 |

本表记录主要消费字段，不承诺穷尽全部 serde 默认/别名。New API 字段不能因名称近似直接套入这些 DTO；无法确认的单位、时间类型及统计口径为 **UNKNOWN**。

## 4. 原支付中心合同：不能漏掉独立 `/pay` 服务

`PayClient` 拼接 `{endpoint}/pay{path}?lang=...` 并发送 Accept-Language；`pay_json` 在 HTTP 成功后直接解析正文，**不是前述 code-envelope**。`authed_get` 先用账号 Bearer，在 400/401 时退回查询参数 `token=`。证据：`C:crates/sub2api/src/pay.rs:293起,496–525`。

| 请求 | 请求字段 / 鉴权 | 响应或消费字段 | 证据（`C:crates/sub2api/src/pay.rs`） |
| --- | --- | --- | --- |
| GET `/pay/api/orders/my?page=1&page_size=20` | 账号 Bearer，允许上述 fallback | 配置加载消费 user.id、displayName/username/email、balance、summary.pending | 529–550 |
| GET `/pay/api/user?user_id=...` | 同上 | config 的支付 methods/limits、minAmount/maxAmount/maxPendingOrders、balanceCreditCnyPerUsd、stripePublishableKey、balanceDisabled | 552–604 |
| GET `/pay/api/subscription-plans` | 同上 | `{plans:[...]}`；plan 使用 camelCase，含字符串 id、数值 groupId、groupName/name/description、price/originalPrice、validityDays/unit、features/platform/rateMultiplier/limits 等 | 142起、609–625 |
| POST `/pay/api/orders` | JSON `token,amount,payment_type,is_mobile:false`；订阅增加 `order_type:"subscription",plan_id` | `PayOrder`：orderId/amount/payAmount/status/paymentType/payUrl/qrCode/clientSecret/expiresAt/statusAccessToken；要求 orderId 与 status token 非空 | 223–239,345–367,628–648 |
| GET `/pay/api/orders/{id}?access_token=...` | **订单 statusAccessToken**，不是账号 access token | id/status/expiresAt/paymentSuccess/rechargeSuccess/rechargeStatus/failedReason | 373–387,651–662 |
| POST `/pay/api/orders/{id}/cancel` | JSON `{token}`，账号 token | 取消结果 | 665–673 |

原 UI 在后台加载配置/套餐、创建订单、轮询状态及取消：`C:src/app/cloud_pay.rs:163–192,325–331,413,463,560`。代码区分充值额度与支付金额，含 CNY 价格/兑换配置；**实际商户设置、付款结果和对账口径 UNKNOWN**。

另有网页充值 URL `/pay?token=...&theme=...&ui_mode=standalone&lang=...`：`C:crates/sub2api/src/client.rs:801–807`；`C:crates/sub2api/src/pay.rs:716起`。这里只记录 token 可进入 URL 的事实；是否进入日志、历史或其他泄露渠道未验证，不作泄露结论。

## 5. 桌面数据范围及“云”含义

- 启动读取账户 credentials，应用路由并后台刷新账户、details、模型目录；后台结果使用 session/attempt 检查避免覆盖另一登录。证据：`C:src/app/cloud_account.rs:169–203,232–340,518–575,704–739`。
- 用量页后台请求 stats/logs，缓存 TTL 30 秒、每页 20 条，可按模型/组筛选；结果有账户 session 检查。**没有将它描述为已证明具有所有筛选请求的独立 generation guard。** 证据：`C:src/app/cloud_usage.rs:13–16,57–125`。
- 公告后台加载到内存；已读采用本地乐观更新及 best-effort 服务端写回。证据：`C:src/app/announcements.rs:45–97,115–145`。
- 订阅与目录还参与 gateway 分组 key、模型路由、上下文/图片能力缓存刷新。证据：`C:crates/sub2api/src/lib.rs:256起,419起,775–797`；`C:src/app/cloud_subscriptions.rs:73起`。

**本轮确认的原范围**：账户身份/余额、可用组、gateway keys、订阅及窗口进度、模型及价格、组健康、账户用量/日志、充值/套餐订单、兑换、推荐、公告及已读。它不是后台管理范围，不应为了适配新增用户管理、渠道管理或管理权限要求。

**站点账户/账务数据获取不等于聊天云同步。** `StateStore::default_path` 将 debug 数据放在 checkout 的 `temp/app.db`，release 数据放在本机 per-user data directory 的 `app.db`；保存路径实际执行 SQLite 的 session/detail/message 写入。证据：`C:crates/waku-core/src/persistence.rs:847,869–882,1345–1378（StateStore）`；daemon 创建 store 见 `C:crates/waku-daemon/src/main.rs:52–58`。

本轮账户 API 集合没有确认会话上传/下载合同；相关 cloud-sync 文本搜索未命中也不能证明整个应用永不联网。聊天 prompt/上下文会随模型请求送到 gateway；其他 provider/CLI 功能是否另有同步 **UNKNOWN**。因此不得把“账户已接通”写成“聊天历史云同步完成”，也不得反向宣称聊天内容绝不离开本机。

## 6. CLI / 内置 Agent 真实路由

### 6.1 选择规则与配置落点

`desired_routes` 的优先级不统一：Native 每个 slot **custom 优先、cloud fallback**，且存在 native custom 时不混入 cloud 的平台/model key 表；Claude/Codex/Grok 为 **cloud 优先、custom fallback**；OpenCode/Pi **只走 custom**。证据：`C:crates/sub2api/src/global_config/mod.rs:199–268`。

| 客户端 | 真实配置 / 合同 | 证据 |
| --- | --- | --- |
| Native | 原生配置中的 provider_configs/api_base/api_key；由所选 gateway key 和模型路由驱动 | `C:crates/sub2api/src/global_config/native.rs:126–185,286–287` |
| Claude | `~/.claude/settings.json` 环境项 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN；Claude 专用 key 可回退通用 key | `C:crates/sub2api/src/global_config/claude.rs:22–46`；`C:crates/sub2api/src/gateway.rs:47–72` |
| Codex | `~/.codex/config.toml` 的 model_providers.OpenAI；wire_api=responses、requires_openai_auth=false、experimental_bearer_token=**gateway key** | `C:crates/sub2api/src/global_config/codex.rs:68–115` |
| Codex 特别边界 | managed provider_base_url 保留 **root**，custom 使用 OpenAI `/v1` base；当前实现不是向 auth.json 写 cloud OAuth token，release_auth_json 用于恢复旧 takeover | `C:crates/sub2api/src/global_config/codex.rs:68–73,163起,391,418–447` |
| Grok | `~/.grok/config.toml` 的 base_url/api_key，使用 openai_base_url | `C:crates/sub2api/src/global_config/grok.rs:21,66,87` |
| OpenCode | custom 的 opencode.json provider options.baseURL/apiKey；不是默认 cloud 接管目标 | `C:crates/sub2api/src/global_config/opencode.rs:18,45–46`；`global_config/mod.rs:199–268` |
| Pi | custom 的 models.json 追加 provider.baseUrl/apiKey，不接管 auth/settings；可使用绝对 PI_CODING_AGENT_DIR | `C:crates/sub2api/src/global_config/pi.rs:34–36`；`global_config/mod.rs:66–85,199–268` |

`openai_base_url` 一般添加 `/v1`，已有 version segment 时不重复；模型发现调用 `{openai_base_url(origin)}/models`，使用 gateway key。证据：`C:crates/sub2api/src/gateway.rs:76–82`；`C:crates/sub2api/src/lib.rs:331–340`。CLI 启动环境函数主要处理 Node PATH/runtime 与 Claude 的非必要流量开关，不能把它误记为统一 OAuth 注入：`C:crates/sub2api/src/cli_install.rs:744–758（apply_provider_launch_env）`；`C:crates/waku-core/src/command_env.rs:63`。

### 6.2 新入口与资源边界

拟用 `client.tsyqapi.top` 是入口决策，**不是已经落地的默认地址，也不等于资源隔离**。修改编译期 managed URL 不会自动改写已保存的 `Credentials.endpoint`。账户 endpoint 与 gateway origin 可分离：`gateway_config_with_origin` 接收 origin override，桌面将账户与 gateway 路由分别处理。证据：`C:crates/sub2api/src/brand.rs:28–50`；`C:crates/sub2api/src/auth.rs:146–220`；`C:crates/sub2api/src/lib.rs:775–797`；`C:src/app/cloud_account.rs:865–883`。

是否共用户、共库、共额度、共订阅、共网关 token，由主 agent 的部署/资源决策决定，本文件不另起方案。域名分离不能推出这些资源分离；实际 DNS/反代/隔离状态均 **UNKNOWN**。

## 7. New API rc.37：已证实合同差异

以下比较来自 **tag 源码**，不是最新文档、记忆中的旧版 New API 或当前生产假设。

| 领域 | rc.37 已证实接口 / 形状 | 相对原 client 的缺口 | Server tag 证据 |
| --- | --- | --- | --- |
| 路径及 envelope | 账户路由挂载 `/api`；响应主要为 `{success,message,data}` | 原 client 固定 `/api/v1` 并读取 code；只换域名不够，只改 prefix 也不够 | `S:router/api-router.go:16`；`S:controller/user.go:196–212` |
| 登录入口 | `/api/user/login` 等；有 OAuth provider 路由；router 未定位到 `/auth/paseo` 或 desktop exchange | 原浏览器桥/验证码 PKCE 合同不能由原生登录路由直接替代；外置桥 UNKNOWN | `S:router/api-router.go:59,75–79`；`S:controller/user.go:29–34` |
| token 返回 | 登录 JSON 包含 access_token/token_type/**access_expires_at**/session/user；refresh 由 cookie 写出 | 原 client 要求 JSON refresh_token 和相对 expires_in；需要语义适配，不是 DTO 改名 | `S:controller/user.go:196–212` |
| refresh | POST `/api/user/auth/refresh` 读取 refresh **cookie**，可传 X-Auth-Session，旋转 cookie；JSON 不给原 refresh DTO | 原 `{refresh_token}` JSON 请求不是其取值来源 | `S:router/api-router.go:75`；`S:controller/auth_session.go:17–44` |
| logout | POST `/api/user/auth/logout` 支持 dashboard Bearer 撤销 session，也支持 refresh cookie；无凭据时可 success 且无 data | 不能声称它仅支持 cookie；但原 client 无 Bearer 的 JSON refresh 不是其撤销凭据，空 data 也不满足旧 unwrap | `S:controller/auth_session.go:47–95` |
| 账号鉴权 | Dashboard access JWT + login session 验证，并有管理 PAT 分类分支；relay token 另走 TokenAuth | 不应强制沿用旧认知的 New-Api-User 头，也不能用 gateway key 替代 dashboard access | `S:middleware/auth.go:158–186,361起` |
| me | GET `/api/user/self`：role/status 为数值，group 为字符串；quota/used_quota/request_count 等 | 原 User 的字符串 role/status、balance、数值 allowed_groups 不直接匹配；不能把整数 quota 当美元 | `S:router/api-router.go:97–99`；`S:controller/user.go:489–520`；`S:model/user.go（User）` |
| groups | GET `/api/user/self/groups` 返回 groupName → `{ratio,desc}` map；auto 的 ratio 可为字符串 | 原 Vec<Group>、数值 id、platform、订阅组/窗口字段需要稳定映射，不能临时猜 id | `S:router/api-router.go:89,97`；`S:controller/group.go:26–51` |
| token 列表/分页 | GET `/api/token/`，items 的 key 经掩码；status 数值、group 字符串；页号为 **p**，page_size 也支持别名 | 原 `/keys?page=1`、字符串 status、数值 group_id、可直接使用的 key 均不同；原 client 还只取前 50 条 | `S:router/api-router.go:271–285`；`S:controller/token.go:55–69,130–142`；`S:model/token.go:14–32`；`S:common/page_info.go:9–16,40起` |
| token 创建/明文获取 | POST `/api/token/` 绑定 token 字段及 auto_groups，成功仅 success/message；**POST `/api/token/:id/key`** 返回完整 key | 创建不直接返回 ApiKey 的 id/key；需要确定可靠 id 定位和明文取 key 步骤，不能把 masked key 写入 CLI | `S:controller/token.go:188–207,278–358`；`S:router/api-router.go:271–285` |
| 订阅 | GET `/api/subscription/plans`；GET `/api/subscription/self` 返回 billing_preference/subscriptions/all_subscriptions | 不是原 subscription/progress 与日周月 USD 窗口；窗口等价数据来源 UNKNOWN | `S:router/api-router.go:168–178`；`S:controller/subscription.go:32–74` |
| 模型/价格 | `/api/pricing` 返回 data pricing 及 vendors/group_ratio/usable_group/supported_endpoint/auto_groups/pricing_version；模型 pricing 含 ratio/price、enable_groups、endpoint types 等 | 不是 enriched ModelCatalog；best_group、effective USD、对比/窗口/能力不能无依据填充 | `S:router/api-router.go:36`；`S:controller/pricing.go:38–76`；`S:model/pricing.go:28–51` |
| 用量日志 | GET `/api/log/self`，字段过滤 type/start_timestamp/end_timestamp/token_name/**model_name/group 字符串**/request_id 等；created_at 是 Unix int64 | 原 period/model/group_id、时间和 token/cost/cache/latency 等语义不同；other JSON 的可用字段未穷尽 | `S:router/api-router.go:314–318`；`S:controller/log.go:41–59`；`S:model/log.go:59–80` |
| 用量统计 | GET `/api/log/self/stat` 返回 **quota/rpm/tpm**；self/search controller 已弃用 | 不是原 total_requests/token 合计/美元实际费用/平均延迟 DTO；统计口径需另核，不能直接造零值 | `S:controller/log.go:71–76,130–154` |
| quota 单位 | QuotaPerUnit 默认 500000，可由配置改变 | 不硬编码默认值并宣称所有 quota 可按它折算 USD；运行配置与 billing 口径 UNKNOWN | `S:common/constants.go:22`；`S:model/option.go:623–624` |
| 兑换 | POST `/api/user/topup`，请求 `{key}`，返回 scalar quota | 原 `{code}` → `{message,value,new_balance}` 不直接对应 | `S:router/api-router.go:115`；`S:controller/user.go:1190–1192,1235–1265` |
| 推荐 | aff 返回 scalar code，self 另有 aff_count 等 | 原 referral_code/referral_link/stats 需明确组合及链接来源 | `S:router/api-router.go:112`；`S:controller/user.go:437–457,489–520` |
| 公告 | GET `/api/notice` 返回 success/message/data，其中 data 为全局 Notice 内容字符串 | 不是有 id/read_at 的账户公告 collection；没定位到原逐条已读合同 | `S:router/api-router.go:30`；`S:controller/misc.go:179–183`；`S:controller/revalidated_response.go:28–53` |
| 支付 | 用户有 topup/info、topup/self、pay、stripe/pay 等；subscription 有各 payment 路由 | 不能机械替代原 `/pay/api/...` 的统一订单、status token、取消和套餐 DTO；外部支付中心 UNKNOWN | `S:router/api-router.go:113–120,168–178` |
| 组健康 | 未确立旧 group-status 指标的等价 DTO | 不把 performance/status 路由当作无需转换的 group-status；映射 UNKNOWN | `C:crates/sub2api/src/client.rs:395–453,730–733`；`S:router/api-router.go` |

### 7.1 中继支持：不能误报“rc.37 没有 Responses”

rc.37 有 GET `/v1/models`、POST `/v1/messages`、`/v1/chat/completions`、`/v1/responses/compact`、`/v1/images/generations`、`/v1/images/edits`。证据：`S:router/relay-router.go:19–31,90,98,103,116,119`。

**POST `/v1/responses` 和 GET `/v1/responses/:response_id` 由动态 host protocol 注册。** 只搜索 relay-router.go 会漏掉：`S:pkg/jsplugin/routing.go:81–85` 声明路径；`S:router/task-plugin-protocol-router.go:13–24,29–36` 注册并接入 handler；`S:router/main.go:19` 调用注册。

已读 router/pkg/jsplugin 未定位到 root POST `/responses` 或 root GET `/models` 的等价 relay alias；原 Codex managed base 却保留 root。**确认的是源码 prefix 假设不同，不是所有 Codex 请求必然失败。** 外部反代别名、实际 CLI 版本如何追加路径、流式事件/tool/usage/image 扩展及实际模型支持均 **UNKNOWN**，本轮没有 runtime 验收。

## 8. UNKNOWN 清单与原认证安全观察

| UNKNOWN / 观察 | 后续最小确认对象 | 本轮不能做的结论 |
| --- | --- | --- |
| 原桥服务部署与 New API 会话关联 | `/auth/paseo`、desktop exchange 的实现/反代、服务端账户绑定 | 不能以未在 tag 找到桥宣称部署绝无此功能；不能以沿用方案宣称兼容完成 |
| PKCE 服务端保障 | verifier/challenge 校验、登录码 TTL/单次、attempt 绑定 | 客户端生成 S256 不等于服务端已实施全部保障 |
| loopback legacy 路径 | handler 对有 Origin 校验同端口 localhost/127.0.0.1，缺 Origin 仍可接受；endpoint 不一致拒绝 | 只记录条件，不宣判可利用攻击 | 
| refresh/revoke 实际效果 | 原 JSON-refresh 合同到 rc.37 session/cookie 生命周期的桥接与登出结果 | 本地清除不等于服务端 gateway keys 全部撤销 |
| credentials 权限 | Windows profile ACL、Unix chmod 失败路径的实际效果 | 明文 JSON/non-Unix 空函数不是未经验证的漏洞宣判 |
| URL token / fragment | 原 pay token URL、legacy relay fragment 的日志/历史处理 | 未测日志/浏览器历史，不声称已泄露 |
| 资源和入口关系 | 主 agent 部署配置、共享用户/数据库/额度、网关 origin | 独立域名不等于资源隔离 |
| 数据等价 | quota/成本/缓存 token/延迟/订阅窗口、支付订单、公告已读来源 | 不能凭字段名接近、默认值或空数组宣称原范围完整 |
| 模型与 CLI | per-CLI root/v1 最终 URL、key 可用性、模型能力及流式事件 | 源码注册路由不等于提供商 interaction 验收完成 |

安全证据定位：`C:crates/sub2api/src/auth.rs:554–599,668–693`（Origin、endpoint、legacy）；`845–864`（relay fragment 交付片段未见清 hash）；`267–276,364–373`（文件保存/权限）。这些是原流程事实及待核项，不要求安全架构重设计、不要求更换用户已选择的认证方案。

本轮对官方 OWASP 做过真实 web 搜索；搜索工具未返回可用结果。随后通过只读 HTTP 获取官方 Authentication、Session Management、OAuth2 Cheat Sheet 正文；ASVS 项目主页未获取有效正文，**不声称确认最新 ASVS 版本、逐条合规或 ASVS 验收通过**。

官方 primary 来源（仅作后续原流程验收参考，不覆盖本地合同证据）：

- `https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html`
- `https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html`
- `https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html`
- ASVS 索引：`https://owasp.org/www-project-application-security-verification-standard/`（本轮有效正文未取得）。

适用检查集中于服务端挑战验证、会话轮换/失效、redirect 约束与凭据传输/存储；客户端检查不是服务端保障的证明。**本文件没有漏洞定级、攻击可利用性或安全合规结论。**

## 9. 下一任务 M-002：最小适配建议，不代替部署与实现决策

**结论：直接把原 client 指向未经适配的 New API rc.37，不能得到原认证及原数据范围的完整兼容。必须存在协议/语义适配，或已有等价兼容服务；是否已经部署后者 UNKNOWN。** 用户不必因此改用新认证，也不要求把管理端搬入桌面。薄适配可设在现有桥/服务端兼容面或 client 接口边界，具体位置由主任务决定；某些原数据没有已证明的等价源，不能承诺“只加几个别名就全部完成”。

建议 M-002 先补矩阵而非马上重写：

1. **冻结原 contract。** 以本文件请求/DTO 表作为输入，将每项标为直接可用、需转换、需补来源、UNKNOWN；明确原认证保留，禁止以“新站可登录”替代原桥/refresh/logout 验收。
2. **先闭合认证最小链。** 确定原 `/auth/paseo` → code/verifier exchange → 原 tokenpair → me → refresh → logout 的桥接边界。明确 expiry 相对/绝对转换与服务端 session 对应；不要把本地 session_id 当 SID，不盲目把 refresh cookie 当 JSON refresh token。
3. **闭合账户到可用 gateway key。** 稳定映射数值 group_id 与 New API group string；确认 token 创建后的可靠 id 定位、专用取明文 key、数值 status 映射和完整分页。不要把掩码 key 当可用 key，不沿用固定第一页当全部 token。
4. **逐项保留原数据范围。** me/余额、组、订阅窗口、目录价格、组健康、用量、兑换、推荐、公告、支付中心逐项确认 source/DTO/单位。缺来源时标 UNKNOWN/未支持并说明 UI 降级，不用默认零值制造成功；原范围不能默默删减，也不增加管理 API。
5. **分开账户入口与 CLI 中继。** 对 Native/Claude/Codex/Grok 逐一记录最终 base/key/URL，尤其 Codex managed root 与 `/v1/responses`；OpenCode/Pi 不自动扩展为 cloud 接管。共享资源与新域名选择引用主 agent 决策，不另作部署方案。
6. **后续验收建议而非本轮成果。** 先用无真实 secret 的 DTO/请求 fixture 检查 envelope、错误语义、expiry、group/key/pagination；再在明确授权环境验证原桥及每个 CLI/provider 的实际请求。runtime 与视觉验收留给后续任务，本文件不标通过。

### 本轮交付记录

- 唯一写入：`docs/migration/CLIENT-COMPATIBILITY-AUDIT.md`。
- 无业务代码修改、无 server 文件写入、无 push、无 watcher/构建/视觉测试、无实际凭据读取或输出。
- 未穷尽项目保留 UNKNOWN；本文件可作为计划与任务链接的有效落盘输入，但不是发布、部署、安全或 runtime 验收证书。
