# A 股实时能量看板（ashare-volpulse）实施计划

本文档是 `ashare-volpulse` 项目的权威实施计划，汇总已确认的需求口径、数学定义、系统架构与分阶段落地任务。后续开发请严格按阶段推进，并满足每阶段的 **Completion Criteria**。

---

## 1. 已确认需求与产品边界

| 维度 | 确认决策 |
| --- | --- |
| **产品形态** | 纯 Windows 桌面悬浮窗 + 系统托盘（不提供独立浏览器 Web 页面）；支持本地开发与 Windows 便携版 `.exe` 打包 |
| **技术栈** | Electron + TypeScript + React + ECharts + 本地 SQLite（零本机 MSVC C++ 编译依赖） |
| **交互形态** | 双态悬浮窗：默认「紧凑 HUD 悬浮窗」（置顶、可调透明度、拖拽记忆位置），点击/双击展开「详情浮层」（完整 ECharts 分时对比图、斜率图、自选股管理、事件流、设置）+ 系统托盘 + 全局老板键一键显隐 |
| **大盘口径** | 主指标为 **沪深两市总成交额**（上证 `000001.SH` + 深市全额 `399106.SZ`，不含北证、防止科创/创业重复累加）；默认并列展示 **四大全市场板块指数**（上证指数 `000001.SH`、深证成指 `399001.SZ`、创业板指 `399006.SZ`、科创综指 `000680.SH`），设置页另提供 **上证50（`000016.SH`）、沪深300（`000300.SH`）、中证1000（`000852.SH`）、科创50（`000688.SH`）** 可选开关（默认关闭），全部明确标注「全市场 / 成分股」口径 |
| **个股监控** | 支持代码/名称搜索增删改排自选股；与大盘共用同一套放缩量与斜率引擎；悬浮窗展示价、涨跌幅、成交额、放缩量状态，点击进入详情浮层看完整对比图；快速放缩量提醒支持全局与单股独立开关及阈值微调 |
| **数据源策略** | **混合双源 + 本地落盘**：免费公开实时/分时源（Phase 0 实测择优）承担高频批量快照与今/昨 1 分钟分时基线；同花顺 Fuyao API 承担交易日历、标的检索消歧及低频校验/备用兜底；所有采样与 1 分钟聚合持久化到本地 SQLite（滚动保留近 30 个交易日） |
| **刷新粒度与时段** | 盘中默认 3 秒快照（可调 3~15 秒，经 Phase 0 限流实测校准默认安全值）+ 1 分钟聚合落盘；`09:25` 集合竞价单标展示；`09:30–11:30` 与 `13:00–15:00` 午休自动折叠；非交易时段自动暂停轮询并保留最近交易日全天数据复盘 |
| **放缩量与斜率** | 昨日同期归一化双指标：累计成交额同比（差额/百分比 + 全天预测成交额）+ 滚动 5 分钟（可调 3/5/10）相对昨日同期量比斜率与区间增量倍数；`09:30–09:35` 冷启动防抖 |
| **提醒机制** | 悬浮窗呼吸高亮 + Windows 原生系统通知 + 可静音区分急放/急缩短提示音 + 详情页异动事件流日志；同标的同方向默认 5 分钟冷却；暂不接入外部 Webhook |
| **密钥与安全** | 同花顺 API Key 按优先级读取：软件内 `safeStorage` 加密存储 → `HITHINK_FINANCE_API_KEY` → `%APPDATA%\hithink-finance\credentials.env`；严禁明文入库、入 Git 或打日志 |

---

## 2. 领域规范与数学定义（Single Source of Truth）

### 2.1 标的与大盘聚合口径

