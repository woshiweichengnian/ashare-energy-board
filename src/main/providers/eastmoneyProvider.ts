import {
  getShanghaiParts,
  minuteIndexToLabel,
  upstreamMinuteLabelToIndex,
} from '../../core/tradingClock';
import type {
  IntradayBarRow,
  IntradayDayData,
  ProviderHealthStatus,
  QuoteSnapshot,
  TickerSearchResult,
} from '../../shared/types';
import {
  chunkSymbols,
  fetchBufferWithTimeout,
  normalizeDateStr,
  parseStrictFiniteNumber,
  toEastmoneySecid,
} from './http';
import { ProviderRequestError, type FetchLike, type MarketDataProvider } from './types';

const EASTMONEY_REFERER = 'https://quote.eastmoney.com/';

export interface EastmoneyProviderOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface EastmoneyTrendsPayload {
  data?: {
    preClose?: number;
    prePrice?: number;
    trends?: string[];
  };
}

/**
 * 解析东方财富 push2his trends2 2 日 1 分钟分时 JSON。
 * 严格对齐 docs/DATA_SOURCES.md §4.3 A：
 * - 统一使用 f53（收盘价，index 2）作为分钟价格（历史日 f52 开盘价可能为 0.00）
 * - f56 为单分钟增量成交量（手 → ×100 转股），f57 为单分钟增量成交额（元，×1），需前缀累加得到 cumVolume / cumTurnover
 * - 09:30 记录为开盘集合竞价锚点，并计入当日累计前缀（与腾讯及实时快照口径完全一致）
 * - 缺失分钟绝不补零
 */
export function parseEastmoneyIntradayResponse(
  payload: unknown,
  symbol: string,
  days = 2
): IntradayDayData[] {
  const data = (payload as EastmoneyTrendsPayload)?.data;
  const trends = data?.trends;
  if (!Array.isArray(trends) || trends.length === 0) {
    return [];
  }

  const byDate = new Map<string, string[]>();
  for (const row of trends) {
    const dt = String(row).split(',')[0] ?? '';
    const [rawDate] = dt.trim().split(/\s+/);
    const tradeDate = normalizeDateStr(rawDate ?? '');
    if (!tradeDate) continue;
    const list = byDate.get(tradeDate) ?? [];
    list.push(String(row));
    byDate.set(tradeDate, list);
  }

  const upperSymbol = symbol.toUpperCase();
  const prevCloseNum = parseStrictFiniteNumber(data?.preClose ?? data?.prePrice);
  const latestDayPrevClose =
    Number.isFinite(prevCloseNum) && prevCloseNum > 0 ? prevCloseNum : null;

  const result: IntradayDayData[] = [];
  const sortedDates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));

  for (let dateIdx = 0; dateIdx < sortedDates.length; dateIdx++) {
    const tradeDate = sortedDates[dateIdx];
    const rows = byDate.get(tradeDate) ?? [];
    let auction: { openPrice: number; auctionTurnover: number } | null = null;
    let runningCumVolume = 0;
    let runningCumTurnover = 0;
    const bars: IntradayBarRow[] = [];
    const seenIndices = new Set<number>();

    for (const row of rows) {
      const parts = row.split(',');
      if (parts.length < 7) continue;
      const [, timeStr] = (parts[0] ?? '').trim().split(/\s+/);
      if (!timeStr) continue;

      const price = parseStrictFiniteNumber(parts[2]); // f53 收盘/当前价
      const barVolHands = parseStrictFiniteNumber(parts[5]); // f56 单分钟成交量（手）
      const barTurnover = parseStrictFiniteNumber(parts[6]); // f57 单分钟成交额（元）

      if (
        !Number.isFinite(price) ||
        !Number.isFinite(barVolHands) ||
        !Number.isFinite(barTurnover) ||
        barTurnover < 0
      ) {
        continue;
      }

      const barVolShares = Math.max(0, barVolHands) * 100;

      if (timeStr === '09:30') {
        auction = { openPrice: price, auctionTurnover: barTurnover };
        runningCumVolume += barVolShares;
        runningCumTurnover += barTurnover;
        continue;
      }

      const minuteIndex = upstreamMinuteLabelToIndex(timeStr);
      if (minuteIndex === null || seenIndices.has(minuteIndex)) {
        continue;
      }
      seenIndices.add(minuteIndex);

      runningCumVolume += barVolShares;
      runningCumTurnover += barTurnover;

      bars.push({
        symbol: upperSymbol,
        tradeDate,
        minuteIndex,
        minuteStr: minuteIndexToLabel(minuteIndex),
        price,
        cumVolume: runningCumVolume,
        cumTurnover: runningCumTurnover,
        barTurnover,
        source: 'eastmoney',
      });
    }

    bars.sort((a, b) => a.minuteIndex - b.minuteIndex);
    // 东财 trends2 顶层 data.preClose 仅代表最新交易日的昨收，不可广播赋给更早的历史日期
    const prevClose = dateIdx === sortedDates.length - 1 ? latestDayPrevClose : null;
    result.push({
      symbol: upperSymbol,
      tradeDate,
      prevClose,
      auction,
      bars,
      source: 'eastmoney',
    });
  }

  result.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
  return result.slice(0, Math.max(1, days));
}

