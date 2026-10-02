# M-004 自有品牌、端点与安装身份

- 状态：最小 Rust 基础代码已落地；Rust 编译/测试待执行，完整发行验收仍未完成，上线依赖 M-003 与包装集成。
- 背景：默认CheapRouter，用户确认域名但未确认正式名称/图标/平台，不自行用域名猜品牌。
- 写集：本卡、`crates/sub2api/src/brand.rs`、`crates/waku-protocol/src/identity.rs`、`resources/`、必要品牌资产/文档。额外hook先登记。发行scripts归M-005。

## 工作与验收

1. 集中品牌/官网/托管API/备用地址/更新源/数据目录/bundle ID/Windows AppId与发布者；`client.tsyqapi.top`为入口候选，不覆写用户自定义端点。
2. 核验option_env、build.rs、plist、Inno Setup、跨crate数据目录和CI参数实际生效，不仅改brand.rs。
3. 首次本站发行用自有安装身份和更新公钥，不复用前fork GUID覆盖其安装；发行后identity保持稳定。若已有本站用户先查迁移兼容，不盲换GUID。
4. 独立数据目录；旧 `.waku`/`.cheaprouter`迁移需明确同意/回退，不静默导入其他站点凭据。
5. 保留Waku/直接上游及许可证/NOTICE，内部包名/exe可保持；源码发行链接由本站控制。

验收：离线元数据一致，不残留前fork默认账户/更新源；未确认品牌/证书/平台如实待定。本任务不做视觉测试。


## 2026-10-02：最小基础代码落地（限定写集）

本轮按用户明确指示，仅写：

- `crates/sub2api/src/brand.rs`：补充平台数据目录的共同/debug 编译期配置，与 protocol 保持一致。
- `crates/waku-protocol/src/identity.rs`：release APP_ID 接入现有 bundle ID 配置，平台目录改为可配置；删除旧硬编码目录常量，保留默认 debug 身份。
- `crates/sub2api/src/migrate.rs`：自定义目录和自有发行禁止默认导入旧存储，显式允许后才迁移；补充隔离单元测试。
- `crates/sub2api/tests/identity_config.rs`：直接包含实际 protocol identity 源码，验证跨 crate 配置契约，不增加依赖。
- 本卡。没有写集外 hook，也没有改 UI/build/scripts/resources/workflow；包装接入由主线程委托 Aquinas。

### 与包装 worker 同步的编译期契约

| 环境变量 | Rust 行为 |
|---|---|
| `SUB2API_BRAND_BUNDLE_ID` | release APP_ID 与 brand::BUNDLE_ID 使用同一显式值；未设置时保留各自历史默认，不将默认配置声称为本站发行配置 |
| `SUB2API_BRAND_BUNDLE_ID_DEBUG` | 可选，仅覆盖 debug APP_ID；未设置仍为 `sh.waku.dev`，不继承 release ID |
| `SUB2API_DATA_DIR_NAME` | 两 crate 的 home 数据目录；默认 `.cheaprouter` |
| `SUB2API_PLATFORM_DATA_DIR_NAME` | release/debug 共同平台目录覆盖项；未设置时仍为 CheapRouter / CheapRouter Debug |
| `SUB2API_PLATFORM_DATA_DIR_NAME_DEBUG` | 可选，优先覆盖 debug 平台目录；要分离两 profile 时同时设置共同和 debug 项 |
| `SUB2API_ALLOW_LEGACY_STORAGE_MIGRATION` | 只有精确字符串 `1` 允许；其他任何已设置值均禁止全部迁移；不是运行时环境开关 |
| `SUB2API_SITE_RELEASE=1` | 即使沿用默认数据目录，也禁止自动迁移；上面的显式允许值才可放行。其余发行元数据校验属于包装 worker |

这些变量须在实际 Cargo 编译环境传给两个 crate，不是仅由根 build.rs 对根包设置 rustc-env。目录参数是目录名；自有发行的名称/路径/元数据校验与打包一致性由包装接入负责。本轮未改 APP_NAME 的既有默认、watcher 或 mac 构建命名，默认 Waku Debug.app 的运行流程不变。

### 迁移边界

- 仅当 home、release 平台、debug 平台目录都为原默认且不是自有发行、未显式禁用时，保留原 Waku → CheapRouter 行为。
- 任何目录自定义，默认整次迁移为 no-op；不会顺带迁走其他默认平台目录或用户全局命令目录。
- 显式允许后，home 来源优先 `.cheaprouter`、后 `.waku`；平台来源分别优先 CheapRouter / CheapRouter Debug、后 Waku / Waku Debug，目标使用实际编译配置。
- 已有目标不覆盖、不合并；未选中的来源保持原样；失败保留来源并返回警告；重复启动和重复 OS 根路径可安全重试。
- 自定义目录即使允许迁移，也不迁移仍硬编码的共享 `.config/waku` 命令目录。命令扫描的全局命名空间隔离不在本轮范围，不能声称全应用所有全局路径都已隔离。
- opt-in 会移动包含凭据的完整旧目录，不校验凭据是否属于目标站点。仅在确认旧站点兼容、得到迁移授权并备份后使用；包装方不应默认设置该开关。回退需停止相关进程，确认旧路径不存在，再将迁移目录移回原路径；不提供自动合并/覆盖回退。
- 官网、托管 API、备用地址、更新源和用户自定义端点未改。不猜正式品牌、安装 GUID 或更新公钥，不把默认站点指向未经桥接的 New API。

### 测试与证据

- 基线 HEAD：`e60ae223687d536d43febf133aca76d5008e9a2b`。共享工作区其他 worker 的改动未覆盖；不提交、不 push、不 cherry-pick。
- 已通过：限定 Rust 写集的 `git diff --check`、LF/末尾换行/行尾空白检查、两 crate 目录常量源码一致性检查、profile 目录常量唯一性与环境变量契约静态检查。
- 已添加但未执行：12 个迁移单元测试（含原 3 个）和 4 个跨 crate 编译配置契约测试。迁移测试仅注入独立临时目录和无敏感信息的 marker；不调用读取真实 OS 数据根目录的公共迁移入口，不读取真实账户文件，不变更进程环境，不发网络请求。
- 环境限制：`where.exe cargo` / `where.exe rustc` 均未找到；默认 .cargo/bin 与 .rustup/toolchains 无可用工具链，WSL 列表仅见 docker-desktop。没有安装工具链或把静态检查冒充 Rust 编译/test/rustfmt 通过。
- 未启动 watcher/第二构建进程，未做视觉测试、打包、签名、生产连接或真实凭据迁移。安装身份、更新 key、域名桥接与完整发行一致性仍待确认/验收。

在具备 Rust 工具链与依赖缓存的环境执行（offline 防止自动联网）：

~~~powershell
cargo test --offline --locked -p sub2api --lib migrate::tests
cargo test --offline --locked -p sub2api --test identity_config
cargo test --offline --locked --release -p sub2api --test identity_config
~~~

编译配置测试应在隔离子进程分别覆盖：①全部相关变量未设置；②仅 release bundle ID；③home + 共同平台目录覆盖（debug 应继承共同平台目录）；④再增加 debug bundle ID/debug 平台目录覆盖。每组运行 debug 和 release 的 identity_config 测试；测试值仅用明显的测试目录和 `org.example.identity-test` 类测试 ID，不作为生产配置写入仓库。迁移单元测试以注入参数设计覆盖自定义目录、显式允许/禁止、SITE_RELEASE、来源优先级、现有目标、失败及重复根路径，无需操作真实用户目录。
