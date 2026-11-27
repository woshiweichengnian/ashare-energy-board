import type {
  IntradayDayData,
  ProviderHealthStatus,
  ProviderId,
  QuoteSnapshot,
  TickerSearchResult,
} from '../../shared/types';

export type FetchLike = typeof fetch;

export type SleepLike = (ms: number) => Promise<void>;

/** 统一的行情上游错误，携带 HTTP 状态、业务码及限流/可重试标记（绝不含密钥） */
export class ProviderRequestError extends Error {
  readonly provider: ProviderId;
  readonly httpStatus: number;
  readonly apiCode: number | null;
  readonly rateLimited: boolean;
  readonly retryable: boolean;

  constructor(params: {
    provider: ProviderId;
    message: string;
    httpStatus?: number;
    apiCode?: number | null;
    rateLimited?: boolean;
    retryable?: boolean;
  }) {
    super(`[${params.provider}] ${params.message}`);
    this.name = 'ProviderRequestError';
    this.provider = params.provider;
    this.httpStatus = params.httpStatus ?? 0;
    this.apiCode = params.apiCode ?? null;
    this.rateLimited = Boolean(params.rateLimited);
    this.retryable = Boolean(params.retryable);
  }
}

/** 可插拔行情数据提供者接口（对齐 docs/PLAN.md Phase 3 任务 1） */
export interface MarketDataProvider {
  readonly id: ProviderId;
  fetchBatchSnapshots(
    symbols: readonly string[],
    nameLookup?: ReadonlyMap<string, string>
  ): Promise<Map<string, QuoteSnapshot>>;
  fetchIntradayMinutes(symbol: string, days: number): Promise<IntradayDayData[]>;
  searchTickers(keyword: string, limit?: number): Promise<TickerSearchResult[]>;
  healthCheck(): Promise<ProviderHealthStatus>;
}
