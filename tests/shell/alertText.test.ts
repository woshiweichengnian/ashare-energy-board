import { describe, expect, it } from 'vitest';
import {
  describeAlert,
  describeAlertGroup,
  formatAlertClock,
  formatMultiplePlain,
  groupAlerts,
} from '../../src/shared/alertText';
import { SIMULATED_ALERT_PREFIX } from '../../src/shared/constants';
import type { AlertEventInput } from '../../src/shared/types';

const T0 = Date.UTC(2026, 10, 27, 2, 32, 0); // 北京时间 10:32

function alert(over: Partial<AlertEventInput>): AlertEventInput {
  return {
    symbol: '000001.SH',
    name: '上证指数',
    tradeDate: '2026-11-27',
    minuteIndex: 62,
    direction: 'SURGE',
    slope: 12,
    windowMultiple: 1.61,
    cumRatio: -0.046,
    message: '上证指数快速放量',
    createdAt: T0,
    ...over,
  };
}

describe('alertText', () => {
  it('放量说倍数，缩量说只剩百分之几', () => {
    expect(formatMultiplePlain('SURGE', 1.61)).toBe('1.6 倍');
    expect(formatMultiplePlain('SHRINK', 0.53)).toBe('53%');
  });

  it('单条提醒翻成一句话，指标另放', () => {
    const t = describeAlert(alert({}));
    expect(t.headline).toBe('上证指数突然放量，最近几分钟的成交是昨天同时段的 1.6 倍');
    expect(t.detail).toBe('今天到这一刻累计比昨天同期 -4.6%');
    expect(t.metrics).toContain('+12.00%/分');
    const s = describeAlert(alert({ direction: 'SHRINK', windowMultiple: 0.47, slope: -4.3 }));
    expect(s.headline).toContain('只有昨天同时段的 47%');
  });

  it('两分钟内同方向的多条合并成一组，反方向和隔得远的分开', () => {
    const rows = [
      alert({ name: '科创50', symbol: '000688.SH', createdAt: T0 - 60_000, windowMultiple: 1.52 }),
      alert({}),
      alert({ name: '深证成指', symbol: '399001.SZ', createdAt: T0 + 20_000, windowMultiple: 1.9 }),
      alert({ name: '上证指数', createdAt: T0 + 30_000 }),
      alert({ direction: 'SHRINK', createdAt: T0 - 600_000, windowMultiple: 0.5 }),
      alert({ createdAt: T0 - 1_200_000 }),
      alert({ message: `${SIMULATED_ALERT_PREFIX} 测试`, createdAt: T0 + 40_000 }),
    ];
    const groups = groupAlerts(rows);
    expect(groups).toHaveLength(3);
    expect(groups[0].names).toEqual(['科创50', '上证指数', '深证成指']);
    expect(groups[0].count).toBe(4);
    expect(groups[0].multiple).toBe(1.9);
    expect(groups[0].latestAt).toBe(T0 + 30_000);
    expect(groups[1].direction).toBe('SHRINK');
    expect(describeAlertGroup(groups[0])).toEqual({ who: '科创50、上证指数等 3 个', what: '放量 1.9 倍' });
    expect(describeAlertGroup(groups[1]).what).toBe('缩到 50%');
  });

  it('时间按北京时间显示', () => {
    expect(formatAlertClock(T0)).toBe('10:32');
  });
});
