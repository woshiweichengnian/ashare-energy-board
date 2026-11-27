import { useEffect, useRef, useState } from 'react';
import { DEFAULT_ALERT_CONFIG } from '../../../core/alertEngine';
import { MONITORED_INDEX_SYMBOLS, OPTIONAL_INDEX_SYMBOLS } from '../../../shared/constants';
import type {
  AlertMatchModeType,
  MarketDashboardState,
  MonitorConfig,
  SlopeWindowOption,
  TickerSearchResult,
  WatchlistItemRow,
  WatchlistThresholdOverride,
} from '../../../shared/types';
import {
  formatPrice,
  formatSignedPct,
  formatTurnover,
  formatVolumeState,
  getSignedToneClass,
  resolveSymbolChangePct,
  resolveSymbolPrice,
  resolveSymbolTurnover,
} from '../utils/format';

const CORE_INDEX_SYMBOL_SET = new Set<string>(MONITORED_INDEX_SYMBOLS);
const OPTIONAL_INDEX_SYMBOL_SET = new Set<string>(OPTIONAL_INDEX_SYMBOLS);

export interface WatchlistPanelProps {
  watchlistRows: readonly WatchlistItemRow[];
  market: MarketDashboardState | null;
  globalConfig: MonitorConfig | null;
  onWatchlistChanged: (rows: WatchlistItemRow[]) => void;
  onJumpToChart: (symbol: string) => void;
  onModalOpenChange?: (open: boolean) => void;
}

