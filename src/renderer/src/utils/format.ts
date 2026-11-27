import type { MarketPhaseType, VolumeStateType } from '../../../shared/types';
export {
  resolveSymbolChangePct,
  resolveSymbolPrice,
  resolveSymbolTurnover,
} from '../../../shared/snapshotView';

/**
 * 本机定制：是否存在"会影响数据"的降级。
 * 交易日历用公开数据推断（没配同花顺密钥时恒为真）不算，否则黄标常亮、真出问题时分不出来。
 * 完整原因仍在详情页设置栏里列出。
 */
export function hasDataDegradation(
  status: { degraded?: boolean; degradedReasons?: readonly string[] } | null | undefined
): boolean {
  if (!status?.degraded) return false;
  const reasons = status.degradedReasons ?? [];
  if (reasons.length === 0) return true;
  return reasons.some((r) => !r.startsWith('CALENDAR_'));
}

export function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) {
    return '—';
  }
  return price >= 1000 ? price.toFixed(1) : price.toFixed(2);
}

export function formatSlopeTrend(
  slope: number | null | undefined,
  windowMultiple: number | null | undefined,
  surgeSlopeThreshold = 3.0,
  shrinkSlopeThreshold = -3.0,
  options?: {
    postCloseReview?: boolean;
    /** 静态复盘态的前缀文字，默认「尾盘」；午休传「午间收盘」 */
    reviewLabel?: string;
    /** 本机定制：「急放/急缩」标签与正式提醒用同一套条件（斜率 + 区间倍数） */
    surgeMultipleThreshold?: number;
    shrinkMultipleThreshold?: number;
    matchMode?: 'AND' | 'OR';
  }
): {
  arrow: string;
  label: string;
  tone: 'surge' | 'shrink' | 'up' | 'down' | 'flat';
} {
  if (slope === null || slope === undefined || !Number.isFinite(slope)) {
    return { arrow: '·', label: '斜率待计算', tone: 'flat' };
  }
  const slopeStr = `${slope > 0 ? '+' : ''}${slope.toFixed(2)}%/分`;
  const multStr =
    windowMultiple !== null && windowMultiple !== undefined && Number.isFinite(windowMultiple)
      ? ` · ${windowMultiple.toFixed(2)}x`
      : '';

  // 盘后/休市静态复盘态：保留尾盘斜率数值，但去掉「急放/急缩」动态告警标签与红绿高亮
  if (options?.postCloseReview) {
    return { arrow: '', label: `${options.reviewLabel ?? '尾盘'} ${slopeStr}${multStr}`, tone: 'flat' };
  }

  // 本机定制：原版只看斜率，门槛太低导致标签盘中几乎一直在闪。这里补上区间倍数条件，
  // 口径与 core/alertEngine 一致；倍数缺失时按"未达标"处理。
  const hasMult =
    windowMultiple !== null && windowMultiple !== undefined && Number.isFinite(windowMultiple);
  const surgeMultHit = hasMult && windowMultiple >= (options?.surgeMultipleThreshold ?? 1.5);
  const shrinkMultHit = hasMult && windowMultiple <= (options?.shrinkMultipleThreshold ?? 0.65);
  const both = (options?.matchMode ?? 'AND') === 'AND';
  const surgeHit = both
    ? slope >= surgeSlopeThreshold && surgeMultHit
    : slope >= surgeSlopeThreshold || surgeMultHit;
  const shrinkHit = both
    ? slope <= shrinkSlopeThreshold && shrinkMultHit
    : slope <= shrinkSlopeThreshold || shrinkMultHit;

  if (surgeHit) {
    return { arrow: '▲', label: `急放 ${slopeStr}${multStr}`, tone: 'surge' };
  }
  if (shrinkHit) {
    return { arrow: '▼', label: `急缩 ${slopeStr}${multStr}`, tone: 'shrink' };
  }
  if (slope >= 0.8) {
    return { arrow: '↗', label: `${slopeStr}${multStr}`, tone: 'up' };
  }
  if (slope <= -0.8) {
    return { arrow: '↘', label: `${slopeStr}${multStr}`, tone: 'down' };
  }
  return { arrow: '→', label: `${slopeStr}${multStr}`, tone: 'flat' };
}

