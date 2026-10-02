# M-005 自动构建、自有签名与预发/正式更新隔离

- 状态：PARTIAL（2026-10-02）；离线最小发布通道门禁与发行配置接入已落地，完整发行/更新验收未完成；最终元数据依赖M-004。
- 背景：Docker是server流水线，客户端仍发行原生包；国内镜像仓库和安装包分发是两件事。
- 写集：本卡、发行文档、`.github/workflows/release.yml`/`sync-release.yml`、相关发行/appcast scripts和测试、`src/updater.rs`、`build.rs`发行配置。resources通过M-004依次接入。

## 工作与验收

1. 确认客户端版本/平台，当前Cargo0.2.8不自动改后端版本。若用cjq策略定义外部tag、内部安装版本、单调构建号，不只改Cargo。
2. 服务端预发 `v1.0.0-cjq.1-rc.1`、正式 `v1.0.0-cjq.1`、latest仅正式。通用SemVer将含连字符的cjq正式tag也视为prerelease，须业务分类，不擅改标签。
3. 若客户端采用cjq格式，解决mac release连字符发布阻挡、Windows updater/appcast丢后缀。覆盖rc.1→rc.2→正式→下次正式、同版本不可变/未知标签拒绝，不能把cjq修订视为相等。
4. 正式与预发feed/latest/GitHub属性隔离，release published和手动sync都有门禁，防绕过。
5. 选自有分发位置，核查所有旧源（含CI `releases.waku.sh`历史feed）、plist、安装脚本。server registry另由T003选择，目标国内网络实测，不假设GitHub直连稳定。
6. 自有密钥安全生成，私钥仅受控CI secret；不读取前fork私钥。签名/公证缺失如实限制，不能把绕过系统安全提示当正式验收。
7. 记录锁文件/工具版本/SHA/checksum/签名/manifest和对应源码。

验收：离线通道比较测试、隔离旧版→新版验签更新、坏签名拒绝通过；RC不影响正式源。本阶段不发布生产、不启动第二watcher、不做视觉测试。


## 2026-10-02：离线最小发布通道门禁

### 本次范围与结论

本次仅修改 `.github/workflows/sync-release.yml`、新增 `scripts/release-channel.ts` / `scripts/release-channel.test.ts`、更新本卡。未修改 release workflow、现有 release/appcast scripts、build.rs、updater.rs；工作区其他 worker 的构建/配置和 M-003 修改不归本次门禁验收。

**当前客户端发行仅允许普通安装版本 `X.Y.Z`。cjq/RC 标签分类、排序和同步隔离只是发布通道的基础门禁，不代表客户端已支持 cjq/RC 发行。** 包装 worker 的 `SITE_RELEASE=1`、配置预检和普通版本限制属于另一条构建工作；本卡不将其算作本 worker 的实现或实测。

### 已落地规则