| 展示对象 | 标准代码 (`thscode`) | 口径说明 |
| --- | --- | --- |
| **沪深两市总成交额**（汇总指标） | `000001.SH` + `399106.SZ` | 沪市全市场（已含科创板）+ 深市全市场（已含创业板），**不含北证**。严禁将四大宽基成交额直接相加 |
| 上证指数 | `000001.SH` | 点位 + 沪市全市场成交额（标注：`全市场`） |
| 深证成指 | `399001.SZ` | 点位 + 成交额（Phase 0 实测确认所选数据源该字段为 `成分股` 还是 `深市全市场` 后标注） |
| 创业板指 | `399006.SZ` | 点位 + 成交额（标注：`全市场`，腾讯/新浪实测与 `399102.SZ` 一致） |
| 科创综指 | `000680.SH` | 点位 + 科创板全市场成交额（默认展示，标注：`全市场`） |
| 上证50 / 沪深300 / 中证1000 / 科创50 | `000016.SH` / `000300.SH` / `000852.SH` / `000688.SH` | 可选扩展指数（设置页默认关闭，开启后展示，标注：`成分股`） |

> **关键约束**：不同公开源返回的成交额单位可能是「元」或「万元」，`MarketDataProvider` 适配器必须在边界层统一标准化为 **人民币元（`number`）**，UI 展示层再按量级格式化（如 `1.28 万亿`、`864.5 亿`、`3.42 亿`、`5,820 万`）。

### 2.2 交易时间轴与午休折叠

- **集合竞价**：`09:15–09:25`，记录 `09:25` 终态开盘竞价成交额与开盘价作为独立锚点 `auctionSnapshot`，不混入连续竞价斜率窗口。
- **连续交易分钟索引 `minuteIndex` (`0..239`)**：
  - 上午：`09:30` → `0` … `11:29` → `119`（`11:30` 闭合归入上午最后一根 `119`）
  - 午休：`11:30–13:00` **完全折叠**，不产生空 K 线
  - 下午：`13:00` → `120` … `14:59` → `239`（`15:00` 收盘撮合归入最后一根 `239`）
- **交易日判断**：每日首次启动/跨日时优先通过同花顺 `/api/a-share/calendar/trading-days` 拉取近一年交易日历并缓存到 SQLite，用以精确确定 `prevTradingDate`（解决长假/周末跨日问题）。

### 2.3 放量/缩量、全天预测与斜率算法

记当前连续交易分钟索引为 $t \in [0, 239]$（盘中未闭合分钟用最新秒级快照按已过秒数进行平滑映射，避免在每分钟第 3 秒时因分钟未结束而误判骤缩）：

1. **累计成交额对比（同期归一化）**：
   - 今日截至时刻 $t$ 累计成交额：$A_{\text{today}}(t)$
   - 上一交易日同一时刻 $t$ 累计成交额：$A_{\text{prev}}(t)$（未闭合分钟内若已过 $s \in (0, 60]$ 秒，采用线性插值 $A_{\text{prev}}(t-1) + \frac{s}{60}\cdot \Delta a_{\text{prev}}(t)$ 对齐，避免秒级锯齿误报）
   - **同比差额**：$\Delta A(t) = A_{\text{today}}(t) - A_{\text{prev}}(t)$
   - **同比变化率（量比偏离）**：
     $$R(t) = \frac{A_{\text{today}}(t) - A_{\text{prev}}(t)}{A_{\text{prev}}(t)} \quad (A_{\text{prev}}(t) > 0)$$
   - **全天预测成交额**（仅大盘及具备历史全天成交额基线的标的，采用**多日分时占比模板 + 剩余时段贝叶斯收缩**，消除开盘前几分钟单日基线噪声导致的剧烈偏低/偏高）：
     - 优先取本地 SQLite 最近最多 `10` 个历史完整交易日（不足时自动退回已有天数 / 昨日）计算每分钟平均累计占比 $\bar{w}(t) \in (0, 1]$（未闭合分钟按已过秒数线性插值）及样本日全天成交额均值 $\bar{A}_{\text{full}}$；
     - 计算当前实时倍率 $r(t) = \frac{A_{\text{today}}(t)}{\bar{A}_{\text{full}} \cdot \bar{w}(t)}$ 与基于已成交占比的贝叶斯置信权重 $\alpha(t) = \frac{\bar{w}(t)}{\bar{w}(t) + \lambda}$（默认先验强度 $\lambda = 0.12$）；
     - 拆分已成交与剩余时段预测：
       $$\hat{A}_{\text{full}}(t) = A_{\text{today}}(t) + \Bigl(\alpha(t) \cdot r(t) + \bigl(1 - \alpha(t)\bigr)\Bigr) \cdot \bar{A}_{\text{full}} \cdot \bigl(1 - \bar{w}(t)\bigr)$$
       保证平量无偏、开盘稳健防腰斩、收盘 $\bar{w}(239)=1$ 时严格等于真实收盘成交额。
   - **放/缩量状态判定**（阈值可配置，默认 `±5%`）：
     - $R(t) \ge +5\%$：`放量`
     - $R(t) \le -5\%$：`缩量`
     - 其他：`平量`

