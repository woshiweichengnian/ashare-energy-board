import type { EChartsCoreOption } from 'echarts/core';
import {
  LUNCH_DIVIDER_SLOT,
  type ChartAlertMarker,
  type EnergyChartDataset,
} from '../../../shared/chartData';
import { formatSignedPct, formatTurnover, getSignedToneColor } from '../utils/format';

export interface AxisUnitScale {
  divisor: number;
  unit: '亿' | '万' | '元';
}

/** 对 Tooltip 内插文本做 HTML 转义，防止上游标的名称中的特殊字符破坏浮层 DOM */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 根据指定序列的最大值独立选择金额轴单位（亿 / 万 / 元），避免累计轴与 1 分钟增量轴量级错配 */
export function pickTurnoverAxisUnit(
  ...seriesList: ReadonlyArray<ReadonlyArray<number | null>>
): AxisUnitScale {
  let maxVal = 0;
  for (const series of seriesList) {
    for (const v of series) {
      if (v !== null && Number.isFinite(v) && v > maxVal) {
        maxVal = v;
      }
    }
  }
  if (maxVal >= 1e8) return { divisor: 1e8, unit: '亿' };
  if (maxVal >= 1e4) return { divisor: 1e4, unit: '万' };
  return { divisor: 1, unit: '元' };
}

export function formatAxisNumber(val: number, unit: string): string {
  if (unit === '亿' && Math.abs(val) >= 10000) {
    return `${(val / 10000).toFixed(1)}万亿`;
  }
  if (Math.abs(val) >= 100) return `${Math.round(val)}${unit}`;
  return `${val.toFixed(1)}${unit}`;
}

/**
 * 构建上下联动 ECharts 配置：
 * - 单 ECharts 实例双 Grid，axisPointer 严格同步联动，左右留白恒定对齐（防止无价格曲线时裁切下表右轴）
 * - 上图累计成交额与下图 1 分钟增量各自独立选择金额单位（亿 / 万 / 元），杜绝中小盘个股下表刻度全显示 0.0亿
 * - 复用实例增量 setOption，3 秒高频刷新无闪烁、无内存泄漏
 */
