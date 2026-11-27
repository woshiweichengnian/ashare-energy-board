import {
  AlertEngine,
  DEFAULT_ENERGY_CONFIG,
  aggregateMarketTotalAuction,
  aggregateMarketTotalSeries,
  aggregateMarketTotalSnapshot,
  evaluateEnergy,
  getPrevTradingDate,
  minuteIndexToLabel,
  resolveAlertConfig,
  shanghaiToTimestampMs,
  type AlertRuleConfig,
  type EnergyEngineConfig,
  type IntradayPredictionProfile,
  type SymbolAlertOverride,
} from '../../core';
import {
  CORE_INDEX_SYMBOLS,
  DEFAULT_POLLING_INTERVAL_SEC,
  DEFAULT_REPLAY_STEP_MS,
  MARKET_TOTAL_COMPONENTS,
  MARKET_TOTAL_SYMBOL,
  MONITORED_INDEX_NAMES,
  REPLAY_ALERT_PREFIX,
  normalizeEnabledCoreIndices,
  normalizeEnabledOptionalIndices,
  resolveDisplayedIndices,
  resolveMonitoredIndexSymbols,
  type CoreIndexSymbol,
  type OptionalIndexSymbol,
} from '../../shared/constants';
import { hasCybCrossSourceMismatch, toAggregatorBars } from '../../shared/seriesGuards';
import type {
  AlertDispatchPayload,
  AlertEventRow,
  IntradayBarRow,
  MarketDashboardState,
  MarketPhaseType,
  MarketTotalState,
  ProviderId,
  QuoteSnapshot,
  ReplayStatusInfo,
  SymbolEnergySnapshot,
  WatchlistItemRow,
} from '../../shared/types';
import type { AppDatabase } from '../storage/database';
import {
  loadMarketTotalPredictionProfile,
  loadSymbolPredictionProfile,
} from '../storage/predictionProfileLoader';

const TOTAL_MINUTE_BARS = 240;
const TOTAL_REPLAY_STEPS = 241; // 0 = 09:25 集合竞价，1..240 = minuteIndex 0..239

export interface ResolvedReplayDates {
  tradeDate: string;
  prevTradeDate: string | null;
  availableDates: string[];
}

export interface DayReplayEngineOptions {
  database: AppDatabase;
  /** 指定回放交易日；省略或 null 时自动选择本地 SQLite 中最新已录制交易日 */
  tradeDate?: string | null;
  /** 每步推进间隔（毫秒），默认 120ms */
  stepIntervalMs?: number;
  energyConfig?: Partial<EnergyEngineConfig>;
  alertConfig?: Partial<AlertRuleConfig>;
  enabledCoreIndices?: readonly CoreIndexSymbol[];
  enabledOptionalIndices?: readonly OptionalIndexSymbol[];
  onStateUpdate?: (state: MarketDashboardState) => void;
  /** 回放产生的告警（严格内存态，不写实盘 alert_events，不弹系统通知） */
  onReplayAlert?: (payload: AlertDispatchPayload) => void;
}

export interface ReplayStepResult {
  stepIndex: number;
  timeLabel: string;
  minuteIndex: number | null;
  state: MarketDashboardState;
  triggeredAlerts: AlertDispatchPayload[];
}

export interface ReplayFullRunSummary {
  tradeDate: string;
  prevTradeDate: string | null;
  totalStepsExecuted: number;
  finalState: MarketDashboardState;
  triggeredAlerts: AlertDispatchPayload[];
  coldStartAlertCount: number;
  /** 每步非降级帧两市总成交额是否严格等于 000001.SH + 399106.SZ */
  marketTotalExactMatchAllSteps: boolean;
  /** 跨午休 13:02 (minuteIndex=122) 滚动斜率是否连续可用 */
  lunchBridgeSlopeAvailable: boolean;
  degradedStepsCount: number;
}