2. **缩放量趋势变化（边际量比斜率）与快速异动判定**：
   设滚动窗口长度为 $W$ 分钟（默认 `5`，可选 `3 / 5 / 10`），仅在折叠后的连续 `minuteIndex` 上计算，并剔除 `09:25` 集合竞价对连续竞价斜率的干扰：
   - **指标 A — 滚动区间增量倍数 $M_W(t)$ 与边际量比偏离 $D_W(t)$**：
     对 $k \ge W$ 取满窗口 $[k - W + 1, k]$（$1 \le k < W$ 取剔除 `09:25` 与 `09:30` 混合首分钟后的纯连续竞价前缀 $[1, k]$）：
     $$M_W(t) = \frac{A_{\text{today}}(t) - A_{\text{today}}(t - W)}{A_{\text{prev,aligned}}(t) - A_{\text{prev}}(t - W)} \quad (\text{分母} > 0), \qquad D_W(t) = \bigl(M_W(t) - 1\bigr) \times 100\%$$
     衡量最近 $W$ 分钟的边际成交能量相对于昨日同一 $W$ 分钟的倍数与偏离百分比，天然剔除 A 股早盘高、午盘低的 U 型日内规律干扰，且早盘与尾盘量纲完全一致（无午后累计大基数钝化）。
   - **指标 B — 边际量比趋势斜率 $S_W(t)$（单位：百分点/分钟）**：
     对窗口内序列 $\{(k, D_W(k))\}_{k=t-W+1}^{t}$（$t \ge W$，使 $k \ge 1$ 全程不含集合竞价）做普通最小二乘（OLS）线性回归，取斜率 $S_W(t)$。正值表示近期边际量能正在加速放量，负值表示正在加速缩量；当集合竞价大幅放量而连续竞价平稳放量时，斜率保持在 `0` 附近，不再产生开盘假急缩深坑。
   - **快速放量 / 快速缩量触发条件（默认参数，支持全局与单股覆写）**：
     - **冷启动保护**：`minuteIndex < 5`（即 `09:30–09:34`）不触发斜率提醒。
     - **快速放量（Rapid Surge）**：$S_W(t) \ge +3.0\%/\text{min}$ **且** $M_W(t) \ge 1.5\text{x}$（可选「且/或」模式，默认「且」以降低噪声）。
     - **快速缩量（Rapid Shrink）**：$S_W(t) \le -3.0\%/\text{min}$ **且** $M_W(t) \le 0.65\text{x}$。
     - **防刷屏冷却**：同一 `(symbol, direction)` 触发后进入冷却期（默认 `5` 分钟），冷却期内不重复弹窗与发声，但持续更新 HUD 实时斜率显示。

### 2.4 同花顺 Fuyao API 契约摘要

- Base URL：`https://fuyao.aicubes.cn`，全部 `GET`，Header：`X-api-key: <API_KEY>`。
- 成功判定：HTTP `200` 且 JSON 信封 `code === 0`（`{ code, message, request_id, data }`）。
- 本项目使用端点：
  - `GET /api/a-share/calendar/trading-days`（每日缓存一次）
  - `GET /api/meta/tickers/search?q=<keyword>&limit=10`（添加自选股搜索消歧）
  - `GET /api/a-share-index/prices/snapshot?thscodes=000001.SH,399106.SZ,399001.SZ,399006.SZ,000688.SH`（低频校验/兜底）
  - `GET /api/a-share/prices/snapshot?thscodes=<comma-separated>`（低频校验/兜底）
- 已知边界：历史接口仅支持 `1d` 日线，**无历史分钟/分时接口**；存在 `code=4001` 动态限流，不得高频轮询。

---

