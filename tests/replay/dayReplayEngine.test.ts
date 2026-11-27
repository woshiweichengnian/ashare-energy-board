import { afterEach, describe, expect, it } from 'vitest';
import {
  AlertEngine,
  aggregateMarketTotalSeries,
  evaluateEnergy,
  minuteIndexToLabel,
  shanghaiToTimestampMs,
} from '../../src/core';
import { DayReplayEngine, parseReplayArgs } from '../../src/main/replay';
import { AppDatabase } from '../../src/main/storage/database';
import {
  MARKET_TOTAL_SYMBOL,
  MONITORED_INDEX_SYMBOLS,
  REPLAY_ALERT_PREFIX,
} from '../../src/shared/constants';
import type { AlertDispatchPayload, IntradayBarRow } from '../../src/shared/types';

const openDbs: AppDatabase[] = [];

function createMemoryDb(): AppDatabase {
  const db = new AppDatabase(':memory:');
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

function seedFullTradingDay(
  db: AppDatabase,
  tradeDate: string,
  opts?: {
    scaleBySymbol?: Record<string, number>;
    surgeMinuteRange?: [number, number];
    omitSymbol?: string;
    omitMinutesForSymbol?: { symbol: string; minutes: number[] };
  }
): void {
  const allSymbols = [...MONITORED_INDEX_SYMBOLS, '300750.SZ'];
  const bars: IntradayBarRow[] = [];

  for (const symbol of allSymbols) {
    if (opts?.omitSymbol === symbol) continue;
    const baseScale = opts?.scaleBySymbol?.[symbol] ?? (symbol === '300750.SZ' ? 0.08 : 1.0);
    const auctionTurnover = 1.2e10 * baseScale;
    db.upsertAuctionSnapshot({
      symbol,
      tradeDate,
      openPrice: 3300,
      auctionTurnover,
      capturedAt: shanghaiToTimestampMs(tradeDate, 9, 25, 0),
    });

    let cum = auctionTurnover;
    const omitted =
      opts?.omitMinutesForSymbol?.symbol === symbol
        ? new Set(opts.omitMinutesForSymbol.minutes)
        : null;

    for (let m = 0; m < 240; m++) {
      let mult = 1.0;
      // 开盘第 1..4 分钟故意放高，验证冷启动保护（09:30-09:34 无告警）
      if (opts?.surgeMinuteRange && m >= 1 && m <= 4) {
        mult = 2.8;
      }
      if (opts?.surgeMinuteRange && m >= opts.surgeMinuteRange[0] && m <= opts.surgeMinuteRange[1]) {
        const offset = m - opts.surgeMinuteRange[0] + 1;
        mult = 1 + offset * 0.35;
      }
      const barTurnover = 2.5e9 * baseScale * mult;
      cum += barTurnover;
      if (omitted?.has(m)) continue;

      bars.push({
        symbol,
        tradeDate,
        minuteIndex: m,
        minuteStr: minuteIndexToLabel(m),
        price: 3300 + m * 0.2,
        cumVolume: 1_000_000 * (m + 1),
        cumTurnover: cum,
        barTurnover,
        source: 'tencent',
      });
    }
  }

  db.upsertIntradayBars(bars);
}

describe('parseReplayArgs', () => {
  it('parses --replay flag, optional date, and step interval', () => {
    expect(parseReplayArgs(['electron', '.'])).toBeNull();
    expect(parseReplayArgs(['electron', '.', '--replay'])).toEqual({
      enabled: true,
      tradeDate: null,
      stepIntervalMs: 120,
    });
    expect(parseReplayArgs(['electron', '.', '--replay', '2026-11-24', '--replay-step-ms=40'])).toEqual(
      {
        enabled: true,
        tradeDate: '2026-11-24',
        stepIntervalMs: 40,
      }
    );
    expect(parseReplayArgs(['electron', '.', '--replay=2026-11-24', '--replay-step-ms', '0'])).toEqual({
      enabled: true,
      tradeDate: '2026-11-24',
      stepIntervalMs: 0,
    });
    expect(() => parseReplayArgs(['electron', '.', '--replay', '2026/11/24'])).toThrow();
  });
});

describe('DayReplayEngine', () => {
  it('replays 09:25 -> 15:00 completely, matches offline engine alerts, enforces cold start, and never writes alert_events', () => {
    const db = createMemoryDb();
    db.upsertTradingDays([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);
    db.upsertWatchlistItem({
      symbol: '300750.SZ',
      name: '宁德时代',
      sortOrder: 0,
      alertEnabled: true,
      customThresholdsJson: null,
    });

    // 录制昨日基线与今日（10:10-10:15 出现明显加速放量脉冲）
    seedFullTradingDay(db, '2026-11-23');
    seedFullTradingDay(db, '2026-11-24', { surgeMinuteRange: [40, 45] });

    const observedAlerts: AlertDispatchPayload[] = [];
    const engine = new DayReplayEngine({
      database: db,
      tradeDate: '2026-11-24',
      stepIntervalMs: 0,
      onReplayAlert: (p) => observedAlerts.push(p),
    });

    const summary = engine.runAllSteps();

    // 1. 全天 241 步（09:25 + 0..239）完整跑完且全程标识回放
    expect(summary.totalStepsExecuted).toBe(241);
    expect(summary.tradeDate).toBe('2026-11-24');
    expect(summary.prevTradeDate).toBe('2026-11-23');
    expect(summary.finalState.status.mode).toBe('REPLAY');
    expect(summary.finalState.status.replay?.active).toBe(true);
    expect(summary.finalState.status.replay?.finished).toBe(true);
    expect(summary.finalState.status.replay?.tradeDate).toBe('2026-11-24');

    // 2. MARKET_TOTAL 全程精确等于 000001.SH + 399106.SZ；跨午休 13:02 斜率连续可用
    expect(summary.marketTotalExactMatchAllSteps).toBe(true);
    expect(summary.lunchBridgeSlopeAvailable).toBe(true);
    expect(summary.degradedStepsCount).toBe(0);

    // 3. 09:30-09:34 冷启动无告警
    expect(summary.coldStartAlertCount).toBe(0);

    // 4. 触发的回放告警均标记 [回放] + isReplay=true，且绝不写入实盘 alert_events
    expect(summary.triggeredAlerts.length).toBeGreaterThan(0);
    expect(observedAlerts).toHaveLength(summary.triggeredAlerts.length);
    for (const a of summary.triggeredAlerts) {
      expect(a.isReplay).toBe(true);
      expect(a.message.startsWith(REPLAY_ALERT_PREFIX)).toBe(true);
    }
    expect(db.getAlertEvents(undefined, 100)).toHaveLength(0);

    // 5. 与独立离线逐帧计算 MARKET_TOTAL 告警结果 100% 一致
    const shToday = db.getIntradayBars('000001.SH', '2026-11-24');
    const szToday = db.getIntradayBars('399106.SZ', '2026-11-24');
    const shPrev = db.getIntradayBars('000001.SH', '2026-11-23');
    const szPrev = db.getIntradayBars('399106.SZ', '2026-11-23');
    const todayTotal = aggregateMarketTotalSeries(shToday, szToday).bars;
    const prevTotal = aggregateMarketTotalSeries(shPrev, szPrev).bars;
    const offlineAlertEngine = new AlertEngine();
    const offlineMarketTotalTriggers: Array<{ minuteIndex: number; direction: string }> = [];

    for (let m = 0; m < 240; m++) {
      const visible = todayTotal.filter((b) => b.minuteIndex <= m);
      const metrics = evaluateEnergy({
        todaySeries: visible,
        prevSeries: prevTotal,
        minuteIndex: m,
        elapsedSeconds: 60,
        prevFullDayTurnover: prevTotal[prevTotal.length - 1].cumTurnover,
      });
      const label = minuteIndexToLabel(m);
      const [hh, mm] = label.split(':').map(Number);
      const res = offlineAlertEngine.evaluate({
        symbol: MARKET_TOTAL_SYMBOL,
        name: '沪深两市',
        tradeDate: '2026-11-24',
        timestampMs: shanghaiToTimestampMs('2026-11-24', hh, mm, 59),
        metrics,
        degraded: false,
      });
      if (res.triggered && res.direction) {
        offlineMarketTotalTriggers.push({ minuteIndex: m, direction: res.direction });
      }
    }

    const replayMarketTotalTriggers = summary.triggeredAlerts
      .filter((a) => a.symbol === MARKET_TOTAL_SYMBOL)
      .map((a) => ({ minuteIndex: a.minuteIndex, direction: a.direction }));
    expect(replayMarketTotalTriggers).toEqual(offlineMarketTotalTriggers);
  });

  it('continues replay with explicit degraded state without fabricating missing data when a side or prev day is incomplete', () => {
    const db = createMemoryDb();
    db.upsertTradingDays([{ date: '2026-11-24', isOpen: true }]);
    // 故意缺少上一交易日，并且 399106.SZ 在 minuteIndex 50..55 缺失
    seedFullTradingDay(db, '2026-11-24', {
      omitMinutesForSymbol: { symbol: '399106.SZ', minutes: [50, 51, 52, 53, 54, 55] },
    });

    const engine = new DayReplayEngine({
      database: db,
      stepIntervalMs: 0,
    });

    const stepSnapshots: Array<{ minuteIndex: number | null; cum: number | null; degraded: boolean }> =
      [];
    for (let s = 0; s < 241; s++) {
      const res = engine.stepNext();
      if (!res) break;
      stepSnapshots.push({
        minuteIndex: res.minuteIndex,
        cum: res.state.marketTotal.cumTurnover,
        degraded: res.state.marketTotal.degraded,
      });
    }

    expect(stepSnapshots).toHaveLength(241);
    const missingMinute = stepSnapshots.find((s) => s.minuteIndex === 52)!;
    // 单边缺失时两市总成交额必为 null（绝不补零/不拿单边冒充两市），且明确标注降级
    expect(missingMinute.cum).toBeNull();
    expect(missingMinute.degraded).toBe(true);
  });

  it('guards against cross-gap barTurnover inflation, 399006.SZ cross-source scope mismatch, and reloads watchlist on re-run', () => {
    const db = createMemoryDb();
    db.upsertTradingDays([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);

    for (const sym of [...MONITORED_INDEX_SYMBOLS, '600519.SH']) {
      const prevBars: IntradayBarRow[] = [];
      const todayBars: IntradayBarRow[] = [];
      for (let m = 0; m < 240; m++) {
        prevBars.push({
          symbol: sym,
          tradeDate: '2026-11-23',
          minuteIndex: m,
          minuteStr: minuteIndexToLabel(m),
          price: 2000,
          cumVolume: 1_000_000 * (m + 1),
          cumTurnover: (m + 1) * 100,
          barTurnover: 100,
          source: 'tencent',
        });
        // 000001.SH 缺失 11..14 分钟，第 15 分钟写有膨胀的 500 增量
        if (sym === '000001.SH' && m >= 11 && m <= 14) continue;
        todayBars.push({
          symbol: sym,
          tradeDate: '2026-11-24',
          minuteIndex: m,
          minuteStr: minuteIndexToLabel(m),
          price: 2000,
          cumVolume: 1_000_000 * (m + 1),
          cumTurnover: (m + 1) * 100,
          barTurnover: sym === '000001.SH' && m === 15 ? 500 : 100,
          // 399006.SZ 今日用 eastmoney、昨日用 tencent → 跨源口径冲突
          source: sym === '399006.SZ' ? 'eastmoney' : 'tencent',
        });
      }
      db.upsertIntradayBars(prevBars);
      db.upsertIntradayBars(todayBars);
    }

    const engine = new DayReplayEngine({ database: db, tradeDate: '2026-11-24', stepIntervalMs: 0 });
    const s1 = engine.runAllSteps();

    // 1. 跨缺口首分钟（minuteIndex=15）barTurnover 必须标为 null，杜绝 500+100=600 虚增
    const gapBar15 = s1.finalState.marketTotal.todaySeries.find((b) => b.minuteIndex === 15);
    expect(gapBar15?.barTurnover).toBeNull();

    // 2. 399006.SZ 跨源口径冲突必须降级且置空 metrics（与 PollingScheduler 口径完全一致）
    const cyb = s1.finalState.indices.find((i) => i.symbol === '399006.SZ');
    expect(cyb?.degraded).toBe(true);
    expect(cyb?.degradedReason).toBe('CROSS_SOURCE_SCOPE_MISMATCH');
    expect(cyb?.metrics).toBeNull();

    // 3. 回放期间新增自选股后重新执行 runAllSteps 应自动加载并纳入回放
    expect(s1.finalState.watchlist).toHaveLength(0);
    db.upsertWatchlistItem({
      symbol: '600519.SH',
      name: '贵州茅台',
      sortOrder: 0,
      alertEnabled: true,
      customThresholdsJson: null,
    });
    const s2 = engine.runAllSteps();
    expect(s2.finalState.watchlist.map((w) => w.symbol)).toEqual(['600519.SH']);

    // 4. 默认仅展示上/深/双创；开启可选扩展指数后应纳入回放输出
    expect(s2.finalState.indices.map((i) => i.symbol)).toEqual([
      '000001.SH',
      '399001.SZ',
      '399006.SZ',
      '000680.SH',
    ]);
    engine.updateEnabledOptionalIndices(['000016.SH', '000852.SH']);
    const s3 = engine.runAllSteps();
    expect(s3.finalState.indices.map((i) => i.symbol)).toEqual([
      '000001.SH',
      '399001.SZ',
      '399006.SZ',
      '000680.SH',
      '000016.SH',
      '000852.SH',
    ]);
  });

  it('tracks read/unread state and mark-all-read for in-memory replay alerts', () => {
    const db = createMemoryDb();
    db.upsertTradingDays([
      { date: '2026-11-24', isOpen: true },
      { date: '2026-11-25', isOpen: true },
    ]);
    seedFullTradingDay(db, '2026-11-24');
    seedFullTradingDay(db, '2026-11-25', { surgeMinuteRange: [40, 50] });

    const engine = new DayReplayEngine({
      database: db,
      tradeDate: '2026-11-25',
      stepIntervalMs: 0,
    });
    const summary = engine.runAllSteps();
    expect(summary.triggeredAlerts.length).toBeGreaterThanOrEqual(2);

    const initial = engine.getReplayAlerts();
    expect(initial.every((a) => a.isRead === false)).toBe(true);

    const firstId = initial[0].id;
    expect(engine.markReplayAlertRead(firstId)).toBe(true);
    expect(engine.markReplayAlertRead(firstId)).toBe(false);
    expect(engine.getReplayAlerts().find((a) => a.id === firstId)?.isRead).toBe(true);

    const remainingUnread = engine.getReplayAlerts().filter((a) => !a.isRead).length;
    expect(engine.markAllReplayAlertsRead('2026-11-25')).toBe(remainingUnread);
    expect(engine.getReplayAlerts().every((a) => a.isRead)).toBe(true);
  });
});
