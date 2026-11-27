/**
 * 交易时钟与时间轴模块（纯 TypeScript，零 IO、零系统时钟依赖）
 *
 * 严格按北京时间（Asia/Shanghai，UTC+8）解释所有时间戳，与宿主机时区无关。
 * 连续交易分钟索引 minuteIndex ∈ [0, 239]：
 * - 上午：09:30 → 0 … 11:29 → 119（11:30:00 闭合归入 119）
 * - 午休：11:30–13:00 完全折叠，不产生索引
 * - 下午：13:00 → 120 … 14:59 → 239（15:00:00 收盘撮合归入 239）
 */

export type MarketPhase =
  | 'PRE_MARKET'
  | 'OPEN_AUCTION'
  | 'AUCTION_GAP'
  | 'MORNING_SESSION'
  | 'LUNCH_BREAK'
  | 'AFTERNOON_SESSION'
  | 'POST_MARKET'
  | 'CLOSED_DAY';

export interface ShanghaiDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** YYYY-MM-DD */
  readonly dateStr: string;
  /** 当日已过秒数 [0, 86399] */
  readonly secondsOfDay: number;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const SEC_09_15 = 9 * 3600 + 15 * 60;
const SEC_09_25 = 9 * 3600 + 25 * 60;
const SEC_09_30 = 9 * 3600 + 30 * 60;
const SEC_11_30 = 11 * 3600 + 30 * 60;
const SEC_13_00 = 13 * 3600;
const SEC_15_00 = 15 * 3600;

export const TOTAL_TRADING_MINUTES = 240;
export const MORNING_END_MINUTE_INDEX = 119;
export const AFTERNOON_START_MINUTE_INDEX = 120;
export const LAST_MINUTE_INDEX = 239;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 将 Unix 毫秒时间戳转换为北京时间（Asia/Shanghai, UTC+8）的年月日时分秒，完全不依赖宿主机时区。
 */
export function getShanghaiParts(timestampMs: number): ShanghaiDateTimeParts {
  const shifted = new Date(timestampMs + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const second = shifted.getUTCSeconds();

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateStr: `${year}-${pad2(month)}-${pad2(day)}`,
    secondsOfDay: hour * 3600 + minute * 60 + second,
  };
}

/**
 * 将北京时间日期与时分秒构造成 Unix 毫秒时间戳（便于确定性测试与时钟运算）。
 */
