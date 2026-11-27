import { minuteIndexToLabel, upstreamMinuteLabelToIndex } from '../../core/tradingClock';
import type {
  IntradayBarRow,
  IntradayDayData,
  ProviderHealthStatus,
  QuoteSnapshot,
  TickerSearchResult,
} from '../../shared/types';
import {
  chunkSymbols,
  decodeGb18030,
  fetchBufferWithTimeout,
  normalizeDateStr,
  parseCompactShanghaiTimestamp,
  parseStrictFiniteNumber,
  toTxSinaCode,
} from './http';
import { ProviderRequestError, type FetchLike, type MarketDataProvider } from './types';

const TENCENT_REFERER = 'https://gu.qq.com/';

export interface TencentProviderOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function unescapeUnicode(raw: string): string {
  return raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

/**
 * 解析腾讯批量实时快照响应（GB18030 解码后的文本）。
 * 严格对齐 docs/DATA_SOURCES.md §4.1 A：
 * - 成交额首选 parts[35] 第三段（精确到元，×1），缺失时回退 parts[37] × 10000（万元 → 元）
 * - 成交量 parts[6] 为手，统一 × 100 转为股
 */
export function parseTencentSnapshotResponse(text: string): Map<string, QuoteSnapshot> {
  const result = new Map<string, QuoteSnapshot>();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^v_(sh|sz)(\d{6})="(.+)";?$/);
    if (!match) continue;

    const symbol = `${match[2]}.${match[1].toUpperCase()}`;
    const parts = match[3].split('~');
    if (parts.length < 38) continue;

    const name = parts[1]?.trim() || symbol;
    const price = parseStrictFiniteNumber(parts[3]);
    const prevClose = parseStrictFiniteNumber(parts[4]);
    const open = parseStrictFiniteNumber(parts[5]);
    const volumeHands = parseStrictFiniteNumber(parts[6]);
    const changeAmt = parseStrictFiniteNumber(parts[31]);
    const changePct = parseStrictFiniteNumber(parts[32]);
    const high = parseStrictFiniteNumber(parts[33]);
    const low = parseStrictFiniteNumber(parts[34]);

    const f35Parts = (parts[35] ?? '').split('/');
    const f35Yuan =
      f35Parts.length >= 3 ? parseStrictFiniteNumber(f35Parts[2]) : Number.NaN;
    const f37Wan = parseStrictFiniteNumber(parts[37]);
    const turnover = Number.isFinite(f35Yuan)
      ? f35Yuan
      : Number.isFinite(f37Wan)
        ? f37Wan * 10_000
        : Number.NaN;

    const parsedTime = parseCompactShanghaiTimestamp(parts[30] ?? '');
    if (
      !parsedTime ||
      !Number.isFinite(price) ||
      !Number.isFinite(turnover) ||
      turnover < 0
    ) {
      continue;
    }

    result.set(symbol, {
      symbol,
      name,
      price,
      prevClose: Number.isFinite(prevClose) ? prevClose : 0,
      open: Number.isFinite(open) ? open : price,
      high: Number.isFinite(high) ? high : price,
      low: Number.isFinite(low) ? low : price,
      changeAmt: Number.isFinite(changeAmt) ? changeAmt : 0,
      changePct: Number.isFinite(changePct) ? changePct : 0,
      volumeShares: Number.isFinite(volumeHands) && volumeHands >= 0 ? volumeHands * 100 : 0,
      turnover,
      tradeDate: parsedTime.tradeDate,
      timestampMs: parsedTime.timestampMs,
      source: 'tencent',
    });
  }

  return result;
}

interface TencentDayQueryPayload {
  data?: Record<
    string,
    {
      data?: Array<{
        date?: string;
        prec?: string | number;
        data?: string[];
      }>;
    }
  >;
}

