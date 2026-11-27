import { describe, expect, it, vi } from 'vitest';

const {
  mockRepresentations,
  mockTrayInstances,
  mockBuiltMenuTemplates,
} = vi.hoisted(() => ({
  mockRepresentations: [] as Array<Array<{ scaleFactor: number; width: number; height: number }>>,
  mockTrayInstances: [] as Array<{
    image: unknown;
    tooltip: string;
    menu: unknown;
    destroyed: boolean;
    listeners: Map<string, () => void>;
    setToolTip: ReturnType<typeof vi.fn>;
    setImage: ReturnType<typeof vi.fn>;
    setContextMenu: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
  mockBuiltMenuTemplates: [] as Array<Array<Record<string, unknown>>>,
}));

vi.mock('electron', () => ({
  globalShortcut: {
    register: vi.fn(),
    unregister: vi.fn(),
    isRegistered: vi.fn(),
  },
  nativeImage: {
    createEmpty: vi.fn(() => {
      const reps: Array<{ scaleFactor: number; width: number; height: number }> = [];
      mockRepresentations.push(reps);
      return {
        addRepresentation: vi.fn((rep: { scaleFactor: number; width: number; height: number }) => {
          reps.push(rep);
        }),
        reps,
      };
    }),
    createFromBuffer: vi.fn(() => ({ resize: vi.fn() })),
  },
  Menu: {
    buildFromTemplate: vi.fn((template: Array<Record<string, unknown>>) => {
      mockBuiltMenuTemplates.push(template);
      return { template };
    }),
  },
  Tray: vi.fn(function (this: unknown, image: unknown) {
    const listeners = new Map<string, () => void>();
    const instance = {
      image,
      tooltip: '',
      menu: null as unknown,
      destroyed: false,
      listeners,
      setToolTip: vi.fn((tip: string) => {
        instance.tooltip = tip;
      }),
      setImage: vi.fn((img: unknown) => {
        instance.image = img;
      }),
      setContextMenu: vi.fn((menu: unknown) => {
        instance.menu = menu;
      }),
      on: vi.fn((event: string, cb: () => void) => {
        listeners.set(event, cb);
      }),
      destroy: vi.fn(() => {
        instance.destroyed = true;
      }),
    };
    mockTrayInstances.push(instance);
    return instance;
  }),
}));

import {
  BossKeyManager,
  TrayManager,
  formatTrayTooltip,
  generateTrayIconPng,
  getTrayNativeImage,
  normalizeAccelerator,
  resolveTrayIconMood,
  type GlobalShortcutApi,
} from '../../src/main/tray';
import type { DesktopShellState, MarketDashboardState } from '../../src/shared/types';

function makeDashboardState(overrides?: {
  cumTurnover?: number | null;
  volumeState?: 'EXPANDING' | 'FLAT' | 'SHRINKING' | 'UNAVAILABLE';
  cumRatioPct?: number | null;
  degraded?: boolean;
  stale?: boolean;
}): MarketDashboardState {
  const cumTurnover = overrides && 'cumTurnover' in overrides ? overrides.cumTurnover ?? null : 1.28e12;
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
      lastUpdatedAt: Date.now(),
      lastLatencyMs: 68,
      consecutiveFailures: 0,
      stale: overrides?.stale ?? false,
      degraded: overrides?.degraded ?? false,
      degradedReasons: overrides?.degraded ? ['主源超时'] : [],
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
              cumRatioPct: overrides?.cumRatioPct ?? 12.4,
              predictedFullDayTurnover: 1.68e12,
              volumeState: overrides?.volumeState ?? 'EXPANDING',
              slope: 0.85,
              windowMultiple: 1.25,
              windowDeviationPct: 25,
              slopeWindow: 5,
            },
      todaySeries: [],
      prevSeries: [],
      degraded: overrides?.degraded ?? false,
      degradedReason: overrides?.degraded ? '数据降级' : null,
    },
    indices: [],
    watchlist: [],
    recentAlerts: [],
  };
}