interface EastmoneySnapshotPayload {
  data?: {
    diff?: Array<{
      f2?: number;
      f3?: number;
      f4?: number;
      f5?: number;
      f6?: number;
      f12?: string;
      f13?: number;
      f14?: string;
      f15?: number;
      f16?: number;
      f17?: number;
      f18?: number;
      f124?: number;
    }>;
  };
}

/**
 * 解析东方财富 push2 批量快照 JSON（仅作低频降级，严禁用于 3s 高频主轮询）。
 */
export function parseEastmoneySnapshotResponse(payload: unknown): Map<string, QuoteSnapshot> {
  const diff = (payload as EastmoneySnapshotPayload)?.data?.diff;
  const result = new Map<string, QuoteSnapshot>();
  if (!Array.isArray(diff)) return result;

  for (const d of diff) {
    const exchange = d.f13 === 1 ? 'SH' : d.f13 === 0 ? 'SZ' : null;
    if (!exchange || !d.f12) continue;
    const symbol = `${d.f12}.${exchange}`;
    const price = parseStrictFiniteNumber(d.f2);
    const turnover = parseStrictFiniteNumber(d.f6);
    const timestampSec = parseStrictFiniteNumber(d.f124);
    if (
      !Number.isFinite(price) ||
      !Number.isFinite(turnover) ||
      turnover < 0 ||
      !Number.isFinite(timestampSec) ||
      timestampSec <= 0
    ) {
      continue;
    }

    const timestampMs = timestampSec * 1000;
    const { dateStr: tradeDate } = getShanghaiParts(timestampMs);
    const volHands = parseStrictFiniteNumber(d.f5);
    const prevCloseVal = parseStrictFiniteNumber(d.f18);
    const openVal = parseStrictFiniteNumber(d.f17);
    const highVal = parseStrictFiniteNumber(d.f15);
    const lowVal = parseStrictFiniteNumber(d.f16);
    const changeAmtVal = parseStrictFiniteNumber(d.f4);
    const changePctVal = parseStrictFiniteNumber(d.f3);

    result.set(symbol, {
      symbol,
      name: d.f14?.trim() || symbol,
      price,
      prevClose: Number.isFinite(prevCloseVal) ? prevCloseVal : 0,
      open: Number.isFinite(openVal) ? openVal : price,
      high: Number.isFinite(highVal) ? highVal : price,
      low: Number.isFinite(lowVal) ? lowVal : price,
      changeAmt: Number.isFinite(changeAmtVal) ? changeAmtVal : 0,
      changePct: Number.isFinite(changePctVal) ? changePctVal : 0,
      volumeShares: Number.isFinite(volHands) && volHands >= 0 ? volHands * 100 : 0,
      turnover,
      tradeDate,
      timestampMs,
      source: 'eastmoney',
    });
  }

  return result;
}

interface EastmoneySuggestPayload {
  QuotationCodeTable?: {
    Data?: Array<{
      Code?: string;
      Name?: string;
      MktNum?: string;
      Classify?: string;
      SecurityTypeName?: string;
    }>;
  };
}

/** 解析东方财富搜索联想 JSON */
export function parseEastmoneySearchResponse(payload: unknown, limit = 10): TickerSearchResult[] {
  const rows = (payload as EastmoneySuggestPayload)?.QuotationCodeTable?.Data;
  if (!Array.isArray(rows)) return [];

  const results: TickerSearchResult[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const mkt = String(row.MktNum ?? '');
    const ticker = String(row.Code ?? '').trim();
    if ((mkt !== '0' && mkt !== '1') || !/^\d{6}$/.test(ticker)) continue;

    const exchange = mkt === '1' ? 'SH' : 'SZ';
    const symbol = `${ticker}.${exchange}`;
    if (seen.has(symbol)) continue;

    const typeName = String(row.SecurityTypeName ?? '');
    const classify = String(row.Classify ?? '');
    const isIndex = classify === 'Index' || typeName.includes('指数');
    const isStock = classify === 'AStock' || typeName.includes('A') || typeName.includes('股');
    if (!isIndex && !isStock) continue;

    seen.add(symbol);
    results.push({
      symbol,
      ticker,
      name: String(row.Name ?? '').trim() || symbol,
      exchange,
      assetType: isIndex ? 'INDEX' : 'STOCK',
      source: 'eastmoney',
    });
    if (results.length >= limit) break;
  }

  return results;
}