/**
 * 解析腾讯 day/query 5 日 1 分钟分时 JSON。
 * 严格执行 docs/DATA_SOURCES.md §3 & §4.1 B 清洗规则：
 * - 0930 → 写入 auction 锚点，不进入连续竞价 bars
 * - 1300 → 丢弃（午休重复锚点）
 * - >1500 → 丢弃（沪深个股盘后定价交易）
 * - 仅保留 0931..1130 (0..119) 与 1301..1500 (120..239)，缺失分钟绝不补零
 */
export function parseTencentIntradayResponse(
  payload: unknown,
  symbol: string,
  days = 2
): IntradayDayData[] {
  const txCode = toTxSinaCode(symbol);
  const rawDays = (payload as TencentDayQueryPayload)?.data?.[txCode]?.data;
  if (!Array.isArray(rawDays) || rawDays.length === 0) {
    return [];
  }

  const normalizedDays: IntradayDayData[] = [];

  for (const dayEntry of rawDays) {
    const tradeDate = normalizeDateStr(String(dayEntry.date ?? ''));
    if (!tradeDate || !Array.isArray(dayEntry.data)) continue;

    const prevCloseNum = parseStrictFiniteNumber(dayEntry.prec);
    const prevClose = Number.isFinite(prevCloseNum) && prevCloseNum > 0 ? prevCloseNum : null;

    let auction: { openPrice: number; auctionTurnover: number } | null = null;
    const rawEntries: Array<{
      minuteIndex: number;
      price: number;
      cumVolHands: number;
      cumTurnover: number;
    }> = [];
    const seenIndices = new Set<number>();

    for (const row of dayEntry.data) {
      const cols = String(row).trim().split(/\s+/);
      if (cols.length < 4) continue;
      const hhmm = cols[0];
      const price = parseStrictFiniteNumber(cols[1]);
      const cumVolHands = parseStrictFiniteNumber(cols[2]);
      const cumTurnover = parseStrictFiniteNumber(cols[3]);

      if (
        !Number.isFinite(price) ||
        !Number.isFinite(cumVolHands) ||
        !Number.isFinite(cumTurnover) ||
        cumTurnover < 0
      ) {
        continue;
      }

      if (hhmm === '0930') {
        auction = { openPrice: price, auctionTurnover: cumTurnover };
        continue;
      }
      if (hhmm === '1300' || hhmm > '1500') {
        continue;
      }

      const minuteIndex = upstreamMinuteLabelToIndex(hhmm);
      if (minuteIndex === null || seenIndices.has(minuteIndex)) {
        continue;
      }
      seenIndices.add(minuteIndex);
      rawEntries.push({ minuteIndex, price, cumVolHands, cumTurnover });
    }

    // 先按 minuteIndex 升序排列后再差分计算单分钟增量，防止上游乱序导致 barTurnover 错算
    rawEntries.sort((a, b) => a.minuteIndex - b.minuteIndex);

    const bars: IntradayBarRow[] = [];
    for (const entry of rawEntries) {
      const prevBar = bars.length > 0 ? bars[bars.length - 1] : null;
      let barTurnover: number;
      if (prevBar) {
        barTurnover = Math.max(0, entry.cumTurnover - prevBar.cumTurnover);
      } else if (entry.minuteIndex === 0 && auction) {
        barTurnover = Math.max(0, entry.cumTurnover - auction.auctionTurnover);
      } else {
        barTurnover = entry.cumTurnover;
      }

      bars.push({
        symbol: symbol.toUpperCase(),
        tradeDate,
        minuteIndex: entry.minuteIndex,
        minuteStr: minuteIndexToLabel(entry.minuteIndex),
        price: entry.price,
        cumVolume: Math.max(0, entry.cumVolHands) * 100,
        cumTurnover: entry.cumTurnover,
        barTurnover,
        source: 'tencent',
      });
    }

    normalizedDays.push({
      symbol: symbol.toUpperCase(),
      tradeDate,
      prevClose,
      auction,
      bars,
      source: 'tencent',
    });
  }

  // 按日期倒序（[0] 最新交易日，[1] 上一交易日）截取所需天数
  normalizedDays.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
  return normalizedDays.slice(0, Math.max(1, days));
}

/**
 * 解析腾讯 smartbox 搜索联想响应。
 */