describe('trayTooltip and trayIcon', () => {
  it('formats tooltip for initializing, expanding, shrinking, and degraded states', () => {
    expect(formatTrayTooltip(null)).toContain('数据初始化中');

    const expanding = formatTrayTooltip(
      makeDashboardState({ cumTurnover: 1.28e12, volumeState: 'EXPANDING', cumRatioPct: 12.4 })
    );
    expect(expanding).toContain('1.28万亿');
    expect(expanding).toContain('放量');
    expect(expanding).toContain('+12.4%');

    const shrinking = formatTrayTooltip(
      makeDashboardState({ cumTurnover: 8.64e11, volumeState: 'SHRINKING', cumRatioPct: -8.6 })
    );
    expect(shrinking).toContain('8640.0亿');
    expect(shrinking).toContain('缩量');
    expect(shrinking).toContain('-8.6%');

    const degradedWithVal = formatTrayTooltip(
      makeDashboardState({ cumTurnover: 1.05e12, volumeState: 'FLAT', degraded: true, stale: true })
    );
    expect(degradedWithVal).toContain('降级');
    expect(degradedWithVal).toContain('陈旧');

    const degradedMissing = formatTrayTooltip(
      makeDashboardState({ cumTurnover: null, degraded: true })
    );
    expect(degradedMissing).toContain('不可用');
    expect(degradedMissing).toContain('降级');
    expect(degradedMissing).not.toContain('0元');
  });

  it('generates valid distinct PNG buffers for all tray icon moods', () => {
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const exp = generateTrayIconPng('expanding');
    const shr = generateTrayIconPng('shrinking');
    const flt = generateTrayIconPng('flat');
    const deg = generateTrayIconPng('degraded');

    for (const buf of [exp, shr, flt, deg]) {
      expect(buf.subarray(0, 8).equals(pngSignature)).toBe(true);
      expect(buf.length).toBeGreaterThan(60);
    }
    expect(exp.equals(shr)).toBe(false);
    expect(exp.equals(deg)).toBe(false);

    expect(resolveTrayIconMood(makeDashboardState({ volumeState: 'EXPANDING' }))).toBe('expanding');
    expect(resolveTrayIconMood(makeDashboardState({ volumeState: 'SHRINKING' }))).toBe('shrinking');
    expect(resolveTrayIconMood(makeDashboardState({ degraded: true }))).toBe('degraded');

    // 验证支持 16x16 + 32x32 双分辨率表示（保留 Windows 高 DPI 清晰度）
    const png16 = generateTrayIconPng('expanding', 16);
    expect(png16.subarray(0, 8).equals(pngSignature)).toBe(true);
    expect(png16.readUInt32BE(16)).toBe(16);
    expect(exp.readUInt32BE(16)).toBe(32);

    const beforeCount = mockRepresentations.length;
    getTrayNativeImage('expanding');
    expect(mockRepresentations.length).toBeGreaterThanOrEqual(beforeCount);
    const lastReps = mockRepresentations[mockRepresentations.length - 1];
    expect(lastReps.map((r) => r.scaleFactor)).toEqual([1.0, 2.0]);
  });
});

