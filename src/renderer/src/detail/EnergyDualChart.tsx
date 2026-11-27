import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { buildEnergyChartDataset } from '../../../shared/chartData';
import type { AlertEventRow, MarketDashboardState } from '../../../shared/types';
import { buildEnergyChartOption } from './chartOption';

// 按需注册所需图表与组件，显著缩减渲染层打包体积与启动开销
echarts.use([
  LineChart,
  BarChart,
  ScatterChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AxisPointerComponent,
  MarkLineComponent,
  MarkPointComponent,
  CanvasRenderer,
]);

export interface EnergyDualChartProps {
  market: MarketDashboardState | null;
  symbol: string;
  alerts: readonly AlertEventRow[];
  slopeWindow?: number;
}

export function EnergyDualChart({ market, symbol, alerts, slopeWindow }: EnergyDualChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const dataset = useMemo(
    () => buildEnergyChartDataset({ market, symbol, alerts, slopeWindow }),
    [market, symbol, alerts, slopeWindow]
  );

  // 初始化单个 ECharts 实例并在卸载时销毁，避免高频更新产生实例泄漏
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const instance = echarts.init(el, undefined, { renderer: 'canvas' });
    chartRef.current = instance;

    let resizeRaf = 0;
    const observer = new ResizeObserver(() => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (chartRef.current && !chartRef.current.isDisposed()) {
          chartRef.current.resize();
        }
      });
    });
    observer.observe(el);

    return () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      observer.disconnect();
      instance.dispose();
      chartRef.current = null;
    };
  }, []);

  // 增量更新 Option，无闪烁复用实例（同步渲染确保切页签/跳转个股 0ms 出图）
  useEffect(() => {
    const instance = chartRef.current;
    if (!instance || instance.isDisposed()) return;
    const option = buildEnergyChartOption(dataset);
    instance.setOption(option, {
      notMerge: false,
      replaceMerge: ['series'],
    });
  }, [dataset]);

  return (
    <div className="chart-container-wrap">
      <div ref={containerRef} className="chart-canvas" />
      {!dataset.hasData && (
        <div className="chart-empty-overlay">
          <span className="badge badge-warn">降级 / 暂无分时数据</span>
          <span>{dataset.degradedReason ?? '当前标的尚无可用今/昨分时曲线，未用 0 填充'}</span>
        </div>
      )}
    </div>
  );
}
