import { afterEach, describe, expect, it } from 'vitest';
import { minuteIndexToLabel } from '../../src/core';
import { AppDatabase } from '../../src/main/storage/database';
import {
  loadMarketTotalPredictionProfile,
  loadSymbolPredictionProfile,
} from '../../src/main/storage/predictionProfileLoader';
import type { IntradayBarRow } from '../../src/shared/types';

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

function seedSymbolDay(
  db: AppDatabase,
  symbol: string,
  tradeDate: string,
  m0Share: number,
  fullDay: number
): void {
  const m0 = fullDay * m0Share;
  const step = (fullDay - m0) / 239;
  const bars: IntradayBarRow[] = [];
  for (let m = 0; m < 240; m++) {
    const cum = m === 0 ? m0 : m0 + step * m;
    bars.push({
      symbol,
      tradeDate,
      minuteIndex: m,
      minuteStr: minuteIndexToLabel(m),
      price: 3300,
      cumVolume: 1_000_000,
      cumTurnover: cum,
      barTurnover: m === 0 ? m0 : step,
      source: 'tencent',
    });
  }
  db.upsertIntradayBars(bars);
  db.upsertAuctionSnapshot({
    symbol,
    tradeDate,
    openPrice: 3300,
    auctionTurnover: m0 * 0.3,
    capturedAt: Date.now(),
  });
}

describe('predictionProfileLoader', () => {
  it('loads multi-day symbol and MARKET_TOTAL profiles strictly before current tradeDate', () => {
    const db = createMemoryDb();
    seedSymbolDay(db, '000001.SH', '2026-11-20', 0.05, 6000);
    seedSymbolDay(db, '399106.SZ', '2026-11-20', 0.05, 8000);

    seedSymbolDay(db, '000001.SH', '2026-11-23', 0.05, 7000);
    seedSymbolDay(db, '399106.SZ', '2026-11-23', 0.05, 9000);

    seedSymbolDay(db, '000001.SH', '2026-11-24', 0.11, 8000);
    seedSymbolDay(db, '399106.SZ', '2026-11-24', 0.11, 10000);

    // 当日（2026-11-25）不应混入历史模板
    seedSymbolDay(db, '000001.SH', '2026-11-25', 0.2, 12000);
    seedSymbolDay(db, '399106.SZ', '2026-11-25', 0.2, 12000);

    const shProfile = loadSymbolPredictionProfile(db, '000001.SH', '2026-11-25', 10);
    expect(shProfile).not.toBeNull();
    expect(shProfile!.sampleDays).toBe(3);
    expect(shProfile!.avgFullDayTurnover).toBeCloseTo((6000 + 7000 + 8000) / 3, 6);
    expect(shProfile!.minuteShares.get(0)).toBeCloseTo((0.05 + 0.05 + 0.11) / 3, 6);

    const totalProfile = loadMarketTotalPredictionProfile(db, '2026-11-25', 10);
    expect(totalProfile).not.toBeNull();
    expect(totalProfile!.sampleDays).toBe(3);
    // 3 天两市合计全天分别为 14000, 16000, 18000 → 均值 16000
    expect(totalProfile!.avgFullDayTurnover).toBeCloseTo(16_000, 6);
    expect(totalProfile!.minuteShares.get(0)).toBeCloseTo((0.05 + 0.05 + 0.11) / 3, 6);
    expect(totalProfile!.minuteShares.get(239)).toBe(1);
  });

  it('ignores partial days and other-symbol dates so they never crowd out valid complete days', () => {
    const db = createMemoryDb();
    // 较早的两个完整日
    seedSymbolDay(db, '000001.SH', '2026-11-18', 0.05, 6000);
    seedSymbolDay(db, '399106.SZ', '2026-11-18', 0.05, 8000);
    seedSymbolDay(db, '000001.SH', '2026-11-19', 0.07, 7000);
    seedSymbolDay(db, '399106.SZ', '2026-11-19', 0.07, 9000);

    // 较近的 3 个日期：1 天只有其他个股，2 天只有残缺 1 根收盘柱
    seedSymbolDay(db, '300750.SZ', '2026-11-20', 0.06, 1000);
    for (const partialDate of ['2026-11-23', '2026-11-24']) {
      db.upsertIntradayBars([
        {
          symbol: '000001.SH',
          tradeDate: partialDate,
          minuteIndex: 239,
          minuteStr: '14:59',
          price: 3300,
          cumVolume: 1_000_000,
          cumTurnover: 9000,
          barTurnover: 100,
          source: 'tencent',
        },
        {
          symbol: '399106.SZ',
          tradeDate: partialDate,
          minuteIndex: 239,
          minuteStr: '14:59',
          price: 2000,
          cumVolume: 1_000_000,
          cumTurnover: 11000,
          barTurnover: 100,
          source: 'tencent',
        },
      ]);
    }

    // 即便 maxDays=2，也不应被 2026-11-20/23/24 的他股日与残缺日挤占，应精准取到 11-18 & 11-19 两个完整日
    const shProfile = loadSymbolPredictionProfile(db, '000001.SH', '2026-11-25', 2);
    expect(shProfile).not.toBeNull();
    expect(shProfile!.sampleDays).toBe(2);
    expect(shProfile!.avgFullDayTurnover).toBeCloseTo(6500, 6);

    const totalProfile = loadMarketTotalPredictionProfile(db, '2026-11-25', 2);
    expect(totalProfile).not.toBeNull();
    expect(totalProfile!.sampleDays).toBe(2);
    expect(totalProfile!.avgFullDayTurnover).toBeCloseTo(15_000, 6);
  });
});
