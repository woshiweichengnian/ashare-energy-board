import type { SymbolEnergySnapshot } from './types';

/**
 * 读取单标的当前累计成交额：
 * 优先实时快照，复盘/盘前无快照时回退至能量指标或分时序列末点；
 * 全部缺失时返回 null，绝不补零。
 */
export function resolveSymbolTurnover(item: SymbolEnergySnapshot | null | undefined): number | null {
  if (!item) return null;
  if (item.quote && Number.isFinite(item.quote.turnover)) {
    return item.quote.turnover;
  }
  if (
    item.metrics &&
    item.metrics.todayCumTurnover !== null &&
    Number.isFinite(item.metrics.todayCumTurnover)
  ) {
    return item.metrics.todayCumTurnover;
  }
  const lastBar = item.todaySeries.length > 0 ? item.todaySeries[item.todaySeries.length - 1] : null;
  if (lastBar && Number.isFinite(lastBar.cumTurnover)) {
    return lastBar.cumTurnover;
  }
  return null;
}

/**
 * 读取单标的涨跌幅百分比：
 * 优先实时快照；复盘模式无快照时基于今昨分时末点收盘价推算；缺失返回 null。
 */
export function resolveSymbolChangePct(item: SymbolEnergySnapshot | null | undefined): number | null {
  if (!item) return null;
  if (item.quote && Number.isFinite(item.quote.changePct)) {
    return item.quote.changePct;
  }
  const lastToday =
    item.todaySeries.length > 0 ? item.todaySeries[item.todaySeries.length - 1] : null;
  const lastPrev =
    item.prevSeries.length > 0 ? item.prevSeries[item.prevSeries.length - 1] : null;
  if (
    lastToday &&
    lastPrev &&
    Number.isFinite(lastToday.price) &&
    Number.isFinite(lastPrev.price) &&
    lastPrev.price > 0
  ) {
    return ((lastToday.price - lastPrev.price) / lastPrev.price) * 100;
  }
  return null;
}

/**
 * 读取单标的最新价格/点位：优先实时快照，复盘无快照时回退至分时序列末点价格。
 */
export function resolveSymbolPrice(item: SymbolEnergySnapshot | null | undefined): number | null {
  if (!item) return null;
  if (item.quote && Number.isFinite(item.quote.price) && item.quote.price > 0) {
    return item.quote.price;
  }
  const lastToday =
    item.todaySeries.length > 0 ? item.todaySeries[item.todaySeries.length - 1] : null;
  if (lastToday && Number.isFinite(lastToday.price) && lastToday.price > 0) {
    return lastToday.price;
  }
  return null;
}
