import type { MarketDashboardState, VolumeStateType } from '../../shared/types';

const WINDOWS_TRAY_TOOLTIP_MAX_LEN = 120;

export function formatTurnoverCompact(amountYuan: number): string {
  const abs = Math.abs(amountYuan);
  const sign = amountYuan < 0 ? '-' : '';
  if (abs >= 1e12) {
    return `${sign}${(abs / 1e12).toFixed(2)}万亿`;
  }
  if (abs >= 1e8) {
    return `${sign}${(abs / 1e8).toFixed(1)}亿`;
  }
  if (abs >= 1e4) {
    return `${sign}${Math.round(abs / 1e4)}万`;
  }
  return `${sign}${Math.round(abs)}元`;
}

export function formatVolumeStateLabel(state: VolumeStateType | undefined): string {
  switch (state) {
    case 'EXPANDING':
      return '放量';
    case 'SHRINKING':
      return '缩量';
    case 'FLAT':
      return '平量';
    default:
      return '待比对';
  }
}

/**
 * 格式化系统托盘悬停 Tooltip：
 * - 展示沪深两市总成交额与放/平/缩量状态（含同比%）
 * - 数据降级或陈旧时明确标注「降级」/「陈旧」
 */
export function formatTrayTooltip(state: MarketDashboardState | null): string {
  const replay = state?.status.replay;
  const title = replay?.active
    ? `A股能量看板 [回放 ${replay.tradeDate} ${replay.currentTimeLabel}]`
    : 'A股实时能量看板';
  if (!state) {
    return `${title}\n数据初始化中…`;
  }

  const { marketTotal, status } = state;
  const flags: string[] = [];
  if (status.degraded || marketTotal.degraded) {
    flags.push('降级');
  }
  if (status.stale) {
    flags.push('陈旧');
  }

  if (marketTotal.cumTurnover === null) {
    const suffix = flags.length > 0 ? flags.join('/') : '降级';
    return `${title}\n两市总成交额：不可用（${suffix}）`;
  }

  const turnoverText = formatTurnoverCompact(marketTotal.cumTurnover);
  const volLabel = formatVolumeStateLabel(marketTotal.metrics?.volumeState);
  const ratioPct = marketTotal.metrics?.cumRatioPct;
  const ratioText =
    ratioPct !== null && ratioPct !== undefined
      ? ` ${ratioPct >= 0 ? '+' : ''}${ratioPct.toFixed(1)}%`
      : '';

  const statusSuffix = flags.length > 0 ? ` · ${flags.join('/')}` : '';
  const line = `两市：${turnoverText}（${volLabel}${ratioText}${statusSuffix}）`;
  const full = `${title}\n${line}`;
  return full.length > WINDOWS_TRAY_TOOLTIP_MAX_LEN
    ? `${full.slice(0, WINDOWS_TRAY_TOOLTIP_MAX_LEN - 1)}…`
    : full;
}
