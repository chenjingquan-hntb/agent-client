# 客户端下一阶段与 server T007 依赖核对

日期：2026-10-02。客户端基础 PR #1 已合并为 `111d48ba31017e9b01323b0f9685643952c23203`。本记录是本地源码核对和后续范围说明，不是服务端运行验收或上线授权。

## 核对基线与边界

- 服务端仓库：`D:/Projects/agent-server`，分支 `develop`，HEAD `cdbd593a807deceee77b9a38beaae2ce6594f2b8`。
- rc.37 基线：`385d2dfd10d821b25c8a6766bd16eea248cb1652`；该基线到 HEAD 仅有规划文档变更，没有兼容桥代码。
- 服务端已有 9 份已跟踪文档修改及未跟踪的 `DEPLOYMENT-DECISIONS.md`，保持原样。此阶段仅只读核对，未修改 server、读取凭据、连接生产或执行 server 测试。
- 下表路径相对于上述服务端仓库；客户端合同见 [client-api-v1](../contracts/client-api-v1.md)。仓库之外是否已有独立桥仍为 UNKNOWN，不将源码搜索结果推断为生产事实。

## 实现事实

| 客户端需要 | 源码核对结果 | 证据 |
|---|---|---|
| `/auth/paseo` 浏览器桥 | 未找到实现 | router/controller/service 与 web 路由核对；客户端合同第 3 节 |
| `/api/v1/auth/desktop-session/exchange` | 未找到 code 签发/消费和 verifier 校验的对应实现 | `tasks/T007-api-contract-and-client-integration.md` 仍 TODO；其他 OAuth/Telegram PKCE 不是 desktop 桥 |
| JSON refresh token pair | 原生已有，但仅 cookie refresh、success envelope、绝对 expiry，不能直接满足客户端合同 | `router/api-router.go:73–76`；`controller/auth_session.go:17–44`；`service/auth_session.go:44–50` |
| JSON logout | 原生已有撤销机制，不等于客户端 JSON refresh_token 合同 | `controller/auth_session.go:47–95` |
| `/api/v1` 账户 DTO | 未找到适配路由组；已有原生账户能力 | `router/api-router.go:91–105,167–178` |

原生 session/token 所有权测试已存在（`service/auth_session_test.go`、`controller/auth_session_test.go`、`controller/token_test.go`），但本次未执行，且不能替代 desktop bridge 契约测试。

## 最小后续闭环

1. 如果已有独立兼容桥，先取得源码位置、固定 commit 和脱敏入口映射后复用；不重复建立认证体系。
2. 否则由 server T007 在现有仓库增加薄兼容模块：`浏览器桥 → exchange → me → refresh → logout`，保留既有浏览器登录/MFA/verification，校验 S256、短有效期、单次消费、会话绑定与撤销；不把 cookie refresh 直接公开就声称完成适配。
3. 再处理稳定 group 映射及 gateway key 创建关联、分页、明文所有权验证；不能将掩码 key 当可用 key。
4. 独立实例联调后才进入 M-006 的真实 provider/CLI/SSE 和安装更新验收。

客户端侧先补 loopback + synthetic credentials 的真实 curl 边界回归，不引入新的认证 UI、依赖或生产端点。这类测试证明客户端请求和解析行为，不证明 server T007 已实现。

## 不可猜测的业务语义

账户完整适配前需确认 quota 的货币/成本口径、group 的 platform/subscription_type、订阅窗口与重置规则，以及缺少等价源的公告/价格/状态等功能如何明确处理。不能用默认 0、空数组或虚构字段冒充同步成功，也不能未经确认缩减原功能范围。品牌/平台/身份/公钥决策与上述技术实现分开；不收集私钥、密码或完整连接串。

当前客户端授权范围内不修改 server。推进 T007 的跨仓代码写入需明确范围；生产部署、真实数据迁移和发布仍单独验收。
