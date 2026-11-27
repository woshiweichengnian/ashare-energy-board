import { globalShortcut } from 'electron';
import type { BossKeyStatus } from '../../shared/types';

export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export interface BossKeyManagerOptions {
  shortcutApi?: GlobalShortcutApi;
  onTrigger: () => void;
  onConflict?: (status: BossKeyStatus) => void;
}

export interface NormalizedAcceleratorResult {
  valid: boolean;
  normalized: string;
  canonicalKey: string;
  reason: string | null;
}

const MODIFIER_MAP: Readonly<Record<string, { display: string; canonical: string }>> = {
  ctrl: { display: 'Ctrl', canonical: 'ctrl' },
  control: { display: 'Control', canonical: 'ctrl' },
  alt: { display: 'Alt', canonical: 'alt' },
  option: { display: 'Alt', canonical: 'alt' },
  altgr: { display: 'AltGr', canonical: 'altgr' },
  shift: { display: 'Shift', canonical: 'shift' },
  super: { display: 'Super', canonical: 'super' },
  meta: { display: 'Meta', canonical: 'super' },
  cmd: { display: 'Command', canonical: 'super' },
  command: { display: 'Command', canonical: 'super' },
  cmdorctrl: { display: 'CmdOrCtrl', canonical: 'cmdorctrl' },
  commandorcontrol: { display: 'CommandOrControl', canonical: 'cmdorctrl' },
};

const FUNCTION_KEY_REGEX = /^F([1-9]|1[0-9]|2[0-4])$/i;

/**
 * 规范化并校验 Electron globalShortcut 快捷键：
 * - 去除 `+` 两侧多余空白，统一修饰键大小写
 * - 生成大小写与修饰键顺序无关的 canonicalKey，避免 Windows 下同键变体（如 alt+shift+a）自冲突
 * - 强制包含至少一个修饰键或使用 F1–F24 功能键，防止裸单键（如 A）劫持全系统键盘输入
 */
export function normalizeAccelerator(raw: string): NormalizedAcceleratorResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      valid: false,
      normalized: '',
      canonicalKey: '',
      reason: '老板键不能为空，请输入有效组合键（例如 Alt+Shift+A）。',
    };
  }

  const rawTokens = trimmed.split('+');
  if (rawTokens.some((token) => token.trim().length === 0)) {
    return {
      valid: false,
      normalized: trimmed,
      canonicalKey: '',
      reason: `老板键 "${trimmed}" 格式无效，请使用如 Alt+Shift+A 的组合键格式。`,
    };
  }

  const modifiers: Array<{ display: string; canonical: string }> = [];
  const seenModifierCanonical = new Set<string>();
  const mainKeys: string[] = [];

  for (const token of rawTokens) {
    const cleaned = token.trim();
    const mod = MODIFIER_MAP[cleaned.toLowerCase()];
    if (mod) {
      if (!seenModifierCanonical.has(mod.canonical)) {
        seenModifierCanonical.add(mod.canonical);
        modifiers.push(mod);
      }
    } else {
      mainKeys.push(cleaned);
    }
  }

  if (mainKeys.length !== 1) {
    return {
      valid: false,
      normalized: trimmed,
      canonicalKey: '',
      reason: `老板键 "${trimmed}" 必须包含且仅包含一个主键（例如 Alt+Shift+A）。`,
    };
  }

  const rawKey = mainKeys[0];
  const displayKey =
    rawKey.length === 1
      ? rawKey.toUpperCase()
      : FUNCTION_KEY_REGEX.test(rawKey)
        ? rawKey.toUpperCase()
        : rawKey;

  if (modifiers.length === 0 && !FUNCTION_KEY_REGEX.test(displayKey)) {
    return {
      valid: false,
      normalized: trimmed,
      canonicalKey: '',
      reason: `为避免拦截正常键盘输入，老板键 "${trimmed}" 必须包含修饰键（如 Alt+Shift+A）或使用 F1–F24 功能键。`,
    };
  }

  const normalized = [...modifiers.map((m) => m.display), displayKey].join('+');
  const sortedModKeys = [...seenModifierCanonical].sort();
  const canonicalKey = [...sortedModKeys, displayKey.toLowerCase()].join('+');

  return {
    valid: true,
    normalized,
    canonicalKey,
    reason: null,
  };
}

const defaultShortcutApi: GlobalShortcutApi = {
  register: (acc, cb) => globalShortcut.register(acc, cb),
  unregister: (acc) => globalShortcut.unregister(acc),
  isRegistered: (acc) => globalShortcut.isRegistered(acc),
};

/**
 * 全局老板键管理器：
 * - 支持启动注册与运行时改绑
 * - 校验组合键安全性（禁止裸单键）并做等价归一化避免大小写/空格自冲突
 * - 注册失败（被其他程序占用或格式非法）时给出明确冲突提示，并保留原快捷键不丢失
 */
export class BossKeyManager {
  private readonly api: GlobalShortcutApi;
  private readonly onTrigger: () => void;
  private readonly onConflict?: (status: BossKeyStatus) => void;