export function parseTencentSearchResponse(text: string, limit = 10): TickerSearchResult[] {
  const match = text.match(/v_hint="([^"]*)"/);
  if (!match || !match[1]) return [];

  const results: TickerSearchResult[] = [];
  const seen = new Set<string>();
  const rows = match[1].split('^');

  for (const row of rows) {
    const parts = row.split('~');
    if (parts.length < 5) continue;
    const market = parts[0].toLowerCase();
    const ticker = parts[1].trim();
    const name = unescapeUnicode(parts[2] ?? '').trim();
    const typeTag = (parts[4] ?? '').toUpperCase();

    if ((market !== 'sh' && market !== 'sz') || !/^\d{6}$/.test(ticker)) continue;
    const isStock = typeTag.includes('GP-A');
    const isIndex = typeTag.includes('ZS');
    if (!isStock && !isIndex) continue;

    const exchange = market === 'sh' ? 'SH' : 'SZ';
    const symbol = `${ticker}.${exchange}`;
    if (seen.has(symbol)) continue;
    seen.add(symbol);

    results.push({
      symbol,
      ticker,
      name: name || symbol,
      exchange,
      assetType: isIndex ? 'INDEX' : 'STOCK',
      source: 'tencent',
    });
    if (results.length >= limit) break;
  }

  return results;
}

/** 主公开源适配器：腾讯财经（高频批量快照 + 5日1分钟分时 + 搜索兜底） */
export class TencentProvider implements MarketDataProvider {
  readonly id = 'tencent' as const;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: TencentProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async fetchBatchSnapshots(symbols: readonly string[]): Promise<Map<string, QuoteSnapshot>> {
    const chunks = chunkSymbols(symbols);
    const merged = new Map<string, QuoteSnapshot>();

    for (const chunk of chunks) {
      const codes = chunk.map((s) => toTxSinaCode(s)).join(',');
      const url = `https://qt.gtimg.cn/q=${codes}`;
      const res = await fetchBufferWithTimeout({
        provider: this.id,
        url,
        headers: { Referer: TENCENT_REFERER },
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });

      const decoded = decodeGb18030(res.buffer);
      const parsed = parseTencentSnapshotResponse(decoded);
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

  async fetchIntradayMinutes(symbol: string, days = 2): Promise<IntradayDayData[]> {
    const txCode = toTxSinaCode(symbol);
    const url = `https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${txCode}`;
    const res = await fetchBufferWithTimeout({
      provider: this.id,
      url,
      headers: { Referer: TENCENT_REFERER },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });

    let json: unknown;
    try {
      json = JSON.parse(res.buffer.toString('utf8'));
    } catch {
      throw new ProviderRequestError({
        provider: this.id,
        message: 'Invalid JSON in day/query response',
        httpStatus: res.status,
        retryable: true,
      });
    }

    const parsed = parseTencentIntradayResponse(json, symbol, days);
    if (parsed.length === 0) {
      throw new ProviderRequestError({
        provider: this.id,
        message: `No intraday data returned for ${symbol}`,
        httpStatus: res.status,
        retryable: true,
      });
    }
    return parsed;
  }

  async searchTickers(keyword: string, limit = 10): Promise<TickerSearchResult[]> {
    const trimmed = keyword.trim();
    if (!trimmed) return [];

    const url = `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(trimmed)}&t=all`;
    const res = await fetchBufferWithTimeout({
      provider: this.id,
      url,
      headers: { Referer: TENCENT_REFERER },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });

    return parseTencentSearchResponse(decodeGb18030(res.buffer), limit);
  }

  async healthCheck(): Promise<ProviderHealthStatus> {
    const startedAt = performance.now();
    try {
      const snaps = await this.fetchBatchSnapshots(['000001.SH']);
      const latencyMs = Math.round((performance.now() - startedAt) * 10) / 10;
      const ok = snaps.has('000001.SH');
      return {
        provider: this.id,
        ok,
        latencyMs,
        error: ok ? null : 'Missing 000001.SH in health check response',
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
