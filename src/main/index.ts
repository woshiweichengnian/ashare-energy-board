import path from 'node:path';
import { app, ipcMain, safeStorage } from 'electron';
import { fetchMarketSentiment, startExtrasPoller, type ExtrasPoller } from './extras/extrasPoller';
import { getShanghaiParts } from '../core/tradingClock';
import {
  APP_USER_MODEL_ID,
  DATABASE_FILENAME,
  DEFAULT_RETENTION_TRADING_DAYS,
  ENCRYPTED_KEY_FILENAME,
  MARKET_TOTAL_SYMBOL,
} from '../shared/constants';
import { IPC_CHANNELS } from '../shared/ipc';
import type {
  AlertDirection,
  AlertEventInput,
  BootstrapState,
  DesktopShellSettings,
  DesktopShellState,
  HudMode,
  MarketDashboardState,
  MonitorConfig,
  OpenDetailOptions,
  ProviderHealthStatus,
  WatchlistAddInput,
  WatchlistUpdateInput,
} from '../shared/types';
import { AlertDispatcher } from './alerts';
import {
  EastmoneyProvider,
  HithinkProvider,
  SinaProvider,
  TencentProvider,
} from './providers';
import { DayReplayEngine, parseReplayArgs, type ReplayCliOptions } from './replay';
import { PollingScheduler } from './scheduler';
import { AppDatabase } from './storage/database';
import { migrateLegacyUserDataDir } from './storage/legacyDataMigration';
import { MonitorSettingsStore } from './storage/monitorSettingsStore';
import { SecretStore } from './storage/secretStore';
import { WatchlistService } from './storage/watchlistService';
import { BossKeyManager, TrayManager } from './tray';
import {
  ShellSettingsStore,
  WindowManager,
  resolvePreloadPath,
  resolveRendererHtmlPath,
} from './windows';
import { resolveAutoLaunchSettings } from './windows/autoLaunch';

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}
// 允许无用户点击手势前在常驻 HUD 播放 Web Audio 告警提示音
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const isDevMode = !app.isPackaged;
const singleInstanceLock = app.requestSingleInstanceLock();

let database: AppDatabase | null = null;
let secretStore: SecretStore | null = null;
let settingsStore: ShellSettingsStore | null = null;
let monitorSettingsStore: MonitorSettingsStore | null = null;
let watchlistService: WatchlistService | null = null;
let hithinkProvider: HithinkProvider | null = null;
let shellSettings: DesktopShellSettings | null = null;
let windowManager: WindowManager | null = null;
let trayManager: TrayManager | null = null;
let bossKeyManager: BossKeyManager | null = null;
let alertDispatcher: AlertDispatcher | null = null;
let scheduler: PollingScheduler | null = null;
let replayEngine: DayReplayEngine | null = null;
let replayCliOptions: ReplayCliOptions | null = null;

let replayCliParseError: string | null = null;

if (isDevMode) {
  try {
    replayCliOptions = parseReplayArgs(process.argv);
  } catch (err: unknown) {
    replayCliParseError = err instanceof Error ? err.message : String(err);
    console.error('[main] Invalid --replay argument:', replayCliParseError);
  }
}

function buildShellState(): DesktopShellState {
  if (!shellSettings || !windowManager || !bossKeyManager) {
    throw new Error('Desktop shell services are not initialized.');
  }
  return {
    settings: { ...shellSettings },
    bossKeyStatus: bossKeyManager.getStatus(),
    hudVisible: windowManager.isHudVisible(),
    detailVisible: windowManager.isDetailVisible(),
    activeDetailSymbol: windowManager.getActiveDetailSymbol(),
    activeDetailTab: windowManager.getActiveDetailTab(),
    detailFocusSeq: windowManager.getDetailFocusSeq(),
    isDev: isDevMode,
  };
}

function syncShellState(): DesktopShellState {
  const state = buildShellState();
  trayManager?.updateShellState(state);
  windowManager?.broadcast(IPC_CHANNELS.SHELL_STATE_UPDATED, state);
  return state;
}

let extrasPoller: ExtrasPoller | null = null;

function broadcastMarketState(state: MarketDashboardState): void {
  trayManager?.updateMarketState(state);
  windowManager?.broadcast(IPC_CHANNELS.MARKET_STATE_UPDATED, state);
}

