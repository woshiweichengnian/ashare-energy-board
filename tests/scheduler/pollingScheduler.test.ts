import { describe, expect, it, vi } from 'vitest';
import { minuteIndexToLabel, shanghaiToTimestampMs } from '../../src/core/tradingClock';
import {
  HithinkProvider,
  ProviderRequestError,
  type MarketDataProvider,
} from '../../src/main/providers';
import { PollingScheduler } from '../../src/main/scheduler';
import { AppDatabase } from '../../src/main/storage/database';
import type {
  AlertEventInput,
  IntradayBarRow,
  IntradayDayData,
  MarketDashboardState,
  ProviderId,
  QuoteSnapshot,
} from '../../src/shared/types';

function makeIntradayDay(params: {
  symbol: string;
  tradeDate: string;
  barCount: number;
  baseTurnoverPerMin: number;
  auctionTurnover?: number;
  skipMinutes?: ReadonlySet<number>;
  source?: ProviderId;
}): IntradayDayData {
  const auctionTurnover = params.auctionTurnover ?? params.baseTurnoverPerMin;
  const bars: IntradayBarRow[] = [];
  let cumTurnover = auctionTurnover;
  let cumVolume = 100_000;

  for (let idx = 0; idx < params.barCount; idx++) {
    cumTurnover += params.baseTurnoverPerMin;
    cumVolume += 50_000;
    if (params.skipMinutes?.has(idx)) {
      continue;
    }
    bars.push({
      symbol: params.symbol,
      tradeDate: params.tradeDate,
      minuteIndex: idx,
      minuteStr: minuteIndexToLabel(idx),
      price: 3500 + idx * 0.1,
      cumVolume,
      cumTurnover,
      barTurnover: params.baseTurnoverPerMin,
      source: params.source ?? 'tencent',
    });
  }

  return {
    symbol: params.symbol,
    tradeDate: params.tradeDate,
    prevClose: 3500,
    auction: { openPrice: 3500, auctionTurnover },
    bars,
    source: params.source ?? 'tencent',
  };
}

function makeSnapshot(params: {
  symbol: string;
  name?: string;
  tradeDate: string;
  timestampMs: number;
  turnover: number;
  price?: number;
  source?: ProviderId;
}): QuoteSnapshot {
  return {
    symbol: params.symbol,
    name: params.name ?? params.symbol,
    price: params.price ?? 3550,
    prevClose: 3500,
    open: 3510,
    high: 3560,
    low: 3505,
    changeAmt: 50,
    changePct: 1.43,
    volumeShares: 10_000_000,
    turnover: params.turnover,
    tradeDate: params.tradeDate,
    timestampMs: params.timestampMs,
    source: params.source ?? 'tencent',
  };
}

function createFakeProvider(
  id: ProviderId,
  overrides: Partial<MarketDataProvider> = {}
): MarketDataProvider {
  return {
    id,
    fetchBatchSnapshots: vi.fn(async () => new Map<string, QuoteSnapshot>()),
    fetchIntradayMinutes: vi.fn(async () => []),
    searchTickers: vi.fn(async () => []),
    healthCheck: vi.fn(async () => ({ provider: id, ok: true, latencyMs: 12, error: null })),
    ...overrides,
  };
}

function createFakeHithink(params: {
  configured: boolean;
  tradingDays?: string[];
  snapshots?: (symbols: readonly string[]) => Promise<Map<string, QuoteSnapshot>>;
}): HithinkProvider {
  const secretStore = {
    getApiKey: () => (params.configured ? 'fake-key' : null),
  };
  const provider = new HithinkProvider({
    secretStore,
    sleepImpl: async () => {},
  });

  vi.spyOn(provider, 'fetchTradingDays').mockImplementation(async () => {
    if (!params.configured) {
      throw new ProviderRequestError({ provider: 'hithink', message: 'not configured' });
    }
    return (params.tradingDays ?? ['2026-11-20', '2026-11-23', '2026-11-24']).map((date) => ({
      date,
      isOpen: true,
    }));
  });

  if (params.snapshots) {
    vi.spyOn(provider, 'fetchBatchSnapshots').mockImplementation(async (syms) =>
      params.snapshots!(syms)
    );
  }

  return provider;
}

