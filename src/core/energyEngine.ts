/**
 * 统一能量计算引擎（纯 TypeScript，零 IO）
 *
 * 适用于沪深两市聚合（MARKET_TOTAL）、四大核心指数及任意自选个股。
 * 所有数学公式严格对齐 docs/PLAN.md §2.3：
 * - 未闭合分钟线性插值对齐昨日同期：A_prev_aligned(t) = A_prev(t-1) + (s / 60) * Δa_prev(t)
 * - 同比差额 ΔA(t) = A_today(t) - A_prev_aligned(t)
 * - 同比变化率 R(t) = ΔA(t) / A_prev_aligned(t)（仅当分母 > 0）
 * - 全天预测成交额（多日分时占比模板 + 剩余时段贝叶斯收缩）：
 *   Â_full(t) = A_today(t) + (α(t) * r(t) + (1 - α(t))) * Ā_full * (1 - w(t))，α(t) = w(t) / (w(t) + λ)
 * - 放/平/缩量状态：R(t)*100 >= +5% 放量，<= -5% 缩量，其余平量，不可计算为 UNAVAILABLE
 * - 滚动区间增量倍数 M_W(t) 与边际量比偏离 D_W(t) = (M_W(t) - 1) * 100%
 * - 边际量比趋势斜率 S_W(t)：对窗口 [t-W+1, t]（t >= W，全程不含 09:25 集合竞价）的 {(k, D_W(k))} 做 OLS 回归
 */

export type VolumeState = 'EXPANDING' | 'FLAT' | 'SHRINKING' | 'UNAVAILABLE';

export interface MinuteTurnoverPoint {
  readonly minuteIndex: number;
  /** 截至该分钟的累计成交额（人民币元） */
  readonly cumTurnover: number;
}

/** 单个历史完整交易日输入（用于构建多日分时占比模板） */
export interface HistoricalDaySeries {
  readonly bars: readonly MinuteTurnoverPoint[];
  readonly auctionTurnover?: number | null;
}

/** 多日平均分时成交占比模板（消除单日开盘异常对全天预测的扰动） */
export interface IntradayPredictionProfile {
  /** 实际参与平均的历史完整交易日数 */
  readonly sampleDays: number;
  /** 样本日全天成交额均值（元） */
  readonly avgFullDayTurnover: number;
  /** 样本日 09:25 竞价占全天比例均值（无竞价样本时为 null） */
  readonly avgAuctionShare: number | null;
  /** 每分钟（0..239）平均累计占比 w(k) ∈ (0, 1]，单调非降且 w(239)=1 */
  readonly minuteShares: ReadonlyMap<number, number>;
}

/** 全天预测剩余时段贝叶斯收缩默认先验强度 λ（等效 ~12% 全天成交量） */
export const DEFAULT_PREDICTION_PRIOR_STRENGTH = 0.12;

export interface EnergyEngineConfig {
  /** 放量阈值（百分比数值，默认 5 即 +5%） */
  readonly expandThresholdPct: number;
  /** 缩量阈值（百分比数值，默认 -5 即 -5%） */
  readonly shrinkThresholdPct: number;
  /** 滚动斜率与区间增量倍数窗口长度 W（分钟，默认 5，可选 3/5/10） */
  readonly slopeWindow: number;
  /** 全天预测贝叶斯收缩先验强度 λ（默认 0.12；传 0 可退化为无收缩直接外推） */
  readonly predictionPriorStrength?: number;
}

export const DEFAULT_ENERGY_CONFIG: EnergyEngineConfig = {
  expandThresholdPct: 5,
  shrinkThresholdPct: -5,
  slopeWindow: 5,
  predictionPriorStrength: DEFAULT_PREDICTION_PRIOR_STRENGTH,
};

