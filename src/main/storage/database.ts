import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_RETENTION_TRADING_DAYS } from '../../shared/constants';
import type {
  AlertDirection,
  AlertEventInput,
  AlertEventRow,
  AuctionSnapshotRow,
  DatabaseRetentionStats,
  IntradayBarRow,
  PruneResult,
  TradingDayRow,
  WatchlistItemRow,
} from '../../shared/types';

/**
 * 基于 Electron / Node 内置 node:sqlite (DatabaseSync) 的本地 SQLite 持久层。
 * 零 MSVC / node-gyp 编译依赖，支持 WAL 模式与事务读写。
 */
export class AppDatabase {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    this.initSchema();
  }

  /**
   * 幂等初始化 6 张核心表与查询索引（严格对齐 docs/PLAN.md Phase 1 任务 2）。
   * 重复调用不会破坏已有数据。
   */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trading_days (
        date TEXT PRIMARY KEY,
        is_open INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS intraday_bars (
        symbol TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        minute_index INTEGER NOT NULL,
        minute_str TEXT NOT NULL,
        price REAL NOT NULL,
        cum_volume REAL NOT NULL,
        cum_turnover REAL NOT NULL,
        bar_turnover REAL NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (symbol, trade_date, minute_index)
      );

      CREATE INDEX IF NOT EXISTS idx_intraday_bars_trade_date
        ON intraday_bars (trade_date);

      CREATE TABLE IF NOT EXISTS auction_snapshots (
        symbol TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        open_price REAL NOT NULL,
        auction_turnover REAL NOT NULL,
        captured_at INTEGER NOT NULL,
        PRIMARY KEY (symbol, trade_date)
      );

      CREATE INDEX IF NOT EXISTS idx_auction_snapshots_trade_date
        ON auction_snapshots (trade_date);

      CREATE TABLE IF NOT EXISTS watchlist (
        symbol TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        alert_enabled INTEGER NOT NULL,
        custom_thresholds_json TEXT
      );

      CREATE TABLE IF NOT EXISTS alert_events (
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
        created_at INTEGER NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_alert_events_trade_date
        ON alert_events (trade_date);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `);

    // 兼容旧版数据库平滑迁移：为已有 alert_events 表补充 is_read 列（默认未读 0）
    const alertColumns = this.db.prepare('PRAGMA table_info(alert_events)').all() as Array<{
      name: string;
    }>;
    if (!alertColumns.some((col) => col.name === 'is_read')) {
      this.db.exec('ALTER TABLE alert_events ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0;');
    }
  }

  /** 在单个 SQLite 事务中执行操作，异常时自动回滚 */
  private runInTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. trading_days
  // ---------------------------------------------------------------------------

  upsertTradingDays(days: readonly TradingDayRow[]): void {
    if (days.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO trading_days (date, is_open)
      VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET is_open = excluded.is_open
    `);
    this.runInTransaction(() => {
      for (const day of days) {
        stmt.run(day.date, day.isOpen ? 1 : 0);
      }
    });
  }

  getTradingDays(openOnly = false): TradingDayRow[] {
    const sql = openOnly
      ? 'SELECT date, is_open FROM trading_days WHERE is_open = 1 ORDER BY date ASC'
      : 'SELECT date, is_open FROM trading_days ORDER BY date ASC';
    const rows = this.db.prepare(sql).all() as Array<{ date: string; is_open: number }>;
    return rows.map((r) => ({
      date: r.date,
      isOpen: r.is_open === 1,
    }));
  }

  getRecentOpenTradingDays(limit: number, asOfDate?: string): string[] {
    if (asOfDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      throw new RangeError(`Invalid asOfDate (expected YYYY-MM-DD): ${asOfDate}`);
    }
    const rows = (
      asOfDate !== undefined
        ? this.db
            .prepare(
              'SELECT date FROM trading_days WHERE is_open = 1 AND date <= ? ORDER BY date DESC LIMIT ?'
            )
            .all(asOfDate, limit)
        : this.db
            .prepare('SELECT date FROM trading_days WHERE is_open = 1 ORDER BY date DESC LIMIT ?')
            .all(limit)
    ) as Array<{ date: string }>;
    return rows.map((r) => r.date);
  }

  // ---------------------------------------------------------------------------
  // 2. intraday_bars
  // ---------------------------------------------------------------------------

  upsertIntradayBars(bars: readonly IntradayBarRow[]): void {
    if (bars.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO intraday_bars (
        symbol, trade_date, minute_index, minute_str,
        price, cum_volume, cum_turnover, bar_turnover, source
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, trade_date, minute_index) DO UPDATE SET
        minute_str = excluded.minute_str,
        price = excluded.price,
        cum_volume = excluded.cum_volume,
        cum_turnover = excluded.cum_turnover,
        bar_turnover = excluded.bar_turnover,
        source = excluded.source
    `);
    this.runInTransaction(() => {
      for (const b of bars) {
        stmt.run(
          b.symbol,
          b.tradeDate,
          b.minuteIndex,
          b.minuteStr,
          b.price,
          b.cumVolume,
          b.cumTurnover,
          b.barTurnover,
          b.source
        );
      }
    });
  }

  getIntradayBars(symbol: string, tradeDate: string): IntradayBarRow[] {
    const rows = this.db
      .prepare(
        `SELECT symbol, trade_date, minute_index, minute_str,
                price, cum_volume, cum_turnover, bar_turnover, source
         FROM intraday_bars
         WHERE symbol = ? AND trade_date = ?
         ORDER BY minute_index ASC`
      )
      .all(symbol, tradeDate) as Array<{
      symbol: string;
      trade_date: string;
      minute_index: number;
      minute_str: string;
      price: number;
      cum_volume: number;
      cum_turnover: number;
      bar_turnover: number;
      source: string;
    }>;

    return rows.map((r) => ({
      symbol: r.symbol,
      tradeDate: r.trade_date,
      minuteIndex: r.minute_index,
      minuteStr: r.minute_str,
      price: r.price,
      cumVolume: r.cum_volume,
      cumTurnover: r.cum_turnover,
      barTurnover: r.bar_turnover,
      source: r.source,
    }));
  }

  /** 查询本地已录制分钟线涵盖的交易日列表（降序，用于全天回放选择） */
  getRecordedBarDates(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT trade_date FROM intraday_bars ORDER BY trade_date DESC')
      .all() as Array<{ trade_date: string }>;
    return rows.map((r) => r.trade_date);
  }

  /** 查询早于指定交易日的最近 limit 个已录制交易日（降序） */
  getRecentRecordedBarDatesBefore(beforeDate: string, limit = 10): string[] {
    const rows = this.db
      .prepare(
        'SELECT DISTINCT trade_date FROM intraday_bars WHERE trade_date < ? ORDER BY trade_date DESC LIMIT ?'
      )
      .all(beforeDate, limit) as Array<{ trade_date: string }>;
    return rows.map((r) => r.trade_date);
  }

  /** 按指定标的查询早于 beforeDate 的最近 limit 个完整 240 分钟历史交易日（降序，防残缺日/他股挤占样本名额） */
  getRecentCompleteBarDatesForSymbol(symbol: string, beforeDate: string, limit = 10): string[] {
    const rows = this.db
      .prepare(
        `SELECT trade_date
         FROM intraday_bars
         WHERE symbol = ? AND trade_date < ?
         GROUP BY trade_date
         HAVING COUNT(*) >= 240
         ORDER BY trade_date DESC
         LIMIT ?`
      )
      .all(symbol, beforeDate, limit) as Array<{ trade_date: string }>;
    return rows.map((r) => r.trade_date);
  }

  /** 查询沪深两市成分标的（shSymbol 与 szSymbol）同时具备完整 240 分钟的历史交易日（降序） */
  getRecentCompletePairBarDates(
    shSymbol: string,
    szSymbol: string,
    beforeDate: string,
    limit = 10
  ): string[] {
    const rows = this.db
      .prepare(
        `SELECT a.trade_date
         FROM (
           SELECT trade_date FROM intraday_bars
           WHERE symbol = ? AND trade_date < ?
           GROUP BY trade_date
           HAVING COUNT(*) >= 240
         ) a
         INNER JOIN (
           SELECT trade_date FROM intraday_bars
           WHERE symbol = ? AND trade_date < ?
           GROUP BY trade_date
           HAVING COUNT(*) >= 240
         ) b ON a.trade_date = b.trade_date
         ORDER BY a.trade_date DESC
         LIMIT ?`
      )
      .all(shSymbol, beforeDate, szSymbol, beforeDate, limit) as Array<{ trade_date: string }>;
    return rows.map((r) => r.trade_date);
  }

  /** 查询指定交易日在本地已录制分钟线中的所有标的 */
  getRecordedSymbolsForDate(tradeDate: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT symbol FROM intraday_bars WHERE trade_date = ? ORDER BY symbol ASC')
      .all(tradeDate) as Array<{ symbol: string }>;
    return rows.map((r) => r.symbol);
  }

  // ---------------------------------------------------------------------------
  // 3. auction_snapshots
  // ---------------------------------------------------------------------------

  upsertAuctionSnapshot(snapshot: AuctionSnapshotRow): void {
    this.db
      .prepare(
        `INSERT INTO auction_snapshots (
           symbol, trade_date, open_price, auction_turnover, captured_at
         )
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(symbol, trade_date) DO UPDATE SET
           open_price = excluded.open_price,
           auction_turnover = excluded.auction_turnover,
           captured_at = excluded.captured_at`
      )
      .run(
        snapshot.symbol,
        snapshot.tradeDate,
        snapshot.openPrice,
        snapshot.auctionTurnover,
        snapshot.capturedAt
      );
  }

  getAuctionSnapshot(symbol: string, tradeDate: string): AuctionSnapshotRow | null {
    const row = this.db
      .prepare(
        `SELECT symbol, trade_date, open_price, auction_turnover, captured_at
         FROM auction_snapshots
         WHERE symbol = ? AND trade_date = ?`
      )
      .get(symbol, tradeDate) as
      | {
          symbol: string;
          trade_date: string;
          open_price: number;
          auction_turnover: number;
          captured_at: number;
        }
      | undefined;

    if (!row) return null;
    return {
      symbol: row.symbol,
      tradeDate: row.trade_date,
      openPrice: row.open_price,
      auctionTurnover: row.auction_turnover,
      capturedAt: row.captured_at,
    };
  }

  // ---------------------------------------------------------------------------
  // 4. watchlist
  // ---------------------------------------------------------------------------

  upsertWatchlistItem(item: WatchlistItemRow): void {
    this.db
      .prepare(
        `INSERT INTO watchlist (
           symbol, name, sort_order, alert_enabled, custom_thresholds_json
         )
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           name = excluded.name,
           sort_order = excluded.sort_order,
           alert_enabled = excluded.alert_enabled,
           custom_thresholds_json = excluded.custom_thresholds_json`
      )
      .run(
        item.symbol,
        item.name,
        item.sortOrder,
        item.alertEnabled ? 1 : 0,
        item.customThresholdsJson
      );
  }

  getWatchlist(): WatchlistItemRow[] {
    const rows = this.db
      .prepare(
        `SELECT symbol, name, sort_order, alert_enabled, custom_thresholds_json
         FROM watchlist
         ORDER BY sort_order ASC, symbol ASC`
      )
      .all() as Array<{
      symbol: string;
      name: string;
      sort_order: number;
      alert_enabled: number;
      custom_thresholds_json: string | null;
    }>;

    return rows.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      sortOrder: r.sort_order,
      alertEnabled: r.alert_enabled === 1,
      customThresholdsJson: r.custom_thresholds_json,
    }));
  }

  removeWatchlistItem(symbol: string): boolean {
    const result = this.db.prepare('DELETE FROM watchlist WHERE symbol = ?').run(symbol);
    return Number(result.changes) > 0;
  }

  // ---------------------------------------------------------------------------
  // 5. alert_events
  // ---------------------------------------------------------------------------

  insertAlertEvent(event: AlertEventInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO alert_events (
           symbol, name, trade_date, minute_index, direction,
           slope, window_multiple, cum_ratio, message, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.symbol,
        event.name,
        event.tradeDate,
        event.minuteIndex,
        event.direction,
        event.slope,
        event.windowMultiple,
        event.cumRatio,
        event.message,
        event.createdAt
      );
    return Number(result.lastInsertRowid);
  }

  getAlertEvents(tradeDate?: string, limit = 200): AlertEventRow[] {
    const rows = (
      tradeDate
        ? this.db
            .prepare(
              `SELECT id, symbol, name, trade_date, minute_index, direction,
                      slope, window_multiple, cum_ratio, message, created_at, is_read
               FROM alert_events
               WHERE trade_date = ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?`
            )
            .all(tradeDate, limit)
        : this.db
            .prepare(
              `SELECT id, symbol, name, trade_date, minute_index, direction,
                      slope, window_multiple, cum_ratio, message, created_at, is_read
               FROM alert_events
               ORDER BY created_at DESC, id DESC
               LIMIT ?`
            )
            .all(limit)
    ) as Array<{
      id: number;
      symbol: string;
      name: string;
      trade_date: string;
      minute_index: number;
      direction: string;
      slope: number;
      window_multiple: number;
      cum_ratio: number;
      message: string;
      created_at: number;
      is_read: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      name: r.name,
      tradeDate: r.trade_date,
      minuteIndex: r.minute_index,
      direction: r.direction as AlertDirection,
      slope: r.slope,
      windowMultiple: r.window_multiple,
      cumRatio: r.cum_ratio,
      message: r.message,
      createdAt: r.created_at,
      isRead: r.is_read === 1,
    }));
  }

  /** 将指定 ID 的异动事件标记为已读 */
  markAlertEventRead(id: number): boolean {
    if (!Number.isInteger(id)) return false;
    const result = this.db
      .prepare('UPDATE alert_events SET is_read = 1 WHERE id = ? AND is_read = 0')
      .run(id);
    return Number(result.changes) > 0;
  }

  /** 将指定交易日（省略时为全部历史）的所有未读异动事件标记为已读，返回更新条数 */
  markAllAlertEventsRead(tradeDate?: string): number {
    const result = tradeDate
      ? this.db
          .prepare('UPDATE alert_events SET is_read = 1 WHERE trade_date = ? AND is_read = 0')
          .run(tradeDate)
      : this.db.prepare('UPDATE alert_events SET is_read = 1 WHERE is_read = 0').run();
    return Number(result.changes);
  }

  // ---------------------------------------------------------------------------
  // 6. app_settings
  // ---------------------------------------------------------------------------

  setSetting<T>(key: string, value: T): void {
    const json = JSON.stringify(value);
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(key, json);
  }

  getSetting<T>(key: string): T | null {
    const row = this.db
      .prepare('SELECT value_json FROM app_settings WHERE key = ?')
      .get(key) as { value_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value_json) as T;
  }

  getAllSettings(): Record<string, unknown> {
    const rows = this.db
      .prepare('SELECT key, value_json FROM app_settings ORDER BY key ASC')
      .all() as Array<{ key: string; value_json: string }>;
    const result: Record<string, unknown> = {};
    for (const r of rows) {
      result[r.key] = JSON.parse(r.value_json);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // 30 交易日滚动清理与留存统计
  // ---------------------------------------------------------------------------

  /**
   * 依据 trading_days 中最近 keepDays 个开市日，清理更早的日内行情、竞价与告警记录。
   * - 不触碰 watchlist、app_settings、trading_days
   * - trading_days 为空或开市日不足 keepDays 时不删除任何数据
   * - 传入 asOfDate（YYYY-MM-DD）时仅统计 date <= asOfDate 的开市日，防止日历含未来日期时误删当日/近期数据
   */
  pruneOlderThanTradingDays(
    keepDays = DEFAULT_RETENTION_TRADING_DAYS,
    asOfDate?: string
  ): PruneResult {
    if (!Number.isInteger(keepDays) || keepDays <= 0) {
      throw new Error(`Invalid keepDays: ${keepDays}`);
    }

    const recentOpenDays = this.getRecentOpenTradingDays(keepDays, asOfDate);
    if (recentOpenDays.length < keepDays) {
      return {
        pruned: false,
        keepDays,
        openTradingDaysCount: recentOpenDays.length,
        cutoffDate: null,
        deleted: {
          intradayBars: 0,
          auctionSnapshots: 0,
          alertEvents: 0,
        },
      };
    }

    const cutoffDate = recentOpenDays[recentOpenDays.length - 1];
    const deleted = this.runInTransaction(() => {
      const barsRes = this.db
        .prepare('DELETE FROM intraday_bars WHERE trade_date < ?')
        .run(cutoffDate);
      const auctionRes = this.db
        .prepare('DELETE FROM auction_snapshots WHERE trade_date < ?')
        .run(cutoffDate);
      const alertRes = this.db
        .prepare('DELETE FROM alert_events WHERE trade_date < ?')
        .run(cutoffDate);

      return {
        intradayBars: Number(barsRes.changes),
        auctionSnapshots: Number(auctionRes.changes),
        alertEvents: Number(alertRes.changes),
      };
    });

    return {
      pruned: true,
      keepDays,
      openTradingDaysCount: recentOpenDays.length,
      cutoffDate,
      deleted,
    };
  }

  getRetentionStats(): DatabaseRetentionStats {
    const countOf = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { cnt: number };
      return Number(row?.cnt ?? 0);
    };

    return {
      tradingDaysCount: countOf('SELECT COUNT(*) AS cnt FROM trading_days WHERE is_open = 1'),
      intradayBarsCount: countOf('SELECT COUNT(*) AS cnt FROM intraday_bars'),
      auctionSnapshotsCount: countOf('SELECT COUNT(*) AS cnt FROM auction_snapshots'),
      watchlistCount: countOf('SELECT COUNT(*) AS cnt FROM watchlist'),
      alertEventsCount: countOf('SELECT COUNT(*) AS cnt FROM alert_events'),
      distinctBarDatesCount: countOf('SELECT COUNT(DISTINCT trade_date) AS cnt FROM intraday_bars'),
    };
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
