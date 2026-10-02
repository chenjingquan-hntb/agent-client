# M-002 原认证与 New API rc.37 兼容矩阵

- 状态：STATIC_DONE / 兼容运行验收待完成，P0。2026-10-02 完成版本化静态契约、全调用/DTO证据与合成fixtures；不等同协议适配或runtime通过。
- 背景：现有客户端有托管账户/CLI路由，站点服务是New API rc.37。用户暂保留原认证和数据范围，不做管理端，不授权本任务重写认证。
- 输入：[审计](../../migration/CLIENT-COMPATIBILITY-AUDIT.md)、[计划](../../migration/CLIENT-IMPLEMENTATION-PLAN.md)、server T007。
- 写集：仅本卡与 `docs/contracts/**`（主契约、调用/DTO库存、固定基线证据、合成fixtures、独立Bun测试）；不改审计/计划/其他任务或生产代码，server代码只读固定tag。生产访问须另行授权和测试账户。

## 工作与验收

1. 每个现有调用列触发点、method/path、认证语义、请求/返回DTO、错误/分页/超时。用户登录、模型key、CLI凭据分开。
2. 用server `v1.0.0-rc.37`源码或隔离实例核验，不以当前develop新增API替代生产基线。
3. 按现有代码盘点数据，区分账户/模型/分组/额度/已有统计与本地会话；不扩展管理员和聊天云同步。
4. 分类：直接可用/字段映射/语义不兼容/缺失/未验证。给出最小适配位置、server owner和M-003逐文件写集，不能将改域名等同兼容。
5. 确认测试账户、独立实例/数据条件和认证安全控制。暂保留原方案不等于免除安全核验。

验收：全调用可追溯，DTO有脱敏形状/源码证据，明确最小功能集与缺口；运行证据不足明确记录，不宣称已联通。

## 2026-10-02 静态交付与验证

- [x] [client-api-v1.md](../../contracts/client-api-v1.md)：35项原调用/调用族分类与触发点、请求/真实DTO/认证、错误/分页/超时、最小适配位置、条件性逐文件建议与owner缺口。
- [x] [calls-v1.json](../../contracts/calls-v1.json)：16账户、6支付、3浏览器/本地、10中继/CLI/图像；[client-dto-v1.json](../../contracts/client-dto-v1.json)：32种冻结原wire DTO字段库存。
- [x] [source-evidence.json](../../contracts/source-evidence.json)：原client提交 e60ae223687d536d43febf133aca76d5008e9a2b；server仅 v1.0.0-rc.37 / 385d2dfd10d821b25c8a6766bd16eea248cb1652；固定源码路径/hash，没有把develop或本轮并行生产修改当原基线。
- [x] [fixtures/](../../contracts/fixtures/)：合成golden和拒绝边界，没有secret/真实账户/真实response抓包；native self日志id按源码展示序号，不能当稳定DB身份。
- [x] 严格区分原库存与本轮目标：库存code.default_on_missing=true及TokenPair字段default只描述原基线；M-003目标code显式required、refresh三字段required、两token非空白、expires_in相对秒且>0，拒绝无code native success。JSON解析诊断不echo原始body，不在client转换native认证。
- [x] 主线程Rust共享六fixture文件名保留：refresh-valid、native-refresh-success、native-self-success、refresh-missing-fields、refresh-empty-token、refresh-nonpositive-expiry（均在docs/contracts/fixtures/*.json）；本次收尾内容未变。主线程报告已加入 frozen_refresh_fixtures_match_the_client_boundary，Rust直接include_str消费同fixture。
- [x] 独立离线Bun验证：

  ```powershell
  bun test ./docs/contracts/fixtures.test.ts
  ```

  收尾实测Bun 1.4.0：**76 pass / 0 fail / 236 expect calls**。只测本地合成JSON与独立参考函数，不import生产模块，不证明Rust/serde一致性、client HTTP或runtime。主线程最终集成复核另报告291项离线测试（792次断言）及TS/YAML/Bash/diff检查通过，非本任务新增执行证据。

- [x] 收尾静态检查：19个JSON均可解析；15个本地文档链接有效；35调用/调用族在主契约覆盖；全写集无尾随空白/NUL；限定写集git diff --check通过（未跟踪文件另行逐文件检查）；六个共享fixture收尾hash不变。

- [ ] Rust/Cargo执行：本机PATH没有rustc/cargo；共享fixture测试已接入为主线程报告，**尚未执行**。
- [ ] 兼容适配验收：严格拒绝原误成功不是native认证/数据桥已完成；本轮明确M-003生产写集仅client.rs/http.rs，更多文件仅条件建议，需owner另行确认写集。
- [ ] 测试账户、独立实例/数据/账隔离、安全控制与发布范围决策：未取得运行证据；待主线程/server T007/认证、计费、订阅、支付、relay等owner。

### 未证实缺口 / 不可宣称

既有PKCE/desktop桥是否存在及refresh/session绑定；稳定数值group_id/platform/三窗口订阅；quota↔USD/实际成本；key创建id关联与全分页；enriched catalog/组健康；期间/时区/日志身份和count完整性；公告已读/邀请链接；/pay完整配置、订单token、取消与到账链；Codex root路径/具体CLI版本、provider/SSE/图像async/下载安全。rc.37已有/v1/responses静态注册，不能误报缺失，也不能从注册断言模型运行可用。

未访问生产、未读取真实凭据、未写server、未构建/启动应用或watcher、无视觉测试。保留原普通用户/模型key/CLI凭据边界；不扩展管理端、认证重写或聊天云同步；不以空DTO/默认0伪造数据成功。审计原文和其他任务/并行agent写集未由本任务覆盖。
