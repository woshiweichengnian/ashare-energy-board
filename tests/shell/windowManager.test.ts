import { afterEach, describe, expect, it, vi } from 'vitest';

interface MockBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MockBrowserWindowInstance {
  opts: Record<string, unknown>;
  bounds: MockBounds;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  resizeSequence: string[];
  visible: boolean;
  destroyed: boolean;
  opacity: number;
  alwaysOnTop: boolean;
  showCalls: number;
  hideCalls: number;
  focusCalls: number;
  sentMessages: Array<{ channel: string; payload: unknown }>;
  emitWindowEvent: (event: string, ...args: unknown[]) => void;
  emitWebContentsEvent: (event: string, ...args: unknown[]) => void;
}

const { mockWindows, mockDisplays } = vi.hoisted(() => ({
  mockWindows: [] as MockBrowserWindowInstance[],
  mockDisplays: [
    { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
  ],
}));

vi.mock('electron', () => ({
  app: { isPackaged: true, quit: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => mockDisplays),
    getPrimaryDisplay: vi.fn(() => mockDisplays[0]),
  },
  BrowserWindow: vi.fn(function (this: unknown, opts: Record<string, unknown>) {
    const winListeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const wcListeners = new Map<string, Array<(...args: unknown[]) => void>>();

    const addListener = (
      map: Map<string, Array<(...args: unknown[]) => void>>,
      event: string,
      cb: (...args: unknown[]) => void
    ) => {
      const list = map.get(event) ?? [];
      list.push(cb);
      map.set(event, list);
    };

    const emit = (
      map: Map<string, Array<(...args: unknown[]) => void>>,
      event: string,
      args: unknown[]
    ) => {
      for (const cb of [...(map.get(event) ?? [])]) {
        cb(...args);
      }
    };

    const instance: MockBrowserWindowInstance = {
      opts,
      bounds: {
        x: Number(opts.x ?? 0),
        y: Number(opts.y ?? 0),
        width: Number(opts.width ?? 376),
        height: Number(opts.height ?? 388),
      },
      minWidth: Number(opts.minWidth ?? 0),
      minHeight: Number(opts.minHeight ?? 0),
      resizable: opts.resizable !== false,
      resizeSequence: [],
      visible: Boolean(opts.show),
      destroyed: false,
      opacity: 1,
      alwaysOnTop: Boolean(opts.alwaysOnTop),
      showCalls: 0,
      hideCalls: 0,
      focusCalls: 0,
      sentMessages: [],
      emitWindowEvent: (event, ...args) => emit(winListeners, event, args),
      emitWebContentsEvent: (event, ...args) => emit(wcListeners, event, args),
    };

    const proxy = {
      webContents: {
        setZoomFactor: () => {},
        on: (event: string, cb: (...args: unknown[]) => void) => addListener(wcListeners, event, cb),
        send: (channel: string, payload: unknown) => {
          instance.sentMessages.push({ channel, payload });
        },
        isDestroyed: () => instance.destroyed,
      },
      on: (event: string, cb: (...args: unknown[]) => void) => addListener(winListeners, event, cb),
      once: (event: string, cb: (...args: unknown[]) => void) => {
        const wrapper = (...args: unknown[]) => {
          const list = winListeners.get(event) ?? [];
          winListeners.set(
            event,
            list.filter((fn) => fn !== wrapper)
          );
          cb(...args);
        };
        addListener(winListeners, event, wrapper);
      },
      loadURL: vi.fn(async () => {}),
      loadFile: vi.fn(async () => {}),
      setOpacity: vi.fn((val: number) => {
        instance.opacity = val;
      }),
      setAlwaysOnTop: vi.fn((flag: boolean) => {
        instance.alwaysOnTop = flag;
      }),
      getBounds: () => ({ ...instance.bounds }),
      setResizable: vi.fn((flag: boolean) => {
        instance.resizable = flag;
        instance.resizeSequence.push(`resizable:${flag}`);
      }),
      setMinimumSize: vi.fn((width: number, height: number) => {
        instance.minWidth = width;
        instance.minHeight = height;
        instance.resizeSequence.push(`minSize:${width}x${height}`);
      }),
      setBounds: vi.fn((b: MockBounds) => {
        instance.bounds = { ...b };
        instance.resizeSequence.push(`bounds:${b.width}x${b.height}`);
      }),
      getPosition: () => [instance.bounds.x, instance.bounds.y] as [number, number],
      setPosition: vi.fn((x: number, y: number) => {
        instance.bounds.x = x;
        instance.bounds.y = y;
      }),
      show: vi.fn(() => {
        instance.visible = true;
        instance.showCalls += 1;
        instance.emitWindowEvent('show');
      }),
      hide: vi.fn(() => {
        instance.visible = false;
        instance.hideCalls += 1;
        instance.emitWindowEvent('hide');
      }),
      focus: vi.fn(() => {
        instance.focusCalls += 1;
      }),
      isVisible: () => instance.visible,
      isDestroyed: () => instance.destroyed,
      destroy: vi.fn(() => {
        instance.destroyed = true;
        instance.visible = false;
        instance.emitWindowEvent('closed');
      }),
    };

    mockWindows.push(instance);
    return proxy;
  }),
}));