export function buildEnergyChartOption(dataset: EnergyChartDataset): EChartsCoreOption {
  const cumScale = pickTurnoverAxisUnit(dataset.todayCum, dataset.prevCum);
  const barScale = pickTurnoverAxisUnit(dataset.todayBar, dataset.prevBar);

  const scaleCum = (v: number | null): number | null => (v === null ? null : v / cumScale.divisor);
  const scaleBar = (v: number | null): number | null => (v === null ? null : v / barScale.divisor);

  const todayCumScaled = dataset.todayCum.map(scaleCum);
  const prevCumScaled = dataset.prevCum.map(scaleCum);
  const todayBarScaled = dataset.todayBar.map(scaleBar);
  const prevBarScaled = dataset.prevBar.map(scaleBar);

  // 为放量淡红 / 缩量淡绿区间填充构造相邻点段：[slot0, today0, prev0, slot1, today1, prev1]
  const diffSegments: Array<[number, number, number, number, number, number]> = [];
  for (let i = 1; i < todayCumScaled.length - 1; i++) {
    const t0 = todayCumScaled[i];
    const p0 = prevCumScaled[i];
    const t1 = todayCumScaled[i + 1];
    const p1 = prevCumScaled[i + 1];
    if (t0 !== null && p0 !== null && t1 !== null && p1 !== null) {
      diffSegments.push([i, t0, p0, i + 1, t1, p1]);
    }
  }

  // 09:25 集合竞价锚点标记（今昨同在 x=0 且高度接近，仅给今竞价画偏移文字标签防止重叠，Tooltip 展示完整今昨竞价）
  const auctionTodayScaled = scaleCum(dataset.todayAuctionTurnover);
  const auctionPrevScaled = scaleCum(dataset.prevAuctionTurnover);
  const auctionMarkData: Array<{
    name: string;
    coord: [number, number];
    itemStyle: { color: string };
    label?: { show: boolean; position?: string; offset?: [number, number] };
  }> = [];
  if (auctionTodayScaled !== null) {
    auctionMarkData.push({
      name: '09:25竞价',
      coord: [0, auctionTodayScaled],
      itemStyle: { color: '#f85149' },
      label: { show: true, position: 'top', offset: [24, -4] },
    });
  }
  if (auctionPrevScaled !== null) {
    auctionMarkData.push({
      name: '昨竞价',
      coord: [0, auctionPrevScaled],
      itemStyle: { color: '#8b949e' },
      label: { show: false },
    });
  }

  // 异动告警散点（急放红 / 急缩绿，落在滚动边际量比趋势线上）
  const surgeScatter: Array<{ value: [number, number]; meta: ChartAlertMarker }> = [];
  const shrinkScatter: Array<{ value: [number, number]; meta: ChartAlertMarker }> = [];
  for (const m of dataset.alertMarkers) {
    const point = { value: [m.slotIndex, m.marginalDevPct] as [number, number], meta: m };
    if (m.direction === 'SURGE') {
      surgeScatter.push(point);
    } else {
      shrinkScatter.push(point);
    }
  }

  const hasPrice = dataset.priceSeries.some((p) => p !== null);
  const marginalLegendName = `滚动${dataset.slopeWindow}m量比`;
  const safeName = escapeHtml(dataset.name);
  const safePriceName = escapeHtml(dataset.priceSeriesName);

  // 关键 X 轴刻度：均匀 5 节点（09:30、10:30、11:30/13:00、14:00、15:00），避免 09:25 与 09:30 紧邻重叠
  const keyTickIndices = new Set([1, 61, LUNCH_DIVIDER_SLOT, 181, 240]);

  // 本机定制：今日累计较昨日同一时刻的百分比曲线；颜色跟最新值走（红=放量，绿=缩量）
  const hasCumRatioPct = dataset.cumRatioPctSeries.some((v) => v !== null);
  let latestCumRatioPct: number | null = null;
  for (let i = dataset.cumRatioPctSeries.length - 1; i >= 0; i--) {
    const v = dataset.cumRatioPctSeries[i];
    if (v !== null) {
      latestCumRatioPct = v;
      break;
    }
  }
  const cumRatioColor =
    latestCumRatioPct !== null && latestCumRatioPct >= 0 ? '#f85149' : '#3fb950';

  const timeAxisLabel = {
    color: '#8b949e',
    fontSize: 10,
    margin: 8,
    interval: 0,
    alignMinLabel: 'left',
    alignMaxLabel: 'right',
    formatter: (val: string, idx: number) => {
      if (!keyTickIndices.has(idx)) return '';
      if (idx === LUNCH_DIVIDER_SLOT) return '11:30/13:00';
      if (idx === 240) return '15:00';
      return val;
    },
  };

  return {
    animation: false,
    backgroundColor: 'transparent',
    legend: {
      top: 0,
      left: 8,
      itemWidth: 12,
      itemHeight: 8,
      itemGap: 12,
      textStyle: { color: '#8b949e', fontSize: 11 },
      data: [
        '今日累计',
        '昨日累计',
        ...(hasPrice ? [dataset.priceSeriesName] : []),
        '今日1m增量',
        '昨日1m增量',
        marginalLegendName,
        ...(hasCumRatioPct ? ['较昨日同期'] : []),
      ],
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        lineStyle: { color: 'rgba(139, 148, 158, 0.5)', width: 1, type: 'dashed' },
        crossStyle: { color: 'rgba(139, 148, 158, 0.45)' },
        label: { backgroundColor: '#1f2937', color: '#e6edf3', fontSize: 10 },
      },
      backgroundColor: 'rgba(13, 17, 23, 0.96)',
      borderColor: 'rgba(139, 148, 158, 0.35)',
      textStyle: { color: '#e6edf3', fontSize: 11 },
      formatter: (rawParams: unknown) => {
        const list = Array.isArray(rawParams) ? rawParams : [];
        if (list.length === 0) return '';
        const slotIndex = Number((list[0] as { dataIndex?: number }).dataIndex ?? 0);
        const timeLabel =
          slotIndex === 0
            ? '09:25（集合竞价锚点）'
            : slotIndex === LUNCH_DIVIDER_SLOT
              ? '13:00（午休折叠衔接）'
              : escapeHtml(dataset.xLabels[slotIndex] ?? '');

        const tCum = dataset.todayCum[slotIndex];
        const pCum = dataset.prevCum[slotIndex];
        const diff = tCum !== null && pCum !== null ? tCum - pCum : null;
        const pct = tCum !== null && pCum !== null && pCum > 0 ? ((tCum - pCum) / pCum) * 100 : null;
        const priceVal = dataset.priceSeries[slotIndex];
        const tBar = dataset.todayBar[slotIndex];
        const pBar = dataset.prevBar[slotIndex];
        const marginalDevVal = dataset.marginalDevSeries[slotIndex];
        const slopeVal = dataset.slopeSeries[slotIndex];

        const lines: string[] = [
          `<div style="font-weight:600;margin-bottom:4px;">${safeName} · ${timeLabel}</div>`,
        ];
        lines.push(`<div>今日累计：<b>${formatTurnover(tCum)}</b></div>`);
        lines.push(`<div>昨日同期：${formatTurnover(pCum)}</div>`);
        if (diff !== null && pct !== null) {
          const color = getSignedToneColor(pct);
          const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
          lines.push(
            `<div>累计同比：<span style="color:${color};font-weight:600;">${formatSignedPct(pct, 1)} (${sign}${formatTurnover(Math.abs(diff))})</span></div>`
          );
        }
        if (priceVal !== null) {
          lines.push(`<div>${safePriceName}：<b>${priceVal.toFixed(2)}</b></div>`);
        }
        if (slotIndex > 0) {
          lines.push(
            `<div style="margin-top:3px;border-top:1px solid rgba(139,148,158,0.2);padding-top:3px;">1m 增量：今 ${formatTurnover(tBar)} / 昨 ${formatTurnover(pBar)}</div>`
          );
          if (marginalDevVal !== null) {
            const mc = getSignedToneColor(marginalDevVal);
            const mult = 1 + marginalDevVal / 100;
            lines.push(
              `<div>滚动 ${dataset.slopeWindow}m 边际量比：<span style="color:${mc};font-weight:600;">${formatSignedPct(marginalDevVal, 1)} (${mult.toFixed(2)}x)</span></div>`
            );
          }
          if (slopeVal !== null) {
            const sc = getSignedToneColor(slopeVal);
            lines.push(
              `<div>边际趋势斜率：<span style="color:${sc};font-weight:600;">${formatSignedPct(slopeVal, 2)}/分</span></div>`
            );
          }
        }
        const markersHere = dataset.alertMarkers.filter((m) => m.slotIndex === slotIndex);
        for (const m of markersHere) {
          const mc = m.direction === 'SURGE' ? '#ff7b72' : '#56d364';
          const tag = m.isReplay ? '[回放] ' : m.isSimulated ? '[模拟测试] ' : '';
          lines.push(
            `<div style="color:${mc};margin-top:3px;">● ${tag}${m.direction === 'SURGE' ? '快速放量' : '快速缩量'} (${m.windowMultiple.toFixed(2)}x)</div>`
          );
        }
        return lines.join('');
      },
    },
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
    },
    // 下表右轴（量比 %）始终渲染，两侧 Grid 统一固定 right: 66 确保刻度不裁剪且上下垂直对齐
    // 本机定制：拆成三行，第三行单独画「较昨日同期」百分比，纵轴自适应方便看清起伏
    grid: hasCumRatioPct
      ? [
          { left: 68, right: 66, top: 44, height: '25%' },
          { left: 68, right: 66, top: '45%', height: '21%' },
          { left: 68, right: 66, top: '77%', bottom: 24 },
        ]
      : [
          { left: 68, right: 66, top: 44, height: '41%' },
          { left: 68, right: 66, top: '68%', bottom: 24 },
        ],
    xAxis: [
      {
        type: 'category',
        gridIndex: 0,
        data: dataset.xLabels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: 'rgba(139, 148, 158, 0.28)' } },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dataset.xLabels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: 'rgba(139, 148, 158, 0.28)' } },
        axisTick: { show: false },
        axisLabel: hasCumRatioPct ? { show: false } : timeAxisLabel,
        splitLine: { show: false },
      },
      ...(hasCumRatioPct
        ? [
            {
              type: 'category',
              gridIndex: 2,
              data: dataset.xLabels,
              boundaryGap: false,
              axisLine: { lineStyle: { color: 'rgba(139, 148, 158, 0.28)' } },
              axisTick: { show: false },
              axisLabel: timeAxisLabel,
              splitLine: { show: false },
            },
          ]
        : []),
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        name: `累计(${cumScale.unit})`,
        nameGap: 10,
        nameTextStyle: { color: '#6e7681', fontSize: 10, align: 'right', padding: [0, 4, 0, 0] },
        splitNumber: 3,
        axisLabel: {
          color: '#8b949e',
          fontSize: 10,
          margin: 8,
          formatter: (val: number) => formatAxisNumber(val, cumScale.unit),
        },
        splitLine: { lineStyle: { color: 'rgba(139, 148, 158, 0.12)' } },
      },
      {
        type: 'value',
        gridIndex: 0,
        show: hasPrice,
        name: dataset.priceSeriesName,
        nameGap: 10,
        nameTextStyle: { color: '#79c0ff', fontSize: 10, align: 'left', padding: [0, 0, 0, 4] },
        scale: true,
        splitNumber: 3,
        axisLabel: {
          color: '#79c0ff',
          fontSize: 10,
          margin: 8,
          formatter: (val: number) => val.toFixed(val >= 1000 ? 0 : 2),
        },
        splitLine: { show: false },
      },
      {
        type: 'value',
        gridIndex: 1,
        name: `增量(${barScale.unit})`,
        nameGap: 10,
        nameTextStyle: { color: '#6e7681', fontSize: 10, align: 'right', padding: [0, 4, 0, 0] },
        splitNumber: 2,
        axisLabel: {
          color: '#8b949e',
          fontSize: 10,
          margin: 8,
          formatter: (val: number) => formatAxisNumber(val, barScale.unit),
        },
        splitLine: { lineStyle: { color: 'rgba(139, 148, 158, 0.12)' } },
      },
      {
        type: 'value',
        gridIndex: 1,
        name: `${dataset.slopeWindow}m量比(%)`,
        nameGap: 10,
        nameTextStyle: { color: '#d2a8ff', fontSize: 10, align: 'left', padding: [0, 0, 0, 4] },
        splitNumber: 2,
        axisLabel: {
          color: '#d2a8ff',
          fontSize: 10,
          margin: 8,
          formatter: (val: number) => `${val > 0 ? '+' : ''}${Math.round(val)}%`,
        },
        splitLine: { show: false },
      },
      ...(hasCumRatioPct
        ? [
            {
              type: 'value',
              gridIndex: 2,
              name: '同期(%)',
              nameGap: 10,
              nameTextStyle: { color: '#6e7681', fontSize: 10, align: 'right', padding: [0, 4, 0, 0] },
              scale: true,
              splitNumber: 3,
              axisLabel: {
                color: '#8b949e',
                fontSize: 10,
                margin: 8,
                formatter: (val: number) => `${val > 0 ? '+' : ''}${val.toFixed(1)}%`,
              },
              splitLine: { lineStyle: { color: 'rgba(139, 148, 158, 0.12)' } },
            },
          ]
        : []),
    ],
    series: [
      // 放量淡红 / 缩量淡绿区间差值填充（精确处理今昨交叉）
      {
        name: '放缩差值区',
        type: 'custom',
        xAxisIndex: 0,
        yAxisIndex: 0,
        silent: true,
        z: 1,
        tooltip: { show: false },
        renderItem: (
          _params: unknown,
          api: {
            value: (idx: number) => number;
            coord: (val: [number, number]) => [number, number];
          }
        ) => {
          const x0 = api.value(0);
          const t0 = api.value(1);
          const p0 = api.value(2);
          const x1 = api.value(3);
          const t1 = api.value(4);
          const p1 = api.value(5);
          const d0 = t0 - p0;
          const d1 = t1 - p1;

          const fillExpand = 'rgba(248, 81, 73, 0.16)';
          const fillShrink = 'rgba(46, 160, 67, 0.16)';

          if ((d0 >= 0 && d1 >= 0) || (d0 <= 0 && d1 <= 0)) {
            return {
              type: 'polygon',
              shape: {
                points: [
                  api.coord([x0, t0]),
                  api.coord([x1, t1]),
                  api.coord([x1, p1]),
                  api.coord([x0, p0]),
                ],
              },
              style: { fill: d0 + d1 >= 0 ? fillExpand : fillShrink },
            };
          }

          // 两点间发生交叉，求精确交点拆分为两个三角形
          const alpha = Math.abs(d0) / (Math.abs(d0) + Math.abs(d1));
          const xMid = x0 + (x1 - x0) * alpha;
          const yMid = t0 + (t1 - t0) * alpha;
          const midPt = api.coord([xMid, yMid]);

          return {
            type: 'group',
            children: [
              {
                type: 'polygon',
                shape: {
                  points: [api.coord([x0, t0]), midPt, api.coord([x0, p0])],
                },
                style: { fill: d0 >= 0 ? fillExpand : fillShrink },
              },
              {
                type: 'polygon',
                shape: {
                  points: [midPt, api.coord([x1, t1]), api.coord([x1, p1])],
                },
                style: { fill: d1 >= 0 ? fillExpand : fillShrink },
              },
            ],
          };
        },
        data: diffSegments,
      },
      // 今日累计成交额实线
      {
        name: '今日累计',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        showSymbol: false,
        connectNulls: false,
        z: 3,
        lineStyle: { color: '#ff7b72', width: 2 },
        itemStyle: { color: '#ff7b72' },
        data: todayCumScaled,
        markPoint:
          auctionMarkData.length > 0
            ? {
                symbol: 'diamond',
                symbolSize: 8,
                label: {
                  show: true,
                  position: 'right',
                  fontSize: 9,
                  color: '#e6edf3',
                  formatter: (p: { name?: string }) => p.name ?? '',
                },
                data: auctionMarkData,
              }
            : undefined,
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          lineStyle: { color: 'rgba(139, 148, 158, 0.35)', type: 'dashed', width: 1 },
          label: { show: false },
          data: [{ xAxis: LUNCH_DIVIDER_SLOT }],
        },
      },
      // 昨日同期累计成交额虚线
      {
        name: '昨日累计',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        showSymbol: false,
        connectNulls: false,
        z: 2,
        lineStyle: { color: '#8b949e', width: 1.5, type: 'dashed' },
        itemStyle: { color: '#8b949e' },
        data: prevCumScaled,
      },
      // 右轴叠加分时价 / 点位曲线
      ...(hasPrice
        ? [
            {
              name: dataset.priceSeriesName,
              type: 'line',
              xAxisIndex: 0,
              yAxisIndex: 1,
              showSymbol: false,
              connectNulls: false,
              z: 4,
              lineStyle: { color: '#58a6ff', width: 1.3 },
              itemStyle: { color: '#58a6ff' },
              data: dataset.priceSeries,
            },
          ]
        : []),
      // 下图：昨日 1 分钟增量柱
      {
        name: '昨日1m增量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 2,
        barGap: '-100%',
        barMaxWidth: 4,
        z: 1,
        itemStyle: { color: 'rgba(139, 148, 158, 0.28)' },
        data: prevBarScaled,
      },
      // 下图：今日 1 分钟增量柱（高于昨同分钟用红，低于用绿；图例色固定红色保持红涨绿跌一致）
      {
        name: '今日1m增量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 2,
        barMaxWidth: 4,
        z: 2,
        itemStyle: { color: '#f85149' },
        data: todayBarScaled.map((val, idx) => {
          if (val === null) return null;
          const prevVal = prevBarScaled[idx];
          const isHigher = prevVal === null || val >= prevVal;
          return {
            value: val,
            itemStyle: {
              color: isHigher ? 'rgba(248, 81, 73, 0.72)' : 'rgba(46, 160, 67, 0.72)',
            },
          };
        }),
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          lineStyle: { color: 'rgba(139, 148, 158, 0.35)', type: 'dashed', width: 1 },
          label: { show: false },
          data: [{ xAxis: LUNCH_DIVIDER_SLOT }],
        },
      },
      // 下图：滚动 W 分钟边际量比偏离主趋势线（0% 为昨日同期水平，早盘尾盘量纲一致）
      {
        name: marginalLegendName,
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 3,
        showSymbol: false,
        connectNulls: false,
        z: 4,
        lineStyle: { color: '#d2a8ff', width: 1.6 },
        itemStyle: { color: '#d2a8ff' },
        data: dataset.marginalDevSeries,
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          lineStyle: { color: 'rgba(210, 168, 255, 0.3)', type: 'dotted', width: 1 },
          label: { show: false },
          data: [{ yAxis: 0 }],
        },
      },
      // 本机定制：今日累计较昨日同一时刻的百分比变化（0% = 与昨日同期持平）
      ...(hasCumRatioPct
        ? [
            {
              name: '较昨日同期',
              type: 'line',
              xAxisIndex: 2,
              yAxisIndex: 4,
              showSymbol: false,
              connectNulls: false,
              z: 5,
              lineStyle: { color: cumRatioColor, width: 1.8 },
              itemStyle: { color: cumRatioColor },
              areaStyle: { color: cumRatioColor, opacity: 0.1 },
              data: dataset.cumRatioPctSeries,
              endLabel: {
                show: true,
                color: cumRatioColor,
                fontSize: 11,
                fontWeight: 600,
                formatter: (p: { value: number | null }) =>
                  p.value === null || p.value === undefined ? '' : formatSignedPct(p.value, 1),
              },
              markLine: {
                silent: true,
                symbol: ['none', 'none'],
                lineStyle: { color: 'rgba(139, 148, 158, 0.45)', type: 'dashed', width: 1 },
                label: { show: false },
                data: [{ yAxis: 0 }, { xAxis: LUNCH_DIVIDER_SLOT }],
              },
            },
          ]
        : []),
      // 异动散点：快速放量（红色上三角）
      {
        name: '急放异动',
        type: 'scatter',
        xAxisIndex: 1,
        yAxisIndex: 3,
        symbol: 'triangle',
        symbolSize: 10,
        z: 6,
        itemStyle: { color: '#f85149', borderColor: '#ffffff', borderWidth: 1 },
        data: surgeScatter,
      },
      // 异动散点：快速缩量（绿色下三角）
      {
        name: '急缩异动',
        type: 'scatter',
        xAxisIndex: 1,
        yAxisIndex: 3,
        symbol: 'triangle',
        symbolRotate: 180,
        symbolSize: 10,
        z: 6,
        itemStyle: { color: '#2ea043', borderColor: '#ffffff', borderWidth: 1 },
        data: shrinkScatter,
      },
    ],
  };
}