## 3. 系统架构与目录规划

```text
ashare-volpulse/
├── AGENTS.md
├── docs/
│   ├── PLAN.md                  # 本实施计划
│   └── DATA_SOURCES.md          # Phase 0 实测调研报告（数据源选型、单位与安全频率）
├── scripts/
│   └── spike-data-sources.mjs   # Phase 0 数据源探针脚本
├── src/
│   ├── shared/                  # 前后端共享类型、IPC 契约、常量
│   │   ├── types.ts
│   │   ├── ipc.ts
│   │   └── constants.ts
│   ├── core/                    # 纯 TypeScript 领域引擎（零 Electron/DOM/IO 依赖）
│   │   ├── tradingClock.ts      # 交易时段判定、minuteIndex 映射、午休折叠
│   │   ├── marketAggregator.ts  # 沪深两市总成交额聚合、口径校验
│   │   ├── energyEngine.ts      # 同比放缩、全天预测、未闭合分钟插值、OLS 斜率、区间倍数
│   │   └── alertEngine.ts       # 冷启动保护、触发判定、冷却去重
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts             # 应用生命周期与依赖装配
│   │   ├── windows/             # Compact HUD 窗口、Detail Overlay 窗口、位置/透明度持久化
│   │   ├── tray/                # 系统托盘菜单、动态状态提示、全局老板键
│   │   ├── providers/           # MarketDataProvider 接口 + 东财/腾讯/新浪适配器 + HithinkAdapter
│   │   ├── scheduler/           # 分层轮询调度、批量合并、1分钟聚合、指数退避与故障转移
│   │   ├── storage/             # SQLite 持久层（30 交易日滚动清理）与 SecretStore (safeStorage)
│   │   └── alerts/              # Windows 原生通知派发与事件落库
│   ├── preload/
│   │   └── index.ts             # contextBridge 类型安全 API
│   └── renderer/                # React + ECharts 渲染进程
│       ├── hud/                 # 紧凑 HUD 悬浮窗组件（红涨绿跌、呼吸提醒、点击展开）
│       ├── detail/              # 详情浮层（ECharts 双图联动、自选股管理、事件流、设置页）
│       ├── audio/               # Web Audio 急放/急缩短提示音（可静音）
│       └── styles/              # 暗色半透明磨砂交易 HUD 主题
├── tests/
│   └── core/                    # Vitest 单元测试（边界时段、公式、斜率、聚合、冷却）
└── package.json
```

---

## 4. 分阶段实施路线与验收标准

### Phase 0：数据源实测调研与运行时可行性探针（必须最先执行）

**目标**：在写任何业务代码前，用实测消除数据源、口径、限流与 SQLite 零编译兼容性的所有不确定性。

**任务**：
1. 编写并运行探针脚本 `scripts/spike-data-sources.mjs`，在真实网络环境下测试候选公开免费行情源（如东方财富 `push2`/`push2his` trends2、腾讯 `qt.gtimg.cn` 及分时接口、新浪 `hq.sinajs.cn`）：
   - 验证能否**单次批量请求**获取 `000001.SH`, `399106.SZ`, `399001.SZ`, `399006.SZ`, `000688.SH` 与测试个股（如 `600519.SH`, `300750.SZ`）的实时快照（含最新价、涨跌幅、成交量、成交额）。
   - 验证能否获取**今日 + 上一交易日**完整 1 分钟分时成交额与价格序列（如 `ndays=2` trends2 接口）。
   - 核对每个源的**成交额单位**（元 vs 万元）与 **`399001.SZ` vs `399106.SZ` 的成交额口径差异**。
   - 在 3 秒、5 秒间隔下进行有界压测（如连续 20 次批量请求），记录响应延迟、是否触发限流/403/空包，确定默认安全刷新频率与备用源优先级。
2. 若本机已配置同花顺 API Key，执行最小有界探测（仅查交易日历 + 单条搜索 + 指数快照）核对真实字段与延迟；未配置则按契约标注待用户填入后验证。
3. 验证目标 Electron 版本内嵌 Node 是否直接支持 `node:sqlite`（无需 MSVC 编译）；若不稳定，验证 `sql.js`（纯 WASM）或预编译二进制方案并定型。
4. 将全部实测数据与最终选型写入 `docs/DATA_SOURCES.md`。

