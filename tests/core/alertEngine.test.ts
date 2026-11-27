import { describe, expect, it } from 'vitest';
import { AlertEngine, resolveAlertConfig } from '../../src/core/alertEngine';
import type { EnergyMetrics } from '../../src/core/energyEngine';
import { shanghaiToTimestampMs } from '../../src/core/tradingClock';

function makeMetrics(overrides: Partial<EnergyMetrics>): EnergyMetrics {
  return {
    minuteIndex: 10,
    elapsedSeconds: 60,
    todayCumTurnover: 1200,
    prevAlignedCumTurnover: 1000,
    cumDiff: 200,
    cumRatio: 0.2,
    cumRatioPct: 20,
    predictedFullDayTurnover: 24_000,
    volumeState: 'EXPANDING',
    slope: 4.5,
    windowMultiple: 1.8,
    windowDeviationPct: 80,
    slopeWindow: 5,
    ...overrides,
  };
}

describe('AlertEngine', () => {
  it('suppresses alerts during 09:30-09:34 (minuteIndex < 5) and allows alerts from 09:35 (minuteIndex >= 5)', () => {
    const engine = new AlertEngine();
    const d = '2026-11-24';

    for (let idx = 0; idx < 5; idx++) {
      const res = engine.evaluate({
        symbol: 'MARKET_TOTAL',
        name: '沪深两市',
        tradeDate: d,
        timestampMs: shanghaiToTimestampMs(d, 9, 30 + idx, 30),
        metrics: makeMetrics({ minuteIndex: idx, slope: 3.0, windowMultiple: 2.5 }),
      });
      expect(res.triggered).toBe(false);
      expect(res.skipReason).toBe('COLD_START');
    }

    const at0935 = engine.evaluate({
      symbol: 'MARKET_TOTAL',
      name: '沪深两市',
      tradeDate: d,
      timestampMs: shanghaiToTimestampMs(d, 9, 35, 0),
      metrics: makeMetrics({ minuteIndex: 5, slope: 3.5, windowMultiple: 1.6 }),
    });
    expect(at0935.triggered).toBe(true);
    expect(at0935.direction).toBe('SURGE');
    expect(at0935.event?.symbol).toBe('MARKET_TOTAL');
    expect(at0935.event?.minuteIndex).toBe(5);
  });

  it('enforces same-direction cooldown, re-triggers after cooldown, and triggers opposite direction immediately', () => {
    const engine = new AlertEngine();
    const d = '2026-11-24';
    const t0 = shanghaiToTimestampMs(d, 10, 0, 0);

    // 首次 SURGE 触发
    const first = engine.evaluate({
      symbol: '600519.SH',
      name: '贵州茅台',
      tradeDate: d,
      timestampMs: t0,
      metrics: makeMetrics({ minuteIndex: 30, slope: 3.4, windowMultiple: 1.7 }),
    });
    expect(first.triggered).toBe(true);
    expect(first.direction).toBe('SURGE');

    // 4 分 59 秒后仍处冷却期 → 同方向 SURGE 被抑制
    const withinCooldown = engine.evaluate({
      symbol: '600519.SH',
      name: '贵州茅台',
      tradeDate: d,
      timestampMs: t0 + 4 * 60_000 + 59_000,
      metrics: makeMetrics({ minuteIndex: 34, slope: 4.0, windowMultiple: 2.2 }),
    });
    expect(withinCooldown.triggered).toBe(false);
    expect(withinCooldown.skipReason).toBe('COOLDOWN');

    // 冷却期内反方向 SHRINK → 不受 SURGE 冷却影响，立即触发！
    const opposite = engine.evaluate({
      symbol: '600519.SH',
      name: '贵州茅台',
      tradeDate: d,
      timestampMs: t0 + 2 * 60_000,
      metrics: makeMetrics({
        minuteIndex: 32,
        slope: -3.5,
        windowMultiple: 0.55,
        cumRatio: -0.06,
        cumRatioPct: -6,
        volumeState: 'SHRINKING',
      }),
    });
    expect(opposite.triggered).toBe(true);
    expect(opposite.direction).toBe('SHRINK');

    // 满 5 分钟后冷却结束 → 同方向 SURGE 可再次触发
    const afterCooldown = engine.evaluate({
      symbol: '600519.SH',
      name: '贵州茅台',
      tradeDate: d,
      timestampMs: t0 + 5 * 60_000,
      metrics: makeMetrics({ minuteIndex: 35, slope: 3.6, windowMultiple: 1.8 }),
    });
    expect(afterCooldown.triggered).toBe(true);
    expect(afterCooldown.direction).toBe('SURGE');
  });

  it('supports AND vs OR match modes and symbol-level threshold/toggle overrides', () => {
    const engine = new AlertEngine();
    const d = '2026-11-24';
    const ts = shanghaiToTimestampMs(d, 10, 15, 0);

    // 默认 AND 模式：仅斜率满足，倍数不满足 → 不触发
    const andMiss = engine.evaluate({
      symbol: '300750.SZ',
      name: '宁德时代',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 45, slope: 3.8, windowMultiple: 1.3 }),
    });
    expect(andMiss.triggered).toBe(false);
    expect(andMiss.skipReason).toBe('NO_SIGNAL');

    // 单股覆写为 OR 模式 → 触发
    const orHit = engine.evaluate({
      symbol: '300750.SZ',
      name: '宁德时代',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 45, slope: 3.8, windowMultiple: 1.3 }),
      symbolOverride: { matchMode: 'OR' },
    });
    expect(orHit.triggered).toBe(true);
    expect(orHit.direction).toBe('SURGE');

    // 单股覆写放宽/收紧阈值与独立开关关闭
    const strictMiss = engine.evaluate({
      symbol: '000001.SH',
      name: '上证指数',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 45, slope: 3.5, windowMultiple: 1.6 }),
      symbolOverride: { surgeSlopeThreshold: 5.0 },
    });
    expect(strictMiss.triggered).toBe(false);

    const disabled = engine.evaluate({
      symbol: '000001.SH',
      name: '上证指数',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 45, slope: 3.0, windowMultiple: 3.0 }),
      symbolOverride: { enabled: false },
    });
    expect(disabled.triggered).toBe(false);
    expect(disabled.skipReason).toBe('DISABLED');
  });

  it('never triggers when any core metric is unavailable or target is degraded', () => {
    const engine = new AlertEngine({ matchMode: 'OR' });
    const d = '2026-11-24';
    const ts = shanghaiToTimestampMs(d, 10, 20, 0);

    const missingSlope = engine.evaluate({
      symbol: '600519.SH',
      name: '贵州茅台',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 50, slope: null, windowMultiple: 2.5 }),
    });
    expect(missingSlope.triggered).toBe(false);
    expect(missingSlope.skipReason).toBe('METRICS_UNAVAILABLE');

    const missingMultiple = engine.evaluate({
      symbol: '600519.SH',
      name: '贵州茅台',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 50, slope: 2.5, windowMultiple: null }),
    });
    expect(missingMultiple.triggered).toBe(false);
    expect(missingMultiple.skipReason).toBe('METRICS_UNAVAILABLE');

    const degradedTotal = engine.evaluate({
      symbol: 'MARKET_TOTAL',
      name: '沪深两市',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 50, slope: 2.5, windowMultiple: 2.5 }),
      degraded: true,
    });
    expect(degradedTotal.triggered).toBe(false);
    expect(degradedTotal.skipReason).toBe('DEGRADED');

    // NaN / Infinity 指标在 OR 模式下也必须拦截，不得产生 NaN 告警
    const nanMetric = engine.evaluate({
      symbol: '600519.SH',
      name: '贵州茅台',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 50, slope: 2.5, windowMultiple: Number.NaN }),
    });
    expect(nanMetric.triggered).toBe(false);
    expect(nanMetric.skipReason).toBe('METRICS_UNAVAILABLE');
  });

  it('ignores explicit undefined fields in config overrides and enforces slopeWindow consistency', () => {
    const resolved = resolveAlertConfig(
      { surgeSlopeThreshold: 1.8 },
      { surgeSlopeThreshold: undefined, enabled: true }
    );
    expect(resolved.surgeSlopeThreshold).toBe(1.8);
    expect(resolved.shrinkMultipleThreshold).toBe(0.65);

    const engine = new AlertEngine();
    const d = '2026-11-24';
    const ts = shanghaiToTimestampMs(d, 10, 25, 0);

    // 精准命中阈值边界（+3.0 / 1.5 与 -3.0 / 0.65）应触发
    const exactSurge = engine.evaluate({
      symbol: '000001.SH',
      name: '上证指数',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 55, slope: 3.0, windowMultiple: 1.5, slopeWindow: 5 }),
    });
    expect(exactSurge.triggered).toBe(true);
    expect(exactSurge.direction).toBe('SURGE');

    const exactShrink = engine.evaluate({
      symbol: '000001.SH',
      name: '上证指数',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({
        minuteIndex: 55,
        slope: -3.0,
        windowMultiple: 0.65,
        cumRatio: -0.06,
        slopeWindow: 5,
      }),
    });
    expect(exactShrink.triggered).toBe(true);
    expect(exactShrink.direction).toBe('SHRINK');

    // 单股覆写 slopeWindow=3，但传入 metrics.slopeWindow=5 → 返回 WINDOW_MISMATCH 防止静默错窗
    const windowMismatch = engine.evaluate({
      symbol: '300750.SZ',
      name: '宁德时代',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 55, slope: 4.0, windowMultiple: 2.0, slopeWindow: 5 }),
      symbolOverride: { slopeWindow: 3 },
    });
    expect(windowMismatch.triggered).toBe(false);
    expect(windowMismatch.skipReason).toBe('WINDOW_MISMATCH');

    // 当 metrics.slopeWindow 与覆写后的 slopeWindow=3 对齐时正常触发
    const windowMatched = engine.evaluate({
      symbol: '300750.SZ',
      name: '宁德时代',
      tradeDate: d,
      timestampMs: ts,
      metrics: makeMetrics({ minuteIndex: 55, slope: 4.0, windowMultiple: 2.0, slopeWindow: 3 }),
      symbolOverride: { slopeWindow: 3 },
    });
    expect(windowMatched.triggered).toBe(true);
    expect(windowMatched.direction).toBe('SURGE');
  });
});
