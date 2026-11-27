import type {
  IntradayDayData,
  ProviderHealthStatus,
  QuoteSnapshot,
  TickerSearchResult,
} from '../../shared/types';
import {
  chunkSymbols,
  decodeGb18030,
  fetchBufferWithTimeout,
  isShanghaiIndexThscode,
  parseSplitShanghaiTimestamp,
  parseStrictFiniteNumber,
  toTxSinaCode,
} from './http';
import { ProviderRequestError, type FetchLike, type MarketDataProvider } from './types';

const SINA_REFERER = 'https://finance.sina.com.cn/';

export interface SinaProviderOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * 解析新浪批量实时快照响应（GB18030 解码后的文本）。
 * 严格对齐 docs/DATA_SOURCES.md §4.2：
 * - 成交额 parts[9] 统一为人民币元（×1）
 * - 成交量 parts[8] 存在跨市场单位差异：沪市指数为手（×100 转股），深市指数及全部 A 股个股为股（×1）
 * - 涨跌额与涨跌幅由 (price - prevClose) 精确计算
 */
export function parseSinaSnapshotResponse(text: string): Map<string, QuoteSnapshot> {
  const result = new Map<string, QuoteSnapshot>();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^var hq_str_(sh|sz)(\d{6})="(.*)";?$/);
    if (!match || !match[3]) continue;

    const symbol = `${match[2]}.${match[1].toUpperCase()}`;
    const parts = match[3].split(',');
    if (parts.length < 32) continue;

    const name = parts[0]?.trim() || symbol;
    const open = parseStrictFiniteNumber(parts[1]);
    const prevClose = parseStrictFiniteNumber(parts[2]);
    const price = parseStrictFiniteNumber(parts[3]);
    const high = parseStrictFiniteNumber(parts[4]);
    const low = parseStrictFiniteNumber(parts[5]);
    const rawVolume = parseStrictFiniteNumber(parts[8]);
    const turnover = parseStrictFiniteNumber(parts[9]);
    const parsedTime = parseSplitShanghaiTimestamp(parts[30] ?? '', parts[31] ?? '');

    if (
      !parsedTime ||
      !Number.isFinite(price) ||
      !Number.isFinite(turnover) ||
      turnover < 0
    ) {
      continue;
    }

    const safePrevClose = Number.isFinite(prevClose) ? prevClose : 0;
    const changeAmt = Math.round((price - safePrevClose) * 10_000) / 10_000;
    const changePct =
      safePrevClose > 0
        ? Math.round(((price - safePrevClose) / safePrevClose) * 10_000) / 100
        : 0;

    const volumeShares =
      Number.isFinite(rawVolume) && rawVolume >= 0
        ? isShanghaiIndexThscode(symbol)
          ? rawVolume * 100
          : rawVolume
        : 0;

    result.set(symbol, {
      symbol,
      name,
      price,
      prevClose: safePrevClose,
      open: Number.isFinite(open) ? open : price,
      high: Number.isFinite(high) ? high : price,
      low: Number.isFinite(low) ? low : price,
      changeAmt,
      changePct,
      volumeShares,
      turnover,
      tradeDate: parsedTime.tradeDate,
      timestampMs: parsedTime.timestampMs,
      source: 'sina',
    });
  }

  return result;
}

/** 第一备用快照源适配器：新浪财经（高频快照故障转移，与腾讯口径 100% 一致） */
export class SinaProvider implements MarketDataProvider {
  readonly id = 'sina' as const;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: SinaProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async fetchBatchSnapshots(symbols: readonly string[]): Promise<Map<string, QuoteSnapshot>> {
    const chunks = chunkSymbols(symbols);
    const merged = new Map<string, QuoteSnapshot>();

    for (const chunk of chunks) {
      const codes = chunk.map((s) => toTxSinaCode(s)).join(',');
      const url = `https://hq.sinajs.cn/list=${codes}`;
      const res = await fetchBufferWithTimeout({
        provider: this.id,
        url,
        headers: { Referer: SINA_REFERER },
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });

      const parsed = parseSinaSnapshotResponse(decodeGb18030(res.buffer));
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

  async fetchIntradayMinutes(_symbol: string, _days = 2): Promise<IntradayDayData[]> {
    // 新浪公开接口无 1 分钟成交额分时，仅承担高频快照第一备源
    return [];
  }

  async searchTickers(_keyword: string, _limit = 10): Promise<TickerSearchResult[]> {
    return [];
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
