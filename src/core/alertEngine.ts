import type { AlertDirection, AlertEventInput } from '../shared/types';
import type { EnergyMetrics } from './energyEngine';

/**
 * 快速放量 / 快速缩量告警引擎（纯 TypeScript，零 IO、零系统时钟依赖）
 *
 * 规则严格对齐 docs/PLAN.md §2.3 与 Phase 2 Spec：
 * - 冷启动保护：minuteIndex < 5（09:30–09:34）不触发；09:35（minuteIndex = 5）起可触发。
 * - 快速放量（SURGE）：边际量比斜率 S_W(t) >= +3.0%/min 且/或 M_W(t) >= 1.5x（默认 AND）。
 * - 快速缩量（SHRINK）：边际量比斜率 S_W(t) <= -3.0%/min 且/或 M_W(t) <= 0.65x（默认 AND）。
 * - 任一核心指标不可用（null）或标的处于 degraded 状态时不触发。
 * - 全局默认阈值可被单个标的覆写（开关、阈值、窗口、匹配模式、冷却时长）。
 * - 冷却防抖按 (symbol, direction) 独立计时（默认 5 分钟），反方向可即时触发。
 */

export type AlertMatchMode = 'AND' | 'OR';

export interface AlertRuleConfig {
  readonly enabled: boolean;
  /** 快速放量斜率阈值（百分点/分钟，默认 +1.2） */
  readonly surgeSlopeThreshold: number;
  /** 快速放量区间增量倍数阈值（默认 1.5） */
  readonly surgeMultipleThreshold: number;
  /** 快速缩量斜率阈值（百分点/分钟，默认 -1.2） */
  readonly shrinkSlopeThreshold: number;
  /** 快速缩量区间增量倍数阈值（默认 0.65） */
  readonly shrinkMultipleThreshold: number;
  /** 双指标组合方式：AND（默认）或 OR */
  readonly matchMode: AlertMatchMode;
  /** 同标的同方向冷却时间（分钟，默认 5） */
  readonly cooldownMinutes: number;
  /** 开盘冷启动保护分钟数（默认 5，即 minuteIndex < 5 抑制） */
  readonly coldStartMinutes: number;
  /** 该标的对应的斜率窗口长度（分钟，默认 5） */
  readonly slopeWindow: number;
}

export type SymbolAlertOverride = Partial<AlertRuleConfig>;

export const DEFAULT_ALERT_CONFIG: AlertRuleConfig = {
  enabled: true,
  surgeSlopeThreshold: 3.0,
  surgeMultipleThreshold: 1.5,
  shrinkSlopeThreshold: -3.0,
  shrinkMultipleThreshold: 0.65,
  matchMode: 'AND',
  cooldownMinutes: 5,
  coldStartMinutes: 5,
  slopeWindow: 5,
};

export interface AlertEvaluationInput {
  readonly symbol: string;
  readonly name: string;
  readonly tradeDate: string;
  readonly timestampMs: number;
  readonly metrics: EnergyMetrics;
  /** 标的数据是否处于降级/缺失状态（如 MARKET_TOTAL 单边缺失） */
  readonly degraded?: boolean;
  /** 单股覆写配置（可选） */
  readonly symbolOverride?: SymbolAlertOverride | null;
}

export type AlertSkipReason =
  | 'DISABLED'
  | 'DEGRADED'
  | 'COLD_START'
  | 'WINDOW_MISMATCH'
  | 'METRICS_UNAVAILABLE'
  | 'NO_SIGNAL'
  | 'COOLDOWN';

