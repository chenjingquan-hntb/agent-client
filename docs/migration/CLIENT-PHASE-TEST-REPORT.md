# agent-client 阶段测试报告

日期：2026-10-02。分支：`feat/client-minimal-foundation`。本报告只覆盖本阶段客户端最小兼容、身份/存储隔离、发行门禁与契约检查；不等同于 server T007 联调、原生 macOS/Windows 应用验收、真实 provider/SSE、更新签名或生产发布。

## 已执行检查

| 检查 | 命令/环境 | 结果 |
|---|---|---|
| Bun 离线规格测试 | `bun test scripts/brand-config.test.ts scripts/release-channel.test.ts docs/contracts` | 291 pass / 0 fail，794 assertions，3 files |
| 阶段验证入口 | `bun scripts/validate-client-phase.ts` | 通过；10 TS/TSX、2 YAML、19 workflow Bash blocks、`scripts/bundle.sh`、6 fixtures、686 文件 NUL 扫描 |
| TypeScript/YAML/Bash | Bun.Transpiler、Bun.YAML.parse、`bash -n` | 通过；只解析，不执行 workflow/release |
| Rust | 官方 `rust:1.96.0-bookworm` Docker，engine 29.7.2，image digest `sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc` | 通过：sub2api lib **323 passed / 0 failed**；identity_config debug/release 各 **4 passed / 0 failed** |

Bun 阶段入口还通过了内存故障注入：TS、YAML、Bash、NUL 与子测试失败均返回非零；该行为不代表生产 workflow 被执行。阶段复核还修正了 `cjq.N` 标签必须进入隔离 prerelease 路径、以及分发 URL 不得使用旧 CheapRouter/Waku host，并加入回归测试。

## Rust 测试范围

隔离容器使用 Rust/Cargo 1.96.0、只读仓库挂载和独立 Cargo/target volume，当前命令为：

```text
cargo test --locked -p sub2api --lib
cargo test --locked -p sub2api --test identity_config
cargo test --locked --release -p sub2api --test identity_config
```

`identity_config` 已在 unset、release bundle id、home+共同平台目录、debug identity/debug 平台目录四组公开 synthetic 配置下覆盖 debug/release：**8/8 配置组合通过，每组 4 tests，共 32 个配置测试通过**。Docker Linux 结果不能替代 GitHub macOS/windows 原生 runner。CI 已在两种现有 runner 运行 release-profile identity_config，默认 `cargo test --locked` 仍保留。

## 边界与剩余阻断

- 本阶段未实现 New API 原生认证转换；server T007 仍负责桥接。
- 未执行真实登录、账户数据/key 映射、provider/CLI/SSE、更新验签、备份恢复或支付；M-006 仍 TODO。
- 未启动 watcher、未退出 Debug app、未做视觉测试、未运行打包/发布、未读取凭据或私钥。
- 通过阶段测试不表示可发行；自有正式品牌、域名、安装身份、更新公钥仍需显式配置与后续验收。

## 原生 CI 与合并补充（2026-10-02）

- PR #1 测试提交：`147d0f2513a5bcc43e70b008f14724c0d98299c4`。
- PR workflow：`36961036557`，event=`pull_request`，conclusion=`success`。
- macOS job `110694551201`：SUCCESS，完成于 `2026-10-02T04:05:59Z`。
- Windows job `110694551324`：SUCCESS，完成于 `2026-10-02T04:17:25Z`。
- 两个平台均通过阶段入口、`cargo test --locked` 和 `cargo test --locked -p sub2api --test identity_config --release`；macOS 另通过 generated protocol/browser client checks。
- 重复 push workflow `36961032706` 已取消，不是测试失败；取消状态不是成功证据。
- 用户要求继续后，PR #1 于 `2026-10-02T06:08:58Z` 正常合并；merge commit=`111d48ba31017e9b01323b0f9685643952c23203`。未使用 admin override、force push、tag 或发布操作。
- 合并后的 main workflow `36972177800` 已触发；本补充记录时仍在运行，不能将 PR 检查结果冒充该 run 的最终结果。

本补充只更新代码/CI/合并证据；M-003 完整桥接与 M-006 运行、恢复和首发仍未验收。

## 后续客户端 HTTP 边界回归（2026-10-02）

分支：`feat/client-http-boundary-tests`，以已合并基础 `111d48ba` 为起点。新增 `crates/sub2api/tests/http_boundary.rs`，不修改生产模块、依赖或默认端点。测试使用 `127.0.0.1:0`、现有真实 curl transport、合成凭据和共享 fixtures；服务端线程、socket I/O 及请求尺寸有界并回收。

- `cargo test --offline --locked -p sub2api --test http_boundary`：**7 passed / 0 failed**；子代理默认并行与单线程各通过，主线程默认并行复核通过。
- `cargo test --offline --locked -p sub2api --lib`：主线程复核 **323 passed / 0 failed**。
- `bun scripts/validate-client-phase.ts`：主线程复核 **291 pass / 0 fail / 794 assertions**；`git diff --check` 通过。
- Rust 环境：既有官方 `rust:1.96.0-bookworm` 镜像、网络禁用、仓库只读挂载、独立既有 Cargo/target volumes；loopback 仅在容器内部。
- 覆盖：exchange/refresh 的真实 method/path/JSON/header 与合法解析；native envelope 拒绝；refresh 必需字段/非空/正期限；401/403 与 429/502 和业务 refresh reason 分类；畸形 JSON/非结构化 HTTP 错误不回显合成令牌；未接入连接时 fixture server 可取消和回收。
- `rustfmt` 未执行：镜像未安装该 component；没有联网安装。不将此项记为通过。

本次真实 HTTP transport 测试仅对接 loopback 合成 server，不是 New API 联调；新增测试的 macOS/Windows 原生 CI 尚待该分支 workflow 运行。原生应用、server bridge、provider/SSE、实际安装更新、签名及生产验收均未因此完成。服务端只读核对结论和最小后续见 [下一阶段](CLIENT-NEXT-STAGE.md)。
