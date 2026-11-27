import { getShanghaiParts } from '../../core/tradingClock';
import { MONITORED_INDEX_NAMES } from '../../shared/constants';
import type {
  IntradayDayData,
  ProviderHealthStatus,
  QuoteSnapshot,
  TickerSearchResult,
  TradingDayRow,
} from '../../shared/types';
import type { SecretStore } from '../storage/secretStore';
import {
  chunkSymbols,
  defaultSleep,
  fetchBufferWithTimeout,
  isIndexThscode,
  normalizeDateStr,
  parseStrictFiniteNumber,
} from './http';
import {
  ProviderRequestError,
  type FetchLike,
  type MarketDataProvider,
  type SleepLike,
} from './types';

const DEFAULT_HITHINK_BASE_URL = 'https://fuyao.aicubes.cn';
const HITHINK_MAX_RETRIES = 3;
const HITHINK_INITIAL_BACKOFF_MS = 500;

export interface HithinkProviderOptions {
  secretStore: Pick<SecretStore, 'getApiKey'>;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  sleepImpl?: SleepLike;
  timeoutMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  nowFn?: () => number;
}

interface HithinkEnvelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

interface HithinkCalendarData {
  item?: Array<{
    date?: string;
    date_ms?: number;
  }>;
}

interface HithinkSearchData {
  item?: Array<{
    thscode?: string;
    ticker?: string;
    name?: string;
    exchange?: string;
    asset_type?: string;
  }>;
}

interface HithinkSnapshotItem {
  thscode?: string;
  last_price?: number | string;
  price_change_ratio_pct?: number | string;
  price_change?: number | string;
  prev_close?: number | string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  volume?: number | string;
  turnover?: number | string;
  timestamp?: number | string;
}

interface HithinkSnapshotData {
  timestamp?: number | string;
  item?: HithinkSnapshotItem[];
}

function parseHithinkTimestampMs(raw: unknown, fallbackMs: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1e12 ? asNum * 1000 : asNum;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallbackMs;
}