**Completion Criteria**：
- `docs/DATA_SOURCES.md` 完整记录：主公开源、备用公开源、同花顺辅助源的精确 URL/参数/响应字段映射、成交额单位换算系数、`399001.SZ` 口径实测结论、推荐默认安全轮询间隔、以及无 MSVC 编译的 SQLite 方案结论。

---

### Phase 1：工程脚手架、本地持久化与安全凭据层

**目标**：搭建可运行、可类型检查、可单测的 Electron + React + TypeScript 骨架及本地数据层。

**任务**：
1. 初始化 `package.json`、`tsconfig.json`、`electron-vite`（或 Vite + tsc）、`vitest`、`electron-builder`（配置 Windows `portable` 目标）。
2. 实现 `src/main/storage/database.ts`（采用 Phase 0 定型的零 MSVC SQLite 方案），建表：
   - `trading_days(date TEXT PRIMARY KEY, is_open INTEGER)`
   - `intraday_bars(symbol TEXT, trade_date TEXT, minute_index INTEGER, minute_str TEXT, price REAL, cum_volume REAL, cum_turnover REAL, bar_turnover REAL, source TEXT, PRIMARY KEY(symbol, trade_date, minute_index))`
   - `auction_snapshots(symbol TEXT, trade_date TEXT, open_price REAL, auction_turnover REAL, captured_at INTEGER, PRIMARY KEY(symbol, trade_date))`
   - `watchlist(symbol TEXT PRIMARY KEY, name TEXT, sort_order INTEGER, alert_enabled INTEGER, custom_thresholds_json TEXT)`
   - `alert_events(id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, name TEXT, trade_date TEXT, minute_index INTEGER, direction TEXT, slope REAL, window_multiple REAL, cum_ratio REAL, message TEXT, created_at INTEGER)`
   - `app_settings(key TEXT PRIMARY KEY, value_json TEXT)`
3. 实现 **30 个交易日滚动清理**（启动及每日收盘后按 `trading_days` 保留最近 30 个交易日的 `intraday_bars`、`auction_snapshots` 与 `alert_events`）。
4. 实现 `src/main/storage/secretStore.ts`：按 `safeStorage` 加密存储 → `HITHINK_FINANCE_API_KEY` → `%APPDATA%\hithink-finance\credentials.env` 顺序读取同花顺 Key，且提供脱敏状态查询（只返回是否已配置与来源，永不回传明文给日志）。

**Completion Criteria**：
- `npm install` 在无 MSVC 环境下零报错完成。
- `npm run typecheck`、`npm run test`、最小 Electron 空窗体 `npm run dev` 均可启动通过。
- SQLite 建表、读写与 30 交易日清理逻辑有对应单元测试且全部通过。

---

### Phase 2：纯 TypeScript 核心领域引擎（时间轴、聚合、放缩量、斜率与告警）

**目标**：在不依赖任何网络或 UI 的前提下，将所有金融计算逻辑做扎实、可复现、全边界覆盖。

**任务**：
1. `src/core/tradingClock.ts`：
   - 识别当前市场阶段：`PRE_MARKET`、`OPEN_AUCTION (09:15–09:25)`、`AUCTION_GAP (09:25–09:30)`、`MORNING_SESSION (09:30–11:30)`、`LUNCH_BREAK (11:30–13:00)`、`AFTERNOON_SESSION (13:00–15:00)`、`POST_MARKET`、`CLOSED_DAY`。
   - 提供 `timestampToMinuteIndex()` 与 `minuteIndexToLabel()`（严格折叠午休）。
2. `src/core/marketAggregator.ts`：
   - 由 `000001.SH` 与 `399106.SZ` 合成虚拟聚合标的 `MARKET_TOTAL`（沪深两市总成交额），并校验双边时间对齐与缺失标记（任一侧缺失则标记 `degraded`，不以半边数据冒充全市场）。