export function shanghaiToTimestampMs(
  dateStr: string,
  hour: number,
  minute: number,
  second = 0
): number {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new RangeError(`Invalid dateStr (expected YYYY-MM-DD): ${dateStr}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Date.UTC(year, month - 1, day, hour, minute, second) - SHANGHAI_OFFSET_MS;
}

/**
 * 判断给定日期是否为交易日。
 */
export function isTradingDay(
  dateStr: string,
  openTradingDays: ReadonlySet<string> | readonly string[]
): boolean {
  if (Array.isArray(openTradingDays)) {
    return openTradingDays.includes(dateStr);
  }
  return (openTradingDays as ReadonlySet<string>).has(dateStr);
}

/**
 * 根据开市日集合查找指定日期的上一交易日（严格小于 dateStr 的最近开市日）。
 */
export function getPrevTradingDate(
  dateStr: string,
  openTradingDays: ReadonlySet<string> | readonly string[]
): string | null {
  let prev: string | null = null;
  for (const d of openTradingDays) {
    if (d < dateStr && (prev === null || d > prev)) {
      prev = d;
    }
  }
  return prev;
}

/**
 * 根据时间戳与开市交易日历判定当前市场阶段。
 */
export function getMarketPhase(
  timestampMs: number,
  openTradingDays: ReadonlySet<string> | readonly string[]
): MarketPhase {
  const parts = getShanghaiParts(timestampMs);
  if (!isTradingDay(parts.dateStr, openTradingDays)) {
    return 'CLOSED_DAY';
  }

  const sec = parts.secondsOfDay;
  if (sec < SEC_09_15) return 'PRE_MARKET';
  if (sec < SEC_09_25) return 'OPEN_AUCTION';
  if (sec < SEC_09_30) return 'AUCTION_GAP';
  if (sec <= SEC_11_30) return 'MORNING_SESSION';
  if (sec < SEC_13_00) return 'LUNCH_BREAK';
  if (sec <= SEC_15_00) return 'AFTERNOON_SESSION';
  return 'POST_MARKET';
}

/**
 * 将时间戳映射为连续交易分钟索引 minuteIndex ∈ [0, 239]（午休完全折叠）。
 * - 09:30:00–11:29:59 → 0..119；11:30:00 闭合归入 119
 * - 13:00:00–14:59:59 → 120..239；15:00:00 收盘撮合归入 239
 * - 非连续交易时段返回 null
 */
export function timestampToMinuteIndex(timestampMs: number): number | null {
  const { hour, minute, secondsOfDay } = getShanghaiParts(timestampMs);

  if (secondsOfDay >= SEC_09_30 && secondsOfDay < SEC_11_30) {
    return (hour - 9) * 60 + (minute - 30);
  }
  if (secondsOfDay === SEC_11_30) {
    return MORNING_END_MINUTE_INDEX;
  }
  if (secondsOfDay >= SEC_13_00 && secondsOfDay < SEC_15_00) {
    return AFTERNOON_START_MINUTE_INDEX + (hour - 13) * 60 + minute;
  }
  if (secondsOfDay === SEC_15_00) {
    return LAST_MINUTE_INDEX;
  }
  return null;
}

/**
 * 将连续交易分钟索引 minuteIndex ∈ [0, 239] 映射为可读时间标签（HH:mm）。
 * 0 → "09:30"，119 → "11:29"，120 → "13:00"，239 → "14:59"。
 */
export function minuteIndexToLabel(minuteIndex: number): string {
  if (!Number.isInteger(minuteIndex) || minuteIndex < 0 || minuteIndex > LAST_MINUTE_INDEX) {
    throw new RangeError(`minuteIndex must be an integer in [0, 239], received: ${minuteIndex}`);
  }

  if (minuteIndex <= MORNING_END_MINUTE_INDEX) {
    const totalMinutes = 9 * 60 + 30 + minuteIndex;
    return `${pad2(Math.floor(totalMinutes / 60))}:${pad2(totalMinutes % 60)}`;
  }

  const afternoonOffset = minuteIndex - AFTERNOON_START_MINUTE_INDEX;
  const totalMinutes = 13 * 60 + afternoonOffset;
  return `${pad2(Math.floor(totalMinutes / 60))}:${pad2(totalMinutes % 60)}`;
}

/**
 * 获取当前时间戳在所属连续交易分钟内已过的秒数（用于未闭合分钟的昨日基线线性插值）：
 * - 09:30:00–11:29:59、13:00:00–14:59:59：返回 [0, 59]
 * - 11:30:00 或 15:00:00（闭合时刻）：返回 60
 * - 非连续交易时段：返回 null
 */
export function getElapsedSecondsInMinute(timestampMs: number): number | null {
  const { second, secondsOfDay } = getShanghaiParts(timestampMs);
  if (secondsOfDay === SEC_11_30 || secondsOfDay === SEC_15_00) {
    return 60;
  }
  if (
    (secondsOfDay >= SEC_09_30 && secondsOfDay < SEC_11_30) ||
    (secondsOfDay >= SEC_13_00 && secondsOfDay < SEC_15_00)
  ) {
    return second;
  }
  return null;
}

/**
 * 将上游分时接口（腾讯 day/query、东财 trends2）的闭合分钟标签映射到 minuteIndex ∈ [0, 239]。
 * 依据 Phase 0 实测：
 * - "09:30" / "0930" 是开盘集合竞价锚点，不属于连续竞价（返回 null）
 * - "09:31".."11:30" → 0..119
 * - "13:00" 是腾讯午休重复锚点（返回 null）
 * - "13:01".."15:00" → 120..239
 * - "15:01".."15:30" 是沪市盘后固定价格交易（返回 null）
 */
export function upstreamMinuteLabelToIndex(label: string): number | null {
  const normalized = label.replace(':', '').trim();
  if (!/^\d{4}$/.test(normalized)) return null;

  const hour = Number(normalized.slice(0, 2));
  const minute = Number(normalized.slice(2, 4));
  if (minute < 0 || minute > 59) return null;

  const totalMin = hour * 60 + minute;
  // 09:31 (571) .. 11:30 (690) → 0 .. 119
  if (totalMin >= 9 * 60 + 31 && totalMin <= 11 * 60 + 30) {
    return totalMin - (9 * 60 + 31);
  }
  // 13:01 (781) .. 15:00 (900) → 120 .. 239
  if (totalMin >= 13 * 60 + 1 && totalMin <= 15 * 60) {
    return AFTERNOON_START_MINUTE_INDEX + (totalMin - (13 * 60 + 1));
  }
  return null;
}
