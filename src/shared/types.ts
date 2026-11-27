import type { CoreIndexSymbol, IndexScopeBadge, OptionalIndexSymbol } from './constants';

/**
 * 前后端共享数据类型与 SQLite 持久化行契约
 */

export type AlertDirection = 'SURGE' | 'SHRINK';

export type ProviderId = 'tencent' | 'sina' | 'eastmoney' | 'hithink';

export type CalendarSource = 'sqlite_cache' | 'hithink' | 'inferred_degraded';

export type CollectorMode = 'LIVE' | 'REPLAY' | 'IDLE';

export type MarketPhaseType =
  | 'PRE_MARKET'
  | 'OPEN_AUCTION'
  | 'AUCTION_GAP'
  | 'MORNING_SESSION'
  | 'LUNCH_BREAK'
  | 'AFTERNOON_SESSION'
  | 'POST_MARKET'
  | 'CLOSED_DAY';

export type VolumeStateType = 'EXPANDING' | 'FLAT' | 'SHRINKING' | 'UNAVAILABLE';

/** 标准化单标的实时快照（金额统一为人民币元，成交量统一为股） */
export interface QuoteSnapshot {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  changeAmt: number;
  /** 涨跌幅百分比数值（如 1.46 表示 +1.46%） */
  changePct: number;
  /** 累计成交量（股） */
  volumeShares: number;
  /** 累计成交额（人民币元） */
  turnover: number;
  /** 行情交易日 YYYY-MM-DD */
  tradeDate: string;
  /** 行情时间戳（按北京时间解析的 Unix 毫秒） */
  timestampMs: number;
  source: ProviderId;
}

/** 标准化单日 1 分钟分时基线数据 */
export interface IntradayDayData {
  symbol: string;
  tradeDate: string;
  prevClose: number | null;
  auction: {
    openPrice: number;
    auctionTurnover: number;
  } | null;
  bars: IntradayBarRow[];
  source: ProviderId;
}

/** 标准化标的搜索结果 */
export interface TickerSearchResult {
  symbol: string;
  ticker: string;
  name: string;
  exchange: 'SH' | 'SZ';
  assetType: 'STOCK' | 'INDEX';
  source: ProviderId;
}