function handleAlertTriggered(event: AlertEventInput): void {
  alertDispatcher?.dispatch(event);
}

function applyAutoLaunchSetting(enabled: boolean): boolean {
  const loginItemOptions = resolveAutoLaunchSettings({
    platform: process.platform,
    isPackaged: app.isPackaged,
    enabled,
    execPath: process.execPath,
    argv: process.argv,
    cwd: process.cwd(),
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
  });
  if (!loginItemOptions) {
    return false;
  }
  try {
    app.setLoginItemSettings(loginItemOptions);
    return true;
  } catch (err: unknown) {
    console.warn(
      '[main] setLoginItemSettings failed:',
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

function applyMonitorConfigToScheduler(config: MonitorConfig): void {
  if (replayEngine) {
    replayEngine.updateEnabledCoreIndices(config.enabledCoreIndices);
    replayEngine.updateEnabledOptionalIndices(config.enabledOptionalIndices);
    replayEngine.updateEnergyConfig({
      expandThresholdPct: config.expandThresholdPct,
      shrinkThresholdPct: config.shrinkThresholdPct,
      slopeWindow: config.slopeWindow,
    });
    replayEngine.updateAlertConfig({
      enabled: config.alertsEnabled,
      surgeSlopeThreshold: config.surgeSlopeThreshold,
      surgeMultipleThreshold: config.surgeMultipleThreshold,
      shrinkSlopeThreshold: config.shrinkSlopeThreshold,
      shrinkMultipleThreshold: config.shrinkMultipleThreshold,
      matchMode: config.matchMode,
      cooldownMinutes: config.cooldownMinutes,
      slopeWindow: config.slopeWindow,
    });
  }
  if (!scheduler) return;
  scheduler.updateEnabledCoreIndices(config.enabledCoreIndices);
  scheduler.updateEnabledOptionalIndices(config.enabledOptionalIndices);
  scheduler.updatePollingInterval(config.pollingIntervalSec);
  scheduler.updateEnergyConfig({
    expandThresholdPct: config.expandThresholdPct,
    shrinkThresholdPct: config.shrinkThresholdPct,
    slopeWindow: config.slopeWindow,
  });
  scheduler.updateAlertConfig({
    enabled: config.alertsEnabled,
    surgeSlopeThreshold: config.surgeSlopeThreshold,
    surgeMultipleThreshold: config.surgeMultipleThreshold,
    shrinkSlopeThreshold: config.shrinkSlopeThreshold,
    shrinkMultipleThreshold: config.shrinkMultipleThreshold,
    matchMode: config.matchMode,
    cooldownMinutes: config.cooldownMinutes,
    slopeWindow: config.slopeWindow,
  });
}

function sanitizeErrorText(text: string | null): string | null {
  if (!text) return null;
  const activeKey = secretStore?.getApiKey();
  if (activeKey && text.includes(activeKey)) {
    return text.split(activeKey).join('***');
  }
  return text;
}

function updateAlwaysOnTop(alwaysOnTop: boolean): DesktopShellState {
  if (!settingsStore || !shellSettings || !windowManager) {
    throw new Error('Desktop shell is not ready.');
  }
  const normalized = settingsStore.setAlwaysOnTop(alwaysOnTop);
  shellSettings = { ...shellSettings, alwaysOnTop: normalized };
  windowManager.applyAlwaysOnTop(normalized);
  return syncShellState();
}

function updateMuted(muted: boolean): DesktopShellState {
  if (!settingsStore || !shellSettings) {
    throw new Error('Desktop shell is not ready.');
  }
  const normalized = settingsStore.setMuted(muted);
  shellSettings = { ...shellSettings, muted: normalized };
  return syncShellState();
}

function updateHudOpacity(opacity: number): DesktopShellState {
  if (!settingsStore || !shellSettings || !windowManager) {
    throw new Error('Desktop shell is not ready.');
  }
  const clamped = settingsStore.setHudOpacity(opacity);
  shellSettings = { ...shellSettings, hudOpacity: clamped };
  windowManager.applyOpacity(clamped);
  return syncShellState();
}

function updateAutoLaunch(enabled: boolean): DesktopShellState {
  if (!settingsStore || !shellSettings) {
    throw new Error('Desktop shell is not ready.');
  }
  const applied = applyAutoLaunchSetting(Boolean(enabled));
  if (applied) {
    const normalized = settingsStore.setAutoLaunch(enabled);
    shellSettings = { ...shellSettings, autoLaunch: normalized };
  }
  return syncShellState();
}

function updateHudMode(mode: HudMode): DesktopShellState {
  if (!settingsStore || !shellSettings || !windowManager) {
    throw new Error('Desktop shell is not ready.');
  }
  const normalized = settingsStore.setHudMode(mode);
  shellSettings = { ...shellSettings, hudMode: normalized };
  windowManager.applyHudMode(normalized);
  return syncShellState();
}

function requestQuit(): void {
  windowManager?.prepareForQuit();
  app.quit();
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.APP_GET_BOOTSTRAP_STATE, (): BootstrapState => {
    if (!database || !secretStore) {
      throw new Error('Core storage services are not initialized.');
    }
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      dbReady: true,
      retention: database.getRetentionStats(),
      secretStatus: secretStore.getStatus(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.DB_GET_RETENTION_STATS, () => {
    if (!database) {
      throw new Error('Database is not initialized.');
    }
    return database.getRetentionStats();
  });

  ipcMain.handle(IPC_CHANNELS.SECRET_GET_STATUS, () => {
    if (!secretStore) {
      throw new Error('SecretStore is not initialized.');
    }
    return secretStore.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SECRET_SAVE_KEY, (_event, apiKey: string) => {
    if (!secretStore) {
      throw new Error('SecretStore is not initialized.');
    }
    secretStore.setStoredApiKey(apiKey);
    // 凭据更新后即时重拉权威交易日历并刷新状态，无需重启解除日历降级
    void scheduler?.refreshCalendarNow().catch(() => {});
    return secretStore.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SECRET_CLEAR_KEY, () => {
    if (!secretStore) {
      throw new Error('SecretStore is not initialized.');
    }
    secretStore.clearStoredApiKey();
    return secretStore.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SECRET_TEST_CONNECTION, async (): Promise<ProviderHealthStatus> => {
    if (!hithinkProvider) {
      return {
        provider: 'hithink',
        ok: false,
        latencyMs: 0,
        error: 'HithinkProvider is not initialized.',
      };
    }
    const result = await hithinkProvider.healthCheck();
    return {
      ...result,
      error: sanitizeErrorText(result.error),
    };
  });

  ipcMain.handle(IPC_CHANNELS.EXTRAS_GET, () => extrasPoller?.getLatest() ?? null);

  // 本机定制：拖动手柄调整悬浮窗高度 / 整体放大；松手时保存
  ipcMain.handle(
    IPC_CHANNELS.SHELL_HUD_RESIZE_DRAG,
    (_event, phase: 'start' | 'move' | 'end', axis: 'w' | 'h'): void => {
      if (!windowManager) return;
      windowManager.hudResizeDrag(phase, axis === 'w' ? 'w' : 'h');
      if (phase === 'end' && settingsStore) settingsStore.setHudSize(windowManager.getHudCustomSize());
    }
  );
  ipcMain.handle(IPC_CHANNELS.SHELL_HUD_RESET_SIZE, (): void => {
    if (!windowManager) return;
    windowManager.resetHudSize();
    settingsStore?.setHudSize(windowManager.getHudCustomSize());
  });

  // 本机定制：「情绪」页数据，页面打开时才会来取
  ipcMain.handle(IPC_CHANNELS.SENTIMENT_GET, () => {
    const total = (replayEngine?.getLatestState() ?? scheduler?.getLatestState())?.marketTotal;
    return fetchMarketSentiment(total?.tradeDate ?? null, total?.prevTradeDate ?? null);
  });

  ipcMain.handle(IPC_CHANNELS.MARKET_GET_STATE, () => {
    if (replayEngine) return replayEngine.getLatestState();
    return scheduler?.getLatestState() ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.MARKET_REFRESH_NOW, async () => {
    // 回放模式下禁止发起实时轮询，改为从头重播当前回放交易日
    if (replayEngine) {
      replayEngine.start();
      return replayEngine.getLatestState();
    }
    if (!scheduler) return null;
    return scheduler.refreshNow({ forceReconcile: true });
  });

  ipcMain.handle(
    IPC_CHANNELS.TICKER_SEARCH,
    async (_event, keyword: string, limit?: number) => {
      if (!scheduler) return [];
      return scheduler.searchTickers(keyword, limit);
    }
  );

  ipcMain.handle(IPC_CHANNELS.MONITOR_GET_CONFIG, (): MonitorConfig => {
    if (!monitorSettingsStore) {
      throw new Error('MonitorSettingsStore is not initialized.');
    }
    return monitorSettingsStore.load();
  });

  ipcMain.handle(
    IPC_CHANNELS.MONITOR_UPDATE_CONFIG,
    async (_event, patch: Partial<MonitorConfig>): Promise<MonitorConfig> => {
      if (!monitorSettingsStore) {
        throw new Error('MonitorSettingsStore is not initialized.');
      }
      const next = monitorSettingsStore.update(patch);
      applyMonitorConfigToScheduler(next);
      windowManager?.broadcast(IPC_CHANNELS.MONITOR_CONFIG_UPDATED, next);
      // 触发即时重算与广播，使阈值/斜率窗口/刷新周期改动无需重启即刻生效
      void scheduler?.refreshNow().catch(() => {});
      return next;
    }
  );

  ipcMain.handle(IPC_CHANNELS.WATCHLIST_GET_ALL, () => {
    if (!watchlistService) return [];
    return watchlistService.list();
  });

  ipcMain.handle(IPC_CHANNELS.WATCHLIST_ADD, (_event, input: WatchlistAddInput) => {
    if (!watchlistService) {
      throw new Error('WatchlistService is not initialized.');
    }
    const list = watchlistService.add(input);
    void scheduler?.refreshNow().catch(() => {});
    return list;
  });

  ipcMain.handle(IPC_CHANNELS.WATCHLIST_REMOVE, (_event, symbol: string) => {
    if (!watchlistService) {
      throw new Error('WatchlistService is not initialized.');
    }
    const list = watchlistService.remove(symbol);
    void scheduler?.refreshNow().catch(() => {});
    return list;
  });

  ipcMain.handle(IPC_CHANNELS.WATCHLIST_REORDER, (_event, symbols: string[]) => {
    if (!watchlistService) {
      throw new Error('WatchlistService is not initialized.');
    }
    const list = watchlistService.reorder(symbols);
    void scheduler?.refreshNow().catch(() => {});
    return list;
  });

  ipcMain.handle(IPC_CHANNELS.WATCHLIST_UPDATE, (_event, input: WatchlistUpdateInput) => {
    if (!watchlistService) {
      throw new Error('WatchlistService is not initialized.');
    }
    const list = watchlistService.update(input);
    void scheduler?.refreshNow().catch(() => {});
    return list;
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_GET_STATE, (): DesktopShellState => {
    return buildShellState();
  });

  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_DETAIL,
    (_event, options?: OpenDetailOptions): DesktopShellState => {
      windowManager?.openDetail(options);
      return buildShellState();
    }
  );

  ipcMain.handle(IPC_CHANNELS.SHELL_HIDE_DETAIL, (): DesktopShellState => {
    windowManager?.hideDetail();
    return buildShellState();
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_HIDE_HUD, (): DesktopShellState => {
    windowManager?.hideHud();
    return buildShellState();
  });

  // 本机定制：拖动悬浮窗底边调整高度，松手时保存
  ipcMain.handle(
    IPC_CHANNELS.SHELL_SET_HUD_HEIGHT,
    (_event, height: number, commit: boolean): number => {
      if (!windowManager) return 0;
      const applied = windowManager.applyHudHeight(Number(height));
      if (commit && applied > 0 && settingsStore) settingsStore.setHudHeight(applied);
      return applied;
    }
  );

  ipcMain.handle(IPC_CHANNELS.SHELL_SET_OPACITY, (_event, opacity: number): DesktopShellState => {
    return updateHudOpacity(opacity);
  });

  ipcMain.handle(
    IPC_CHANNELS.SHELL_SET_ALWAYS_ON_TOP,
    (_event, alwaysOnTop: boolean): DesktopShellState => {
      return updateAlwaysOnTop(alwaysOnTop);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SHELL_SET_MUTED, (_event, muted: boolean): DesktopShellState => {
    return updateMuted(muted);
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_SET_BOSS_KEY, (_event, accelerator: string) => {
    if (!bossKeyManager || !settingsStore || !shellSettings) {
      throw new Error('BossKeyManager is not initialized.');
    }
    const result = bossKeyManager.rebind(accelerator);
    if (result.success && result.committedAccelerator) {
      const saved = settingsStore.setBossKey(result.committedAccelerator);
      shellSettings = { ...shellSettings, bossKey: saved };
    }
    syncShellState();
    return result.status;
  });

  ipcMain.handle(
    IPC_CHANNELS.SHELL_SET_AUTO_LAUNCH,
    (_event, enabled: boolean): DesktopShellState => {
      return updateAutoLaunch(enabled);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SHELL_SET_HUD_MODE,
    (_event, mode: HudMode): DesktopShellState => {
      return updateHudMode(mode);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SHELL_SET_DETAIL_MODAL_OPEN, (_event, open: boolean): void => {
    windowManager?.setDetailEscapeSuppressed(Boolean(open));
  });

  ipcMain.handle(
    IPC_CHANNELS.ALERT_GET_RECENT,
    (_event, tradeDate?: string, limit?: number) => {
      if (replayEngine) {
        return replayEngine.getReplayAlerts();
      }
      if (!database) return [];
      const safeLimit =
        typeof limit === 'number' && Number.isFinite(limit)
          ? Math.max(1, Math.min(500, Math.round(limit)))
          : 100;
      return database.getAlertEvents(tradeDate, safeLimit);
    }
  );

  ipcMain.handle(IPC_CHANNELS.ALERT_MARK_READ, (_event, id: number): boolean => {
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      return false;
    }
    if (replayEngine) {
      return replayEngine.markReplayAlertRead(id);
    }
    if (!database) return false;
    return database.markAlertEventRead(id);
  });

  ipcMain.handle(IPC_CHANNELS.ALERT_MARK_ALL_READ, (_event, tradeDate?: string): number => {
    const normalizedDate = typeof tradeDate === 'string' && tradeDate.trim() ? tradeDate.trim() : undefined;
    if (replayEngine) {
      return replayEngine.markAllReplayAlertsRead(normalizedDate);
    }
    if (!database) return 0;
    return database.markAllAlertEventsRead(normalizedDate);
  });

  ipcMain.handle(
    IPC_CHANNELS.ALERT_SIMULATE,
    (_event, direction: AlertDirection, symbol?: string) => {
      if (replayEngine) {
        throw new Error('回放模式下禁止触发模拟实盘告警，防止写入 alert_events 或弹出系统通知。');
      }
      if (!alertDispatcher) {
        throw new Error('AlertDispatcher is not initialized.');
      }
      if (direction !== 'SURGE' && direction !== 'SHRINK') {
        throw new Error(`Invalid alert direction: ${String(direction)}`);
      }
      const targetSymbol = symbol?.trim() || MARKET_TOTAL_SYMBOL;
      const watchlistName = database
        ?.getWatchlist()
        .find((item) => item.symbol.toUpperCase() === targetSymbol.toUpperCase())?.name;
      return alertDispatcher.dispatchSimulated(direction, {
        symbol: targetSymbol,
        name: watchlistName,
      });
    }
  );
}

function initServices(): void {
  const userDataDir = app.getPath('userData');
  try {
    migrateLegacyUserDataDir(userDataDir);
  } catch (err: unknown) {
    console.warn(
      '[main] Legacy userData migration skipped:',
      err instanceof Error ? err.message : String(err)
    );
  }
  const dbPath = path.join(userDataDir, DATABASE_FILENAME);
  const encryptedKeyPath = path.join(userDataDir, ENCRYPTED_KEY_FILENAME);

  database = new AppDatabase(dbPath);
  if (!replayCliOptions) {
    const todayShanghai = getShanghaiParts(Date.now()).dateStr;
    database.pruneOlderThanTradingDays(DEFAULT_RETENTION_TRADING_DAYS, todayShanghai);
  }

  secretStore = new SecretStore({
    encryptedFilePath: encryptedKeyPath,
    safeStorage,
  });

  settingsStore = new ShellSettingsStore(database);
  shellSettings = settingsStore.load();

  monitorSettingsStore = new MonitorSettingsStore(database);
  const initialMonitorConfig = monitorSettingsStore.load();

  watchlistService = new WatchlistService(database);

  windowManager = new WindowManager({
    preloadPath: resolvePreloadPath(__dirname),
    rendererHtmlPath: resolveRendererHtmlPath(__dirname),
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL,
    initialSettings: shellSettings,
    initialHudHeight: settingsStore.getHudHeight(),
    initialHudWidth: settingsStore.getHudWidth(),
    onHudPositionCommitted: (pos) => {
      if (!settingsStore || !shellSettings) return;
      const saved = settingsStore.setHudPosition(pos);
      shellSettings = { ...shellSettings, hudPosition: saved };
      syncShellState();
    },
    onStateChanged: () => {
      if (shellSettings && windowManager && bossKeyManager) {
        syncShellState();
      }
    },
    onWindowReady: (win) => {
      if (win.isDestroyed()) return;
      if (shellSettings && windowManager && bossKeyManager) {
        win.webContents.send(IPC_CHANNELS.SHELL_STATE_UPDATED, buildShellState());
      }
      const latestMarket = replayEngine?.getLatestState() ?? scheduler?.getLatestState();
      if (latestMarket) {
        win.webContents.send(IPC_CHANNELS.MARKET_STATE_UPDATED, latestMarket);
      }
    },
  });

  extrasPoller = startExtrasPoller((extras) => {
    windowManager?.broadcast(IPC_CHANNELS.EXTRAS_UPDATED, extras);
  });

  alertDispatcher = new AlertDispatcher({
    database,
    isMuted: () => Boolean(shellSettings?.muted),
    broadcastAlert: (payload) => {
      windowManager?.broadcast(IPC_CHANNELS.ALERT_TRIGGERED, payload);
    },
    onNotificationClick: (symbol) => {
      windowManager?.openDetail({ symbol, tab: 'alerts' });
    },
    allowSimulation: isDevMode,
  });

  bossKeyManager = new BossKeyManager({
    onTrigger: () => {
      windowManager?.toggleBossKeyVisibility();
    },
    onConflict: (status) => {
      alertDispatcher?.notifyBossKeyConflict(status);
    },
  });

  trayManager = new TrayManager({
    onToggleHud: () => windowManager?.toggleHud(),
    onToggleDetail: () => windowManager?.toggleDetail(),
    onToggleMinimalMode: (next) => {
      updateHudMode(next ? 'minimal' : 'standard');
    },
    onToggleAlwaysOnTop: (next) => {
      updateAlwaysOnTop(next);
    },
    onToggleMuted: (next) => {
      updateMuted(next);
    },
    onToggleAutoLaunch: (next) => {
      updateAutoLaunch(next);
    },
    onRefreshNow: () => {
      if (replayEngine) {
        replayEngine.start();
      } else {
        void scheduler?.refreshNow({ forceReconcile: true });
      }
    },
    onOpenSettings: () => {
      windowManager?.openDetail({ tab: 'settings' });
    },
    onSimulateAlert:
      isDevMode && !replayCliOptions
        ? (direction) => {
            alertDispatcher?.dispatchSimulated(direction);
          }
        : undefined,
    onQuit: requestQuit,
  });

  if (replayCliOptions) {
    replayEngine = new DayReplayEngine({
      database,
      tradeDate: replayCliOptions.tradeDate,
      stepIntervalMs: replayCliOptions.stepIntervalMs,
      enabledCoreIndices: initialMonitorConfig.enabledCoreIndices,
      enabledOptionalIndices: initialMonitorConfig.enabledOptionalIndices,
      energyConfig: {
        expandThresholdPct: initialMonitorConfig.expandThresholdPct,
        shrinkThresholdPct: initialMonitorConfig.shrinkThresholdPct,
        slopeWindow: initialMonitorConfig.slopeWindow,
      },
      alertConfig: {
        enabled: initialMonitorConfig.alertsEnabled,
        surgeSlopeThreshold: initialMonitorConfig.surgeSlopeThreshold,
        surgeMultipleThreshold: initialMonitorConfig.surgeMultipleThreshold,
        shrinkSlopeThreshold: initialMonitorConfig.shrinkSlopeThreshold,
        shrinkMultipleThreshold: initialMonitorConfig.shrinkMultipleThreshold,
        matchMode: initialMonitorConfig.matchMode,
        cooldownMinutes: initialMonitorConfig.cooldownMinutes,
        slopeWindow: initialMonitorConfig.slopeWindow,
      },
      onStateUpdate: broadcastMarketState,
      onReplayAlert: (payload) => {
        // 回放告警仅驱动界面呼吸高亮与事件流展示，不入实盘库、不弹系统通知
        windowManager?.broadcast(IPC_CHANNELS.ALERT_TRIGGERED, payload);
      },
    });
  } else {
    const tencentProvider = new TencentProvider();
    const sinaProvider = new SinaProvider();
    const eastmoneyProvider = new EastmoneyProvider();
    hithinkProvider = new HithinkProvider({ secretStore });

    scheduler = new PollingScheduler({
      database,
      primarySnapshotProvider: tencentProvider,
      secondarySnapshotProvider: sinaProvider,
      hithinkProvider,
      primaryIntradayProvider: tencentProvider,
      secondaryIntradayProvider: eastmoneyProvider,
      configuredIntervalSec: initialMonitorConfig.pollingIntervalSec,
      enabledCoreIndices: initialMonitorConfig.enabledCoreIndices,
      enabledOptionalIndices: initialMonitorConfig.enabledOptionalIndices,
      energyConfig: {
        expandThresholdPct: initialMonitorConfig.expandThresholdPct,
        shrinkThresholdPct: initialMonitorConfig.shrinkThresholdPct,
        slopeWindow: initialMonitorConfig.slopeWindow,
      },
      alertConfig: {
        enabled: initialMonitorConfig.alertsEnabled,
        surgeSlopeThreshold: initialMonitorConfig.surgeSlopeThreshold,
        surgeMultipleThreshold: initialMonitorConfig.surgeMultipleThreshold,
        shrinkSlopeThreshold: initialMonitorConfig.shrinkSlopeThreshold,
        shrinkMultipleThreshold: initialMonitorConfig.shrinkMultipleThreshold,
        matchMode: initialMonitorConfig.matchMode,
        cooldownMinutes: initialMonitorConfig.cooldownMinutes,
        slopeWindow: initialMonitorConfig.slopeWindow,
      },
      onStateUpdate: broadcastMarketState,
      onAlertTriggered: handleAlertTriggered,
    });
  }
}

if (replayCliParseError) {
  // --replay 参数非法时快速失败退出，严禁静默降级为实盘实时轮询
  app.exit(1);
} else if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    windowManager?.showHud();
  });

  app
    .whenReady()
    .then(() => {
      // macOS 作为菜单栏 + 悬浮窗驻留工具运行，不占用 Dock 图标
      if (process.platform === 'darwin') {
        app.dock?.hide();
      }
      initServices();
      registerIpcHandlers();

      if (shellSettings) {
        bossKeyManager?.registerInitial(shellSettings.bossKey);
        if (shellSettings.autoLaunch) {
          applyAutoLaunchSetting(true);
        }
      }

      windowManager?.createHudWindow();
      trayManager?.init(
        buildShellState(),
        replayEngine?.getLatestState() ?? scheduler?.getLatestState() ?? null
      );

      if (replayEngine) {
        replayEngine.start();
      } else {
        void scheduler?.start().catch((err: unknown) => {
          console.error(
            '[main] PollingScheduler start failed:',
            err instanceof Error ? err.message : String(err)
          );
        });
      }

      app.on('activate', () => {
        windowManager?.showHud();
      });
    })
    .catch((err: unknown) => {
      console.error(
        '[main] Startup failed:',
        err instanceof Error ? err.message : String(err)
      );
      replayEngine?.stop();
      replayEngine = null;
      scheduler?.stop();
      scheduler = null;
      windowManager?.destroyAll();
      windowManager = null;
      database?.close();
      database = null;
      app.exit(1);
    });

  // 关闭窗口仅隐藏至托盘，不自动退出应用；只有托盘「退出」触发真正退出
  app.on('window-all-closed', () => {
    // 刻意保持驻留系统托盘
  });

  app.on('before-quit', () => {
    windowManager?.prepareForQuit();
  });

  app.on('will-quit', () => {
    extrasPoller?.stop();
    extrasPoller = null;
    bossKeyManager?.unregister();
    bossKeyManager = null;
    trayManager?.destroy();
    trayManager = null;
    replayEngine?.stop();
    replayEngine = null;
    scheduler?.stop();
    scheduler = null;
    hithinkProvider = null;
    windowManager?.destroyAll();
    windowManager = null;
    database?.close();
    database = null;
  });
}
