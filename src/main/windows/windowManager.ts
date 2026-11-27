import path from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import {
  DETAIL_DEFAULT_HEIGHT,
  DETAIL_DEFAULT_WIDTH,
  DETAIL_MIN_HEIGHT,
  DETAIL_MIN_WIDTH,
  HUD_DEFAULT_HEIGHT,
  HUD_DEFAULT_WIDTH,
  HUD_MAX_HEIGHT,
  HUD_MAX_WIDTH,
  MARKET_TOTAL_SYMBOL,
} from '../../shared/constants';
import type {
  DesktopShellSettings,
  DetailTab,
  HudMode,
  OpenDetailOptions,
  WindowPosition,
} from '../../shared/types';
import {
  clampHudOpacity,
  computeDetailOverlayBounds,
  computeResizedHudBounds,
  getHudSizeForMode,
  isRectSufficientlyVisible,
  resolveHudBounds,
  type Rect,
} from './windowGeometry';

export interface WindowVisibilitySnapshot {
  hudVisible: boolean;
  detailVisible: boolean;
}

/**
 * 老板键一键显隐状态机（纯逻辑，便于独立单测）：
 * - 隐藏前记忆 HUD 与详情浮层各自的可见状态
 * - 再次触发时按隐藏前状态精确恢复（若两者原均不可见则至少恢复 HUD）
 */
export class BossVisibilityController {
  private savedBeforeHide: WindowVisibilitySnapshot | null = null;

  computeNextVisibility(current: WindowVisibilitySnapshot): {
    action: 'hide' | 'restore';
    target: WindowVisibilitySnapshot;
  } {
    if (current.hudVisible || current.detailVisible) {
      this.savedBeforeHide = {
        hudVisible: current.hudVisible,
        detailVisible: current.detailVisible,
      };
      return {
        action: 'hide',
        target: { hudVisible: false, detailVisible: false },
      };
    }

    const restoreTarget: WindowVisibilitySnapshot = this.savedBeforeHide
      ? {
          hudVisible: this.savedBeforeHide.hudVisible || !this.savedBeforeHide.detailVisible,
          detailVisible: this.savedBeforeHide.detailVisible,
        }
      : { hudVisible: true, detailVisible: false };

    this.savedBeforeHide = null;
    return {
      action: 'restore',
      target: restoreTarget,
    };
  }

  clearSnapshot(): void {
    this.savedBeforeHide = null;
  }
}

export interface WindowManagerOptions {
  preloadPath: string;
  rendererHtmlPath: string;
  rendererDevUrl?: string;
  initialSettings: DesktopShellSettings;
  /** 本机定制：上次保存的标准模式悬浮窗高度 */
  initialHudHeight?: number | null;
  initialHudWidth?: number | null;
  onHudPositionCommitted: (position: WindowPosition) => void;
  onStateChanged: () => void;
  onWindowReady?: (win: BrowserWindow, view: 'hud' | 'detail') => void;
}

/**
 * 双态桌面窗口管理器（紧凑 HUD 悬浮窗 + 详情浮层窗口）：
 * - HUD：无边框、透明圆角、置顶、不占任务栏、后台不节流（保障隐藏态提示音）、记忆坐标与 30%–100% 透明度
 * - Detail：贴近 HUD 弹出（空间不足则屏幕居中）、首次等待 ready-to-show 防闪屏、失焦不销毁、Esc 或点击收起隐藏
 * - 关闭按钮仅隐藏至托盘，只有明确 quit 时才允许真正销毁窗口
 */
export class WindowManager {
  private readonly options: WindowManagerOptions;
  private readonly bossVisibility = new BossVisibilityController();
  private hudWindow: BrowserWindow | null = null;
  private customHudHeight: number | null = null;
  private customHudWidth: number | null = null;
  private resizeDrag: {
    axis: 'w' | 'h';
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null = null;
  private detailWindow: BrowserWindow | null = null;
  private settings: DesktopShellSettings;
  private activeDetailSymbol = MARKET_TOTAL_SYMBOL;
  private activeDetailTab: DetailTab = 'chart';
  private detailFocusSeq = 0;
  private hudReady = false;
  private hudDesiredVisible = true;
  private detailReady = false;
  private detailDesiredVisible = false;
  private detailEscapeSuppressed = false;
  private suppressStateEvents = false;
  private isQuitting = false;
  private moveSaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WindowManagerOptions) {
    this.options = options;
    this.settings = { ...options.initialSettings };
    const h = options.initialHudHeight;
    this.customHudHeight =
      typeof h === 'number' && Number.isFinite(h) && h > HUD_DEFAULT_HEIGHT
        ? Math.min(HUD_MAX_HEIGHT, Math.round(h))
        : null;
    const w = options.initialHudWidth;
    this.customHudWidth =
      typeof w === 'number' && Number.isFinite(w) && w > HUD_DEFAULT_WIDTH
        ? Math.min(HUD_MAX_WIDTH, Math.round(w))
        : null;
  }

