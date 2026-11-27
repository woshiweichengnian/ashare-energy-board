import { MARKET_TOTAL_COMPONENTS, MARKET_TOTAL_SYMBOL } from '../shared/constants';

/**
 * 沪深两市总成交额聚合模块（纯 TypeScript，零 IO）
 *
 * 领域硬不变量：
 * - 固定按 MARKET_TOTAL = 上证指数(000001.SH) + 深证综指(399106.SZ) 计算，不含北证。
 * - 深证成指(399001.SZ)、创业板指(399006.SZ)、科创50(000688.SH) 永不参与合计，防止重复累加。
 * - 任一侧缺失或两侧时间未对齐时，显式标记 degraded=true 且不输出合计值。
 */

const [SH_TOTAL_SYMBOL, SZ_TOTAL_SYMBOL] = MARKET_TOTAL_COMPONENTS;

export type AggregationDegradedReason =
  | 'MISSING_BOTH'
  | 'MISSING_SH'
  | 'MISSING_SZ'
  | 'INVALID_TURNOVER'
  | 'TRADE_DATE_MISMATCH'
  | 'MINUTE_MISALIGNED'
  | 'TIMESTAMP_MISALIGNED';

export interface SymbolTurnoverSnapshot {
  readonly symbol: string;
  readonly tradeDate: string;
  readonly minuteIndex: number | null;
  readonly timestampMs?: number;
  /** 截至当前时刻的累计成交额（人民币元） */
  readonly cumTurnover: number;
}

export interface MarketTotalSnapshot {
  readonly symbol: typeof MARKET_TOTAL_SYMBOL;
  readonly tradeDate: string | null;
  readonly minuteIndex: number | null;
  readonly timestampMs: number | null;
  /** 正常时为沪深两市合计成交额（元）；degraded 时恒为 null */
  readonly cumTurnover: number | null;
  readonly shTurnover: number | null;
  readonly szTurnover: number | null;
  readonly degraded: boolean;
  readonly reason: AggregationDegradedReason | null;
}

export interface AggregateSnapshotOptions {
  /** 当双边均提供 timestampMs 时允许的最大时间差（毫秒），默认 60_000ms */
  maxTimestampDriftMs?: number;
}

export interface SymbolMinuteBar {
  readonly minuteIndex: number;
  readonly cumTurnover: number;
  readonly barTurnover?: number;
}

export interface AggregatedMinuteBar {
  readonly minuteIndex: number;
  readonly cumTurnover: number;
  /** 单分钟增量成交额；未传入双边单分钟增量且前后分钟不连续时为 null，避免跨缺口虚增单分钟增量 */
  readonly barTurnover: number | null;
  readonly shCumTurnover: number;
  readonly szCumTurnover: number;
}

export interface MarketTotalSeriesResult {
  readonly symbol: typeof MARKET_TOTAL_SYMBOL;
  readonly bars: readonly AggregatedMinuteBar[];
  readonly degraded: boolean;
  readonly missingShMinutes: readonly number[];
  readonly missingSzMinutes: readonly number[];
}

export interface SymbolAuctionInput {
  readonly symbol: string;
  readonly tradeDate: string;
  readonly auctionTurnover: number;
}

export interface MarketTotalAuctionResult {
  readonly symbol: typeof MARKET_TOTAL_SYMBOL;
  readonly tradeDate: string | null;
  readonly auctionTurnover: number | null;
  readonly shAuctionTurnover: number | null;
  readonly szAuctionTurnover: number | null;
  readonly degraded: boolean;
  readonly reason: AggregationDegradedReason | null;
}

