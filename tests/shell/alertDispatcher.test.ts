import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: {
    isSupported: () => true,
  },
}));

import {
  AlertDispatcher,
  isSimulatedAlertMessage,
  type NativeNotificationRequest,
} from '../../src/main/alerts';
import { AppDatabase } from '../../src/main/storage/database';
import { SIMULATED_ALERT_PREFIX } from '../../src/shared/constants';
import type { AlertDispatchPayload, AlertEventInput } from '../../src/shared/types';

const openDbs: AppDatabase[] = [];

function createMemoryDb(): AppDatabase {
  const db = new AppDatabase(':memory:');
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe('AlertDispatcher', () => {
  it('persists alert_events, sends Windows notification, and broadcasts IPC payload', () => {
    const db = createMemoryDb();
    const notifications: NativeNotificationRequest[] = [];
    const broadcasts: AlertDispatchPayload[] = [];
    let muted = false;

    const dispatcher = new AlertDispatcher({
      database: db,
      isMuted: () => muted,
      broadcastAlert: (p) => broadcasts.push(p),
      sendNativeNotification: (req) => notifications.push(req),
      allowSimulation: true,
    });

    const liveEvent: AlertEventInput = {
      symbol: 'MARKET_TOTAL',
      name: '沪深两市',
      tradeDate: '2026-11-25',
      minuteIndex: 42,
      direction: 'SURGE',
      slope: 1.65,
      windowMultiple: 1.84,
      cumRatio: 0.132,
      message: '沪深两市 5 分钟快速放量',
      createdAt: 1764036720000,
    };

    const payload = dispatcher.dispatch(liveEvent);

    // 1. 落库校验
    const rows = db.getAlertEvents('2026-11-25', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(payload.id);
    expect(rows[0].direction).toBe('SURGE');
    expect(isSimulatedAlertMessage(rows[0].message)).toBe(false);

    // 2. 原生通知包含标的名、方向、斜率与区间倍数
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toContain('快速放量');
    expect(notifications[0].title).toContain('沪深两市');
    expect(notifications[0].body).toContain('+1.65%/分');
    expect(notifications[0].body).toContain('1.84x');

    // 3. IPC 广播载荷
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].isSimulated).toBe(false);
    expect(broadcasts[0].muted).toBe(false);

    // 4. 开启静音后：写库、原生通知、HUD 呼吸广播全部照常，仅 muted=true 静音提示音
    muted = true;
    const shrinkPayload = dispatcher.dispatch({
      ...liveEvent,
      direction: 'SHRINK',
      slope: -1.42,
      windowMultiple: 0.58,
      cumRatio: -0.095,
      createdAt: 1764036780000,
    });

    expect(db.getAlertEvents('2026-11-25', 10)).toHaveLength(2);
    expect(notifications).toHaveLength(2);
    expect(notifications[1].title).toContain('快速缩量');
    expect(notifications[1].silent).toBe(true);
    expect(broadcasts).toHaveLength(2);
    expect(shrinkPayload.muted).toBe(true);
  });

  it('clearly tags simulated alerts as test events and blocks simulation in production mode', () => {
    const db = createMemoryDb();
    const notifications: NativeNotificationRequest[] = [];
    const broadcasts: AlertDispatchPayload[] = [];

    const devDispatcher = new AlertDispatcher({
      database: db,
      isMuted: () => false,
      broadcastAlert: (p) => broadcasts.push(p),
      sendNativeNotification: (req) => notifications.push(req),
      allowSimulation: true,
      nowFn: () => Date.parse('2026-11-25T02:15:00.000Z'), // 北京时间 10:15
    });

    const simSurge = devDispatcher.dispatchSimulated('SURGE');
    expect(simSurge.isSimulated).toBe(true);
    expect(simSurge.message.startsWith(SIMULATED_ALERT_PREFIX)).toBe(true);
    expect(notifications[0].title).toContain('【模拟测试】');
    expect(notifications[0].body).toContain('非实盘信号');

    const stored = db.getAlertEvents('2026-11-25', 10);
    expect(stored).toHaveLength(1);
    expect(stored[0].message.startsWith(SIMULATED_ALERT_PREFIX)).toBe(true);

    // 打包生产模式禁止触发模拟告警
    const prodDispatcher = new AlertDispatcher({
      database: db,
      isMuted: () => false,
      broadcastAlert: vi.fn(),
      sendNativeNotification: vi.fn(),
      allowSimulation: false,
    });
    expect(() => prodDispatcher.dispatchSimulated('SHRINK')).toThrow();
  });
});
