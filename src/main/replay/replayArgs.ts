import { DEFAULT_REPLAY_STEP_MS } from '../../shared/constants';

export interface ReplayCliOptions {
  enabled: true;
  /** 指定回放交易日 YYYY-MM-DD；为 null 时自动选择本地 SQLite 最新已录制交易日 */
  tradeDate: string | null;
  /** 每帧推进间隔（毫秒），默认 120ms */
  stepIntervalMs: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 解析开发态全天回放启动参数：
 * - `--replay`（自动选择本地最近已录制交易日）
 * - `--replay 2026-11-24` 或 `--replay=2026-11-24`
 * - `--replay-step-ms=50` 或 `--replay-step-ms 50`
 */
export function parseReplayArgs(argv: readonly string[]): ReplayCliOptions | null {
  let enabled = false;
  let tradeDate: string | null = null;
  let stepIntervalMs = DEFAULT_REPLAY_STEP_MS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--replay') {
      enabled = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        if (!DATE_PATTERN.test(next)) {
          throw new Error(`无效的回放交易日格式（应为 YYYY-MM-DD）：${next}`);
        }
        tradeDate = next;
        i += 1;
      }
    } else if (arg.startsWith('--replay=')) {
      enabled = true;
      const val = arg.slice('--replay='.length).trim();
      if (val) {
        if (!DATE_PATTERN.test(val)) {
          throw new Error(`无效的回放交易日格式（应为 YYYY-MM-DD）：${val}`);
        }
        tradeDate = val;
      }
    } else if (arg === '--replay-step-ms') {
      const next = argv[i + 1];
      if (next !== undefined) {
        const parsed = Number(next);
        if (Number.isFinite(parsed) && parsed >= 0) {
          stepIntervalMs = Math.min(5000, Math.round(parsed));
        }
        i += 1;
      }
    } else if (arg.startsWith('--replay-step-ms=')) {
      const parsed = Number(arg.slice('--replay-step-ms='.length));
      if (Number.isFinite(parsed) && parsed >= 0) {
        stepIntervalMs = Math.min(5000, Math.round(parsed));
      }
    }
  }

  if (!enabled) return null;
  return {
    enabled: true,
    tradeDate,
    stepIntervalMs,
  };
}
