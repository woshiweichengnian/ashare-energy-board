# Phase 1：工程脚手架、本地持久化与凭据层

## Goal

仓库目前只有文档，没有可运行、可类型检查、可单测的工程，也没有本地数据层。

完成后，开发者可以启动一个最小 Electron 空窗体，运行类型检查与单测，并通过主进程读写本地 SQLite 和安全读取同花顺 Key，为后续阶段提供地基。

## Behavior

- 提供以下 npm 脚本并可直接运行：`dev`（启动 Electron 空窗体）、`typecheck`、`test`（vitest）、`build`、`package`（electron-builder Windows `portable`）。
- 空窗体以 `contextIsolation: true`、`nodeIntegration: false` 运行，渲染进程只能通过 preload 暴露的类型化 API 访问主进程能力。
- 应用首次启动时在 Electron `userData` 目录下创建 SQLite 数据库并建好 6 张表：`trading_days`、`intraday_bars`、`auction_snapshots`、`watchlist`、`alert_events`、`app_settings`。重复启动不破坏已有数据。
- 提供 30 交易日滚动清理：
  - 依据 `trading_days` 中最近 30 个开市日，删除更早的 `intraday_bars`、`auction_snapshots`、`alert_events`。
  - `watchlist`、`app_settings`、`trading_days` 不参与清理。
  - `trading_days` 为空或不足 30 个开市日时不删除任何数据。
  - 应用启动时执行一次；清理函数可被后续阶段在收盘后调用。
- 凭据读取：
  - 按 `safeStorage` 加密存储 → `HITHINK_FINANCE_API_KEY` → `%APPDATA%\hithink-finance\credentials.env` 的顺序解析同花顺 Key。
  - 支持写入 / 清除软件内加密存储的 Key。
  - 状态查询只返回 `{ configured, source }`，从不返回明文；明文只在主进程内部用于发请求。

## Constraints

- SQLite 方案使用 `docs/DATA_SOURCES.md` 中 Phase 0 定型的零 MSVC 方案；`npm install` 不得触发本地 C++ 编译。
- 表结构以 `docs/PLAN.md` Phase 1 任务 2 中的定义为准。
- 目录分层遵循 `docs/PLAN.md` §3：存储与凭据在 `src/main/storage/`，渲染进程不得直接访问数据库或凭据。
- Key 不得写入代码、Git、URL、日志或错误堆栈。

## Out of Scope

- 行情数据采集、调度、核心计算引擎。
- HUD / 详情浮层 UI、托盘、老板键、通知（空窗体即可）。
- 设置页里的 Key 输入界面（Phase 5）。
- 数据库迁移框架、多版本 schema 升级机制。

## Acceptance Criteria

- 在无 MSVC 的本机上，`npm install` 零报错完成。
- `npm run typecheck`、`npm run test` 通过；`npm run dev` 能弹出空窗体。
- 单元测试覆盖并通过：
  - 建表幂等（重复初始化不报错、不丢数据）。
  - 6 张表的基本读写。
  - 30 交易日清理：保留最近 30 个开市日数据、删除更早数据、不触碰自选股与设置、`trading_days` 不足时不删除。
  - 凭据解析优先级：三种来源分别存在 / 同时存在时选中正确来源；状态查询结果不含明文。