export interface AlertEvaluationResult {
  readonly triggered: boolean;
  readonly event: AlertEventInput | null;
  readonly direction: AlertDirection | null;
  readonly skipReason: AlertSkipReason | null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function stripUndefined<T extends object>(obj?: Partial<T> | null): Partial<T> {
  if (!obj) return {};
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/**
 * 合并全局默认配置与单股覆写配置（自动忽略显式 undefined 字段，避免覆盖默认值）。
 */
export function resolveAlertConfig(
  globalConfig: Partial<AlertRuleConfig> = {},
  symbolOverride?: SymbolAlertOverride | null
): AlertRuleConfig {
  return {
    ...DEFAULT_ALERT_CONFIG,
    ...stripUndefined(globalConfig),
    ...stripUndefined(symbolOverride),
  };
}

function formatAlertMessage(
  name: string,
  direction: AlertDirection,
  slope: number,
  windowMultiple: number
): string {
  const dirLabel = direction === 'SURGE' ? '快速放量' : '快速缩量';
  const slopeSign = slope >= 0 ? '+' : '';
  return `${name}${dirLabel}：斜率 ${slopeSign}${slope.toFixed(2)}%/分，区间量比 ${windowMultiple.toFixed(2)}x`;
}

/**
 * 状态化冷却告警引擎（所有时间戳均由调用方显式传入，无系统时钟依赖）。
 */
export class AlertEngine {
  private globalConfig: AlertRuleConfig;
  private readonly cooldowns = new Map<string, number>();

  constructor(globalConfig: Partial<AlertRuleConfig> = {}) {
    this.globalConfig = resolveAlertConfig(globalConfig);
  }

  updateGlobalConfig(nextConfig: Partial<AlertRuleConfig>): void {
    this.globalConfig = resolveAlertConfig({ ...this.globalConfig, ...nextConfig });
  }

  getGlobalConfig(): AlertRuleConfig {
    return this.globalConfig;
  }

  resetCooldowns(): void {
    this.cooldowns.clear();
  }

  private getCooldownKey(symbol: string, direction: AlertDirection): string {
    return `${symbol}:${direction}`;
  }

  isInCooldown(
    symbol: string,
    direction: AlertDirection,
    timestampMs: number,
    cooldownMinutes: number
  ): boolean {
    const lastMs = this.cooldowns.get(this.getCooldownKey(symbol, direction));
    if (lastMs === undefined) return false;
    return timestampMs - lastMs < cooldownMinutes * 60_000;
  }

  /**
   * 评估当前标的能量指标是否触发快速放量 / 快速缩量告警。
   */
  evaluate(input: AlertEvaluationInput): AlertEvaluationResult {
    const cfg = resolveAlertConfig(this.globalConfig, input.symbolOverride);

    if (!cfg.enabled) {
      return { triggered: false, event: null, direction: null, skipReason: 'DISABLED' };
    }

    if (input.degraded) {
      return { triggered: false, event: null, direction: null, skipReason: 'DEGRADED' };
    }

    const { metrics } = input;
    if (metrics.minuteIndex < cfg.coldStartMinutes) {
      return { triggered: false, event: null, direction: null, skipReason: 'COLD_START' };
    }

    // 校验评估指标所用的斜率窗口与当前生效配置（含单股覆写）一致
    if (metrics.slopeWindow !== cfg.slopeWindow) {
      return { triggered: false, event: null, direction: null, skipReason: 'WINDOW_MISMATCH' };
    }

    // 任一核心指标不可用（null 或非有限数值如 NaN/Infinity）时不触发
    if (
      !isFiniteNumber(metrics.slope) ||
      !isFiniteNumber(metrics.windowMultiple) ||
      !isFiniteNumber(metrics.cumRatio)
    ) {
      return { triggered: false, event: null, direction: null, skipReason: 'METRICS_UNAVAILABLE' };
    }

    const { slope, windowMultiple, cumRatio } = metrics;
    const surgeSlopeHit = slope >= cfg.surgeSlopeThreshold;
    const surgeMultHit = windowMultiple >= cfg.surgeMultipleThreshold;
    const surgeMatched =
      cfg.matchMode === 'AND' ? surgeSlopeHit && surgeMultHit : surgeSlopeHit || surgeMultHit;

    const shrinkSlopeHit = slope <= cfg.shrinkSlopeThreshold;
    const shrinkMultHit = windowMultiple <= cfg.shrinkMultipleThreshold;
    const shrinkMatched =
      cfg.matchMode === 'AND' ? shrinkSlopeHit && shrinkMultHit : shrinkSlopeHit || shrinkMultHit;

    let direction: AlertDirection | null = null;
    if (surgeMatched && !shrinkMatched) {
      direction = 'SURGE';
    } else if (shrinkMatched && !surgeMatched) {
      direction = 'SHRINK';
    } else if (surgeMatched && shrinkMatched) {
      // OR 模式下极端异常双边同时命中时按斜率方向裁决
      direction = slope >= 0 ? 'SURGE' : 'SHRINK';
    }

    if (!direction) {
      return { triggered: false, event: null, direction: null, skipReason: 'NO_SIGNAL' };
    }

    if (this.isInCooldown(input.symbol, direction, input.timestampMs, cfg.cooldownMinutes)) {
      return { triggered: false, event: null, direction, skipReason: 'COOLDOWN' };
    }

    this.cooldowns.set(this.getCooldownKey(input.symbol, direction), input.timestampMs);

    const event: AlertEventInput = {
      symbol: input.symbol,
      name: input.name,
      tradeDate: input.tradeDate,
      minuteIndex: metrics.minuteIndex,
      direction,
      slope,
      windowMultiple,
      cumRatio,
      message: formatAlertMessage(input.name, direction, slope, windowMultiple),
      createdAt: input.timestampMs,
    };

    return {
      triggered: true,
      event,
      direction,
      skipReason: null,
    };
  }
}