describe('TrayManager', () => {
  function makeShellState(overrides?: Partial<DesktopShellState>): DesktopShellState {
    return {
      settings: {
        hudPosition: null,
        hudOpacity: 0.9,
        alwaysOnTop: true,
        muted: false,
        bossKey: 'Alt+Shift+A',
        autoLaunch: false,
        hudMode: 'standard',
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
      ...overrides,
    };
  }

  it('builds complete context menu, wires checkboxes/actions, isolates dev simulation items, and updates tooltip/icon', () => {
    const actions = {
      onToggleHud: vi.fn(),
      onToggleDetail: vi.fn(),
      onToggleMinimalMode: vi.fn(),
      onToggleAlwaysOnTop: vi.fn(),
      onToggleMuted: vi.fn(),
      onToggleAutoLaunch: vi.fn(),
      onRefreshNow: vi.fn(),
      onOpenSettings: vi.fn(),
      onSimulateAlert: vi.fn(),
      onQuit: vi.fn(),
    };

    const trayMgr = new TrayManager(actions, 'win32');
    trayMgr.init(makeShellState({ isDev: true }), makeDashboardState({ volumeState: 'EXPANDING' }));

    const trayInstance = mockTrayInstances[mockTrayInstances.length - 1];
    const devMenu = mockBuiltMenuTemplates[mockBuiltMenuTemplates.length - 1];
    const labels = devMenu.map((item) => item.label).filter(Boolean);

    expect(labels).toContain('隐藏悬浮窗');
    expect(labels).toContain('展开详情浮层');
    expect(labels).toContain('极简模式');
    expect(labels).toContain('窗口置顶');
    expect(labels).toContain('静音提醒');
    expect(labels).toContain('开机自启');
    expect(labels).toContain('手动刷新行情');
    expect(labels).toContain('打开设置');
    expect(labels).toContain('开发测试：模拟急放告警');
    expect(labels).toContain('开发测试：模拟急缩告警');
    expect(labels).toContain('退出');

    // 点击托盘图标切换悬浮窗
    trayInstance.listeners.get('click')?.();
    expect(actions.onToggleHud).toHaveBeenCalledTimes(1);

    // 触发菜单回调
    const muteItem = devMenu.find((i) => i.label === '静音提醒');
    (muteItem?.click as (arg: { checked: boolean }) => void)?.({ checked: true });
    expect(actions.onToggleMuted).toHaveBeenCalledWith(true);

    const minimalItem = devMenu.find((i) => i.label === '极简模式');
    expect(minimalItem?.checked).toBe(false);
    (minimalItem?.click as (arg: { checked: boolean }) => void)?.({ checked: true });
    expect(actions.onToggleMinimalMode).toHaveBeenCalledWith(true);

    const simSurge = devMenu.find((i) => i.label === '开发测试：模拟急放告警');
    (simSurge?.click as () => void)?.();
    expect(actions.onSimulateAlert).toHaveBeenCalledWith('SURGE');

    const quitItem = devMenu.find((i) => i.label === '退出');
    (quitItem?.click as () => void)?.();
    expect(actions.onQuit).toHaveBeenCalledTimes(1);

    // 切换生产态（isDev: false）时绝不暴露模拟菜单项，且极简勾选同步
    trayMgr.updateShellState(
      makeShellState({
        isDev: false,
        hudVisible: false,
        detailVisible: true,
        settings: {
          hudPosition: null,
          hudOpacity: 0.9,
          alwaysOnTop: true,
          muted: false,
          bossKey: 'Alt+Shift+A',
          autoLaunch: false,
          hudMode: 'minimal',
        },
      })
    );
    const prodMenu = mockBuiltMenuTemplates[mockBuiltMenuTemplates.length - 1];
    const prodLabels = prodMenu.map((item) => item.label).filter(Boolean);
    expect(prodLabels).toContain('显示悬浮窗');
    expect(prodLabels).toContain('收起详情浮层');
    expect(prodMenu.find((i) => i.label === '极简模式')?.checked).toBe(true);
    expect(prodLabels).not.toContain('开发测试：模拟急放告警');

    // 行情状态由放量切为降级时更新图标与 Tooltip
    trayMgr.updateMarketState(makeDashboardState({ degraded: true, stale: true }));
    expect(trayInstance.setImage).toHaveBeenCalledTimes(1);
    expect(trayInstance.tooltip).toContain('降级');
    expect(trayInstance.tooltip).toContain('陈旧');

    trayMgr.destroy();
    expect(trayInstance.destroyed).toBe(true);
  });

  it('does not bind click-to-toggle on macOS so menu bar click only opens context menu', () => {
    const actions = {
      onToggleHud: vi.fn(),
      onToggleDetail: vi.fn(),
      onToggleMinimalMode: vi.fn(),
      onToggleAlwaysOnTop: vi.fn(),
      onToggleMuted: vi.fn(),
      onToggleAutoLaunch: vi.fn(),
      onRefreshNow: vi.fn(),
      onOpenSettings: vi.fn(),
      onQuit: vi.fn(),
    };

    const macTrayMgr = new TrayManager(actions, 'darwin');
    macTrayMgr.init(makeShellState({ isDev: false }), makeDashboardState({ volumeState: 'FLAT' }));

    const macTrayInstance = mockTrayInstances[mockTrayInstances.length - 1];
    expect(macTrayInstance.listeners.has('click')).toBe(false);
    expect(actions.onToggleHud).not.toHaveBeenCalled();

    macTrayMgr.destroy();
    expect(macTrayInstance.destroyed).toBe(true);
  });
});

describe('BossKeyManager', () => {
  function createFakeShortcutApi(occupiedKeys: Set<string>): {
    api: GlobalShortcutApi;
    registered: Map<string, () => void>;
  } {
    const registered = new Map<string, () => void>();
    const api: GlobalShortcutApi = {
      register: (acc, cb) => {
        if (occupiedKeys.has(acc) || registered.has(acc)) {
          return false;
        }
        registered.set(acc, cb);
        return true;
      },
      unregister: (acc) => {
        registered.delete(acc);
      },
      isRegistered: (acc) => registered.has(acc),
    };
    return { api, registered };
  }

  it('registers initial shortcut, handles conflict, and preserves old binding on rebind conflict', () => {
    const occupied = new Set<string>(['Ctrl+Shift+X']);
    const { api, registered } = createFakeShortcutApi(occupied);
    const onTrigger = vi.fn();
    const onConflict = vi.fn();

    const manager = new BossKeyManager({
      shortcutApi: api,
      onTrigger,
      onConflict,
    });

    // 初始注册成功
    const initStatus = manager.registerInitial('Alt+Shift+A');
    expect(initStatus).toEqual({
      accelerator: 'Alt+Shift+A',
      registered: true,
      conflictMessage: null,
    });
    registered.get('Alt+Shift+A')?.();
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // 改绑到被占用快捷键 → 返回冲突提示，但保留原 Alt+Shift+A
    const failedRebind = manager.rebind('Ctrl+Shift+X');
    expect(failedRebind.success).toBe(false);
    expect(failedRebind.committedAccelerator).toBe('Alt+Shift+A');
    expect(failedRebind.status.registered).toBe(true);
    expect(failedRebind.status.conflictMessage).toContain('已被其他应用占用');
    expect(registered.has('Alt+Shift+A')).toBe(true);
    expect(onConflict).toHaveBeenCalledTimes(1);

    // 改绑到空闲快捷键 → 解绑旧键并生效新键
    const okRebind = manager.rebind('Alt+Shift+Z');
    expect(okRebind.success).toBe(true);
    expect(okRebind.committedAccelerator).toBe('Alt+Shift+Z');
    expect(okRebind.status.conflictMessage).toBeNull();
    expect(registered.has('Alt+Shift+A')).toBe(false);
    expect(registered.has('Alt+Shift+Z')).toBe(true);

    manager.unregister();
    expect(registered.size).toBe(0);
  });

  it('reports initial conflict clearly when default accelerator is already taken', () => {
    const { api } = createFakeShortcutApi(new Set(['Alt+Shift+A']));
    const onConflict = vi.fn();
    const manager = new BossKeyManager({
      shortcutApi: api,
      onTrigger: vi.fn(),
      onConflict,
    });

    const status = manager.registerInitial('Alt+Shift+A');
    expect(status.registered).toBe(false);
    expect(status.conflictMessage).toContain('Alt+Shift+A');
    expect(onConflict).toHaveBeenCalledTimes(1);
  });

  it('rejects bare single-key shortcuts and avoids case/whitespace/order self-conflict on rebind', () => {
    // 模拟 Windows globalShortcut 大小写不敏感行为
    const registeredLower = new Map<string, () => void>();
    const winShortcutApi: GlobalShortcutApi = {
      register: (acc, cb) => {
        const key = acc.toLowerCase().replace(/\s+/g, '');
        if (registeredLower.has(key)) return false;
        registeredLower.set(key, cb);
        return true;
      },
      unregister: (acc) => {
        registeredLower.delete(acc.toLowerCase().replace(/\s+/g, ''));
      },
      isRegistered: (acc) => registeredLower.has(acc.toLowerCase().replace(/\s+/g, '')),
    };

    const onConflict = vi.fn();
    const manager = new BossKeyManager({
      shortcutApi: winShortcutApi,
      onTrigger: vi.fn(),
      onConflict,
    });

    // 裸单键禁止注册（避免劫持系统正常打字）
    expect(normalizeAccelerator('A').valid).toBe(false);
    expect(normalizeAccelerator('Enter').valid).toBe(false);
    expect(normalizeAccelerator('F9').valid).toBe(true);

    expect(manager.registerInitial('Alt+Shift+A').registered).toBe(true);

    // 尝试改绑为裸单键被拒，且原热键安全保留
    const bareRes = manager.rebind('A');
    expect(bareRes.success).toBe(false);
    expect(bareRes.committedAccelerator).toBe('Alt+Shift+A');
    expect(bareRes.status.registered).toBe(true);
    expect(bareRes.status.conflictMessage).toContain('修饰键');

    // 大小写、空格、修饰键顺序等价变体视为同一快捷键，不自冲突并清除旧冲突提示
    const lowerRes = manager.rebind('alt+shift+a');
    expect(lowerRes.success).toBe(true);
    expect(lowerRes.committedAccelerator).toBe('Alt+Shift+A');
    expect(lowerRes.status.conflictMessage).toBeNull();

    const spacedRes = manager.rebind('Shift + Alt + A');
    expect(spacedRes.success).toBe(true);
    expect(spacedRes.committedAccelerator).toBe('Alt+Shift+A');
    expect(spacedRes.status.conflictMessage).toBeNull();

    // 允许独立功能键改绑
    const f9Res = manager.rebind('f9');
    expect(f9Res.success).toBe(true);
    expect(f9Res.committedAccelerator).toBe('F9');
  });
});