export interface EnergyEvaluationInput {
  /** 今日连续交易分钟序列（仅含 minuteIndex 0..239，不含 09:25 竞价锚点） */
  readonly todaySeries: readonly MinuteTurnoverPoint[];
  /** 上一交易日连续交易分钟序列（0..239） */
  readonly prevSeries: readonly MinuteTurnoverPoint[];
  /** 当前评估的连续交易分钟索引 t ∈ [0, 239] */
  readonly minuteIndex: number;
  /** 盘中未闭合分钟的实时累计成交额（元）；省略时从 todaySeries[minuteIndex] 读取 */
  readonly currentTodayCumTurnover?: number | null;
  /** 当前分钟已过秒数 s ∈ [0, 60]；默认 60 表示该分钟已闭合 */
  readonly elapsedSeconds?: number;
  /** 上一交易日全天总成交额（元）；在无多日预测模板时用作单日回退基线 */
  readonly prevFullDayTurnover?: number | null;
  /** 昨日 09:25 开盘集合竞价成交额（元），仅用于 t=0 未闭合分钟插值基准（不进入斜率窗口） */
  readonly prevAuctionTurnover?: number | null;
  /** 多日平均分时成交占比模板（可选；缺失时自动回退至昨日单日占比 + 贝叶斯收缩） */
  readonly predictionProfile?: IntradayPredictionProfile | null;
  /** 阈值与窗口配置（可选，缺省使用默认参数） */
  readonly config?: Partial<EnergyEngineConfig>;
}

export interface EnergyMetrics {
  readonly minuteIndex: number;
  readonly elapsedSeconds: number;
  readonly todayCumTurnover: number | null;
  readonly prevAlignedCumTurnover: number | null;
  /** 同比差额 ΔA(t)（元），无法计算时为 null */
  readonly cumDiff: number | null;
  /** 同比变化率 R(t)（小数形式，如 +0.12 表示 +12%），无法计算时为 null */
  readonly cumRatio: number | null;
  /** 同比变化率百分比 R(t) * 100（如 +12），无法计算时为 null */
  readonly cumRatioPct: number | null;
  /** 全天预测成交额 Â_full(t)（元），采用多日分时占比 + 剩余时段贝叶斯收缩 */
  readonly predictedFullDayTurnover: number | null;
  readonly volumeState: VolumeState;
  /** 边际量比趋势斜率 S_W(t)（百分点/分钟），对最近 W 个连续时刻的 D_W(k) 做 OLS 回归 */
  readonly slope: number | null;
  /** 滚动区间增量倍数 M_W(t)（倍），分母 <= 0 或窗口点缺失时为 null */
  readonly windowMultiple: number | null;
  /** 滚动边际量比偏离 D_W(t) = (M_W(t) - 1) * 100（百分比），无法计算时为 null */
  readonly windowDeviationPct: number | null;
  readonly slopeWindow: number;
}

function isValidNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function toTurnoverMap(series: readonly MinuteTurnoverPoint[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const p of series) {
    if (
      Number.isInteger(p.minuteIndex) &&
      p.minuteIndex >= 0 &&
      p.minuteIndex <= 239 &&
      isValidNumber(p.cumTurnover) &&
      p.cumTurnover >= 0
    ) {
      map.set(p.minuteIndex, p.cumTurnover);
    }
  }
  return map;
}

/**
 * 从最近 N 个历史完整交易日构建多日平均分时成交占比模板。
 * - 严格要求历史日具备完整 240 根连续分钟（0..239）且收盘累计成交额 > 0，防止残缺日污染曲线或造成上午预测缺失
 * - 无有效完整历史日时返回 null（调用方自动回退昨日单日基线）
 */
