# agent-client 最小落地记录

日期：2026-10-02。基线 HEAD：`e60ae223687d536d43febf133aca76d5008e9a2b`。这是本地实现与离线证据，不是生产部署/发行/安全或完整运行验收。

## 范围与并行写集

按现有计划，客户端保留原认证交互、普通用户数据范围和provider引擎，不引入第三项目、不改New API整体认证，不扩管理员和聊天云同步。用户明确要求并行子代理；写集拆为互不覆盖的契约、Rust身份/存储、同步通道、发行配置，主线程负责接口边界与集成检查。

| 工作 | 主要文件 | 落地结果 |
|---|---|---|
| M-002静态契约 | `docs/contracts/client-api-v1.md`、调用/DTO清单、来源证据、fixtures/离线测试 | 冻结客户端原合同，读取服务端rc.37基线，逐项区分映射候选/语义不兼容/未证实来源 |
| M-003接口边界 | `crates/sub2api/src/client.rs`、`http.rs` | 显式整数code，refresh形状/非空/正相对期限校验，JSON decode错误不回显body/值；Rust测试消费同一份契约fixtures |
| M-004身份/存储 | `brand.rs`、`migrate.rs`、`waku-protocol/src/identity.rs`、`sub2api/tests/identity_config.rs` | 编译配置进入release APP_ID和两crate数据目录；自定义目录/自有发行不默认迁入旧凭据；默认debug流程保持 |
| 发行配置预检 | `scripts/brand-config.ts`及测试、Windows/mac打包与appcast脚本、`build.rs`、Windows安装模板、release workflow、`.env.site.example` | 显式自有发行要求完整公开元数据，拒绝前fork身份/站点/更新公钥，实际注入平台元数据与公钥 |
| M-005同步门禁 | `scripts/release-channel.ts`及测试、`.github/workflows/sync-release.yml` | 严格业务标签/排序，published和manual共用门禁，RC独立路径，稳定指针验证证据并禁止倒退/同版本覆盖 |

既有用户修改（例如BASELINE/M-001/FORK/发行文档）保留，不重写历史、不提交、不push；服务端仅只读。

## 配置与行为边界

- 未确认正式品牌、图标、发行平台、Windows AppId、分发源或自有更新公钥；模板只列待确认项，不擅自生成生产身份/私钥或推定域名用途。
- 没有把默认服务直接改到候选客户端域名。自有发行走 `SUB2API_SITE_RELEASE=1` 且必须显式配置；缺配置时CI拒绝发行，而非悄悄使用旧站。
- `SUB2API_ALLOW_LEGACY_STORAGE_MIGRATION=1` 是移动整份旧目录的显式授权，不是跨站点凭据自动兼容；自有包不默认设置。迁移/回退详见M-004。
- shared全局命令扫描命名空间仍有旧硬编码，本轮不宣称所有路径/CLI provider id已改名。既有用户主动配置的端点不覆写。
- 客户端安装版本仍是Cargo `0.2.8`；仅普通X.Y.Z原生发行接入，cjq/RC分类/排序门禁不等于已完成Rust updater/mac Sparkle版本映射。当前发行预检拒绝cjq/RC，待明确客户端版本策略后做M-005后续。
- 当前site产品名必须为ASCII字母开头、后续仅字母/数字/下划线/连字符，以匹配实际产物与同步命名；publisher和平台目录仍支持安全Unicode/空格。Windows便携zip的两个原生target triple已加入精确门禁，未知平台/错误版本/错误扩展名仍拒绝。
- 同步状态缺失时拒绝稳定发行，首次bootstrap、真实Sparkle XML/增量包和签名验收另行做；只用离线合成feed不能证明实际生成的feed均能同步。
- 没有启动/恢复watcher、退出debug app、运行bundle debug、视觉测试、真实凭据迁移、生产连接或发布。

## 验证

主线程最终集成检查（2026-10-02）：

