import { useEffect, useRef, useState } from 'react';
import type { MarketDashboardState } from '../../../shared/types';

/**
 * 本机定制：两市总成交额「近 10 秒增量」。
 * 应用的急放/急缩看的是 5 分钟窗口，几秒钟的脉冲会被抹平；这里直接给出最近约 10 秒进了多少钱。
 * 行情源对沪、深指数的推送节奏不完全一致，单看相邻两次刷新会忽大忽小，所以取约 10 秒的跨度再折算成 10 秒。
 */
export interface DeltaSample {
  t: number;
  cum: number;
}

export interface RecentDelta {
  /** 折算成 10 秒的增量（元） */
  amount: number;
  /** 相对昨天同一分钟平均节奏的倍数；昨天数据缺失时为 null */
  paceMultiple: number | null;
}

const TARGET_MS = 10_000;
const MIN_SPAN_MS = 7_000;
const MAX_SPAN_MS = 16_000;
export const DELTA_KEEP_MS = 20_000;
/** 达到昨天同一分钟节奏的多少倍时标红并显示倍数 */
export const DELTA_HOT_MULTIPLE = 2;

export function computeRecentDelta(
  samples: readonly DeltaSample[],
  prevMinuteTurnover: number | null
): RecentDelta | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  let base: DeltaSample | null = null;
  for (const s of samples) {
    const span = last.t - s.t;
    if (span < MIN_SPAN_MS || span > MAX_SPAN_MS) continue;
    if (!base || Math.abs(span - TARGET_MS) < Math.abs(last.t - base.t - TARGET_MS)) base = s;
  }
  if (!base) return null;
  const raw = last.cum - base.cum;
  if (!Number.isFinite(raw) || raw < 0) return null;
  const amount = (raw * TARGET_MS) / (last.t - base.t);
  const pace =
    prevMinuteTurnover !== null && Number.isFinite(prevMinuteTurnover) && prevMinuteTurnover > 0
      ? prevMinuteTurnover / 6
      : null;
  return { amount, paceMultiple: pace ? amount / pace : null };
}

/** 仅在连续竞价时段输出；午休、盘后、休市返回 null（界面不显示这一项） */
export function useRecentDelta(market: MarketDashboardState | null): RecentDelta | null {
  const samplesRef = useRef<DeltaSample[]>([]);
  const [delta, setDelta] = useState<RecentDelta | null>(null);

  useEffect(() => {
    const status = market?.status;
    const total = market?.marketTotal;
    const live =
      status?.mode === 'LIVE' &&
      (status.phase === 'MORNING_SESSION' || status.phase === 'AFTERNOON_SESSION');
    const cum = total?.cumTurnover;
    if (!live || cum === null || cum === undefined || !Number.isFinite(cum)) {
      samplesRef.current = [];
      setDelta(null);
      return;
    }
    const now = Date.now();
    const kept = samplesRef.current.filter((s) => now - s.t <= DELTA_KEEP_MS && s.cum <= cum);
    kept.push({ t: now, cum });
    samplesRef.current = kept;

    const todaySeries = total?.todaySeries ?? [];
    const nextIdx =
      todaySeries.length > 0 ? todaySeries[todaySeries.length - 1].minuteIndex + 1 : 0;
    const prevBar = (total?.prevSeries ?? []).find((p) => p.minuteIndex === nextIdx);
    setDelta(computeRecentDelta(kept, prevBar?.barTurnover ?? null));
  }, [market]);

  return delta;
}