  prepareForQuit(): void {
    this.isQuitting = true;
    this.flushPendingMoveSave();
  }

  isHudVisible(): boolean {
    return Boolean(this.hudWindow && !this.hudWindow.isDestroyed() && this.hudWindow.isVisible());
  }

  isDetailVisible(): boolean {
    return Boolean(
      this.detailWindow && !this.detailWindow.isDestroyed() && this.detailWindow.isVisible()
    );
  }

  getActiveDetailSymbol(): string {
    return this.activeDetailSymbol;
  }

  getActiveDetailTab(): DetailTab {
    return this.activeDetailTab;
  }

  getDetailFocusSeq(): number {
    return this.detailFocusSeq;
  }

  private emitStateChanged(): void {
    if (!this.suppressStateEvents) {
      this.options.onStateChanged();
    }
  }

  private withBatchedStateChange<T>(fn: () => T): T {
    const prev = this.suppressStateEvents;
    this.suppressStateEvents = true;
    try {
      return fn();
    } finally {
      this.suppressStateEvents = prev;
      if (!prev) {
        this.options.onStateChanged();
      }
    }
  }

  private applyWindowPinning(win: BrowserWindow, alwaysOnTop: boolean): void {
    if (alwaysOnTop) {
      win.setAlwaysOnTop(true, 'floating');
      // macOS 下开启跨桌面与全屏应用上方可见，保证全屏看盘/写代码时 HUD 仍可悬浮
      if (process.platform === 'darwin' && typeof win.setVisibleOnAllWorkspaces === 'function') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
    } else {
      win.setAlwaysOnTop(false);
      if (process.platform === 'darwin' && typeof win.setVisibleOnAllWorkspaces === 'function') {
        win.setVisibleOnAllWorkspaces(false);
      }
    }
  }

  private getDisplayMetrics(): { workAreas: Rect[]; primaryWorkArea: Rect } {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    return {
      workAreas: displays.map((d) => d.workArea),
      primaryWorkArea: primary.workArea,
    };
  }

  /** 本机定制：标准模式用用户拉过的高度，极简模式不变 */
  private hudSizeFor(mode: HudMode): { width: number; height: number } {
    const size = getHudSizeForMode(mode);
    if (mode === 'minimal') return size;
    const zoom = this.hudZoomFor(mode);
    const minHeight = Math.round(HUD_DEFAULT_HEIGHT * zoom);
    return {
      width: this.customHudWidth ?? size.width,
      height: Math.max(minHeight, this.customHudHeight ?? minHeight),
    };
  }

  /** 本机定制：整体放大倍数 = 当前宽度 / 默认宽度；极简模式不放大 */
  private hudZoomFor(mode: HudMode): number {
    return mode !== 'minimal' && this.customHudWidth !== null
      ? this.customHudWidth / HUD_DEFAULT_WIDTH
      : 1;
  }

  private applyHudZoom(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    win.webContents.setZoomFactor(this.hudZoomFor(this.settings.hudMode));
  }

  getHudCustomSize(): { width: number | null; height: number | null } {
    return { width: this.customHudWidth, height: this.customHudHeight };
  }

  private setHudBoundsFreely(win: BrowserWindow, width: number, height: number): void {
    const current = win.getBounds();
    if (width === current.width && height === current.height) return;
    win.setResizable(true);
    win.setMinimumSize(Math.min(width, current.width), Math.min(height, current.height));
    win.setBounds({ x: current.x, y: current.y, width, height });
    win.setMinimumSize(width, height);
    win.setResizable(false);
  }

