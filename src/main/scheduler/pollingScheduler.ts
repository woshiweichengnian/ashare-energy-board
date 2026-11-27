import {
  AlertEngine,
  DEFAULT_ENERGY_CONFIG,
  aggregateMarketTotalAuction,
  aggregateMarketTotalSeries,
  aggregateMarketTotalSnapshot,
  evaluateEnergy,
  getElapsedSecondsInMinute,
  getMarketPhase,
  getPrevTradingDate,
  getShanghaiParts,
  minuteIndexToLabel,
  resolveAlertConfig,
  shanghaiToTimestampMs,
  timestampToMinuteIndex,
  type AlertRuleConfig,
  type EnergyEngineConfig,
  type IntradayPredictionProfile,
  type MarketPhase,
  type SymbolAlertOverride,
  type SymbolTurnoverSnapshot,
} from '../../core';
import {
  CORE_INDEX_SYMBOLS,
  DEFAULT_POLLING_INTERVAL_SEC,
  DEFAULT_RETENTION_TRADING_DAYS,
  FAILOVER_FAILURE_THRESHOLD,
  HITHINK_FALLBACK_MIN_INTERVAL_SEC,
  MARKET_TOTAL_COMPONENTS,
  MARKET_TOTAL_SYMBOL,
  MAX_BACKOFF_INTERVAL_SEC,
  MAX_POLLING_INTERVAL_SEC,
  MIN_POLLING_INTERVAL_SEC,
  MONITORED_INDEX_NAMES,
  PRIMARY_RECOVERY_PROBE_INTERVAL_MS,
  SETTING_CALENDAR_SYNC_DATE,
  SETTING_POST_CLOSE_RECONCILED,
  normalizeEnabledCoreIndices,
  normalizeEnabledOptionalIndices,
  resolveDisplayedIndices,
  resolveMonitoredIndexSymbols,
  type CoreIndexSymbol,
  type OptionalIndexSymbol,
} from '../../shared/constants';
import type {
  AlertEventInput,
  CalendarSource,
  CollectorMode,
  CollectorStatus,
  IntradayBarRow,
  IntradayDayData,
  MarketDashboardState,
  MarketTotalState,
  ProviderId,
  QuoteSnapshot,
  SymbolEnergySnapshot,
  TickerSearchResult,
  WatchlistItemRow,
} from '../../shared/types';
import {
  getCybScopeGroup,
  hasCybCrossSourceMismatch,
  toAggregatorBars,
} from '../../shared/seriesGuards';
import {
  ProviderRequestError,
  defaultSleep,
  type HithinkProvider,
  type MarketDataProvider,
  type SleepLike,
} from '../providers';
import type { AppDatabase } from '../storage/database';
import {
  loadMarketTotalPredictionProfile,
  loadSymbolPredictionProfile,
} from '../storage/predictionProfileLoader';
import type { SecretStore } from '../storage/secretStore';

const TOTAL_DAY_BARS = 240;
const MORNING_BARS = 120;
const NON_TRADING_WAKE_INTERVAL_MS = 30_000;
const IDLE_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
const BACKFILL_RETRY_COOLDOWN_MS = 120_000;
const CALENDAR_REPROBE_INTERVAL_MS = 30_000;
const UPSTREAM_SNAPSHOT_STALE_MIN_MS = 60_000;
const MAX_RECENT_ALERTS = 100;

const SEC_09_15 = 9 * 3600 + 15 * 60;
const SEC_09_25 = 9 * 3600 + 25 * 60;
const SEC_09_26 = 9 * 3600 + 26 * 60;
const SEC_09_35 = 9 * 3600 + 35 * 60;
const SEC_11_30 = 11 * 3600 + 30 * 60;
const SEC_11_31 = 11 * 3600 + 31 * 60;
const SEC_15_00 = 15 * 3600;
const SEC_15_00_SETTLE = 15 * 3600 + 15;
const SEC_15_02 = 15 * 3600 + 2 * 60;
const SEC_15_05 = 15 * 3600 + 5 * 60;
const SEC_15_10 = 15 * 3600 + 10 * 60;
const MAX_AUTO_POST_CLOSE_RECONCILE_ATTEMPTS = 2;

interface PostCloseReconciledRecord {
  tradeDate: string;
  symbols: string[];
}

interface PendingMinuteBar {
  minuteIndex: number;
  price: number;
  cumVolume: number;
  cumTurnover: number;
  source: ProviderId;
}

export interface PollingSchedulerOptions {
  database: AppDatabase;
  /** 可选保留参数（历史兼容，同花顺凭据由 hithinkProvider 内部读取） */
  secretStore?: Pick<SecretStore, 'getApiKey' | 'getStatus'>;
  primarySnapshotProvider: MarketDataProvider;
  secondarySnapshotProvider: MarketDataProvider;
  hithinkProvider: HithinkProvider;
  primaryIntradayProvider: MarketDataProvider;
  secondaryIntradayProvider: MarketDataProvider;
  configuredIntervalSec?: number;
  energyConfig?: Partial<EnergyEngineConfig>;
  alertConfig?: Partial<AlertRuleConfig>;
  enabledCoreIndices?: readonly CoreIndexSymbol[];
  enabledOptionalIndices?: readonly OptionalIndexSymbol[];
  /** 仅用于测试注入时钟，默认 Date.now */
  nowFn?: () => number;
  /** 仅用于测试注入等待函数 */
  sleepFn?: SleepLike;
  /** 仅用于测试控制单标补齐间隔，默认 150ms */
  backfillDelayMs?: number;
  /** 状态更新回调（主进程用于推送 IPC） */
  onStateUpdate?: (state: MarketDashboardState) => void;
  /** 告警事件派发入口（Phase 4 接入通知与提示音） */
  onAlertTriggered?: (event: AlertEventInput) => void;
}

function clampPollingInterval(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_POLLING_INTERVAL_SEC;
  return Math.max(MIN_POLLING_INTERVAL_SEC, Math.min(MAX_POLLING_INTERVAL_SEC, Math.round(sec)));
}

/** 获取 YYYY-MM-DD 对应的星期几（0=周日 .. 6=周六，独立于宿主机时区） */
function getDateWeekday(dateStr: string): number {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return 0;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

/** 计算给定日期 YYYY-MM-DD 的下一个自然日 YYYY-MM-DD */
function nextCalendarDate(dateStr: string): string {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateStr;
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 检查有序分钟序列是否存在缺口（含头部缺 09:30、内部跳号或尾部截断）。
 * 当 expectedLastClosedIndex < 0（如 09:30 第一分钟尚未闭合）时，空序列不视为缺口。
 */
function hasSeriesGap(
  bars: readonly { minuteIndex: number }[],
  expectedLastClosedIndex: number | null
): boolean {
  if (bars.length === 0) {
    return expectedLastClosedIndex !== null && expectedLastClosedIndex >= 0;
  }
  if (bars[0].minuteIndex > 0) {
    return true;
  }
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].minuteIndex !== bars[i - 1].minuteIndex + 1) {
      return true;
    }
  }
  if (
    expectedLastClosedIndex !== null &&
    expectedLastClosedIndex >= 0 &&
    bars[bars.length - 1].minuteIndex < expectedLastClosedIndex
  ) {
    return true;
  }
  return false;
}

/**
 * 将实时快照时间戳映射到连续交易分钟索引与秒数：
 * - 常规交易时间严格复用 src/core/tradingClock.ts
 * - 兼容上游真实延迟推送的午盘闭合（11:30:01–11:31:00 → 119）与收盘集合竞价（15:00:01–15:01:00 → 239）
 */
function resolveSnapshotMinute(
  timestampMs: number
): { minuteIndex: number; elapsedSeconds: number } | null {
  const directIdx = timestampToMinuteIndex(timestampMs);
  if (directIdx !== null) {
    return {
      minuteIndex: directIdx,
      elapsedSeconds: getElapsedSecondsInMinute(timestampMs) ?? 60,
    };
  }
  const { secondsOfDay } = getShanghaiParts(timestampMs);
  if (secondsOfDay > SEC_11_30 && secondsOfDay <= SEC_11_31) {
    return { minuteIndex: 119, elapsedSeconds: 60 };
  }
  if (secondsOfDay > SEC_15_00 && secondsOfDay <= SEC_15_05) {
    return { minuteIndex: 239, elapsedSeconds: 60 };
  }
  return null;
}

