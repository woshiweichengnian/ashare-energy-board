import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../src/main/storage/database';
import type { TradingDayRow } from '../../src/shared/types';

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashare-volpulse-db-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'test.sqlite');
}

function makeDate(offsetDays: number): string {
  const base = new Date(Date.UTC(2026, 0, 1 + offsetDays));
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, '0');
  const d = String(base.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('AppDatabase', () => {
  it('supports idempotent initialization without losing existing data', () => {
    const dbPath = createTempDbPath();

    const db1 = new AppDatabase(dbPath);
    db1.upsertWatchlistItem({
      symbol: '600519.SH',
      name: '贵州茅台',
      sortOrder: 0,
      alertEnabled: true,
      customThresholdsJson: null,
    });
    db1.setSetting('pollingIntervalSec', 3);
    db1.close();

    // 重复打开同一个数据库文件，建表语句应幂等且保留原有数据
    const db2 = new AppDatabase(dbPath);
    expect(db2.getWatchlist()).toHaveLength(1);
    expect(db2.getWatchlist()[0].symbol).toBe('600519.SH');
    expect(db2.getSetting<number>('pollingIntervalSec')).toBe(3);
    db2.close();
  });

  it('reads and writes all 6 tables accurately', () => {
    const db = new AppDatabase(':memory:');

    // 1. trading_days
    db.upsertTradingDays([
      { date: '2026-11-21', isOpen: false },
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);
    expect(db.getTradingDays()).toHaveLength(3);
    expect(db.getTradingDays(true).map((d) => d.date)).toEqual(['2026-11-23', '2026-11-24']);

    // 2. intraday_bars
    db.upsertIntradayBars([
      {
        symbol: '000001.SH',
        tradeDate: '2026-11-24',
        minuteIndex: 1,
        minuteStr: '09:32',
        price: 3567.2,
        cumVolume: 4521037700,
        cumTurnover: 75078389510.4,
        barTurnover: 23733444870,
        source: 'tencent',
      },
      {
        symbol: '000001.SH',
        tradeDate: '2026-11-24',
        minuteIndex: 0,
        minuteStr: '09:31',
        price: 3559.78,
        cumVolume: 3005857800,
        cumTurnover: 51344944640.4,
        barTurnover: 38616172951.9,
        source: 'tencent',
      },
    ]);
    const bars = db.getIntradayBars('000001.SH', '2026-11-24');
    expect(bars.map((b) => b.minuteIndex)).toEqual([0, 1]);
    expect(bars[0].cumTurnover).toBeCloseTo(51344944640.4, 2);

    // 3. auction_snapshots
    db.upsertAuctionSnapshot({
      symbol: '000001.SH',
      tradeDate: '2026-11-24',
      openPrice: 3567.84,
      auctionTurnover: 12728771688.5,
      capturedAt: 1795483505000,
    });
    const auction = db.getAuctionSnapshot('000001.SH', '2026-11-24');
    expect(auction).not.toBeNull();
    expect(auction?.openPrice).toBe(3567.84);
    expect(auction?.auctionTurnover).toBeCloseTo(12728771688.5, 2);

    // 4. watchlist
    db.upsertWatchlistItem({
      symbol: '300750.SZ',
      name: '宁德时代',
      sortOrder: 2,
      alertEnabled: true,
      customThresholdsJson: JSON.stringify({ slopeThreshold: 1.5 }),
    });
    db.upsertWatchlistItem({
      symbol: '600519.SH',
      name: '贵州茅台',
      sortOrder: 1,
      alertEnabled: false,
      customThresholdsJson: null,
    });
    expect(db.getWatchlist().map((w) => w.symbol)).toEqual(['600519.SH', '300750.SZ']);
    expect(db.removeWatchlistItem('600519.SH')).toBe(true);
    expect(db.removeWatchlistItem('600519.SH')).toBe(false);
    expect(db.getWatchlist().map((w) => w.symbol)).toEqual(['300750.SZ']);

    // 5. alert_events
    const id1 = db.insertAlertEvent({
      symbol: 'MARKET_TOTAL',
      name: '沪深两市',
      tradeDate: '2026-11-24',
      minuteIndex: 15,
      direction: 'SURGE',
      slope: 1.85,
      windowMultiple: 1.72,
      cumRatio: 0.124,
      message: '沪深两市快速放量',
      createdAt: 1795485000000,
    });
    const id2 = db.insertAlertEvent({
      symbol: '300750.SZ',
      name: '宁德时代',
      tradeDate: '2026-11-24',
      minuteIndex: 45,
      direction: 'SHRINK',
      slope: -1.42,
      windowMultiple: 0.58,
      cumRatio: -0.08,
      message: '宁德时代快速缩量',
      createdAt: 1795486800000,
    });
    expect(id2).toBeGreaterThan(id1);
    const events = db.getAlertEvents('2026-11-24');
    expect(events.map((e) => e.id)).toEqual([id2, id1]);
    expect(events[0].direction).toBe('SHRINK');

    // 6. app_settings
    db.setSetting('hudOpacity', 0.85);
    db.setSetting('bossKey', 'Alt+Shift+A');
    expect(db.getSetting<number>('hudOpacity')).toBe(0.85);
    expect(db.getSetting<string>('missingKey')).toBeNull();
    expect(db.getAllSettings()).toEqual({
      bossKey: 'Alt+Shift+A',
      hudOpacity: 0.85,
    });

    db.close();
  });

  it('does not delete any data when trading_days is empty or has fewer than 30 open days', () => {
    const db = new AppDatabase(':memory:');

    db.upsertIntradayBars([
      {
        symbol: '000001.SH',
        tradeDate: '2025-01-02',
        minuteIndex: 0,
        minuteStr: '09:31',
        price: 3000,
        cumVolume: 1000,
        cumTurnover: 1e8,
        barTurnover: 1e8,
        source: 'tencent',
      },
    ]);
    db.upsertAuctionSnapshot({
      symbol: '000001.SH',
      tradeDate: '2025-01-02',
      openPrice: 3000,
      auctionTurnover: 1e7,
      capturedAt: 1735781100000,
    });
    db.insertAlertEvent({
      symbol: '000001.SH',
      name: '上证指数',
      tradeDate: '2025-01-02',
      minuteIndex: 10,
      direction: 'SURGE',
      slope: 1.5,
      windowMultiple: 1.6,
      cumRatio: 0.1,
      message: '历史测试告警',
      createdAt: 1735781700000,
    });

    // trading_days 为空时不清理
    const resEmpty = db.pruneOlderThanTradingDays(30);
    expect(resEmpty.pruned).toBe(false);
    expect(resEmpty.cutoffDate).toBeNull();
    expect(db.getIntradayBars('000001.SH', '2025-01-02')).toHaveLength(1);

    // 写入 29 个开市日 + 10 个休市日（总行数 39，但开市日仅 29 < 30），仍不得清理
    const days: TradingDayRow[] = [];
    for (let i = 0; i < 39; i++) {
      days.push({ date: makeDate(i), isOpen: i < 29 });
    }
    db.upsertTradingDays(days);

    const resInsufficient = db.pruneOlderThanTradingDays(30);
    expect(resInsufficient.pruned).toBe(false);
    expect(resInsufficient.openTradingDaysCount).toBe(29);
    expect(db.getIntradayBars('000001.SH', '2025-01-02')).toHaveLength(1);
    expect(db.getAuctionSnapshot('000001.SH', '2025-01-02')).not.toBeNull();
    expect(db.getAlertEvents('2025-01-02')).toHaveLength(1);

    db.close();
  });

  it('prunes only records older than the most recent 30 open trading days while preserving watchlist, settings, and trading_days', () => {
    const db = new AppDatabase(':memory:');

    // 构造 42 个自然日：前 35 个开市日 + 夹杂 7 个休市日
    const openDates: string[] = [];
    const calendar: TradingDayRow[] = [];
    for (let i = 0; i < 42; i++) {
      const date = makeDate(i);
      const isOpen = i % 6 !== 5; // 每 6 天休市 1 天，共 35 个开市日
      calendar.push({ date, isOpen });
      if (isOpen) openDates.push(date);
    }
    expect(openDates).toHaveLength(35);
    db.upsertTradingDays(calendar);

    // 为 35 个开市日全部写入 intraday_bars、auction_snapshots、alert_events
    const bars = openDates.map((date) => ({
      symbol: '000001.SH',
      tradeDate: date,
      minuteIndex: 0,
      minuteStr: '09:31',
      price: 3500,
      cumVolume: 10000,
      cumTurnover: 1e9,
      barTurnover: 1e9,
      source: 'tencent',
    }));
    db.upsertIntradayBars(bars);

    for (let i = 0; i < openDates.length; i++) {
      const date = openDates[i];
      db.upsertAuctionSnapshot({
        symbol: '000001.SH',
        tradeDate: date,
        openPrice: 3500,
        auctionTurnover: 1e8,
        capturedAt: 1700000000000 + i * 86400000,
      });
      db.insertAlertEvent({
        symbol: '000001.SH',
        name: '上证指数',
        tradeDate: date,
        minuteIndex: 10,
        direction: 'SURGE',
        slope: 1.5,
        windowMultiple: 1.8,
        cumRatio: 0.12,
        message: `alert-${date}`,
        createdAt: 1700000000000 + i * 86400000,
      });
    }

    // 写入 watchlist 和 app_settings，验证清理不会触碰
    db.upsertWatchlistItem({
      symbol: '600519.SH',
      name: '贵州茅台',
      sortOrder: 0,
      alertEnabled: true,
      customThresholdsJson: null,
    });
    db.setSetting('theme', 'dark-hud');

    const result = db.pruneOlderThanTradingDays(30);
    const expectedCutoff = openDates[5]; // 索引 0..4 共 5 天被清理，索引 5..34 共 30 天保留

    expect(result.pruned).toBe(true);
    expect(result.cutoffDate).toBe(expectedCutoff);
    expect(result.deleted).toEqual({
      intradayBars: 5,
      auctionSnapshots: 5,
      alertEvents: 5,
    });

    // 验证边界：cutoffDate 前一天被删，cutoffDate 当天保留
    expect(db.getIntradayBars('000001.SH', openDates[4])).toHaveLength(0);
    expect(db.getIntradayBars('000001.SH', expectedCutoff)).toHaveLength(1);
    expect(db.getAuctionSnapshot('000001.SH', openDates[4])).toBeNull();
    expect(db.getAuctionSnapshot('000001.SH', expectedCutoff)).not.toBeNull();
    expect(db.getAlertEvents(openDates[4])).toHaveLength(0);
    expect(db.getAlertEvents(expectedCutoff)).toHaveLength(1);

    // 验证统计与未受影响的表
    const stats = db.getRetentionStats();
    expect(stats.intradayBarsCount).toBe(30);
    expect(stats.auctionSnapshotsCount).toBe(30);
    expect(stats.alertEventsCount).toBe(30);
    expect(stats.distinctBarDatesCount).toBe(30);
    expect(stats.watchlistCount).toBe(1);
    expect(db.getTradingDays()).toHaveLength(42);
    expect(db.getSetting<string>('theme')).toBe('dark-hud');

    db.close();
  });

  it('respects asOfDate so future trading_days in calendar never delete today or recent data', () => {
    const db = new AppDatabase(':memory:');

    // 写入连续 60 个开市日（索引 0..59），模拟日历中包含大量未来交易日
    const allDates: string[] = [];
    for (let i = 0; i < 60; i++) {
      allDates.push(makeDate(i));
    }
    db.upsertTradingDays(allDates.map((date) => ({ date, isOpen: true })));

    // 假设“今日”为第 35 个开市日（索引 34）：
    // - 索引 0..4（共 5 天）早于最近 30 个截至今日的开市日 → 应被清理
    // - 索引 5..34（共 30 天，含今日索引 34）→ 必须完整保留
    const asOfDate = allDates[34];
    db.upsertIntradayBars(
      allDates.slice(0, 35).map((date) => ({
        symbol: '000001.SH',
        tradeDate: date,
        minuteIndex: 0,
        minuteStr: '09:31',
        price: 3500,
        cumVolume: 1000,
        cumTurnover: 1e9,
        barTurnover: 1e9,
        source: 'tencent',
      }))
    );

    const res = db.pruneOlderThanTradingDays(30, asOfDate);
    expect(res.pruned).toBe(true);
    expect(res.cutoffDate).toBe(allDates[5]);
    expect(res.deleted.intradayBars).toBe(5);
    expect(db.getIntradayBars('000001.SH', allDates[4])).toHaveLength(0);
    expect(db.getIntradayBars('000001.SH', allDates[5])).toHaveLength(1);
    expect(db.getIntradayBars('000001.SH', asOfDate)).toHaveLength(1);

    // 截至今日开市日不足 30 天时，即便表内有大量未来交易日也不得清理
    const earlyRes = db.pruneOlderThanTradingDays(30, allDates[10]);
    expect(earlyRes.pruned).toBe(false);
    expect(earlyRes.openTradingDaysCount).toBe(11);
    expect(earlyRes.cutoffDate).toBeNull();

    // 非法日期格式应显式报错，防止混合 YYYYMMDD / YYYY-MM-DD 格式静默失效
    expect(() => db.pruneOlderThanTradingDays(30, '20261124')).toThrow(RangeError);

    db.close();
  });

  it('tracks alert read/unread state, supports mark-one and mark-all by scope, and migrates legacy tables', () => {
    const dbPath = createTempDbPath();

    // 模拟旧版无 is_read 列的数据库并写入一条历史告警
    const legacyRaw = new DatabaseSync(dbPath);
    legacyRaw.exec(`
      CREATE TABLE alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        minute_index INTEGER NOT NULL,
        direction TEXT NOT NULL,
        slope REAL NOT NULL,
        window_multiple REAL NOT NULL,
        cum_ratio REAL NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO alert_events (
        symbol, name, trade_date, minute_index, direction,
        slope, window_multiple, cum_ratio, message, created_at
      ) VALUES (
        '000001.SH', '上证指数', '2026-11-24', 30, 'SURGE',
        3.5, 1.7, 0.12, '旧版历史告警', 1000
      );
    `);
    legacyRaw.close();

    // 使用 AppDatabase 打开旧库：自动迁移 is_read 列且老数据默认未读
    const db = new AppDatabase(dbPath);
    const idToday1 = db.insertAlertEvent({
      symbol: '300750.SZ',
      name: '宁德时代',
      tradeDate: '2026-11-25',
      minuteIndex: 40,
      direction: 'SURGE',
      slope: 4.1,
      windowMultiple: 1.85,
      cumRatio: 0.19,
      message: '当日告警 1',
      createdAt: 2000,
    });
    const idToday2 = db.insertAlertEvent({
      symbol: '600519.SH',
      name: '贵州茅台',
      tradeDate: '2026-11-25',
      minuteIndex: 50,
      direction: 'SHRINK',
      slope: -3.4,
      windowMultiple: 0.55,
      cumRatio: -0.14,
      message: '当日告警 2',
      createdAt: 3000,
    });

    const initialAll = db.getAlertEvents(undefined, 20);
    expect(initialAll).toHaveLength(3);
    expect(initialAll.every((a) => a.isRead === false)).toBe(true);

    // 1. 单条标已读（幂等）
    expect(db.markAlertEventRead(idToday1)).toBe(true);
    expect(db.markAlertEventRead(idToday1)).toBe(false);
    expect(db.getAlertEvents('2026-11-25').find((a) => a.id === idToday1)?.isRead).toBe(true);
    expect(db.getAlertEvents('2026-11-25').find((a) => a.id === idToday2)?.isRead).toBe(false);

    // 2. 按当日全部已读：仅标记 2026-11-25 剩余未读，不影响昨日历史
    expect(db.markAllAlertEventsRead('2026-11-25')).toBe(1);
    expect(db.getAlertEvents('2026-11-25').every((a) => a.isRead)).toBe(true);
    expect(db.getAlertEvents('2026-11-24')[0].isRead).toBe(false);

    // 3. 全部历史已读：把剩余历史未读全部置为已读
    expect(db.markAllAlertEventsRead()).toBe(1);
    expect(db.markAllAlertEventsRead()).toBe(0);
    expect(db.getAlertEvents(undefined, 20).every((a) => a.isRead)).toBe(true);

    db.close();
  });
});
