import { describe, expect, it } from 'vitest';
import { computeRecentDelta } from '../../src/renderer/src/hud/recentDelta';

const YI = 1e8;

describe('local: computeRecentDelta', () => {
  it('returns null until there is a ~10s span', () => {
    expect(computeRecentDelta([], null)).toBeNull();
    expect(computeRecentDelta([{ t: 0, cum: 0 }, { t: 3000, cum: YI }], null)).toBeNull();
  });

  it('picks the sample closest to 10s ago and normalises to 10s', () => {
    const samples = [
      { t: 0, cum: 100 * YI },
      { t: 3000, cum: 103 * YI },
      { t: 6000, cum: 106 * YI },
      { t: 9000, cum: 109 * YI },
      { t: 12000, cum: 112 * YI },
    ];
    // 最接近 10 秒前的是 t=3000（跨度 9 秒，进 9 亿）→ 折算 10 秒 = 10 亿
    const r = computeRecentDelta(samples, 60 * YI);
    expect(r?.amount).toBeCloseTo(10 * YI, 0);
    // 昨天同一分钟 60 亿 → 每 10 秒 10 亿 → 1 倍
    expect(r?.paceMultiple).toBeCloseTo(1, 5);
  });

  it('reports a burst as a multiple of yesterday pace', () => {
    const r = computeRecentDelta([{ t: 0, cum: 0 }, { t: 10000, cum: 30 * YI }], 60 * YI);
    expect(r?.paceMultiple).toBeCloseTo(3, 5);
  });

  it('has no multiple when yesterday bar is missing, and rejects negative deltas', () => {
    expect(computeRecentDelta([{ t: 0, cum: 0 }, { t: 10000, cum: YI }], null)?.paceMultiple).toBeNull();
    expect(computeRecentDelta([{ t: 0, cum: 5 * YI }, { t: 10000, cum: YI }], null)).toBeNull();
  });
});
