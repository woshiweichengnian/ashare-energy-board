import { useEffect, useRef, useState } from 'react';
import { describeAlert } from '../../../shared/alertText';
import { HudExtrasRow } from './HudExtrasRow';
import { HudRecentAlerts } from './HudRecentAlerts';
import { HudResizeHandle } from './HudResizeHandle';
import { DELTA_HOT_MULTIPLE, useRecentDelta } from './recentDelta';
import { HUD_MINIMAL_WATCHLIST_LIMIT, MARKET_TOTAL_SYMBOL } from '../../../shared/constants';
import type {
  AlertDirection,
  AlertDispatchPayload,
  DesktopShellState,
  HudMode,
  MarketDashboardState,
  MonitorConfig,
  OpenDetailOptions,
  SymbolEnergySnapshot,
} from '../../../shared/types';
import { playAlertSound } from '../audio/alertSound';
import {
  formatClockTime,
  formatPhaseLabel,
  formatPrice,
  formatSignedPct,
  formatSignedTurnover,
  formatSlopeTrend,
  hasDataDegradation,
  predictedVsPrevFullDayPct,
  formatTurnover,
  formatVolumeState,
  getSignedToneClass,
  resolveSymbolChangePct,
  resolveSymbolPrice,
  resolveSymbolTurnover,
} from '../utils/format';

const PULSE_DURATION_MS = 6000;

/** 极简模式仅按当前自选股顺序取前 N 条（默认 3 条），不补占位假数据 */
export function selectMinimalWatchlist(
  items: readonly SymbolEnergySnapshot[],
  limit = HUD_MINIMAL_WATCHLIST_LIMIT
): SymbolEnergySnapshot[] {
  return items.slice(0, Math.max(0, limit));
}

export interface HudContentProps {
  market: MarketDashboardState | null;
  shell: DesktopShellState | null;
  monitorConfig: MonitorConfig | null;
  activeAlert: AlertDispatchPayload | null;
  watchlistExpanded: boolean;
  onToggleWatchlistExpanded: () => void;
  onSetHudMode: (mode: HudMode) => void;
  onSetAlwaysOnTop: (alwaysOnTop: boolean) => void;
  onSetMuted: (muted: boolean) => void;
  onOpenDetail: (options?: OpenDetailOptions) => void;
  onHideHud: () => void;
  onSetHudOpacity: (opacity: number) => void;
  onRefreshMarketNow: () => void;
  onSimulate: (direction: AlertDirection) => void;
}