function parseWatchlistOverride(item: WatchlistItemRow): SymbolAlertOverride {
  const base: Partial<AlertRuleConfig> = { enabled: item.alertEnabled };
  if (!item.customThresholdsJson) return base;
  try {
    const parsed = JSON.parse(item.customThresholdsJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return base;
    const out: Record<string, unknown> = { ...base };
    for (const key of [
      'surgeSlopeThreshold',
      'surgeMultipleThreshold',
      'shrinkSlopeThreshold',
      'shrinkMultipleThreshold',
      'cooldownMinutes',
      'coldStartMinutes',
      'slopeWindow',
    ] as const) {
      if (typeof parsed[key] === 'number' && Number.isFinite(parsed[key])) {
        out[key] = parsed[key];
      }
    }
    if (parsed.matchMode === 'AND' || parsed.matchMode === 'OR') {
      out.matchMode = parsed.matchMode;
    }
    return out as SymbolAlertOverride;
  } catch {
    return base;
  }
}

function toProviderId(raw: string | undefined): ProviderId | null {
  if (raw === 'tencent' || raw === 'sina' || raw === 'eastmoney' || raw === 'hithink') {
    return raw;
  }
  return null;
}

function minuteIndexToTimestampMs(tradeDate: string, minuteIndex: number): number {
  const label = minuteIndexToLabel(minuteIndex);
  const [hh, mm] = label.split(':').map(Number);
  return shanghaiToTimestampMs(tradeDate, hh, mm, 59);
}

/**
 * 解析回放交易日与上一对比交易日（严格基于本地 SQLite 真实录制数据）。
 */
export function resolveReplayDates(
  database: AppDatabase,
  requestedDate?: string | null
): ResolvedReplayDates {
  const availableDates = database.getRecordedBarDates();
  if (availableDates.length === 0) {
    throw new Error('本地 SQLite 中暂无已录制的分钟行情数据，请先正常运行应用录制至少一个交易日。');
  }

  const tradeDate = requestedDate?.trim() || availableDates[0];
  if (!availableDates.includes(tradeDate)) {
    throw new Error(
      `本地 SQLite 中未找到交易日 ${tradeDate} 的录制数据。可用交易日：${availableDates.slice(0, 10).join(', ')}`
    );
  }

  const openDays = new Set(database.getTradingDays(true).map((d) => d.date));
  let prevTradeDate = getPrevTradingDate(tradeDate, openDays);
  if (!prevTradeDate) {
    // 若未缓存交易日历，则退回使用本地录制日期中严格早于 tradeDate 的最近一日
    prevTradeDate = availableDates.find((d) => d < tradeDate) ?? null;
  }

  return {
    tradeDate,
    prevTradeDate,
    availableDates,
  };
}

/**
 * 全天历史回放引擎（Phase 6）：
 * - 严格从本地 SQLite 已录制真实数据回放 09:25 → 15:00 全流程（零合成数据、零实时轮询）
 * - 100% 复用 src/core/ 实盘聚合、能量计算与告警判定引擎
 * - 回放告警仅在内存中标记 [回放] 并推送至 UI，绝不写入实盘 alert_events、绝不弹出系统通知
 */
export class DayReplayEngine {
  private readonly db: AppDatabase;
  private readonly tradeDate: string;
  private readonly prevTradeDate: string | null;
  private readonly stepIntervalMs: number;
  private readonly onStateUpdate?: (state: MarketDashboardState) => void;
  private readonly onReplayAlert?: (payload: AlertDispatchPayload) => void;

  private energyConfig: EnergyEngineConfig;
  private readonly alertEngine: AlertEngine;
  private enabledCoreIndices: CoreIndexSymbol[] = [...CORE_INDEX_SYMBOLS];
  private enabledOptionalIndices: OptionalIndexSymbol[] = [];

  private watchlistItems: WatchlistItemRow[] = [];
  private readonly todayBarsBySymbol = new Map<string, IntradayBarRow[]>();
  private readonly prevBarsBySymbol = new Map<string, IntradayBarRow[]>();
  private readonly todayAuctionBySymbol = new Map<string, { openPrice: number; auctionTurnover: number }>();
  private readonly prevAuctionBySymbol = new Map<string, { openPrice: number; auctionTurnover: number }>();
  private readonly predictionProfiles = new Map<string, IntradayPredictionProfile | null>();

  private currentStepIndex = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latestState: MarketDashboardState | null = null;
  private replayAlerts: AlertDispatchPayload[] = [];
  private nextReplayAlertId = -1;

  constructor(options: DayReplayEngineOptions) {
    this.db = options.database;
    const resolved = resolveReplayDates(options.database, options.tradeDate);
    this.tradeDate = resolved.tradeDate;
    this.prevTradeDate = resolved.prevTradeDate;
    this.stepIntervalMs =
      typeof options.stepIntervalMs === 'number' && Number.isFinite(options.stepIntervalMs)
        ? Math.max(0, Math.round(options.stepIntervalMs))
        : DEFAULT_REPLAY_STEP_MS;
    this.onStateUpdate = options.onStateUpdate;
    this.onReplayAlert = options.onReplayAlert;

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

    this.watchlistItems = this.db.getWatchlist();
    this.preloadRecordedData();
  }

  getTradeDate(): string {
    return this.tradeDate;
  }

  getPrevTradeDate(): string | null {
    return this.prevTradeDate;
  }

  getLatestState(): MarketDashboardState | null {
    return this.latestState;
  }

  getReplayAlerts(): AlertEventRow[] {
    return this.replayAlerts.map((item) => ({ ...item }));
  }

  markReplayAlertRead(id: number): boolean {
    let changed = false;
    this.replayAlerts = this.replayAlerts.map((item) => {
      if (item.id === id && !item.isRead) {
        changed = true;
        return { ...item, isRead: true };
      }
      return item;
    });
    return changed;
  }

  markAllReplayAlertsRead(tradeDate?: string): number {
    let count = 0;
    this.replayAlerts = this.replayAlerts.map((item) => {
      if (!item.isRead && (!tradeDate || item.tradeDate === tradeDate)) {
        count += 1;
        return { ...item, isRead: true };
      }
      return item;
    });
    return count;
  }

  updateEnergyConfig(next: Partial<EnergyEngineConfig>): void {
    this.energyConfig = { ...this.energyConfig, ...next };
    if (next.slopeWindow !== undefined) {
      this.alertEngine.updateGlobalConfig({ slopeWindow: next.slopeWindow });
    }
  }

  updateAlertConfig(next: Partial<AlertRuleConfig>): void {
    this.alertEngine.updateGlobalConfig(next);
    if (next.slopeWindow !== undefined) {
      this.energyConfig = { ...this.energyConfig, slopeWindow: next.slopeWindow };
    }
  }

  updateEnabledCoreIndices(next: readonly CoreIndexSymbol[]): void {
    this.enabledCoreIndices = normalizeEnabledCoreIndices(next);
    for (const sym of resolveMonitoredIndexSymbols(
      this.enabledOptionalIndices,
      this.enabledCoreIndices
    )) {
      if (!this.todayBarsBySymbol.has(sym)) {
        this.loadRecordedSymbol(sym);
      }
    }
  }

  updateEnabledOptionalIndices(next: readonly OptionalIndexSymbol[]): void {
    this.enabledOptionalIndices = normalizeEnabledOptionalIndices(next);
    for (const sym of resolveMonitoredIndexSymbols(
      this.enabledOptionalIndices,
      this.enabledCoreIndices
    )) {
      if (!this.todayBarsBySymbol.has(sym)) {
        this.loadRecordedSymbol(sym);
      }
    }
  }

  private preloadRecordedData(): void {
    const symbols = new Set<string>(
      resolveMonitoredIndexSymbols(this.enabledOptionalIndices, this.enabledCoreIndices)
    );
    for (const item of this.watchlistItems) {
      symbols.add(item.symbol.trim().toUpperCase());
    }

    for (const sym of symbols) {
      this.loadRecordedSymbol(sym);
    }

    this.predictionProfiles.set(
      MARKET_TOTAL_SYMBOL,
      loadMarketTotalPredictionProfile(this.db, this.tradeDate)
    );
  }

  /** 启动加速定时回放（驱动渲染进程从 09:25 推进至 15:00） */
  start(): void {
    this.stop();
    this.reloadWatchlistAndPreload();
    this.currentStepIndex = -1;
    this.replayAlerts = [];
    this.nextReplayAlertId = -1;
    this.alertEngine.resetCooldowns();

    // 立即推第一帧（09:25 集合竞价）
    this.stepNext();

    const interval = Math.max(10, this.stepIntervalMs);
    this.timer = setInterval(() => {
      const out = this.stepNext();
      if (!out || out.stepIndex >= TOTAL_REPLAY_STEPS - 1) {
        this.stop();
      }
    }, interval);
  }

  private reloadWatchlistAndPreload(): void {
    this.watchlistItems = this.db.getWatchlist();
    const symbols = new Set<string>(
      resolveMonitoredIndexSymbols(this.enabledOptionalIndices, this.enabledCoreIndices)
    );
    for (const item of this.watchlistItems) {
      symbols.add(item.symbol.trim().toUpperCase());
    }
    for (const sym of symbols) {
      if (!this.todayBarsBySymbol.has(sym)) {
        this.loadRecordedSymbol(sym);
      }
    }
  }

  private loadRecordedSymbol(sym: string): void {
    const todayBars = this.db.getIntradayBars(sym, this.tradeDate);
    this.todayBarsBySymbol.set(sym, todayBars);

    const todayAuc = this.db.getAuctionSnapshot(sym, this.tradeDate);
    if (todayAuc) {
      this.todayAuctionBySymbol.set(sym, {
        openPrice: todayAuc.openPrice,
        auctionTurnover: todayAuc.auctionTurnover,
      });
    }

    if (this.prevTradeDate) {
      const prevBars = this.db.getIntradayBars(sym, this.prevTradeDate);
      this.prevBarsBySymbol.set(sym, prevBars);

      const prevAuc = this.db.getAuctionSnapshot(sym, this.prevTradeDate);
      if (prevAuc) {
        this.prevAuctionBySymbol.set(sym, {
          openPrice: prevAuc.openPrice,
          auctionTurnover: prevAuc.auctionTurnover,
        });
      }
    } else {
      this.prevBarsBySymbol.set(sym, []);
    }

    this.predictionProfiles.set(sym, loadSymbolPredictionProfile(this.db, sym, this.tradeDate));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 推进到下一帧（stepIndex: 0 = 09:25 竞价，1..240 = minuteIndex 0..239） */
  stepNext(): ReplayStepResult | null {
    const nextStep = this.currentStepIndex + 1;
    if (nextStep >= TOTAL_REPLAY_STEPS) {
      return null;
    }

    this.currentStepIndex = nextStep;
    const isAuctionStep = nextStep === 0;
    const minuteIndex = isAuctionStep ? null : nextStep - 1;
    const timeLabel = isAuctionStep
      ? '09:25'
      : minuteIndex === TOTAL_MINUTE_BARS - 1
        ? '15:00'
        : minuteIndexToLabel(minuteIndex!);
    const timestampMs = isAuctionStep
      ? shanghaiToTimestampMs(this.tradeDate, 9, 25, 0)
      : minuteIndexToTimestampMs(this.tradeDate, minuteIndex!);

    const phase: MarketPhaseType = isAuctionStep
      ? 'OPEN_AUCTION'
      : minuteIndex! < 120
        ? 'MORNING_SESSION'
        : minuteIndex === TOTAL_MINUTE_BARS - 1
          ? 'POST_MARKET'
          : 'AFTERNOON_SESSION';

    const triggeredThisStep: AlertDispatchPayload[] = [];
    const emitReplayAlert = (ev: {
      symbol: string;
      name: string;
      tradeDate: string;
      minuteIndex: number;
      direction: 'SURGE' | 'SHRINK';
      slope: number;
      windowMultiple: number;
      cumRatio: number;
      message: string;
      createdAt: number;
    }) => {
      const payload: AlertDispatchPayload = {
        ...ev,
        id: this.nextReplayAlertId--,
        isRead: false,
        message: ev.message.startsWith(REPLAY_ALERT_PREFIX)
          ? ev.message
          : `${REPLAY_ALERT_PREFIX} ${ev.message}`,
        isSimulated: false,
        isReplay: true,
        // 回放告警不弹系统通知，也不发刺耳提示音（保持静默展示）
        muted: true,
      };
      this.replayAlerts = [payload, ...this.replayAlerts].slice(0, 200);
      triggeredThisStep.push(payload);
      this.onReplayAlert?.(payload);
    };

    const marketTotal = this.buildMarketTotalStep(minuteIndex, timestampMs, emitReplayAlert);
    const displayedIndices = resolveDisplayedIndices(
      this.enabledOptionalIndices,
      this.enabledCoreIndices
    );
    const displayedIndexSet = new Set(displayedIndices.map((meta) => meta.symbol));
    const indices = displayedIndices.map((meta) =>
      this.buildSymbolStep({
        symbol: meta.symbol,
        name: meta.name,
        isIndex: true,
        scope: meta.scope,
        scopeDetail: meta.scopeDetail,
        minuteIndex,
        timestampMs,
        emitReplayAlert,
      })
    );
    const watchlist = this.watchlistItems
      .filter((item) => !displayedIndexSet.has(item.symbol.trim().toUpperCase()))
      .map((item) =>
        this.buildSymbolStep({
          symbol: item.symbol,
          name: item.name,
          isIndex: false,
          minuteIndex,
          timestampMs,
          symbolOverride: parseWatchlistOverride(item),
          emitReplayAlert,
        })
      );

    const degradedReasons: string[] = [];
    if (!this.prevTradeDate) {
      degradedReasons.push('本地缺少上一交易日录制基线');
    }
    if (marketTotal.degraded && marketTotal.degradedReason) {
      degradedReasons.push(`两市总成交额：${marketTotal.degradedReason}`);
    }

    const firstTodayBar = this.todayBarsBySymbol.get('000001.SH')?.[0];
    const sourceProvider = toProviderId(firstTodayBar?.source);

    const replayInfo: ReplayStatusInfo = {
      active: true,
      tradeDate: this.tradeDate,
      prevTradeDate: this.prevTradeDate,
      stepIndex: nextStep,
      totalSteps: TOTAL_REPLAY_STEPS,
      currentTimeLabel: timeLabel,
      stepIntervalMs: this.stepIntervalMs,
      finished: nextStep >= TOTAL_REPLAY_STEPS - 1,
    };

    const state: MarketDashboardState = {
      status: {
        mode: 'REPLAY',
        phase,
        tradeDate: this.tradeDate,
        prevTradeDate: this.prevTradeDate,
        activeSnapshotProvider: null,
        activeIntradayProvider: sourceProvider,
        calendarSource: this.db.getTradingDays(true).length > 0 ? 'sqlite_cache' : 'inferred_degraded',
        calendarDegraded: !this.prevTradeDate,
        pollingIntervalSec: DEFAULT_POLLING_INTERVAL_SEC,
        configuredIntervalSec: DEFAULT_POLLING_INTERVAL_SEC,
        lastUpdatedAt: timestampMs,
        lastLatencyMs: 0,
        consecutiveFailures: 0,
        stale: false,
        degraded: degradedReasons.length > 0,
        degradedReasons,
        replay: replayInfo,
      },
      marketTotal,
      indices,
      watchlist,
      recentAlerts: this.replayAlerts,
    };

    this.latestState = state;
    this.onStateUpdate?.(state);

    return {
      stepIndex: nextStep,
      timeLabel,
      minuteIndex,
      state,
      triggeredAlerts: triggeredThisStep,
    };
  }

  /** 同步完整跑通 09:25 → 15:00 全天 241 帧并输出校验汇总 */
  runAllSteps(): ReplayFullRunSummary {
    this.stop();
    this.reloadWatchlistAndPreload();
    this.currentStepIndex = -1;
    this.replayAlerts = [];
    this.nextReplayAlertId = -1;
    this.alertEngine.resetCooldowns();

    let totalStepsExecuted = 0;
    let coldStartAlertCount = 0;
    let marketTotalExactMatchAllSteps = true;
    let lunchBridgeSlopeAvailable = false;
    let degradedStepsCount = 0;
    let lastState: MarketDashboardState | null = null;
    const allAlerts: AlertDispatchPayload[] = [];

    for (let s = 0; s < TOTAL_REPLAY_STEPS; s++) {
      const res = this.stepNext();
      if (!res) break;
      totalStepsExecuted += 1;
      lastState = res.state;

      if (res.state.marketTotal.degraded) {
        degradedStepsCount += 1;
      } else if (res.minuteIndex !== null) {
        const shBar = this.findBarAt(MARKET_TOTAL_COMPONENTS[0], this.todayBarsBySymbol, res.minuteIndex);
        const szBar = this.findBarAt(MARKET_TOTAL_COMPONENTS[1], this.todayBarsBySymbol, res.minuteIndex);
        if (shBar && szBar && res.state.marketTotal.cumTurnover !== null) {
          const expected = shBar.cumTurnover + szBar.cumTurnover;
          if (Math.abs(res.state.marketTotal.cumTurnover - expected) > 1e-3) {
            marketTotalExactMatchAllSteps = false;
          }
        }
      }

      if (res.minuteIndex === 122) {
        lunchBridgeSlopeAvailable = res.state.marketTotal.metrics?.slope !== null;
      }

      for (const a of res.triggeredAlerts) {
        allAlerts.push(a);
        if (a.minuteIndex < 5) {
          coldStartAlertCount += 1;
        }
      }
    }

    if (!lastState) {
      throw new Error('全天回放未产出任何状态帧。');
    }

    return {
      tradeDate: this.tradeDate,
      prevTradeDate: this.prevTradeDate,
      totalStepsExecuted,
      finalState: lastState,
      triggeredAlerts: allAlerts,
      coldStartAlertCount,
      marketTotalExactMatchAllSteps,
      lunchBridgeSlopeAvailable,
      degradedStepsCount,
    };
  }

  private findBarAt(
    symbol: string,
    store: Map<string, IntradayBarRow[]>,
    minuteIndex: number
  ): IntradayBarRow | null {
    const bars = store.get(symbol);
    if (!bars) return null;
    return bars.find((b) => b.minuteIndex === minuteIndex) ?? null;
  }

  private buildMarketTotalStep(
    minuteIndex: number | null,
    timestampMs: number,
    emitReplayAlert: (ev: {
      symbol: string;
      name: string;
      tradeDate: string;
      minuteIndex: number;
      direction: 'SURGE' | 'SHRINK';
      slope: number;
      windowMultiple: number;
      cumRatio: number;
      message: string;
      createdAt: number;
    }) => void
  ): MarketTotalState {
    const [shSym, szSym] = MARKET_TOTAL_COMPONENTS;
    const shTodayAll = this.todayBarsBySymbol.get(shSym) ?? [];
    const szTodayAll = this.todayBarsBySymbol.get(szSym) ?? [];
    const shPrevAll = this.prevBarsBySymbol.get(shSym) ?? [];
    const szPrevAll = this.prevBarsBySymbol.get(szSym) ?? [];

    const shTodayVisible =
      minuteIndex === null ? [] : shTodayAll.filter((b) => b.minuteIndex <= minuteIndex);
    const szTodayVisible =
      minuteIndex === null ? [] : szTodayAll.filter((b) => b.minuteIndex <= minuteIndex);

    const todayAggSeries = aggregateMarketTotalSeries(
      toAggregatorBars(shTodayVisible),
      toAggregatorBars(szTodayVisible)
    );
    const prevAggSeries = aggregateMarketTotalSeries(
      toAggregatorBars(shPrevAll),
      toAggregatorBars(szPrevAll)
    );

    const shTodayAuc = this.todayAuctionBySymbol.get(shSym)?.auctionTurnover ?? null;
    const szTodayAuc = this.todayAuctionBySymbol.get(szSym)?.auctionTurnover ?? null;
    const todayAggAuc = aggregateMarketTotalAuction([
      ...(shTodayAuc !== null
        ? [{ symbol: shSym, tradeDate: this.tradeDate, auctionTurnover: shTodayAuc }]
        : []),
      ...(szTodayAuc !== null
        ? [{ symbol: szSym, tradeDate: this.tradeDate, auctionTurnover: szTodayAuc }]
        : []),
    ]);

    const shPrevAuc = this.prevAuctionBySymbol.get(shSym)?.auctionTurnover ?? null;
    const szPrevAuc = this.prevAuctionBySymbol.get(szSym)?.auctionTurnover ?? null;
    const prevAggAuc = aggregateMarketTotalAuction([
      ...(shPrevAuc !== null && this.prevTradeDate
        ? [{ symbol: shSym, tradeDate: this.prevTradeDate, auctionTurnover: shPrevAuc }]
        : []),
      ...(szPrevAuc !== null && this.prevTradeDate
        ? [{ symbol: szSym, tradeDate: this.prevTradeDate, auctionTurnover: szPrevAuc }]
        : []),
    ]);

    const prevFullDayTurnover =
      prevAggSeries.bars.length > 0
        ? prevAggSeries.bars[prevAggSeries.bars.length - 1].cumTurnover
        : null;

    if (minuteIndex === null) {
      // 09:25 集合竞价帧：展示竞价锚点，不进入连续竞价斜率与告警
      return {
        symbol: MARKET_TOTAL_SYMBOL,
        name: '沪深两市',
        tradeDate: this.tradeDate,
        prevTradeDate: this.prevTradeDate,
        cumTurnover: todayAggAuc.auctionTurnover,
        shTurnover: shTodayAuc,
        szTurnover: szTodayAuc,
        auctionTurnover: todayAggAuc.auctionTurnover,
        prevAuctionTurnover: prevAggAuc.auctionTurnover,
        prevFullDayTurnover,
        metrics: null,
        todaySeries: [],
        prevSeries: prevAggSeries.bars.map((b) => ({
          minuteIndex: b.minuteIndex,
          cumTurnover: b.cumTurnover,
          barTurnover: b.barTurnover,
        })),
        degraded: todayAggAuc.degraded,
        degradedReason: todayAggAuc.degraded ? '09:25 集合竞价数据缺失（不补零）' : null,
      };
    }

    const shCur = shTodayVisible.find((b) => b.minuteIndex === minuteIndex) ?? null;
    const szCur = szTodayVisible.find((b) => b.minuteIndex === minuteIndex) ?? null;

    const snapAgg = aggregateMarketTotalSnapshot(
      [
        ...(shCur
          ? [
              {
                symbol: shSym,
                tradeDate: this.tradeDate,
                minuteIndex,
                cumTurnover: shCur.cumTurnover,
                timestampMs,
              },
            ]
          : []),
        ...(szCur
          ? [
              {
                symbol: szSym,
                tradeDate: this.tradeDate,
                minuteIndex,
                cumTurnover: szCur.cumTurnover,
                timestampMs,
              },
            ]
          : []),
      ],
      { maxTimestampDriftMs: 60_000 }
    );

    let degraded = snapAgg.degraded;
    let degradedReason: string | null = snapAgg.reason;
    if (prevAggSeries.bars.length === 0) {
      degraded = true;
      degradedReason = degradedReason ?? 'MISSING_PREV_BASELINE';
    }

    const alertCfg = resolveAlertConfig(this.alertEngine.getGlobalConfig());
    const metrics = !snapAgg.degraded
      ? evaluateEnergy({
          todaySeries: todayAggSeries.bars,
          prevSeries: prevAggSeries.bars,
          minuteIndex,
          currentTodayCumTurnover: snapAgg.cumTurnover,
          elapsedSeconds: 60,
          prevFullDayTurnover,
          prevAuctionTurnover: prevAggAuc.auctionTurnover,
          predictionProfile: this.predictionProfiles.get(MARKET_TOTAL_SYMBOL) ?? null,
          config: {
            ...this.energyConfig,
            slopeWindow: alertCfg.slopeWindow,
          },
        })
      : null;

    if (metrics) {
      const evalRes = this.alertEngine.evaluate({
        symbol: MARKET_TOTAL_SYMBOL,
        name: '沪深两市',
        tradeDate: this.tradeDate,
        timestampMs,
        metrics,
        degraded,
      });
      if (evalRes.triggered && evalRes.event) {
        emitReplayAlert(evalRes.event);
      }
    }

    return {
      symbol: MARKET_TOTAL_SYMBOL,
      name: '沪深两市',
      tradeDate: this.tradeDate,
      prevTradeDate: this.prevTradeDate,
      cumTurnover: snapAgg.cumTurnover,
      shTurnover: snapAgg.shTurnover,
      szTurnover: snapAgg.szTurnover,
      auctionTurnover: todayAggAuc.auctionTurnover,
      prevAuctionTurnover: prevAggAuc.auctionTurnover,
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
        todaySeries: [...shTodayVisible],
        minuteIndex,
        livePrice: shTodayVisible.length > 0 ? shTodayVisible[shTodayVisible.length - 1].price : null,
      },
      degraded,
      degradedReason,
    };
  }

  private buildSymbolStep(params: {
    symbol: string;
    name: string;
    isIndex: boolean;
    scope?: SymbolEnergySnapshot['scope'];
    scopeDetail?: string;
    minuteIndex: number | null;
    timestampMs: number;
    symbolOverride?: SymbolAlertOverride;
    emitReplayAlert: (ev: {
      symbol: string;
      name: string;
      tradeDate: string;
      minuteIndex: number;
      direction: 'SURGE' | 'SHRINK';
      slope: number;
      windowMultiple: number;
      cumRatio: number;
      message: string;
      createdAt: number;
    }) => void;
  }): SymbolEnergySnapshot {
    const { symbol, name, minuteIndex, timestampMs } = params;
    const todayAll = this.todayBarsBySymbol.get(symbol) ?? [];
    const prevAll = this.prevBarsBySymbol.get(symbol) ?? [];
    const todayVisible =
      minuteIndex === null ? [] : todayAll.filter((b) => b.minuteIndex <= minuteIndex);

    const todayAuc = this.todayAuctionBySymbol.get(symbol)?.auctionTurnover ?? null;
    const prevAuc = this.prevAuctionBySymbol.get(symbol)?.auctionTurnover ?? null;
    const prevFullDayTurnover =
      prevAll.length > 0 ? prevAll[prevAll.length - 1].cumTurnover : null;
    const prevClose = prevAll.length > 0 ? prevAll[prevAll.length - 1].price : 0;

    if (minuteIndex === null) {
      return {
        symbol,
        name: MONITORED_INDEX_NAMES[symbol] ?? name,
        isIndex: params.isIndex,
        scope: params.scope,
        scopeDetail: params.scopeDetail,
        quote: null,
        metrics: null,
        auctionTurnover: todayAuc,
        prevAuctionTurnover: prevAuc,
        prevFullDayTurnover,
        todaySeries: [],
        prevSeries: prevAll,
        degraded: todayAuc === null,
        degradedReason: todayAuc === null ? 'NO_AUCTION_SNAPSHOT' : null,
      };
    }

    const curBar = todayVisible.find((b) => b.minuteIndex === minuteIndex) ?? null;
    const crossSourceMismatch = hasCybCrossSourceMismatch({
      symbol,
      todayBars: todayVisible,
      prevBars: prevAll,
      liveSnap: null,
    });

    let degraded = false;
    let degradedReason: string | null = null;
    if (!curBar) {
      degraded = true;
      degradedReason = 'MISSING_MINUTE_BAR';
    } else if (crossSourceMismatch) {
      degraded = true;
      degradedReason = 'CROSS_SOURCE_SCOPE_MISMATCH';
    }
    if (prevAll.length === 0) {
      degraded = true;
      degradedReason = degradedReason ?? 'MISSING_PREV_BASELINE';
    }

    const quote: QuoteSnapshot | null = curBar
      ? {
          symbol,
          name: MONITORED_INDEX_NAMES[symbol] ?? name,
          price: curBar.price,
          prevClose,
          open: todayVisible[0]?.price ?? curBar.price,
          high: todayVisible.reduce((mx, b) => Math.max(mx, b.price), curBar.price),
          low: todayVisible.reduce((mn, b) => Math.min(mn, b.price), curBar.price),
          changeAmt: prevClose > 0 ? curBar.price - prevClose : 0,
          changePct: prevClose > 0 ? ((curBar.price - prevClose) / prevClose) * 100 : 0,
          volumeShares: curBar.cumVolume,
          turnover: curBar.cumTurnover,
          tradeDate: this.tradeDate,
          timestampMs,
          source: toProviderId(curBar.source) ?? 'tencent',
        }
      : null;

    const alertCfg = resolveAlertConfig(this.alertEngine.getGlobalConfig(), params.symbolOverride);
    const metrics =
      curBar && !crossSourceMismatch
        ? evaluateEnergy({
            todaySeries: todayVisible,
            prevSeries: prevAll,
            minuteIndex,
            currentTodayCumTurnover: curBar.cumTurnover,
            elapsedSeconds: 60,
            prevFullDayTurnover,
            prevAuctionTurnover: prevAuc,
            predictionProfile: this.predictionProfiles.get(symbol) ?? null,
            config: {
              ...this.energyConfig,
              slopeWindow: alertCfg.slopeWindow,
            },
          })
        : null;

    if (metrics) {
      const evalRes = this.alertEngine.evaluate({
        symbol,
        name: MONITORED_INDEX_NAMES[symbol] ?? name,
        tradeDate: this.tradeDate,
        timestampMs,
        metrics,
        degraded,
        symbolOverride: params.symbolOverride,
      });
      if (evalRes.triggered && evalRes.event) {
        params.emitReplayAlert(evalRes.event);
      }
    }

    return {
      symbol,
      name: MONITORED_INDEX_NAMES[symbol] ?? name,
      isIndex: params.isIndex,
      scope: params.scope,
      scopeDetail: params.scopeDetail,
      quote,
      metrics,
      auctionTurnover: todayAuc,
      prevAuctionTurnover: prevAuc,
      prevFullDayTurnover,
      todaySeries: todayVisible,
      prevSeries: prevAll,
      degraded,
      degradedReason,
    };
  }
}