/** 第一备用分时源兼搜索兜底：东方财富（push2his trends2 + searchapi） */
export class EastmoneyProvider implements MarketDataProvider {
  readonly id = 'eastmoney' as const;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: EastmoneyProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async fetchIntradayMinutes(symbol: string, days = 2): Promise<IntradayDayData[]> {
    const secid = toEastmoneySecid(symbol);
    const ndays = Math.max(1, Math.min(5, days));
    const url =
      'https://push2his.eastmoney.com/api/qt/stock/trends2/get' +
      '?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
      '&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
      `&ndays=${ndays}&iscr=1&secid=${secid}`;

    const res = await fetchBufferWithTimeout({
      provider: this.id,
      url,
      headers: { Referer: EASTMONEY_REFERER },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });

    let json: unknown;
    try {
      json = JSON.parse(res.buffer.toString('utf8'));
    } catch {
      throw new ProviderRequestError({
        provider: this.id,
        message: 'Invalid JSON in trends2 response',
        httpStatus: res.status,
        retryable: true,
      });
    }

    const parsed = parseEastmoneyIntradayResponse(json, symbol, days);
    if (parsed.length === 0) {
      throw new ProviderRequestError({
        provider: this.id,
        message: `No trends2 data returned for ${symbol}`,
        httpStatus: res.status,
        retryable: true,
      });
    }
    return parsed;
  }

  async fetchBatchSnapshots(symbols: readonly string[]): Promise<Map<string, QuoteSnapshot>> {
    const chunks = chunkSymbols(symbols);
    const merged = new Map<string, QuoteSnapshot>();

    for (const chunk of chunks) {
      const secids = chunk.map((s) => toEastmoneySecid(s)).join(',');
      const url =
        'https://push2.eastmoney.com/api/qt/ulist.np/get' +
        `?fltt=2&invt=2&fields=f1,f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f124&secids=${secids}`;
      const res = await fetchBufferWithTimeout({
        provider: this.id,
        url,
        headers: { Referer: EASTMONEY_REFERER },
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });

      let json: unknown;
      try {
        json = JSON.parse(res.buffer.toString('utf8'));
      } catch {
        throw new ProviderRequestError({
          provider: this.id,
          message: 'Invalid JSON in ulist snapshot response',
          httpStatus: res.status,
          retryable: true,
        });
      }

      const parsed = parseEastmoneySnapshotResponse(json);
      if (parsed.size === 0) {
        throw new ProviderRequestError({
          provider: this.id,
          message: 'Empty snapshot payload returned',
          httpStatus: res.status,
          retryable: true,
        });
      }
      for (const [sym, snap] of parsed) {
        merged.set(sym, snap);
      }
    }

    return merged;
  }

  async searchTickers(keyword: string, limit = 10): Promise<TickerSearchResult[]> {
    const trimmed = keyword.trim();
    if (!trimmed) return [];

    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(trimmed)}&type=14&count=${limit}`;
    const res = await fetchBufferWithTimeout({
      provider: this.id,
      url,
      headers: { Referer: EASTMONEY_REFERER },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });

    let json: unknown;
    try {
      json = JSON.parse(res.buffer.toString('utf8'));
    } catch {
      return [];
    }

    return parseEastmoneySearchResponse(json, limit);
  }

  async healthCheck(): Promise<ProviderHealthStatus> {
    const startedAt = performance.now();
    try {
      const days = await this.fetchIntradayMinutes('000001.SH', 1);
      const latencyMs = Math.round((performance.now() - startedAt) * 10) / 10;
      const ok = days.length > 0;
      return {
        provider: this.id,
        ok,
        latencyMs,
        error: ok ? null : 'Empty trends2 health check response',
      };
    } catch (err) {
      const latencyMs = Math.round((performance.now() - startedAt) * 10) / 10;
      return {
        provider: this.id,
        ok: false,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
