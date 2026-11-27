import { describe, expect, it } from 'vitest';
import {
  getElapsedSecondsInMinute,
  getMarketPhase,
  getPrevTradingDate,
  getShanghaiParts,
  minuteIndexToLabel,
  shanghaiToTimestampMs,
  timestampToMinuteIndex,
  upstreamMinuteLabelToIndex,
} from '../../src/core/tradingClock';

const OPEN_DAYS = new Set(['2026-11-20', '2026-11-23', '2026-11-24']);

describe('tradingClock', () => {
  it('classifies all key market phase boundaries and minuteIndex accurately', () => {
    const d = '2026-11-24';

    const cases: Array<{
      h: number;
      m: number;
      s?: number;
      phase: ReturnType<typeof getMarketPhase>;
      minuteIndex: number | null;
    }> = [
      { h: 9, m: 0, phase: 'PRE_MARKET', minuteIndex: null },
      { h: 9, m: 15, phase: 'OPEN_AUCTION', minuteIndex: null },
      { h: 9, m: 24, s: 59, phase: 'OPEN_AUCTION', minuteIndex: null },
      { h: 9, m: 25, phase: 'AUCTION_GAP', minuteIndex: null },
      { h: 9, m: 29, s: 59, phase: 'AUCTION_GAP', minuteIndex: null },
      { h: 9, m: 30, phase: 'MORNING_SESSION', minuteIndex: 0 },
      { h: 9, m: 35, phase: 'MORNING_SESSION', minuteIndex: 5 },
      { h: 11, m: 28, phase: 'MORNING_SESSION', minuteIndex: 118 },
      { h: 11, m: 29, phase: 'MORNING_SESSION', minuteIndex: 119 },
      { h: 11, m: 30, s: 0, phase: 'MORNING_SESSION', minuteIndex: 119 },
      { h: 11, m: 30, s: 1, phase: 'LUNCH_BREAK', minuteIndex: null },
      { h: 12, m: 0, phase: 'LUNCH_BREAK', minuteIndex: null },
      { h: 13, m: 0, phase: 'AFTERNOON_SESSION', minuteIndex: 120 },
      { h: 13, m: 2, phase: 'AFTERNOON_SESSION', minuteIndex: 122 },
      { h: 14, m: 59, phase: 'AFTERNOON_SESSION', minuteIndex: 239 },
      { h: 15, m: 0, s: 0, phase: 'AFTERNOON_SESSION', minuteIndex: 239 },
      { h: 15, m: 0, s: 1, phase: 'POST_MARKET', minuteIndex: null },
      { h: 15, m: 1, phase: 'POST_MARKET', minuteIndex: null },
    ];

    for (const c of cases) {
      const ts = shanghaiToTimestampMs(d, c.h, c.m, c.s ?? 0);
      expect(getMarketPhase(ts, OPEN_DAYS)).toBe(c.phase);
      expect(timestampToMinuteIndex(ts)).toBe(c.minuteIndex);
    }
  });

  it('returns CLOSED_DAY on weekends or holidays regardless of clock time', () => {
    const saturday10am = shanghaiToTimestampMs('2026-11-21', 10, 0, 0);
    expect(getMarketPhase(saturday10am, OPEN_DAYS)).toBe('CLOSED_DAY');
    expect(getShanghaiParts(saturday10am).dateStr).toBe('2026-11-21');
  });

  it('maps minuteIndex bidirectionally to labels with lunch break folded', () => {
    expect(minuteIndexToLabel(0)).toBe('09:30');
    expect(minuteIndexToLabel(119)).toBe('11:29');
    expect(minuteIndexToLabel(120)).toBe('13:00');
    expect(minuteIndexToLabel(239)).toBe('14:59');
    expect(() => minuteIndexToLabel(-1)).toThrow(RangeError);
    expect(() => minuteIndexToLabel(240)).toThrow(RangeError);
  });

  it('computes elapsed seconds inside continuous trading minutes and closure points', () => {
    expect(getElapsedSecondsInMinute(shanghaiToTimestampMs('2026-11-24', 10, 5, 10))).toBe(10);
    expect(getElapsedSecondsInMinute(shanghaiToTimestampMs('2026-11-24', 11, 30, 0))).toBe(60);
    expect(getElapsedSecondsInMinute(shanghaiToTimestampMs('2026-11-24', 15, 0, 0))).toBe(60);
    expect(getElapsedSecondsInMinute(shanghaiToTimestampMs('2026-11-24', 12, 0, 0))).toBeNull();
  });

  it('maps upstream intraday labels while excluding 09:30 auction, 13:00 duplicate, and after-hours', () => {
    expect(upstreamMinuteLabelToIndex('09:30')).toBeNull();
    expect(upstreamMinuteLabelToIndex('0930')).toBeNull();
    expect(upstreamMinuteLabelToIndex('09:31')).toBe(0);
    expect(upstreamMinuteLabelToIndex('11:30')).toBe(119);
    expect(upstreamMinuteLabelToIndex('13:00')).toBeNull();
    expect(upstreamMinuteLabelToIndex('1300')).toBeNull();
    expect(upstreamMinuteLabelToIndex('13:01')).toBe(120);
    expect(upstreamMinuteLabelToIndex('15:00')).toBe(239);
    expect(upstreamMinuteLabelToIndex('15:01')).toBeNull();
    expect(upstreamMinuteLabelToIndex('1530')).toBeNull();
  });

  it('resolves previous trading date across weekends accurately', () => {
    expect(getPrevTradingDate('2026-11-24', OPEN_DAYS)).toBe('2026-11-23');
    expect(getPrevTradingDate('2026-11-23', OPEN_DAYS)).toBe('2026-11-20');
    expect(getPrevTradingDate('2026-11-20', OPEN_DAYS)).toBeNull();
  });
});
