import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  HudContent,
  selectMinimalWatchlist,
  type HudContentProps,
} from '../../src/renderer/src/hud/HudView';
import type {
  AlertDispatchPayload,
  DesktopShellState,
  HudMode,
  MarketDashboardState,
  SymbolEnergySnapshot,
} from '../../src/shared/types';

function makeStock(symbol: string, name: string, price: number, pct: number): SymbolEnergySnapshot {
  return {
    symbol,
    name,
    isIndex: false,
    quote: {
      symbol,
      name,
      price,
      prevClose: 10,
      open: 10,
      high: price,
      low: 9.8,
      changeAmt: 0.2,
      changePct: pct,
      volumeShares: 1_000_000,
      turnover: 5.2e8,
      tradeDate: '2026-11-25',
      timestampMs: Date.now(),
      source: 'tencent',
    },
    metrics: {
      minuteIndex: 60,
      elapsedSeconds: 30,
      todayCumTurnover: 5.2e8,
      prevAlignedCumTurnover: 4.5e8,
      cumDiff: 7e7,
      cumRatio: 0.155,
      cumRatioPct: 15.5,
      predictedFullDayTurnover: null,
      volumeState: 'EXPANDING',
      slope: 1.4,
      windowMultiple: 1.32,
      windowDeviationPct: 32,
      slopeWindow: 5,
    },
    auctionTurnover: null,
    prevAuctionTurnover: null,
    prevFullDayTurnover: null,
    todaySeries: [],
    prevSeries: [],
    degraded: false,
    degradedReason: null,
  };
}

function makeIndex(symbol: string, name: string): SymbolEnergySnapshot {
  return {
    ...makeStock(symbol, name, 3320.5, 0.85),
    isIndex: true,
    scope: '全市场',
  };
}

function makeShellState(hudMode: HudMode): DesktopShellState {
  return {
    settings: {
      hudPosition: null,
      hudOpacity: 0.9,
      alwaysOnTop: true,
      muted: false,
      bossKey: 'Alt+Shift+A',
      autoLaunch: false,
      hudMode,
    },
    bossKeyStatus: {
      accelerator: 'Alt+Shift+A',
      registered: true,
      conflictMessage: null,
    },
    hudVisible: true,
    detailVisible: false,
    activeDetailSymbol: 'MARKET_TOTAL',
    activeDetailTab: 'chart',
    detailFocusSeq: 0,
    isDev: true,
  };
}

function makeMarketState(options?: {
  indices?: SymbolEnergySnapshot[];
  watchlist?: SymbolEnergySnapshot[];
  cumTurnover?: number | null;
  degraded?: boolean;
  stale?: boolean;
}): MarketDashboardState {
  const cumTurnover =
    options && 'cumTurnover' in options ? options.cumTurnover ?? null : 1.28e12;
  return {
    status: {
      mode: 'LIVE',
      phase: 'MORNING_SESSION',
      tradeDate: '2026-11-25',
      prevTradeDate: '2026-11-24',
      activeSnapshotProvider: 'tencent',
      activeIntradayProvider: 'tencent',
      calendarSource: 'sqlite_cache',
      calendarDegraded: false,
      pollingIntervalSec: 3,
      configuredIntervalSec: 3,
      lastUpdatedAt: Date.parse('2026-11-25T02:05:09.000Z'),
      lastLatencyMs: 42,
      consecutiveFailures: 0,
      stale: options?.stale ?? false,
      degraded: options?.degraded ?? false,
      degradedReasons: options?.degraded ? ['数据源超时'] : [],
    },
    marketTotal: {
      symbol: 'MARKET_TOTAL',
      name: '沪深两市',
      tradeDate: '2026-11-25',
      prevTradeDate: '2026-11-24',
      cumTurnover,
      shTurnover: cumTurnover ? cumTurnover * 0.45 : null,
      szTurnover: cumTurnover ? cumTurnover * 0.55 : null,
      auctionTurnover: null,
      prevAuctionTurnover: null,
      prevFullDayTurnover: 1.5e12,
      metrics:
        cumTurnover === null
          ? null
          : {
              minuteIndex: 60,
              elapsedSeconds: 30,
              todayCumTurnover: cumTurnover,
              prevAlignedCumTurnover: 1.14e12,
              cumDiff: 1.4e11,
              cumRatio: 0.124,
              cumRatioPct: 12.4,
              predictedFullDayTurnover: 1.68e12,
              volumeState: 'EXPANDING',
              slope: 1.25,
              windowMultiple: 1.35,
              windowDeviationPct: 35,
              slopeWindow: 5,
            },
      todaySeries: [],
      prevSeries: [],
      degraded: options?.degraded ?? false,
      degradedReason: options?.degraded ? '数据源异常' : null,
    },
    indices: options?.indices ?? [
      makeIndex('000001.SH', '上证指数'),
      makeIndex('399001.SZ', '深证成指'),
      makeIndex('399006.SZ', '创业板指'),
      makeIndex('000680.SH', '科创综指'),
    ],
    watchlist: options?.watchlist ?? [
      makeStock('600519.SH', '贵州茅台', 1580, 1.25),
      makeStock('300750.SZ', '宁德时代', 212.5, -0.82),
      makeStock('000001.SZ', '平安银行', 11.42, 0.35),
      makeStock('601318.SH', '中国平安', 48.2, 2.1),
      makeStock('300059.SZ', '东方财富', 24.6, -1.4),
    ],
    recentAlerts: [],
  };
}

