import { afterEach, describe, expect, it } from 'vitest';
import type { MonitorConfig } from '../../src/shared/types';
import { AppDatabase } from '../../src/main/storage/database';
import {
  DEFAULT_MONITOR_CONFIG,
  MonitorSettingsStore,
  sanitizeMonitorConfig,
} from '../../src/main/storage/monitorSettingsStore';

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

describe('MonitorSettingsStore', () => {
  it('returns defaults when app_settings has no monitor.config', () => {
    const db = createMemoryDb();
    const store = new MonitorSettingsStore(db);
    expect(store.load()).toEqual(DEFAULT_MONITOR_CONFIG);
  });

  it('persists updates across reloads and clamps out-of-range fields safely', () => {
    const db = createMemoryDb();
    const store = new MonitorSettingsStore(db);

    const updated = store.update({
      pollingIntervalSec: 25, // 应钳制到 15
      expandThresholdPct: 8.5,
      shrinkThresholdPct: 7.5, // 正数自动规范为 -7.5
      slopeWindow: 10,
      surgeSlopeThreshold: 1.8,
      surgeMultipleThreshold: 1.9,
      shrinkSlopeThreshold: -1.6,
      shrinkMultipleThreshold: 0.55,
      matchMode: 'OR',
      cooldownMinutes: 8,
      alertsEnabled: false,
    });

    expect(updated).toEqual({
      pollingIntervalSec: 15,
      expandThresholdPct: 8.5,
      shrinkThresholdPct: -7.5,
      slopeWindow: 10,
      alertsEnabled: false,
      surgeSlopeThreshold: 1.8,
      surgeMultipleThreshold: 1.9,
      shrinkSlopeThreshold: -1.6,
      shrinkMultipleThreshold: 0.55,
      matchMode: 'OR',
      cooldownMinutes: 8,
      enabledCoreIndices: ['000001.SH', '399001.SZ', '399006.SZ', '000680.SH'],
      enabledOptionalIndices: [],
    });

    // 模拟重启重新加载
    const reloaded = new MonitorSettingsStore(db).load();
    expect(reloaded).toEqual(updated);

    // 非法斜率窗口回退到已有合法值
    const sanitized = sanitizeMonitorConfig({ slopeWindow: 7 as unknown as 5 }, reloaded);
    expect(sanitized.slopeWindow).toBe(10);
  });

  it('defaults optional indices to disabled and persists sanitized optional index selections', () => {
    const db = createMemoryDb();
    const store = new MonitorSettingsStore(db);

    expect(store.load().enabledOptionalIndices).toEqual([]);

    // 乱序 + 重复 + 非法代码均自动清洗并按标准顺序排列
    const updated = store.update({
      enabledOptionalIndices: [
        '000688.SH',
        '000016.SH',
        '000688.SH',
        '932000.CSI',
        '000680.SH',
      ] as unknown as MonitorConfig['enabledOptionalIndices'],
    });
    expect(updated.enabledOptionalIndices).toEqual(['000016.SH', '000688.SH']);

    // 模拟重启重新加载保持不变
    expect(new MonitorSettingsStore(db).load().enabledOptionalIndices).toEqual([
      '000016.SH',
      '000688.SH',
    ]);

    // 单独修改其他字段不应误覆盖已开启的可选指数
    const afterOtherPatch = store.update({ pollingIntervalSec: 5 });
    expect(afterOtherPatch.enabledOptionalIndices).toEqual(['000016.SH', '000688.SH']);

    // 全部关闭后持久化为空数组
    const cleared = store.update({ enabledOptionalIndices: [] });
    expect(cleared.enabledOptionalIndices).toEqual([]);
    expect(new MonitorSettingsStore(db).load().enabledOptionalIndices).toEqual([]);
  });

  it('allows disabling individual or all core indices and preserves legacy configs without enabledCoreIndices', () => {
    const db = createMemoryDb();
    // 模拟旧版数据库里不含 enabledCoreIndices 字段的 monitor.config
    db.setSetting('monitor.config', {
      pollingIntervalSec: 5,
      enabledOptionalIndices: ['000688.SH'],
    });

    const store = new MonitorSettingsStore(db);
    const loadedLegacy = store.load();
    expect(loadedLegacy.enabledCoreIndices).toEqual([
      '000001.SH',
      '399001.SZ',
      '399006.SZ',
      '000680.SH',
    ]);
    expect(loadedLegacy.enabledOptionalIndices).toEqual(['000688.SH']);

    // 关闭部分主要指数（乱序与非法代码应自动清洗）
    const partial = store.update({
      enabledCoreIndices: [
        '000680.SH',
        '000001.SH',
        '000688.SH',
      ] as unknown as MonitorConfig['enabledCoreIndices'],
    });
    expect(partial.enabledCoreIndices).toEqual(['000001.SH', '000680.SH']);
    expect(new MonitorSettingsStore(db).load().enabledCoreIndices).toEqual([
      '000001.SH',
      '000680.SH',
    ]);

    // 允许全部 4 个主要指数均设为不展示（空数组 []）
    const allHidden = store.update({ enabledCoreIndices: [] });
    expect(allHidden.enabledCoreIndices).toEqual([]);
    expect(new MonitorSettingsStore(db).load().enabledCoreIndices).toEqual([]);
  });
});
