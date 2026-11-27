import {
  ALLOWED_SLOPE_WINDOWS,
  MONITORED_INDEX_SYMBOLS,
  OPTIONAL_INDEX_SYMBOLS,
} from '../../shared/constants';
import type {
  SlopeWindowOption,
  WatchlistAddInput,
  WatchlistItemRow,
  WatchlistThresholdOverride,
  WatchlistUpdateInput,
} from '../../shared/types';
import type { AppDatabase } from './database';

const THSCODE_REGEX = /^\d{6}\.(SH|SZ)$/;
const CORE_INDEX_SYMBOL_SET = new Set<string>(MONITORED_INDEX_SYMBOLS);
const OPTIONAL_INDEX_SYMBOL_SET = new Set<string>(OPTIONAL_INDEX_SYMBOLS);

export function normalizeThscode(raw: string): string {
  const normalized = raw.trim().toUpperCase();
  if (!THSCODE_REGEX.test(normalized)) {
    throw new Error(`无效的 A 股标的代码（仅支持沪深 6 位代码如 600519.SH / 300750.SZ）：${raw}`);
  }
  return normalized;
}

function clampFinite(value: unknown, min: number, max: number, digits = 2): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const clamped = Math.max(min, Math.min(max, value));
  const factor = 10 ** digits;
  return Math.round(clamped * factor) / factor;
}

/** 清洗单股自定义阈值覆写；无有效覆写项时返回 null（跟随全局默认） */
export function sanitizeWatchlistThresholds(
  raw: WatchlistThresholdOverride | null | undefined
): WatchlistThresholdOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: WatchlistThresholdOverride = {};

  if (
    typeof raw.slopeWindow === 'number' &&
    (ALLOWED_SLOPE_WINDOWS as readonly number[]).includes(raw.slopeWindow)
  ) {
    out.slopeWindow = raw.slopeWindow as SlopeWindowOption;
  }

  const surgeSlope = clampFinite(raw.surgeSlopeThreshold, 0.1, 50, 2);
  if (surgeSlope !== undefined) out.surgeSlopeThreshold = surgeSlope;

  const surgeMult = clampFinite(raw.surgeMultipleThreshold, 1.05, 20, 2);
  if (surgeMult !== undefined) out.surgeMultipleThreshold = surgeMult;

  if (typeof raw.shrinkSlopeThreshold === 'number' && Number.isFinite(raw.shrinkSlopeThreshold)) {
    const neg = raw.shrinkSlopeThreshold > 0 ? -raw.shrinkSlopeThreshold : raw.shrinkSlopeThreshold;
    const shrinkSlope = clampFinite(neg, -50, -0.1, 2);
    if (shrinkSlope !== undefined) out.shrinkSlopeThreshold = shrinkSlope;
  }

  const shrinkMult = clampFinite(raw.shrinkMultipleThreshold, 0.05, 0.95, 2);
  if (shrinkMult !== undefined) out.shrinkMultipleThreshold = shrinkMult;

  if (raw.matchMode === 'AND' || raw.matchMode === 'OR') {
    out.matchMode = raw.matchMode;
  }

  const cooldown = clampFinite(raw.cooldownMinutes, 1, 120, 0);
  if (cooldown !== undefined) out.cooldownMinutes = Math.round(cooldown);

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 自选股持久化管理服务（增、删、排序、单股告警开关与自定义阈值）。
 */
export class WatchlistService {
  private readonly db: AppDatabase;

  constructor(db: AppDatabase) {
    this.db = db;
  }

  list(): WatchlistItemRow[] {
    return this.db.getWatchlist();
  }

  add(input: WatchlistAddInput): WatchlistItemRow[] {
    const symbol = normalizeThscode(input.symbol);
    if (CORE_INDEX_SYMBOL_SET.has(symbol)) {
      throw new Error(`核心大盘指数 ${symbol} 由「设置 → 指数展示配置」统一管理，无需加入自选股`);
    }
    if (OPTIONAL_INDEX_SYMBOL_SET.has(symbol)) {
      throw new Error(`扩展指数 ${symbol} 请在「设置 → 指数展示配置」中开启，无需加入自选股`);
    }
    const name = input.name.trim() || symbol;
    const existing = this.db.getWatchlist();
    const found = existing.find((item) => item.symbol === symbol);

    if (found) {
      this.db.upsertWatchlistItem({
        ...found,
        name,
      });
      return this.db.getWatchlist();
    }

    const maxOrder = existing.reduce((max, item) => Math.max(max, item.sortOrder), -1);
    this.db.upsertWatchlistItem({
      symbol,
      name,
      sortOrder: maxOrder + 1,
      alertEnabled: true,
      customThresholdsJson: null,
    });
    return this.db.getWatchlist();
  }

  remove(rawSymbol: string): WatchlistItemRow[] {
    const symbol = rawSymbol.trim().toUpperCase();
    this.db.removeWatchlistItem(symbol);

    const remaining = this.db.getWatchlist();
    remaining.forEach((item, index) => {
      if (item.sortOrder !== index) {
        this.db.upsertWatchlistItem({ ...item, sortOrder: index });
      }
    });
    return this.db.getWatchlist();
  }

  reorder(orderedSymbols: readonly string[]): WatchlistItemRow[] {
    const existing = this.db.getWatchlist();
    const bySymbol = new Map<string, WatchlistItemRow>();
    for (const item of existing) {
      bySymbol.set(item.symbol, item);
    }

    const nextList: WatchlistItemRow[] = [];
    const seen = new Set<string>();

    for (const raw of orderedSymbols) {
      const sym = raw.trim().toUpperCase();
      const item = bySymbol.get(sym);
      if (item && !seen.has(sym)) {
        seen.add(sym);
        nextList.push(item);
      }
    }

    // 保留未出现在 orderedSymbols 中的既有条目，避免误丢数据
    for (const item of existing) {
      if (!seen.has(item.symbol)) {
        nextList.push(item);
      }
    }

    nextList.forEach((item, index) => {
      this.db.upsertWatchlistItem({
        ...item,
        sortOrder: index,
      });
    });

    return this.db.getWatchlist();
  }

  update(input: WatchlistUpdateInput): WatchlistItemRow[] {
    const symbol = input.symbol.trim().toUpperCase();
    const existing = this.db.getWatchlist();
    const target = existing.find((item) => item.symbol === symbol);
    if (!target) {
      throw new Error(`自选股中未找到标的：${symbol}`);
    }

    let nextThresholdsJson = target.customThresholdsJson;
    if (input.customThresholds !== undefined) {
      const sanitized = sanitizeWatchlistThresholds(input.customThresholds);
      nextThresholdsJson = sanitized ? JSON.stringify(sanitized) : null;
    }

    this.db.upsertWatchlistItem({
      ...target,
      alertEnabled:
        typeof input.alertEnabled === 'boolean' ? input.alertEnabled : target.alertEnabled,
      customThresholdsJson: nextThresholdsJson,
    });
    return this.db.getWatchlist();
  }
}