function renderHud(overrides?: Partial<HudContentProps>): string {
  const props: HudContentProps = {
    market: makeMarketState(),
    shell: makeShellState('minimal'),
    monitorConfig: null,
    activeAlert: null,
    watchlistExpanded: true,
    onToggleWatchlistExpanded: vi.fn(),
    onSetHudMode: vi.fn(),
    onSetAlwaysOnTop: vi.fn(),
    onSetMuted: vi.fn(),
    onOpenDetail: vi.fn(),
    onHideHud: vi.fn(),
    onSetHudOpacity: vi.fn(),
    onRefreshMarketNow: vi.fn(),
    onSimulate: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(createElement(HudContent, props));
}

describe('HUD minimal mode', () => {
  it('selects at most 3 watchlist stocks in order without padding', () => {
    const stocks = [
      makeStock('600519.SH', '贵州茅台', 1580, 1.2),
      makeStock('300750.SZ', '宁德时代', 212, -0.5),
      makeStock('000001.SZ', '平安银行', 11.4, 0.2),
      makeStock('601318.SH', '中国平安', 48.2, 2.1),
    ];
    expect(selectMinimalWatchlist([])).toEqual([]);
    expect(selectMinimalWatchlist(stocks.slice(0, 2)).map((s) => s.name)).toEqual([
      '贵州茅台',
      '宁德时代',
    ]);
    expect(selectMinimalWatchlist(stocks).map((s) => s.name)).toEqual([
      '贵州茅台',
      '宁德时代',
      '平安银行',
    ]);
  });

  it('renders only market total + top 3 stocks and hides indices, footer, and extra buttons in minimal mode', () => {
    const html = renderHud({
      shell: makeShellState('minimal'),
      market: makeMarketState(),
    });

    expect(html).toContain('沪深总成交');
    expect(html).toContain('1.28 万亿');
    expect(html).toContain('+12.4%');
    expect(html).toContain('贵州茅台');
    expect(html).toContain('宁德时代');
    expect(html).toContain('平安银行');

    // 超出 3 条的自选股、四大核心指数、底部状态栏与管理栏必须隐藏
    expect(html).not.toContain('中国平安');
    expect(html).not.toContain('东方财富');
    expect(html).not.toContain('上证指数');
    expect(html).not.toContain('深证成指');
    expect(html).not.toContain('创业板指');
    expect(html).not.toContain('科创综指');
    expect(html).not.toContain('hud-footer');
    expect(html).not.toContain('+ 管理');
    expect(html).not.toContain('老板键');

    // 极简模式仅保留 1 个切回「标准」按钮，隐藏顶/音/静/详/×/刷新/设置/测急放
    const buttonCount = (html.match(/<button\b/g) ?? []).length;
    expect(buttonCount).toBe(1);
    expect(html).toContain('>标准</button>');
    expect(html).not.toContain('>简</button>');
    expect(html).not.toContain('>顶</button>');
    expect(html).not.toContain('>详</button>');
    expect(html).not.toContain('>刷新</button>');
    expect(html).not.toContain('>设置</button>');
    expect(html).not.toContain('>测急放</button>');
  });

  it('shows empty watchlist prompt and explicit degraded badges without zero-filling in minimal mode', () => {
    const emptyHtml = renderHud({
      shell: makeShellState('minimal'),
      market: makeMarketState({ watchlist: [] }),
    });
    expect(emptyHtml).toContain('暂无自选股，点击添加');

    const degradedHtml = renderHud({
      shell: makeShellState('minimal'),
      market: makeMarketState({ cumTurnover: null, degraded: true, stale: true }),
    });
    expect(degradedHtml).toContain('降级/无数据');
    expect(degradedHtml).toContain('陈旧');
    expect(degradedHtml).not.toContain('0 元');
  });

  it('keeps all 3 stocks and overlays pulse/alert banner in minimal mode, and preserves full layout in standard mode', () => {
    const alertPayload: AlertDispatchPayload = {
      id: 1,
      symbol: 'MARKET_TOTAL',
      name: '沪深两市',
      tradeDate: '2026-11-25',
      minuteIndex: 60,
      direction: 'SURGE',
      slope: 3.45,
      windowMultiple: 1.68,
      cumRatio: 0.12,
      message: '快速放量',
      createdAt: Date.now(),
      isRead: false,
      isSimulated: false,
      muted: false,
    };

    const minimalAlertHtml = renderHud({
      shell: makeShellState('minimal'),
      activeAlert: alertPayload,
    });
    expect(minimalAlertHtml).toContain('pulse-surge');
    expect(minimalAlertHtml).toContain('hud-alert-banner-minimal');
    expect(minimalAlertHtml).toContain('贵州茅台');
    expect(minimalAlertHtml).toContain('宁德时代');
    expect(minimalAlertHtml).toContain('平安银行');

    const standardHtml = renderHud({
      shell: makeShellState('standard'),
      market: makeMarketState(),
    });
    expect(standardHtml).toContain('上证指数');
    expect(standardHtml).toContain('深证成指');
    expect(standardHtml).toContain('创业板指');
    expect(standardHtml).toContain('科创综指');
    expect(standardHtml).toContain('中国平安');
    expect(standardHtml).toContain('东方财富');
    expect(standardHtml).toContain('>简</button>');
    expect(standardHtml).toContain('hud-footer');

    // 当用户在设置中开启可选扩展指数时，标准模式 HUD 应完整展示全部已开启指数（不被截断为 4 条）
    const expandedStandardHtml = renderHud({
      shell: makeShellState('standard'),
      market: makeMarketState({
        indices: [
          makeIndex('000001.SH', '上证指数'),
          makeIndex('399001.SZ', '深证成指'),
          makeIndex('399006.SZ', '创业板指'),
          makeIndex('000680.SH', '科创综指'),
          makeIndex('000016.SH', '上证50'),
          makeIndex('000300.SH', '沪深300'),
          makeIndex('000852.SH', '中证1000'),
          makeIndex('000688.SH', '科创50'),
        ],
      }),
    });
    for (const label of ['上证指数', '深证成指', '创业板指', '科创综指', '上证50', '沪深300', '中证1000', '科创50']) {
      expect(expandedStandardHtml).toContain(label);
    }

    // 当全部指数均被设置为不展示时，标准模式 HUD 不渲染空的指数列表容器
    const hiddenAllIndicesHtml = renderHud({
      shell: makeShellState('standard'),
      market: makeMarketState({ indices: [] }),
    });
    expect(hiddenAllIndicesHtml).not.toContain('hud-list-section');
    expect(hiddenAllIndicesHtml).toContain('沪深两市总成交额');
    expect(hiddenAllIndicesHtml).toContain('贵州茅台');
  });
});