import { WindowManager } from '../../src/main/windows/windowManager';
import {
  HUD_DEFAULT_HEIGHT,
  HUD_DEFAULT_WIDTH,
  HUD_MINIMAL_HEIGHT,
  HUD_MINIMAL_WIDTH,
} from '../../src/shared/constants';
import type { DesktopShellSettings } from '../../src/shared/types';

function makeSettings(overrides?: Partial<DesktopShellSettings>): DesktopShellSettings {
  return {
    hudPosition: null,
    hudOpacity: 0.85,
    alwaysOnTop: true,
    muted: false,
    bossKey: 'Alt+Shift+A',
    autoLaunch: false,
    hudMode: 'standard',
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  mockWindows.length = 0;
  mockDisplays.length = 0;
  mockDisplays.push(
    { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }
  );
});

describe('WindowManager', () => {
  it('creates frameless transparent always-on-top HUD with backgroundThrottling disabled and intercepts close to hide', () => {
    const onPositionCommitted = vi.fn();
    const onStateChanged = vi.fn();
    const wm = new WindowManager({
      preloadPath: '/preload.js',
      rendererHtmlPath: '/index.html',
      initialSettings: makeSettings(),
      onHudPositionCommitted: onPositionCommitted,
      onStateChanged,
    });

    wm.createHudWindow();
    const hud = mockWindows[0];
    expect(hud.opts.frame).toBe(false);
    expect(hud.opts.transparent).toBe(true);
    expect(hud.opts.skipTaskbar).toBe(true);
    expect(hud.opts.alwaysOnTop).toBe(true);
    expect(HUD_DEFAULT_HEIGHT).toBeGreaterThanOrEqual(380);
    const webPrefs = hud.opts.webPreferences as Record<string, unknown>;
    expect(webPrefs.contextIsolation).toBe(true);
    expect(webPrefs.nodeIntegration).toBe(false);
    expect(webPrefs.sandbox).toBe(true);
    expect(webPrefs.backgroundThrottling).toBe(false);

    // ready-to-show 触发显示
    hud.emitWindowEvent('ready-to-show');
    expect(wm.isHudVisible()).toBe(true);

    // 关闭按钮拦截为隐藏到托盘（非退出态）
    const closeEvent = { preventDefault: vi.fn() };
    hud.emitWindowEvent('close', closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(wm.isHudVisible()).toBe(false);

    // 显式退出时放行关闭
    wm.prepareForQuit();
    const quitCloseEvent = { preventDefault: vi.fn() };
    hud.emitWindowEvent('close', quitCloseEvent);
    expect(quitCloseEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('respects early hideHud before ready-to-show, debounces moved saves, and flushes on prepareForQuit', () => {
    vi.useFakeTimers();
    const onPositionCommitted = vi.fn();
    const wm = new WindowManager({
      preloadPath: '/preload.js',
      rendererHtmlPath: '/index.html',
      initialSettings: makeSettings(),
      onHudPositionCommitted: onPositionCommitted,
      onStateChanged: vi.fn(),
    });

    wm.createHudWindow();
    const hud = mockWindows[0];
    wm.hideHud();
    hud.emitWindowEvent('ready-to-show');
    // 启动完成前已要求隐藏，不得强行弹回
    expect(wm.isHudVisible()).toBe(false);

    wm.showHud();
    expect(wm.isHudVisible()).toBe(true);

    // 拖动防抖 200ms 持久化，退出前立即刷盘
    hud.bounds.x = 640;
    hud.bounds.y = 180;
    hud.emitWindowEvent('moved');
    expect(onPositionCommitted).not.toHaveBeenCalled();

    wm.prepareForQuit();
    expect(onPositionCommitted).toHaveBeenCalledWith({ x: 640, y: 180 });
  });

  it('waits for ready-to-show on first openDetail, hides on Escape without destroying, and recovers off-screen windows on boss key restore', () => {
    const onStateChanged = vi.fn();
    const wm = new WindowManager({
      preloadPath: '/preload.js',
      rendererHtmlPath: '/index.html',
      initialSettings: makeSettings({ hudPosition: { x: 2400, y: 120 } }),
      onHudPositionCommitted: vi.fn(),
      onStateChanged,
    });

    wm.createHudWindow();
    const hud = mockWindows[0];
    hud.emitWindowEvent('ready-to-show');

    // 首次打开详情浮层：等待 ready-to-show 防闪屏
    wm.openDetail({ symbol: '000001.SH', tab: 'alerts' });
    const detail = mockWindows[1];
    expect(wm.getActiveDetailSymbol()).toBe('000001.SH');
    expect(wm.getActiveDetailTab()).toBe('alerts');
    expect(wm.getDetailFocusSeq()).toBe(1);
    expect(wm.isDetailVisible()).toBe(false);

    detail.emitWindowEvent('ready-to-show');
    expect(wm.isDetailVisible()).toBe(true);

    // 按 Escape 隐藏但不销毁详情浮层
    const escEvent = { preventDefault: vi.fn() };
    detail.emitWebContentsEvent('before-input-event', escEvent, { type: 'keyDown', key: 'Escape' });
    expect(escEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(wm.isDetailVisible()).toBe(false);
    expect(detail.destroyed).toBe(false);

    // 已就绪后再次打开详情浮层立即显示
    wm.openDetail({ tab: 'settings' });
    expect(wm.isDetailVisible()).toBe(true);
    expect(wm.getDetailFocusSeq()).toBe(2);

    // 页内模态框打开期间抑制主进程 Escape 拦截，允许 Esc 仅关闭弹窗；恢复后 Esc 再次收起详情窗
    wm.setDetailEscapeSuppressed(true);
    const modalEscEvent = { preventDefault: vi.fn() };
    detail.emitWebContentsEvent('before-input-event', modalEscEvent, {
      type: 'keyDown',
      key: 'Escape',
    });
    expect(modalEscEvent.preventDefault).not.toHaveBeenCalled();
    expect(wm.isDetailVisible()).toBe(true);

    wm.setDetailEscapeSuppressed(false);
    const closeEscEvent = { preventDefault: vi.fn() };
    detail.emitWebContentsEvent('before-input-event', closeEscEvent, {
      type: 'keyDown',
      key: 'Escape',
    });
    expect(closeEscEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(wm.isDetailVisible()).toBe(false);

    wm.openDetail({ tab: 'settings' });
    expect(wm.isDetailVisible()).toBe(true);

    // 老板键隐藏双窗：合并为单次状态广播
    onStateChanged.mockClear();
    wm.toggleBossKeyVisibility();
    expect(wm.isHudVisible()).toBe(false);
    expect(wm.isDetailVisible()).toBe(false);
    expect(onStateChanged).toHaveBeenCalledTimes(1);

    // 模拟隐藏期间拔掉副屏，仅剩主屏 0..1920
    mockDisplays.splice(1, 1);

    // 再次按老板键恢复双窗：HUD 与 Detail 必须自动拉回主屏可见区域
    onStateChanged.mockClear();
    wm.toggleBossKeyVisibility();
    expect(wm.isHudVisible()).toBe(true);
    expect(wm.isDetailVisible()).toBe(true);
    expect(hud.bounds.x).toBeLessThan(1920);
    expect(hud.bounds.x).toBeGreaterThanOrEqual(0);
    expect(detail.bounds.x).toBeLessThan(1920);
    expect(detail.bounds.x).toBeGreaterThanOrEqual(0);
    expect(onStateChanged).toHaveBeenCalledTimes(1);
  });

  it('creates minimal HUD size when persisted and resizes dynamically with right-edge anchoring on applyHudMode', () => {
    const onPositionCommitted = vi.fn();
    const wmMinimal = new WindowManager({
      preloadPath: '/preload.js',
      rendererHtmlPath: '/index.html',
      initialSettings: makeSettings({ hudMode: 'minimal' }),
      onHudPositionCommitted: onPositionCommitted,
      onStateChanged: vi.fn(),
    });

    wmMinimal.createHudWindow();
    const initialMinimalHud = mockWindows[0];
    expect(initialMinimalHud.bounds.width).toBe(HUD_MINIMAL_WIDTH);
    expect(initialMinimalHud.bounds.height).toBe(HUD_MINIMAL_HEIGHT);
    expect(initialMinimalHud.minWidth).toBe(HUD_MINIMAL_WIDTH);
    expect(initialMinimalHud.minHeight).toBe(HUD_MINIMAL_HEIGHT);

    // 标准窗口在右上角动态切换极简与标准模式
    const wm = new WindowManager({
      preloadPath: '/preload.js',
      rendererHtmlPath: '/index.html',
      initialSettings: makeSettings({
        hudMode: 'standard',
        hudPosition: { x: 1500, y: 20 },
      }),
      onHudPositionCommitted: onPositionCommitted,
      onStateChanged: vi.fn(),
    });
    wm.createHudWindow();
    const hud = mockWindows[1];
    expect(hud.bounds).toEqual({
      x: 1500,
      y: 20,
      width: HUD_DEFAULT_WIDTH,
      height: HUD_DEFAULT_HEIGHT,
    });

    wm.applyHudMode('minimal');
    expect(hud.resizeSequence).toEqual([
      'resizable:true',
      `minSize:${HUD_MINIMAL_WIDTH}x${HUD_MINIMAL_HEIGHT}`,
      `bounds:${HUD_MINIMAL_WIDTH}x${HUD_MINIMAL_HEIGHT}`,
      'resizable:false',
    ]);
    expect(hud.resizable).toBe(false);
    expect(hud.minWidth).toBe(HUD_MINIMAL_WIDTH);
    expect(hud.minHeight).toBe(HUD_MINIMAL_HEIGHT);
    expect(hud.bounds).toEqual({
      x: 1500 + HUD_DEFAULT_WIDTH - HUD_MINIMAL_WIDTH,
      y: 20,
      width: HUD_MINIMAL_WIDTH,
      height: HUD_MINIMAL_HEIGHT,
    });
    expect(onPositionCommitted).toHaveBeenCalledWith({
      x: 1500 + HUD_DEFAULT_WIDTH - HUD_MINIMAL_WIDTH,
      y: 20,
    });

    hud.resizeSequence.length = 0;
    wm.applyHudMode('standard');
    expect(hud.bounds).toEqual({
      x: 1500,
      y: 20,
      width: HUD_DEFAULT_WIDTH,
      height: HUD_DEFAULT_HEIGHT,
    });
    expect(hud.resizeSequence).toEqual([
      'resizable:true',
      `minSize:${HUD_DEFAULT_WIDTH}x${HUD_DEFAULT_HEIGHT}`,
      `bounds:${HUD_DEFAULT_WIDTH}x${HUD_DEFAULT_HEIGHT}`,
      'resizable:false',
    ]);
  });
});