- 正式：精确 `vX.Y.Z` 或 `vX.Y.Z-cjq.N`；预发：精确 `vX.Y.Z-cjq.N-rc.N`。版本三段允许 0，cjq/rc 计数从 1 开始；拒绝前导零、其他后缀、build metadata、空白、换行和未知标签，fail closed。
- 纯函数顺序：核心版本三段 → cjq 修订（普通版本为修订 0）→ RC 序号 → 对应正式。同核心版本 `cjq.1-rc.1 < cjq.1-rc.2 < cjq.1 < cjq.2-rc.1 < cjq.2`；下个核心版本优先于旧核心的全部修订。使用 BigInt，cjq 修订不相等。这不是 Rust updater/mac Sparkle 的比较实现。
- `release.published` 和手动 `workflow_dispatch` 都无条件经过同一门禁。先严格验证 tag，再读取 GitHub 实际 release：tag 必须一致、draft 必须为布尔 false、prerelease 必须与业务通道一致。published 事件还验证事件载荷；手动不能同步 draft 或绕过属性检查。
- tag 经环境变量进入 CLI/带引号的 shell 参数，不嵌入 shell 源码；CLI 输出前严格校验整个字符串。资产名拒绝路径、命令字符和换行，下载资产列表/大小必须与 GitHub 元数据一致。
- RC 只允许 `prerelease/<完整tag>/`，即使资产名为 appcast/latest 也只写该独立前缀；不写根目录稳定指针/稳定状态。该前缀已存在任何对象时拒绝，部分失败也不自动覆盖重试。RC 可仅有版本化安装资产；若含 feed，其 enclosure/notes 必须指向显式配置的 RC URL，而不是稳定根目录。
- 正式资产留在现有根目录，已存在的同名版本化资产拒绝覆盖，含相同内容的重跑也拒绝。仅允许准确版本化的 dmg/zip/exe/md/sha256 文件及四个已知指针；不开放任意名称上传。
- 正式指针：`appcast.xml`、两个 Windows 架构 appcast、`latest-windows.txt`。候选必须包含已有指针，latest 保留完整业务版本；feed 必须包含候选完整身份，不能包含 RC/未来版本，链接必须来自显式自有通道 URL 且对应可用版本化资产。feed 检查为保守子集，不是完整 XML 解析器；不支持的 XML、delta 等结构安全拒绝。
- 正式必须有远端 `release-channel-state.json`：schema=1、正式 tag、bucket/endpoint/downloadBaseUrl、每个现有稳定指针的 SHA256。状态的指针集合必须与成功远端列举结果一致，刚下载的指针字节必须匹配哈希且确实声明状态中的完整版本；候选 tag 必须严格更大。不以 GitHub /latest、时间戳、安装文件名或手填“上一版”猜测稳定版本。
- 首次分发、旧 bucket 没有状态记录、列举/下载失败、状态/指针不同步、缺少证据时均拒绝。**本实现不提供自动 bootstrap 或强制覆盖开关**；初始状态需另行审计自有存储、现有源和真实安装版本后建立，本次未建立或上传任何状态。
- 写入前重新读取 GitHub 属性/资产证据及存储状态、重新计算计划；GitHub 比较排除会因本次下载变化的 download_count，仍比较 release/asset id、tag、属性、大小、digest 等。先写不可变资产，再写通道指针，稳定状态最后提交。指针/状态强制传输，避免等大小导致跳过。中途失败留下碰撞或不匹配证据，后续拒绝，不猜测恢复。

### 显式配置与写入边界

sync 不再默认使用前 fork 的 bucket。执行前必须配置：

