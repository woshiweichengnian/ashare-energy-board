import type { HudExtras, MarketSentiment } from '../../shared/types';
import { buildHudExtras, buildMarketSentiment } from './builtinExtras';

/**
 * 本机定制：悬浮窗附加行（韩国综指 / 国家队是否上班 / 涨跌停家数 / 涨跌家数）。
 * 取数逻辑内置在应用里（见 builtinExtras.ts），不依赖本机其他服务，换一台电脑装上就能用。
 * 这里每 10 秒问一次；真正向外发请求的频率由各项自己的缓存决定（盘中十几到二十几秒，
 * 非交易时段 5 分钟）。任何一项取不到显示"—"，不影响量能主功能。
 */
const EXTRAS_INTERVAL_MS = 10_000;

export interface ExtrasPoller {
  getLatest(): HudExtras | null;
  stop(): void;
}

export function startExtrasPoller(onUpdate: (extras: HudExtras | null) => void): ExtrasPoller {
  let latest: HudExtras | null = null;
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      latest = await buildHudExtras();
    } catch (err: unknown) {
      latest = null;
      console.warn('[extras] build failed:', err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
    if (!stopped) onUpdate(latest);
  };

  void tick();
  const timer = setInterval(() => void tick(), EXTRAS_INTERVAL_MS);

  return {
    getLatest: () => latest,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** 「情绪」页数据。取不到返回 null，页面自己显示原因。 */
export function fetchMarketSentiment(
  tradeDate: string | null,
  prevTradeDate: string | null
): Promise<MarketSentiment | null> {
  return buildMarketSentiment(tradeDate, prevTradeDate);
}
