import {
  ALLOWED_SLOPE_WINDOWS,
  CORE_INDEX_SYMBOLS,
  DEFAULT_POLLING_INTERVAL_SEC,
  MAX_POLLING_INTERVAL_SEC,
  MIN_POLLING_INTERVAL_SEC,
  SETTING_MONITOR_CONFIG,
  normalizeEnabledCoreIndices,
  normalizeEnabledOptionalIndices,
} from '../../shared/constants';
import type { AlertMatchModeType, MonitorConfig, SlopeWindowOption } from '../../shared/types';
import type { AppDatabase } from './database';

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  pollingIntervalSec: DEFAULT_POLLING_INTERVAL_SEC,
  expandThresholdPct: 5,
  shrinkThresholdPct: -5,
  slopeWindow: 5,
  alertsEnabled: true,
  surgeSlopeThreshold: 3.0,
  surgeMultipleThreshold: 1.5,
  shrinkSlopeThreshold: -3.0,
  shrinkMultipleThreshold: 0.65,
  matchMode: 'AND',
  cooldownMinutes: 5,
  enabledCoreIndices: [...CORE_INDEX_SYMBOLS],
  enabledOptionalIndices: [],
};

function clampNumber(value: unknown, min: number, max: number, fallback: number, digits = 2): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = Math.max(min, Math.min(max, value));
  const factor = 10 ** digits;
  return Math.round(clamped * factor) / factor;
}

function clampNegative(value: unknown, min: number, max: number, fallback: number, digits = 2): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const negativeVal = value > 0 ? -value : value;
  return clampNumber(negativeVal, min, max, fallback, digits);
}

function normalizeSlopeWindow(value: unknown, fallback: SlopeWindowOption): SlopeWindowOption {
  if (typeof value === 'number' && (ALLOWED_SLOPE_WINDOWS as readonly number[]).includes(value)) {
    return value as SlopeWindowOption;
  }
  return fallback;
}

function normalizeMatchMode(value: unknown, fallback: AlertMatchModeType): AlertMatchModeType {
  return value === 'AND' || value === 'OR' ? value : fallback;
}

/** 校验并规范化监控与告警全局配置 */
export function sanitizeMonitorConfig(
  raw: Partial<MonitorConfig> | null | undefined,
  base: MonitorConfig = DEFAULT_MONITOR_CONFIG
): MonitorConfig {
  const src = raw ?? {};
  return {
    pollingIntervalSec: Math.round(
      clampNumber(
        src.pollingIntervalSec,
        MIN_POLLING_INTERVAL_SEC,
        MAX_POLLING_INTERVAL_SEC,
        base.pollingIntervalSec,
        0
      )
    ),
    expandThresholdPct: clampNumber(src.expandThresholdPct, 0.5, 100, base.expandThresholdPct, 1),
    shrinkThresholdPct: clampNegative(src.shrinkThresholdPct, -100, -0.5, base.shrinkThresholdPct, 1),
    slopeWindow: normalizeSlopeWindow(src.slopeWindow, base.slopeWindow),
    alertsEnabled: typeof src.alertsEnabled === 'boolean' ? src.alertsEnabled : base.alertsEnabled,
    surgeSlopeThreshold: clampNumber(
      src.surgeSlopeThreshold,
      0.1,
      50,
      base.surgeSlopeThreshold,
      2
    ),
    surgeMultipleThreshold: clampNumber(
      src.surgeMultipleThreshold,
      1.05,
      20,
      base.surgeMultipleThreshold,
      2
    ),
    shrinkSlopeThreshold: clampNegative(
      src.shrinkSlopeThreshold,
      -50,
      -0.1,
      base.shrinkSlopeThreshold,
      2
    ),
    shrinkMultipleThreshold: clampNumber(
      src.shrinkMultipleThreshold,
      0.05,
      0.95,
      base.shrinkMultipleThreshold,
      2
    ),
    matchMode: normalizeMatchMode(src.matchMode, base.matchMode),
    cooldownMinutes: Math.round(clampNumber(src.cooldownMinutes, 1, 120, base.cooldownMinutes, 0)),
    enabledCoreIndices: Array.isArray(src.enabledCoreIndices)
      ? normalizeEnabledCoreIndices(src.enabledCoreIndices)
      : normalizeEnabledCoreIndices(base.enabledCoreIndices),
    enabledOptionalIndices: Array.isArray(src.enabledOptionalIndices)
      ? normalizeEnabledOptionalIndices(src.enabledOptionalIndices)
      : normalizeEnabledOptionalIndices(base.enabledOptionalIndices),
  };
}

/**
 * 监控与告警参数持久化仓库（存入 SQLite app_settings 表）。
 */
export class MonitorSettingsStore {
  private readonly db: AppDatabase;

  constructor(db: AppDatabase) {
    this.db = db;
  }

  load(): MonitorConfig {
    const stored = this.db.getSetting<Partial<MonitorConfig>>(SETTING_MONITOR_CONFIG);
    return sanitizeMonitorConfig(stored, DEFAULT_MONITOR_CONFIG);
  }

  update(patch: Partial<MonitorConfig>): MonitorConfig {
    const current = this.load();
    const next = sanitizeMonitorConfig(patch, current);
    this.db.setSetting(SETTING_MONITOR_CONFIG, next);
    return next;
  }
}