- `bun test scripts/brand-config.test.ts scripts/release-channel.test.ts docs/contracts`：**291 pass / 0 fail，794次断言，3个测试文件**。均为离线规格/配置/通道测试，没有执行网络或生产操作。
- 8个改动TypeScript文件通过 `Bun.Transpiler` 内存语法转换；未执行打包/发布脚本。
- 两个workflow经 `Bun.YAML.parse` 解析，临时检查脚本抽取的 `release.yml` **13个**和 `sync-release.yml` **6个** Bash run块均通过 `bash -n`；`scripts/bundle.sh` 也通过 `bash -n`。这不是实际GitHub Actions运行。
- 改动及新增文件按字节扫描无实际NUL；6个Rust `include_str!`共享fixture路径存在。此检查只证明文件完整性，不证明Rust编译。
- `git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab diff --check` 通过；Git的LF/CRLF提示不是通过编译的证据。

复核命令（以下不是Rust或runtime验收）：

~~~powershell
bun test scripts/brand-config.test.ts scripts/release-channel.test.ts docs/contracts
git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab diff --check
~~~

当前可用Bun `1.4.0`；`where.exe cargo`、`where.exe rustc`未找到。新增Rust回归和跨crate/迁移测试已写入，但未运行、未rustfmt、未编译应用。不要将Bun的fixture规格测试当作Rust执行。

具备Rust工具链与依赖缓存后，在未启用自有发行配置的隔离测试环境执行：

~~~powershell
cargo test --offline --locked -p sub2api --lib
cargo test --offline --locked -p sub2api --test identity_config
cargo test --offline --locked --release -p sub2api --test identity_config
~~~

配置矩阵见M-004；offline缺依赖时应报告不足，不以失败日志声称已编译。

## 下一步与发布阻断

1. server T007按client-api-v1实现/确认原登录桥、code exchange、refresh/logout及普通用户兼容面；无需重写客户端认证。
2. 核验完整数据来源，明确分组稳定映射、token分页/创建后定位/取明文key，以及无等价源功能的显式降级方案；不以空值伪造成功。
3. 确认公开品牌/安装身份/平台/更新分发信息，生成并受控保存自有签名密钥后配置CI；不将私钥放入仓库/任务。
4. 执行Rust测试、原生构建/验签，再按M-006用临时独立实例完成登录/数据/provider/CLI/SSE/更新与恢复演练。

没有上述证据，不标M-003/004/005/006完成，也不把文档或离线测试通过当作可上线。

## 阶段测试补充（2026-10-02）

在前述离线检查基础上，本阶段新增 `scripts/validate-client-phase.ts` 作为可复现门禁，并接入 `.github/workflows/test.yml` 的 macOS/Windows 两个现有 runner。入口不执行 workflow 或发布脚本，只做 Bun 测试、语法解析、Bash `-n`、fixture 解析和实际 NUL 扫描；Windows Bash 由 Git `--exec-path` 定位，不依赖开发机路径。

本地 Windows 已执行入口并通过：291 pass / 0 fail、794 assertions；10 个 TS/TSX、2 个 workflow、19 个 workflow Bash blocks、`scripts/bundle.sh`、6 个 Rust fixture 路径、686 个文件完整性检查均通过。Rust 回归在隔离 Rust 1.96.0 Docker 中执行，结果与配置矩阵记录见 `CLIENT-PHASE-TEST-REPORT.md`；Docker Linux 证据不替代 macOS/Windows 原生 CI。

用户已授权在阶段证据满足后提交功能分支并创建 PR。本阶段仍不宣称 server T007/M-006、真实登录/provider/SSE、原生打包验签或生产发布完成。

阶段补充：Rust 已于 2026-10-02 在隔离官方 `rust:1.96.0-bookworm` 容器实际完成：`cargo test --locked -p sub2api --lib` 为 323 passed / 0 failed；debug 与 release 的 `identity_config` 基线各 4 passed / 0 failed。随后执行四组 synthetic 编译环境（全部 unset、仅 release bundle ID、home+共同平台目录、再加 debug identity/debug 平台目录），每组 debug/release 均 4 passed / 0 failed，共 32 个配置测试通过。

阶段复核发现并修正两项门禁缺陷：`vX.Y.Z-cjq.N` 现在与 RC 一样归入隔离 prerelease 命名空间，不再错误写稳定根路径；R2 endpoint 与下载 URL 拒绝旧 CheapRouter/Waku host。相关 TS 回归测试现为 76 pass / 0 fail、325 assertions；完整阶段入口复跑通过。
