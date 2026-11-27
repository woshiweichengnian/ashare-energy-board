import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HITHINK_API_KEY_ENV } from '../../shared/constants';
import type { SecretSource, SecretStatus } from '../../shared/types';

/** Electron safeStorage 的最小抽象接口，便于单测注入 */
export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretStoreOptions {
  /** 软件内加密凭据文件的绝对路径（通常在 userData 下） */
  encryptedFilePath: string;
  /** Electron safeStorage 实例或测试桩 */
  safeStorage?: SafeStorageAdapter;
  /** 环境变量源，默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** 目标操作系统，默认 process.platform（便于跨平台单测） */
  platform?: NodeJS.Platform;
  /** 用户主目录，默认 os.homedir()（便于跨平台单测） */
  homeDir?: string;
  /** 用户级 credentials.env 路径，默认按平台自动解析 */
  credentialsEnvPath?: string;
}

/**
 * 按平台解析同花顺统一用户级 credentials.env 默认路径：
 * - Windows: %APPDATA%\hithink-finance\credentials.env
 * - macOS:   ~/Library/Application Support/hithink-finance/credentials.env
 * - Linux:   ${XDG_CONFIG_HOME:-~/.config}/hithink-finance/credentials.env
 */
export function resolveDefaultCredentialsEnvPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir?: string
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim();
    return appData ? path.join(appData, 'hithink-finance', 'credentials.env') : '';
  }

  const resolvedHome = (homeDir ?? env.HOME ?? os.homedir()).trim();
  if (platform === 'darwin') {
    return resolvedHome
      ? path.join(resolvedHome, 'Library', 'Application Support', 'hithink-finance', 'credentials.env')
      : '';
  }

  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfig) {
    return path.join(xdgConfig, 'hithink-finance', 'credentials.env');
  }
  return resolvedHome ? path.join(resolvedHome, '.config', 'hithink-finance', 'credentials.env') : '';
}

interface ResolvedSecret {
  value: string | null;
  source: SecretSource;
}

/**
 * 解析 credentials.env 中的 HITHINK_FINANCE_API_KEY。
 * 支持可选的 export 前缀、注释行以及单/双引号包裹值。
 */
export function parseCredentialsEnv(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?HITHINK_FINANCE_API_KEY\s*=\s*(.+)$/);
    if (!match) continue;
    const rawVal = match[1].trim();
    let val = rawVal;
    if (rawVal.startsWith('"') || rawVal.startsWith("'")) {
      const quote = rawVal[0];
      const closingIdx = rawVal.indexOf(quote, 1);
      if (closingIdx >= 1) {
        const trailing = rawVal.slice(closingIdx + 1).trim();
        if (trailing === '' || trailing.startsWith('#')) {
          val = rawVal.slice(1, closingIdx).trim();
        }
      }
    } else {
      // 去掉未加引号时的行尾注释（如 KEY=xxx # comment）
      const commentIdx = rawVal.indexOf(' #');
      if (commentIdx >= 0) {
        val = rawVal.slice(0, commentIdx).trim();
      }
    }
    if (val) return val;
  }
  return null;
}

/**
 * 同花顺 API Key 安全凭据管理器。
 *
 * 解析优先级（严格对齐 docs/PLAN.md 与 AGENTS.md）：
 * 1. Electron safeStorage 本地加密存储
 * 2. 环境变量 HITHINK_FINANCE_API_KEY
 * 3. 用户级凭据文件 %APPDATA%\hithink-finance\credentials.env
 *
 * 安全卫生：
 * - 状态查询 getStatus() 仅返回 { configured, source, encryptionAvailable }，永不返回明文或片段。
 * - 错误消息与异常堆栈绝不拼接密钥明文。
 */
