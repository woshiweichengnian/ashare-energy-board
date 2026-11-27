import { REPLAY_ALERT_PREFIX, SIMULATED_ALERT_PREFIX } from './constants';
import type { AlertDirection, AlertEventInput } from './types';

/**
 * 本机定制：把急放/急缩提醒从"斜率、区间倍数"翻成一句人话，并把同一两分钟内
 * 多个指数一起触发的提醒合并成一条（大盘一动，6 个指数会各报一次）。
 * 纯函数，悬浮窗、提醒页、系统通知共用同一套说法。
 */

type AlertTextSource = Pick<
  AlertEventInput,
  'name' | 'direction' | 'windowMultiple' | 'cumRatio' | 'slope'
>;

/** "1.6 倍" / "53%"：放量说倍数，缩量说只剩百分之几 */
export function formatMultiplePlain(direction: AlertDirection, multiple: number): string {
  if (!Number.isFinite(multiple)) return '—';
  if (direction === 'SHRINK' && multiple < 1) return `${Math.round(multiple * 100)}%`;
  return `${multiple.toFixed(1)} 倍`;
}

function signedPct(value: number, digits = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export interface AlertPlainText {
  /** 一句话：谁、放量还是缩量、和昨天同时段比是多少 */
  headline: string;
  /** 补充：今天到这一刻累计比昨天同期多还是少 */
  detail: string;
  /** 原始指标，给想看数字的人放在悬停提示或小字里 */
  metrics: string;
}

export function describeAlert(alert: AlertTextSource): AlertPlainText {
  const plain = formatMultiplePlain(alert.direction, alert.windowMultiple);
  const headline =
    alert.direction === 'SURGE'
      ? `${alert.name}突然放量，最近几分钟的成交是昨天同时段的 ${plain}`
      : `${alert.name}突然缩量，最近几分钟的成交只有昨天同时段的 ${plain}`;
  const detail = Number.isFinite(alert.cumRatio)
    ? `今天到这一刻累计比昨天同期 ${signedPct(alert.cumRatio * 100)}`
    : '';
  const metrics = `斜率 ${signedPct(alert.slope, 2)}/分 · 区间倍数 ${alert.windowMultiple.toFixed(2)}x`;
  return { headline, detail, metrics };
}

export interface AlertGroup {
  direction: AlertDirection;
  /** 这一组里最新一条的时间戳 */
  latestAt: number;
  /** 去重后的标的名，按触发先后 */
  names: string[];
  /** 第一条的代码，点击时用来跳转 */
  symbol: string;
  /** 放量取组内最大倍数，缩量取最小倍数 */
  multiple: number;
  count: number;
}

export const ALERT_GROUP_WINDOW_MS = 120_000;

/**
 * 把提醒按"同方向、相邻两条间隔不超过 windowMs"合并，返回从新到旧的分组。
 * 模拟测试和回放产生的提醒不参与。
 */
export function groupAlerts(
  alerts: readonly AlertEventInput[],
  windowMs = ALERT_GROUP_WINDOW_MS
): AlertGroup[] {
  const real = alerts
    .filter(
      (a) =>
        !a.message.startsWith(SIMULATED_ALERT_PREFIX) && !a.message.startsWith(REPLAY_ALERT_PREFIX)
    )
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  const groups: AlertGroup[] = [];
  let oldestInGroup = 0;
  for (const a of real) {
    const g = groups[groups.length - 1];
    if (g && g.direction === a.direction && oldestInGroup - a.createdAt <= windowMs) {
      // 从新往旧扫：同名的挪到最前，最后得到按首次触发先后的顺序
      g.names = [a.name, ...g.names.filter((n) => n !== a.name)];
      g.symbol = a.symbol;
      g.count += 1;
      g.multiple =
        a.direction === 'SURGE'
          ? Math.max(g.multiple, a.windowMultiple)
          : Math.min(g.multiple, a.windowMultiple);
    } else {
      groups.push({
        direction: a.direction,
        latestAt: a.createdAt,
        names: [a.name],
        symbol: a.symbol,
        multiple: a.windowMultiple,
        count: 1,
      });
    }
    oldestInGroup = a.createdAt;
  }
  return groups;
}

/** 分组的短说法，如"沪深两市、上证指数等 6 个 放量 1.9 倍" */
export function describeAlertGroup(group: AlertGroup): { who: string; what: string } {
  const who =
    group.names.length <= 2
      ? group.names.join('、')
      : `${group.names.slice(0, 2).join('、')}等 ${group.names.length} 个`;
  const plain = formatMultiplePlain(group.direction, group.multiple);
  const what = group.direction === 'SURGE' ? `放量 ${plain}` : `缩到 ${plain}`;
  return { who, what };
}

/** 时间戳 -> 北京时间 "HH:MM" */
export function formatAlertClock(timestampMs: number): string {
  const d = new Date(timestampMs + 8 * 3600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