| 配置 | 要求 |
|---|---|
| Secret `R2_BUCKET` | 显式自有 bucket；没有默认值 |
| Secret `R2_ENDPOINT` 或 `R2_ACCOUNT_ID` | 明确 HTTPS S3 endpoint，或明确 Cloudflare 账户；不能从空配置推出目标 |
| Secrets `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 分发存储权限；仅 workflow 使用，本次未读取真实凭据 |
| Secret `R2_PROVIDER` | 可选自有 S3 provider；默认协议 provider 为 Cloudflare，不是默认 bucket/账户 |
| Repository variable `SUB2API_RELEASES_BASE_URL` | 与包装流水线共用的唯一自有 HTTPS 下载根，规范 URL、**无尾 `/`**；sync 用 `format('{0}/', vars.SUB2API_RELEASES_BASE_URL)` 派生环境变量 `RELEASE_DOWNLOAD_BASE_URL` 并 cross-check 完全一致，不设独立可漂移的同名 repo variable |
| Repository variable `RELEASE_CHANNEL_WRITER` | 仅在确认独占通道写入后设置为 `sync-release-only`；缺失就拒绝 |

workflow 默认分支 checkout 最新门禁，不从旧 release tag 加载旧策略；所有 sync 使用同一 concurrency 队列。**rclone 快照复核不是存储 CAS，也不是多对象事务**：独占写入标记是运维确认条件，不是自动检测；必须禁止其他 workflow、直接 release.ts 上传、人工或外部写入器修改同一通道。包装 worker 本轮在 site 模式禁止 release.ts 直接上传，约定只走 sync 唯一 writer；该修改在其写集，本 worker 不改 release.ts。仍须确认非 site/人工/外部写入器不会访问同一通道，不能将快照复核说成跨 writer 原子保护。GitHub 的 make_latest 设置也不在本次写集中。

### 离线验证（本机实际执行）

```sh
bun test scripts/release-channel.test.ts
```

Bun 1.4.0：**62 pass / 0 fail，309 次断言**。包括标签分类/未知标签、RC→正式→下次正式、不等修订/大计数、draft/prerelease 属性、缺失配置、RC 前缀隔离/重复拒绝、稳定倒退/重跑、缺失/损坏状态与指针哈希、部分失败、后缀丢失、旧源链接、共享下载根缺失/尾斜杠/漂移拒绝、CLI 输出与离线计划。

使用 `Bun.YAML.parse` 实际解析 `sync-release.yml` 并检查 published/manual 入口；从解析后的 workflow 抽取全部 **6 个** Bash run 块，经 `D:\Scoop\apps\git\current\usr\bin\bash.exe -n` 全部通过。测试不执行 gh/rclone/HTTP，不导入现有 release/appcast/updater，不读取私钥。

### 剩余限制 / 未验收

1. 未接入 Rust updater 或 mac Sparkle 的版本比较、内部安装版本/单调构建号映射；不能承诺 cjq 客户端发行或更新受支持。当前普通 `X.Y.Z` 客户端构建边界继续由包装流水线负责。
2. **stable 空 bucket 没有 bootstrap state 时，首次正式同步也会拒绝**；本轮不新增 bootstrap，也不因空 bucket 猜测“尚未发布”。未做真实 CI、存储传输、生产发布、DNS/TLS/国内下载可达性验证，缺配置/独占写入确认/可信旧状态均拒绝。
3. **严格 XML gate 不支持 Sparkle delta、多 enclosure、部分 XML entities/DTD/注释等结构；必须在隔离环境用真实 mac 生成产物验证。合成 appcast fixture 通过不证明现有 mac/Sparkle 生成 feed 已兼容**，可能按设计安全拒绝真实 feed。本轮不扩展 XML parser。
4. 未做隔离旧版→新版验签更新、坏签名拒绝、系统签名/公证验收；fixture 的签名仅是测试占位。门禁核对身份、大小与指针哈希，不等于安装包 EdDSA/代码签名校验；完整安装包 checksum/签名 manifest、工具/SHA 锁定仍待落实。
5. 本机未找到 cargo/rustc；本 worker 未跑 Rust tests，不能用 Bun 结果代替主线程 M-003 的 Rust 验证。
6. 无生产网络访问、无发布、无私钥读取、无 watcher 启动/重启、无视觉测试；M-005 总卡继续 PARTIAL，完整发行/更新验收不能标完成。

## 主线程包装集成补充（2026-10-02）

发行配置 worker 已接入 `scripts/brand-config.ts`及测试、mac/Windows bundle与appcast脚本、Windows安装模板、`build.rs`、release workflow和 `.env.site.example`。显式 `SUB2API_SITE_RELEASE=1` 才启用自有发行完整预检：缺项或前fork身份/域名/目录/安装GUID/公开更新key拒绝；同一公开key进入客户端编译和feed签名核对；CI从repository vars注入，构建前预检。site `release.ts`仅允许 `--local`，且禁止 `--skip-build`，不成为第二个分发写入者。

全量离线测试为 **291 pass / 0 fail、792次断言**，包含139项品牌配置测试、76项通道测试和76项契约规格测试。8个改动TS文件语法转换、release workflow YAML及13个Bash块、sync workflow YAML及6个Bash块、bundle.sh语法和全工作区diff whitespace检查均通过。未实际打包、运行GitHub Actions或上传。

仅普通 `X.Y.Z` macOS/Windows自有发行链路已接入；cjq/RC及自有Linux构建仍明确拒绝。正式公开元数据/公钥/证书仍待确认；原生签名/公证/安装更新、首次stable bootstrap及真实Sparkle XML兼容性均未验收，不能据此发行。详见[本轮记录](../../migration/CLIENT-IMPLEMENTATION-LOG.md)。

最终产物命名集成补齐：site产品名预检限定为ASCII字母开头、后续字母/数字/下划线/连字符，与sync门禁一致；publisher/platform目录仍支持安全Unicode/空格。通道门禁显式接受 `*-X.Y.Z-{x86_64,aarch64}-pc-windows-msvc.zip` 原生产物，新增14项命名回归，未知架构/平台、错误版本和非精确扩展名拒绝。仅验证合成资产名，不宣称真实安装包已生成或签名。
