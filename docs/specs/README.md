# Phase Specs

由 [`docs/PLAN.md`](../PLAN.md) 拆分出的分阶段轻量 Spec。按顺序实施，每个阶段的 Acceptance Criteria 全部通过后再进入下一阶段。公式、代码口径、表结构以 `PLAN.md` 为准；数据源细节以 `docs/DATA_SOURCES.md`（Phase 0 产出）为准。

| 阶段 | Spec | 依赖 |
| --- | --- | --- |
| 0 | [数据源实测与运行时可行性探针](phase-0-data-source-spike.md) | — |
| 1 | [工程脚手架、本地持久化与凭据层](phase-1-scaffold-storage-secrets.md) | 0 |
| 2 | [纯 TypeScript 核心领域引擎](phase-2-core-engine.md) | 1 |
| 3 | [混合双源采集与自适应调度](phase-3-collector-scheduler.md) | 0、1、2 |
| 4 | [Electron 桌面外壳与告警通道](phase-4-desktop-shell.md) | 3 |
| 5 | [HUD 与详情看板界面](phase-5-dashboard-ui.md) | 4 |
| 6 | [全天回放验证与 Windows 便携版打包](phase-6-replay-packaging.md) | 5 |

## Feature Specs

| 功能 | Spec | 状态 |
| --- | --- | --- |
| 桌面悬浮窗极简模式 | [桌面悬浮窗极简模式](hud-minimal-mode.md) | 已确认 |
