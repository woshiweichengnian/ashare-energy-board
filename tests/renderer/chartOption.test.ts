import { describe, expect, it } from 'vitest';
import {
  buildEnergyChartOption,
  escapeHtml,
  pickTurnoverAxisUnit,
} from '../../src/renderer/src/detail/chartOption';
import { CHART_SLOT_COUNT, type EnergyChartDataset } from '../../src/shared/chartData';

function makeStockDataset(overrides?: Partial<EnergyChartDataset>): EnergyChartDataset {
  const empty = () => new Array<number | null>(CHART_SLOT_COUNT).fill(null);
  const xLabels = ['09:25', ...Array.from({ length: 240 }, (_, i) => `M${i}`)];

  const todayCum = empty();
  const prevCum = empty();
  const todayBar = empty();
  const prevBar = empty();
  const marginalDevSeries = empty();
  const slopeSeries = empty();

  // 中小盘个股：全天累计 2.0 亿，单分钟增量 80 万（0.008 亿）
  for (let m = 0; m < 10; m++) {
    todayCum[m + 1] = 1.92e8 + (m + 1) * 80e4;
    prevCum[m + 1] = 1.92e8 + (m + 1) * 80e4;
    todayBar[m + 1] = 80e4;
    prevBar[m + 1] = 80e4;
    marginalDevSeries[m + 1] = 0;
    slopeSeries[m + 1] = 0;
  }

  return {
    symbol: '300750.SZ',
    name: '测试<个股>&A',
    tradeDate: '2026-11-25',
    prevTradeDate: '2026-11-24',
    xLabels,
    todayCum,
    prevCum,
    priceSeries: empty(), // 无价格曲线
    priceSeriesName: '分时<价>',
    todayBar,
    prevBar,
    marginalDevSeries,
    slopeSeries,
    cumRatioPctSeries: empty(),
    slopeWindow: 5,
    todayAuctionTurnover: null,
    prevAuctionTurnover: null,
    alertMarkers: [],
    hasData: true,
    degraded: false,
    degradedReason: null,
    ...overrides,
  };
}

describe('chartOption', () => {
  it('picks independent units for upper cumulative axis (亿) and lower 1m bar axis (万)', () => {
    const ds = makeStockDataset();
    expect(pickTurnoverAxisUnit(ds.todayCum, ds.prevCum)).toEqual({ divisor: 1e8, unit: '亿' });
    expect(pickTurnoverAxisUnit(ds.todayBar, ds.prevBar)).toEqual({ divisor: 1e4, unit: '万' });

    const option = buildEnergyChartOption(ds) as {
      yAxis: Array<{ name: string; axisLabel: { formatter: (v: number) => string } }>;
      series: Array<{ name: string; data: unknown[] }>;
    };

    expect(option.yAxis[0].name).toBe('累计(亿)');
    expect(option.yAxis[2].name).toBe('增量(万)');
    expect(option.yAxis[2].axisLabel.formatter(80)).toBe('80.0万');

    const prevBarSeries = option.series.find((s) => s.name === '昨日1m增量');
    expect(prevBarSeries?.data[1]).toBeCloseTo(80, 6);
  });

  it('reserves constant right margin for lower right axis even when price series is absent', () => {
    const ds = makeStockDataset();
    const option = buildEnergyChartOption(ds) as {
      grid: Array<{ right: number }>;
    };

    expect(option.grid[0].right).toBe(66);
    expect(option.grid[1].right).toBe(66);
  });

  it('escapes HTML in tooltip labels and keeps flat 0% values in neutral color', () => {
    expect(escapeHtml('<img src=x onerror=1>&"')).toBe('&lt;img src=x onerror=1&gt;&amp;&quot;');

    const ds = makeStockDataset();
    const option = buildEnergyChartOption(ds) as {
      tooltip: { formatter: (params: unknown) => string };
    };

    const html = option.tooltip.formatter([{ dataIndex: 5 }]);
    expect(html).toContain('测试&lt;个股&gt;&amp;A');
    expect(html).not.toContain('<个股>');
    // 0.0% 同比、0.0% 边际量比与 0.00%/分 斜率均使用中性色 #e6edf3 而非红涨色 #ff7b72
    expect(html).toContain('color:#e6edf3;font-weight:600;">0.0%');
    expect(html).toContain('color:#e6edf3;font-weight:600;">0.00%/分');
    expect(html).not.toContain('#ff7b72');
  });

  it('本机定制：有同期百分比时多画一条线，颜色跟最新值的正负走', () => {
    const pct = new Array<number | null>(241).fill(null);
    pct[1] = -30;
    pct[2] = -12.5;
    const ds = makeStockDataset({ cumRatioPctSeries: pct });
    const opt = buildEnergyChartOption(ds) as {
      series: Array<{ name: string; lineStyle?: { color: string } }>;
      legend: { data: string[] };
    };
    const line = opt.series.find((s) => s.name === '较昨日同期');
    expect(line?.lineStyle?.color).toBe('#3fb950');
    expect(opt.legend.data).toContain('较昨日同期');
    expect((opt as unknown as { grid: unknown[] }).grid).toHaveLength(3);
    expect((line as unknown as { xAxisIndex: number }).xAxisIndex).toBe(2);

    const none = buildEnergyChartOption(makeStockDataset()) as { series: Array<{ name: string }> };
    expect(none.series.some((s) => s.name === '较昨日同期')).toBe(false);
    expect((none as unknown as { grid: unknown[] }).grid).toHaveLength(2);
  });
});