  /**
   * 本机定制：整体放大悬浮窗。宽度夹在 [默认宽度, 上限与屏幕右边界]，高度按同比例跟着变，
   * 内容用缩放倍数一起放大。左上角不动。
   */
  applyHudWidth(width: number): number {
    const win = this.hudWindow;
    if (!win || win.isDestroyed() || this.settings.hudMode === 'minimal') return 0;
    if (!Number.isFinite(width)) return 0;
    const current = win.getBounds();
    const workArea = screen.getDisplayMatching(current).workArea;
    const maxW = Math.max(HUD_DEFAULT_WIDTH, workArea.x + workArea.width - current.x);
    const next = Math.round(Math.max(HUD_DEFAULT_WIDTH, Math.min(HUD_MAX_WIDTH, maxW, width)));
    const maxH = Math.max(HUD_DEFAULT_HEIGHT, workArea.y + workArea.height - current.y);
    const minH = Math.round((HUD_DEFAULT_HEIGHT * next) / HUD_DEFAULT_WIDTH);
    const scaledH = Math.round((current.height * next) / current.width);
    const nextH = Math.max(Math.min(minH, maxH), Math.min(HUD_MAX_HEIGHT, maxH, scaledH));
    this.customHudWidth = next > HUD_DEFAULT_WIDTH ? next : null;
    this.customHudHeight = nextH;
    this.setHudBoundsFreely(win, next, nextH);
    this.applyHudZoom(win);
    return next;
  }

  /** 拖动手柄：鼠标位置由主进程读，避免页面缩放后坐标对不上 */
  hudResizeDrag(phase: 'start' | 'move' | 'end', axis: 'w' | 'h'): void {
    const win = this.hudWindow;
    if (!win || win.isDestroyed() || this.settings.hudMode === 'minimal') return;
    const cursor = screen.getCursorScreenPoint();
    if (phase === 'start') {
      const b = win.getBounds();
      this.resizeDrag = { axis, startX: cursor.x, startY: cursor.y, startW: b.width, startH: b.height };
      return;
    }
    const d = this.resizeDrag;
    if (!d) return;
    if (d.axis === 'w') this.applyHudWidth(d.startW + (cursor.x - d.startX));
    else this.applyHudHeight(d.startH + (cursor.y - d.startY));
    if (phase === 'end') this.resizeDrag = null;
  }

  resetHudSize(): void {
    const win = this.hudWindow;
    if (!win || win.isDestroyed() || this.settings.hudMode === 'minimal') return;
    this.applyHudWidth(HUD_DEFAULT_WIDTH);
    this.applyHudHeight(HUD_DEFAULT_HEIGHT);
    this.customHudWidth = null;
    this.customHudHeight = null;
  }

  /**
   * 本机定制：把标准模式悬浮窗调到指定高度（左上角不动，向下伸缩）。
   * 高度限制在默认高度到所在屏幕可用高度之间；极简模式下不生效，返回 0。
   */
  applyHudHeight(height: number): number {
    const win = this.hudWindow;
    if (!win || win.isDestroyed() || this.settings.hudMode === 'minimal') return 0;
    if (!Number.isFinite(height)) return 0;
    const current = win.getBounds();
    const workArea = screen.getDisplayMatching(current).workArea;
    const minH = Math.round(HUD_DEFAULT_HEIGHT * this.hudZoomFor(this.settings.hudMode));
    const maxByScreen = Math.max(minH, workArea.y + workArea.height - current.y);
    const next = Math.round(Math.max(minH, Math.min(HUD_MAX_HEIGHT, maxByScreen, height)));
    this.customHudHeight = next;
    this.setHudBoundsFreely(win, current.width, next);
    return next;
  }

  private ensureHudInVisibleWorkArea(win: BrowserWindow): void {
    const { workAreas, primaryWorkArea } = this.getDisplayMetrics();
    const current = win.getBounds();
    const modeSize = this.hudSizeFor(this.settings.hudMode);
    const safeBounds = resolveHudBounds(
      { x: current.x, y: current.y },
      { width: current.width || modeSize.width, height: current.height || modeSize.height },
      workAreas,
      primaryWorkArea
    );
    if (safeBounds.x !== current.x || safeBounds.y !== current.y) {
      win.setPosition(safeBounds.x, safeBounds.y);
    }
  }

