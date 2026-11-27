import path from 'node:path';

export interface ResolveAutoLaunchParams {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  enabled: boolean;
  execPath: string;
  argv: readonly string[];
  cwd: string;
  portableExecutableFile?: string | null;
}

export interface LoginItemOptions {
  openAtLogin: boolean;
  path?: string;
  args?: string[];
}

/**
 * 构造跨形态（Windows 便携版 / 已安装打包版 / 开发态）安全的开机自启参数：
 * - Windows 便携版（electron-builder portable）：process.execPath 指向退出即删的 %TEMP% 解压路径，
 *   必须使用 PORTABLE_EXECUTABLE_FILE 指向持久便携 .exe，否则重启后自启失效。
 * - 非 Windows/macOS 平台返回 null。
 */
export function resolveAutoLaunchSettings(
  params: ResolveAutoLaunchParams
): LoginItemOptions | null {
  if (params.platform !== 'win32' && params.platform !== 'darwin') {
    return null;
  }

  const openAtLogin = Boolean(params.enabled);
  if (params.isPackaged) {
    const portablePath = params.portableExecutableFile?.trim();
    if (params.platform === 'win32' && portablePath) {
      return {
        openAtLogin,
        path: portablePath,
      };
    }
    return { openAtLogin };
  }

  if (params.platform === 'win32') {
    const appArg = params.argv[1] ? path.resolve(params.argv[1]) : params.cwd;
    return {
      openAtLogin,
      path: params.execPath,
      args: [appArg],
    };
  }

  return { openAtLogin };
}
