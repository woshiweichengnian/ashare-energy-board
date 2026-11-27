import { describe, expect, it } from 'vitest';
import {
  resolveSymbolChangePct,
  resolveSymbolTurnover,
} from '../../src/shared/snapshotView';
import type { IntradayBarRow, SymbolEnergySnapshot } from '../../src/shared/types';

function makeBar(minuteIndex: number, price: number, cumTurnover: number): IntradayBarRow {
  return {
    symbol: '000001.SH',
    tradeDate: '2026-11-24',
    minuteIndex,
    minuteStr: '15:00',
    price,
    cumVolume: 1_000_000,
    cumTurnover,
    barTurnover: 1_000_000,
    source: 'tencent',
  };
}

function makeSnapshot(overrides?: Partial<SymbolEnergySnapshot>): SymbolEnergySnapshot {
  return {
    symbol: '000001.SH',
    name: '上证指数',
    isIndex: true,
    scope: '全市场',
    quote: null,
    metrics: null,
    auctionTurnover: null,
    prevAuctionTurnover: null,
    prevFullDayTurnover: null,
    todaySeries: [],
    prevSeries: [],
    degraded: false,
    degradedReason: null,
    ...overrides,
  };
}

describe('renderer format helpers (REPLAY & LIVE fallback)', () => {
  it('resolves turnover from quote first, then metrics, then todaySeries without zero-filling', () => {
    // 1. 复盘态 quote=null 但 metrics.todayCumTurnover 有值（盘前/盘后典型场景）
    const replayWithMetrics = makeSnapshot({
      quote: null,
      metrics: {
        minuteIndex: 239,
        elapsedSeconds: 60,
        todayCumTurnover: 7718.6e8,
        prevAlignedCumTurnover: 7385e8,
        cumDiff: 333.6e8,
        cumRatio: 0.045,
        cumRatioPct: 4.5,
        predictedFullDayTurnover: 7718.6e8,
        volumeState: 'FLAT',
        slope: -0.03,
        windowMultiple: 0.95,
        windowDeviationPct: -5,
        slopeWindow: 5,
      },
    });
    expect(resolveSymbolTurnover(replayWithMetrics)).toBe(7718.6e8);

    // 2. quote=null 且 metrics=null 时，回退至 todaySeries 最后一根
    const seriesOnly = makeSnapshot({
      todaySeries: [makeBar(0, 3300, 100e8), makeBar(239, 3320, 8832.2e8)],
    });
    expect(resolveSymbolTurnover(seriesOnly)).toBe(8832.2e8);

    // 3. 盘中实时 quote 存在时优先取 quote.turnover
    const liveWithQuote = makeSnapshot({
      quote: {
        symbol: '000001.SH',
        name: '上证指数',
        price: 3350,
        prevClose: 3300,
        open: 3310,
        high: 3360,
        low: 3305,
        changeAmt: 50,
        changePct: 1.52,
        volumeShares: 1e9,
        turnover: 5123.4e8,
        tradeDate: '2026-11-25',
        timestampMs: Date.now(),
        source: 'tencent',
      },
      todaySeries: [makeBar(10, 3320, 4900e8)],
    });
    expect(resolveSymbolTurnover(liveWithQuote)).toBe(5123.4e8);

    // 4. 完全无数据时返回 null（绝不补零）
    expect(resolveSymbolTurnover(makeSnapshot())).toBeNull();
  });

  it('resolves changePct from quote first, then computes close-to-close changePct in REPLAY mode', () => {
    const replay = makeSnapshot({
      todaySeries: [makeBar(239, 3366, 7718.6e8)],
      prevSeries: [makeBar(239, 3300, 7385e8)],
    });
    expect(resolveSymbolChangePct(replay)).toBeCloseTo(2.0, 5);

    // 缺少昨日收盘价时返回 null
    const missingPrev = makeSnapshot({
      todaySeries: [makeBar(239, 3366, 7718.6e8)],
      prevSeries: [],
    });
    expect(resolveSymbolChangePct(missingPrev)).toBeNull();
  });
});