  private ensureDetailInVisibleWorkArea(win: BrowserWindow, preferRepositionNearHud: boolean): void {
    const { workAreas, primaryWorkArea } = this.getDisplayMetrics();
    const current = win.getBounds();
    const visible = isRectSufficientlyVisible(current, workAreas.length > 0 ? workAreas : [primaryWorkArea]);
    if (!preferRepositionNearHud && visible) {
      return;
    }

    const hudBounds =
      this.hudWindow && !this.hudWindow.isDestroyed() ? this.hudWindow.getBounds() : null;
    const nextBounds = computeDetailOverlayBounds(
      hudBounds,
      {
        width: current.width || DETAIL_DEFAULT_WIDTH,
        height: current.height || DETAIL_DEFAULT_HEIGHT,
      },
      workAreas,
      primaryWorkArea
    );
    win.setBounds(nextBounds);
  }

  private loadView(win: BrowserWindow, view: 'hud' | 'detail'): void {
    if (this.options.rendererDevUrl) {
      const url = new URL(this.options.rendererDevUrl);
      url.searchParams.set('view', view);
      void win.loadURL(url.toString());
    } else {
      void win.loadFile(this.options.rendererHtmlPath, { query: { view } });
    }
  }

  createHudWindow(): BrowserWindow {
    if (this.hudWindow && !this.hudWindow.isDestroyed()) {
      return this.hudWindow;
    }

    const { workAreas, primaryWorkArea } = this.getDisplayMetrics();
    const hudSize = this.hudSizeFor(this.settings.hudMode);
    const bounds = resolveHudBounds(
      this.settings.hudPosition,
      hudSize,
      workAreas,
      primaryWorkArea
    );

    this.hudReady = false;
    this.hudDesiredVisible = true;

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: bounds.width,
      minHeight: bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: this.settings.alwaysOnTop,
      skipTaskbar: true,
      show: false,
      title: 'A 股实时能量看板 HUD',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 保持隐藏至托盘期间 Web Audio 提示音不被 Chromium 后台节流挂起
        backgroundThrottling: false,
      },
    });

    win.setOpacity(clampHudOpacity(this.settings.hudOpacity));
    this.applyWindowPinning(win, this.settings.alwaysOnTop);

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      this.hudReady = true;
      win.setOpacity(clampHudOpacity(this.settings.hudOpacity));
      this.applyWindowPinning(win, this.settings.alwaysOnTop);

      if (this.hudDesiredVisible) {
        this.ensureHudInVisibleWorkArea(win);
        this.withBatchedStateChange(() => {
          win.show();
        });
      }

      if (!app.isPackaged) {
        const smokeExitMs = Number(process.env.A_SHARE_SMOKE_EXIT_MS || '0');
        if (smokeExitMs > 0) {
          setTimeout(() => {
            this.prepareForQuit();
            app.quit();
          }, smokeExitMs);
        }
      }
    });

    win.webContents.on('did-finish-load', () => {
      this.applyHudZoom(win);
      this.options.onWindowReady?.(win, 'hud');
    });

    win.on('moved', () => {
      if (win.isDestroyed()) return;
      this.scheduleMoveSave();
    });

    win.on('show', () => this.emitStateChanged());
    win.on('hide', () => this.emitStateChanged());

    win.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.hudDesiredVisible = false;
        this.withBatchedStateChange(() => {
          win.hide();
        });
      }
    });

    win.on('closed', () => {
      if (this.hudWindow === win) {
        this.hudWindow = null;
        this.hudReady = false;
      }
    });

    this.hudWindow = win;
    this.loadView(win, 'hud');
    return win;
  }

  ensureDetailWindow(): BrowserWindow {
    if (this.detailWindow && !this.detailWindow.isDestroyed()) {
      return this.detailWindow;
    }

    const { workAreas, primaryWorkArea } = this.getDisplayMetrics();
    const hudBounds =
      this.hudWindow && !this.hudWindow.isDestroyed() ? this.hudWindow.getBounds() : null;
    const bounds = computeDetailOverlayBounds(
      hudBounds,
      { width: DETAIL_DEFAULT_WIDTH, height: DETAIL_DEFAULT_HEIGHT },
      workAreas,
      primaryWorkArea
    );

    this.detailReady = false;

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: DETAIL_MIN_WIDTH,
      minHeight: DETAIL_MIN_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: this.settings.alwaysOnTop,
      skipTaskbar: true,
      show: false,
      title: 'A 股实时能量看板 - 详情浮层',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.applyWindowPinning(win, this.settings.alwaysOnTop);

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      this.detailReady = true;
      if (this.detailDesiredVisible) {
        this.ensureDetailInVisibleWorkArea(win, true);
        this.applyWindowPinning(win, this.settings.alwaysOnTop);
        this.withBatchedStateChange(() => {
          win.show();
          win.focus();
        });
      }
    });

    // 失焦不销毁、不自动隐藏；仅按 Esc（且当前无页内模态框打开）或点击收起按钮隐藏
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !this.detailEscapeSuppressed) {
        event.preventDefault();
        this.hideDetail();
      }
    });

    win.webContents.on('did-finish-load', () => {
      this.options.onWindowReady?.(win, 'detail');
    });

    win.on('show', () => this.emitStateChanged());
    win.on('hide', () => this.emitStateChanged());

    win.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.detailDesiredVisible = false;
        this.withBatchedStateChange(() => {
          win.hide();
        });
      }
    });

    win.on('closed', () => {
      if (this.detailWindow === win) {
        this.detailWindow = null;
        this.detailReady = false;
      }
    });

    this.detailWindow = win;
    this.loadView(win, 'detail');
    return win;
  }

  showHud(): void {
    const win = this.createHudWindow();
    this.hudDesiredVisible = true;
    this.bossVisibility.clearSnapshot();
    this.ensureHudInVisibleWorkArea(win);
    if (this.settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'floating');
    }
    win.setOpacity(clampHudOpacity(this.settings.hudOpacity));

    this.withBatchedStateChange(() => {
      if (this.hudReady || win.isVisible()) {
        win.show();
        win.focus();
      }
    });
  }

  hideHud(): void {
    this.hudDesiredVisible = false;
    if (this.hudWindow && !this.hudWindow.isDestroyed()) {
      this.withBatchedStateChange(() => {
        this.hudWindow?.hide();
      });
    }
  }

  toggleHud(): void {
    if (this.isHudVisible()) {
      this.hideHud();
    } else {
      this.showHud();
    }
  }

  openDetail(options?: OpenDetailOptions): void {
    if (options?.symbol && options.symbol.trim().length > 0) {
      this.activeDetailSymbol = options.symbol.trim();
    }
    if (options?.tab) {
      this.activeDetailTab = options.tab;
    }
    if (options?.symbol || options?.tab) {
      this.detailFocusSeq += 1;
    }

    this.detailDesiredVisible = true;
    const win = this.ensureDetailWindow();
    const wasVisible = win.isVisible();
    this.bossVisibility.clearSnapshot();

    if (!wasVisible) {
      this.ensureDetailInVisibleWorkArea(win, true);
    }

    if (this.settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'floating');
    }

    this.withBatchedStateChange(() => {
      // 首次新建窗口等待 ready-to-show 避免透明窗闪黑/白帧；已就绪窗口立即显示并聚焦
      if (this.detailReady || wasVisible) {
        win.show();
        win.focus();
      }
    });
  }

  setDetailEscapeSuppressed(suppressed: boolean): void {
    this.detailEscapeSuppressed = Boolean(suppressed);
  }

  hideDetail(): void {
    this.detailDesiredVisible = false;
    this.detailEscapeSuppressed = false;
    if (this.detailWindow && !this.detailWindow.isDestroyed() && this.detailWindow.isVisible()) {
      this.withBatchedStateChange(() => {
        this.detailWindow?.hide();
      });
    }
  }

  toggleDetail(): void {
    if (this.isDetailVisible()) {
      this.hideDetail();
    } else {
      this.openDetail();
    }
  }

  /** 老板键触发：隐藏所有窗口并记忆状态；再次触发时按可见性校验恢复到隐藏前状态 */
  toggleBossKeyVisibility(): { action: 'hide' | 'restore'; target: WindowVisibilitySnapshot } {
    const decision = this.bossVisibility.computeNextVisibility({
      hudVisible: this.isHudVisible(),
      detailVisible: this.isDetailVisible(),
    });

    this.withBatchedStateChange(() => {
      if (decision.action === 'hide') {
        this.hudDesiredVisible = false;
        this.detailDesiredVisible = false;
        if (this.hudWindow && !this.hudWindow.isDestroyed()) {
          this.hudWindow.hide();
        }
        if (this.detailWindow && !this.detailWindow.isDestroyed()) {
          this.detailWindow.hide();
        }
      } else {
        if (decision.target.hudVisible) {
          this.hudDesiredVisible = true;
          const hud = this.createHudWindow();
          this.ensureHudInVisibleWorkArea(hud);
          if (this.settings.alwaysOnTop) {
            hud.setAlwaysOnTop(true, 'floating');
          }
          hud.setOpacity(clampHudOpacity(this.settings.hudOpacity));
          if (this.hudReady || hud.isVisible()) {
            hud.show();
          }
        }
        if (decision.target.detailVisible) {
          this.detailDesiredVisible = true;
          const detail = this.ensureDetailWindow();
          this.ensureDetailInVisibleWorkArea(detail, false);
          if (this.settings.alwaysOnTop) {
            detail.setAlwaysOnTop(true, 'floating');
          }
          if (this.detailReady || detail.isVisible()) {
            detail.show();
            detail.focus();
          }
        }
      }
    });

    return decision;
  }

  applyOpacity(opacity: number): number {
    const clamped = clampHudOpacity(opacity);
    this.settings = { ...this.settings, hudOpacity: clamped };
    if (this.hudWindow && !this.hudWindow.isDestroyed()) {
      this.hudWindow.setOpacity(clamped);
    }
    return clamped;
  }

  applyAlwaysOnTop(alwaysOnTop: boolean): boolean {
    const normalized = Boolean(alwaysOnTop);
    this.settings = { ...this.settings, alwaysOnTop: normalized };

    for (const win of [this.hudWindow, this.detailWindow]) {
      if (win && !win.isDestroyed()) {
        this.applyWindowPinning(win, normalized);
      }
    }
    return normalized;
  }

  /** 切换 HUD 标准/极简模式并按锚点同步缩放窗体物理尺寸 */
  applyHudMode(mode: HudMode): HudMode {
    const normalized: HudMode = mode === 'minimal' ? 'minimal' : 'standard';
    this.settings = { ...this.settings, hudMode: normalized };

    if (this.hudWindow && !this.hudWindow.isDestroyed()) {
      const win = this.hudWindow;
      const current = win.getBounds();
      const nextSize = this.hudSizeFor(normalized);
      const { workAreas, primaryWorkArea } = this.getDisplayMetrics();
      const nextBounds = computeResizedHudBounds(current, nextSize, workAreas, primaryWorkArea);

      if (this.moveSaveTimer) {
        clearTimeout(this.moveSaveTimer);
        this.moveSaveTimer = null;
      }

      // Windows 下 resizable: false 窗口需临时放开 resizable 并更新 minSize 才能可靠缩小
      win.setResizable(true);
      win.setMinimumSize(nextBounds.width, nextBounds.height);
      win.setBounds(nextBounds);
      win.setResizable(false);
      this.applyHudZoom(win);

      if (nextBounds.x !== current.x || nextBounds.y !== current.y) {
        const pos: WindowPosition = { x: nextBounds.x, y: nextBounds.y };
        this.settings = { ...this.settings, hudPosition: pos };
        this.options.onHudPositionCommitted(pos);
      }
    }

    return normalized;
  }

  broadcast(channel: string, payload: unknown): void {
    for (const win of [this.hudWindow, this.detailWindow]) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }

  private scheduleMoveSave(): void {
    if (this.moveSaveTimer) {
      clearTimeout(this.moveSaveTimer);
    }
    this.moveSaveTimer = setTimeout(() => {
      this.moveSaveTimer = null;
      this.commitCurrentHudPosition();
    }, 200);
  }

  private flushPendingMoveSave(): void {
    if (this.moveSaveTimer) {
      clearTimeout(this.moveSaveTimer);
      this.moveSaveTimer = null;
      this.commitCurrentHudPosition();
    }
  }

  private commitCurrentHudPosition(): void {
    if (!this.hudWindow || this.hudWindow.isDestroyed()) return;
    const [x, y] = this.hudWindow.getPosition();
    const pos: WindowPosition = { x, y };
    this.settings = { ...this.settings, hudPosition: pos };
    this.options.onHudPositionCommitted(pos);
  }

  destroyAll(): void {
    this.prepareForQuit();
    if (this.detailWindow && !this.detailWindow.isDestroyed()) {
      this.detailWindow.destroy();
    }
    if (this.hudWindow && !this.hudWindow.isDestroyed()) {
      this.hudWindow.destroy();
    }
    this.detailWindow = null;
    this.hudWindow = null;
    this.hudReady = false;
    this.detailReady = false;
  }
}

export function resolvePreloadPath(mainDirname: string): string {
  return path.join(mainDirname, '../preload/index.js');
}

export function resolveRendererHtmlPath(mainDirname: string): string {
  return path.join(mainDirname, '../renderer/index.html');
}