function parseOverride(json: string | null): WatchlistThresholdOverride {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as WatchlistThresholdOverride;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function formatSourceLabel(source: string): string {
  switch (source) {
    case 'hithink':
      return '同花顺';
    case 'eastmoney':
      return '东财';
    case 'tencent':
      return '腾讯';
    default:
      return source;
  }
}

interface ThresholdDraft {
  symbol: string;
  name: string;
  slopeWindow: '' | '3' | '5' | '10';
  surgeSlopeThreshold: string;
  surgeMultipleThreshold: string;
  shrinkSlopeThreshold: string;
  shrinkMultipleThreshold: string;
  matchMode: '' | AlertMatchModeType;
  cooldownMinutes: string;
}

export function WatchlistPanel({
  watchlistRows,
  market,
  globalConfig,
  onWatchlistChanged,
  onJumpToChart,
  onModalOpenChange,
}: WatchlistPanelProps) {
  const [keyword, setKeyword] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<TickerSearchResult[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [draggingSymbol, setDraggingSymbol] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<ThresholdDraft | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchReqIdRef = useRef<number>(0);

  const existingSymbols = new Set(watchlistRows.map((w) => w.symbol));

  // 同步模态框开关状态至主进程，并在弹窗打开时用 Esc 仅关闭弹窗而不隐藏整个详情窗口
  useEffect(() => {
    const isOpen = editingDraft !== null;
    onModalOpenChange?.(isOpen);
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setEditingDraft(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [editingDraft, onModalOpenChange]);

  useEffect(() => {
    return () => {
      onModalOpenChange?.(false);
    };
  }, [onModalOpenChange]);

  useEffect(() => {
    const trimmed = keyword.trim();
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchReqIdRef.current += 1;
    const reqId = searchReqIdRef.current;

    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }

    searchTimerRef.current = setTimeout(() => {
      setSearching(true);
      setErrorMsg(null);
      void window.api
        .searchTickers(trimmed, 10)
        .then((list) => {
          if (reqId !== searchReqIdRef.current) return;
          setResults(list);
        })
        .catch((err: unknown) => {
          if (reqId !== searchReqIdRef.current) return;
          setErrorMsg(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (reqId !== searchReqIdRef.current) return;
          setSearching(false);
        });
    }, 280);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [keyword]);

  const handleAdd = async (item: TickerSearchResult) => {
    setErrorMsg(null);
    try {
      const next = await window.api.addWatchlistItem({ symbol: item.symbol, name: item.name });
      onWatchlistChanged(next);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemove = async (symbol: string) => {
    setErrorMsg(null);
    try {
      const next = await window.api.removeWatchlistItem(symbol);
      onWatchlistChanged(next);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleMove = async (index: number, delta: -1 | 1) => {
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= watchlistRows.length) return;
    setErrorMsg(null);
    try {
      const symbols = watchlistRows.map((w) => w.symbol);
      const [moved] = symbols.splice(index, 1);
      symbols.splice(targetIdx, 0, moved);
      const next = await window.api.reorderWatchlist(symbols);
      onWatchlistChanged(next);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDropOn = async (targetSymbol: string) => {
    if (!draggingSymbol || draggingSymbol === targetSymbol) {
      setDraggingSymbol(null);
      return;
    }
    const symbols = watchlistRows.map((w) => w.symbol);
    const fromIdx = symbols.indexOf(draggingSymbol);
    const toIdx = symbols.indexOf(targetSymbol);
    if (fromIdx < 0 || toIdx < 0) {
      setDraggingSymbol(null);
      return;
    }
    const [moved] = symbols.splice(fromIdx, 1);
    symbols.splice(toIdx, 0, moved);
    setDraggingSymbol(null);
    setErrorMsg(null);
    try {
      const next = await window.api.reorderWatchlist(symbols);
      onWatchlistChanged(next);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleAlert = async (symbol: string, alertEnabled: boolean) => {
    setErrorMsg(null);
    try {
      const next = await window.api.updateWatchlistItem({ symbol, alertEnabled });
      onWatchlistChanged(next);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const openThresholdModal = (row: WatchlistItemRow) => {
    const ov = parseOverride(row.customThresholdsJson);
    setEditingDraft({
      symbol: row.symbol,
      name: row.name,
      slopeWindow: ov.slopeWindow ? (String(ov.slopeWindow) as '3' | '5' | '10') : '',
      surgeSlopeThreshold:
        ov.surgeSlopeThreshold !== undefined ? String(ov.surgeSlopeThreshold) : '',
      surgeMultipleThreshold:
        ov.surgeMultipleThreshold !== undefined ? String(ov.surgeMultipleThreshold) : '',
      shrinkSlopeThreshold:
        ov.shrinkSlopeThreshold !== undefined ? String(ov.shrinkSlopeThreshold) : '',
      shrinkMultipleThreshold:
        ov.shrinkMultipleThreshold !== undefined ? String(ov.shrinkMultipleThreshold) : '',
      matchMode: ov.matchMode ?? '',
      cooldownMinutes: ov.cooldownMinutes !== undefined ? String(ov.cooldownMinutes) : '',
    });
  };

  const saveThresholdModal = async () => {
    if (!editingDraft) return;
    const override: WatchlistThresholdOverride = {};
    if (editingDraft.slopeWindow) {
      override.slopeWindow = Number(editingDraft.slopeWindow) as SlopeWindowOption;
    }
    if (editingDraft.surgeSlopeThreshold.trim()) {
      override.surgeSlopeThreshold = Number(editingDraft.surgeSlopeThreshold);
    }
    if (editingDraft.surgeMultipleThreshold.trim()) {
      override.surgeMultipleThreshold = Number(editingDraft.surgeMultipleThreshold);
    }
    if (editingDraft.shrinkSlopeThreshold.trim()) {
      override.shrinkSlopeThreshold = Number(editingDraft.shrinkSlopeThreshold);
    }
    if (editingDraft.shrinkMultipleThreshold.trim()) {
      override.shrinkMultipleThreshold = Number(editingDraft.shrinkMultipleThreshold);
    }
    if (editingDraft.matchMode) {
      override.matchMode = editingDraft.matchMode;
    }
    if (editingDraft.cooldownMinutes.trim()) {
      override.cooldownMinutes = Number(editingDraft.cooldownMinutes);
    }

    const payload = Object.keys(override).length > 0 ? override : null;
    setErrorMsg(null);
    try {
      const next = await window.api.updateWatchlistItem({
        symbol: editingDraft.symbol,
        customThresholds: payload,
      });
      onWatchlistChanged(next);
      setEditingDraft(null);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const resetThresholdsToGlobal = async () => {
    if (!editingDraft) return;
    setErrorMsg(null);
    try {
      const next = await window.api.updateWatchlistItem({
        symbol: editingDraft.symbol,
        customThresholds: null,
      });
      onWatchlistChanged(next);
      setEditingDraft(null);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* 搜索添加区 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>搜索并添加自选股（同花顺优先，公开源兜底）</span>
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 400 }}>
            支持 6 位代码或中文简称
          </span>
        </h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input
            type="text"
            className="text-input"
            style={{ flex: 1 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="输入代码或名称，例如 600519、宁德时代、中芯国际…"
          />
          {keyword && (
            <button type="button" className="btn" onClick={() => setKeyword('')}>
              清空
            </button>
          )}
        </div>

        {errorMsg && (
          <div className="tone-warn" style={{ marginTop: '8px', fontSize: '12px' }}>
            ⚠ {errorMsg}
          </div>
        )}

        {searching && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            正在检索标的…
          </div>
        )}

        {!searching && results.length > 0 && (
          <div className="search-result-list">
            {results.map((item) => {
              const upperSym = item.symbol.toUpperCase();
              const added = existingSymbols.has(item.symbol);
              const isCoreIndex = CORE_INDEX_SYMBOL_SET.has(upperSym);
              const isOptionalIndex = OPTIONAL_INDEX_SYMBOL_SET.has(upperSym);
              return (
                <div key={item.symbol} className="search-result-row">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <strong>{item.name}</strong>
                    <span className="muted-mono">{item.symbol}</span>
                    <span className="scope-tag">{formatSourceLabel(item.source)}</span>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={added || isCoreIndex || isOptionalIndex}
                    onClick={() => void handleAdd(item)}
                  >
                    {isCoreIndex
                      ? '请在设置中配置'
                      : isOptionalIndex
                        ? '请在设置中开启'
                        : added
                          ? '已添加'
                          : '+ 加入自选'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 自选股管理表 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>已监控自选股（共 {watchlistRows.length} 只 · 支持拖拽或按钮排序）</span>
        </h2>

        {watchlistRows.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: '12px', padding: '12px 0' }}>
            尚未添加自选股。添加后将在 HUD 中同步展示，并在下一轮轮询中自动补齐今/昨 1 分钟分时基线。
          </div>
        ) : (
          <div className="watchlist-manage-list">
            {watchlistRows.map((row, idx) => {
              const snap = market?.watchlist.find((w) => w.symbol === row.symbol) ?? null;
              const price = resolveSymbolPrice(snap);
              const pct = resolveSymbolChangePct(snap);
              const turnover = resolveSymbolTurnover(snap);
              const badge = formatVolumeState(snap?.metrics?.volumeState);
              const hasCustom = Boolean(row.customThresholdsJson);
              const toneClass = getSignedToneClass(pct);

              return (
                <div
                  key={row.symbol}
                  className={`watchlist-manage-row ${draggingSymbol === row.symbol ? 'dragging' : ''}`}
                  draggable
                  onDragStart={() => setDraggingSymbol(row.symbol)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => void handleDropOn(row.symbol)}
                  onDragEnd={() => setDraggingSymbol(null)}
                >
                  <div className="wl-col-drag" title="按住拖拽排序">
                    ⋮⋮
                  </div>
                  <div
                    className="wl-col-name"
                    onClick={() => onJumpToChart(row.symbol)}
                    title="点击查看该股分时能量图"
                  >
                    <strong>{row.name}</strong>
                    <span className="muted-mono">{row.symbol}</span>
                  </div>
                  <div className="wl-col-quote">
                    <span>{formatPrice(price)}</span>
                    <span className={toneClass}>{formatSignedPct(pct, 2)}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {turnover !== null ? formatTurnover(turnover) : '待拉取/降级'}
                    </span>
                    <span className={`badge badge-compact badge-${badge.tone}`}>{badge.label}</span>
                  </div>
                  <div className="wl-col-actions">
                    <label className="inline-check" title="单股急放/急缩告警开关">
                      <input
                        type="checkbox"
                        checked={row.alertEnabled}
                        onChange={(e) => void handleToggleAlert(row.symbol, e.target.checked)}
                      />
                      <span>提醒</span>
                    </label>
                    <button
                      type="button"
                      className={`btn btn-sm ${hasCustom ? 'btn-accent' : ''}`}
                      onClick={() => openThresholdModal(row)}
                    >
                      {hasCustom ? '已自定义阈值' : '阈值'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={idx === 0}
                      title="上移"
                      onClick={() => void handleMove(idx, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={idx === watchlistRows.length - 1}
                      title="下移"
                      onClick={() => void handleMove(idx, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => void handleRemove(row.symbol)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 单股自定义阈值弹窗 */}
      {editingDraft && (
        <div className="modal-backdrop" onClick={() => setEditingDraft(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="panel-title">
              <span>
                单股告警阈值覆写 · {editingDraft.name} ({editingDraft.symbol})
              </span>
              <button type="button" className="icon-btn" onClick={() => setEditingDraft(null)}>
                ×
              </button>
            </h3>
            <div className="setting-desc" style={{ marginBottom: '10px' }}>
              留空表示沿用全局默认设置（当前全局：窗口 {globalConfig?.slopeWindow ?? 5} 分钟，急放{' '}
              +{globalConfig?.surgeSlopeThreshold ?? 3.0}%/分 & {globalConfig?.surgeMultipleThreshold ?? 1.5}x，急缩{' '}
              {globalConfig?.shrinkSlopeThreshold ?? -3.0}%/分 & {globalConfig?.shrinkMultipleThreshold ?? 0.65}x，模式{' '}
              {globalConfig?.matchMode ?? 'AND'}）。
            </div>

            <div className="modal-form-grid">
              <label className="form-field">
                <span>斜率窗口（分钟）</span>
                <select
                  className="text-input"
                  value={editingDraft.slopeWindow}
                  onChange={(e) =>
                    setEditingDraft({
                      ...editingDraft,
                      slopeWindow: e.target.value as '' | '3' | '5' | '10',
                    })
                  }
                >
                  <option value="">跟随全局 ({globalConfig?.slopeWindow ?? 5}m)</option>
                  <option value="3">3 分钟</option>
                  <option value="5">5 分钟</option>
                  <option value="10">10 分钟</option>
                </select>
              </label>

              <label className="form-field">
                <span>触发组合模式</span>
                <select
                  className="text-input"
                  value={editingDraft.matchMode}
                  onChange={(e) =>
                    setEditingDraft({
                      ...editingDraft,
                      matchMode: e.target.value as '' | AlertMatchModeType,
                    })
                  }
                >
                  <option value="">跟随全局 ({globalConfig?.matchMode ?? 'AND'})</option>
                  <option value="AND">且 (AND) — 双指标同时满足</option>
                  <option value="OR">或 (OR) — 任一指标满足</option>
                </select>
              </label>

              <label className="form-field">
                <span>急放斜率阈值 (%/分)</span>
                <input
                  type="number"
                  step="0.1"
                  className="text-input"
                  placeholder={String(
                    globalConfig?.surgeSlopeThreshold ?? DEFAULT_ALERT_CONFIG.surgeSlopeThreshold
                  )}
                  value={editingDraft.surgeSlopeThreshold}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, surgeSlopeThreshold: e.target.value })
                  }
                />
              </label>

              <label className="form-field">
                <span>急放区间倍数 (x)</span>
                <input
                  type="number"
                  step="0.05"
                  className="text-input"
                  placeholder={String(globalConfig?.surgeMultipleThreshold ?? 1.5)}
                  value={editingDraft.surgeMultipleThreshold}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, surgeMultipleThreshold: e.target.value })
                  }
                />
              </label>

              <label className="form-field">
                <span>急缩斜率阈值 (%/分)</span>
                <input
                  type="number"
                  step="0.1"
                  className="text-input"
                  placeholder={String(
                    globalConfig?.shrinkSlopeThreshold ?? DEFAULT_ALERT_CONFIG.shrinkSlopeThreshold
                  )}
                  value={editingDraft.shrinkSlopeThreshold}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, shrinkSlopeThreshold: e.target.value })
                  }
                />
              </label>

              <label className="form-field">
                <span>急缩区间倍数 (x)</span>
                <input
                  type="number"
                  step="0.05"
                  className="text-input"
                  placeholder={String(globalConfig?.shrinkMultipleThreshold ?? 0.65)}
                  value={editingDraft.shrinkMultipleThreshold}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, shrinkMultipleThreshold: e.target.value })
                  }
                />
              </label>

              <label className="form-field">
                <span>冷却时长（分钟）</span>
                <input
                  type="number"
                  step="1"
                  min={1}
                  max={120}
                  className="text-input"
                  placeholder={String(globalConfig?.cooldownMinutes ?? 5)}
                  value={editingDraft.cooldownMinutes}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, cooldownMinutes: e.target.value })
                  }
                />
              </label>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn"
                onClick={() => void resetThresholdsToGlobal()}
              >
                恢复跟随全局默认
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" className="btn" onClick={() => setEditingDraft(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={() => void saveThresholdModal()}
                >
                  保存覆写
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
