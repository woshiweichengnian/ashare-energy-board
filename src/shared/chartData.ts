import { evaluateEnergySeries, type MinuteTurnoverPoint } from '../core/energyEngine';
import { minuteIndexToLabel } from '../core/tradingClock';
import {
  MARKET_TOTAL_SYMBOL,
  REPLAY_ALERT_PREFIX,
  SIMULATED_ALERT_PREFIX,
} from './constants';
import type {
  AlertDirection,
  AlertEventRow,
  IntradayBarRow,
  MarketDashboardState,
  SymbolEnergySnapshot,
} from './types';

export const CHART_SLOT_COUNT = 241; // 0 = 09:25 竞价锚点，1..240 = minuteIndex 0..239
export const LUNCH_DIVIDER_SLOT = 121; // minuteIndex 120 (13:00) 对应槽位

export interface ChartAlertMarker {
  slotIndex: number;
  minuteIndex: number;
  minuteLabel: string;
  direction: AlertDirection;
  /** 散点落在下图右轴主趋势线上的纵坐标（滚动边际量比偏离 %） */
  marginalDevPct: number;
  slope: number;
  windowMultiple: number;
  cumRatio: number;
  message: string;
  isSimulated: boolean;
  isReplay: boolean;
}

export interface EnergyChartDataset {
  symbol: string;
  name: string;
  tradeDate: string | null;
  prevTradeDate: string | null;
  /** 241 个横轴标签：['09:25', '09:30', ..., '11:29', '13:00', ..., '14:59'] */
  xLabels: string[];
  /** 今日累计成交额（元），槽位 0 为 09:25 竞价锚点，缺失保持 null */
  todayCum: Array<number | null>;
  /** 昨日累计成交额（元），槽位 0 为昨日 09:25 竞价锚点，缺失保持 null */
  prevCum: Array<number | null>;
  /** 叠加在右轴的价格 / 点位曲线（大盘总成交额自动参照上证指数点位） */
  priceSeries: Array<number | null>;
  priceSeriesName: string;
  /** 今日 1 分钟增量成交额（元），槽位 0 固定为 null */
  todayBar: Array<number | null>;
  /** 昨日 1 分钟增量成交额（元），槽位 0 固定为 null */
  prevBar: Array<number | null>;
  /** 滚动 W 分钟边际量比偏离 D_W(t) = (M_W(t) - 1) * 100（%），下图右轴主趋势线 */
  marginalDevSeries: Array<number | null>;
  /** 边际量比趋势斜率 S_W(t)（百分点/分钟），与后端告警引擎 100% 同源 */
  slopeSeries: Array<number | null>;
  /** 本机定制：逐分钟「今日累计成交额较昨日同一时刻」的百分比（%），即卡片「较昨日同期」的全天走势，缺失为 null */
  cumRatioPctSeries: Array<number | null>;
  slopeWindow: number;
  /** 09:25 开盘集合竞价锚点 */
  todayAuctionTurnover: number | null;
  prevAuctionTurnover: number | null;
  /** 当日该标的异动散点 */
  alertMarkers: ChartAlertMarker[];
  /** 是否存在任意可绘制的有效数据 */
  hasData: boolean;
  degraded: boolean;
  degradedReason: string | null;
}

const CACHED_X_LABELS: readonly string[] = (() => {
  const labels: string[] = ['09:25'];
  for (let i = 0; i < 240; i++) {
    labels.push(minuteIndexToLabel(i));
  }
  return labels;
})();