function parseWatchlistOverride(item: WatchlistItemRow): SymbolAlertOverride {
  const base: Partial<AlertRuleConfig> = { enabled: item.alertEnabled };
  if (!item.customThresholdsJson) return base;
  try {
    const parsed = JSON.parse(item.customThresholdsJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return base;
    return {
      ...parsed,
      enabled: item.alertEnabled,
    } as SymbolAlertOverride;
  } catch {
    return base;
  }
}

/**
 * 混合双源行情采集与自适应分层调度器：
 * - 启动/跨日加载交易日历（SQLite 当日缓存 → 同花顺 → 公开分时/快照降级推断）
 * - 自动按需补齐昨日完整 240 分钟及今日已过分钟并落盘 SQLite（绝不补零）
 * - 交易时段按配置周期批量轮询 5 指数 + 实时自选股，调用 src/core/ 计算能量与告警
 * - 遇错误或 429/403 指数退避并自动主备切换（腾讯 → 新浪 → 同花顺低频兜底），主/备源恢复后回切与回落
 * - 午休、盘后、休市自动停止高频轮询并进入复盘模式，保留纯本地时钟轻量唤醒以便次日自动开盘，收盘后执行 30 交易日滚动清理
 */

export class PollingScheduler {
  private readonly db: AppDatabase;
  private readonly primarySnapshot: MarketDataProvider;
  private readonly secondarySnapshot: MarketDataProvider;
  private readonly hithink: HithinkProvider;
  private readonly primaryIntraday: MarketDataProvider;
  private readonly secondaryIntraday: MarketDataProvider;
  private readonly nowFn: () => number;
  private readonly sleepFn: SleepLike;
  private readonly backfillDelayMs: number;
  private readonly onStateUpdate?: (state: MarketDashboardState) => void;
  private readonly onAlertTriggered?: (event: AlertEventInput) => void;

  private readonly alertEngine: AlertEngine;
  private energyConfig: EnergyEngineConfig;
  private enabledCoreIndices: CoreIndexSymbol[] = [...CORE_INDEX_SYMBOLS];
  private enabledOptionalIndices: OptionalIndexSymbol[] = [];
  private configuredIntervalSec: number;
  private effectiveIntervalSec: number;

  private running = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight: Promise<MarketDashboardState> | null = null;
  private queuedRefresh: Promise<MarketDashboardState> | null = null;
  private configRevision = 0;
  private lastTickConfigRevision = 0;

  private openTradingDays: string[] = [];
  private openTradingDaySet = new Set<string>();
  private calendarSource: CalendarSource = 'sqlite_cache';
  private calendarDegraded = false;
  private calendarNeedsTodayReprobe = false;
  private calendarForceReload = false;
  private lastCalendarReprobeAt = 0;
  private initializedForDate: string | null = null;
  private lastPrunedDate: string | null = null;

  private displayTradeDate: string | null = null;
  private prevTradeDate: string | null = null;
  private activeDisplayDate: string | null = null;
  private activePrevDate: string | null = null;
  private lastWatchlistSignature = '';
  private mode: CollectorMode = 'IDLE';
  private lastPhase: MarketPhase = 'CLOSED_DAY';

  private activeSnapshotProvider: ProviderId;
  private activeIntradayProvider: ProviderId | null = null;
  private consecutiveFailures = 0;
  private lastPrimaryProbeAt = 0;
  private lastUpdatedAt: number | null = null;
  private lastLatencyMs: number | null = null;

  private readonly latestSnapshots = new Map<string, QuoteSnapshot>();
  private readonly todayBars = new Map<string, IntradayBarRow[]>();
  private readonly prevBars = new Map<string, IntradayBarRow[]>();
  private readonly todayAuctions = new Map<string, { openPrice: number; auctionTurnover: number }>();
  private readonly prevAuctions = new Map<string, { openPrice: number; auctionTurnover: number }>();
  private readonly pendingBars = new Map<string, PendingMinuteBar>();
  private readonly loadedFromDbSymbols = new Set<string>();
  private readonly predictionProfiles = new Map<string, IntradayPredictionProfile | null>();
  private readonly lastBackfillAttemptAt = new Map<string, number>();
  private readonly intradaySourceBySymbol = new Map<string, ProviderId>();
  private readonly cybRealignedGroups = new Set<string>();
  private postCloseReconciledDate: string | null = null;
  private readonly postCloseReconciledSymbols = new Set<string>();
  private readonly postCloseReconcileAttempts = new Map<string, number>();
  private postCloseSettleSnapshotDoneDate: string | null = null;
  private postCloseForceReconcilePending = false;
  private readonly recentAlerts: AlertEventInput[] = [];
  private latestState: MarketDashboardState | null = null;

  constructor(options: PollingSchedulerOptions) {
    this.db = options.database;
    this.primarySnapshot = options.primarySnapshotProvider;
    this.secondarySnapshot = options.secondarySnapshotProvider;
    this.hithink = options.hithinkProvider;
    this.primaryIntraday = options.primaryIntradayProvider;
    this.secondaryIntraday = options.secondaryIntradayProvider;
    this.activeSnapshotProvider = options.primarySnapshotProvider.id;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.sleepFn = options.sleepFn ?? defaultSleep;
    this.backfillDelayMs = options.backfillDelayMs ?? 150;
    this.onStateUpdate = options.onStateUpdate;
    this.onAlertTriggered = options.onAlertTriggered;

    this.configuredIntervalSec = clampPollingInterval(
      options.configuredIntervalSec ?? DEFAULT_POLLING_INTERVAL_SEC
    );
    this.effectiveIntervalSec = this.configuredIntervalSec;
    this.energyConfig = {
      ...DEFAULT_ENERGY_CONFIG,
      ...(options.energyConfig ?? {}),
    };
    this.alertEngine = new AlertEngine({
      ...(options.energyConfig?.slopeWindow !== undefined
        ? { slopeWindow: options.energyConfig.slopeWindow }
        : {}),
      ...(options.alertConfig ?? {}),
    });
    this.enabledCoreIndices =
      options.enabledCoreIndices === undefined
        ? [...CORE_INDEX_SYMBOLS]
        : normalizeEnabledCoreIndices(options.enabledCoreIndices);
    this.enabledOptionalIndices = normalizeEnabledOptionalIndices(options.enabledOptionalIndices);
  }

  /** 启动调度器并立即执行一次初始化与状态计算 */
  async start(): Promise<MarketDashboardState> {
    this.stopped = false;
    this.running = true;
    const state = await this.tickOnce();
    if (this.running && !this.stopped) {
      this.scheduleNextTick();
    }
    return state;
  }

  /** 停止所有定时轮询并落盘尚未闭合的待提交分钟线（之后在途异步回调不再触碰 SQLite） */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.stopped) {
      this.flushAllPendingBars();
      this.stopped = true;
    }
  }

  getLatestState(): MarketDashboardState | null {
    return this.latestState;
  }

  updatePollingInterval(intervalSec: number): void {
    this.configuredIntervalSec = clampPollingInterval(intervalSec);
    this.configRevision += 1;
    if (this.activeSnapshotProvider !== 'hithink') {
      this.effectiveIntervalSec =
        this.consecutiveFailures > 0
          ? Math.max(this.configuredIntervalSec, this.effectiveIntervalSec)
          : this.configuredIntervalSec;
    }
    if (this.running && !this.stopped) {
      this.scheduleNextTick();
    }
  }

  updateEnergyConfig(next: Partial<EnergyEngineConfig>): void {
    this.energyConfig = {
      ...this.energyConfig,
      ...next,
    };
    this.configRevision += 1;
    if (next.slopeWindow !== undefined) {
      this.alertEngine.updateGlobalConfig({ slopeWindow: next.slopeWindow });
    }
  }

  updateAlertConfig(next: Partial<AlertRuleConfig>): void {
    this.alertEngine.updateGlobalConfig(next);
    this.configRevision += 1;
    if (next.slopeWindow !== undefined) {
      this.energyConfig = {
        ...this.energyConfig,
        slopeWindow: next.slopeWindow,
      };
    }
  }

  updateEnabledCoreIndices(next: readonly CoreIndexSymbol[]): void {
    const normalized = normalizeEnabledCoreIndices(next);
    const unchanged =
      normalized.length === this.enabledCoreIndices.length &&
      normalized.every((sym, idx) => sym === this.enabledCoreIndices[idx]);
    if (unchanged) return;
    this.enabledCoreIndices = normalized;
    this.configRevision += 1;
  }

  updateEnabledOptionalIndices(next: readonly OptionalIndexSymbol[]): void {
    const normalized = normalizeEnabledOptionalIndices(next);
    const unchanged =
      normalized.length === this.enabledOptionalIndices.length &&
      normalized.every((sym, idx) => sym === this.enabledOptionalIndices[idx]);
    if (unchanged) return;
    this.enabledOptionalIndices = normalized;
    this.configRevision += 1;
  }

  /** 按优先级执行标的搜索（同花顺权威优先 → 东财快速联想 → 腾讯兜底） */
  async searchTickers(keyword: string, limit = 10): Promise<TickerSearchResult[]> {
    const trimmed = keyword.trim();
    if (!trimmed) return [];

    if (this.hithink.isConfigured()) {
      try {
        const res = await this.hithink.searchTickers(trimmed, limit);
        if (res.length > 0) return res;
      } catch {
        // 降级至公开联想源
      }
    }

    try {
      const emRes = await this.secondaryIntraday.searchTickers(trimmed, limit);
      if (emRes.length > 0) return emRes;
    } catch {
      // 继续降级至腾讯
    }

    try {
      return await this.primarySnapshot.searchTickers(trimmed, limit);
    } catch {
      return [];
    }
  }

  /** 凭据变更（如保存同花顺 Key）后强制重载权威交易日历并即时重算看板状态 */
  async refreshCalendarNow(): Promise<MarketDashboardState> {
    this.calendarForceReload = true;
    this.calendarNeedsTodayReprobe = false;
    this.configRevision += 1;
    return this.refreshNow();
  }

  /**
   * 手动/配置变更后立即刷新一次：
   * - 若当前已有在途轮询，排队合并为一次紧随其后的新鲜 tick，避免吞掉刚落盘的自选股或参数改动
   * - 传入 forceReconcile=true（用户手动点「刷新」）时，在盘后/复盘态会强制重新拉取权威收盘分时校正尾盘竞价
   * - 若调度器处于运行态则顺便重置下一次定时唤醒
   */
  async refreshNow(options?: { forceReconcile?: boolean }): Promise<MarketDashboardState> {
    if (options?.forceReconcile) {
      this.postCloseForceReconcilePending = true;
      this.postCloseSettleSnapshotDoneDate = null;
      this.postCloseReconciledSymbols.clear();
      this.postCloseReconcileAttempts.clear();
      this.lastBackfillAttemptAt.clear();
      this.configRevision += 1;
    }

    let state: MarketDashboardState;
    if (this.pollInFlight) {
      if (!this.queuedRefresh) {
        this.queuedRefresh = this.pollInFlight
          .catch(() => undefined)
          .then(() => {
            this.queuedRefresh = null;
            return this.tickOnce();
          });
      }
      state = await this.queuedRefresh;
    } else {
      state = await this.tickOnce();
    }

    if (this.running && !this.stopped) {
      this.scheduleNextTick();
    }
    return state;
  }

  /** 立即执行一次完整周期（初始化/跨日检查 → 按需补齐 → 交易时段拉快照或非交易时段复盘） */
  async tickOnce(): Promise<MarketDashboardState> {
    if (this.pollInFlight) {
      return this.pollInFlight;
    }

    const run = this.executeTick().finally(() => {
      this.pollInFlight = null;
    });
    this.pollInFlight = run;
    return run;
  }

  private computeNextWakeDelayMs(nowMs: number): number {
    if (this.mode === 'LIVE') {
      return this.effectiveIntervalSec * 1000;
    }

    const { dateStr: todayStr } = getShanghaiParts(nowMs);

    if (this.lastPhase === 'PRE_MARKET') {
      const openAuctionMs = shanghaiToTimestampMs(todayStr, 9, 15, 0);
      const remaining = openAuctionMs - nowMs;
      if (remaining > 0) {
        return Math.max(1_000, Math.min(NON_TRADING_WAKE_INTERVAL_MS, remaining));
      }
      return 1_000;
    }

    if (this.lastPhase === 'LUNCH_BREAK') {
      const afternoonOpenMs = shanghaiToTimestampMs(todayStr, 13, 0, 0);
      const remaining = afternoonOpenMs - nowMs;
      if (remaining > 0) {
        return Math.max(1_000, Math.min(NON_TRADING_WAKE_INTERVAL_MS, remaining));
      }
      return 1_000;
    }

    // 工作日开盘窗内待确认今日是否开市（无 Key 降级场景）：30s 轻量检查
    if (this.calendarNeedsTodayReprobe) {
      return NON_TRADING_WAKE_INTERVAL_MS;
    }

    // 收盘集合竞价结算过渡窗（15:00:01–15:02:00）：
    // 先在 15:00:15 补抓一次收盘竞价快照，再于 15:02:00 自动用上游权威分时线校准终态 240 根分钟线
    if (this.lastPhase === 'POST_MARKET' && this.displayTradeDate === todayStr) {
      const { secondsOfDay } = getShanghaiParts(nowMs);
      const watchlistItems = this.db.getWatchlist();
      const monitored = this.collectMonitoredSymbols(watchlistItems);
      const hasUnreconciled = monitored.some((sym) => !this.postCloseReconciledSymbols.has(sym));
      if (hasUnreconciled) {
        if (
          secondsOfDay < SEC_15_00_SETTLE &&
          this.postCloseSettleSnapshotDoneDate !== this.displayTradeDate
        ) {
          const settleMs = shanghaiToTimestampMs(todayStr, 15, 0, 15);
          return Math.max(1_000, settleMs - nowMs);
        }
        if (secondsOfDay < SEC_15_02) {
          const reconcileMs = shanghaiToTimestampMs(todayStr, 15, 2, 0);
          return Math.max(1_000, reconcileMs - nowMs);
        }
      }
    }

    // 盘后与非交易日：零高频行情请求，仅保留纯本地时钟轻量唤醒以便跨日准点开盘
    const nextDay = nextCalendarDate(todayStr);
    const nextDayOpenMs = shanghaiToTimestampMs(nextDay, 9, 15, 0);
    const remaining = nextDayOpenMs - nowMs;
    if (remaining > 0) {
      return Math.max(1_000, Math.min(IDLE_RECHECK_INTERVAL_MS, remaining));
    }
    return IDLE_RECHECK_INTERVAL_MS;
  }

  private scheduleNextTick(): void {
    if (!this.running || this.stopped) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const delayMs = this.computeNextWakeDelayMs(this.nowFn());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.onTimerWake().catch(() => {
        // 防止定时器回调产生未捕获 Promise 拒绝
      });
    }, delayMs);
  }

  private async onTimerWake(): Promise<void> {
    if (!this.running || this.stopped) return;

    // 非交易时段先做纯本地时钟与自选股签名快判，无变化时零网络请求直接继续休眠
    if (this.mode !== 'LIVE' && this.latestState !== null && !this.calendarNeedsTodayReprobe) {
      const nowMs = this.nowFn();
      const { dateStr: todayStr } = getShanghaiParts(nowMs);
      const nextPhase = getMarketPhase(nowMs, this.openTradingDaySet);
      const watchlistItems = this.db.getWatchlist();
      const watchlistSig = this.computeWatchlistSignature(watchlistItems);
      const needsClosingFollowup =
        this.shouldRunPostCloseSettleSnapshot(nowMs, nextPhase) ||
        this.collectMonitoredSymbols(watchlistItems).some((sym) =>
          this.needsPostCloseReconcileForSymbol(sym, nowMs, nextPhase)
        );
      if (
        todayStr === this.initializedForDate &&
        !this.calendarForceReload &&
        !this.postCloseForceReconcilePending &&
        !needsClosingFollowup &&
        nextPhase === this.lastPhase &&
        watchlistSig === this.lastWatchlistSignature &&
        this.configRevision === this.lastTickConfigRevision
      ) {
        this.scheduleNextTick();
        return;
      }
    }

    try {
      await this.tickOnce();
    } finally {
      if (this.running && !this.stopped) {
        this.scheduleNextTick();
      }
    }
  }

  private computeWatchlistSignature(items: readonly WatchlistItemRow[]): string {
    return items
      .map(
        (i) =>
          `${i.symbol}:${i.sortOrder}:${i.alertEnabled ? 1 : 0}:${i.customThresholdsJson ?? ''}`
      )
      .join('|');
  }

  private syncDateContext(displayDate: string | null, prevDate: string | null): void {
    if (displayDate === this.activeDisplayDate && prevDate === this.activePrevDate) {
      return;
    }

    const displayDateChanged = displayDate !== this.activeDisplayDate;
    this.activeDisplayDate = displayDate;
    this.activePrevDate = prevDate;

    this.todayBars.clear();
    this.prevBars.clear();
    this.todayAuctions.clear();
    this.prevAuctions.clear();
    this.pendingBars.clear();
    this.loadedFromDbSymbols.clear();
    this.predictionProfiles.clear();
    this.lastBackfillAttemptAt.clear();
    this.intradaySourceBySymbol.clear();
    this.latestSnapshots.clear();
    this.cybRealignedGroups.clear();

    if (displayDateChanged) {
      this.alertEngine.resetCooldowns();
      this.loadRecentAlertsFromDb(displayDate);
      this.loadPostCloseReconciledState(displayDate);
    }
  }

  private loadPostCloseReconciledState(tradeDate: string | null): void {
    this.postCloseReconciledDate = tradeDate;
    this.postCloseReconciledSymbols.clear();
    this.postCloseReconcileAttempts.clear();
    if (!tradeDate || this.stopped) return;

    const stored = this.db.getSetting<PostCloseReconciledRecord>(SETTING_POST_CLOSE_RECONCILED);
    if (stored && stored.tradeDate === tradeDate && Array.isArray(stored.symbols)) {
      for (const sym of stored.symbols) {
        if (typeof sym === 'string' && sym.trim()) {
          this.postCloseReconciledSymbols.add(sym.trim().toUpperCase());
        }
      }
    }
  }

  private isPostCloseReconcileReady(nowMs: number, phase: MarketPhase): boolean {
    if (this.mode !== 'REPLAY' || !this.displayTradeDate || phase === 'LUNCH_BREAK') {
      return false;
    }
    if (this.postCloseForceReconcilePending) {
      return true;
    }
    if (phase === 'POST_MARKET') {
      return getShanghaiParts(nowMs).secondsOfDay >= SEC_15_02;
    }
    // CLOSED_DAY 或 PRE_MARKET 复盘上一已完成交易日，终态数据已稳定可用
    return true;
  }

  private needsPostCloseReconcileForSymbol(
    symbol: string,
    nowMs: number,
    phase: MarketPhase
  ): boolean {
    if (!this.isPostCloseReconcileReady(nowMs, phase)) {
      return false;
    }
    if (this.postCloseReconciledSymbols.has(symbol)) {
      return false;
    }
    if (
      !this.postCloseForceReconcilePending &&
      (this.postCloseReconcileAttempts.get(symbol) ?? 0) >= MAX_AUTO_POST_CLOSE_RECONCILE_ATTEMPTS
    ) {
      return false;
    }
    return true;
  }

  private shouldRunPostCloseSettleSnapshot(nowMs: number, phase: MarketPhase): boolean {
    if (phase !== 'POST_MARKET' || !this.displayTradeDate) {
      return false;
    }
    const { dateStr, secondsOfDay } = getShanghaiParts(nowMs);
    if (dateStr !== this.displayTradeDate) {
      return false;
    }
    return (
      secondsOfDay >= SEC_15_00_SETTLE &&
      secondsOfDay < SEC_15_02 &&
      this.postCloseSettleSnapshotDoneDate !== this.displayTradeDate
    );
  }

  private persistPostCloseReconciledSymbol(
    symbol: string,
    days: readonly IntradayDayData[],
    nowMs: number,
    phase: MarketPhase
  ): void {
    if (!this.displayTradeDate || this.stopped) return;
    // 15:00:01–15:01:59 期间上游分时可能尚未含完整收盘集合竞价，不提前锁定已校准标记
    if (phase === 'POST_MARKET' && getShanghaiParts(nowMs).secondsOfDay < SEC_15_02) {
      return;
    }
    const matchedDay = days.find((d) => d.tradeDate === this.displayTradeDate);
    if (!matchedDay || matchedDay.bars.length < TOTAL_DAY_BARS) {
      return;
    }
    const hasClosingBar = matchedDay.bars.some((b) => b.minuteIndex === TOTAL_DAY_BARS - 1);
    if (!hasClosingBar) {
      return;
    }

    if (this.postCloseReconciledDate !== this.displayTradeDate) {
      this.postCloseReconciledDate = this.displayTradeDate;
      this.postCloseReconciledSymbols.clear();
    }
    this.postCloseReconciledSymbols.add(symbol);
    this.db.setSetting<PostCloseReconciledRecord>(SETTING_POST_CLOSE_RECONCILED, {
      tradeDate: this.displayTradeDate,
      symbols: [...this.postCloseReconciledSymbols],
    });
  }

  private loadRecentAlertsFromDb(tradeDate: string | null): void {
    this.recentAlerts.length = 0;
    if (!tradeDate || this.stopped) return;

    const rows = this.db.getAlertEvents(tradeDate, MAX_RECENT_ALERTS);
    for (const row of rows) {
      this.recentAlerts.push({
        symbol: row.symbol,
        name: row.name,
        tradeDate: row.tradeDate,
        minuteIndex: row.minuteIndex,
        direction: row.direction,
        slope: row.slope,
        windowMultiple: row.windowMultiple,
        cumRatio: row.cumRatio,
        message: row.message,
        createdAt: row.createdAt,
      });
    }
  }

  private buildStoppedFallbackState(): MarketDashboardState {
    if (this.latestState) {
      return this.latestState;
    }
    return {
      status: {
        mode: 'IDLE',
        phase: this.lastPhase,
        tradeDate: this.displayTradeDate,
        prevTradeDate: this.prevTradeDate,
        activeSnapshotProvider: null,
        activeIntradayProvider: this.activeIntradayProvider,
        calendarSource: this.calendarSource,
        calendarDegraded: this.calendarDegraded,
        pollingIntervalSec: this.effectiveIntervalSec,
        configuredIntervalSec: this.configuredIntervalSec,
        lastUpdatedAt: this.lastUpdatedAt,
        lastLatencyMs: this.lastLatencyMs,
        consecutiveFailures: this.consecutiveFailures,
        stale: false,
        degraded: false,
        degradedReasons: [],
      },
      marketTotal: {
        symbol: MARKET_TOTAL_SYMBOL,
        name: '沪深两市',
        tradeDate: this.displayTradeDate,
        prevTradeDate: this.prevTradeDate,
        cumTurnover: null,
        shTurnover: null,
        szTurnover: null,
        auctionTurnover: null,
        prevAuctionTurnover: null,
        prevFullDayTurnover: null,
        metrics: null,
        todaySeries: [],
        prevSeries: [],
        degraded: true,
        degradedReason: 'SCHEDULER_STOPPED',
      },
      indices: [],
      watchlist: [],
      recentAlerts: [...this.recentAlerts],
    };
  }

  private async executeTick(): Promise<MarketDashboardState> {
    if (this.stopped) {
      return this.buildStoppedFallbackState();
    }

    const nowMs = this.nowFn();
    const { dateStr: todayStr, secondsOfDay } = getShanghaiParts(nowMs);
    const tickConfigRev = this.configRevision;

    // 1. 首次启动、跨自然日或凭据更新强制重载时加载/刷新交易日历
    if (this.calendarForceReload || this.initializedForDate !== todayStr) {
      this.calendarForceReload = false;
      await this.initializeCalendarForDate(todayStr, nowMs);
      if (this.stopped) return this.buildStoppedFallbackState();
      this.initializedForDate = todayStr;
    } else if (this.calendarNeedsTodayReprobe && secondsOfDay >= SEC_09_15) {
      await this.reprobeTodayTradingStatus(todayStr, nowMs, secondsOfDay);
      if (this.stopped) return this.buildStoppedFallbackState();
    }

    // 2. 判定当前市场阶段、展示交易日与运行模式
    const prevPhase = this.lastPhase;
    const phase = getMarketPhase(nowMs, this.openTradingDaySet);
    this.lastPhase = phase;

    const { displayDate, prevDate, mode } = this.resolveDatesAndMode(todayStr, phase);
    this.displayTradeDate = displayDate;
    this.prevTradeDate = prevDate;
    this.mode = mode;

    // 若展示交易日或基线日切换（如 PRE_MARKET → OPEN_AUCTION 或跨日），彻底清理旧日内存缓存并重载当日告警
    this.syncDateContext(displayDate, prevDate);

    // 3. 获取最新监控标的列表（5 指数 + 实时数据库自选股，增删无需重启）
    const watchlistItems = this.db.getWatchlist();
    this.lastWatchlistSignature = this.computeWatchlistSignature(watchlistItems);
    const monitoredSymbols = this.collectMonitoredSymbols(watchlistItems);
    const nameLookup = this.buildNameLookup(watchlistItems);

    // 从连续交易阶段刚跨入午休或盘后时，补拉一次终态收盘快照捕获 11:30:xx / 15:00:xx 集合竞价，再刷盘待闭合分钟
    const justClosedSession =
      (prevPhase === 'MORNING_SESSION' && phase === 'LUNCH_BREAK') ||
      (prevPhase === 'AFTERNOON_SESSION' && phase === 'POST_MARKET');
    if (justClosedSession) {
      await this.pollLiveSnapshots(monitoredSymbols, nameLookup, nowMs, prevPhase);
      if (this.stopped) return this.buildStoppedFallbackState();
      this.flushAllPendingBars();
      if (phase === 'POST_MARKET' && secondsOfDay >= SEC_15_00_SETTLE && displayDate) {
        this.postCloseSettleSnapshotDoneDate = displayDate;
      }
    } else if (this.shouldRunPostCloseSettleSnapshot(nowMs, phase)) {
      // 15:00:15 收盘集合竞价二次结算补抓（仅执行 1 次），避免 15:00:01 瞬间尚未推送尾盘撮合额
      await this.pollLiveSnapshots(monitoredSymbols, nameLookup, nowMs, 'AFTERNOON_SESSION');
      if (this.stopped) return this.buildStoppedFallbackState();
      this.flushAllPendingBars();
      this.postCloseSettleSnapshotDoneDate = displayDate;
    }

    // 4. 首次从 SQLite 加载内存缓存并按需补齐缺失的昨日 240 分钟、今日已过分钟及盘后权威收盘终态
    await this.ensureIntradayBackfilled(monitoredSymbols, nowMs, phase);
    if (this.stopped) return this.buildStoppedFallbackState();
    this.postCloseForceReconcilePending = false;

    // 5. 交易时段执行批量快照拉取与告警评估；非交易时段零高频请求，直接复盘
    if (mode === 'LIVE') {
      await this.pollLiveSnapshots(monitoredSymbols, nameLookup, nowMs, phase);
      if (this.stopped) return this.buildStoppedFallbackState();
      await this.maybeRealignCybIntradayBaseline();
      if (this.stopped) return this.buildStoppedFallbackState();
    }

    // 6. 盘后触发一次 30 交易日滚动清理（每日最多一次）
    if (phase === 'POST_MARKET' && displayDate && this.lastPrunedDate !== displayDate) {
      this.db.pruneOlderThanTradingDays(DEFAULT_RETENTION_TRADING_DAYS, displayDate);
      this.lastPrunedDate = displayDate;
    }

    // 7. 调用 src/core/ 引擎计算最新全量看板状态并推送回调
    const state = this.buildDashboardState(watchlistItems, nowMs, phase);
    this.lastTickConfigRevision = tickConfigRev;
    this.latestState = state;
    if (!this.stopped) {
      this.onStateUpdate?.(state);
    }
    return state;
  }

  private async initializeCalendarForDate(todayStr: string, nowMs: number): Promise<void> {
    const cachedSyncDate = this.db.getSetting<string>(SETTING_CALENDAR_SYNC_DATE);
    const cachedOpenDays = this.db.getTradingDays(true).map((d) => d.date);
    this.calendarNeedsTodayReprobe = false;

    // 1. SQLite 当日缓存有效 → 直接使用
    if (cachedSyncDate === todayStr && cachedOpenDays.length > 0) {
      this.setOpenTradingDays(cachedOpenDays, 'sqlite_cache', false);
      return;
    }

    // 2. 配置了同花顺 Key → 拉取近一年权威交易日历并缓存
    if (this.hithink.isConfigured()) {
      try {
        const fetched = await this.hithink.fetchTradingDays();
        if (this.stopped) return;
        if (fetched.length > 0) {
          this.db.upsertTradingDays(fetched);
          this.db.setSetting(SETTING_CALENDAR_SYNC_DATE, todayStr);
          const openDays = fetched.filter((d) => d.isOpen).map((d) => d.date);
          this.setOpenTradingDays(openDays, 'hithink', false);
          return;
        }
      } catch {
        // 同花顺拉取失败，回落至已有缓存或公开分时推断
      }
    }

    // 3. 若已有旧缓存且覆盖到 todayStr → 直接降级复用旧缓存
    const maxCachedDate =
      cachedOpenDays.length > 0 ? cachedOpenDays[cachedOpenDays.length - 1] : null;
    if (maxCachedDate !== null && maxCachedDate >= todayStr) {
      this.setOpenTradingDays(cachedOpenDays, 'sqlite_cache', true);
      return;
    }

    // 4. 无缓存或旧缓存未覆盖今日 → 结合公开分时（及工作日开盘窗内单次快照探测）推断交易日，避免误判 CLOSED_DAY
    const inferredDates = await this.inferTradingDatesFromPublicIntraday(nowMs);
    if (this.stopped) return;

    const mergedDates = new Set<string>([...cachedOpenDays, ...inferredDates]);
    const weekday = getDateWeekday(todayStr);
    const isWeekday = weekday >= 1 && weekday <= 5;
    const { secondsOfDay } = getShanghaiParts(nowMs);

    if (isWeekday && !mergedDates.has(todayStr)) {
      if (secondsOfDay >= SEC_09_15 && secondsOfDay <= SEC_15_10) {
        const openedToday = await this.probeTodayOpenViaPublicSnapshot(todayStr);
        if (this.stopped) return;
        if (openedToday) {
          mergedDates.add(todayStr);
        } else if (secondsOfDay < SEC_09_35) {
          this.calendarNeedsTodayReprobe = true;
          this.lastCalendarReprobeAt = nowMs;
        }
      } else if (secondsOfDay < SEC_09_15) {
        this.calendarNeedsTodayReprobe = true;
        this.lastCalendarReprobeAt = nowMs;
      }
    }

    this.setOpenTradingDays([...mergedDates], 'inferred_degraded', true);
  }

  private async reprobeTodayTradingStatus(
    todayStr: string,
    nowMs: number,
    secondsOfDay: number
  ): Promise<void> {
    if (this.openTradingDaySet.has(todayStr)) {
      this.calendarNeedsTodayReprobe = false;
      return;
    }
    if (secondsOfDay > SEC_15_10) {
      this.calendarNeedsTodayReprobe = false;
      return;
    }
    if (
      this.lastCalendarReprobeAt > 0 &&
      nowMs - this.lastCalendarReprobeAt < CALENDAR_REPROBE_INTERVAL_MS
    ) {
      return;
    }

    this.lastCalendarReprobeAt = nowMs;
    const openedToday = await this.probeTodayOpenViaPublicSnapshot(todayStr);
    if (this.stopped) return;

    if (openedToday) {
      this.setOpenTradingDays(
        [...this.openTradingDays, todayStr],
        this.calendarSource,
        this.calendarDegraded
      );
      this.calendarNeedsTodayReprobe = false;
    } else if (secondsOfDay >= SEC_09_35) {
      // 超过 09:35 公开源仍无今日行情，判定为法定节假日休市
      this.calendarNeedsTodayReprobe = false;
    }
  }

  private async probeTodayOpenViaPublicSnapshot(todayStr: string): Promise<boolean> {
    for (const provider of [this.primarySnapshot, this.secondarySnapshot]) {
      try {
        const snaps = await provider.fetchBatchSnapshots(['000001.SH']);
        const sh = snaps.get('000001.SH');
        if (sh && sh.tradeDate === todayStr) {
          return true;
        }
      } catch {
        // 尝试下一公开源
      }
    }
    return false;
  }

  private setOpenTradingDays(
    openDays: readonly string[],
    source: CalendarSource,
    degraded: boolean
  ): void {
    const uniqueSorted = [...new Set(openDays)].sort((a, b) => a.localeCompare(b));
    this.openTradingDays = uniqueSorted;
    this.openTradingDaySet = new Set(uniqueSorted);
    this.calendarSource = source;
    this.calendarDegraded = degraded;
  }

  private async inferTradingDatesFromPublicIntraday(nowMs: number): Promise<string[]> {
    const dayLists = await this.fetchIntradayWithFallback('000001.SH', 5);
    if (!dayLists || this.stopped) return [];
    this.persistIntradayDays(dayLists);
    this.intradaySourceBySymbol.set('000001.SH', dayLists[0].source);
    this.lastBackfillAttemptAt.set('000001.SH', nowMs);
    return dayLists.map((d) => d.tradeDate).sort((a, b) => a.localeCompare(b));
  }

  private resolveDatesAndMode(
    todayStr: string,
    phase: MarketPhase
  ): { displayDate: string | null; prevDate: string | null; mode: CollectorMode } {
    if (
      phase === 'OPEN_AUCTION' ||
      phase === 'AUCTION_GAP' ||
      phase === 'MORNING_SESSION' ||
      phase === 'AFTERNOON_SESSION'
    ) {
      return {
        displayDate: todayStr,
        prevDate: getPrevTradingDate(todayStr, this.openTradingDaySet),
        mode: 'LIVE',
      };
    }

    if (phase === 'LUNCH_BREAK' || phase === 'POST_MARKET') {
      return {
        displayDate: todayStr,
        prevDate: getPrevTradingDate(todayStr, this.openTradingDaySet),
        mode: 'REPLAY',
      };
    }

    // CLOSED_DAY 或 PRE_MARKET（09:15 之前）：复盘最近一个已完成交易日
    let latestCompleted: string | null = null;
    for (const d of this.openTradingDays) {
      if (d < todayStr) {
        latestCompleted = d;
      }
    }
    return {
      displayDate: latestCompleted,
      prevDate: latestCompleted ? getPrevTradingDate(latestCompleted, this.openTradingDaySet) : null,
      mode: 'REPLAY',
    };
  }

  private collectMonitoredSymbols(watchlistItems: readonly WatchlistItemRow[]): string[] {
    const result: string[] = resolveMonitoredIndexSymbols(
      this.enabledOptionalIndices,
      this.enabledCoreIndices
    );
    const seen = new Set<string>(result);
    for (const item of watchlistItems) {
      const sym = item.symbol.trim().toUpperCase();
      if (sym && !seen.has(sym)) {
        seen.add(sym);
        result.push(sym);
      }
    }
    return result;
  }

  private buildNameLookup(watchlistItems: readonly WatchlistItemRow[]): Map<string, string> {
    const map = new Map<string, string>(Object.entries(MONITORED_INDEX_NAMES));
    for (const item of watchlistItems) {
      map.set(item.symbol.trim().toUpperCase(), item.name);
    }
    return map;
  }

  private loadSymbolFromDb(symbol: string): void {
    if (this.stopped) return;

    if (this.displayTradeDate) {
      this.todayBars.set(symbol, this.db.getIntradayBars(symbol, this.displayTradeDate));
      const a = this.db.getAuctionSnapshot(symbol, this.displayTradeDate);
      if (a) {
        this.todayAuctions.set(symbol, {
          openPrice: a.openPrice,
          auctionTurnover: a.auctionTurnover,
        });
      } else {
        this.todayAuctions.delete(symbol);
      }
    } else {
      this.todayBars.delete(symbol);
      this.todayAuctions.delete(symbol);
    }

    if (this.prevTradeDate) {
      this.prevBars.set(symbol, this.db.getIntradayBars(symbol, this.prevTradeDate));
      const pa = this.db.getAuctionSnapshot(symbol, this.prevTradeDate);
      if (pa) {
        this.prevAuctions.set(symbol, {
          openPrice: pa.openPrice,
          auctionTurnover: pa.auctionTurnover,
        });
      } else {
        this.prevAuctions.delete(symbol);
      }
    } else {
      this.prevBars.delete(symbol);
      this.prevAuctions.delete(symbol);
    }

    this.loadedFromDbSymbols.add(symbol);
    this.predictionProfiles.set(
      symbol,
      loadSymbolPredictionProfile(this.db, symbol, this.displayTradeDate)
    );
    if ((MARKET_TOTAL_COMPONENTS as readonly string[]).includes(symbol)) {
      const [shSym, szSym] = MARKET_TOTAL_COMPONENTS;
      if (this.loadedFromDbSymbols.has(shSym) && this.loadedFromDbSymbols.has(szSym)) {
        this.predictionProfiles.set(
          MARKET_TOTAL_SYMBOL,
          loadMarketTotalPredictionProfile(this.db, this.displayTradeDate)
        );
      } else {
        this.predictionProfiles.delete(MARKET_TOTAL_SYMBOL);
      }
    }
  }

  private getPredictionProfile(symbol: string): IntradayPredictionProfile | null {
    if (this.stopped || !this.displayTradeDate) return null;
    if (this.predictionProfiles.has(symbol)) {
      return this.predictionProfiles.get(symbol) ?? null;
    }
    const profile =
      symbol === MARKET_TOTAL_SYMBOL
        ? loadMarketTotalPredictionProfile(this.db, this.displayTradeDate)
        : loadSymbolPredictionProfile(this.db, symbol, this.displayTradeDate);
    this.predictionProfiles.set(symbol, profile);
    return profile;
  }

  private needsBackfill(symbol: string, nowMs: number, phase: MarketPhase): boolean {
    if (!this.displayTradeDate) return false;

    const prevList = this.prevBars.get(symbol) ?? [];
    if (this.prevTradeDate && prevList.length < TOTAL_DAY_BARS) {
      return true;
    }

    const todayList = this.todayBars.get(symbol) ?? [];
    if (this.mode === 'REPLAY') {
      if (phase === 'LUNCH_BREAK') {
        return todayList.length < MORNING_BARS;
      }
      if (todayList.length < TOTAL_DAY_BARS) {
        return true;
      }
      // 即使已落盘 240 根（如盘中快照拼接），盘后仍需用上游权威分时终态校准一次以补全 14:57–15:00 尾盘集合竞价
      return this.needsPostCloseReconcileForSymbol(symbol, nowMs, phase);
    }

    const currentMinuteIndex = timestampToMinuteIndex(nowMs);
    if (currentMinuteIndex !== null && currentMinuteIndex > 0) {
      const expectedLastClosed = currentMinuteIndex - 1;
      if (todayList.length < currentMinuteIndex || hasSeriesGap(todayList, expectedLastClosed)) {
        return true;
      }
    }

    if (
      (phase === 'MORNING_SESSION' || phase === 'AFTERNOON_SESSION') &&
      !this.todayAuctions.has(symbol)
    ) {
      return true;
    }

    return false;
  }

  private async ensureIntradayBackfilled(
    symbols: readonly string[],
    nowMs: number,
    phase: MarketPhase
  ): Promise<void> {
    const missing: string[] = [];

    for (const sym of symbols) {
      if (!this.loadedFromDbSymbols.has(sym)) {
        this.loadSymbolFromDb(sym);
      }
      if (!this.needsBackfill(sym, nowMs, phase)) {
        continue;
      }

      const lastAttempt = this.lastBackfillAttemptAt.get(sym);
      if (
        !this.postCloseForceReconcilePending &&
        lastAttempt !== undefined &&
        nowMs - lastAttempt < BACKFILL_RETRY_COOLDOWN_MS
      ) {
        continue;
      }
      missing.push(sym);
    }

    if (missing.length === 0) return;

    const isPostCloseReconcilePass = this.isPostCloseReconcileReady(nowMs, phase);

    // 限制并发度为 2、批次间间隔 150ms，避免触发上游限流（docs/DATA_SOURCES.md §5.2）
    const concurrency = 2;
    for (let i = 0; i < missing.length; i += concurrency) {
      if (this.stopped) return;
      const batch = missing.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (sym) => {
          this.lastBackfillAttemptAt.set(sym, nowMs);
          if (isPostCloseReconcilePass) {
            this.postCloseReconcileAttempts.set(
              sym,
              (this.postCloseReconcileAttempts.get(sym) ?? 0) + 1
            );
          }
          const days = await this.fetchIntradayWithFallback(sym, 2);
          if (this.stopped) return;
          if (days && days.length > 0) {
            this.persistIntradayDays(days);
            this.intradaySourceBySymbol.set(sym, days[0].source);
            this.lastUpdatedAt = nowMs;
            this.loadSymbolFromDb(sym);
            if (isPostCloseReconcilePass) {
              this.persistPostCloseReconciledSymbol(sym, days, nowMs, phase);
            }
          }
        })
      );
      if (i + concurrency < missing.length && this.backfillDelayMs > 0 && !this.stopped) {
        await this.sleepFn(this.backfillDelayMs);
      }
    }
  }

  /**
   * 399006.SZ 跨源口径自动对齐：当 LIVE 快照与分时基线分属不同口径组时，
   * 尝试通过目标口径组的分时源一次性重拉 2 日基线，保持「今/昨同源」。
   */
  private async maybeRealignCybIntradayBaseline(): Promise<void> {
    const sym = '399006.SZ';
    const snap = this.latestSnapshots.get(sym) ?? null;
    if (!snap || !this.displayTradeDate || snap.tradeDate !== this.displayTradeDate) return;

    const todayBars = this.todayBars.get(sym) ?? [];
    const prevBars = this.prevBars.get(sym) ?? [];
    if (!hasCybCrossSourceMismatch({ symbol: sym, todayBars, prevBars, liveSnap: snap })) {
      return;
    }

    const targetGroup = getCybScopeGroup(snap.source);
    if (!targetGroup || this.cybRealignedGroups.has(targetGroup)) return;
    this.cybRealignedGroups.add(targetGroup);

    const targetProvider =
      targetGroup === 'tx_sina' ? this.primaryIntraday : this.secondaryIntraday;
    try {
      const days = await targetProvider.fetchIntradayMinutes(sym, 2);
      if (this.stopped || days.length === 0) return;
      this.activeIntradayProvider = targetProvider.id;
      this.persistIntradayDays(days);
      this.intradaySourceBySymbol.set(sym, days[0].source);
      this.loadSymbolFromDb(sym);
    } catch {
      // 重拉失败时保持 CROSS_SOURCE_SCOPE_MISMATCH 安全降级，绝不混除
    }
  }

  private async fetchIntradayWithFallback(
    symbol: string,
    days: number
  ): Promise<IntradayDayData[] | null> {
    try {
      const res = await this.primaryIntraday.fetchIntradayMinutes(symbol, days);
      if (res.length > 0) {
        this.activeIntradayProvider = this.primaryIntraday.id;
        return res;
      }
    } catch {
      // 主分时源失败，自动回退至备用分时源（东财 push2his）
    }

    try {
      const fallback = await this.secondaryIntraday.fetchIntradayMinutes(symbol, days);
      if (fallback.length > 0) {
        this.activeIntradayProvider = this.secondaryIntraday.id;
        return fallback;
      }
    } catch {
      // 双分时源均失败时保持现状，绝不补零或生成合成数据
    }

    return null;
  }

  private persistIntradayDays(days: readonly IntradayDayData[]): void {
    if (this.stopped) return;
    const nowMs = this.nowFn();
    for (const day of days) {
      if (day.bars.length > 0) {
        this.db.upsertIntradayBars(day.bars);
      }
      if (day.auction) {
        this.db.upsertAuctionSnapshot({
          symbol: day.symbol,
          tradeDate: day.tradeDate,
          openPrice: day.auction.openPrice,
          auctionTurnover: day.auction.auctionTurnover,
          capturedAt: nowMs,
        });
      }
    }
  }

  private getProviderById(id: ProviderId): MarketDataProvider {
    if (id === this.primarySnapshot.id) return this.primarySnapshot;
    if (id === this.secondarySnapshot.id) return this.secondarySnapshot;
    return this.hithink;
  }

  private async maybeProbePrimaryRecovery(nowMs: number): Promise<void> {
    if (this.activeSnapshotProvider === this.primarySnapshot.id) return;
    if (nowMs - this.lastPrimaryProbeAt < PRIMARY_RECOVERY_PROBE_INTERVAL_MS) return;

    this.lastPrimaryProbeAt = nowMs;

    try {
      const primaryHealth = await this.primarySnapshot.healthCheck();
      if (primaryHealth.ok) {
        this.activeSnapshotProvider = this.primarySnapshot.id;
        this.consecutiveFailures = 0;
        return;
      }
    } catch {
      // 探测异常视作未恢复
    }

    // 若当前滞留在同花顺紧急低频兜底，且主源仍不可用，顺带探测第一备源（新浪）是否已恢复
    if (this.activeSnapshotProvider === 'hithink') {
      try {
        const secondaryHealth = await this.secondarySnapshot.healthCheck();
        if (secondaryHealth.ok) {
          this.activeSnapshotProvider = this.secondarySnapshot.id;
          this.consecutiveFailures = 0;
        }
      } catch {
        // 维持当前兜底源
      }
    }
  }

  private async pollLiveSnapshots(
    symbols: readonly string[],
    nameLookup: ReadonlyMap<string, string>,
    nowMs: number,
    phase: MarketPhase
  ): Promise<void> {
    await this.maybeProbePrimaryRecovery(nowMs);
    if (this.stopped) return;

    const attemptPoll = async (providerId: ProviderId): Promise<Map<string, QuoteSnapshot>> => {
      const provider = this.getProviderById(providerId);
      const started = performance.now();
      const snapshots = await provider.fetchBatchSnapshots(symbols, nameLookup);
      this.lastLatencyMs = Math.round((performance.now() - started) * 10) / 10;
      this.lastUpdatedAt = nowMs;
      return snapshots;
    };

    try {
      const snapshots = await attemptPoll(this.activeSnapshotProvider);
      if (this.stopped) return;
      this.handlePollSuccess(snapshots, nowMs, phase);
      return;
    } catch (err) {
      if (this.stopped) return;
      const switched = this.handlePollFailure(err, nowMs);
      if (switched) {
        // 刚刚触发主备切换时立即用新备源补拉一次，避免多等一个周期
        try {
          const fallbackSnapshots = await attemptPoll(this.activeSnapshotProvider);
          if (this.stopped) return;
          this.handlePollSuccess(fallbackSnapshots, nowMs, phase);
        } catch (fallbackErr) {
          if (this.stopped) return;
          this.handlePollFailure(fallbackErr, nowMs);
        }
      }
    }
  }

  private handlePollSuccess(
    snapshots: Map<string, QuoteSnapshot>,
    nowMs: number,
    phase: MarketPhase
  ): void {
    this.consecutiveFailures = 0;

    if (this.activeSnapshotProvider === 'hithink') {
      this.effectiveIntervalSec = Math.max(
        HITHINK_FALLBACK_MIN_INTERVAL_SEC,
        this.configuredIntervalSec
      );
    } else if (this.effectiveIntervalSec > this.configuredIntervalSec) {
      this.effectiveIntervalSec = Math.max(
        this.configuredIntervalSec,
        Math.floor(this.effectiveIntervalSec / 2)
      );
    }

    const { secondsOfDay: nowSecOfDay } = getShanghaiParts(nowMs);

    for (const [symbol, snap] of snapshots) {
      this.latestSnapshots.set(symbol, snap);

      if (!this.displayTradeDate || snap.tradeDate !== this.displayTradeDate) {
        continue;
      }

      // 仅在 09:25–09:29 集合竞价间隙捕获开盘集合竞价并落盘 auction_snapshots
      // 允许 09:25 期间随终态修正更新；冷门股 09:26 后真实零成交也允许落盘 0
      if (phase === 'AUCTION_GAP') {
        const snapParts = getShanghaiParts(snap.timestampMs);
        if (snapParts.secondsOfDay >= SEC_09_25) {
          const existingAuction = this.todayAuctions.get(symbol);
          const shouldRecord =
            (!existingAuction && (snap.turnover > 0 || nowSecOfDay >= SEC_09_26)) ||
            (existingAuction !== undefined && snap.turnover > existingAuction.auctionTurnover);
          if (shouldRecord) {
            const auction = {
              openPrice: snap.open > 0 ? snap.open : snap.price,
              auctionTurnover: snap.turnover,
            };
            this.todayAuctions.set(symbol, auction);
            this.db.upsertAuctionSnapshot({
              symbol,
              tradeDate: this.displayTradeDate,
              openPrice: auction.openPrice,
              auctionTurnover: auction.auctionTurnover,
              capturedAt: nowMs,
            });
          }
        }
      }

      // 399006.SZ 禁止将与昨日基线不同口径的快照写入 intraday_bars（防止污染当日序列）
      if (symbol === '399006.SZ') {
        const prevGroup = getCybScopeGroup(this.prevBars.get(symbol)?.[0]?.source);
        const snapGroup = getCybScopeGroup(snap.source);
        if (prevGroup && snapGroup && prevGroup !== snapGroup) {
          continue;
        }
      }

      // 连续竞价阶段维护分钟聚合并在分钟闭合时落盘 intraday_bars（含 11:30:xx / 15:00:xx 收盘延迟推送）
      const resolvedMinute = resolveSnapshotMinute(snap.timestampMs);
      if (!resolvedMinute) continue;

      const { minuteIndex, elapsedSeconds } = resolvedMinute;
      const prevPending = this.pendingBars.get(symbol);
      if (prevPending && prevPending.minuteIndex < minuteIndex) {
        this.persistClosedPendingBar(symbol, prevPending);
      }

      const nextPending: PendingMinuteBar = {
        minuteIndex,
        price: snap.price,
        cumVolume: snap.volumeShares,
        cumTurnover: snap.turnover,
        source: snap.source,
      };
      this.pendingBars.set(symbol, nextPending);

      // 11:30 或 15:00 闭合点立即落盘
      if (elapsedSeconds === 60) {
        this.persistClosedPendingBar(symbol, nextPending);
        this.pendingBars.delete(symbol);
      }
    }
  }

  /** 返回是否发生了主备源切换 */
  private handlePollFailure(err: unknown, nowMs: number): boolean {
    this.consecutiveFailures += 1;
    const isRateLimited = err instanceof ProviderRequestError && err.rateLimited;

    // 指数退避翻倍（3s → 6s → 12s → 24s → 30s 上限）
    this.effectiveIntervalSec = Math.min(
      MAX_BACKOFF_INTERVAL_SEC,
      Math.max(this.configuredIntervalSec, this.effectiveIntervalSec) * 2
    );

    const shouldFailover = isRateLimited || this.consecutiveFailures >= FAILOVER_FAILURE_THRESHOLD;
    if (!shouldFailover) {
      return false;
    }

    const nextProvider = this.selectNextFallbackProvider(this.activeSnapshotProvider);
    if (!nextProvider || nextProvider === this.activeSnapshotProvider) {
      return false;
    }

    this.activeSnapshotProvider = nextProvider;
    this.consecutiveFailures = 0;
    this.lastPrimaryProbeAt = nowMs;

    if (nextProvider === 'hithink') {
      this.effectiveIntervalSec = Math.max(
        this.effectiveIntervalSec,
        HITHINK_FALLBACK_MIN_INTERVAL_SEC
      );
    }

    return true;
  }

  private selectNextFallbackProvider(current: ProviderId): ProviderId | null {
    if (current === this.primarySnapshot.id) {
      return this.secondarySnapshot.id;
    }
    if (current === this.secondarySnapshot.id && this.hithink.isConfigured()) {
      return 'hithink';
    }
    return null;
  }

  private persistClosedPendingBar(symbol: string, pending: PendingMinuteBar): void {
    if (!this.displayTradeDate || this.stopped) return;

    const existing = this.todayBars.get(symbol) ?? [];
    const prevBar = existing.find((b) => b.minuteIndex === pending.minuteIndex - 1);
    const auction = this.todayAuctions.get(symbol);

    let barTurnover: number;
    if (prevBar) {
      barTurnover = Math.max(0, pending.cumTurnover - prevBar.cumTurnover);
    } else if (pending.minuteIndex === 0 && auction) {
      barTurnover = Math.max(0, pending.cumTurnover - auction.auctionTurnover);
    } else if (existing.length > 0) {
      const lastBefore = [...existing]
        .reverse()
        .find((b) => b.minuteIndex < pending.minuteIndex);
      barTurnover = lastBefore
        ? Math.max(0, pending.cumTurnover - lastBefore.cumTurnover)
        : pending.cumTurnover;
    } else {
      barTurnover = pending.cumTurnover;
    }

    const bar: IntradayBarRow = {
      symbol,
      tradeDate: this.displayTradeDate,
      minuteIndex: pending.minuteIndex,
      minuteStr: minuteIndexToLabel(pending.minuteIndex),
      price: pending.price,
      cumVolume: pending.cumVolume,
      cumTurnover: pending.cumTurnover,
      barTurnover,
      source: pending.source,
    };

    this.db.upsertIntradayBars([bar]);

    const idx = existing.findIndex((b) => b.minuteIndex === bar.minuteIndex);
    const updated = [...existing];
    if (idx >= 0) {
      updated[idx] = bar;
    } else {
      updated.push(bar);
      updated.sort((a, b) => a.minuteIndex - b.minuteIndex);
    }
    this.todayBars.set(symbol, updated);
  }

  private flushAllPendingBars(): void {
    for (const [symbol, pending] of this.pendingBars) {
      this.persistClosedPendingBar(symbol, pending);
    }
    this.pendingBars.clear();
  }

  private isLiveSnapshotStale(nowMs: number, phase: MarketPhase): boolean {
    if (this.mode !== 'LIVE') return false;

    const pollStaleThresholdMs = Math.max(15_000, this.effectiveIntervalSec * 3_000);
    if (this.lastUpdatedAt === null || nowMs - this.lastUpdatedAt > pollStaleThresholdMs) {
      return true;
    }

    // 连续竞价阶段同时校验核心行情自带时间戳，捕获上游冻结返回过期数据的场景
    if (phase === 'MORNING_SESSION' || phase === 'AFTERNOON_SESSION') {
      const upstreamStaleThresholdMs = Math.max(
        UPSTREAM_SNAPSHOT_STALE_MIN_MS,
        this.effectiveIntervalSec * 4_000
      );
      for (const sym of MARKET_TOTAL_COMPONENTS) {
        const snap = this.latestSnapshots.get(sym);
        if (!snap) continue;
        if (this.displayTradeDate && snap.tradeDate !== this.displayTradeDate) {
          return true;
        }
        if (nowMs - snap.timestampMs > upstreamStaleThresholdMs) {
          return true;
        }
      }
    }

    return false;
  }

  private buildDashboardState(
    watchlistItems: readonly WatchlistItemRow[],
    nowMs: number,
    phase: MarketPhase
  ): MarketDashboardState {
    const degradedReasons: string[] = [];

    if (this.calendarDegraded) {
      degradedReasons.push(`CALENDAR_${this.calendarSource.toUpperCase()}`);
    }
    if (this.activeSnapshotProvider === 'hithink') {
      degradedReasons.push('SNAPSHOT_HITHINK_EMERGENCY_FALLBACK');
    }
    if (this.consecutiveFailures > 0) {
      degradedReasons.push(`SNAPSHOT_FAILURES_${this.consecutiveFailures}`);
    }

    const stale = this.isLiveSnapshotStale(nowMs, phase);
    if (stale) {
      degradedReasons.push('DATA_STALE');
    }

    const currentMinuteIndex = timestampToMinuteIndex(nowMs);
    const currentElapsedSec = getElapsedSecondsInMinute(nowMs) ?? 60;

    // 1. 计算沪深两市总成交额（严格使用 000001.SH + 399106.SZ）
    const marketTotal = this.buildMarketTotalState(
      nowMs,
      phase,
      currentMinuteIndex,
      currentElapsedSec,
      stale
    );
    if (marketTotal.degraded) {
      degradedReasons.push(`MARKET_TOTAL_${marketTotal.degradedReason ?? 'DEGRADED'}`);
    }

    // 2. 计算已开启展示的主要板块指数 + 可选扩展指数
    const displayedIndices = resolveDisplayedIndices(
      this.enabledOptionalIndices,
      this.enabledCoreIndices
    );
    const displayedIndexSet = new Set(displayedIndices.map((meta) => meta.symbol));
    const indices = displayedIndices.map((meta) =>
      this.buildSymbolState({
        symbol: meta.symbol,
        name: meta.name,
        isIndex: true,
        scope: meta.scope,
        scopeDetail: meta.scopeDetail,
        symbolOverride: null,
        nowMs,
        phase,
        currentMinuteIndex,
        currentElapsedSec,
        globalStale: stale,
      })
    );

    // 3. 计算用户自选股（若历史库存在已开启为展示指数的同代码，去重避免重复渲染与告警）
    const watchlist = watchlistItems
      .filter((item) => !displayedIndexSet.has(item.symbol.trim().toUpperCase()))
      .map((item) =>
        this.buildSymbolState({
          symbol: item.symbol.trim().toUpperCase(),
          name: item.name,
          isIndex: false,
          symbolOverride: parseWatchlistOverride(item),
          nowMs,
          phase,
          currentMinuteIndex,
          currentElapsedSec,
          globalStale: stale,
        })
      );

    const status: CollectorStatus = {
      mode: this.mode,
      phase,
      tradeDate: this.displayTradeDate,
      prevTradeDate: this.prevTradeDate,
      activeSnapshotProvider: this.mode === 'LIVE' ? this.activeSnapshotProvider : null,
      activeIntradayProvider: this.activeIntradayProvider,
      calendarSource: this.calendarSource,
      calendarDegraded: this.calendarDegraded,
      pollingIntervalSec: this.effectiveIntervalSec,
      configuredIntervalSec: this.configuredIntervalSec,
      lastUpdatedAt: this.lastUpdatedAt,
      lastLatencyMs: this.lastLatencyMs,
      consecutiveFailures: this.consecutiveFailures,
      stale,
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };

    return {
      status,
      marketTotal,
      indices,
      watchlist,
      recentAlerts: [...this.recentAlerts],
    };
  }

  private expectedTodayLastClosedIndex(
    phase: MarketPhase,
    evalMinuteIndex: number | null
  ): number | null {
    if (this.mode === 'REPLAY') {
      if (phase === 'LUNCH_BREAK') return MORNING_BARS - 1;
      return TOTAL_DAY_BARS - 1;
    }
    if (evalMinuteIndex === null) return null;
    return evalMinuteIndex - 1;
  }

  private buildMarketTotalState(
    nowMs: number,
    phase: MarketPhase,
    currentMinuteIndex: number | null,
    currentElapsedSec: number,
    globalStale: boolean
  ): MarketTotalState {
    const [shSym, szSym] = MARKET_TOTAL_COMPONENTS;
    const shTodayBars = this.todayBars.get(shSym) ?? [];
    const szTodayBars = this.todayBars.get(szSym) ?? [];
    const shPrevBars = this.prevBars.get(shSym) ?? [];
    const szPrevBars = this.prevBars.get(szSym) ?? [];

    const todayAggSeries = aggregateMarketTotalSeries(
      toAggregatorBars(shTodayBars),
      toAggregatorBars(szTodayBars)
    );
    const prevAggSeries = aggregateMarketTotalSeries(
      toAggregatorBars(shPrevBars),
      toAggregatorBars(szPrevBars)
    );

    const todayAuctionInputs = [shSym, szSym]
      .map((sym) => {
        const a = this.todayAuctions.get(sym);
        return a && this.displayTradeDate
          ? { symbol: sym, tradeDate: this.displayTradeDate, auctionTurnover: a.auctionTurnover }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const todayAggAuction = aggregateMarketTotalAuction(todayAuctionInputs);

    const prevAuctionInputs = [shSym, szSym]
      .map((sym) => {
        const a = this.prevAuctions.get(sym);
        return a && this.prevTradeDate
          ? { symbol: sym, tradeDate: this.prevTradeDate, auctionTurnover: a.auctionTurnover }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const prevAggAuction = aggregateMarketTotalAuction(prevAuctionInputs);

    const prevFullDayTurnover =
      prevAggSeries.bars.length > 0
        ? prevAggSeries.bars[prevAggSeries.bars.length - 1].cumTurnover
        : null;

    let cumTurnover: number | null = null;
    let shTurnover: number | null = null;
    let szTurnover: number | null = null;
    let degraded = false;
    let degradedReason: string | null = null;
    let alertDegraded = globalStale;
    let evalMinuteIndex: number | null = null;
    let evalElapsedSec = 60;

    if (this.mode === 'LIVE') {
      const shSnap = this.latestSnapshots.get(shSym);
      const szSnap = this.latestSnapshots.get(szSym);
      const snapInputs: SymbolTurnoverSnapshot[] = [];
      if (shSnap) {
        snapInputs.push({
          symbol: shSnap.symbol,
          tradeDate: shSnap.tradeDate,
          minuteIndex: resolveSnapshotMinute(shSnap.timestampMs)?.minuteIndex ?? null,
          timestampMs: shSnap.timestampMs,
          cumTurnover: shSnap.turnover,
        });
      }
      if (szSnap) {
        snapInputs.push({
          symbol: szSnap.symbol,
          tradeDate: szSnap.tradeDate,
          minuteIndex: resolveSnapshotMinute(szSnap.timestampMs)?.minuteIndex ?? null,
          timestampMs: szSnap.timestampMs,
          cumTurnover: szSnap.turnover,
        });
      }

      const aggSnap = aggregateMarketTotalSnapshot(snapInputs);
      cumTurnover = aggSnap.cumTurnover;
      shTurnover = aggSnap.shTurnover;
      szTurnover = aggSnap.szTurnover;
      evalMinuteIndex = aggSnap.minuteIndex ?? currentMinuteIndex;
      evalElapsedSec =
        aggSnap.timestampMs !== null
          ? (resolveSnapshotMinute(aggSnap.timestampMs)?.elapsedSeconds ?? currentElapsedSec)
          : currentElapsedSec;

      if (aggSnap.degraded) {
        degraded = true;
        degradedReason = aggSnap.reason;
        alertDegraded = true;
      }

      if (
        todayAggSeries.missingShMinutes.length > 0 ||
        todayAggSeries.missingSzMinutes.length > 0
      ) {
        degraded = true;
        degradedReason = degradedReason ?? 'SERIES_INCOMPLETE';
      }
    } else {
      // REPLAY 模式：采用最新已聚合收盘分钟
      const lastBar =
        todayAggSeries.bars.length > 0
          ? todayAggSeries.bars[todayAggSeries.bars.length - 1]
          : null;
      cumTurnover = lastBar?.cumTurnover ?? null;
      shTurnover = lastBar?.shCumTurnover ?? null;
      szTurnover = lastBar?.szCumTurnover ?? null;
      evalMinuteIndex = lastBar?.minuteIndex ?? null;
      evalElapsedSec = 60;

      if (lastBar === null) {
        degraded = true;
        degradedReason = 'NO_SERIES_DATA';
        alertDegraded = true;
      } else if (todayAggSeries.degraded) {
        degraded = true;
        degradedReason = 'SERIES_INCOMPLETE';
      }
    }

    const expectedTodayLast = this.expectedTodayLastClosedIndex(phase, evalMinuteIndex);
    const todaySeriesHasGap = hasSeriesGap(todayAggSeries.bars, expectedTodayLast);
    const prevSeriesMissing = prevAggSeries.bars.length === 0;
    const prevSeriesIncomplete =
      !prevSeriesMissing &&
      (prevAggSeries.degraded || hasSeriesGap(prevAggSeries.bars, TOTAL_DAY_BARS - 1));

    if (prevSeriesMissing) {
      degraded = true;
      degradedReason = degradedReason ?? 'MISSING_PREV_BASELINE';
      alertDegraded = true;
    } else if (todaySeriesHasGap || prevSeriesIncomplete) {
      degraded = true;
      degradedReason = degradedReason ?? (todaySeriesHasGap ? 'SERIES_GAP' : 'PREV_SERIES_INCOMPLETE');
    }

    const alertCfg = resolveAlertConfig(this.alertEngine.getGlobalConfig());
    const metrics =
      evalMinuteIndex !== null
        ? evaluateEnergy({
            todaySeries: todayAggSeries.bars,
            prevSeries: prevAggSeries.bars,
            minuteIndex: evalMinuteIndex,
            currentTodayCumTurnover: cumTurnover,
            elapsedSeconds: evalElapsedSec,
            prevFullDayTurnover,
            prevAuctionTurnover: prevAggAuction.auctionTurnover,
            predictionProfile: this.getPredictionProfile(MARKET_TOTAL_SYMBOL),
            config: {
              ...this.energyConfig,
              slopeWindow: alertCfg.slopeWindow,
            },
          })
        : null;

    if (this.mode === 'LIVE' && metrics && this.displayTradeDate) {
      this.evaluateAndDispatchAlert({
        symbol: MARKET_TOTAL_SYMBOL,
        name: '沪深两市',
        tradeDate: this.displayTradeDate,
        timestampMs: nowMs,
        metrics,
        degraded: alertDegraded,
      });
    }

    return {
      symbol: MARKET_TOTAL_SYMBOL,
      name: '沪深两市',
      tradeDate: this.displayTradeDate,
      prevTradeDate: this.prevTradeDate,
      cumTurnover,
      shTurnover,
      szTurnover,
      auctionTurnover: todayAggAuction.auctionTurnover,
      prevAuctionTurnover: prevAggAuction.auctionTurnover,
      prevFullDayTurnover,
      metrics,
      todaySeries: todayAggSeries.bars.map((b) => ({
        minuteIndex: b.minuteIndex,
        cumTurnover: b.cumTurnover,
        barTurnover: b.barTurnover,
      })),
      prevSeries: prevAggSeries.bars.map((b) => ({
        minuteIndex: b.minuteIndex,
        cumTurnover: b.cumTurnover,
        barTurnover: b.barTurnover,
      })),
      shReference: {
        todaySeries: [...shTodayBars],
        minuteIndex: metrics?.minuteIndex ?? currentMinuteIndex,
        livePrice: this.mode === 'LIVE' ? (this.latestSnapshots.get(shSym)?.price ?? null) : null,
      },
      degraded,
      degradedReason,
    };
  }

  private buildSymbolState(params: {
    symbol: string;
    name: string;
    isIndex: boolean;
    scope?: SymbolEnergySnapshot['scope'];
    scopeDetail?: string;
    symbolOverride: SymbolAlertOverride | null;
    nowMs: number;
    phase: MarketPhase;
    currentMinuteIndex: number | null;
    currentElapsedSec: number;
    globalStale: boolean;
  }): SymbolEnergySnapshot {
    const { symbol, name } = params;
    const todaySeries = this.todayBars.get(symbol) ?? [];
    const prevSeries = this.prevBars.get(symbol) ?? [];
    const todayAuction = this.todayAuctions.get(symbol)?.auctionTurnover ?? null;
    const prevAuction = this.prevAuctions.get(symbol)?.auctionTurnover ?? null;
    const prevFullDayTurnover =
      prevSeries.length > 0 ? prevSeries[prevSeries.length - 1].cumTurnover : null;

    const snap = this.latestSnapshots.get(symbol) ?? null;

    // 399006.SZ 跨源口径防跳变检查（同时覆盖 LIVE 与 REPLAY）
    const crossSourceMismatch = hasCybCrossSourceMismatch({
      symbol,
      todayBars: todaySeries,
      prevBars: prevSeries,
      liveSnap: this.mode === 'LIVE' ? snap : null,
    });

    let degraded = false;
    let degradedReason: string | null = null;
    let alertDegraded = params.globalStale;
    let evalMinuteIndex: number | null = null;
    let evalTodayTurnover: number | null = null;
    let evalElapsedSec = 60;

    if (this.mode === 'LIVE') {
      if (!snap || (this.displayTradeDate && snap.tradeDate !== this.displayTradeDate)) {
        degraded = true;
        degradedReason = 'MISSING_OR_STALE_SNAPSHOT';
        alertDegraded = true;
      } else if (crossSourceMismatch) {
        degraded = true;
        degradedReason = 'CROSS_SOURCE_SCOPE_MISMATCH';
        alertDegraded = true;
      } else {
        const resolved = resolveSnapshotMinute(snap.timestampMs);
        evalMinuteIndex = resolved?.minuteIndex ?? params.currentMinuteIndex;
        evalTodayTurnover = snap.turnover;
        evalElapsedSec = resolved?.elapsedSeconds ?? params.currentElapsedSec;
      }
    } else {
      const lastBar = todaySeries.length > 0 ? todaySeries[todaySeries.length - 1] : null;
      if (!lastBar) {
        degraded = true;
        degradedReason = 'NO_SERIES_DATA';
        alertDegraded = true;
      } else if (crossSourceMismatch) {
        degraded = true;
        degradedReason = 'CROSS_SOURCE_SCOPE_MISMATCH';
        alertDegraded = true;
      } else {
        evalMinuteIndex = lastBar.minuteIndex;
        evalTodayTurnover = lastBar.cumTurnover;
        evalElapsedSec = 60;
      }
    }

    const expectedTodayLast = this.expectedTodayLastClosedIndex(params.phase, evalMinuteIndex);
    if (prevSeries.length === 0) {
      degraded = true;
      degradedReason = degradedReason ?? 'MISSING_PREV_BASELINE';
      alertDegraded = true;
    } else if (
      hasSeriesGap(todaySeries, expectedTodayLast) ||
      hasSeriesGap(prevSeries, TOTAL_DAY_BARS - 1)
    ) {
      degraded = true;
      degradedReason = degradedReason ?? 'MISSING_MINUTES';
    }

    const alertCfg = resolveAlertConfig(this.alertEngine.getGlobalConfig(), params.symbolOverride);
    const metrics =
      evalMinuteIndex !== null && !crossSourceMismatch
        ? evaluateEnergy({
            todaySeries,
            prevSeries,
            minuteIndex: evalMinuteIndex,
            currentTodayCumTurnover: evalTodayTurnover,
            elapsedSeconds: evalElapsedSec,
            prevFullDayTurnover,
            prevAuctionTurnover: prevAuction,
            predictionProfile: this.getPredictionProfile(symbol),
            config: {
              ...this.energyConfig,
              slopeWindow: alertCfg.slopeWindow,
            },
          })
        : null;

    if (this.mode === 'LIVE' && metrics && this.displayTradeDate) {
      this.evaluateAndDispatchAlert({
        symbol,
        name: snap?.name ?? name,
        tradeDate: this.displayTradeDate,
        timestampMs: params.nowMs,
        metrics,
        degraded: alertDegraded,
        symbolOverride: params.symbolOverride,
      });
    }

    return {
      symbol,
      name: snap?.name ?? name,
      isIndex: params.isIndex,
      scope: params.scope,
      scopeDetail: params.scopeDetail,
      // 本机定制：非实盘（午休/盘后/休市）且已有分时序列时不再下发最后一笔实时快照。
      // 否则收盘后界面一直显示集合竞价前的旧点位，而序列末点才是校准过的收盘值；
      // 界面在 quote 为空时会自动回退到序列末点（见 shared/snapshotView.ts）。
      quote: this.mode === 'LIVE' || todaySeries.length === 0 ? snap : null,
      metrics,
      auctionTurnover: todayAuction,
      prevAuctionTurnover: prevAuction,
      prevFullDayTurnover,
      todaySeries,
      prevSeries,
      degraded,
      degradedReason,
    };
  }

  private evaluateAndDispatchAlert(params: {
    symbol: string;
    name: string;
    tradeDate: string;
    timestampMs: number;
    metrics: NonNullable<SymbolEnergySnapshot['metrics']>;
    degraded: boolean;
    symbolOverride?: SymbolAlertOverride | null;
  }): void {
    const res = this.alertEngine.evaluate(params);
    if (!res.triggered || !res.event) return;

    this.recentAlerts.unshift(res.event);
    if (this.recentAlerts.length > MAX_RECENT_ALERTS) {
      this.recentAlerts.length = MAX_RECENT_ALERTS;
    }
    this.onAlertTriggered?.(res.event);
  }
}
