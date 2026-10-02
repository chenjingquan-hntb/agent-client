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