  private activeAccelerator: string | null = null;
  private activeCanonicalKey: string | null = null;
  private status: BossKeyStatus = {
    accelerator: '',
    registered: false,
    conflictMessage: null,
  };

  constructor(options: BossKeyManagerOptions) {
    this.api = options.shortcutApi ?? defaultShortcutApi;
    this.onTrigger = options.onTrigger;
    this.onConflict = options.onConflict;
  }

  getStatus(): BossKeyStatus {
    return { ...this.status };
  }

  registerInitial(accelerator: string): BossKeyStatus {
    const parsed = normalizeAccelerator(accelerator);
    if (!parsed.valid) {
      this.activeAccelerator = null;
      this.activeCanonicalKey = null;
      this.status = {
        accelerator: parsed.normalized,
        registered: false,
        conflictMessage: parsed.reason,
      };
      this.onConflict?.(this.getStatus());
      return this.getStatus();
    }

    let ok = false;
    try {
      ok = this.api.register(parsed.normalized, this.onTrigger);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.activeAccelerator = null;
      this.activeCanonicalKey = null;
      this.status = {
        accelerator: parsed.normalized,
        registered: false,
        conflictMessage: `老板键 "${parsed.normalized}" 格式无效或注册异常：${reason}`,
      };
      this.onConflict?.(this.getStatus());
      return this.getStatus();
    }

    if (ok) {
      this.activeAccelerator = parsed.normalized;
      this.activeCanonicalKey = parsed.canonicalKey;
      this.status = {
        accelerator: parsed.normalized,
        registered: true,
        conflictMessage: null,
      };
    } else {
      this.activeAccelerator = null;
      this.activeCanonicalKey = null;
      this.status = {
        accelerator: parsed.normalized,
        registered: false,
        conflictMessage: `老板键 "${parsed.normalized}" 已被其他应用占用，请更换组合键。`,
      };
      this.onConflict?.(this.getStatus());
    }

    return this.getStatus();
  }

  /**
   * 运行时改绑老板键：
   * - 与当前生效快捷键等价（忽略大小写/空格/修饰键顺序）：直接确认成功并清除旧冲突提示，不触发自冲突
   * - 新快捷键注册成功：解绑旧快捷键并切换
   * - 新快捷键非法或被占用：保留旧快捷键并反馈冲突原因
   */
  rebind(newAccelerator: string): {
    success: boolean;
    committedAccelerator: string | null;
    status: BossKeyStatus;
  } {
    const parsed = normalizeAccelerator(newAccelerator);
    if (!parsed.valid) {
      this.status = {
        accelerator: this.activeAccelerator ?? this.status.accelerator,
        registered: this.activeAccelerator !== null,
        conflictMessage: parsed.reason,
      };
      this.onConflict?.(this.getStatus());
      return {
        success: false,
        committedAccelerator: this.activeAccelerator,
        status: this.getStatus(),
      };
    }

    if (
      this.activeAccelerator !== null &&
      this.activeCanonicalKey === parsed.canonicalKey &&
      this.status.registered
    ) {
      this.status = {
        accelerator: this.activeAccelerator,
        registered: true,
        conflictMessage: null,
      };
      return {
        success: true,
        committedAccelerator: this.activeAccelerator,
        status: this.getStatus(),
      };
    }

    let ok = false;
    let errorDetail: string | null = null;
    try {
      ok = this.api.register(parsed.normalized, this.onTrigger);
    } catch (err: unknown) {
      errorDetail = err instanceof Error ? err.message : String(err);
      ok = false;
    }

    if (!ok) {
      const message = errorDetail
        ? `老板键 "${parsed.normalized}" 格式无效或注册失败：${errorDetail}`
        : `老板键 "${parsed.normalized}" 已被其他应用占用，已保留原快捷键${this.activeAccelerator ? ` "${this.activeAccelerator}"` : ''}。`;
      this.status = {
        accelerator: this.activeAccelerator ?? parsed.normalized,
        registered: this.activeAccelerator !== null,
        conflictMessage: message,
      };
      this.onConflict?.(this.getStatus());
      return {
        success: false,
        committedAccelerator: this.activeAccelerator,
        status: this.getStatus(),
      };
    }

    if (this.activeAccelerator && this.activeAccelerator !== parsed.normalized) {
      try {
        this.api.unregister(this.activeAccelerator);
      } catch {
        // 忽略旧键解绑异常
      }
    }

    this.activeAccelerator = parsed.normalized;
    this.activeCanonicalKey = parsed.canonicalKey;
    this.status = {
      accelerator: parsed.normalized,
      registered: true,
      conflictMessage: null,
    };
    return {
      success: true,
      committedAccelerator: parsed.normalized,
      status: this.getStatus(),
    };
  }

  unregister(): void {
    if (this.activeAccelerator) {
      try {
        this.api.unregister(this.activeAccelerator);
      } catch {
        // 忽略退出时清理异常
      }
      this.activeAccelerator = null;
      this.activeCanonicalKey = null;
    }
    this.status = {
      ...this.status,
      registered: false,
    };
  }
}