export function buildPredictionProfile(
  days: readonly HistoricalDaySeries[]
): IntradayPredictionProfile | null {
  const validDays: Array<{
    map: Map<number, number>;
    fullDayTurnover: number;
    auctionShare: number | null;
  }> = [];

  for (const day of days) {
    const map = toTurnoverMap(day.bars);
    if (map.size < 240) {
      continue;
    }
    const fullDayTurnover = map.get(239);
    const firstMinTurnover = map.get(0);
    if (
      fullDayTurnover === undefined ||
      fullDayTurnover <= 0 ||
      firstMinTurnover === undefined
    ) {
      continue;
    }
    const auctionShare =
      isValidNumber(day.auctionTurnover) && day.auctionTurnover >= 0
        ? Math.min(firstMinTurnover / fullDayTurnover, Math.min(1, day.auctionTurnover / fullDayTurnover))
        : null;
    validDays.push({ map, fullDayTurnover, auctionShare });
  }

  if (validDays.length === 0) {
    return null;
  }

  const avgFullDayTurnover =
    validDays.reduce((sum, d) => sum + d.fullDayTurnover, 0) / validDays.length;

  const minuteShares = new Map<number, number>();
  let runningMaxShare = 0;

  for (let m = 0; m <= 239; m++) {
    let sumShare = 0;
    let count = 0;
    for (const d of validDays) {
      const val = d.map.get(m);
      if (val !== undefined) {
        sumShare += Math.max(0, Math.min(1, val / d.fullDayTurnover));
        count += 1;
      }
    }
    if (count > 0) {
      const avg = m === 239 ? 1 : Math.max(runningMaxShare, Math.min(1, sumShare / count));
      runningMaxShare = avg;
      minuteShares.set(m, avg);
    }
  }

  const auctionShares = validDays
    .map((d) => d.auctionShare)
    .filter((s): s is number => s !== null);
  const firstMinAvgShare = minuteShares.get(0) ?? 1;
  const avgAuctionShare =
    auctionShares.length > 0
      ? Math.min(
          firstMinAvgShare,
          auctionShares.reduce((sum, s) => sum + s, 0) / auctionShares.length
        )
      : null;

  return {
    sampleDays: validDays.length,
    avgFullDayTurnover,
    avgAuctionShare,
    minuteShares,
  };
}

/** 对齐多日预测模板在时刻 t（已过 s 秒）的累计成交占比 w(t) */
function alignProfileShare(
  profile: IntradayPredictionProfile,
  minuteIndex: number,
  elapsedSeconds: number
): number | null {
  if (!isValidNumber(elapsedSeconds)) return null;
  const shareAtT = profile.minuteShares.get(minuteIndex);
  if (shareAtT === undefined || shareAtT <= 0) return null;

  const clampedSeconds = Math.max(0, Math.min(60, elapsedSeconds));
  if (clampedSeconds >= 60) {
    return shareAtT;
  }

  let baseShare: number;
  if (minuteIndex === 0) {
    if (profile.avgAuctionShare === null) return null;
    baseShare = profile.avgAuctionShare;
  } else {
    const prevShare = profile.minuteShares.get(minuteIndex - 1);
    if (prevShare === undefined) return null;
    baseShare = prevShare;
  }

  const delta = Math.max(0, shareAtT - baseShare);
  const aligned = baseShare + (clampedSeconds / 60) * delta;
  return aligned > 0 ? Math.min(1, aligned) : null;
}

/**
 * 贝叶斯收缩全天预测公式：
 * - 已成交部分直接保留 A_today(t)
 * - 剩余部分按置信权重 α(t) = w(t) / (w(t) + λ) 在实时倍率 r(t) 与稳态基线 1.0 之间平滑收缩
 * - w(t) = 1（收盘）时严格等于 A_today(t)；r(t) = 1（平量）时严格等于基线全天额
 */