3. `src/core/energyEngine.ts`：
   - 实现第 2.3 节的全部计算：未闭合分钟线性插值对齐昨日同期、累计同比 $\Delta A(t)$ 与 $R(t)$、全天预测成交额 $\hat{A}_{\text{full}}(t)$、放/平/缩量状态、OLS 滚动斜率 $S_W(t)$、滚动区间增量倍数 $M_W(t)$。
   - 同时支持**大盘聚合、四大指数与任意个股**。
4. `src/core/alertEngine.ts`：
   - 实现冷启动保护（`minuteIndex < 5` 不触发）、快速放量/快速缩量双指标触发、全局默认阈值 + 单股覆写、按 `(symbol, direction)` 的冷却防抖（默认 5 分钟）。

**Completion Criteria**：
- `tests/core/` 覆盖：开盘竞价 `09:25`、冷启动 `09:30–09:34`、跨午休 `11:28→13:02` 滚动斜率连续性、未闭合分钟第 10 秒插值防误报、`000001.SH + 399106.SZ` 防重复累加与单边缺失降级、冷却期内抑制重复触发与跨方向即时触发、昨日同期缺失时的安全降级。
- 所有 `vitest` 用例 100% 通过。

---

### Phase 3：混合双源采集器与自适应分层调度

**目标**：构建稳定的行情采集管线，兼顾秒级新鲜度与零封禁风险。

**任务**：
1. 定义 `MarketDataProvider` 接口：`fetchBatchSnapshots(symbols)`、`fetchIntradayMinutes(symbol, days)`、`searchTickers(keyword)`、`healthCheck()`。
2. 按 `docs/DATA_SOURCES.md` 实现：
   - 主公开源适配器（批量快照 + 2 日 1 分钟分时拉取 + 单位标准化）。
   - 备用公开源适配器（故障转移）。
   - `HithinkProvider`（交易日历缓存、标的搜索、低频校验/全公开源失效时的限速兜底）。
3. 实现 `PollingScheduler`：
   - 启动/盘前初始化：加载交易日历 → 确定 `today` 与 `prevTradingDate` → 检查 SQLite 缓存，缺失则从公开源一次性补齐昨日完整 240 分钟与今日已过分钟。
   - 交易时段：按配置周期（默认 Phase 0 实测安全值，如 3~5 秒）批量拉取全部监控标的（5 个指数 + 全部自选股），实时更新内存态并推送 IPC；每分钟闭合时持久化 `intraday_bars`；`09:25–09:26` 捕获并持久化开盘竞价。
   - 自适应退避：连续错误或 HTTP 429/403 时自动翻倍退避（`3s → 6s → 12s`）并切备用源，恢复后平滑回升；同花顺 `code=4001` 严格退避最多 3 次。
   - 午休与盘后/休市：自动停止高频轮询，进入低功耗复盘模式（展示最近交易日完整收盘曲线）。

**Completion Criteria**：
- 模拟/真实测试验证：盘中任意时刻启动（如 10:35）能自动补齐 `09:30–10:35` 及昨日全天曲线；盘后启动能自动展示最近交易日复盘数据且零高频轮询；主源故障注入时自动无缝切至备用源并在 UI 状态字段暴露当前源与延迟。

---

### Phase 4：Electron 桌面外壳（双态悬浮窗、系统托盘与告警通道）

**目标**：打造真正好用的 Windows 看盘桌面体验。

**任务**：
1. **紧凑 HUD 悬浮窗**：无边框 (`frame: false`)、透明圆角 (`transparent: true`)、置顶 (`alwaysOnTop: true`)、不占任务栏 (`skipTaskbar: true`)、自定义标题拖拽区、记忆上次屏幕坐标与透明度（30%~100%）。
2. **详情浮层窗口**：点击 HUD 展开按钮或双击/点击任意标的弹出（自动贴近 HUD 或屏幕居中显示，失焦不强制销毁以便持续看图，支持 `Esc` 或点击收起）。
3. **Windows 系统托盘 (`Tray`)**：右键菜单（显示/隐藏悬浮窗、展开详情、置顶开关、静音开关、手动刷新、开机/设置、退出）；鼠标悬停托盘 Tooltip 显示当前两市总成交额与放缩状态。
4. **全局老板键**：通过 `globalShortcut` 注册（默认 `Alt+Shift+A`，支持设置页改键与冲突提示），一键隐藏/恢复所有窗口。
5. **多通道提醒**：
   - `main` 触发 `AlertEvent` 时：写库 → 发 Windows 原生 `Notification`（带标的名、方向、斜率与区间倍数）→ 通过 IPC 通知 HUD 触发呼吸高亮 + 播放渲染进程 Web Audio 区分音（静音时不发声）。