/** 单数据源健康检查结果 */
export interface ProviderHealthStatus {
  provider: ProviderId;
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

/** 能量计算指标快照（与 src/core/energyEngine.ts EnergyMetrics 结构同构） */
export interface SymbolEnergyMetricsView {
  minuteIndex: number;
  elapsedSeconds: number;
  todayCumTurnover: number | null;
  prevAlignedCumTurnover: number | null;
  cumDiff: number | null;
  cumRatio: number | null;
  cumRatioPct: number | null;
  predictedFullDayTurnover: number | null;
  volumeState: VolumeStateType;
  slope: number | null;
  windowMultiple: number | null;
  windowDeviationPct: number | null;
  slopeWindow: number;
}

/** 单标的（四大核心指数 / 自选股）看板状态 */
export interface SymbolEnergySnapshot {
  symbol: string;
  name: string;
  isIndex: boolean;
  scope?: IndexScopeBadge;
  scopeDetail?: string;
  quote: QuoteSnapshot | null;
  metrics: SymbolEnergyMetricsView | null;
  auctionTurnover: number | null;
  prevAuctionTurnover: number | null;
  prevFullDayTurnover: number | null;
  todaySeries: IntradayBarRow[];
  prevSeries: IntradayBarRow[];
  degraded: boolean;
  degradedReason: string | null;
}

/** 沪深两市聚合分时点 */
export interface MarketTotalBarPoint {
  minuteIndex: number;
  cumTurnover: number;
  barTurnover: number | null;
}

/** 沪深两市总成交额看板状态 */
export interface MarketTotalState {
  symbol: 'MARKET_TOTAL';
  name: string;
  tradeDate: string | null;
  prevTradeDate: string | null;
  cumTurnover: number | null;
  shTurnover: number | null;
  szTurnover: number | null;
  auctionTurnover: number | null;
  prevAuctionTurnover: number | null;
  prevFullDayTurnover: number | null;
  metrics: SymbolEnergyMetricsView | null;
  todaySeries: MarketTotalBarPoint[];
  prevSeries: MarketTotalBarPoint[];
  /** 上证指数点位参考（用于当上证指数卡片被隐藏时，沪深两市分时图右轴仍可叠加「上证点位」） */
  shReference?: {
    todaySeries: IntradayBarRow[];
    minuteIndex: number | null;
    livePrice: number | null;
  } | null;
  degraded: boolean;
  degradedReason: string | null;
}

/** 开发态全天历史回放进度元信息 */
export interface ReplayStatusInfo {
  active: boolean;
  tradeDate: string;
  prevTradeDate: string | null;
  /** 当前帧序号（0 = 09:25 集合竞价，1..240 = minuteIndex 0..239） */
  stepIndex: number;
  totalSteps: number;
  currentTimeLabel: string;
  stepIntervalMs: number;
  finished: boolean;
}

/** 采集调度器与数据源运行态（向渲染进程暴露） */
export interface CollectorStatus {
  mode: CollectorMode;
  phase: MarketPhaseType;
  tradeDate: string | null;
  prevTradeDate: string | null;
  activeSnapshotProvider: ProviderId | null;
  activeIntradayProvider: ProviderId | null;
  calendarSource: CalendarSource;
  calendarDegraded: boolean;
  pollingIntervalSec: number;
  configuredIntervalSec: number;
  lastUpdatedAt: number | null;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  stale: boolean;
  degraded: boolean;
  degradedReasons: string[];
  /** 仅在 --replay 全天回放模式下存在 */
  replay?: ReplayStatusInfo | null;
}

/** 推送给渲染进程的完整看板状态 */
export interface MarketDashboardState {
  status: CollectorStatus;
  marketTotal: MarketTotalState;
  indices: SymbolEnergySnapshot[];
  watchlist: SymbolEnergySnapshot[];
  recentAlerts: AlertEventInput[];
}

export type SecretSource = 'safeStorage' | 'env' | 'credentialsFile' | 'none';

/** 脱敏后的同花顺 API Key 配置状态（严禁包含任何明文或片段） */
export interface SecretStatus {
  configured: boolean;
  source: SecretSource;
  encryptionAvailable: boolean;
}

/** trading_days 表记录（date 统一采用 YYYY-MM-DD 格式） */
export interface TradingDayRow {
  date: string;
  isOpen: boolean;
}

/** intraday_bars 表记录 */
export interface IntradayBarRow {
  symbol: string;
  tradeDate: string;
  minuteIndex: number;
  minuteStr: string;
  price: number;
  cumVolume: number;
  cumTurnover: number;
  barTurnover: number;
  source: string;
}

/** auction_snapshots 表记录 */
export interface AuctionSnapshotRow {
  symbol: string;
  tradeDate: string;
  openPrice: number;
  auctionTurnover: number;
  capturedAt: number;
}

/** watchlist 表记录 */
export interface WatchlistItemRow {
  symbol: string;
  name: string;
  sortOrder: number;
  alertEnabled: boolean;
  customThresholdsJson: string | null;
}

/** alert_events 表记录（写入时不含 id，读取时包含自增 id） */
export interface AlertEventInput {
  symbol: string;
  name: string;
  tradeDate: string;
  minuteIndex: number;
  direction: AlertDirection;
  slope: number;
  windowMultiple: number;
  cumRatio: number;
  message: string;
  createdAt: number;
}

export interface AlertEventRow extends AlertEventInput {
  id: number;
  /** 是否已读（新产生告警默认为 false） */
  isRead: boolean;
}

/** 经主进程告警通道广播给渲染进程的完整告警载荷 */
export interface AlertDispatchPayload extends AlertEventRow {
  /** 是否为开发态模拟测试事件 */
  isSimulated: boolean;
  /** 是否为 --replay 全天历史回放事件（不写入实盘 alert_events、不弹系统通知） */
  isReplay?: boolean;
  /** 派发瞬间应用是否处于静音状态（静音时渲染进程不播放提示音） */
  muted: boolean;
}

/** 窗口左上角屏幕坐标 */
export interface WindowPosition {
  x: number;
  y: number;
}

/** 详情浮层页签 */
export type DetailTab = 'chart' | 'watchlist' | 'alerts' | 'sentiment' | 'settings';

/** 打开详情浮层的可选参数 */
export interface OpenDetailOptions {
  symbol?: string;
  tab?: DetailTab;
}

/** 悬浮窗展示模式 */
export type HudMode = 'standard' | 'minimal';

/** 持久化在 app_settings 中的桌面外壳设置 */
export interface DesktopShellSettings {
  hudPosition: WindowPosition | null;
  hudOpacity: number;
  alwaysOnTop: boolean;
  muted: boolean;
  bossKey: string;
  autoLaunch: boolean;
  hudMode: HudMode;
}

/** 全局老板键注册状态 */
export interface BossKeyStatus {
  accelerator: string;
  registered: boolean;
  conflictMessage: string | null;
}

/** 桌面外壳运行态（同步给 HUD 与详情浮层） */
export interface DesktopShellState {
  settings: DesktopShellSettings;
  bossKeyStatus: BossKeyStatus;
  hudVisible: boolean;
  detailVisible: boolean;
  activeDetailSymbol: string;
  activeDetailTab: DetailTab;
  /** 每次主进程主动打开/导航详情浮层时递增，避免普通设置同步覆盖用户当前页签 */
  detailFocusSeq: number;
  isDev: boolean;
}

export type SlopeWindowOption = 3 | 5 | 10;

export type AlertMatchModeType = 'AND' | 'OR';

/** 监控与告警全局配置（存入 SQLite app_settings，修改后即时作用于调度与告警引擎） */
export interface MonitorConfig {
  /** 盘中快照轮询周期（3–15 秒） */
  pollingIntervalSec: number;
  /** 放量判定阈值（百分比，如 5 表示 +5%） */
  expandThresholdPct: number;
  /** 缩量判定阈值（百分比，如 -5 表示 -5%） */
  shrinkThresholdPct: number;
  /** 滚动斜率与区间倍数窗口（3 / 5 / 10 分钟） */
  slopeWindow: SlopeWindowOption;
  /** 全局告警总开关 */
  alertsEnabled: boolean;
  /** 快速放量斜率阈值（百分点/分钟，正数） */
  surgeSlopeThreshold: number;
  /** 快速放量区间增量倍数阈值（> 1） */
  surgeMultipleThreshold: number;
  /** 快速缩量斜率阈值（百分点/分钟，负数） */
  shrinkSlopeThreshold: number;
  /** 快速缩量区间增量倍数阈值（0 < x < 1） */
  shrinkMultipleThreshold: number;
  /** 双指标触发组合模式（AND=且，OR=或） */
  matchMode: AlertMatchModeType;
  /** 同标的同方向冷却时长（分钟） */
  cooldownMinutes: number;
  /** 设置中开启展示的主要板块指数（上证 / 深证成指 / 创业板指 / 科创综指），默认全部开启，可逐项关闭 */
  enabledCoreIndices: CoreIndexSymbol[];
  /** 设置中开启展示的可选扩展指数（上证50 / 沪深300 / 中证1000 / 科创50），默认为空（全部关闭） */
  enabledOptionalIndices: OptionalIndexSymbol[];
}

/** 单只自选股自定义告警阈值覆写（序列化存入 watchlist.custom_thresholds_json） */
export interface WatchlistThresholdOverride {
  slopeWindow?: SlopeWindowOption;
  surgeSlopeThreshold?: number;
  surgeMultipleThreshold?: number;
  shrinkSlopeThreshold?: number;
  shrinkMultipleThreshold?: number;
  matchMode?: AlertMatchModeType;
  cooldownMinutes?: number;
}

export interface WatchlistAddInput {
  symbol: string;
  name: string;
}

export interface WatchlistUpdateInput {
  symbol: string;
  alertEnabled?: boolean;
  /** 传入 null 表示清除自定义阈值，恢复跟随全局默认 */
  customThresholds?: WatchlistThresholdOverride | null;
}

/** 30 交易日滚动清理执行结果 */
export interface PruneResult {
  pruned: boolean;
  keepDays: number;
  openTradingDaysCount: number;
  cutoffDate: string | null;
  deleted: {
    intradayBars: number;
    auctionSnapshots: number;
    alertEvents: number;
  };
}

/** 数据库留存统计 */
export interface DatabaseRetentionStats {
  tradingDaysCount: number;
  intradayBarsCount: number;
  auctionSnapshotsCount: number;
  watchlistCount: number;
  alertEventsCount: number;
  distinctBarDatesCount: number;
}

/** Phase 1 最小启动状态（供空窗体验证主进程/预加载桥接） */
export interface BootstrapState {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  dbReady: boolean;
  retention: DatabaseRetentionStats;
  secretStatus: SecretStatus;
}

/** 本机定制：悬浮窗附加行数据（主进程 extras/builtinExtras.ts 内置取数） */
export interface HudExtras {
  kospi: { price: number; chg: number; pct: number; open: boolean; at: string; src: string } | null;
  wwd: { level: 'hot' | 'mid' | 'cool'; label: string; ratio: number; net: number; at: string } | null;
  limit: { zt: number | null; dt: number | null } | null;
  /** 上涨 / 平盘 / 下跌家数（沪深，不含北交所） */
  breadth?: { up: number; down: number; flat: number } | null;
  at?: string;
}

/** 本机定制：「情绪」页数据（主进程 extras/builtinExtras.ts 从东财涨停板行情中心取） */
export interface MarketSentiment {
  date: string;
  prevDate: string;
  at: string;
  up: number;
  down: number;
  flat: number;
  buckets: Array<{ label: string; count: number; side: 'up' | 'flat' | 'down' }>;
  limitUp: number;
  limitDown: number;
  broken: number;
  sealRate: number | null;
  prev: { limitUp: number; limitDown: number; sealRate: number | null };
  ladder: Array<{ label: string; count: number; rate: number | null }>;
  leaders: Array<{ code: string; name: string; boards: number; industry: string; breaks: number }>;
}
