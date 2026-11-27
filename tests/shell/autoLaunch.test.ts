import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAutoLaunchSettings } from '../../src/main/windows/autoLaunch';

describe('resolveAutoLaunchSettings', () => {
  it('uses PORTABLE_EXECUTABLE_FILE for packaged Windows portable builds instead of ephemeral temp execPath', () => {
    const opts = resolveAutoLaunchSettings({
      platform: 'win32',
      isPackaged: true,
      enabled: true,
      execPath: 'C:\\Users\\demo\\AppData\\Local\\Temp\\2xF9a\\A股能量看板.exe',
      argv: ['C:\\Users\\demo\\AppData\\Local\\Temp\\2xF9a\\A股能量看板.exe'],
      cwd: 'C:\\Users\\demo\\AppData\\Local\\Temp\\2xF9a',
      portableExecutableFile: 'D:\\Tools\\A股能量看板-0.1.0-portable.exe',
    });

    expect(opts).toEqual({
      openAtLogin: true,
      path: 'D:\\Tools\\A股能量看板-0.1.0-portable.exe',
    });
  });

  it('uses default loginItem options for non-portable packaged builds and resolves entry arg in dev Windows builds', () => {
    expect(
      resolveAutoLaunchSettings({
        platform: 'win32',
        isPackaged: true,
        enabled: false,
        execPath: 'C:\\Program Files\\AShare\\A股能量看板.exe',
        argv: ['C:\\Program Files\\AShare\\A股能量看板.exe'],
        cwd: 'C:\\Program Files\\AShare',
        portableExecutableFile: undefined,
      })
    ).toEqual({ openAtLogin: false });

    const devOpts = resolveAutoLaunchSettings({
      platform: 'win32',
      isPackaged: false,
      enabled: true,
      execPath: 'D:\\node_modules\\electron\\electron.exe',
      argv: ['D:\\node_modules\\electron\\electron.exe', '.'],
      cwd: 'D:\\Workspace\\ashare-volpulse',
    });
    expect(devOpts).toEqual({
      openAtLogin: true,
      path: 'D:\\node_modules\\electron\\electron.exe',
      args: [path.resolve('.')],
    });
  });

  it('returns null on unsupported platforms such as Linux', () => {
    expect(
      resolveAutoLaunchSettings({
        platform: 'linux',
        isPackaged: true,
        enabled: true,
        execPath: '/usr/bin/app',
        argv: ['/usr/bin/app'],
        cwd: '/tmp',
      })
    ).toBeNull();
  });
});