export function computeBayesianFullDayPrediction(params: {
  todayCumTurnover: number;
  baselineFullDayTurnover: number;
  alignedShare: number;
  priorStrength?: number;
}): number | null {
  const { todayCumTurnover, baselineFullDayTurnover, alignedShare } = params;
  const lambda =
    isValidNumber(params.priorStrength) && params.priorStrength >= 0
      ? params.priorStrength
      : DEFAULT_PREDICTION_PRIOR_STRENGTH;

  if (
    !isValidNumber(todayCumTurnover) ||
    todayCumTurnover < 0 ||
    !isValidNumber(baselineFullDayTurnover) ||
    baselineFullDayTurnover <= 0 ||
    !isValidNumber(alignedShare) ||
    alignedShare <= 0
  ) {
    return null;
  }

  const w = Math.min(1, alignedShare);
  if (w >= 1) {
    return todayCumTurnover;
  }

  const expectedSoFar = baselineFullDayTurnover * w;
  if (expectedSoFar <= 0) return null;

  const observedRatio = todayCumTurnover / expectedSoFar;
  const alpha = w + lambda > 0 ? w / (w + lambda) : 1;
  const effectiveRemainingRatio = alpha * observedRatio + (1 - alpha);
  const remainingBase = baselineFullDayTurnover * (1 - w);

  return todayCumTurnover + Math.max(0, effectiveRemainingRatio) * remainingBase;
}

/**
 * 普通最小二乘（OLS）线性回归斜率。
 * 点集不足 2 个或 x 方差为 0 时返回 null。
 */
