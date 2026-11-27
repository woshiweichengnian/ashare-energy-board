import { describe, expect, it } from 'vitest';
import {
  buildEtfBaseline,
  buildLadder,
  computeWwd,
  countLadder,
  lastWindowEndMs,
  parseFenbu,
  shapeAt,
  summarizeFenbu,
  WWD_CORE_ETFS,
  type EtfBaseline,
  type EtfQuote,
  type Sina5mBar,
} from '../../src/main/extras/extrasMath';

function dayBars(date: string, perBar: number): Sina5mBar[] {
  const out: Sina5mBar[] = [];
  const push = (h: number, m: number): void => {
    out.push({
      day: `${date} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`,
      close: '1',
      volume: String(perBar),
    });
  };
  for (let t = 575; t <= 690; t += 5) push(Math.floor(t / 60), t % 60);
  for (let t = 785; t <= 900; t += 5) push(Math.floor(t / 60), t % 60);
  return out; // 48 根
}

describe('extrasMath', () => {
  it('基准：排除当天，日均额与累计占比曲线', () => {
    const rows = [...dayBars('2026-11-25', 1e7), ...dayBars('2026-11-26', 3e7), ...dayBars('2026-11-27', 9e9)];
    const b = buildEtfBaseline(rows, '2026-11-27');
    expect(b).not.toBeNull();
    expect(b?.avg20Yi).toBeCloseTo((48 * 1e7 + 48 * 3e7) / 2 / 1e8, 6);
    expect(b?.shape).toHaveLength(48);
    expect(shapeAt(b?.shape ?? [], '11:30')).toBeCloseTo(0.5, 6);
    expect(shapeAt(b?.shape ?? [], '15:00')).toBeCloseTo(1, 6);
    expect(shapeAt(b?.shape ?? [], '09:00')).toBeCloseTo(1 / 48, 6);
    expect(buildEtfBaseline(dayBars('2026-11-27', 1), '2026-11-27')).toBeNull();
  });

  it('国家队判定：倍数和净买入方向决定档位', () => {
    const base = new Map<string, EtfBaseline>();
    const mk = (amountYi: number, outer: number, inner: number): Map<string, EtfQuote> => {
      const q = new Map<string, EtfQuote>();
      for (const [code] of WWD_CORE_ETFS) {
        base.set(code, { avg20Yi: 10, shape: [['09:35', 0.02], ['11:30', 0.5], ['15:00', 1]] });
        q.set(code, { amountYi, outerLots: outer, innerLots: inner });
      }
      return q;
    };
    const hot = computeWwd(mk(10, 60, 40), base, '11:30');
    expect(hot).toMatchObject({ level: 'hot', label: '上班了', ratio: 2 });
    expect(hot?.net).toBeCloseTo(40, 6);
    expect(computeWwd(mk(10, 40, 60), base, '11:30')?.level).toBe('mid');
    expect(computeWwd(mk(7, 60, 40), base, '11:30')?.level).toBe('mid');
    expect(computeWwd(mk(10, 60, 40), base, null)).toMatchObject({ level: 'cool', ratio: 1 });
    expect(computeWwd(new Map(), base, '11:30')).toBeNull();
  });

  it('涨跌分布并档、连板率', () => {
    const fen = parseFenbu([{ '11': 417 }, { '10': 1332 }, { '9': 434 }, { '8': 514 }, { '1': 114 }, { '0': 12 }, { '-1': 71 }, { '-11': 0 }]);
    const s = summarizeFenbu(fen);
    expect(s.up).toBe(417 + 1332 + 434 + 514 + 114);
    expect(s.down).toBe(71);
    expect(s.flat).toBe(12);
    expect(s.buckets[0]).toEqual({ label: '涨停', count: 417, side: 'up' });
    expect(s.buckets[1].count).toBe(1332 + 434 + 514);
    const today = countLadder([...Array(388).fill({ lbc: 1 }), ...Array(22).fill({ lbc: 2 }), ...Array(3).fill({ lbc: 3 }), ...Array(3).fill({ lbc: 4 }), { lbc: 6 }]);
    const prev = countLadder([...Array(51).fill({ lbc: 1 }), ...Array(8).fill({ lbc: 2 }), ...Array(4).fill({ lbc: 3 }), { lbc: 4 }, { lbc: 5 }]);
    expect(buildLadder(today, prev).map((x) => [x.count, x.rate])).toEqual([
      [388, null],
      [22, 43],
      [3, 38],
      [3, 75],
      [1, 50],
    ]);
  });

  it('最近一个已结束时段：盘后是今天收盘，盘前和周末是上一个交易日收盘', () => {
    const A = { start: 555, end: 905 }; // 09:15–15:05
    const bj = (d: number, h: number, m: number): number => Date.UTC(2026, 10, d, h - 8, m); // 2026-11
    const fri = bj(27, 15, 6);
    expect(lastWindowEndMs(bj(27, 17, 0), A)).toBe(fri); // 周五盘后
    expect(lastWindowEndMs(bj(27, 10, 0), A)).toBe(bj(26, 15, 6)); // 周五盘中 -> 周四收盘
    expect(lastWindowEndMs(bj(28, 12, 0), A)).toBe(fri); // 周六
    expect(lastWindowEndMs(bj(30, 8, 0), A)).toBe(fri); // 下周一盘前
  });
});