export function HudContent({
  market,
  shell,
  monitorConfig,
  activeAlert,
  watchlistExpanded,
  onToggleWatchlistExpanded,
  onSetHudMode,
  onSetAlwaysOnTop,
  onSetMuted,
  onOpenDetail,
  onHideHud,
  onSetHudOpacity,
  onRefreshMarketNow,
  onSimulate,
}: HudContentProps) {
  const recentDelta = useRecentDelta(market);
  const isMinimal = shell?.settings.hudMode === 'minimal';
  const total = market?.marketTotal ?? null;
  const predictedPct = predictedVsPrevFullDayPct(
    total?.metrics?.predictedFullDayTurnover,
    total?.prevFullDayTurnover
  );
  const status = market?.status ?? null;
  const replay = status?.replay?.active ? status.replay : null;
  const isDegraded = Boolean(hasDataDegradation(status) || status?.stale || total?.degraded);
  const volBadge = formatVolumeState(total?.metrics?.volumeState);
  const isPostCloseReview =
    !replay &&
    status?.mode === 'REPLAY' &&
    (status.phase === 'POST_MARKET' || status.phase === 'CLOSED_DAY');
  const slopeTrend = formatSlopeTrend(
    total?.metrics?.slope,
    total?.metrics?.windowMultiple,
    monitorConfig?.surgeSlopeThreshold ?? 3.0,
    monitorConfig?.shrinkSlopeThreshold ?? -3.0,
    {
      postCloseReview: isPostCloseReview || status?.phase === 'LUNCH_BREAK',
      reviewLabel: status?.phase === 'LUNCH_BREAK' ? '午间收盘' : '尾盘',
      surgeMultipleThreshold: monitorConfig?.surgeMultipleThreshold,
      shrinkMultipleThreshold: monitorConfig?.shrinkMultipleThreshold,
      matchMode: monitorConfig?.matchMode,
    }
  );
  const opacityPct = Math.round((shell?.settings.hudOpacity ?? 0.9) * 100);

  const pulseClass = activeAlert
    ? activeAlert.direction === 'SURGE'
      ? 'pulse-surge'
      : 'pulse-shrink'
    : '';

  const statusDotClass = isDegraded
    ? 'warn'
    : volBadge.tone === 'up'
      ? 'up'
      : volBadge.tone === 'down'
        ? 'down'
        : '';

  const watchlistItems = market?.watchlist ?? [];
  const minimalStocks = selectMinimalWatchlist(watchlistItems);

  if (isMinimal) {
    return (
      <div className="hud-viewport hud-viewport-minimal">
        <section className={`hud-shell hud-shell-minimal ${pulseClass}`}>
          {/* 极简顶栏：仅保留拖拽区、状态圆点、关键状态标识与唯一切换标准按钮 */}
          <header className="hud-header hud-header-minimal drag-region">
            <div className="hud-brand hud-brand-minimal">
              <span className={`status-dot ${statusDotClass}`} />
              <span>沪深能量</span>
              {replay ? (
                <span className="badge badge-compact badge-warn">
                  回放 {replay.currentTimeLabel}
                </span>
              ) : (
                <>
                  {isDegraded && (
                    <span className="badge badge-compact badge-warn">
                      {status?.stale ? '陈旧' : '降级'}
                    </span>
                  )}
                  {!isDegraded && status?.mode === 'REPLAY' && (
                    <span className="badge badge-compact badge-flat">复盘</span>
                  )}
                </>
              )}
            </div>

            <div className="hud-actions no-drag">
              <button
                type="button"
                className="icon-btn icon-btn-minimal"
                title="切换回标准模式"
                onClick={() => onSetHudMode('standard')}
              >
                标准
              </button>
            </div>
          </header>

          {shell?.bossKeyStatus.conflictMessage && (
            <div
              className="hud-conflict-banner hud-conflict-banner-minimal no-drag"
              role="alert"
              onClick={() => onOpenDetail({ tab: 'settings' })}
              title="点击前往设置改绑老板键"
            >
              ⚠ {shell.bossKeyStatus.conflictMessage}
            </div>
          )}

          {/* 极简核心：沪深总成交 */}
          <div
            className="hud-hero hud-hero-minimal no-drag"
            onClick={() => onOpenDetail({ symbol: MARKET_TOTAL_SYMBOL, tab: 'chart' })}
            title="点击展开两市分时能量对比图"
          >
            <div className="hud-hero-top">
              <span className="hud-hero-label">沪深总成交</span>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                {isDegraded && (
                  <span className="badge badge-compact badge-warn">
                    {status?.stale ? '陈旧' : '降级'}
                  </span>
                )}
                <span className={`badge badge-compact badge-${volBadge.tone}`}>
                  {volBadge.label}
                </span>
              </div>
            </div>

            <div className="hud-hero-value hud-hero-value-minimal">
              <span className="hud-total-amount hud-total-amount-minimal">
                {total && total.cumTurnover !== null
                  ? formatTurnover(total.cumTurnover)
                  : '降级/无数据'}
              </span>
              <div className="hud-minimal-ratio">
                <span className={getSignedToneClass(total?.metrics?.cumRatioPct)}>
                  {total?.metrics?.cumRatioPct !== null &&
                  total?.metrics?.cumRatioPct !== undefined
                    ? formatSignedPct(total.metrics.cumRatioPct, 1)
                    : '待比对'}
                </span>
                <span className={`slope-chip slope-${slopeTrend.tone}`} title={slopeTrend.label}>
                  <span className="slope-arrow">{slopeTrend.arrow || '·'}</span>
                </span>
              </div>
            </div>
          </div>

          {/* 极简自选股列表：最多展示前 3 条，隐藏管理栏与滚动条 */}
          <div className="hud-minimal-stocks no-drag">
            {minimalStocks.length === 0 ? (
              <div
                className="hud-watchlist-empty hud-watchlist-empty-minimal"
                onClick={() => onOpenDetail({ tab: 'watchlist' })}
              >
                暂无自选股，点击添加
              </div>
            ) : (
              minimalStocks.map((item) => {
                const price = resolveSymbolPrice(item);
                const pct = resolveSymbolChangePct(item);
                const turnover = resolveSymbolTurnover(item);
                const badge = formatVolumeState(item.metrics?.volumeState);
                const toneClass = getSignedToneClass(pct);
                return (
                  <div
                    key={item.symbol}
                    className="hud-quote-row hud-quote-row-minimal"
                    onClick={() => onOpenDetail({ symbol: item.symbol, tab: 'chart' })}
                    title={`点击查看 ${item.name} (${item.symbol}) 分时能量图`}
                  >
                    <div className="hud-quote-name">
                      <span className="quote-title">{item.name}</span>
                    </div>
                    <span className="hud-quote-price">{formatPrice(price)}</span>
                    <span className={`hud-quote-pct ${toneClass}`}>{formatSignedPct(pct, 2)}</span>
                    <span className="hud-quote-turn">
                      {turnover !== null ? formatTurnover(turnover) : '降级'}
                    </span>
                    <span
                      className={`badge badge-compact badge-${item.degraded && turnover === null ? 'warn' : badge.tone}`}
                    >
                      {item.degraded && turnover === null ? '降级' : badge.label}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {/* 告警横幅：底部悬浮叠加展示，避免挤出第 3 条个股 */}
          {activeAlert && (
            <div
              className={`hud-alert-banner hud-alert-banner-minimal no-drag ${activeAlert.direction === 'SURGE' ? 'surge' : 'shrink'}`}
              onClick={() => onOpenDetail({ symbol: activeAlert.symbol, tab: 'alerts' })}
              title={`${describeAlert(activeAlert).detail}（${describeAlert(activeAlert).metrics}）。点击看全部提醒`}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeAlert.isReplay ? '[回放] ' : activeAlert.isSimulated ? '[模拟测试] ' : ''}
                {describeAlert(activeAlert).headline}
              </span>
              {activeAlert.muted && <span className="badge badge-compact badge-warn">静音</span>}
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="hud-viewport">
      <section className={`hud-shell ${pulseClass}`}>
        {/* 顶部拖拽栏 + 快捷按钮 */}
        <header className="hud-header drag-region">
          <div className="hud-brand">
            <span className={`status-dot ${statusDotClass}`} />
            <span>A 股能量看板</span>
            {replay ? (
              <span className="badge badge-warn">
                回放 {replay.tradeDate} {replay.currentTimeLabel}
              </span>
            ) : (
              <>
                <span className="badge badge-muted">{formatPhaseLabel(status?.phase)}</span>
                {status?.mode === 'REPLAY' && <span className="badge badge-flat">复盘</span>}
              </>
            )}
          </div>

          <div className="hud-actions no-drag">
            <button
              type="button"
              className="icon-btn"
              title="切换极简模式（仅显示沪深总成交与前 3 条个股）"
              onClick={() => onSetHudMode('minimal')}
            >
              简
            </button>
            <button
              type="button"
              className={`icon-btn ${shell?.settings.alwaysOnTop ? 'active' : ''}`}
              title={shell?.settings.alwaysOnTop ? '已置顶（点击取消置顶）' : '点击置顶'}
              onClick={() => onSetAlwaysOnTop(!(shell?.settings.alwaysOnTop ?? true))}
            >
              顶
            </button>
            <button
              type="button"
              className={`icon-btn ${shell?.settings.muted ? 'warn' : ''}`}
              title={shell?.settings.muted ? '已静音（点击取消静音）' : '点击静音'}
              onClick={() => onSetMuted(!(shell?.settings.muted ?? false))}
            >
              {shell?.settings.muted ? '静' : '音'}
            </button>
            <button
              type="button"
              className="icon-btn"
              title="展开详情浮层"
              onClick={() => onOpenDetail({ symbol: MARKET_TOTAL_SYMBOL, tab: 'chart' })}
            >
              详
            </button>
            <button
              type="button"
              className="icon-btn"
              title="最小化至系统托盘"
              onClick={onHideHud}
            >
              ×
            </button>
          </div>
        </header>

        {/* 老板键冲突提示 */}
        {shell?.bossKeyStatus.conflictMessage && (
          <div
            className="hud-conflict-banner no-drag"
            role="alert"
            onClick={() => onOpenDetail({ tab: 'settings' })}
            title="点击前往设置改绑老板键"
          >
            ⚠ {shell.bossKeyStatus.conflictMessage}
          </div>
        )}

        {/* 核心 Hero 区：沪深两市总成交额 + 同比 + 预测全天 + 趋势斜率脉冲 */}
        <div
          className="hud-hero no-drag"
          onClick={() => onOpenDetail({ symbol: MARKET_TOTAL_SYMBOL, tab: 'chart' })}
          title="点击展开两市分时能量对比图"
        >
          <div className="hud-hero-top">
            <span className="hud-hero-label">沪深两市总成交额（沪+深，不含北证）</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {isDegraded && (
                <span className="badge badge-warn">{status?.stale ? '陈旧' : '降级'}</span>
              )}
              <span className={`badge badge-${volBadge.tone}`}>{volBadge.label}</span>
            </div>
          </div>

          <div className="hud-hero-value">
            <span className="hud-total-amount">
              {total && total.cumTurnover !== null ? formatTurnover(total.cumTurnover) : '降级/无数据'}
            </span>
            <span
              className={getSignedToneClass(total?.metrics?.cumRatioPct)}
              style={{ fontSize: '12px', fontWeight: 600 }}
            >
              {total?.metrics?.cumRatioPct !== null && total?.metrics?.cumRatioPct !== undefined
                ? `${formatSignedPct(total.metrics.cumRatioPct, 1)} / ${formatSignedTurnover(total.metrics.cumDiff)}`
                : '同比待比对'}
            </span>
          </div>

          <div className="hud-hero-sub">
            <span
              className="hud-predicted"
              title={
                predictedPct !== null
                  ? `预测全天比昨天全天 ${formatSignedTurnover(
                      (total?.metrics?.predictedFullDayTurnover ?? 0) - (total?.prevFullDayTurnover ?? 0)
                    )}（昨天全天 ${formatTurnover(total?.prevFullDayTurnover)}）`
                  : undefined
              }
            >
              预测 {formatTurnover(total?.metrics?.predictedFullDayTurnover)}
              {predictedPct !== null && (
                <span className={getSignedToneClass(predictedPct)} style={{ marginLeft: 4, fontWeight: 600 }}>
                  {formatSignedPct(predictedPct, 1)}
                </span>
              )}
            </span>
            {recentDelta && (
              <span
                className={
                  recentDelta.paceMultiple !== null && recentDelta.paceMultiple >= DELTA_HOT_MULTIPLE
                    ? 'hud-recent-delta hot'
                    : 'hud-recent-delta'
                }
                title={`最近约 10 秒两市进了多少成交额${
                  recentDelta.paceMultiple !== null
                    ? `，是昨天同一分钟节奏的 ${recentDelta.paceMultiple.toFixed(1)} 倍`
                    : ''
                }。达到 ${DELTA_HOT_MULTIPLE} 倍以上时标红`}
              >
                10秒 +{(recentDelta.amount / 1e8).toFixed(1)}亿
              </span>
            )}
            <span className={`slope-chip slope-${slopeTrend.tone}`}>
              {slopeTrend.arrow && <span className="slope-arrow">{slopeTrend.arrow}</span>}
              <span>{slopeTrend.label}</span>
            </span>
          </div>
        </div>

        <HudExtrasRow />
        <HudRecentAlerts tradeDate={total?.tradeDate} onOpenDetail={onOpenDetail} />

        {/* 已开启展示的板块与宽基指数精简行（若全部关闭则自动隐藏该区块，把空间让给自选股） */}
        {(market?.indices ?? []).length > 0 && (
          <div className="hud-list-section no-drag">
            <div className="hud-index-list">
              {(market?.indices ?? []).map((item) => {
                const price = resolveSymbolPrice(item);
                const pct = resolveSymbolChangePct(item);
                const turnover = resolveSymbolTurnover(item);
                const badge = formatVolumeState(item.metrics?.volumeState);
                const toneClass = getSignedToneClass(pct);
                return (
                  <div
                    key={item.symbol}
                    className="hud-quote-row"
                    onClick={() => onOpenDetail({ symbol: item.symbol, tab: 'chart' })}
                    title={`点击查看 ${item.name} 分时对比图`}
                  >
                    <div className="hud-quote-name">
                      <span className="quote-title">{item.name}</span>
                      {item.scope && <span className="scope-tag">{item.scope}</span>}
                    </div>
                    <span className="hud-quote-price">{formatPrice(price)}</span>
                    <span className={`hud-quote-pct ${toneClass}`}>{formatSignedPct(pct, 2)}</span>
                    <span className="hud-quote-turn">
                      {turnover !== null ? formatTurnover(turnover) : '降级'}
                    </span>
                    <span className={`badge badge-compact badge-${item.degraded && turnover === null ? 'warn' : badge.tone}`}>
                      {item.degraded && turnover === null ? '降级' : badge.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 自选股精简列表（可滚动 / 可折叠） */}
        <div className={`hud-watchlist-section no-drag ${watchlistExpanded ? '' : 'collapsed'}`}>
          <div className="hud-section-bar">
            <button
              type="button"
              className="section-toggle-btn"
              onClick={onToggleWatchlistExpanded}
            >
              <span>{watchlistExpanded ? '▾' : '▸'} 自选股 ({watchlistItems.length})</span>
            </button>
            <button
              type="button"
              className="icon-btn"
              title="管理自选股（添加/删除/排序/单股阈值）"
              onClick={() => onOpenDetail({ tab: 'watchlist' })}
            >
              + 管理
            </button>
          </div>

          {watchlistExpanded && (
            <div className="hud-watchlist-scroll">
              {watchlistItems.length === 0 ? (
                <div
                  className="hud-watchlist-empty"
                  onClick={() => onOpenDetail({ tab: 'watchlist' })}
                >
                  暂无自选股，点击「+ 管理」搜索添加
                </div>
              ) : (
                watchlistItems.map((item) => {
                  const price = resolveSymbolPrice(item);
                  const pct = resolveSymbolChangePct(item);
                  const turnover = resolveSymbolTurnover(item);
                  const badge = formatVolumeState(item.metrics?.volumeState);
                  const toneClass = getSignedToneClass(pct);
                  return (
                    <div
                      key={item.symbol}
                      className="hud-quote-row"
                      onClick={() => onOpenDetail({ symbol: item.symbol, tab: 'chart' })}
                      title={`点击查看 ${item.name} (${item.symbol}) 分时能量图`}
                    >
                      <div className="hud-quote-name">
                        <span className="quote-title">{item.name}</span>
                        <span className="quote-code">{item.symbol.slice(0, 6)}</span>
                      </div>
                      <span className="hud-quote-price">{formatPrice(price)}</span>
                      <span className={`hud-quote-pct ${toneClass}`}>{formatSignedPct(pct, 2)}</span>
                      <span className="hud-quote-turn">
                        {turnover !== null ? formatTurnover(turnover) : '降级'}
                      </span>
                      <span
                        className={`badge badge-compact badge-${item.degraded && turnover === null ? 'warn' : badge.tone}`}
                      >
                        {item.degraded && turnover === null ? '降级' : badge.label}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* 呼吸告警即时横幅 */}
        {activeAlert && (
          <div
            className={`hud-alert-banner no-drag ${activeAlert.direction === 'SURGE' ? 'surge' : 'shrink'}`}
            onClick={() => onOpenDetail({ symbol: activeAlert.symbol, tab: 'alerts' })}
            title={`${describeAlert(activeAlert).detail}（${describeAlert(activeAlert).metrics}）。点击看全部提醒`}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeAlert.isReplay ? '[回放] ' : activeAlert.isSimulated ? '[模拟测试] ' : ''}
              {describeAlert(activeAlert).headline}
            </span>
            {activeAlert.muted && <span className="badge badge-warn">静音</span>}
          </div>
        )}

        {/* 底部极简状态条：数据源、更新时间、延迟/降级提示、透明度滑块、快捷操作 */}
        <HudResizeHandle />
        <footer className="hud-footer no-drag">
          <div className="hud-footer-row">
            <span className="hud-status-text">
              {replay ? (
                <>
                  回放模式（无实时轮询）· {replay.stepIndex}/{replay.totalSteps - 1}
                  {replay.finished ? ' · 已播完' : ''}
                </>
              ) : (
                <>
                  源：{status?.activeSnapshotProvider ?? status?.activeIntradayProvider ?? '—'}
                  {status?.lastLatencyMs !== null && status?.lastLatencyMs !== undefined
                    ? ` (${Math.round(status.lastLatencyMs)}ms)`
                    : ''}
                  {' · '}
                  {formatClockTime(status?.lastUpdatedAt)}
                  {isDegraded ? ' · 降级' : ''}
                </>
              )}
            </span>
            <label className="opacity-control" title={`透明度 ${opacityPct}%`}>
              <span>透 {opacityPct}%</span>
              <input
                type="range"
                min={30}
                max={100}
                step={5}
                value={opacityPct}
                className="opacity-slider"
                onChange={(e) => onSetHudOpacity(Number(e.target.value) / 100)}
              />
            </label>
          </div>

          <div className="hud-footer-row">
            <span>老板键：{shell?.settings.bossKey ?? 'Alt+Shift+A'}</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                type="button"
                className="icon-btn"
                onClick={onRefreshMarketNow}
              >
                刷新
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => onOpenDetail({ tab: 'settings' })}
              >
                设置
              </button>
              {shell?.isDev && (
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ color: '#ff7b72' }}
                    title="开发测试：触发模拟急放告警（不伪装实盘）"
                    onClick={() => onSimulate('SURGE')}
                  >
                    测急放
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ color: '#56d364' }}
                    title="开发测试：触发模拟急缩告警（不伪装实盘）"
                    onClick={() => onSimulate('SHRINK')}
                  >
                    测急缩
                  </button>
                </>
              )}
            </div>
          </div>
        </footer>
      </section>
    </div>
  );
}

export function HudView() {
  const [market, setMarket] = useState<MarketDashboardState | null>(null);
  const [shell, setShell] = useState<DesktopShellState | null>(null);
  const [monitorConfig, setMonitorConfig] = useState<MonitorConfig | null>(null);
  const [activeAlert, setActiveAlert] = useState<AlertDispatchPayload | null>(null);
  const [watchlistExpanded, setWatchlistExpanded] = useState<boolean>(true);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void window.api.getShellState().then(setShell).catch(() => {});
    void window.api.getMonitorConfig().then(setMonitorConfig).catch(() => {});
    void window.api
      .getMarketState()
      .then((initial) => {
        if (initial) setMarket(initial);
      })
      .catch(() => {});

    const unsubMarket = window.api.onMarketStateUpdated((next) => {
      setMarket(next);
    });
    const unsubShell = window.api.onShellStateUpdated((next) => {
      setShell(next);
    });
    const unsubMonitor = window.api.onMonitorConfigUpdated((next) => {
      setMonitorConfig(next);
    });
    const unsubAlert = window.api.onAlertTriggered((payload) => {
      setActiveAlert(payload);
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
      }
      pulseTimerRef.current = setTimeout(() => {
        setActiveAlert(null);
        pulseTimerRef.current = null;
      }, PULSE_DURATION_MS);

      // 仅由常驻 HUD 窗口统一发声，避免与详情浮层重复叠音；静音时不发声
      void playAlertSound(payload.direction, payload.muted);
    });

    return () => {
      unsubMarket();
      unsubShell();
      unsubMonitor();
      unsubAlert();
      if (pulseTimerRef.current) {
        clearTimeout(pulseTimerRef.current);
      }
    };
  }, []);

  return (
    <HudContent
      market={market}
      shell={shell}
      monitorConfig={monitorConfig}
      activeAlert={activeAlert}
      watchlistExpanded={watchlistExpanded}
      onToggleWatchlistExpanded={() => setWatchlistExpanded((v) => !v)}
      onSetHudMode={(mode) => void window.api.setHudMode(mode)}
      onSetAlwaysOnTop={(alwaysOnTop) => void window.api.setAlwaysOnTop(alwaysOnTop)}
      onSetMuted={(muted) => void window.api.setMuted(muted)}
      onOpenDetail={(options) => void window.api.openDetail(options)}
      onHideHud={() => void window.api.hideHud()}
      onSetHudOpacity={(opacity) => void window.api.setHudOpacity(opacity)}
      onRefreshMarketNow={() => void window.api.refreshMarketNow()}
      onSimulate={(direction) =>
        void window.api.simulateAlert(direction, MARKET_TOTAL_SYMBOL).catch(() => {})
      }
    />
  );
}