export function formatTurnover(amountYuan: number | null | undefined): string {
  if (amountYuan === null || amountYuan === undefined || !Number.isFinite(amountYuan)) {
    return '—';
  }
  const abs = Math.abs(amountYuan);
  const sign = amountYuan < 0 ? '-' : '';
  if (abs >= 1e12) {
    return `${sign}${(abs / 1e12).toFixed(2)} 万亿`;
  }
  if (abs >= 1e8) {
    return `${sign}${(abs / 1e8).toFixed(1)} 亿`;
  }
  if (abs >= 1e4) {
    return `${sign}${Math.round(abs / 1e4).toLocaleString('zh-CN')} 万`;
  }
  return `${sign}${Math.round(abs)} 元`;
}

export function formatSignedTurnover(amountYuan: number | null | undefined): string {
  if (amountYuan === null || amountYuan === undefined || !Number.isFinite(amountYuan)) {
    return '—';
  }
  const formatted = formatTurnover(Math.abs(amountYuan));
  if (amountYuan > 0) return `+${formatted}`;
  if (amountYuan < 0) return `-${formatted}`;
  return formatted;
}

export function formatSignedPct(pct: number | null | undefined, digits = 1): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return '—';
  }
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}

/** A 股红涨绿跌语义类：严格 >0 为红，严格 <0 为绿，平盘 0 或缺失保持中性色 */
export function getSignedToneClass(value: number | null | undefined): '' | 'tone-up' | 'tone-down' {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return '';
  }
  return value > 0 ? 'tone-up' : 'tone-down';
}

/** A 股红涨绿跌十六进制色值（供 ECharts Tooltip 等内联样式使用） */
export function getSignedToneColor(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return '#e6edf3';
  }
  return value > 0 ? '#ff7b72' : '#56d364';
}

export function formatVolumeState(state: VolumeStateType | undefined): {
  label: string;
  tone: 'up' | 'down' | 'flat' | 'muted';
} {
  switch (state) {
    case 'EXPANDING':
      return { label: '放量', tone: 'up' };
    case 'SHRINKING':
      return { label: '缩量', tone: 'down' };
    case 'FLAT':
      return { label: '平量', tone: 'flat' };
    default:
      return { label: '待比对', tone: 'muted' };
  }
}

export function formatPhaseLabel(phase: MarketPhaseType | undefined): string {
  switch (phase) {
    case 'PRE_MARKET':
      return '盘前';
    case 'OPEN_AUCTION':
      return '集合竞价';
    case 'AUCTION_GAP':
      return '竞价间隙';
    case 'MORNING_SESSION':
      return '早盘交易';
    case 'LUNCH_BREAK':
      return '午休折叠';
    case 'AFTERNOON_SESSION':
      return '午盘交易';
    case 'POST_MARKET':
      return '盘后复盘';
    case 'CLOSED_DAY':
      return '休市复盘';
    default:
      return '初始化';
  }
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 严格按北京时间（Asia/Shanghai, UTC+8）格式化时钟，独立于宿主机时区 */
export function formatClockTime(timestampMs: number | null | undefined): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return '—';
  const shifted = new Date(timestampMs + SHANGHAI_OFFSET_MS);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * 本机定制：预测全天成交额相对昨日全天的百分比（状态栏量能条的"预测量能 -13.4%"同一含义）。
 * 任一侧缺失或昨日为 0 时返回 null。
 */
export function predictedVsPrevFullDayPct(
  predicted: number | null | undefined,
  prevFullDay: number | null | undefined
): number | null {
  if (
    predicted === null || predicted === undefined || !Number.isFinite(predicted) ||
    prevFullDay === null || prevFullDay === undefined || !Number.isFinite(prevFullDay) ||
    prevFullDay <= 0
  ) {
    return null;
  }
  return (predicted / prevFullDay - 1) * 100;
}