function isValidTurnover(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

function isValidMinuteIndex(val: unknown): val is number {
  return typeof val === 'number' && Number.isInteger(val) && val >= 0 && val <= 239;
}

function findSymbolSnapshot(
  input: ReadonlyMap<string, SymbolTurnoverSnapshot> | readonly SymbolTurnoverSnapshot[],
  targetSymbol: string
): SymbolTurnoverSnapshot | undefined {
  if (Array.isArray(input)) {
    return input.find((item) => item.symbol === targetSymbol);
  }
  return (input as ReadonlyMap<string, SymbolTurnoverSnapshot>).get(targetSymbol);
}

/**
 * 聚合实时快照为沪深两市总成交额（MARKET_TOTAL）。
 * 输入中即便包含 399001.SZ / 399006.SZ / 000688.SH 或个股，也严格忽略，仅采用 000001.SH + 399106.SZ。
 */
export function aggregateMarketTotalSnapshot(
  snapshots: ReadonlyMap<string, SymbolTurnoverSnapshot> | readonly SymbolTurnoverSnapshot[],
  options: AggregateSnapshotOptions = {}
): MarketTotalSnapshot {
  const maxDriftMs = options.maxTimestampDriftMs ?? 60_000;
  const sh = findSymbolSnapshot(snapshots, SH_TOTAL_SYMBOL);
  const sz = findSymbolSnapshot(snapshots, SZ_TOTAL_SYMBOL);

  if (!sh && !sz) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: null,
      minuteIndex: null,
      timestampMs: null,
      cumTurnover: null,
      shTurnover: null,
      szTurnover: null,
      degraded: true,
      reason: 'MISSING_BOTH',
    };
  }

  if (!sh) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: sz!.tradeDate,
      minuteIndex: sz!.minuteIndex,
      timestampMs: sz!.timestampMs ?? null,
      cumTurnover: null,
      shTurnover: null,
      szTurnover: isValidTurnover(sz!.cumTurnover) ? sz!.cumTurnover : null,
      degraded: true,
      reason: 'MISSING_SH',
    };
  }

  if (!sz) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: sh.tradeDate,
      minuteIndex: sh.minuteIndex,
      timestampMs: sh.timestampMs ?? null,
      cumTurnover: null,
      shTurnover: isValidTurnover(sh.cumTurnover) ? sh.cumTurnover : null,
      szTurnover: null,
      degraded: true,
      reason: 'MISSING_SZ',
    };
  }

  if (!isValidTurnover(sh.cumTurnover) || !isValidTurnover(sz.cumTurnover)) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: sh.tradeDate === sz.tradeDate ? sh.tradeDate : null,
      minuteIndex: sh.minuteIndex === sz.minuteIndex ? sh.minuteIndex : null,
      timestampMs: null,
      cumTurnover: null,
      shTurnover: isValidTurnover(sh.cumTurnover) ? sh.cumTurnover : null,
      szTurnover: isValidTurnover(sz.cumTurnover) ? sz.cumTurnover : null,
      degraded: true,
      reason: 'INVALID_TURNOVER',
    };
  }

  if (sh.tradeDate !== sz.tradeDate) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: null,
      minuteIndex: null,
      timestampMs: null,
      cumTurnover: null,
      shTurnover: sh.cumTurnover,
      szTurnover: sz.cumTurnover,
      degraded: true,
      reason: 'TRADE_DATE_MISMATCH',
    };
  }

  if (sh.minuteIndex !== sz.minuteIndex) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: sh.tradeDate,
      minuteIndex: null,
      timestampMs: null,
      cumTurnover: null,
      shTurnover: sh.cumTurnover,
      szTurnover: sz.cumTurnover,
      degraded: true,
      reason: 'MINUTE_MISALIGNED',
    };
  }

  if (
    typeof sh.timestampMs === 'number' &&
    typeof sz.timestampMs === 'number' &&
    Math.abs(sh.timestampMs - sz.timestampMs) > maxDriftMs
  ) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: sh.tradeDate,
      minuteIndex: sh.minuteIndex,
      timestampMs: null,
      cumTurnover: null,
      shTurnover: sh.cumTurnover,
      szTurnover: sz.cumTurnover,
      degraded: true,
      reason: 'TIMESTAMP_MISALIGNED',
    };
  }

  const timestampMs =
    typeof sh.timestampMs === 'number' && typeof sz.timestampMs === 'number'
      ? Math.max(sh.timestampMs, sz.timestampMs)
      : sh.timestampMs ?? sz.timestampMs ?? null;

  return {
    symbol: MARKET_TOTAL_SYMBOL,
    tradeDate: sh.tradeDate,
    minuteIndex: sh.minuteIndex,
    timestampMs,
    cumTurnover: sh.cumTurnover + sz.cumTurnover,
    shTurnover: sh.cumTurnover,
    szTurnover: sz.cumTurnover,
    degraded: false,
    reason: null,
  };
}

/**
 * 将上证 000001.SH 与深证综指 399106.SZ 的分钟序列按 minuteIndex 严格内连接聚合为两市总序列。
 * 单边缺失的分钟不会输出合计值，并在返回结果中标记 degraded=true 与缺失分钟列表。
 */