/** 解析同花顺交易日历 data.item[] */
export function parseHithinkTradingDays(data: unknown): TradingDayRow[] {
  const items = (data as HithinkCalendarData)?.item;
  if (!Array.isArray(items)) return [];

  const result: TradingDayRow[] = [];
  const seen = new Set<string>();
  for (const entry of items) {
    const date = normalizeDateStr(String(entry.date ?? ''));
    if (!date || seen.has(date)) continue;
    seen.add(date);
    result.push({ date, isOpen: true });
  }
  result.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

/** 解析同花顺标的搜索 data.item[] */
export function parseHithinkSearchResults(data: unknown, limit = 10): TickerSearchResult[] {
  const items = (data as HithinkSearchData)?.item;
  if (!Array.isArray(items)) return [];

  const results: TickerSearchResult[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const rawCode = String(item.thscode ?? '').trim().toUpperCase();
    const match = rawCode.match(/^(\d{6})\.(SH|SZ)$/);
    if (!match) continue;
    if (seen.has(rawCode)) continue;
    seen.add(rawCode);

    const assetRaw = String(item.asset_type ?? '').toLowerCase();
    const assetType: 'STOCK' | 'INDEX' =
      assetRaw.includes('index') || isIndexThscode(rawCode) ? 'INDEX' : 'STOCK';

    results.push({
      symbol: rawCode,
      ticker: match[1],
      name: String(item.name ?? '').trim() || rawCode,
      exchange: match[2] as 'SH' | 'SZ',
      assetType,
      source: 'hithink',
    });
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * 解析同花顺指数/个股快照 data.item[]。
 * 依据 docs/DATA_SOURCES.md §4.4：
 * - volume 已为股（×1），turnover 为元（×1）
 * - 不返回中文名 name，由 nameLookup / MONITORED_INDEX_NAMES 补全
 */
export function parseHithinkSnapshotData(
  data: unknown,
  fallbackNowMs: number,
  nameLookup?: ReadonlyMap<string, string>
): Map<string, QuoteSnapshot> {
  const payload = data as HithinkSnapshotData | undefined;
  const items = payload?.item;
  const result = new Map<string, QuoteSnapshot>();
  if (!Array.isArray(items)) return result;

  const batchTs = parseHithinkTimestampMs(payload?.timestamp, fallbackNowMs);

  for (const item of items) {
    const symbol = String(item.thscode ?? '').trim().toUpperCase();
    if (!/^\d{6}\.(SH|SZ)$/.test(symbol)) continue;

    const price = parseStrictFiniteNumber(item.last_price);
    const turnover = parseStrictFiniteNumber(item.turnover);
    if (!Number.isFinite(price) || !Number.isFinite(turnover) || turnover < 0) continue;

    const changePct = parseStrictFiniteNumber(item.price_change_ratio_pct);
    const prevCloseRaw = parseStrictFiniteNumber(item.prev_close);
    const prevClose =
      Number.isFinite(prevCloseRaw) && prevCloseRaw > 0
        ? prevCloseRaw
        : Number.isFinite(changePct) && changePct !== -100
          ? price / (1 + changePct / 100)
          : 0;
    const changeAmtRaw = parseStrictFiniteNumber(item.price_change);
    const changeAmt = Number.isFinite(changeAmtRaw)
      ? changeAmtRaw
      : prevClose > 0
        ? Math.round((price - prevClose) * 10_000) / 10_000
        : 0;

    const volumeShares = parseStrictFiniteNumber(item.volume);
    const openVal = parseStrictFiniteNumber(item.open);
    const highVal = parseStrictFiniteNumber(item.high);
    const lowVal = parseStrictFiniteNumber(item.low);
    const timestampMs = parseHithinkTimestampMs(item.timestamp, batchTs);
    const { dateStr: tradeDate } = getShanghaiParts(timestampMs);

    result.set(symbol, {
      symbol,
      name: nameLookup?.get(symbol) ?? MONITORED_INDEX_NAMES[symbol] ?? symbol,
      price,
      prevClose,
      open: Number.isFinite(openVal) ? openVal : price,
      high: Number.isFinite(highVal) ? highVal : price,
      low: Number.isFinite(lowVal) ? lowVal : price,
      changeAmt,
      changePct: Number.isFinite(changePct) ? changePct : 0,
      volumeShares: Number.isFinite(volumeShares) && volumeShares >= 0 ? volumeShares : 0,
      turnover,
      tradeDate,
      timestampMs,
      source: 'hithink',
    });
  }

  return result;
}

/**
 * 同花顺 Fuyao API 权威辅助适配器：
 * - 每日缓存一次交易日历
 * - 按需标的搜索消歧
 * - 公开源全部失效时的低频兜底快照（≥15s，严禁秒级高频轮询）
 * - 遇 code=4001 / 5xxx / HTTP 429 严格指数退避，最多重试 3 次
 * - Key 仅通过 X-api-key 请求头发送，绝不进入 URL、日志或异常消息
 */
export class HithinkProvider implements MarketDataProvider {
  readonly id = 'hithink' as const;
  private readonly secretStore: Pick<SecretStore, 'getApiKey'>;
  private readonly baseUrl: string;
  private readonly fetchImpl?: FetchLike;
  private readonly sleepImpl: SleepLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly nowFn: () => number;

  constructor(options: HithinkProviderOptions) {
    this.secretStore = options.secretStore;
    this.baseUrl = (options.baseUrl ?? DEFAULT_HITHINK_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? HITHINK_MAX_RETRIES;
    this.initialBackoffMs = options.initialBackoffMs ?? HITHINK_INITIAL_BACKOFF_MS;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return this.secretStore.getApiKey() !== null;
  }

  private async requestJson<T>(endpoint: string): Promise<T> {
    const apiKey = this.secretStore.getApiKey();
    if (!apiKey) {
      throw new ProviderRequestError({
        provider: this.id,
        message: 'Hithink API Key is not configured',
        httpStatus: 0,
        retryable: false,
      });
    }

    const url = `${this.baseUrl}${endpoint}`;
    let lastError: ProviderRequestError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetchBufferWithTimeout({
          provider: this.id,
          url,
          headers: { 'X-api-key': apiKey },
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl,
        });

        let envelope: HithinkEnvelope<T>;
        try {
          envelope = JSON.parse(res.buffer.toString('utf8')) as HithinkEnvelope<T>;
        } catch {
          throw new ProviderRequestError({
            provider: this.id,
            message: 'Invalid JSON envelope returned by Fuyao API',
            httpStatus: res.status,
            retryable: true,
          });
        }

        if (envelope.code === 0 && envelope.data !== undefined) {
          return envelope.data;
        }

        const apiCode = typeof envelope.code === 'number' ? envelope.code : null;
        const rateLimited = apiCode === 4001;
        const retryable = rateLimited || (apiCode !== null && apiCode >= 5000);
        throw new ProviderRequestError({
          provider: this.id,
          message: `Fuyao API error code=${String(apiCode)}: ${envelope.message ?? 'unknown'}`,
          httpStatus: res.status,
          apiCode,
          rateLimited,
          retryable,
        });
      } catch (err) {
        const providerErr =
          err instanceof ProviderRequestError
            ? err
            : new ProviderRequestError({
                provider: this.id,
                message: 'Unexpected request error',
                retryable: false,
              });
        lastError = providerErr;

        if (!providerErr.retryable || attempt >= this.maxRetries) {
          throw providerErr;
        }

        const delayMs = this.initialBackoffMs * 2 ** attempt;
        await this.sleepImpl(delayMs);
      }
    }

    throw lastError ?? new ProviderRequestError({ provider: this.id, message: 'Request failed' });
  }

  async fetchTradingDays(): Promise<TradingDayRow[]> {
    const data = await this.requestJson<HithinkCalendarData>('/api/a-share/calendar/trading-days');
    return parseHithinkTradingDays(data);
  }

  async searchTickers(keyword: string, limit = 10): Promise<TickerSearchResult[]> {
    const trimmed = keyword.trim();
    if (!trimmed) return [];

    const data = await this.requestJson<HithinkSearchData>(
      `/api/meta/tickers/search?q=${encodeURIComponent(trimmed)}&limit=${limit}`
    );
    return parseHithinkSearchResults(data, limit);
  }

  async fetchBatchSnapshots(
    symbols: readonly string[],
    nameLookup?: ReadonlyMap<string, string>
  ): Promise<Map<string, QuoteSnapshot>> {
    const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const indexSymbols = unique.filter((s) => isIndexThscode(s));
    const stockSymbols = unique.filter((s) => !isIndexThscode(s));

    const merged = new Map<string, QuoteSnapshot>();
    const fallbackNow = this.nowFn();

    const indexChunks = chunkSymbols(indexSymbols);
    for (const chunk of indexChunks) {
      const data = await this.requestJson<HithinkSnapshotData>(
        `/api/a-share-index/prices/snapshot?thscodes=${encodeURIComponent(chunk.join(','))}`
      );
      for (const [sym, snap] of parseHithinkSnapshotData(data, fallbackNow, nameLookup)) {
        merged.set(sym, snap);
      }
    }

    const stockChunks = chunkSymbols(stockSymbols);
    for (const chunk of stockChunks) {
      const data = await this.requestJson<HithinkSnapshotData>(
        `/api/a-share/prices/snapshot?thscodes=${encodeURIComponent(chunk.join(','))}`
      );
      for (const [sym, snap] of parseHithinkSnapshotData(data, fallbackNow, nameLookup)) {
        merged.set(sym, snap);
      }
    }

    if (merged.size === 0 && unique.length > 0) {
      throw new ProviderRequestError({
        provider: this.id,
        message: 'Empty snapshot payload returned',
        retryable: true,
      });
    }

    return merged;
  }

  async fetchIntradayMinutes(_symbol: string, _days = 2): Promise<IntradayDayData[]> {
    // 同花顺 Fuyao 无历史 1 分钟分时接口（docs/PLAN.md §2.4）
    return [];
  }

  async healthCheck(): Promise<ProviderHealthStatus> {
    const startedAt = performance.now();
    if (!this.isConfigured()) {
      return {
        provider: this.id,
        ok: false,
        latencyMs: 0,
        error: 'API Key not configured',
      };
    }

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