export function computeOlsSlope(points: ReadonlyArray<readonly [number, number]>): number | null {
  const n = points.length;
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    const dx = x - meanX;
    numerator += dx * (y - meanY);
    denominator += dx * dx;
  }

  if (denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * 对齐昨日同期累计成交额：
 * - elapsedSeconds >= 60：直接返回 A_prev(t)
 * - elapsedSeconds ∈ [0, 60)：采用 A_prev(t-1) + (s / 60) * Δa_prev(t) 线性插值
 * - 任一所需基线缺失时返回 null（绝不补零）
 */
export function alignPrevCumTurnover(
  prevMap: ReadonlyMap<number, number>,
  minuteIndex: number,
  elapsedSeconds: number,
  prevAuctionTurnover?: number | null
): number | null {
  if (!isValidNumber(elapsedSeconds)) return null;

  const prevAtT = prevMap.get(minuteIndex);
  if (prevAtT === undefined) return null;

  const clampedSeconds = Math.max(0, Math.min(60, elapsedSeconds));
  if (clampedSeconds >= 60) {
    return prevAtT;
  }

  let prevBase: number;
  if (minuteIndex === 0) {
    // 昨日 09:25 集合竞价基准缺失时不静默补零，防止开盘第一分钟产生严重假放量
    if (!isValidNumber(prevAuctionTurnover) || prevAuctionTurnover < 0) {
      return null;
    }
    prevBase = prevAuctionTurnover;
  } else {
    const prevAtPrevMinute = prevMap.get(minuteIndex - 1);
    if (prevAtPrevMinute === undefined) {
      return null;
    }
    prevBase = prevAtPrevMinute;
  }

  const delta = Math.max(0, prevAtT - prevBase);
  return prevBase + (clampedSeconds / 60) * delta;
}

/**
 * 计算时刻 k 的滚动边际量比倍数 M_W(k)：
 * - k < 1 返回 null（第 0 分钟混有 09:25 集合竞价，不进入边际量比曲线）
 * - k >= W 时取满窗口增量 A(k) - A(k - W)
 * - 1 <= k < W 时取纯连续竞价前缀增量 A(k) - A(0)，彻底剔除 09:25 竞价污染
 */
function computeWindowMultipleAt(params: {
  todayMap: ReadonlyMap<number, number>;
  prevMap: ReadonlyMap<number, number>;
  k: number;
  window: number;
  todayOverride?: number | null;
  prevOverride?: number | null;
}): number | null {
  const { todayMap, prevMap, k, window, todayOverride, prevOverride } = params;
  if (!Number.isInteger(window) || window < 1 || k < 1) return null;

  const anchorIndex = k >= window ? k - window : 0;
  const todayVal = todayOverride !== undefined ? todayOverride : todayMap.get(k) ?? null;
  const prevVal = prevOverride !== undefined ? prevOverride : prevMap.get(k) ?? null;
  const todayAnchor = todayMap.get(anchorIndex);
  const prevAnchor = prevMap.get(anchorIndex);

  if (
    todayVal === null ||
    prevVal === null ||
    todayAnchor === undefined ||
    prevAnchor === undefined
  ) {
    return null;
  }

  const todayDelta = todayVal - todayAnchor;
  const prevDelta = prevVal - prevAnchor;
  if (prevDelta <= 0 || todayDelta < 0) {
    return null;
  }
  return todayDelta / prevDelta;
}

/**
 * 计算单个标的（大盘聚合、四大指数或任意个股）在指定时刻的能量指标。
 */
export function evaluateEnergy(input: EnergyEvaluationInput): EnergyMetrics {
  const cfg: EnergyEngineConfig = {
    expandThresholdPct: input.config?.expandThresholdPct ?? DEFAULT_ENERGY_CONFIG.expandThresholdPct,
    shrinkThresholdPct: input.config?.shrinkThresholdPct ?? DEFAULT_ENERGY_CONFIG.shrinkThresholdPct,
    slopeWindow: input.config?.slopeWindow ?? DEFAULT_ENERGY_CONFIG.slopeWindow,
    predictionPriorStrength:
      input.config?.predictionPriorStrength ?? DEFAULT_PREDICTION_PRIOR_STRENGTH,
  };

  const t = input.minuteIndex;
  const rawElapsed = input.elapsedSeconds ?? 60;
  const hasValidElapsed = isValidNumber(rawElapsed);
  const elapsedSeconds = hasValidElapsed ? Math.max(0, Math.min(60, rawElapsed)) : 0;
  const todayMap = toTurnoverMap(input.todaySeries);
  const prevMap = toTurnoverMap(input.prevSeries);

  const todayAtT =
    input.currentTodayCumTurnover !== undefined
      ? isValidNumber(input.currentTodayCumTurnover) && input.currentTodayCumTurnover >= 0
        ? input.currentTodayCumTurnover
        : null
      : todayMap.get(t) ?? null;

  const prevAlignedAtT = hasValidElapsed
    ? alignPrevCumTurnover(prevMap, t, elapsedSeconds, input.prevAuctionTurnover)
    : null;

  let cumDiff: number | null = null;
  let cumRatio: number | null = null;
  let cumRatioPct: number | null = null;
  let predictedFullDayTurnover: number | null = null;
  let volumeState: VolumeState = 'UNAVAILABLE';

  if (todayAtT !== null && prevAlignedAtT !== null && prevAlignedAtT > 0) {
    cumDiff = todayAtT - prevAlignedAtT;
    cumRatio = cumDiff / prevAlignedAtT;
    cumRatioPct = cumRatio * 100;

    if (cumRatioPct >= cfg.expandThresholdPct) {
      volumeState = 'EXPANDING';
    } else if (cumRatioPct <= cfg.shrinkThresholdPct) {
      volumeState = 'SHRINKING';
    } else {
      volumeState = 'FLAT';
    }
  }

  // 全天预测成交额：优先采用多日分时占比模板 + 剩余时段贝叶斯收缩；模板无法对齐当前分钟/秒数时无缝回退至昨日单日占比 + 贝叶斯收缩
  if (todayAtT !== null && hasValidElapsed) {
    if (input.predictionProfile && input.predictionProfile.sampleDays > 0) {
      const profileShare = alignProfileShare(input.predictionProfile, t, elapsedSeconds);
      if (profileShare !== null) {
        predictedFullDayTurnover = computeBayesianFullDayPrediction({
          todayCumTurnover: todayAtT,
          baselineFullDayTurnover: input.predictionProfile.avgFullDayTurnover,
          alignedShare: profileShare,
          priorStrength: cfg.predictionPriorStrength,
        });
      }
    }
    if (
      predictedFullDayTurnover === null &&
      prevAlignedAtT !== null &&
      prevAlignedAtT > 0 &&
      isValidNumber(input.prevFullDayTurnover) &&
      input.prevFullDayTurnover > 0
    ) {
      const singleDayShare = Math.min(1, prevAlignedAtT / input.prevFullDayTurnover);
      predictedFullDayTurnover = computeBayesianFullDayPrediction({
        todayCumTurnover: todayAtT,
        baselineFullDayTurnover: input.prevFullDayTurnover,
        alignedShare: singleDayShare,
        priorStrength: cfg.predictionPriorStrength,
      });
    }
  }

  const W = cfg.slopeWindow;

  // 指标 A：滚动区间增量倍数 M_W(t)（仅 t >= W 满窗口输出）与边际量比偏离 D_W(t)
  let windowMultiple: number | null = null;
  if (Number.isInteger(W) && W >= 1 && t >= W) {
    windowMultiple = computeWindowMultipleAt({
      todayMap,
      prevMap,
      k: t,
      window: W,
      todayOverride: todayAtT,
      prevOverride: prevAlignedAtT,
    });
  }

  // 对 t ∈ [1, W-1] 也可给出纯连续竞价前缀偏离用于图表连贯绘制；对 t >= W 严格等于 (M_W(t) - 1) * 100
  let windowDeviationPct: number | null = null;
  if (windowMultiple !== null) {
    windowDeviationPct = (windowMultiple - 1) * 100;
  } else if (Number.isInteger(W) && W >= 1 && t >= 1 && t < W) {
    const prefixMult = computeWindowMultipleAt({
      todayMap,
      prevMap,
      k: t,
      window: W,
      todayOverride: todayAtT,
      prevOverride: prevAlignedAtT,
    });
    if (prefixMult !== null) {
      windowDeviationPct = (prefixMult - 1) * 100;
    }
  }

  // 指标 B：边际量比趋势斜率 S_W(t) — 对最近 W 个连续时刻 [t - W + 1, t] 的 D_W(k) 做 OLS 线性回归
  let slope: number | null = null;
  if (Number.isInteger(W) && W >= 2 && t >= W) {
    const windowPoints: Array<[number, number]> = [];
    let allValid = true;
    for (let k = t - W + 1; k <= t; k++) {
      const mult =
        k === t
          ? windowMultiple
          : computeWindowMultipleAt({
              todayMap,
              prevMap,
              k,
              window: W,
            });
      if (mult === null) {
        allValid = false;
        break;
      }
      windowPoints.push([k, (mult - 1) * 100]);
    }
    if (allValid && windowPoints.length === W) {
      slope = computeOlsSlope(windowPoints);
    }
  }

  return {
    minuteIndex: t,
    elapsedSeconds,
    todayCumTurnover: todayAtT,
    prevAlignedCumTurnover: prevAlignedAtT,
    cumDiff,
    cumRatio,
    cumRatioPct,
    predictedFullDayTurnover,
    volumeState,
    slope,
    windowMultiple,
    windowDeviationPct,
    slopeWindow: W,
  };
}

/**
 * 批量计算今日已闭合分钟序列（0..lastMinuteIndex）的完整能量指标曲线，供图表渲染与复盘使用。
 */
export function evaluateEnergySeries(params: {
  readonly todaySeries: readonly MinuteTurnoverPoint[];
  readonly prevSeries: readonly MinuteTurnoverPoint[];
  readonly prevFullDayTurnover?: number | null;
  readonly prevAuctionTurnover?: number | null;
  readonly predictionProfile?: IntradayPredictionProfile | null;
  readonly config?: Partial<EnergyEngineConfig>;
}): EnergyMetrics[] {
  const sortedIndices = [...new Set(params.todaySeries.map((p) => p.minuteIndex))]
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx <= 239)
    .sort((a, b) => a - b);

  return sortedIndices.map((minuteIndex) =>
    evaluateEnergy({
      todaySeries: params.todaySeries,
      prevSeries: params.prevSeries,
      minuteIndex,
      elapsedSeconds: 60,
      prevFullDayTurnover: params.prevFullDayTurnover,
      prevAuctionTurnover: params.prevAuctionTurnover,
      predictionProfile: params.predictionProfile,
      config: params.config,
    })
  );
}
