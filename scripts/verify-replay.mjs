#!/usr/bin/env node
/**
 * Phase 6：基于本地 SQLite 真实录制交易日数据的 09:25 → 15:00 全天回放验证脚本。
 *
 * 用法：
 *   node scripts/verify-replay.mjs [--db <path-to-sqlite>] [--date YYYY-MM-DD]
 *
 * 默认查找 %APPDATA%\ashare-volpulse\ashare-volpulse.sqlite（若不存在则回退查找旧路径 %APPDATA%\a-share-monitor\a-share-monitor.sqlite）。
 * 严格遵循 Phase 6 约束：
 * - 以只读方式读取实盘 SQLite 并载入内存库运行，绝不修改实盘数据库
 * - 直接复用真实 DayReplayEngine 与 src/core/ 实盘计算路径（不另写一套计算公式）
 * - 验证项：
 *   1. 全天 241 帧（09:25 + 0..239）无报错跑通
 *   2. 两市总成交额非降级帧严格等于 000001.SH + 399106.SZ
 *   3. 跨午休（13:02 / minuteIndex=122）滚动斜率连续可用
 *   4. 09:30–09:34 冷启动窗口 0 告警
 *   5. 回放告警均带 [回放] 标记且对 alert_events 0 写入
 *   6. 回放产生的 MARKET_TOTAL 告警与同样参数独立离线调用 src/core/ 计算结果 100% 一致
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function parseCli(argv) {
  let dbPath = null;
  let tradeDate = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db' && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.slice('--db='.length);
    } else if (arg === '--date' && argv[i + 1]) {
      tradeDate = argv[++i];
    } else if (arg.startsWith('--date=')) {
      tradeDate = arg.slice('--date='.length);
    }
  }
  if (!dbPath) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const primaryDbPath = path.join(appData, 'ashare-volpulse', 'ashare-volpulse.sqlite');
    const legacyDbPath = path.join(appData, 'a-share-monitor', 'a-share-monitor.sqlite');
    dbPath = fs.existsSync(primaryDbPath) || !fs.existsSync(legacyDbPath)
      ? primaryDbPath
      : legacyDbPath;
  }
  return { dbPath, tradeDate };
}

function hydrateMemoryDatabaseFromReadOnlySource(sourceDb, memDb) {
  const tradingDays = sourceDb
    .prepare('SELECT date, is_open FROM trading_days ORDER BY date ASC')
    .all();
  if (tradingDays.length > 0) {
    memDb.upsertTradingDays(
      tradingDays.map((r) => ({ date: r.date, isOpen: Boolean(r.is_open) }))
    );
  }

  const intradayBars = sourceDb
    .prepare(
      `SELECT symbol, trade_date, minute_index, minute_str, price, cum_volume, cum_turnover, bar_turnover, source
       FROM intraday_bars
       ORDER BY trade_date ASC, symbol ASC, minute_index ASC`
    )
    .all();
  if (intradayBars.length > 0) {
    memDb.upsertIntradayBars(
      intradayBars.map((r) => ({
        symbol: r.symbol,
        tradeDate: r.trade_date,
        minuteIndex: r.minute_index,
        minuteStr: r.minute_str,
        price: r.price,
        cumVolume: r.cum_volume,
        cumTurnover: r.cum_turnover,
        barTurnover: r.bar_turnover,
        source: r.source,
      }))
    );
  }

  const auctions = sourceDb
    .prepare(
      'SELECT symbol, trade_date, open_price, auction_turnover, captured_at FROM auction_snapshots'
    )
    .all();
  for (const a of auctions) {
    memDb.upsertAuctionSnapshot({
      symbol: a.symbol,
      tradeDate: a.trade_date,
      openPrice: a.open_price,
      auctionTurnover: a.auction_turnover,
      capturedAt: a.captured_at,
    });
  }

  const watchlist = sourceDb
    .prepare(
      'SELECT symbol, name, sort_order, alert_enabled, custom_thresholds_json FROM watchlist ORDER BY sort_order ASC'
    )
    .all();
  for (const w of watchlist) {
    memDb.upsertWatchlistItem({
      symbol: w.symbol,
      name: w.name,
      sortOrder: w.sort_order,
      alertEnabled: Boolean(w.alert_enabled),
      customThresholdsJson: w.custom_thresholds_json,
    });
  }

  const settings = sourceDb.prepare('SELECT key, value_json FROM app_settings').all();
  for (const s of settings) {
    try {
      memDb.setSetting(s.key, JSON.parse(s.value_json));
    } catch {
      // 忽略无法解析的非关键配置项
    }
  }
}

async function main() {
  const { dbPath, tradeDate: requestedDate } = parseCli(process.argv.slice(2));
  if (!fs.existsSync(dbPath)) {
    console.error(`[verify-replay] 未找到本地录制数据库：${dbPath}`);
    process.exit(1);
  }

  const sourceStatBefore = fs.statSync(dbPath);
  const sourceDb = new DatabaseSync(dbPath, { open: true, readOnly: true });
  const viteServer = await createServer({
    root: projectRoot,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  });

  let memDb = null;
  try {
    const alertCountDiskBefore = sourceDb.prepare('SELECT COUNT(*) AS cnt FROM alert_events').get().cnt;

    const {
      AlertEngine,
      aggregateMarketTotalAuction,
      aggregateMarketTotalSeries,
      evaluateEnergy,
      minuteIndexToLabel,
      shanghaiToTimestampMs,
    } = await viteServer.ssrLoadModule('/src/core/index.ts');
    const { MARKET_TOTAL_COMPONENTS, MARKET_TOTAL_SYMBOL, REPLAY_ALERT_PREFIX } =
      await viteServer.ssrLoadModule('/src/shared/constants.ts');
    const { toAggregatorBars } = await viteServer.ssrLoadModule('/src/shared/seriesGuards.ts');
    const { AppDatabase } = await viteServer.ssrLoadModule('/src/main/storage/database.ts');
    const { MonitorSettingsStore } = await viteServer.ssrLoadModule(
      '/src/main/storage/monitorSettingsStore.ts'
    );
    const { loadMarketTotalPredictionProfile } = await viteServer.ssrLoadModule(
      '/src/main/storage/predictionProfileLoader.ts'
    );
    const { DayReplayEngine } = await viteServer.ssrLoadModule(
      '/src/main/replay/dayReplayEngine.ts'
    );

    memDb = new AppDatabase(':memory:');
    hydrateMemoryDatabaseFromReadOnlySource(sourceDb, memDb);

    const monitorConfig = new MonitorSettingsStore(memDb).load();
    const energyConfig = {
      expandThresholdPct: monitorConfig.expandThresholdPct,
      shrinkThresholdPct: monitorConfig.shrinkThresholdPct,
      slopeWindow: monitorConfig.slopeWindow,
    };
    const alertConfig = {
      enabled: monitorConfig.alertsEnabled,
      surgeSlopeThreshold: monitorConfig.surgeSlopeThreshold,
      surgeMultipleThreshold: monitorConfig.surgeMultipleThreshold,
      shrinkSlopeThreshold: monitorConfig.shrinkSlopeThreshold,
      shrinkMultipleThreshold: monitorConfig.shrinkMultipleThreshold,
      matchMode: monitorConfig.matchMode,
      cooldownMinutes: monitorConfig.cooldownMinutes,
      slopeWindow: monitorConfig.slopeWindow,
    };

    const engine = new DayReplayEngine({
      database: memDb,
      tradeDate: requestedDate,
      stepIntervalMs: 0,
      energyConfig,
      alertConfig,
    });
    const summary = engine.runAllSteps();

    // 独立离线逐帧调用 src/core/ 校验 MARKET_TOTAL 告警一致性
    const [shSym, szSym] = MARKET_TOTAL_COMPONENTS;
    const shToday = memDb.getIntradayBars(shSym, summary.tradeDate);
    const szToday = memDb.getIntradayBars(szSym, summary.tradeDate);
    const shPrev = summary.prevTradeDate ? memDb.getIntradayBars(shSym, summary.prevTradeDate) : [];
    const szPrev = summary.prevTradeDate ? memDb.getIntradayBars(szSym, summary.prevTradeDate) : [];

    const prevAgg = aggregateMarketTotalSeries(toAggregatorBars(shPrev), toAggregatorBars(szPrev));
    const prevFullDayTurnover =
      prevAgg.bars.length > 0 ? prevAgg.bars[prevAgg.bars.length - 1].cumTurnover : null;
    const shPrevAuc = summary.prevTradeDate
      ? memDb.getAuctionSnapshot(shSym, summary.prevTradeDate)
      : null;
    const szPrevAuc = summary.prevTradeDate
      ? memDb.getAuctionSnapshot(szSym, summary.prevTradeDate)
      : null;
    const prevAggAuc = aggregateMarketTotalAuction([
      ...(shPrevAuc && summary.prevTradeDate
        ? [{ symbol: shSym, tradeDate: summary.prevTradeDate, auctionTurnover: shPrevAuc.auctionTurnover }]
        : []),
      ...(szPrevAuc && summary.prevTradeDate
        ? [{ symbol: szSym, tradeDate: summary.prevTradeDate, auctionTurnover: szPrevAuc.auctionTurnover }]
        : []),
    ]);
    const predictionProfile = loadMarketTotalPredictionProfile(memDb, summary.tradeDate);

    const offlineAlertEngine = new AlertEngine(alertConfig);
    const offlineMarketTotalAlerts = [];
    for (let m = 0; m < 240; m++) {
      const shVis = shToday.filter((b) => b.minuteIndex <= m);
      const szVis = szToday.filter((b) => b.minuteIndex <= m);
      const shCur = shVis.find((b) => b.minuteIndex === m);
      const szCur = szVis.find((b) => b.minuteIndex === m);
      if (!shCur || !szCur) continue;

      const todayAgg = aggregateMarketTotalSeries(toAggregatorBars(shVis), toAggregatorBars(szVis));
      const metrics = evaluateEnergy({
        todaySeries: todayAgg.bars,
        prevSeries: prevAgg.bars,
        minuteIndex: m,
        currentTodayCumTurnover: shCur.cumTurnover + szCur.cumTurnover,
        elapsedSeconds: 60,
        prevFullDayTurnover,
        prevAuctionTurnover: prevAggAuc.auctionTurnover,
        predictionProfile,
        config: energyConfig,
      });

      const label = minuteIndexToLabel(m);
      const [hh, mm] = label.split(':').map(Number);
      const res = offlineAlertEngine.evaluate({
        symbol: MARKET_TOTAL_SYMBOL,
        name: '沪深两市',
        tradeDate: summary.tradeDate,
        timestampMs: shanghaiToTimestampMs(summary.tradeDate, hh, mm, 59),
        metrics,
        degraded: prevAgg.bars.length === 0,
      });
      if (res.triggered && res.direction) {
        offlineMarketTotalAlerts.push({ minuteIndex: m, direction: res.direction });
      }
    }

    const replayMarketTotalAlerts = summary.triggeredAlerts
      .filter((a) => a.symbol === MARKET_TOTAL_SYMBOL)
      .map((a) => ({ minuteIndex: a.minuteIndex, direction: a.direction }));

    const offlineParityMatch =
      JSON.stringify(replayMarketTotalAlerts) === JSON.stringify(offlineMarketTotalAlerts);
    const allAlertsTaggedReplay = summary.triggeredAlerts.every(
      (a) => a.isReplay === true && a.message.startsWith(REPLAY_ALERT_PREFIX)
    );
    const memAlertEventsWritten = memDb.getAlertEvents(undefined, 10).length;
    const alertCountDiskAfter = sourceDb.prepare('SELECT COUNT(*) AS cnt FROM alert_events').get().cnt;
    const sourceStatAfter = fs.statSync(dbPath);
    const alertEventsUnchanged =
      memAlertEventsWritten === 0 &&
      alertCountDiskBefore === alertCountDiskAfter &&
      sourceStatBefore.mtimeMs === sourceStatAfter.mtimeMs;

    const fullDayComplete =
      shToday.length === 240 &&
      szToday.length === 240 &&
      shPrev.length === 240 &&
      szPrev.length === 240;

    const report = {
      dbPath,
      tradeDate: summary.tradeDate,
      prevTradeDate: summary.prevTradeDate,
      recordedDatesCount: memDb.getRecordedBarDates().length,
      totalStepsExecuted: summary.totalStepsExecuted,
      todayBars: { sh: shToday.length, sz: szToday.length },
      prevBars: { sh: shPrev.length, sz: szPrev.length },
      degradedStepsCount: summary.degradedStepsCount,
      marketTotalExactMatchAllSteps: summary.marketTotalExactMatchAllSteps,
      lunchBridgeSlopeAvailable: summary.lunchBridgeSlopeAvailable,
      coldStartAlertCount: summary.coldStartAlertCount,
      triggeredAlertsCount: summary.triggeredAlerts.length,
      marketTotalAlerts: replayMarketTotalAlerts,
      offlineParityMatch,
      allAlertsTaggedReplay,
      alertEventsUnchanged,
    };

    console.log(JSON.stringify(report, null, 2));

    if (
      summary.totalStepsExecuted !== 241 ||
      !summary.marketTotalExactMatchAllSteps ||
      summary.coldStartAlertCount > 0 ||
      !offlineParityMatch ||
      !allAlertsTaggedReplay ||
      !alertEventsUnchanged
    ) {
      process.exit(1);
    }
    if (fullDayComplete && !summary.lunchBridgeSlopeAvailable) {
      console.error('[verify-replay] 完整数据下跨午休斜率（13:02）不可用！');
      process.exit(1);
    }
  } finally {
    memDb?.close();
    sourceDb.close();
    await viteServer.close();
  }
}

await main();
