# agent-client 任务入口

日期：2026-10-02。背景：Waku → ai-poet/agent-client → 用户fork；独立服务端 New API rc.37 二开，网页继续内嵌。

开始前读根 `AGENTS.md`、[基线](../migration/BASELINE.md)、[确认决策](../migration/DEPLOYMENT-DECISIONS.md)、[审计](../migration/CLIENT-COMPATIBILITY-AUDIT.md)、[计划](../migration/CLIENT-IMPLEMENTATION-PLAN.md)。上游发行指南不是本站已部署事实。

| 任务 | 状态 | 依赖与优先级 |
|---|---|---|
| [M-001 基线](M-001/task.md) | review；损坏文档已修正 | 功能未验收 |
| [M-002 认证/数据兼容矩阵](M-002/task.md) | 静态契约/fixtures 已落地；运行验收未完成 | P0，server T007 输入 |
| [M-003 最小API兼容](M-003/task.md) | IN_PROGRESS；客户端边界防护已落地，macOS/Windows Rust CI 已通过；完整桥接未验收 | M-002 + server T007 |
| [M-004 品牌和端点](M-004/task.md) | IN_PROGRESS；身份/存储配置及迁移防护落地，原生 CI 已通过；发行元数据未确认 | 正式元数据待确认；上线依赖M-003 |
| [M-005 发布与更新](M-005/task.md) | PARTIAL；离线通道门禁及发行预检落地 | 最终身份依赖M-004；更新/产物验收未完成 |
| [M-006 测试与首发](M-006/task.md) | TODO | M-003/004/005 + server T008 |

执行规则：先核对两端分支/工作区；不重写历史，提交/push/合并按用户授权执行，不绕过分支保护；声明写集，不顺手重构；不记录凭据。按AGENTS不启动第二watcher、不退出debug app，本阶段不做视觉测试。生产迁移与发布须另行授权。任务完成附文件、命令、SHA、通过/失败/未验证证据和剩余依赖。

M-004负责brand.rs/resources，M-005负责发行scripts/workflows/updater；交叉元数据顺序接入，不并行覆盖。低配裸机仅作隔离功能测试。review不等于生产可用。

本轮实现与实际验证边界见 [客户端最小落地记录](../migration/CLIENT-IMPLEMENTATION-LOG.md)。Bun离线测试、Rust测试、打包验签和隔离运行分别记账，不能互相替代。

PR #1 已正常合并；下一阶段客户端 HTTP 回归和 server T007 只读核对见[下一阶段](../migration/CLIENT-NEXT-STAGE.md)，最新执行证据见[阶段报告](../migration/CLIENT-PHASE-TEST-REPORT.md)。
