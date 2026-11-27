import { Menu, Tray, type MenuItemConstructorOptions } from 'electron';
import type { AlertDirection, DesktopShellState, MarketDashboardState } from '../../shared/types';
import { getTrayNativeImage, resolveTrayIconMood, type TrayIconMood } from './trayIcon';
import { formatTrayTooltip } from './trayTooltip';

export interface TrayManagerActions {
  onToggleHud: () => void;
  onToggleDetail: () => void;
  onToggleMinimalMode: (next: boolean) => void;
  onToggleAlwaysOnTop: (next: boolean) => void;
  onToggleMuted: (next: boolean) => void;
  onToggleAutoLaunch: (next: boolean) => void;
  onRefreshNow: () => void;
  onOpenSettings: () => void;
  onSimulateAlert?: (direction: AlertDirection) => void;
  onQuit: () => void;
}

/**
 * Windows 系统托盘管理器：
 * - 右键菜单完整覆盖显隐、详情、置顶、静音、手动刷新、开机自启、设置、退出
 * - 悬停 Tooltip 实时展示两市总成交额与放/平/缩量及降级状态
 */
export class TrayManager {
  private readonly actions: TrayManagerActions;
  private readonly platform: NodeJS.Platform;
  private tray: Tray | null = null;
  private currentMood: TrayIconMood = 'flat';
  private lastShellState: DesktopShellState | null = null;

  constructor(actions: TrayManagerActions, platform: NodeJS.Platform = process.platform) {
    this.actions = actions;
    this.platform = platform;
  }

  init(initialShellState: DesktopShellState, initialMarketState: MarketDashboardState | null): void {
    if (this.tray) return;

    this.lastShellState = initialShellState;
    this.currentMood = resolveTrayIconMood(initialMarketState);

    this.tray = new Tray(getTrayNativeImage(this.currentMood));
    this.tray.setToolTip(formatTrayTooltip(initialMarketState));
    this.rebuildContextMenu();

    // macOS 菜单栏图标绑定 contextMenu 后左键默认展开菜单，避免叠加 click 导致同时显隐 HUD
    if (this.platform !== 'darwin') {
      this.tray.on('click', () => {
        this.actions.onToggleHud();
      });
    }
  }

  updateMarketState(state: MarketDashboardState | null): void {
    if (!this.tray) return;

    const nextMood = resolveTrayIconMood(state);
    if (nextMood !== this.currentMood) {
      this.currentMood = nextMood;
      this.tray.setImage(getTrayNativeImage(nextMood));
    }
    this.tray.setToolTip(formatTrayTooltip(state));
  }

  updateShellState(state: DesktopShellState): void {
    this.lastShellState = state;
    if (!this.tray) return;
    this.rebuildContextMenu();
  }

  private rebuildContextMenu(): void {
    if (!this.tray || !this.lastShellState) return;
    const shell = this.lastShellState;

    const template: MenuItemConstructorOptions[] = [
      {
        label: shell.hudVisible ? '隐藏悬浮窗' : '显示悬浮窗',
        click: () => this.actions.onToggleHud(),
      },
      {
        label: shell.detailVisible ? '收起详情浮层' : '展开详情浮层',
        click: () => this.actions.onToggleDetail(),
      },
      { type: 'separator' },
      {
        label: '极简模式',
        type: 'checkbox',
        checked: shell.settings.hudMode === 'minimal',
        click: (menuItem) => this.actions.onToggleMinimalMode(menuItem.checked),
      },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: shell.settings.alwaysOnTop,
        click: (menuItem) => this.actions.onToggleAlwaysOnTop(menuItem.checked),
      },
      {
        label: '静音提醒',
        type: 'checkbox',
        checked: shell.settings.muted,
        click: (menuItem) => this.actions.onToggleMuted(menuItem.checked),
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: shell.settings.autoLaunch,
        click: (menuItem) => this.actions.onToggleAutoLaunch(menuItem.checked),
      },
      { type: 'separator' },
      {
        label: '手动刷新行情',
        click: () => this.actions.onRefreshNow(),
      },
      {
        label: '打开设置',
        click: () => this.actions.onOpenSettings(),
      },
    ];

    if (shell.isDev && this.actions.onSimulateAlert) {
      template.push(
        { type: 'separator' },
        {
          label: '开发测试：模拟急放告警',
          click: () => this.actions.onSimulateAlert?.('SURGE'),
        },
        {
          label: '开发测试：模拟急缩告警',
          click: () => this.actions.onSimulateAlert?.('SHRINK'),
        }
      );
    }

    template.push(
      { type: 'separator' },
      {
        label: '退出',
        click: () => this.actions.onQuit(),
      }
    );

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
