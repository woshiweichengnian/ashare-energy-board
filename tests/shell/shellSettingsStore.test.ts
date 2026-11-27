import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../src/main/storage/database';
import { ShellSettingsStore } from '../../src/main/windows/shellSettingsStore';

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

describe('ShellSettingsStore', () => {
  it('loads sensible defaults when app_settings is empty', () => {
    const db = createMemoryDb();
    const store = new ShellSettingsStore(db);

    expect(store.load()).toEqual({
      hudPosition: null,
      hudOpacity: 0.9,
      alwaysOnTop: true,
      muted: false,
      bossKey: 'Alt+Shift+A',
      autoLaunch: false,
      hudMode: 'standard',
    });
  });

  it('persists HUD position, clamped opacity, alwaysOnTop, muted, bossKey, autoLaunch, and hudMode', () => {
    const db = createMemoryDb();
    const store = new ShellSettingsStore(db);

    expect(store.setHudPosition({ x: 1200.4, y: 48.6 })).toEqual({ x: 1200, y: 49 });
    expect(store.setHudOpacity(0.15)).toBe(0.3);
    expect(store.setAlwaysOnTop(false)).toBe(false);
    expect(store.setMuted(true)).toBe(true);
    expect(store.setBossKey('  Ctrl+Shift+M  ')).toBe('Ctrl+Shift+M');
    expect(store.setAutoLaunch(true)).toBe(true);
    expect(store.setHudMode('minimal')).toBe('minimal');

    // 模拟重启后从同一 SQLite 重新读取
    const reloaded = new ShellSettingsStore(db).load();
    expect(reloaded).toEqual({
      hudPosition: { x: 1200, y: 49 },
      hudOpacity: 0.3,
      alwaysOnTop: false,
      muted: true,
      bossKey: 'Ctrl+Shift+M',
      autoLaunch: true,
      hudMode: 'minimal',
    });

    // 非法值和切回标准模式均正常落盘并回退默认值
    expect(store.setHudMode('unknown' as unknown as 'standard')).toBe('standard');
    expect(new ShellSettingsStore(db).load().hudMode).toBe('standard');
  });
});