describe('PollingScheduler', () => {
  it('backfills 09:30-10:34 today and full 240 prev-day minutes on 10:35 startup and runs LIVE poll', async () => {
    const db = new AppDatabase(':memory:');
    const nowMs = shanghaiToTimestampMs('2026-11-24', 10, 35, 15); // minuteIndex = 65

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-24',
          barCount: 65, // 0..64 (09:30..10:34)
          baseTurnoverPerMin: 2e9,
        }),
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-23',
          barCount: 240,
          baseTurnoverPerMin: 1.5e9,
        }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const map = new Map<string, QuoteSnapshot>();
        for (const sym of symbols) {
          map.set(
            sym,
            makeSnapshot({
              symbol: sym,
              tradeDate: '2026-11-24',
              timestampMs: nowMs,
              turnover: 133e9,
              source: 'tencent',
            })
          );
        }
        return map;
      }),
    });

    const secondary = createFakeProvider('sina');
    const eastmoney = createFakeProvider('eastmoney');
    const hithink = createFakeHithink({ configured: true });

    const pushedStates: MarketDashboardState[] = [];
    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => 'fake-key',
        getStatus: () => ({ configured: true, source: 'env', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
      onStateUpdate: (s) => pushedStates.push(s),
    });

    const state = await scheduler.tickOnce();

    expect(state.status.mode).toBe('LIVE');
    expect(state.status.phase).toBe('MORNING_SESSION');
    expect(state.status.calendarSource).toBe('hithink');
    expect(state.status.calendarDegraded).toBe(false);
    expect(state.status.activeSnapshotProvider).toBe('tencent');
    expect(state.status.degraded).toBe(false);
    expect(pushedStates).toHaveLength(1);

    // 验证 SQLite 已落盘昨日完整 240 分钟 + 今日已过 65 分钟（09:30..10:34）
    expect(db.getIntradayBars('000001.SH', '2026-11-23')).toHaveLength(240);
    expect(db.getIntradayBars('000001.SH', '2026-11-24')).toHaveLength(65);
    expect(db.getIntradayBars('399106.SZ', '2026-11-23')).toHaveLength(240);

    // 两市总成交额 = 000001.SH + 399106.SZ = 266e9，绝不叠加其他 3 只指数
    expect(state.marketTotal.cumTurnover).toBe(266e9);
    expect(state.marketTotal.degraded).toBe(false);
    expect(state.marketTotal.metrics?.volumeState).toBe('EXPANDING');
    expect(state.indices).toHaveLength(4);

    // 二次 tick 不应重复回补已有分时，只执行一次批量快照请求
    await scheduler.tickOnce();
    expect(primary.fetchIntradayMinutes).toHaveBeenCalledTimes(5); // 仅首次 5 指数各 1 次
    expect(primary.fetchBatchSnapshots).toHaveBeenCalledTimes(2);

    db.close();
  });

  it('serves REPLAY mode after close and on closed days with zero high-frequency snapshot requests', async () => {
    const db = new AppDatabase(':memory:');
    // 预置 35 个交易日以验证盘后触发 30 日滚动清理
    const openDays: string[] = [];
    for (let i = 0; i < 35; i++) {
      const dt = new Date(Date.UTC(2026, 9, 1 + i));
      openDays.push(dt.toISOString().slice(0, 10));
    }
    const lastDay = openDays[34]; // 2026-11-04
    const prevDay = openDays[33]; // 2026-11-03

    // 写入一条最旧交易日的历史数据，期望盘后被清理
    db.upsertIntradayBars([
      {
        symbol: '000001.SH',
        tradeDate: openDays[0],
        minuteIndex: 0,
        minuteStr: '09:30',
        price: 3000,
        cumVolume: 1000,
        cumTurnover: 1e8,
        barTurnover: 1e8,
        source: 'tencent',
      },
    ]);

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({ symbol, tradeDate: lastDay, barCount: 240, baseTurnoverPerMin: 2e9 }),
        makeIntradayDay({ symbol, tradeDate: prevDay, barCount: 240, baseTurnoverPerMin: 1.8e9 }),
      ]),
    });
    const secondary = createFakeProvider('sina');
    const eastmoney = createFakeProvider('eastmoney');
    const hithink = createFakeHithink({ configured: true, tradingDays: openDays });

    // 1. 盘后 15:30 启动
    let currentNow = shanghaiToTimestampMs(lastDay, 15, 30, 0);
    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => 'fake-key',
        getStatus: () => ({ configured: true, source: 'env', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      nowFn: () => currentNow,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const postMarketState = await scheduler.tickOnce();
    expect(postMarketState.status.mode).toBe('REPLAY');
    expect(postMarketState.status.phase).toBe('POST_MARKET');
    expect(postMarketState.status.tradeDate).toBe(lastDay);
    expect(postMarketState.status.prevTradeDate).toBe(prevDay);
    expect(postMarketState.marketTotal.todaySeries).toHaveLength(240);
    expect(postMarketState.marketTotal.metrics?.volumeState).toBe('EXPANDING');
    // 盘后零高频快照请求
    expect(primary.fetchBatchSnapshots).not.toHaveBeenCalled();
    expect(secondary.fetchBatchSnapshots).not.toHaveBeenCalled();
    // 盘后自动触发一次 30 交易日清理
    expect(db.getIntradayBars('000001.SH', openDays[0])).toHaveLength(0);

    // 2. 休市日（非交易日 2026-11-07 周六）启动
    currentNow = shanghaiToTimestampMs('2026-11-07', 10, 30, 0);
    const closedDayState = await scheduler.tickOnce();
    expect(closedDayState.status.mode).toBe('REPLAY');
    expect(closedDayState.status.phase).toBe('CLOSED_DAY');
    expect(closedDayState.status.tradeDate).toBe(lastDay);
    expect(primary.fetchBatchSnapshots).not.toHaveBeenCalled();

    db.close();
  });

  it('fails over from primary to secondary on errors with exponential backoff and recovers when primary heals', async () => {
    const db = new AppDatabase(':memory:');
    let nowMs = shanghaiToTimestampMs('2026-11-24', 10, 0, 0);
    let primaryShouldFail = true;
    let primaryHealthy = false;

    const makeAllSnaps = (symbols: readonly string[], source: ProviderId) => {
      const m = new Map<string, QuoteSnapshot>();
      for (const s of symbols) {
        m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-24', timestampMs: nowMs, turnover: 60e9, source }));
      }
      return m;
    };

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({ symbol, tradeDate: '2026-11-24', barCount: 30, baseTurnoverPerMin: 2e9 }),
        makeIntradayDay({ symbol, tradeDate: '2026-11-23', barCount: 240, baseTurnoverPerMin: 2e9 }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        if (primaryShouldFail) {
          throw new ProviderRequestError({
            provider: 'tencent',
            message: 'timeout',
            retryable: true,
          });
        }
        return makeAllSnaps(symbols, 'tencent');
      }),
      healthCheck: vi.fn(async () => ({
        provider: 'tencent' as const,
        ok: primaryHealthy,
        latencyMs: 18,
        error: primaryHealthy ? null : 'down',
      })),
    });

    const secondary = createFakeProvider('sina', {
      fetchBatchSnapshots: vi.fn(async (symbols) => makeAllSnaps(symbols, 'sina')),
    });

    const eastmoney = createFakeProvider('eastmoney');
    const hithink = createFakeHithink({ configured: true });

    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => 'fake-key',
        getStatus: () => ({ configured: true, source: 'env', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      configuredIntervalSec: 3,
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    // 第 1 次失败：退避 3 -> 6s，未切源
    const s1 = await scheduler.tickOnce();
    expect(s1.status.activeSnapshotProvider).toBe('tencent');
    expect(s1.status.pollingIntervalSec).toBe(6);
    expect(s1.status.consecutiveFailures).toBe(1);

    // 第 2 次失败：退避 6 -> 12s，未切源
    nowMs += 6_000;
    const s2 = await scheduler.tickOnce();
    expect(s2.status.activeSnapshotProvider).toBe('tencent');
    expect(s2.status.pollingIntervalSec).toBe(12);

    // 第 3 次失败：触发故障转移至新浪并当次补拉成功，间隔从 24 回落到 12
    nowMs += 12_000;
    const s3 = await scheduler.tickOnce();
    expect(s3.status.activeSnapshotProvider).toBe('sina');
    expect(s3.status.lastLatencyMs).not.toBeNull();
    expect(s3.status.consecutiveFailures).toBe(0);
    expect(s3.status.pollingIntervalSec).toBe(12);

    // 连续成功逐步回落至配置间隔 3s
    nowMs += 12_000;
    const s4 = await scheduler.tickOnce();
    expect(s4.status.pollingIntervalSec).toBe(6);
    nowMs += 6_000;
    const s5 = await scheduler.tickOnce();
    expect(s5.status.pollingIntervalSec).toBe(3);

    // 5 分钟后主源恢复健康 → 自动探测切回腾讯
    primaryShouldFail = false;
    primaryHealthy = true;
    nowMs += 5 * 60 * 1000 + 1000;
    const s6 = await scheduler.tickOnce();
    expect(primary.healthCheck).toHaveBeenCalledTimes(1);
    expect(s6.status.activeSnapshotProvider).toBe('tencent');
    expect(s6.status.pollingIntervalSec).toBe(3);

    db.close();
  });

  it('never zero-fills missing upstream minutes and runs cleanly without Hithink API key (degraded calendar)', async () => {
    const db = new AppDatabase(':memory:');
    const nowMs = shanghaiToTimestampMs('2026-11-24', 10, 10, 0); // minuteIndex = 40

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-24',
          barCount: 40,
          baseTurnoverPerMin: 2e9,
          // 模拟上游缺失第 15 分钟
          skipMinutes: symbol === '000001.SH' ? new Set([15]) : undefined,
        }),
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-23',
          barCount: 240,
          baseTurnoverPerMin: 2e9,
        }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-24', timestampMs: nowMs, turnover: 82e9, source: 'tencent' }));
        }
        return m;
      }),
    });

    const secondary = createFakeProvider('sina');
    const eastmoney = createFakeProvider('eastmoney');
    const hithink = createFakeHithink({ configured: false }); // 未配置 Key

    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => null,
        getStatus: () => ({ configured: false, source: 'none', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const state = await scheduler.tickOnce();

    // 未配置同花顺 Key 时基于公开源推断交易日，且日历标记降级
    expect(state.status.calendarSource).toBe('inferred_degraded');
    expect(state.status.calendarDegraded).toBe(true);
    expect(state.status.tradeDate).toBe('2026-11-24');
    expect(state.status.prevTradeDate).toBe('2026-11-23');
    expect(state.status.degraded).toBe(true);

    // 上游缺失第 15 分钟：intraday_bars 中绝不出现补 0 的第 15 分钟，且状态带降级标记
    const shBars = db.getIntradayBars('000001.SH', '2026-11-24');
    expect(shBars).toHaveLength(39);
    expect(shBars.find((b) => b.minuteIndex === 15)).toBeUndefined();
    expect(state.marketTotal.degraded).toBe(true);

    db.close();
  });

  it('captures 09:25 auction, persists closed minute bars, picks up dynamic watchlist changes, and dispatches alerts', async () => {
    const db = new AppDatabase(':memory:');
    let nowMs = shanghaiToTimestampMs('2026-11-24', 9, 25, 10); // AUCTION_GAP
    const alerts: AlertEventInput[] = [];

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-23',
          barCount: 240,
          baseTurnoverPerMin: 1e9,
          auctionTurnover: 1e9,
        }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          // 按当前时间决定成交额，构造清晰放量斜率
          const isGap = nowMs < shanghaiToTimestampMs('2026-11-24', 9, 30, 0);
          m.set(
            s,
            makeSnapshot({
              symbol: s,
              tradeDate: '2026-11-24',
              timestampMs: nowMs,
              turnover: isGap ? 1.2e9 : 25e9,
              source: 'tencent',
            })
          );
        }
        return m;
      }),
    });

    const secondary = createFakeProvider('sina');
    const eastmoney = createFakeProvider('eastmoney');
    const hithink = createFakeHithink({ configured: true });

    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => 'fake-key',
        getStatus: () => ({ configured: true, source: 'env', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
      onAlertTriggered: (ev) => alerts.push(ev),
    });

    // 1. 09:25 捕获开盘竞价并写入 auction_snapshots
    await scheduler.tickOnce();
    const shAuction = db.getAuctionSnapshot('000001.SH', '2026-11-24');
    expect(shAuction).not.toBeNull();
    expect(shAuction?.auctionTurnover).toBe(1.2e9);

    // 2. 动态添加自选股（不重启调度器），并按真实时间推进 09:30 -> 09:36 逐分钟闭合落盘并触发快速放量告警
    db.upsertWatchlistItem({
      symbol: '600519.SH',
      name: '贵州茅台',
      sortOrder: 0,
      alertEnabled: true,
      customThresholdsJson: null,
    });

    // 昨日 600519.SH 竞价 1e9、每分钟 +1e9 → prev(k) = (k + 2) * 1e9
    // 今日逐步加速放量：ratios = [0%, 0%, +2%, +5%, +9%, +14%, +25%]
    // 在 minuteIndex = 6（09:36:50，已过 50s）时斜率 >> +1.2%/分 且 区间倍数 >> 1.5x → 触发 SURGE 告警
    const targetCumByMinute = [2.0e9, 3.0e9, 4.08e9, 5.25e9, 6.54e9, 7.98e9, 10.5e9];
    for (let m = 0; m <= 6; m++) {
      nowMs = shanghaiToTimestampMs('2026-11-24', 9, 30 + m, 50);
      vi.mocked(primary.fetchBatchSnapshots).mockImplementationOnce(async (symbols) => {
        const snapMap = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          snapMap.set(
            s,
            makeSnapshot({
              symbol: s,
              tradeDate: '2026-11-24',
              timestampMs: nowMs,
              turnover: targetCumByMinute[m],
              source: 'tencent',
            })
          );
        }
        return snapMap;
      });
      const st = await scheduler.tickOnce();
      if (m === 0) {
        expect(st.watchlist.map((w) => w.symbol)).toEqual(['600519.SH']);
      }
    }

    // 验证第 0..5 分钟已随分钟切换逐根闭合落盘到 SQLite
    const closedBars = db.getIntradayBars('600519.SH', '2026-11-24');
    expect(closedBars.map((b) => b.minuteIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    // 验证冷启动保护后（minuteIndex >= 5）触发了快速放量告警派发回调
    expect(alerts.some((a) => a.symbol === '600519.SH' && a.direction === 'SURGE')).toBe(true);
    expect(alerts.every((a) => a.minuteIndex >= 5)).toBe(true);

    // 3. 删除自选股后下一轮立即移出监控
    db.removeWatchlistItem('600519.SH');
    const afterRemove = await scheduler.tickOnce();
    expect(afterRemove.watchlist).toHaveLength(0);

    db.close();
  });

  it('falls back to Eastmoney intraday and Hithink low-frequency snapshot (>=15s) when public sources fail', async () => {
    const db = new AppDatabase(':memory:');
    const nowMs = shanghaiToTimestampMs('2026-11-24', 10, 20, 30);

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async () => {
        throw new ProviderRequestError({ provider: 'tencent', message: 'intraday down', retryable: true });
      }),
      fetchBatchSnapshots: vi.fn(async () => {
        throw new ProviderRequestError({
          provider: 'tencent',
          message: 'HTTP 429',
          httpStatus: 429,
          rateLimited: true,
          retryable: true,
        });
      }),
    });

    const secondary = createFakeProvider('sina', {
      fetchBatchSnapshots: vi.fn(async () => {
        throw new ProviderRequestError({
          provider: 'sina',
          message: 'HTTP 403',
          httpStatus: 403,
          rateLimited: true,
          retryable: true,
        });
      }),
    });

    const eastmoney = createFakeProvider('eastmoney', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-24',
          barCount: 50,
          baseTurnoverPerMin: 2e9,
          source: 'eastmoney',
        }),
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-23',
          barCount: 240,
          baseTurnoverPerMin: 2e9,
          source: 'eastmoney',
        }),
      ]),
    });

    const hithink = createFakeHithink({
      configured: true,
      snapshots: async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(
            s,
            makeSnapshot({
              symbol: s,
              tradeDate: '2026-11-24',
              timestampMs: nowMs,
              turnover: 102e9,
              source: 'hithink',
            })
          );
        }
        return m;
      },
    });

    const scheduler = new PollingScheduler({
      database: db,
      secretStore: {
        getApiKey: () => 'fake-key',
        getStatus: () => ({ configured: true, source: 'env', encryptionAvailable: true }),
      },
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: secondary,
      hithinkProvider: hithink,
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: eastmoney,
      configuredIntervalSec: 3,
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    // 首次 tick：腾讯 429 → 切新浪并立即重试 → 新浪 403 → 切同花顺紧急兜底（降频 >=15s）
    const s1 = await scheduler.tickOnce();
    expect(s1.status.activeIntradayProvider).toBe('eastmoney');
    expect(s1.status.activeSnapshotProvider).toBe('hithink');
    expect(s1.status.pollingIntervalSec).toBeGreaterThanOrEqual(15);
    expect(s1.status.degraded).toBe(true);

    // 下一轮同花顺兜底拉取成功，但轮询间隔仍必须保持 >=15s（严禁进入秒级高频）
    const s2 = await scheduler.tickOnce();
    expect(s2.status.activeSnapshotProvider).toBe('hithink');
    expect(s2.status.pollingIntervalSec).toBeGreaterThanOrEqual(15);
    expect(s2.marketTotal.cumTurnover).toBe(204e9);

    db.close();
  });

  it('clears previous-day auction cache across PRE_MARKET -> AUCTION_GAP and captures & updates 09:25 auction', async () => {
    const db = new AppDatabase(':memory:');
    db.upsertTradingDays([
      { date: '2026-11-20', isOpen: true },
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);
    db.setSetting('calendar.lastSyncedDate', '2026-11-24');

    for (const sym of ['000001.SH', '399106.SZ', '399001.SZ', '399006.SZ', '000688.SH']) {
      db.upsertIntradayBars(
        makeIntradayDay({ symbol: sym, tradeDate: '2026-11-23', barCount: 240, baseTurnoverPerMin: 1e9, auctionTurnover: 10e9 }).bars
      );
      db.upsertIntradayBars(
        makeIntradayDay({ symbol: sym, tradeDate: '2026-11-20', barCount: 240, baseTurnoverPerMin: 1e9, auctionTurnover: 8e9 }).bars
      );
      db.upsertAuctionSnapshot({ symbol: sym, tradeDate: '2026-11-23', openPrice: 3500, auctionTurnover: 10e9, capturedAt: 1 });
      db.upsertAuctionSnapshot({ symbol: sym, tradeDate: '2026-11-20', openPrice: 3480, auctionTurnover: 8e9, capturedAt: 1 });
    }

    let nowMs = shanghaiToTimestampMs('2026-11-24', 9, 0, 0); // PRE_MARKET
    let auctionTurnover = 25e9;
    const primary = createFakeProvider('tencent', {
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-24', timestampMs: nowMs, turnover: auctionTurnover }));
        }
        return m;
      }),
    });

    const scheduler = new PollingScheduler({
      database: db,
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: createFakeProvider('sina'),
      hithinkProvider: createFakeHithink({ configured: false }),
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: createFakeProvider('eastmoney'),
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    // 09:00 盘前复盘昨日，加载了 2026-11-23 的竞价 10e9
    const sPre = await scheduler.tickOnce();
    expect(sPre.status.phase).toBe('PRE_MARKET');
    expect(sPre.indices[0].auctionTurnover).toBe(10e9);

    // 09:25:10 进入 AUCTION_GAP：昨日竞价绝不可污染今日，应真实落盘 25e9
    nowMs = shanghaiToTimestampMs('2026-11-24', 9, 25, 10);
    const sGap1 = await scheduler.tickOnce();
    expect(sGap1.status.phase).toBe('AUCTION_GAP');
    expect(db.getAuctionSnapshot('000001.SH', '2026-11-24')?.auctionTurnover).toBe(25e9);
    expect(sGap1.indices[0].auctionTurnover).toBe(25e9);
    expect(sGap1.indices[0].prevAuctionTurnover).toBe(10e9);

    // 09:25:18 上游终态修正为 26e9 时同步更新竞价落盘
    nowMs = shanghaiToTimestampMs('2026-11-24', 9, 25, 18);
    auctionTurnover = 26e9;
    const sGap2 = await scheduler.tickOnce();
    expect(db.getAuctionSnapshot('000001.SH', '2026-11-24')?.auctionTurnover).toBe(26e9);
    expect(sGap2.indices[0].auctionTurnover).toBe(26e9);

    db.close();
  });

  it('recovers next trading day when stale SQLite calendar cache lags behind today or when starting pre-open without Hithink key', async () => {
    // 场景 A：昨日缓存的同花顺日历仅覆盖到 2026-11-24，次日 2026-11-25 无 Key 盘中启动不应误判 CLOSED_DAY
    const dbA = new AppDatabase(':memory:');
    dbA.upsertTradingDays([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);
    dbA.setSetting('calendar.lastSyncedDate', '2026-11-24');

    const nowA = shanghaiToTimestampMs('2026-11-25', 10, 30, 0);
    const primaryA = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({ symbol, tradeDate: '2026-11-25', barCount: 60, baseTurnoverPerMin: 2e9 }),
        makeIntradayDay({ symbol, tradeDate: '2026-11-24', barCount: 240, baseTurnoverPerMin: 2e9 }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-25', timestampMs: nowA, turnover: 122e9 }));
        }
        return m;
      }),
    });

    const schedulerA = new PollingScheduler({
      database: dbA,
      primarySnapshotProvider: primaryA,
      secondarySnapshotProvider: createFakeProvider('sina'),
      hithinkProvider: createFakeHithink({ configured: false }),
      primaryIntradayProvider: primaryA,
      secondaryIntradayProvider: createFakeProvider('eastmoney'),
      nowFn: () => nowA,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const stA = await schedulerA.tickOnce();
    expect(stA.status.phase).toBe('MORNING_SESSION');
    expect(stA.status.mode).toBe('LIVE');
    expect(stA.status.tradeDate).toBe('2026-11-25');
    expect(stA.status.prevTradeDate).toBe('2026-11-24');
    expect(stA.status.calendarDegraded).toBe(true);
    dbA.close();

    // 场景 B：工作日 09:20 无 Key 启动，公开分时和快照尚未出今日数据；09:25:30 出现今日快照后自动重探切入 LIVE
    const dbB = new AppDatabase(':memory:');
    let nowB = shanghaiToTimestampMs('2026-11-25', 9, 20, 0);
    let snapTradeDate = '2026-11-24';
    const primaryB = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({ symbol, tradeDate: '2026-11-24', barCount: 240, baseTurnoverPerMin: 2e9 }),
        makeIntradayDay({ symbol, tradeDate: '2026-11-23', barCount: 240, baseTurnoverPerMin: 2e9 }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(s, makeSnapshot({ symbol: s, tradeDate: snapTradeDate, timestampMs: nowB, turnover: 5e9 }));
        }
        return m;
      }),
    });

    const schedulerB = new PollingScheduler({
      database: dbB,
      primarySnapshotProvider: primaryB,
      secondarySnapshotProvider: createFakeProvider('sina'),
      hithinkProvider: createFakeHithink({ configured: false }),
      primaryIntradayProvider: primaryB,
      secondaryIntradayProvider: createFakeProvider('eastmoney'),
      nowFn: () => nowB,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const stPreOpen = await schedulerB.tickOnce();
    expect(stPreOpen.status.mode).toBe('REPLAY');

    // 5 分钟后 09:25:30 公开源吐出今日日期 → 自动识别今日开市切入 AUCTION_GAP / LIVE
    nowB = shanghaiToTimestampMs('2026-11-25', 9, 25, 30);
    snapTradeDate = '2026-11-25';
    const stOpened = await schedulerB.tickOnce();
    expect(stOpened.status.phase).toBe('AUCTION_GAP');
    expect(stOpened.status.mode).toBe('LIVE');
    expect(stOpened.status.tradeDate).toBe('2026-11-25');
    dbB.close();
  });

  it('captures 15:00:03 closing auction snapshot into minuteIndex 239 when transitioning AFTERNOON_SESSION -> POST_MARKET', async () => {
    const db = new AppDatabase(':memory:');
    db.upsertTradingDays([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);
    db.setSetting('calendar.lastSyncedDate', '2026-11-24');

    for (const sym of ['000001.SH', '399106.SZ', '399001.SZ', '399006.SZ', '000688.SH']) {
      db.upsertIntradayBars(makeIntradayDay({ symbol: sym, tradeDate: '2026-11-23', barCount: 240, baseTurnoverPerMin: 1e9 }).bars);
      db.upsertIntradayBars(makeIntradayDay({ symbol: sym, tradeDate: '2026-11-24', barCount: 239, baseTurnoverPerMin: 1e9 }).bars);
      db.upsertAuctionSnapshot({ symbol: sym, tradeDate: '2026-11-24', openPrice: 3500, auctionTurnover: 1e9, capturedAt: 1 });
    }

    let nowMs = shanghaiToTimestampMs('2026-11-24', 14, 59, 57);
    let snapTs = nowMs;
    let snapTurnover = 240e9;

    const primary = createFakeProvider('tencent', {
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-24', timestampMs: snapTs, turnover: snapTurnover }));
        }
        return m;
      }),
    });

    const scheduler = new PollingScheduler({
      database: db,
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: createFakeProvider('sina'),
      hithinkProvider: createFakeHithink({ configured: false }),
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: createFakeProvider('eastmoney'),
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    await scheduler.tickOnce(); // 14:59:57
    // 15:00:05 切入 POST_MARKET，触发一次终态收盘快照补拉（上游时间戳 15:00:03，含收盘集合竞价 255e9）
    nowMs = shanghaiToTimestampMs('2026-11-24', 15, 0, 5);
    snapTs = shanghaiToTimestampMs('2026-11-24', 15, 0, 3);
    snapTurnover = 255e9;
    const postState = await scheduler.tickOnce();

    expect(postState.status.phase).toBe('POST_MARKET');
    expect(postState.status.mode).toBe('REPLAY');
    const bar239 = db.getIntradayBars('000001.SH', '2026-11-24').find((b) => b.minuteIndex === 239);
    expect(bar239?.cumTurnover).toBe(255e9);

    // 盘后再次 tick 不再发快照请求
    const callsAfterClose = vi.mocked(primary.fetchBatchSnapshots).mock.calls.length;
    nowMs = shanghaiToTimestampMs('2026-11-24', 15, 10, 0);
    await scheduler.tickOnce();
    expect(primary.fetchBatchSnapshots).toHaveBeenCalledTimes(callsAfterClose);

    db.close();
  });

  it('prevents 399006.SZ cross-source scope mismatch in both REPLAY and LIVE (blocks dirty DB writes and realigns when available)', async () => {
    // 1. REPLAY 模式：昨日腾讯 + 今日东财 → 必须标 CROSS_SOURCE_SCOPE_MISMATCH 且 metrics=null
    const dbReplay = new AppDatabase(':memory:');
    dbReplay.upsertTradingDays([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);
    dbReplay.setSetting('calendar.lastSyncedDate', '2026-11-24');
    dbReplay.upsertIntradayBars(
      makeIntradayDay({ symbol: '399006.SZ', tradeDate: '2026-11-23', barCount: 240, baseTurnoverPerMin: 4488.64e8 / 241, auctionTurnover: 4488.64e8 / 241, source: 'tencent' }).bars
    );
    dbReplay.upsertIntradayBars(
      makeIntradayDay({ symbol: '399006.SZ', tradeDate: '2026-11-24', barCount: 240, baseTurnoverPerMin: 4539.45e8 / 241, auctionTurnover: 4539.45e8 / 241, source: 'eastmoney' }).bars
    );

    const replayScheduler = new PollingScheduler({
      database: dbReplay,
      primarySnapshotProvider: createFakeProvider('tencent'),
      secondarySnapshotProvider: createFakeProvider('sina'),
      hithinkProvider: createFakeHithink({ configured: false }),
      primaryIntradayProvider: createFakeProvider('tencent'),
      secondaryIntradayProvider: createFakeProvider('eastmoney'),
      nowFn: () => shanghaiToTimestampMs('2026-11-24', 15, 30, 0),
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const replayState = await replayScheduler.tickOnce();
    const cybReplay = replayState.indices.find((i) => i.symbol === '399006.SZ')!;
    expect(cybReplay.degraded).toBe(true);
    expect(cybReplay.degradedReason).toBe('CROSS_SOURCE_SCOPE_MISMATCH');
    expect(cybReplay.metrics).toBeNull();
    dbReplay.close();

    // 2. LIVE 模式：昨日基线为 tencent，快照切到 hithink 且东财分时重拉失败 → 绝不把 hithink 写入 intraday_bars
    const dbLive = new AppDatabase(':memory:');
    dbLive.upsertTradingDays([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);
    dbLive.setSetting('calendar.lastSyncedDate', '2026-11-24');
    for (const sym of ['000001.SH', '399106.SZ', '399001.SZ', '399006.SZ', '000688.SH']) {
      dbLive.upsertIntradayBars(makeIntradayDay({ symbol: sym, tradeDate: '2026-11-23', barCount: 240, baseTurnoverPerMin: 1e9, source: 'tencent' }).bars);
      dbLive.upsertIntradayBars(makeIntradayDay({ symbol: sym, tradeDate: '2026-11-24', barCount: 30, baseTurnoverPerMin: 1e9, source: 'tencent' }).bars);
      dbLive.upsertAuctionSnapshot({ symbol: sym, tradeDate: '2026-11-24', openPrice: 2200, auctionTurnover: 1e9, capturedAt: 1 });
    }

    let nowLive = shanghaiToTimestampMs('2026-11-24', 10, 0, 30);
    const tencentFail = createFakeProvider('tencent', {
      fetchBatchSnapshots: vi.fn(async () => {
        throw new ProviderRequestError({ provider: 'tencent', message: '429', httpStatus: 429, rateLimited: true });
      }),
    });
    const sinaFail = createFakeProvider('sina', {
      fetchBatchSnapshots: vi.fn(async () => {
        throw new ProviderRequestError({ provider: 'sina', message: '403', httpStatus: 403, rateLimited: true });
      }),
    });
    const eastmoneyFail = createFakeProvider('eastmoney', {
      fetchIntradayMinutes: vi.fn(async () => {
        throw new ProviderRequestError({ provider: 'eastmoney', message: 'down', retryable: true });
      }),
    });
    const hithinkOk = createFakeHithink({
      configured: true,
      snapshots: async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-24', timestampMs: nowLive, turnover: 35e9, source: 'hithink' }));
        }
        return m;
      },
    });

    const liveScheduler = new PollingScheduler({
      database: dbLive,
      primarySnapshotProvider: tencentFail,
      secondarySnapshotProvider: sinaFail,
      hithinkProvider: hithinkOk,
      primaryIntradayProvider: tencentFail,
      secondaryIntradayProvider: eastmoneyFail,
      nowFn: () => nowLive,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    await liveScheduler.tickOnce(); // 切到 hithink
    const stHithink1 = await liveScheduler.tickOnce(); // 10:00:30 hithink 拉取成功
    nowLive = shanghaiToTimestampMs('2026-11-24', 10, 1, 30);
    const stHithink2 = await liveScheduler.tickOnce(); // 跨分钟至 10:01:30

    const cybLive = stHithink2.indices.find((i) => i.symbol === '399006.SZ')!;
    expect(stHithink1.status.activeSnapshotProvider).toBe('hithink');
    expect(cybLive.degraded).toBe(true);
    expect(cybLive.degradedReason).toBe('CROSS_SOURCE_SCOPE_MISMATCH');
    expect(cybLive.metrics).toBeNull();
    // 确认 399006.SZ 的 intraday_bars 中绝无 hithink 异源脏记录写入
    const cybBarsInDb = dbLive.getIntradayBars('399006.SZ', '2026-11-24');
    expect(cybBarsInDb.every((b) => b.source === 'tencent')).toBe(true);
    dbLive.close();
  });

  it('marks stale on frozen upstream timestamps, marks degraded on missing prev baseline/head gap, and nulls cross-gap barTurnover', async () => {
    const db = new AppDatabase(':memory:');
    db.upsertTradingDays([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);
    db.setSetting('calendar.lastSyncedDate', '2026-11-24');

    const nowMs = shanghaiToTimestampMs('2026-11-24', 10, 30, 0);
    const frozenTs = shanghaiToTimestampMs('2026-11-24', 10, 15, 0); // 15 分钟前

    const primary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        // 缺失第 0 分钟与第 5 分钟，且完全缺失昨日基线
        makeIntradayDay({
          symbol,
          tradeDate: '2026-11-24',
          barCount: 60,
          baseTurnoverPerMin: 2e9,
          skipMinutes: new Set([0, 5]),
        }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-24', timestampMs: frozenTs, turnover: 120e9 }));
        }
        return m;
      }),
    });

    const scheduler = new PollingScheduler({
      database: db,
      primarySnapshotProvider: primary,
      secondarySnapshotProvider: createFakeProvider('sina'),
      hithinkProvider: createFakeHithink({ configured: false }),
      primaryIntradayProvider: primary,
      secondaryIntradayProvider: createFakeProvider('eastmoney'),
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const st = await scheduler.tickOnce();
    expect(st.status.stale).toBe(true);
    expect(st.status.degraded).toBe(true);
    expect(st.marketTotal.degraded).toBe(true);
    expect(st.marketTotal.degradedReason).toBe('MISSING_PREV_BASELINE');
    // 跨缺口第 6 分钟（前一根 5 缺失）单分钟增量必须为 null，避免虚增
    const bar6 = st.marketTotal.todaySeries.find((b) => b.minuteIndex === 6);
    expect(bar6?.barTurnover).toBeNull();

    db.close();
  });

  it('auto-wakes next morning after POST_MARKET via start() timer with zero overnight snapshot requests', async () => {
    vi.useFakeTimers();
    const db = new AppDatabase(':memory:');
    try {
      const openDays = ['2026-11-23', '2026-11-24', '2026-11-25'];
      db.upsertTradingDays(openDays.map((date) => ({ date, isOpen: true })));
      db.setSetting('calendar.lastSyncedDate', '2026-11-24');

      for (const sym of ['000001.SH', '399106.SZ', '399001.SZ', '399006.SZ', '000688.SH']) {
        db.upsertIntradayBars(makeIntradayDay({ symbol: sym, tradeDate: '2026-11-23', barCount: 240, baseTurnoverPerMin: 1e9 }).bars);
        db.upsertIntradayBars(makeIntradayDay({ symbol: sym, tradeDate: '2026-11-24', barCount: 240, baseTurnoverPerMin: 1e9 }).bars);
      }

      let nowMs = shanghaiToTimestampMs('2026-11-24', 15, 30, 0);
      const primary = createFakeProvider('tencent', {
        fetchBatchSnapshots: vi.fn(async (symbols) => {
          const m = new Map<string, QuoteSnapshot>();
          for (const s of symbols) {
            m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-25', timestampMs: nowMs, turnover: 5e9 }));
          }
          return m;
        }),
      });
      const hithink = createFakeHithink({ configured: true, tradingDays: openDays });

      const scheduler = new PollingScheduler({
        database: db,
        primarySnapshotProvider: primary,
        secondarySnapshotProvider: createFakeProvider('sina'),
        hithinkProvider: hithink,
        primaryIntradayProvider: primary,
        secondaryIntradayProvider: createFakeProvider('eastmoney'),
        nowFn: () => nowMs,
        sleepFn: async () => {},
        backfillDelayMs: 0,
      });

      const postSt = await scheduler.start();
      expect(postSt.status.phase).toBe('POST_MARKET');
      expect(primary.fetchBatchSnapshots).not.toHaveBeenCalled();

      // 盘后休眠 30 分钟期间零高频快照请求
      nowMs += 30 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(primary.fetchBatchSnapshots).not.toHaveBeenCalled();

      // 推进时钟至次日 09:15:00：常驻定时器自动唤醒切入 OPEN_AUCTION / LIVE
      nowMs = shanghaiToTimestampMs('2026-11-25', 9, 15, 0);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(scheduler.getLatestState()?.status.phase).toBe('OPEN_AUCTION');
      expect(scheduler.getLatestState()?.status.mode).toBe('LIVE');
      expect(primary.fetchBatchSnapshots).toHaveBeenCalled();

      // stop() 后推进时间不再产生新的快照请求
      const callsBeforeStop = vi.mocked(primary.fetchBatchSnapshots).mock.calls.length;
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(primary.fetchBatchSnapshots).toHaveBeenCalledTimes(callsBeforeStop);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it('safely ignores in-flight results after stop()+db.close(), reloads recentAlerts from SQLite, probes sina recovery from hithink, and syncs slopeWindow', async () => {
    // 1. 重启回填 SQLite 告警事件 + updateEnergyConfig 同步 slopeWindow + hithink 滞留探测新浪恢复
    const db = new AppDatabase(':memory:');
    db.upsertTradingDays([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);
    db.setSetting('calendar.lastSyncedDate', '2026-11-24');
    db.insertAlertEvent({
      symbol: '000001.SH',
      name: '上证指数',
      tradeDate: '2026-11-24',
      minuteIndex: 20,
      direction: 'SURGE',
      slope: 2.1,
      windowMultiple: 1.8,
      cumRatio: 0.12,
      message: '上证指数快速放量',
      createdAt: shanghaiToTimestampMs('2026-11-24', 9, 50, 0),
    });

    for (const sym of ['000001.SH', '399106.SZ', '399001.SZ', '399006.SZ', '000688.SH']) {
      db.upsertIntradayBars(makeIntradayDay({ symbol: sym, tradeDate: '2026-11-23', barCount: 240, baseTurnoverPerMin: 1e9, source: 'eastmoney' }).bars);
      db.upsertIntradayBars(makeIntradayDay({ symbol: sym, tradeDate: '2026-11-24', barCount: 30, baseTurnoverPerMin: 1e9, source: 'eastmoney' }).bars);
      db.upsertAuctionSnapshot({ symbol: sym, tradeDate: '2026-11-24', openPrice: 3500, auctionTurnover: 1e9, capturedAt: 1 });
    }

    let nowMs = shanghaiToTimestampMs('2026-11-24', 10, 0, 15);
    let sinaHealthy = false;
    const tencent = createFakeProvider('tencent', {
      fetchBatchSnapshots: vi.fn(async () => {
        throw new ProviderRequestError({ provider: 'tencent', message: '429', httpStatus: 429, rateLimited: true });
      }),
      healthCheck: vi.fn(async () => ({ provider: 'tencent' as const, ok: false, latencyMs: 10, error: 'down' })),
    });
    const sina = createFakeProvider('sina', {
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        if (!sinaHealthy) {
          throw new ProviderRequestError({ provider: 'sina', message: '403', httpStatus: 403, rateLimited: true });
        }
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-24', timestampMs: nowMs, turnover: 32e9, source: 'sina' }));
        }
        return m;
      }),
      healthCheck: vi.fn(async () => ({ provider: 'sina' as const, ok: sinaHealthy, latencyMs: 12, error: sinaHealthy ? null : 'down' })),
    });
    const hithink = createFakeHithink({
      configured: true,
      snapshots: async (symbols) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(s, makeSnapshot({ symbol: s, tradeDate: '2026-11-24', timestampMs: nowMs, turnover: 32e9, source: 'hithink' }));
        }
        return m;
      },
    });

    const dbReadSpy = vi.spyOn(db, 'getIntradayBars');
    const scheduler = new PollingScheduler({
      database: db,
      primarySnapshotProvider: tencent,
      secondarySnapshotProvider: sina,
      hithinkProvider: hithink,
      primaryIntradayProvider: tencent,
      secondaryIntradayProvider: createFakeProvider('eastmoney'),
      nowFn: () => nowMs,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });
    scheduler.updateEnergyConfig({ slopeWindow: 10 });

    const s1 = await scheduler.tickOnce();
    expect(s1.recentAlerts).toHaveLength(1);
    expect(s1.recentAlerts[0].symbol).toBe('000001.SH');
    expect(s1.status.activeSnapshotProvider).toBe('hithink');
    expect(s1.marketTotal.metrics?.slopeWindow).toBe(10);

    // 连续第二次 tick 不再重复同步扫描 SQLite intraday_bars
    const dbReadsAfterFirst = dbReadSpy.mock.calls.length;
    nowMs += 15_000;
    await scheduler.tickOnce();
    expect(dbReadSpy).toHaveBeenCalledTimes(dbReadsAfterFirst);

    // 5 分钟后腾讯仍故障但新浪恢复 → 自动从 hithink 兜底切回 sina
    sinaHealthy = true;
    nowMs += 5 * 60 * 1000 + 1000;
    const sRecovered = await scheduler.tickOnce();
    expect(sina.healthCheck).toHaveBeenCalledTimes(1);
    expect(sRecovered.status.activeSnapshotProvider).toBe('sina');
    db.close();

    // 2. stop() + db.close() 在异步请求未完成时触发：后续 resolve 不抛 database is not open 异常
    const dbRace = new AppDatabase(':memory:');
    dbRace.upsertTradingDays([{ date: '2026-11-24', isOpen: true }]);
    dbRace.setSetting('calendar.lastSyncedDate', '2026-11-24');

    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const slowFetchGate: { resolve: ((v: Map<string, QuoteSnapshot>) => void) | null } = {
      resolve: null,
    };
    const slowPrimary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async () => []),
      fetchBatchSnapshots: vi.fn(
        () =>
          new Promise<Map<string, QuoteSnapshot>>((resolve) => {
            slowFetchGate.resolve = resolve;
            markFetchStarted();
          })
      ),
    });
    const raceScheduler = new PollingScheduler({
      database: dbRace,
      primarySnapshotProvider: slowPrimary,
      secondarySnapshotProvider: createFakeProvider('sina'),
      hithinkProvider: createFakeHithink({ configured: false }),
      primaryIntradayProvider: slowPrimary,
      secondaryIntradayProvider: createFakeProvider('eastmoney'),
      nowFn: () => shanghaiToTimestampMs('2026-11-24', 10, 0, 15),
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const inFlight = raceScheduler.tickOnce();
    await fetchStarted;
    raceScheduler.stop();
    dbRace.close();

    slowFetchGate.resolve?.(
      new Map([
        [
          '000001.SH',
          makeSnapshot({
            symbol: '000001.SH',
            tradeDate: '2026-11-24',
            timestampMs: shanghaiToTimestampMs('2026-11-24', 10, 0, 15),
            turnover: 50e9,
          }),
        ],
      ])
    );
    await expect(inFlight).resolves.toBeDefined();
  });

  it('reloads authoritative calendar on refreshCalendarNow after API key save and queues follow-up tick when refreshNow overlaps pollInFlight', async () => {
    // 1. 无 Key 启动进入 CALENDAR_INFERRED_DEGRADED，随后配置 Key 并调用 refreshCalendarNow 立即解除降级
    const dbCal = new AppDatabase(':memory:');
    let keyReady = false;
    const hithinkCal = createFakeHithink({ configured: false });
    vi.spyOn(hithinkCal, 'isConfigured').mockImplementation(() => keyReady);
    vi.mocked(hithinkCal.fetchTradingDays).mockResolvedValue([
      { date: '2026-11-24', isOpen: true },
      { date: '2026-11-25', isOpen: true },
    ]);

    const intradayStub = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({ symbol, tradeDate: '2026-11-24', barCount: 240, baseTurnoverPerMin: 1e9 }),
      ]),
    });

    const calScheduler = new PollingScheduler({
      database: dbCal,
      primarySnapshotProvider: intradayStub,
      secondarySnapshotProvider: createFakeProvider('sina'),
      hithinkProvider: hithinkCal,
      primaryIntradayProvider: intradayStub,
      secondaryIntradayProvider: createFakeProvider('eastmoney'),
      nowFn: () => shanghaiToTimestampMs('2026-11-25', 16, 0, 0),
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const degradedState = await calScheduler.tickOnce();
    expect(degradedState.status.calendarDegraded).toBe(true);
    expect(degradedState.status.calendarSource).toBe('inferred_degraded');
    expect(hithinkCal.fetchTradingDays).not.toHaveBeenCalled();

    keyReady = true;
    const upgradedState = await calScheduler.refreshCalendarNow();
    expect(hithinkCal.fetchTradingDays).toHaveBeenCalledTimes(1);
    expect(upgradedState.status.calendarDegraded).toBe(false);
    expect(upgradedState.status.calendarSource).toBe('hithink');
    dbCal.close();

    // 2. 在途轮询期间新增自选股并多次调用 refreshNow：合并排队补跑 1 次新鲜 tick，绝不吞掉更新
    const dbQueue = new AppDatabase(':memory:');
    dbQueue.upsertTradingDays([
      { date: '2026-11-24', isOpen: true },
      { date: '2026-11-25', isOpen: true },
    ]);
    dbQueue.setSetting('calendar.lastSyncedDate', '2026-11-25');

    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let snapCallCount = 0;
    const nowLive = shanghaiToTimestampMs('2026-11-25', 10, 5, 30);

    const queuePrimary = createFakeProvider('tencent', {
      fetchIntradayMinutes: vi.fn(async (symbol) => [
        makeIntradayDay({ symbol, tradeDate: '2026-11-24', barCount: 240, baseTurnoverPerMin: 1e9 }),
        makeIntradayDay({ symbol, tradeDate: '2026-11-25', barCount: 35, baseTurnoverPerMin: 1.1e9 }),
      ]),
      fetchBatchSnapshots: vi.fn(async (symbols) => {
        snapCallCount += 1;
        if (snapCallCount === 1) {
          signalFirstStarted();
          await firstGate;
        }
        const map = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          map.set(
            s,
            makeSnapshot({
              symbol: s,
              tradeDate: '2026-11-25',
              timestampMs: nowLive,
              turnover: 40e9,
            })
          );
        }
        return map;
      }),
    });

    const queueScheduler = new PollingScheduler({
      database: dbQueue,
      primarySnapshotProvider: queuePrimary,
      secondarySnapshotProvider: createFakeProvider('sina'),
      hithinkProvider: createFakeHithink({ configured: false }),
      primaryIntradayProvider: queuePrimary,
      secondaryIntradayProvider: createFakeProvider('eastmoney'),
      nowFn: () => nowLive,
      sleepFn: async () => {},
      backfillDelayMs: 0,
    });

    const inFlightTick = queueScheduler.tickOnce();
    await firstStarted;

    // 在途期间写入新自选股 + 调整斜率窗口，并发调用两次 refreshNow 应合并为单次补跑
    dbQueue.upsertWatchlistItem({
      symbol: '600519.SH',
      name: '贵州茅台',
      sortOrder: 0,
      alertEnabled: true,
      customThresholdsJson: null,
    });
    queueScheduler.updateEnergyConfig({ slopeWindow: 3 });

    const r1 = queueScheduler.refreshNow();
    const r2 = queueScheduler.refreshNow();

    releaseFirst();
    const [sFirst, sR1, sR2] = await Promise.all([inFlightTick, r1, r2]);

    expect(sFirst.watchlist).toHaveLength(0);
    expect(sR1.watchlist.map((w) => w.symbol)).toEqual(['600519.SH']);
    expect(sR2.watchlist.map((w) => w.symbol)).toEqual(['600519.SH']);
    expect(sR1.marketTotal.metrics?.slopeWindow).toBe(3);
    expect(snapCallCount).toBe(2);
    dbQueue.close();
  });

  it('defaults to SH/SZ/CYB/STAR-Composite indices and dynamically enables/disables optional indices', async () => {
    const db = new AppDatabase(':memory:');
    try {
      db.upsertTradingDays([
        { date: '2026-11-24', isOpen: true },
        { date: '2026-11-25', isOpen: true },
      ]);
      db.setSetting('calendar.lastSyncedDate', '2026-11-25');

      const nowMs = shanghaiToTimestampMs('2026-11-25', 10, 0, 15);
      const snapshotBatches: string[][] = [];
      const intradayCalls: string[] = [];

      const primary = createFakeProvider('tencent', {
        fetchIntradayMinutes: vi.fn(async (symbol: string) => {
          intradayCalls.push(symbol);
          return [
            makeIntradayDay({ symbol, tradeDate: '2026-11-25', barCount: 30, baseTurnoverPerMin: 2e9 }),
            makeIntradayDay({ symbol, tradeDate: '2026-11-24', barCount: 240, baseTurnoverPerMin: 1.8e9 }),
          ];
        }),
        fetchBatchSnapshots: vi.fn(async (symbols: readonly string[]) => {
          snapshotBatches.push([...symbols]);
          const map = new Map<string, QuoteSnapshot>();
          for (const s of symbols) {
            map.set(
              s,
              makeSnapshot({
                symbol: s,
                tradeDate: '2026-11-25',
                timestampMs: nowMs,
                turnover: 65e9,
              })
            );
          }
          return map;
        }),
      });

      const scheduler = new PollingScheduler({
        database: db,
        primarySnapshotProvider: primary,
        secondarySnapshotProvider: createFakeProvider('sina'),
        hithinkProvider: createFakeHithink({ configured: false }),
        primaryIntradayProvider: primary,
        secondaryIntradayProvider: createFakeProvider('eastmoney'),
        nowFn: () => nowMs,
        sleepFn: async () => {},
        backfillDelayMs: 0,
      });

      // 1. 默认状态仅展示上、深、双创，且不采集未开启的可选扩展指数
      const sDefault = await scheduler.tickOnce();
      expect(sDefault.indices.map((i) => i.symbol)).toEqual([
        '000001.SH',
        '399001.SZ',
        '399006.SZ',
        '000680.SH',
      ]);
      expect(snapshotBatches[0]).toEqual([
        '000001.SH',
        '399106.SZ',
        '399001.SZ',
        '399006.SZ',
        '000680.SH',
      ]);
      expect(intradayCalls).not.toContain('000016.SH');
      expect(intradayCalls).not.toContain('000688.SH');

      // 2. 开启沪深300与科创50后，自动补齐分时基线、纳入快照批次并按标准顺序展示
      scheduler.updateEnabledOptionalIndices(['000688.SH', '000300.SH']);
      const sEnabled = await scheduler.refreshNow();
      expect(sEnabled.indices.map((i) => i.symbol)).toEqual([
        '000001.SH',
        '399001.SZ',
        '399006.SZ',
        '000680.SH',
        '000300.SH',
        '000688.SH',
      ]);
      expect(sEnabled.indices.find((i) => i.symbol === '000300.SH')?.scope).toBe('成分股');
      expect(sEnabled.indices.find((i) => i.symbol === '000688.SH')?.scope).toBe('成分股');
      expect(snapshotBatches[1]).toContain('000300.SH');
      expect(snapshotBatches[1]).toContain('000688.SH');
      expect(intradayCalls).toContain('000300.SH');
      expect(intradayCalls).toContain('000688.SH');

      // 3. 关闭全部可选扩展指数后，立即恢复仅展示与采集默认核心指数
      scheduler.updateEnabledOptionalIndices([]);
      const sDisabled = await scheduler.refreshNow();
      expect(sDisabled.indices.map((i) => i.symbol)).toEqual([
        '000001.SH',
        '399001.SZ',
        '399006.SZ',
        '000680.SH',
      ]);
      expect(snapshotBatches[2]).not.toContain('000300.SH');
      expect(snapshotBatches[2]).not.toContain('000688.SH');

      // 4. 关闭全部 4 个主要指数展示后：indices 为空，但两市总成交额聚合与 shReference 依然完整，且不再采集非底层主要指数
      scheduler.updateEnabledCoreIndices([]);
      const sAllCoreHidden = await scheduler.refreshNow();
      expect(sAllCoreHidden.indices).toEqual([]);
      expect(sAllCoreHidden.marketTotal.cumTurnover).toBe(130e9);
      expect(sAllCoreHidden.marketTotal.shReference?.todaySeries.length).toBeGreaterThan(0);
      expect(snapshotBatches[3]).toEqual(['000001.SH', '399106.SZ']);
    } finally {
      db.close();
    }
  });

  it('reconciles missing closing auction turnover in existing 240-bar post-market cache, persists flag, and supports forced refresh', async () => {
    const db = new AppDatabase(':memory:');
    try {
      db.upsertTradingDays([
        { date: '2026-11-24', isOpen: true },
        { date: '2026-11-25', isOpen: true },
      ]);
      db.setSetting('calendar.lastSyncedDate', '2026-11-25');

      // 模拟盘中已写入 240 根 bar，但 minuteIndex=239 停留在 14:59 竞价前（barTurnover=0，缺失尾盘竞价）
      for (const sym of ['000001.SH', '399106.SZ', '399001.SZ', '399006.SZ', '000680.SH']) {
        db.upsertIntradayBars(
          makeIntradayDay({ symbol: sym, tradeDate: '2026-11-24', barCount: 240, baseTurnoverPerMin: 2e9 }).bars
        );
        const staleToday = makeIntradayDay({
          symbol: sym,
          tradeDate: '2026-11-25',
          barCount: 240,
          baseTurnoverPerMin: 2e9,
        }).bars;
        const prev238 = staleToday[238];
        staleToday[239] = {
          ...staleToday[239],
          cumTurnover: prev238.cumTurnover,
          barTurnover: 0,
        };
        db.upsertIntradayBars(staleToday);
      }

      const nowMs = shanghaiToTimestampMs('2026-11-25', 17, 4, 0);
      let authoritativeClosingExtra = 9e9; // 模拟尾盘集合竞价 +90 亿/侧
      const intradayFetchSpy = vi.fn(async (symbol: string) => {
        const dayToday = makeIntradayDay({
          symbol,
          tradeDate: '2026-11-25',
          barCount: 240,
          baseTurnoverPerMin: 2e9,
        });
        const prev238 = dayToday.bars[238];
        dayToday.bars[239] = {
          ...dayToday.bars[239],
          cumTurnover: prev238.cumTurnover + authoritativeClosingExtra,
          barTurnover: authoritativeClosingExtra,
        };
        return [
          dayToday,
          makeIntradayDay({
            symbol,
            tradeDate: '2026-11-24',
            barCount: 240,
            baseTurnoverPerMin: 2e9,
          }),
        ];
      });

      const primary = createFakeProvider('tencent', {
        fetchIntradayMinutes: intradayFetchSpy,
      });

      const scheduler1 = new PollingScheduler({
        database: db,
        primarySnapshotProvider: primary,
        secondarySnapshotProvider: createFakeProvider('sina'),
        hithinkProvider: createFakeHithink({ configured: false }),
        primaryIntradayProvider: primary,
        secondaryIntradayProvider: createFakeProvider('eastmoney'),
        nowFn: () => nowMs,
        sleepFn: async () => {},
        backfillDelayMs: 0,
      });

      // 1. 盘后 17:04 首次启动：虽然库里已有 240 根，但未完成盘后终态校正 → 自动自愈补齐 15:00 尾盘竞价
      const st1 = await scheduler1.tickOnce();
      expect(st1.status.phase).toBe('POST_MARKET');
      expect(intradayFetchSpy).toHaveBeenCalledTimes(5);
      const shBar239 = db.getIntradayBars('000001.SH', '2026-11-25').find((b) => b.minuteIndex === 239);
      expect(shBar239?.barTurnover).toBe(9e9);
      expect(st1.status.lastUpdatedAt).toBe(nowMs);

      // 2. 重启新的调度器实例：已持久化盘后终态校正标记 → 零多余分时请求
      intradayFetchSpy.mockClear();
      const scheduler2 = new PollingScheduler({
        database: db,
        primarySnapshotProvider: primary,
        secondarySnapshotProvider: createFakeProvider('sina'),
        hithinkProvider: createFakeHithink({ configured: false }),
        primaryIntradayProvider: primary,
        secondaryIntradayProvider: createFakeProvider('eastmoney'),
        nowFn: () => nowMs,
        sleepFn: async () => {},
        backfillDelayMs: 0,
      });
      await scheduler2.tickOnce();
      expect(intradayFetchSpy).not.toHaveBeenCalled();

      // 3. 用户手动点击「立即刷新」(forceReconcile: true) → 强制重新校对并更新终态
      authoritativeClosingExtra = 9.5e9;
      await scheduler2.refreshNow({ forceReconcile: true });
      expect(intradayFetchSpy).toHaveBeenCalledTimes(5);
      const updatedShBar239 = db
        .getIntradayBars('000001.SH', '2026-11-25')
        .find((b) => b.minuteIndex === 239);
      expect(updatedShBar239?.barTurnover).toBe(9.5e9);
    } finally {
      db.close();
    }
  });

  it('captures delayed closing auction at 15:00:15 settle tick and reconciles authoritative intraday at 15:02:00', async () => {
    vi.useFakeTimers();
    const db = new AppDatabase(':memory:');
    try {
      db.upsertTradingDays([
        { date: '2026-11-24', isOpen: true },
        { date: '2026-11-25', isOpen: true },
      ]);
      db.setSetting('calendar.lastSyncedDate', '2026-11-25');

      for (const sym of ['000001.SH', '399106.SZ', '399001.SZ', '399006.SZ', '000680.SH']) {
        db.upsertIntradayBars(
          makeIntradayDay({ symbol: sym, tradeDate: '2026-11-24', barCount: 240, baseTurnoverPerMin: 1e9 }).bars
        );
        db.upsertIntradayBars(
          makeIntradayDay({ symbol: sym, tradeDate: '2026-11-25', barCount: 239, baseTurnoverPerMin: 1e9 }).bars
        );
        db.upsertAuctionSnapshot({
          symbol: sym,
          tradeDate: '2026-11-25',
          openPrice: 3500,
          auctionTurnover: 1e9,
          capturedAt: 1,
        });
      }

      let nowMs = shanghaiToTimestampMs('2026-11-25', 14, 59, 57);
      let snapTs = nowMs;
      let snapTurnover = 240e9; // 14:59 未撮合前

      const snapSpy = vi.fn(async (symbols: readonly string[]) => {
        const m = new Map<string, QuoteSnapshot>();
        for (const s of symbols) {
          m.set(
            s,
            makeSnapshot({
              symbol: s,
              tradeDate: '2026-11-25',
              timestampMs: snapTs,
              turnover: snapTurnover,
            })
          );
        }
        return m;
      });

      const intradaySpy = vi.fn(async (symbol: string) => {
        const dayToday = makeIntradayDay({
          symbol,
          tradeDate: '2026-11-25',
          barCount: 240,
          baseTurnoverPerMin: 1e9,
        });
        const prev238 = dayToday.bars[238];
        dayToday.bars[239] = {
          ...dayToday.bars[239],
          cumTurnover: 258e9,
          barTurnover: 258e9 - prev238.cumTurnover,
        };
        return [
          dayToday,
          makeIntradayDay({
            symbol,
            tradeDate: '2026-11-24',
            barCount: 240,
            baseTurnoverPerMin: 1e9,
          }),
        ];
      });

      const primary = createFakeProvider('tencent', {
        fetchBatchSnapshots: snapSpy,
        fetchIntradayMinutes: intradaySpy,
      });

      const scheduler = new PollingScheduler({
        database: db,
        primarySnapshotProvider: primary,
        secondarySnapshotProvider: createFakeProvider('sina'),
        hithinkProvider: createFakeHithink({ configured: false }),
        primaryIntradayProvider: primary,
        secondaryIntradayProvider: createFakeProvider('eastmoney'),
        nowFn: () => nowMs,
        sleepFn: async () => {},
        backfillDelayMs: 0,
      });

      // 14:59:57 启动
      await scheduler.start();
      expect(snapSpy).toHaveBeenCalledTimes(1);

      // 15:00:01 刚跨收盘：交易所尚未推完尾盘竞价，快照仍停留在 240e9
      nowMs = shanghaiToTimestampMs('2026-11-25', 15, 0, 1);
      snapTs = shanghaiToTimestampMs('2026-11-25', 14, 59, 59);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(
        db.getIntradayBars('000001.SH', '2026-11-25').find((b) => b.minuteIndex === 239)?.cumTurnover
      ).toBe(240e9);
      expect(intradaySpy).not.toHaveBeenCalled();

      // 15:00:15 收盘结算补抓点自动唤醒：拿到延迟推送的 15:00:12 终态快照 255e9
      nowMs = shanghaiToTimestampMs('2026-11-25', 15, 0, 15);
      snapTs = shanghaiToTimestampMs('2026-11-25', 15, 0, 12);
      snapTurnover = 255e9;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(
        db.getIntradayBars('000001.SH', '2026-11-25').find((b) => b.minuteIndex === 239)?.cumTurnover
      ).toBe(255e9);

      // 15:02:00 权威分时终态校正点自动唤醒：拉取权威 240 根分时校准为 258e9 并落盘标记
      const snapCallsAt150015 = snapSpy.mock.calls.length;
      nowMs = shanghaiToTimestampMs('2026-11-25', 15, 2, 0);
      await vi.advanceTimersByTimeAsync(106_000);
      expect(intradaySpy).toHaveBeenCalledTimes(5);
      expect(snapSpy).toHaveBeenCalledTimes(snapCallsAt150015);
      expect(
        db.getIntradayBars('000001.SH', '2026-11-25').find((b) => b.minuteIndex === 239)?.cumTurnover
      ).toBe(258e9);

      // 之后再推进 10 分钟：彻底零网络请求
      nowMs = shanghaiToTimestampMs('2026-11-25', 15, 12, 0);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(intradaySpy).toHaveBeenCalledTimes(5);
      expect(snapSpy).toHaveBeenCalledTimes(snapCallsAt150015);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });
});
