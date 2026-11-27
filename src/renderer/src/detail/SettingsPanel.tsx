import { useEffect, useRef, useState } from 'react';
import {
  ALLOWED_SLOPE_WINDOWS,
  CORE_INDICES,
  CORE_INDEX_SYMBOLS,
  OPTIONAL_INDICES,
  normalizeEnabledCoreIndices,
  normalizeEnabledOptionalIndices,
  type CoreIndexSymbol,
  type OptionalIndexSymbol,
} from '../../../shared/constants';
import type {
  AlertMatchModeType,
  BossKeyStatus,
  DatabaseRetentionStats,
  DesktopShellState,
  MonitorConfig,
  ProviderHealthStatus,
  SecretStatus,
  SlopeWindowOption,
} from '../../../shared/types';

export interface SettingsPanelProps {
  shell: DesktopShellState | null;
  monitorConfig: MonitorConfig | null;
  bossKeyInput: string;
  bossKeyFeedback: BossKeyStatus | null;
  onBossKeyInputChange: (val: string) => void;
  onSaveBossKey: () => Promise<void>;
  onKeepCurrentBossKey: () => Promise<void>;
  onMonitorConfigUpdated: (next: MonitorConfig) => void;
}

interface NumericDraftStrings {
  expandThresholdPct: string;
  shrinkThresholdPct: string;
  surgeSlopeThreshold: string;
  surgeMultipleThreshold: string;
  shrinkSlopeThreshold: string;
  shrinkMultipleThreshold: string;
  cooldownMinutes: string;
}

function toNumericDraftStrings(cfg: MonitorConfig): NumericDraftStrings {
  return {
    expandThresholdPct: String(cfg.expandThresholdPct),
    shrinkThresholdPct: String(cfg.shrinkThresholdPct),
    surgeSlopeThreshold: String(cfg.surgeSlopeThreshold),
    surgeMultipleThreshold: String(cfg.surgeMultipleThreshold),
    shrinkSlopeThreshold: String(cfg.shrinkSlopeThreshold),
    shrinkMultipleThreshold: String(cfg.shrinkMultipleThreshold),
    cooldownMinutes: String(cfg.cooldownMinutes),
  };
}

function parseFiniteOrFallback(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : fallback;
}

function formatSecretSource(source: SecretStatus['source']): string {
  switch (source) {
    case 'safeStorage':
      return '软件内加密存储 (safeStorage)';
    case 'env':
      return '环境变量 (HITHINK_FINANCE_API_KEY)';
    case 'credentialsFile':
      return '本地凭据文件 (credentials.env)';
    default:
      return '未配置';
  }
}