export function aggregateMarketTotalSeries(
  shBars: readonly SymbolMinuteBar[],
  szBars: readonly SymbolMinuteBar[]
): MarketTotalSeriesResult {
  const shMap = new Map<number, SymbolMinuteBar>();
  const szMap = new Map<number, SymbolMinuteBar>();
  const allIndices = new Set<number>();
  let hasInvalidInput = false;

  for (const bar of shBars) {
    if (isValidMinuteIndex(bar.minuteIndex) && isValidTurnover(bar.cumTurnover)) {
      shMap.set(bar.minuteIndex, bar);
      allIndices.add(bar.minuteIndex);
    } else {
      hasInvalidInput = true;
    }
  }
  for (const bar of szBars) {
    if (isValidMinuteIndex(bar.minuteIndex) && isValidTurnover(bar.cumTurnover)) {
      szMap.set(bar.minuteIndex, bar);
      allIndices.add(bar.minuteIndex);
    } else {
      hasInvalidInput = true;
    }
  }

  const sortedIndices = [...allIndices].sort((a, b) => a - b);
  const bars: AggregatedMinuteBar[] = [];
  const missingShMinutes: number[] = [];
  const missingSzMinutes: number[] = [];

  for (const idx of sortedIndices) {
    const sh = shMap.get(idx);
    const sz = szMap.get(idx);
    if (!sh) {
      missingShMinutes.push(idx);
      continue;
    }
    if (!sz) {
      missingSzMinutes.push(idx);
      continue;
    }

    const prevAgg = bars.length > 0 ? bars[bars.length - 1] : null;
    const cumTurnover = sh.cumTurnover + sz.cumTurnover;
    let barTurnover: number | null;
    if (isValidTurnover(sh.barTurnover) && isValidTurnover(sz.barTurnover)) {
      barTurnover = sh.barTurnover + sz.barTurnover;
    } else if (prevAgg && prevAgg.minuteIndex === idx - 1) {
      barTurnover = Math.max(0, cumTurnover - prevAgg.cumTurnover);
    } else if (idx === 0) {
      barTurnover = cumTurnover;
    } else {
      barTurnover = null;
    }

    bars.push({
      minuteIndex: idx,
      cumTurnover,
      barTurnover,
      shCumTurnover: sh.cumTurnover,
      szCumTurnover: sz.cumTurnover,
    });
  }

  const degraded =
    hasInvalidInput ||
    bars.length === 0 ||
    missingShMinutes.length > 0 ||
    missingSzMinutes.length > 0;

  return {
    symbol: MARKET_TOTAL_SYMBOL,
    bars,
    degraded,
    missingShMinutes,
    missingSzMinutes,
  };
}

/**
 * 聚合 09:25 开盘集合竞价两市总成交额（000001.SH + 399106.SZ）。
 */
export function aggregateMarketTotalAuction(
  auctions: ReadonlyMap<string, SymbolAuctionInput> | readonly SymbolAuctionInput[]
): MarketTotalAuctionResult {
  const sh = Array.isArray(auctions)
    ? auctions.find((a) => a.symbol === SH_TOTAL_SYMBOL)
    : (auctions as ReadonlyMap<string, SymbolAuctionInput>).get(SH_TOTAL_SYMBOL);
  const sz = Array.isArray(auctions)
    ? auctions.find((a) => a.symbol === SZ_TOTAL_SYMBOL)
    : (auctions as ReadonlyMap<string, SymbolAuctionInput>).get(SZ_TOTAL_SYMBOL);

  if (!sh && !sz) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: null,
      auctionTurnover: null,
      shAuctionTurnover: null,
      szAuctionTurnover: null,
      degraded: true,
      reason: 'MISSING_BOTH',
    };
  }
  if (!sh) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: sz!.tradeDate,
      auctionTurnover: null,
      shAuctionTurnover: null,
      szAuctionTurnover: isValidTurnover(sz!.auctionTurnover) ? sz!.auctionTurnover : null,
      degraded: true,
      reason: 'MISSING_SH',
    };
  }
  if (!sz) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: sh.tradeDate,
      auctionTurnover: null,
      shAuctionTurnover: isValidTurnover(sh.auctionTurnover) ? sh.auctionTurnover : null,
      szAuctionTurnover: null,
      degraded: true,
      reason: 'MISSING_SZ',
    };
  }
  if (!isValidTurnover(sh.auctionTurnover) || !isValidTurnover(sz.auctionTurnover)) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: sh.tradeDate === sz.tradeDate ? sh.tradeDate : null,
      auctionTurnover: null,
      shAuctionTurnover: isValidTurnover(sh.auctionTurnover) ? sh.auctionTurnover : null,
      szAuctionTurnover: isValidTurnover(sz.auctionTurnover) ? sz.auctionTurnover : null,
      degraded: true,
      reason: 'INVALID_TURNOVER',
    };
  }
  if (sh.tradeDate !== sz.tradeDate) {
    return {
      symbol: MARKET_TOTAL_SYMBOL,
      tradeDate: null,
      auctionTurnover: null,
      shAuctionTurnover: sh.auctionTurnover,
      szAuctionTurnover: sz.auctionTurnover,
      degraded: true,
      reason: 'TRADE_DATE_MISMATCH',
    };
  }

  return {
    symbol: MARKET_TOTAL_SYMBOL,
    tradeDate: sh.tradeDate,
    auctionTurnover: sh.auctionTurnover + sz.auctionTurnover,
    shAuctionTurnover: sh.auctionTurnover,
    szAuctionTurnover: sz.auctionTurnover,
    degraded: false,
    reason: null,
  };
}