function isFinitePositiveOrZero(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function buildBarIncrements(
  cumArr: ReadonlyArray<number | null>,
  explicitBars: ReadonlyMap<number, number>
): Array<number | null> {
  const result = new Array<number | null>(CHART_SLOT_COUNT).fill(null);

  for (let m = 0; m < 240; m++) {
    const slot = m + 1;
    const explicit = explicitBars.get(m);
    const curCum = cumArr[slot];

    if (explicit !== undefined && isFinitePositiveOrZero(explicit)) {
      result[slot] = explicit;
    } else if (curCum !== null) {
      if (m === 0) {
        const auctionCum = cumArr[0];
        result[slot] = auctionCum !== null ? Math.max(0, curCum - auctionCum) : curCum;
      } else {
        // 仅当紧邻上一分钟存在有效累计额时才回退做差，绝不跨缺口把多分钟成交额虚增到单分钟柱上
        const prevSlotCum = cumArr[slot - 1];
        if (prevSlotCum !== null) {
          result[slot] = Math.max(0, curCum - prevSlotCum);
        }
      }
    }
  }
  return result;
}

function fillPriceFromBars(
  bars: readonly IntradayBarRow[],
  liveMinuteIndex: number | null,
  livePrice: number | null
): Array<number | null> {
  const prices = new Array<number | null>(CHART_SLOT_COUNT).fill(null);
  for (const b of bars) {
    if (b.minuteIndex >= 0 && b.minuteIndex <= 239 && Number.isFinite(b.price) && b.price > 0) {
      prices[b.minuteIndex + 1] = b.price;
    }
  }
  if (
    liveMinuteIndex !== null &&
    liveMinuteIndex >= 0 &&
    liveMinuteIndex <= 239 &&
    livePrice !== null &&
    Number.isFinite(livePrice) &&
    livePrice > 0
  ) {
    prices[liveMinuteIndex + 1] = livePrice;
  }
  return prices;
}

/**
 * 为详情浮层 ECharts 双图联动构造完整折叠时间轴数据集：
 * - 严格折叠 11:30–13:00 午休，09:25 集合竞价独立位于槽位 0，不混入斜率窗口
 * - 复用 src/core/energyEngine.ts 的 evaluateEnergySeries 保证斜率与后端告警引擎同源一致
 * - 缺失数据一律保持 null，绝不补零
 */
export function buildEnergyChartDataset(params: {
  market: MarketDashboardState | null;
  symbol: string;
  alerts: readonly AlertEventRow[];
  slopeWindow?: number;
}): EnergyChartDataset {
  const { market, symbol, alerts } = params;
  const xLabels = [...CACHED_X_LABELS];
  const emptyCum = () => new Array<number | null>(CHART_SLOT_COUNT).fill(null);

  if (!market) {
    return {
      symbol,
      name: symbol === MARKET_TOTAL_SYMBOL ? '沪深两市总成交额' : symbol,
      tradeDate: null,
      prevTradeDate: null,
      xLabels,
      todayCum: emptyCum(),
      prevCum: emptyCum(),
      priceSeries: emptyCum(),
      priceSeriesName: '价格',
      todayBar: emptyCum(),
      prevBar: emptyCum(),
      marginalDevSeries: emptyCum(),
      slopeSeries: emptyCum(),
      cumRatioPctSeries: emptyCum(),
      slopeWindow: params.slopeWindow ?? 5,
      todayAuctionTurnover: null,
      prevAuctionTurnover: null,
      alertMarkers: [],
      hasData: false,
      degraded: true,
      degradedReason: '行情数据初始化中',
    };
  }

  const todayCum = emptyCum();
  const prevCum = emptyCum();
  const todayExplicitBars = new Map<number, number>();
  const prevExplicitBars = new Map<number, number>();
  const todayPoints: MinuteTurnoverPoint[] = [];
  const prevPoints: MinuteTurnoverPoint[] = [];

  let name = symbol;
  let todayAuctionTurnover: number | null = null;
  let prevAuctionTurnover: number | null = null;
  let prevFullDayTurnover: number | null = null;
  let liveCumRatioPct: number | null = null;
  let slopeWindow = params.slopeWindow ?? 5;
  let degraded = false;
  let degradedReason: string | null = null;
  let priceSeries = emptyCum();
  let priceSeriesName = '分时价';
  let liveMetricsMinute: number | null = null;
  let liveMetricsSlope: number | null = null;
  let liveMetricsDevPct: number | null = null;

  if (symbol === MARKET_TOTAL_SYMBOL) {
    const total = market.marketTotal;
    name = '沪深两市总成交额';
    todayAuctionTurnover = total.auctionTurnover;
    prevAuctionTurnover = total.prevAuctionTurnover;
    prevFullDayTurnover = total.prevFullDayTurnover;
    liveCumRatioPct = total.metrics?.cumRatioPct ?? null;
    slopeWindow = params.slopeWindow ?? total.metrics?.slopeWindow ?? 5;
    degraded = total.degraded;
    degradedReason = total.degradedReason;

    if (isFinitePositiveOrZero(todayAuctionTurnover)) {
      todayCum[0] = todayAuctionTurnover;
    }
    if (isFinitePositiveOrZero(prevAuctionTurnover)) {
      prevCum[0] = prevAuctionTurnover;
    }

    for (const p of total.todaySeries) {
      if (p.minuteIndex >= 0 && p.minuteIndex <= 239 && isFinitePositiveOrZero(p.cumTurnover)) {
        todayCum[p.minuteIndex + 1] = p.cumTurnover;
        todayPoints.push({ minuteIndex: p.minuteIndex, cumTurnover: p.cumTurnover });
        if (isFinitePositiveOrZero(p.barTurnover)) {
          todayExplicitBars.set(p.minuteIndex, p.barTurnover);
        }
      }
    }

    for (const p of total.prevSeries) {
      if (p.minuteIndex >= 0 && p.minuteIndex <= 239 && isFinitePositiveOrZero(p.cumTurnover)) {
        prevCum[p.minuteIndex + 1] = p.cumTurnover;
        prevPoints.push({ minuteIndex: p.minuteIndex, cumTurnover: p.cumTurnover });
        if (isFinitePositiveOrZero(p.barTurnover)) {
          prevExplicitBars.set(p.minuteIndex, p.barTurnover);
        }
      }
    }

    // 盘中实时未闭合分钟点平滑追加
    if (
      total.metrics &&
      total.metrics.minuteIndex >= 0 &&
      total.metrics.minuteIndex <= 239 &&
      isFinitePositiveOrZero(total.metrics.todayCumTurnover)
    ) {
      const m = total.metrics.minuteIndex;
      todayCum[m + 1] = total.metrics.todayCumTurnover;
      liveMetricsMinute = m;
      liveMetricsSlope = total.metrics.slope;
      liveMetricsDevPct =
        total.metrics.windowDeviationPct ??
        (total.metrics.windowMultiple !== null ? (total.metrics.windowMultiple - 1) * 100 : null);
      const existingIdx = todayPoints.findIndex((p) => p.minuteIndex === m);
      if (existingIdx >= 0) {
        todayPoints[existingIdx] = { minuteIndex: m, cumTurnover: total.metrics.todayCumTurnover };
      } else {
        todayPoints.push({ minuteIndex: m, cumTurnover: total.metrics.todayCumTurnover });
      }
    }

    // 大盘总成交额右轴叠加「上证指数点位」作为大盘价格走势参照（即使上证指数卡片被隐藏仍保留）
    const shIndex = market.indices.find((i) => i.symbol === '000001.SH');
    if (shIndex) {
      priceSeriesName = '上证点位';
      priceSeries = fillPriceFromBars(
        shIndex.todaySeries,
        shIndex.metrics?.minuteIndex ?? null,
        shIndex.quote?.price ?? null
      );
    } else if (total.shReference) {
      priceSeriesName = '上证点位';
      priceSeries = fillPriceFromBars(
        total.shReference.todaySeries,
        total.shReference.minuteIndex,
        total.shReference.livePrice
      );
    }
  } else {
    const target: SymbolEnergySnapshot | undefined =
      market.indices.find((i) => i.symbol === symbol) ??
      market.watchlist.find((w) => w.symbol === symbol);

    if (!target) {
      degraded = true;
      degradedReason = `未找到标的 ${symbol} 的行情数据`;
    } else {
      name = target.name;
      todayAuctionTurnover = target.auctionTurnover;
      prevAuctionTurnover = target.prevAuctionTurnover;
      prevFullDayTurnover = target.prevFullDayTurnover;
      liveCumRatioPct = target.metrics?.cumRatioPct ?? null;
      slopeWindow = params.slopeWindow ?? target.metrics?.slopeWindow ?? 5;
      degraded = target.degraded;
      degradedReason = target.degradedReason;
      priceSeriesName = target.isIndex ? `${target.name}点位` : '分时价';

      if (isFinitePositiveOrZero(todayAuctionTurnover)) {
        todayCum[0] = todayAuctionTurnover;
      }
      if (isFinitePositiveOrZero(prevAuctionTurnover)) {
        prevCum[0] = prevAuctionTurnover;
      }

      for (const b of target.todaySeries) {
        if (b.minuteIndex >= 0 && b.minuteIndex <= 239 && isFinitePositiveOrZero(b.cumTurnover)) {
          todayCum[b.minuteIndex + 1] = b.cumTurnover;
          todayPoints.push({ minuteIndex: b.minuteIndex, cumTurnover: b.cumTurnover });
          if (isFinitePositiveOrZero(b.barTurnover)) {
            todayExplicitBars.set(b.minuteIndex, b.barTurnover);
          }
        }
      }

      for (const b of target.prevSeries) {
        if (b.minuteIndex >= 0 && b.minuteIndex <= 239 && isFinitePositiveOrZero(b.cumTurnover)) {
          prevCum[b.minuteIndex + 1] = b.cumTurnover;
          prevPoints.push({ minuteIndex: b.minuteIndex, cumTurnover: b.cumTurnover });
          if (isFinitePositiveOrZero(b.barTurnover)) {
            prevExplicitBars.set(b.minuteIndex, b.barTurnover);
          }
        }
      }

      if (
        target.metrics &&
        target.metrics.minuteIndex >= 0 &&
        target.metrics.minuteIndex <= 239 &&
        isFinitePositiveOrZero(target.metrics.todayCumTurnover)
      ) {
        const m = target.metrics.minuteIndex;
        todayCum[m + 1] = target.metrics.todayCumTurnover;
        liveMetricsMinute = m;
        liveMetricsSlope = target.metrics.slope;
        liveMetricsDevPct =
          target.metrics.windowDeviationPct ??
          (target.metrics.windowMultiple !== null
            ? (target.metrics.windowMultiple - 1) * 100
            : null);
        const existingIdx = todayPoints.findIndex((p) => p.minuteIndex === m);
        if (existingIdx >= 0) {
          todayPoints[existingIdx] = {
            minuteIndex: m,
            cumTurnover: target.metrics.todayCumTurnover,
          };
        } else {
          todayPoints.push({ minuteIndex: m, cumTurnover: target.metrics.todayCumTurnover });
        }
      }

      priceSeries = fillPriceFromBars(
        target.todaySeries,
        target.metrics?.minuteIndex ?? null,
        target.quote?.price ?? null
      );
    }
  }

  // 逐分钟增量柱（仅连续交易分钟 1..240，槽位 0 留空）
  const todayBar = buildBarIncrements(todayCum, todayExplicitBars);
  const prevBar = buildBarIncrements(prevCum, prevExplicitBars);

  // 复用纯核心引擎计算逐分钟滚动边际量比偏离 D_W(t) 与边际斜率 S_W(t)（与后端告警口径 100% 同源）
  const marginalDevSeries = emptyCum();
  const slopeSeries = emptyCum();
  const cumRatioPctSeries = emptyCum();
  if (todayPoints.length > 0 && prevPoints.length > 0) {
    const metricsList = evaluateEnergySeries({
      todaySeries: todayPoints,
      prevSeries: prevPoints,
      prevFullDayTurnover,
      prevAuctionTurnover,
      config: { slopeWindow },
    });
    for (const m of metricsList) {
      if (m.cumRatioPct !== null && Number.isFinite(m.cumRatioPct)) {
        cumRatioPctSeries[m.minuteIndex + 1] = Math.round(m.cumRatioPct * 100) / 100;
      }
      if (m.windowDeviationPct !== null && Number.isFinite(m.windowDeviationPct)) {
        marginalDevSeries[m.minuteIndex + 1] = Math.round(m.windowDeviationPct * 100) / 100;
      }
      if (m.slope !== null && Number.isFinite(m.slope)) {
        slopeSeries[m.minuteIndex + 1] = Math.round(m.slope * 1000) / 1000;
      }
    }
  }
  // 实时未闭合分钟无条件以后端线性插值结果覆写（含 null），防止未插值的 60s 假急缩泄漏到图表
  if (liveMetricsMinute !== null) {
    marginalDevSeries[liveMetricsMinute + 1] =
      liveMetricsDevPct !== null && Number.isFinite(liveMetricsDevPct)
        ? Math.round(liveMetricsDevPct * 100) / 100
        : null;
    slopeSeries[liveMetricsMinute + 1] =
      liveMetricsSlope !== null && Number.isFinite(liveMetricsSlope)
        ? Math.round(liveMetricsSlope * 1000) / 1000
        : null;
  }

  // 本机定制：未闭合的实时分钟用后端按秒对齐后的同期比覆写，保证曲线末端与卡片「较昨日同期」一致
  if (liveMetricsMinute !== null && liveCumRatioPct !== null && Number.isFinite(liveCumRatioPct)) {
    cumRatioPctSeries[liveMetricsMinute + 1] = Math.round(liveCumRatioPct * 100) / 100;
  }

  // 当日该标的异动散点（仅匹配当前展示交易日，落在边际量比趋势线上）
  const displayDate = market.status.tradeDate;
  const alertMarkers: ChartAlertMarker[] = [];
  for (const ev of alerts) {
    if (ev.symbol !== symbol) continue;
    if (displayDate && ev.tradeDate !== displayDate) continue;
    if (ev.minuteIndex < 0 || ev.minuteIndex > 239) continue;
    const slotIndex = ev.minuteIndex + 1;
    const slopeVal = slopeSeries[slotIndex] ?? ev.slope;
    const marginalDevPct =
      marginalDevSeries[slotIndex] ?? Math.round((ev.windowMultiple - 1) * 100 * 100) / 100;
    alertMarkers.push({
      slotIndex,
      minuteIndex: ev.minuteIndex,
      minuteLabel: minuteIndexToLabel(ev.minuteIndex),
      direction: ev.direction,
      marginalDevPct,
      slope: slopeVal,
      windowMultiple: ev.windowMultiple,
      cumRatio: ev.cumRatio,
      message: ev.message,
      isSimulated: ev.message.startsWith(SIMULATED_ALERT_PREFIX),
      isReplay: ev.message.startsWith(REPLAY_ALERT_PREFIX),
    });
  }

  const hasData =
    todayCum.some((v) => v !== null) ||
    prevCum.some((v) => v !== null) ||
    priceSeries.some((v) => v !== null);

  return {
    symbol,
    name,
    tradeDate: market.status.tradeDate,
    prevTradeDate: market.status.prevTradeDate,
    xLabels,
    todayCum,
    prevCum,
    priceSeries,
    priceSeriesName,
    todayBar,
    prevBar,
    marginalDevSeries,
    slopeSeries,
    cumRatioPctSeries,
    slopeWindow,
    todayAuctionTurnover,
    prevAuctionTurnover,
    alertMarkers,
    hasData,
    degraded: degraded || !hasData,
    degradedReason: degradedReason ?? (!hasData ? '暂无分时数据' : null),
  };
}
