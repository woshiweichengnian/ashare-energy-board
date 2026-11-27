import { shanghaiToTimestampMs } from '../../core/tradingClock';
import { MAX_BATCH_SNAPSHOT_SYMBOLS } from '../../shared/constants';
import type { ProviderId } from '../../shared/types';
import { ProviderRequestError, type FetchLike } from './types';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface TimedFetchResult {
  readonly status: number;
  readonly buffer: Buffer;
  readonly latencyMs: number;
}

/** 带超时的 GET 请求封装，自动分类 403/429 限流与 5xx 可重试错误 */
export async function fetchBufferWithTimeout(params: {
  provider: ProviderId;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<TimedFetchResult> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const timeoutMs = params.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetchFn(params.url, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        ...(params.headers ?? {}),
      },
      signal: controller.signal,
    });
    const arrayBuf = await response.arrayBuffer();
    const latencyMs = Math.round((performance.now() - startedAt) * 10) / 10;

    if (!response.ok) {
      const rateLimited = response.status === 429 || response.status === 403;
      const retryable = rateLimited || response.status >= 500;
      throw new ProviderRequestError({
        provider: params.provider,
        message: `HTTP ${response.status}`,
        httpStatus: response.status,
        rateLimited,
        retryable,
      });
    }

    return {
      status: response.status,
      buffer: Buffer.from(arrayBuf),
      latencyMs,
    };
  } catch (err) {
    if (err instanceof ProviderRequestError) {
      throw err;
    }
    const reason =
      err instanceof Error
        ? (err.cause as { code?: string } | undefined)?.code || err.name || err.message
        : String(err);
    throw new ProviderRequestError({
      provider: params.provider,
      message: `Network request failed: ${reason}`,
      httpStatus: 0,
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function decodeGb18030(buf: Buffer): string {
  return new TextDecoder('gb18030').decode(buf);
}

/**
 * 严格解析有限数值，拒绝空字符串、纯空白、null、undefined 与非数字，
 * 防止 JS `Number('') === 0` / `Number(null) === 0` 将缺失成交额或价格静默补零。
 */
export function parseStrictFiniteNumber(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : Number.NaN;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return Number.NaN;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : Number.NaN;
  }
  return Number.NaN;
}

/** 000001.SH -> sh000001; 399106.SZ -> sz399106 */
export function toTxSinaCode(thscode: string): string {
  const match = thscode.trim().toUpperCase().match(/^(\d{6})\.(SH|SZ)$/);
  if (!match) {
    throw new RangeError(`Unsupported A-share thscode: ${thscode}`);
  }
  return `${match[2].toLowerCase()}${match[1]}`;
}

/** sh000001 -> 000001.SH; sz399106 -> 399106.SZ */
export function fromTxSinaCode(code: string): string | null {
  const match = code.trim().toLowerCase().match(/^(sh|sz)(\d{6})$/);
  if (!match) return null;
  return `${match[2]}.${match[1].toUpperCase()}`;
}

/** 000001.SH -> 1.000001; 399106.SZ -> 0.399106 */
export function toEastmoneySecid(thscode: string): string {
  const match = thscode.trim().toUpperCase().match(/^(\d{6})\.(SH|SZ)$/);
  if (!match) {
    throw new RangeError(`Unsupported A-share thscode: ${thscode}`);
  }
  const marketPrefix = match[2] === 'SH' ? '1' : '0';
  return `${marketPrefix}.${match[1]}`;
}

/** 判断标准 thscode 是否为指数（沪市 000xxx.SH 或深市 399xxx.SZ） */
export function isIndexThscode(thscode: string): boolean {
  const upper = thscode.trim().toUpperCase();
  return /^000\d{3}\.SH$/.test(upper) || /^399\d{3}\.SZ$/.test(upper);
}

/** 判断是否为沪市指数（新浪接口对沪市指数成交量单位为“手”，其余为“股”） */
export function isShanghaiIndexThscode(thscode: string): boolean {
  return /^000\d{3}\.SH$/.test(thscode.trim().toUpperCase());
}

/** 将 YYYYMMDD 或 YYYY-MM-DD 统一标准化为 YYYY-MM-DD */
export function normalizeDateStr(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const compact = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }
  return null;
}

/** 将腾讯 14 位时间戳 yyyyMMddHHmmss 解析为北京时间日期与毫秒时间戳 */
export function parseCompactShanghaiTimestamp(raw: string): {
  tradeDate: string;
  timestampMs: number;
} | null {
  const match = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const tradeDate = `${match[1]}-${match[2]}-${match[3]}`;
  const timestampMs = shanghaiToTimestampMs(
    tradeDate,
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
  return { tradeDate, timestampMs };
}

/** 将 YYYY-MM-DD 与 HH:mm:ss 解析为北京时间毫秒时间戳 */
export function parseSplitShanghaiTimestamp(
  dateStr: string,
  timeStr: string
): { tradeDate: string; timestampMs: number } | null {
  const normalized = normalizeDateStr(dateStr);
  const timeMatch = timeStr.trim().match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!normalized || !timeMatch) return null;
  const timestampMs = shanghaiToTimestampMs(
    normalized,
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3])
  );
  return { tradeDate: normalized, timestampMs };
}

/** 按最大单批数量切分并去重标的列表 */
export function chunkSymbols(
  symbols: readonly string[],
  maxBatchSize = MAX_BATCH_SNAPSHOT_SYMBOLS
): string[][] {
  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += maxBatchSize) {
    chunks.push(unique.slice(i, i + maxBatchSize));
  }
  return chunks;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