export class SecretStore {
  private readonly encryptedFilePath: string;
  private readonly safeStorage?: SafeStorageAdapter;
  private readonly env: NodeJS.ProcessEnv;
  private readonly credentialsEnvPath: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: SecretStoreOptions) {
    this.encryptedFilePath = options.encryptedFilePath;
    this.safeStorage = options.safeStorage;
    this.env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    this.platform = platform;
    this.credentialsEnvPath =
      options.credentialsEnvPath ??
      resolveDefaultCredentialsEnvPath(platform, this.env, options.homeDir);
  }

  private isEncryptionAvailable(): boolean {
    try {
      return Boolean(this.safeStorage?.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  private readFromSafeStorage(): string | null {
    // 本机定制：先看密钥文件在不在，再碰系统钥匙串。没存过同花顺密钥时完全不访问钥匙串，
    // 否则每次本机重新打包（签名变了）启动都会被 macOS 的钥匙串授权弹窗卡住主线程。
    if (!fs.existsSync(this.encryptedFilePath)) {
      return null;
    }
    if (!this.safeStorage || !this.isEncryptionAvailable()) {
      return null;
    }
    try {
      const encrypted = fs.readFileSync(this.encryptedFilePath);
      if (encrypted.length === 0) return null;
      const decrypted = this.safeStorage.decryptString(encrypted).trim();
      return decrypted || null;
    } catch {
      // 解密失败时静默降级至后续来源，且绝不泄露原始凭据内容
      return null;
    }
  }

  private readFromEnv(): string | null {
    const raw = this.env[HITHINK_API_KEY_ENV];
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed || null;
  }

  private readFromCredentialsFile(): string | null {
    if (!this.credentialsEnvPath || !fs.existsSync(this.credentialsEnvPath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(this.credentialsEnvPath, 'utf8');
      return parseCredentialsEnv(content);
    } catch {
      return null;
    }
  }

  private resolve(): ResolvedSecret {
    const fromSafe = this.readFromSafeStorage();
    if (fromSafe) {
      return { value: fromSafe, source: 'safeStorage' };
    }

    const fromEnv = this.readFromEnv();
    if (fromEnv) {
      return { value: fromEnv, source: 'env' };
    }

    const fromFile = this.readFromCredentialsFile();
    if (fromFile) {
      return { value: fromFile, source: 'credentialsFile' };
    }

    return { value: null, source: 'none' };
  }

  /**
   * 获取当前生效的 API Key 明文（仅供主进程内部发请求使用，严禁经 IPC 返回渲染进程或打印日志）。
   */
  getApiKey(): string | null {
    return this.resolve().value;
  }

  /**
   * 获取脱敏配置状态（可安全通过 IPC 返回给渲染进程）。
   */
  getStatus(): SecretStatus {
    const { value, source } = this.resolve();
    return {
      configured: value !== null,
      source,
      // 本机定制：没存过密钥文件时不为了回答"能不能加密"去碰钥匙串（macOS 上始终可用），
      // 真正保存密钥时 saveApiKey 仍会做实际检查。
      encryptionAvailable:
        this.platform === 'darwin' && this.safeStorage && !fs.existsSync(this.encryptedFilePath)
          ? true
          : this.isEncryptionAvailable(),
    };
  }

  /**
   * 将用户输入的同花顺 API Key 经 safeStorage 加密写入本地文件。
   */
  setStoredApiKey(plainKey: string): void {
    const trimmed = plainKey.trim();
    if (!trimmed) {
      throw new Error('API Key cannot be empty; use clearStoredApiKey() to remove it.');
    }
    if (!this.safeStorage || !this.isEncryptionAvailable()) {
      throw new Error('OS safeStorage encryption is not available.');
    }
    const encrypted = this.safeStorage.encryptString(trimmed);
    fs.mkdirSync(path.dirname(this.encryptedFilePath), { recursive: true });
    fs.writeFileSync(this.encryptedFilePath, encrypted, { mode: 0o600 });
  }

  /**
   * 清除软件内加密存储的 API Key。清除后将自动按优先级回落至环境变量或 credentials.env。
   */
  clearStoredApiKey(): void {
    if (fs.existsSync(this.encryptedFilePath)) {
      fs.unlinkSync(this.encryptedFilePath);
    }
  }
}