export function SettingsPanel({
  shell,
  monitorConfig,
  bossKeyInput,
  bossKeyFeedback,
  onBossKeyInputChange,
  onSaveBossKey,
  onKeepCurrentBossKey,
  onMonitorConfigUpdated,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<MonitorConfig | null>(monitorConfig);
  const [numDraft, setNumDraft] = useState<NumericDraftStrings | null>(
    monitorConfig ? toNumericDraftStrings(monitorConfig) : null
  );
  const [savingMonitor, setSavingMonitor] = useState(false);
  const [monitorSavedTip, setMonitorSavedTip] = useState<string | null>(null);
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const savedTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyFeedback, setKeyFeedback] = useState<string | null>(null);
  const [healthResult, setHealthResult] = useState<ProviderHealthStatus | null>(null);

  const [retention, setRetention] = useState<DatabaseRetentionStats | null>(null);

  useEffect(() => {
    if (monitorConfig) {
      setDraft(monitorConfig);
      setNumDraft(toNumericDraftStrings(monitorConfig));
    }
  }, [monitorConfig]);

  useEffect(() => {
    return () => {
      if (savedTipTimerRef.current) {
        clearTimeout(savedTipTimerRef.current);
      }
    };
  }, []);

  const loadStorageAndSecret = () => {
    void window.api.getSecretStatus().then(setSecretStatus).catch(() => {});
    void window.api.getDatabaseRetentionStats().then(setRetention).catch(() => {});
  };

  useEffect(() => {
    loadStorageAndSecret();
  }, []);

  const applyMonitorPatch = async (patch: Partial<MonitorConfig>) => {
    setSavingMonitor(true);
    setMonitorSavedTip(null);
    setMonitorError(null);
    if (savedTipTimerRef.current) {
      clearTimeout(savedTipTimerRef.current);
      savedTipTimerRef.current = null;
    }
    try {
      const updated = await window.api.updateMonitorConfig(patch);
      setDraft(updated);
      setNumDraft(toNumericDraftStrings(updated));
      onMonitorConfigUpdated(updated);
      setMonitorSavedTip('已保存并实时生效');
      savedTipTimerRef.current = setTimeout(() => {
        setMonitorSavedTip(null);
        savedTipTimerRef.current = null;
      }, 2200);
    } catch (err: unknown) {
      setMonitorError(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingMonitor(false);
    }
  };

  const handleSaveMonitorDraft = () => {
    if (!draft || !numDraft) return;
    const payload: Partial<MonitorConfig> = {
      pollingIntervalSec: draft.pollingIntervalSec,
      slopeWindow: draft.slopeWindow,
      alertsEnabled: draft.alertsEnabled,
      matchMode: draft.matchMode,
      expandThresholdPct: parseFiniteOrFallback(
        numDraft.expandThresholdPct,
        draft.expandThresholdPct
      ),
      shrinkThresholdPct: parseFiniteOrFallback(
        numDraft.shrinkThresholdPct,
        draft.shrinkThresholdPct
      ),
      surgeSlopeThreshold: parseFiniteOrFallback(
        numDraft.surgeSlopeThreshold,
        draft.surgeSlopeThreshold
      ),
      surgeMultipleThreshold: parseFiniteOrFallback(
        numDraft.surgeMultipleThreshold,
        draft.surgeMultipleThreshold
      ),
      shrinkSlopeThreshold: parseFiniteOrFallback(
        numDraft.shrinkSlopeThreshold,
        draft.shrinkSlopeThreshold
      ),
      shrinkMultipleThreshold: parseFiniteOrFallback(
        numDraft.shrinkMultipleThreshold,
        draft.shrinkMultipleThreshold
      ),
      cooldownMinutes: parseFiniteOrFallback(numDraft.cooldownMinutes, draft.cooldownMinutes),
    };
    void applyMonitorPatch(payload);
  };

  const enabledCoreSet = new Set<string>(
    monitorConfig?.enabledCoreIndices ?? draft?.enabledCoreIndices ?? CORE_INDEX_SYMBOLS
  );

  const enabledOptionalSet = new Set<string>(
    monitorConfig?.enabledOptionalIndices ?? draft?.enabledOptionalIndices ?? []
  );

  const handleToggleCoreIndex = (symbol: CoreIndexSymbol, enabled: boolean) => {
    const nextSet = new Set(enabledCoreSet);
    if (enabled) {
      nextSet.add(symbol);
    } else {
      nextSet.delete(symbol);
    }
    const nextList = normalizeEnabledCoreIndices([...nextSet]);
    void applyMonitorPatch({ enabledCoreIndices: nextList });
  };

  const handleToggleOptionalIndex = (symbol: OptionalIndexSymbol, enabled: boolean) => {
    const nextSet = new Set(enabledOptionalSet);
    if (enabled) {
      nextSet.add(symbol);
    } else {
      nextSet.delete(symbol);
    }
    const nextList = normalizeEnabledOptionalIndices([...nextSet]);
    void applyMonitorPatch({ enabledOptionalIndices: nextList });
  };

  const handleSaveApiKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setKeyFeedback('请输入有效的同花顺 API Key');
      return;
    }
    setKeyBusy(true);
    setKeyFeedback(null);
    setHealthResult(null);
    try {
      const nextStatus = await window.api.saveSecretApiKey(trimmed);
      setSecretStatus(nextStatus);
      // 立即清空明文输入框，绝不在界面留存明文
      setApiKeyInput('');
      setKeyFeedback('已通过系统 safeStorage 加密保存，明文已清空并已触发交易日历刷新');
    } catch (err: unknown) {
      setKeyFeedback(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setKeyBusy(false);
    }
  };

  const handleClearApiKey = async () => {
    setKeyBusy(true);
    setKeyFeedback(null);
    setHealthResult(null);
    try {
      const nextStatus = await window.api.clearSecretApiKey();
      setSecretStatus(nextStatus);
      setKeyFeedback('已清除软件内加密保存的 API Key');
    } catch (err: unknown) {
      setKeyFeedback(`清除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setKeyBusy(false);
    }
  };

  const handleTestConnection = async () => {
    setKeyBusy(true);
    setHealthResult(null);
    setKeyFeedback(null);
    try {
      const res = await window.api.testHithinkConnection();
      setHealthResult(res);
    } catch (err: unknown) {
      setHealthResult({
        provider: 'hithink',
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setKeyBusy(false);
    }
  };

  const opacityPct = Math.round((shell?.settings.hudOpacity ?? 0.9) * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* 0. 大盘与可选扩展指数展示配置 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>指数展示配置（勾选即刻生效并持久化）</span>
          <span className="badge badge-muted">
            已展示 {enabledCoreSet.size + enabledOptionalSet.size}/
            {CORE_INDICES.length + OPTIONAL_INDICES.length} 项指数
          </span>
        </h2>
        <div className="setting-desc" style={{ marginBottom: '10px' }}>
          所有主要板块指数与扩展宽基指数均可独立开关展示；关闭上证指数展示不会影响顶部「沪深两市总成交额」计算与两市分时图右轴点位参照（以下指数均不参与两市总成交额重复累加）。
        </div>

        <div className="index-group-label">主要板块指数（默认开启，可设为不展示）</div>
        <div className="optional-index-grid" style={{ marginBottom: '10px' }}>
          {CORE_INDICES.map((idx) => {
            const symbol = idx.symbol as CoreIndexSymbol;
            const checked = enabledCoreSet.has(symbol);
            return (
              <label
                key={idx.symbol}
                className={`optional-index-card ${checked ? 'active' : ''}`}
              >
                <div className="optional-index-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={savingMonitor}
                      onChange={(e) => handleToggleCoreIndex(symbol, e.target.checked)}
                    />
                    <strong>{idx.name}</strong>
                    <span className="scope-tag">{idx.scope}</span>
                  </div>
                  <span className="muted-mono">{idx.symbol}</span>
                </div>
                <div className="setting-desc">{idx.scopeDetail}</div>
              </label>
            );
          })}
        </div>

        <div className="index-group-label">扩展宽基指数（默认关闭，按需开启）</div>
        <div className="optional-index-grid">
          {OPTIONAL_INDICES.map((idx) => {
            const symbol = idx.symbol as OptionalIndexSymbol;
            const checked = enabledOptionalSet.has(symbol);
            return (
              <label
                key={idx.symbol}
                className={`optional-index-card ${checked ? 'active' : ''}`}
              >
                <div className="optional-index-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={savingMonitor}
                      onChange={(e) => handleToggleOptionalIndex(symbol, e.target.checked)}
                    />
                    <strong>{idx.name}</strong>
                    <span className="scope-tag">{idx.scope}</span>
                  </div>
                  <span className="muted-mono">{idx.symbol}</span>
                </div>
                <div className="setting-desc">{idx.scopeDetail}</div>
              </label>
            );
          })}
        </div>
      </section>

      {/* 1. 行情轮询与放缩量/斜率告警参数 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>监控频率、放缩量与斜率告警参数（即时生效并持久化）</span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {monitorSavedTip && <span className="badge badge-down">{monitorSavedTip}</span>}
            {monitorError && <span className="badge badge-warn">{monitorError}</span>}
            <button
              type="button"
              className="btn btn-accent"
              disabled={!draft || !numDraft || savingMonitor}
              onClick={handleSaveMonitorDraft}
            >
              {savingMonitor ? '应用中…' : '保存并立即生效'}
            </button>
          </div>
        </h2>

        {draft && numDraft && (
          <div className="settings-grid">
            <div className="setting-row">
              <div>
                <div>盘中快照刷新周期（{draft.pollingIntervalSec} 秒）</div>
                <div className="setting-desc">支持 3–15 秒；异常或限流时自动触发退避降频</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="range"
                  min={3}
                  max={15}
                  step={1}
                  value={draft.pollingIntervalSec}
                  onChange={(e) =>
                    setDraft({ ...draft, pollingIntervalSec: Number(e.target.value) })
                  }
                />
                <span className="muted-mono" style={{ width: '32px', textAlign: 'right' }}>
                  {draft.pollingIntervalSec}s
                </span>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div>放量 / 缩量判定阈值（同比昨日同期）</div>
                <div className="setting-desc">默认 ≥ +5% 判放量、≤ -5% 判缩量，其余为平量</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <label className="inline-num">
                  <span>放量 ≥</span>
                  <input
                    type="number"
                    step="0.5"
                    className="num-input"
                    value={numDraft.expandThresholdPct}
                    onChange={(e) =>
                      setNumDraft({ ...numDraft, expandThresholdPct: e.target.value })
                    }
                  />
                  <span>%</span>
                </label>
                <label className="inline-num">
                  <span>缩量 ≤</span>
                  <input
                    type="number"
                    step="0.5"
                    className="num-input"
                    value={numDraft.shrinkThresholdPct}
                    onChange={(e) =>
                      setNumDraft({ ...numDraft, shrinkThresholdPct: e.target.value })
                    }
                  />
                  <span>%</span>
                </label>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div>滚动斜率窗口长度</div>
                <div className="setting-desc">作用于 OLS 斜率曲线与区间增量倍数（折叠午休后连续计算）</div>
              </div>
              <div className="segmented-group">
                {ALLOWED_SLOPE_WINDOWS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={`seg-btn ${draft.slopeWindow === w ? 'active' : ''}`}
                    onClick={() => setDraft({ ...draft, slopeWindow: w as SlopeWindowOption })}
                  >
                    {w} 分钟
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div>快速放量（急放）触发阈值</div>
                <div className="setting-desc">默认边际量比斜率 ≥ +3.0%/分，区间增量倍数 ≥ 1.5x</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <label className="inline-num">
                  <span>斜率 ≥</span>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input"
                    value={numDraft.surgeSlopeThreshold}
                    onChange={(e) =>
                      setNumDraft({ ...numDraft, surgeSlopeThreshold: e.target.value })
                    }
                  />
                  <span>%/分</span>
                </label>
                <label className="inline-num">
                  <span>倍数 ≥</span>
                  <input
                    type="number"
                    step="0.05"
                    className="num-input"
                    value={numDraft.surgeMultipleThreshold}
                    onChange={(e) =>
                      setNumDraft({ ...numDraft, surgeMultipleThreshold: e.target.value })
                    }
                  />
                  <span>x</span>
                </label>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div>快速缩量（急缩）触发阈值</div>
                <div className="setting-desc">默认边际量比斜率 ≤ -3.0%/分，区间增量倍数 ≤ 0.65x</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <label className="inline-num">
                  <span>斜率 ≤</span>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input"
                    value={numDraft.shrinkSlopeThreshold}
                    onChange={(e) =>
                      setNumDraft({ ...numDraft, shrinkSlopeThreshold: e.target.value })
                    }
                  />
                  <span>%/分</span>
                </label>
                <label className="inline-num">
                  <span>倍数 ≤</span>
                  <input
                    type="number"
                    step="0.05"
                    className="num-input"
                    value={numDraft.shrinkMultipleThreshold}
                    onChange={(e) =>
                      setNumDraft({ ...numDraft, shrinkMultipleThreshold: e.target.value })
                    }
                  />
                  <span>x</span>
                </label>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div>双指标组合模式、冷却时长与告警总开关</div>
                <div className="setting-desc">同标的同方向触发后在冷却期内不重复弹窗与发声</div>
              </div>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <div className="segmented-group">
                  {(['AND', 'OR'] as AlertMatchModeType[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`seg-btn ${draft.matchMode === mode ? 'active' : ''}`}
                      onClick={() => setDraft({ ...draft, matchMode: mode })}
                    >
                      {mode === 'AND' ? '且 (AND)' : '或 (OR)'}
                    </button>
                  ))}
                </div>
                <label className="inline-num">
                  <span>冷却</span>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    step={1}
                    className="num-input"
                    value={numDraft.cooldownMinutes}
                    onChange={(e) =>
                      setNumDraft({ ...numDraft, cooldownMinutes: e.target.value })
                    }
                  />
                  <span>分</span>
                </label>
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={draft.alertsEnabled}
                    onChange={(e) => setDraft({ ...draft, alertsEnabled: e.target.checked })}
                  />
                  <span>启用全局告警</span>
                </label>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 2. 同花顺 Fuyao API Key 安全管理 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>同花顺 Fuyao API Key（加密落盘，永不回显明文）</span>
          <span className={`badge ${secretStatus?.configured ? 'badge-down' : 'badge-muted'}`}>
            {secretStatus?.configured ? '已配置' : '未配置'}
          </span>
        </h2>

        <div className="settings-grid">
          <div className="setting-row">
            <div>
              <div>当前凭据来源：{secretStatus ? formatSecretSource(secretStatus.source) : '读取中…'}</div>
              <div className="setting-desc">
                读取优先级：safeStorage 本地加密 → HITHINK_FINANCE_API_KEY → credentials.env
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                className="btn"
                disabled={keyBusy}
                onClick={() => void handleTestConnection()}
              >
                {keyBusy ? '测试中…' : '连接测试'}
              </button>
              {secretStatus?.source === 'safeStorage' && (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={keyBusy}
                  onClick={() => void handleClearApiKey()}
                >
                  清除已存 Key
                </button>
              )}
            </div>
          </div>

          <div className="setting-row">
            <div style={{ flex: 1 }}>
              <div>更新 / 保存 API Key</div>
              <div className="setting-desc">
                {secretStatus?.encryptionAvailable === false
                  ? '当前系统 safeStorage 不可用，请改用环境变量配置'
                  : '保存后使用 Windows DPAPI 加密写入本地文件，界面不回显'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                type="password"
                autoComplete="off"
                className="text-input"
                style={{ width: '210px' }}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="输入新同花顺 API Key"
              />
              <button
                type="button"
                className="btn btn-accent"
                disabled={keyBusy || secretStatus?.encryptionAvailable === false}
                onClick={() => void handleSaveApiKey()}
              >
                加密保存
              </button>
            </div>
          </div>

          {keyFeedback && (
            <div style={{ fontSize: '12px', color: '#79c0ff' }}>{keyFeedback}</div>
          )}

          {healthResult && (
            <div
              style={{
                fontSize: '12px',
                color: healthResult.ok ? '#56d364' : '#ff7b72',
              }}
            >
              {healthResult.ok
                ? `✓ 连接测试成功（延迟 ${healthResult.latencyMs}ms）`
                : `✕ 连接测试失败：${healthResult.error ?? '未知错误'}`}
            </div>
          )}
        </div>
      </section>

      {/* 3. 桌面外壳与老板键 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>桌面外壳、提示音与全局老板键</span>
        </h2>
        <div className="settings-grid">
          <div className="setting-row">
            <div>
              <div>悬浮窗展示模式</div>
              <div className="setting-desc">
                极简模式仅展示沪深总成交与前 3 条自选股，并隐藏大部分控制按钮
              </div>
            </div>
            <div className="segmented-group">
              <button
                type="button"
                className={`seg-btn ${(shell?.settings.hudMode ?? 'standard') === 'standard' ? 'active' : ''}`}
                onClick={() => void window.api.setHudMode('standard')}
              >
                标准模式
              </button>
              <button
                type="button"
                className={`seg-btn ${shell?.settings.hudMode === 'minimal' ? 'active' : ''}`}
                onClick={() => void window.api.setHudMode('minimal')}
              >
                极简模式
              </button>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div>HUD 窗口透明度（{opacityPct}%）</div>
              <div className="setting-desc">支持 30%–100%，重启后自动恢复</div>
            </div>
            <input
              type="range"
              min={30}
              max={100}
              step={5}
              value={opacityPct}
              onChange={(e) => void window.api.setHudOpacity(Number(e.target.value) / 100)}
            />
          </div>

          <div className="setting-row">
            <div>
              <div>窗口行为与提示音</div>
              <div className="setting-desc">静音仅关闭提示音，写库、通知与呼吸高亮照常</div>
            </div>
            <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={shell?.settings.alwaysOnTop ?? true}
                  onChange={(e) => void window.api.setAlwaysOnTop(e.target.checked)}
                />
                <span>始终置顶</span>
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={shell?.settings.muted ?? false}
                  onChange={(e) => void window.api.setMuted(e.target.checked)}
                />
                <span>静音提醒</span>
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={shell?.settings.autoLaunch ?? false}
                  onChange={(e) => void window.api.setAutoLaunch(e.target.checked)}
                />
                <span>开机自启</span>
              </label>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <div>全局老板键（一键隐藏 / 恢复所有窗口）</div>
              <div className="setting-desc">
                当前生效：
                {bossKeyFeedback?.registered
                  ? `已生效 (${bossKeyFeedback.accelerator})`
                  : '未注册'}
              </div>
              {bossKeyFeedback?.conflictMessage && (
                <div className="setting-desc tone-warn" role="alert">
                  ⚠ {bossKeyFeedback.conflictMessage}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input
                type="text"
                className="text-input"
                value={bossKeyInput}
                onChange={(e) => onBossKeyInputChange(e.target.value)}
                placeholder="例如 Alt+Shift+A"
              />
              <button type="button" className="btn" onClick={() => void onSaveBossKey()}>
                应用改绑
              </button>
              {bossKeyFeedback?.registered && bossKeyFeedback.conflictMessage && (
                <button
                  type="button"
                  className="btn"
                  title="清除冲突提示并恢复当前生效快捷键"
                  onClick={() => void onKeepCurrentBossKey()}
                >
                  保留当前键
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 4. 本地 SQLite 30 交易日留存统计 */}
      <section className="panel-card">
        <h2 className="panel-title">
          <span>本地 SQLite 留存统计（自动滚动保留近 30 个交易日）</span>
          <button type="button" className="btn btn-sm" onClick={loadStorageAndSecret}>
            刷新统计
          </button>
        </h2>
        {retention ? (
          <div className="retention-grid">
            <div className="metric-item">
              <div className="metric-label">缓存交易日历</div>
              <div className="metric-value">{retention.tradingDaysCount} 天</div>
            </div>
            <div className="metric-item">
              <div className="metric-label">1 分钟分时记录</div>
              <div className="metric-value">{retention.intradayBarsCount.toLocaleString('zh-CN')}</div>
            </div>
            <div className="metric-item">
              <div className="metric-label">分时覆盖交易日</div>
              <div className="metric-value">{retention.distinctBarDatesCount} 天</div>
            </div>
            <div className="metric-item">
              <div className="metric-label">竞价快照 / 告警 / 自选</div>
              <div className="metric-value" style={{ fontSize: '13px' }}>
                {retention.auctionSnapshotsCount} / {retention.alertEventsCount} /{' '}
                {retention.watchlistCount}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>正在读取统计…</div>
        )}
      </section>
    </div>
  );
}
