import type { SymbolMinuteBar } from '../core';
import type { IntradayBarRow, QuoteSnapshot } from './types';

export type CybScopeGroup = 'tx_sina' | 'em_hithink';

/**
 * 创业板指（399006.SZ）口径分组（docs/DATA_SOURCES.md §2.2）：
 * - 腾讯与新浪口径 100% 一致（创业板全市场股票）
 * - 东财与同花顺口径一致（含扩展统计口径，较腾讯/新浪高约 +1.13%）
 */
export function getCybScopeGroup(source: string | null | undefined): CybScopeGroup | null {
  if (source === 'tencent' || source === 'sina') return 'tx_sina';
  if (source === 'eastmoney' || source === 'hithink') return 'em_hithink';
  return null;
}

/**
 * 检测 399006.SZ 在昨日基线、今日已落盘分时与实时快照之间是否存在跨口径混用。
 * 覆盖实盘 LIVE、复盘 REPLAY 与 --replay 全天回放，防止将不同口径相除制造 +1.13% 假放量。
 */
export function hasCybCrossSourceMismatch(params: {
  symbol: string;
  todayBars: readonly Pick<IntradayBarRow, 'source'>[];
  prevBars: readonly Pick<IntradayBarRow, 'source'>[];
  liveSnap: Pick<QuoteSnapshot, 'source'> | null;
}): boolean {
  if (params.symbol !== '399006.SZ') return false;
  const groups = new Set<CybScopeGroup>();

  for (const bar of params.prevBars) {
    const g = getCybScopeGroup(bar.source);
    if (g) groups.add(g);
  }
  for (const bar of params.todayBars) {
    const g = getCybScopeGroup(bar.source);
    if (g) groups.add(g);
  }
  if (params.liveSnap) {
    const g = getCybScopeGroup(params.liveSnap.source);
    if (g) groups.add(g);
  }

  return groups.size > 1;
}

/**
 * 构造传给 aggregateMarketTotalSeries 的分钟点，对跨缺口首分钟省略 barTurnover，
 * 让核心聚合引擎将其标为 null，避免将多分钟累计差值虚增到单分钟柱状图。
 */
export function toAggregatorBars(
  bars: readonly Pick<IntradayBarRow, 'minuteIndex' | 'cumTurnover' | 'barTurnover'>[]
): SymbolMinuteBar[] {
  return bars.map((bar, i) => {
    const prev = i > 0 ? bars[i - 1] : null;
    const isContiguous =
      bar.minuteIndex === 0 || (prev !== null && prev.minuteIndex === bar.minuteIndex - 1);
    return isContiguous
      ? {
          minuteIndex: bar.minuteIndex,
          cumTurnover: bar.cumTurnover,
          barTurnover: bar.barTurnover,
        }
      : {
          minuteIndex: bar.minuteIndex,
          cumTurnover: bar.cumTurnover,
        };
  });
}
