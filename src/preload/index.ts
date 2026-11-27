import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type PreloadApi } from '../shared/ipc';
import type {
  AlertDirection,
  AlertDispatchPayload,
  DesktopShellState,
  HudExtras,
  HudMode,
  MarketDashboardState,
  MonitorConfig,
  OpenDetailOptions,
  WatchlistAddInput,
  WatchlistUpdateInput,
} from '../shared/types';

const api: PreloadApi = {
  getBootstrapState: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_BOOTSTRAP_STATE),
  getSecretStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SECRET_GET_STATUS),
  saveSecretApiKey: (apiKey: string) => ipcRenderer.invoke(IPC_CHANNELS.SECRET_SAVE_KEY, apiKey),
  clearSecretApiKey: () => ipcRenderer.invoke(IPC_CHANNELS.SECRET_CLEAR_KEY),
  testHithinkConnection: () => ipcRenderer.invoke(IPC_CHANNELS.SECRET_TEST_CONNECTION),
  getDatabaseRetentionStats: () => ipcRenderer.invoke(IPC_CHANNELS.DB_GET_RETENTION_STATS),

  getMarketState: () => ipcRenderer.invoke(IPC_CHANNELS.MARKET_GET_STATE),
  refreshMarketNow: () => ipcRenderer.invoke(IPC_CHANNELS.MARKET_REFRESH_NOW),
  searchTickers: (keyword: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.TICKER_SEARCH, keyword, limit),

  getMonitorConfig: () => ipcRenderer.invoke(IPC_CHANNELS.MONITOR_GET_CONFIG),
  updateMonitorConfig: (patch: Partial<MonitorConfig>) =>
    ipcRenderer.invoke(IPC_CHANNELS.MONITOR_UPDATE_CONFIG, patch),

  getWatchlist: () => ipcRenderer.invoke(IPC_CHANNELS.WATCHLIST_GET_ALL),
  addWatchlistItem: (input: WatchlistAddInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.WATCHLIST_ADD, input),
  removeWatchlistItem: (symbol: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WATCHLIST_REMOVE, symbol),
  reorderWatchlist: (symbols: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.WATCHLIST_REORDER, symbols),
  updateWatchlistItem: (input: WatchlistUpdateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.WATCHLIST_UPDATE, input),

  getShellState: () => ipcRenderer.invoke(IPC_CHANNELS.SHELL_GET_STATE),
  openDetail: (options?: OpenDetailOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_DETAIL, options),
  hideDetail: () => ipcRenderer.invoke(IPC_CHANNELS.SHELL_HIDE_DETAIL),
  hideHud: () => ipcRenderer.invoke(IPC_CHANNELS.SHELL_HIDE_HUD),
  setHudOpacity: (opacity: number) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_OPACITY, opacity),
  setHudHeight: (height: number, commit: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_HUD_HEIGHT, height, commit),
  setAlwaysOnTop: (alwaysOnTop: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_ALWAYS_ON_TOP, alwaysOnTop),
  setMuted: (muted: boolean) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_MUTED, muted),
  setBossKey: (accelerator: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_BOSS_KEY, accelerator),
  setAutoLaunch: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_AUTO_LAUNCH, enabled),
  setHudMode: (mode: HudMode) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_HUD_MODE, mode),
  setDetailModalOpen: (open: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SET_DETAIL_MODAL_OPEN, open),

  getRecentAlerts: (tradeDate?: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ALERT_GET_RECENT, tradeDate, limit),
  markAlertRead: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.ALERT_MARK_READ, id),
  markAllAlertsRead: (tradeDate?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ALERT_MARK_ALL_READ, tradeDate),
  simulateAlert: (direction: AlertDirection, symbol?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ALERT_SIMULATE, direction, symbol),

  onMarketStateUpdated: (listener: (state: MarketDashboardState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: MarketDashboardState) => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.MARKET_STATE_UPDATED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MARKET_STATE_UPDATED, handler);
    };
  },

  onAlertTriggered: (listener: (event: AlertDispatchPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, alertEvent: AlertDispatchPayload) => {
      listener(alertEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.ALERT_TRIGGERED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ALERT_TRIGGERED, handler);
    };
  },

  onShellStateUpdated: (listener: (state: DesktopShellState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopShellState) => {
      listener(state);
    };
    ipcRenderer.on(IPC_CHANNELS.SHELL_STATE_UPDATED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SHELL_STATE_UPDATED, handler);
    };
  },

  onMonitorConfigUpdated: (listener: (config: MonitorConfig) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, config: MonitorConfig) => {
      listener(config);
    };
    ipcRenderer.on(IPC_CHANNELS.MONITOR_CONFIG_UPDATED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MONITOR_CONFIG_UPDATED, handler);
    };
  },

  getHudExtras: () => ipcRenderer.invoke(IPC_CHANNELS.EXTRAS_GET),
  getMarketSentiment: () => ipcRenderer.invoke(IPC_CHANNELS.SENTIMENT_GET),
  hudResizeDrag: (phase: 'start' | 'move' | 'end', axis: 'w' | 'h') =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_HUD_RESIZE_DRAG, phase, axis),
  resetHudSize: () => ipcRenderer.invoke(IPC_CHANNELS.SHELL_HUD_RESET_SIZE),
  onHudExtrasUpdated: (listener: (extras: HudExtras | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, extras: HudExtras | null) => {
      listener(extras);
    };
    ipcRenderer.on(IPC_CHANNELS.EXTRAS_UPDATED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EXTRAS_UPDATED, handler);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