**Completion Criteria**：
- Windows 本地实测：悬浮窗可拖拽置顶半透明且不遮挡任务栏；老板键一键显隐有效；关闭主界面仅最小化至托盘；触发模拟告警时呼吸高亮、Windows 通知、短提示音（可静音）与事件流同步生效。

---

### Phase 5：React + ECharts 看板界面与交互完善

**目标**：实现高信息密度、低视觉疲劳的暗色交易 HUD 与可交互详情看板。

**任务**：
1. **紧凑 HUD 视图（`src/renderer/hud/`）**：
   - 顶部 Hero 区：`沪深两市总成交额` + 较昨日同期（`+12.4% / +842亿`）+ `预测全天 1.62万亿` + 趋势斜率箭头（急放红脉冲 / 急缩绿脉冲）。
   - 四大指数精简行：上证、深证成指、创业板指、科创50（点位、涨跌幅、成交额及口径角标、放缩量徽章）。
   - 自选股精简列表（可滚动/折叠）：名称/代码、现价、涨跌幅、成交额、放缩量徽章。
   - 底部极简状态条：数据源标识、最近更新时间、延迟/降级提示、静音/透明度/展开快捷按钮。
2. **详情浮层视图（`src/renderer/detail/`）**：
   - **分时能量对比图（ECharts 双图联动）**：
     - 上图：今日累计成交额实线 vs 昨日同期累计成交额虚线（中间放量区淡红填充、缩量区淡绿填充）+ 右轴叠加实时指数点位/个股分时价；`09:25` 竞价锚点标记；午休无缝折叠。
     - 下图：1 分钟增量对比柱状图（今 vs 昨）+ 滚动 5 分钟斜率曲线 + 异动提醒散点标记。
   - **自选股配置面板**：输入框按代码/中文名搜索（同花顺元信息优先、公开源兜底）添加、删除、拖拽/上下调整排序、单股提醒开关与自定义阈值弹窗。
   - **今日异动事件流**：按时间倒序展示所有快速放量/缩量触发记录，点击可一键定位该标的图表。
   - **设置面板**：刷新周期（3~15 秒）、放/平/缩判定阈值、斜率窗口（3/5/10 分钟）与急放/急缩阈值、冷却分钟数、全局老板键、HUD 透明度、提示音开关、同花顺 API Key 输入与连接测试（通过 `safeStorage` 加密落盘，仅显示已配置状态）、本地数据库 30 天留存统计。

**Completion Criteria**：
- HUD 与详情浮层切换丝滑，ECharts 在 3 秒高频更新下无闪烁、无内存泄漏（复用 ECharts 实例 `setOption` 增量更新）。
- 自选股增删改排、阈值微调、API Key 保存重启后均持久生效。
- A 股红涨绿跌色彩、无数据时显式降级提示全部符合规范。

---

### Phase 6：全链路复盘验证与 Windows 便携版打包

**目标**：确保端到端质量与最终便携交付物可用。

**任务**：
1. 编写基于真实录制日行情的回放验证模式（开发态 `--replay` 或测试脚本），完整跑通一遍 09:25 → 15:00 全天回放，验证聚合口径、跨午休斜率、快速放/缩量告警与 UI 渲染。
2. 执行全套质量门禁：`npm run typecheck`、`npm run test`、`npm run build`。
3. 执行 `electron-builder` 打包 Windows 便携版 `.exe`（输出至 `release/`），在干净目录启动验证托盘、悬浮窗、配置落盘与数据刷新。

**Completion Criteria**：
- 类型检查 0 错误、单元测试 100% 通过、回放验证无异常。
- 成功产出可独立双击运行的 Windows 便携版 `.exe`（无本机源码目录依赖），且工作区无明文密钥或临时数据库泄漏。
