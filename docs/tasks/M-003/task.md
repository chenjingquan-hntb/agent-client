# M-003 最小兼容实现与版本化契约

- 状态：IN_PROGRESS（2026-10-02）；客户端协议边界防护已通过 macOS/Windows Rust CI，并经 PR #1 合并；完整桥接与隔离验收仍依赖M-002、server T007。
- 背景：保留客户端原认证交互/数据范围，New API不大改；先证明缺口再适配。
- 写集：本卡、`docs/contracts/`；M-002后逐文件声明 `crates/sub2api/`适配模块和最少desktop hook。server代码由T007单独承担，不跨仓混写。

## 工作与验收

1. 确定映射位置，可直连不包装，缺口用薄模块，不先搭第三仓库/大型服务。
2. 明确原方案回调/刷新/退出/账户状态由哪端实现，模型API key不能冒充账户会话。
3. 建契约版本、支持矩阵、脱敏golden fixtures；测试401/403/429、失效凭据、断网/超时/字段缺失/SSE中断。管理员不授权。
4. 分别确认账户API、relay、CLI持久化配置的目的地址，不能盲目将 `/api/v1` 与 `/v1`互换。
5. IO后台执行，不改render热路径，保留provider原生payload顺序。

验收：原方案范围内认证/数据和至少一个目标provider在隔离环境可用；错误信息脱敏，未支持功能明确显示/禁用，不静默请求前fork账户服务。

## 2026-10-02 最小客户端写集与进展

本轮生产代码写集仅 `crates/sub2api/src/client.rs`、`crates/sub2api/src/http.rs`；契约/fixtures由M-002维护。没有把New API原生用户会话、refresh cookie或模型key改装成原客户端登录链。

- 托管响应必须显式携带整数 `code`，无此字段的New API原生 `success` envelope不再按 `code=0`接受。不兼容响应明确提示 `client-api-v1`，不会用缺省字段伪造账户读取成功。
- refresh响应要求两类令牌及相对秒数 `expires_in`，非空/正值校验在返回调用方保存前执行；不把绝对 `expires_at`当相对期限。不改原认证交互。
- JSON解析失败只保留HTTP状态和行列位置，不回显响应体或serde的值；未结构化HTTP错误不再回显原始body。结构化服务端message/reason仍沿用原行为，本轮不是通用敏感词过滤器。
- 添加Rust回归测试：原生/缺失/错误类型envelope，失效refresh形状，401/403与429/502区分，解析错误不回显fixture凭据。没有新增依赖、网络路径或render/测量工作。

验证边界：当前Windows开发环境能执行Bun，但PATH未找到 `cargo` / `rustc`；Rust回归测试尚未运行，也没有宣称应用编译或provider运行验收通过。离线fixture测试不代替Rust代码执行。

剩余：server T007原桥/code exchange/refresh/logout；完整用户数据及key/分组/分页转换；无等价源功能的显式能力降级；至少一个provider/CLI与SSE隔离验收。未连接生产、未更改默认端点、未扩管理员或云同步、未视觉测试。

## 最新验证状态（2026-10-02）

前文“Rust 尚未执行/待执行”保留为当时的历史记录。最新提交 `147d0f2513a5bcc43e70b008f14724c0d98299c4` 的 PR workflow `36961036557` 已在 macOS/Windows 两个平台通过 `cargo test --locked` 与 release-profile `identity_config`；PR #1 已合并为 `111d48ba31017e9b01323b0f9685643952c23203`。这些结果不证明真实认证、provider、安装签名或更新验收通过。

下一阶段客户端回归：新增 `tests/http_boundary.rs`，loopback 真实 curl integration tests 7/7 通过，覆盖 exchange/refresh 请求与错误边界；不代表 server T007 已实现。服务端当前源码未找到 desktop bridge，证据及最小后续见[下一阶段依赖核对](../../migration/CLIENT-NEXT-STAGE.md)。
