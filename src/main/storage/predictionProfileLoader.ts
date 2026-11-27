import {
  aggregateMarketTotalAuction,
  aggregateMarketTotalSeries,
  buildPredictionProfile,
  type HistoricalDaySeries,
  type IntradayPredictionProfile,
} from '../../core';
import { MARKET_TOTAL_COMPONENTS } from '../../shared/constants';
import type { AppDatabase } from './database';

export const DEFAULT_PREDICTION_PROFILE_DAYS = 10;

/**
 * 从本地 SQLite 最近最多 maxDays 个历史交易日构建单标的的多日分时占比模板。
 * 零网络开销，仅采用完整收盘（含 minuteIndex 239）的历史日。
 */
export function loadSymbolPredictionProfile(
  db: AppDatabase,
  symbol: string,
  beforeTradeDate: string | null,
  maxDays = DEFAULT_PREDICTION_PROFILE_DAYS
): IntradayPredictionProfile | null {
  if (!beforeTradeDate) return null;
  const dates = db.getRecentCompleteBarDatesForSymbol(symbol, beforeTradeDate, maxDays);
  if (dates.length === 0) return null;

  const days: HistoricalDaySeries[] = [];
  for (const d of dates) {
    const bars = db.getIntradayBars(symbol, d);
    if (bars.length === 0) continue;
    const auction = db.getAuctionSnapshot(symbol, d);
    days.push({
      bars,
      auctionTurnover: auction?.auctionTurnover ?? null,
    });
  }

  return buildPredictionProfile(days);
}

/**
 * 从本地 SQLite 最近最多 maxDays 个历史交易日构建沪深两市总成交额（000001.SH + 399106.SZ）多日分时占比模板。
 */
export function loadMarketTotalPredictionProfile(
  db: AppDatabase,
  beforeTradeDate: string | null,
  maxDays = DEFAULT_PREDICTION_PROFILE_DAYS
): IntradayPredictionProfile | null {
  if (!beforeTradeDate) return null;
  const [shSym, szSym] = MARKET_TOTAL_COMPONENTS;
  const dates = db.getRecentCompletePairBarDates(shSym, szSym, beforeTradeDate, maxDays);
  if (dates.length === 0) return null;

  const days: HistoricalDaySeries[] = [];

  for (const d of dates) {
    const shBars = db.getIntradayBars(shSym, d);
    const szBars = db.getIntradayBars(szSym, d);
    if (shBars.length === 0 || szBars.length === 0) continue;

    const agg = aggregateMarketTotalSeries(shBars, szBars);
    if (agg.bars.length === 0) continue;

    const shAuc = db.getAuctionSnapshot(shSym, d);
    const szAuc = db.getAuctionSnapshot(szSym, d);
    const aggAuc = aggregateMarketTotalAuction([
      ...(shAuc ? [{ symbol: shSym, tradeDate: d, auctionTurnover: shAuc.auctionTurnover }] : []),
      ...(szAuc ? [{ symbol: szSym, tradeDate: d, auctionTurnover: szAuc.auctionTurnover }] : []),
    ]);

    days.push({
      bars: agg.bars,
      auctionTurnover: aggAuc.auctionTurnover,
    });
  }

  return buildPredictionProfile(days);
}
