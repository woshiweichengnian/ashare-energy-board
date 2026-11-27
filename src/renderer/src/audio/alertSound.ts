import type { AlertDirection } from '../../../shared/types';

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioCtx();
  }
  return sharedAudioContext;
}

interface ToneStep {
  frequency: number;
  startOffsetSec: number;
  durationSec: number;
  type: OscillatorType;
  peakGain: number;
}

/**
 * 急放 vs 急缩区分音色设计：
 * - SURGE（急放）：上行明快三连脉冲（D5 → A5 → D6），快速上升感
 * - SHRINK（急缩）：下行沉稳双音（A4 → D4），低沉收敛感
 */
export const ALERT_TONE_PATTERNS: Record<AlertDirection, readonly ToneStep[]> = {
  SURGE: [
    { frequency: 587.33, startOffsetSec: 0, durationSec: 0.085, type: 'triangle', peakGain: 0.16 },
    { frequency: 880.0, startOffsetSec: 0.095, durationSec: 0.085, type: 'triangle', peakGain: 0.18 },
    { frequency: 1174.66, startOffsetSec: 0.19, durationSec: 0.14, type: 'sine', peakGain: 0.2 },
  ],
  SHRINK: [
    { frequency: 440.0, startOffsetSec: 0, durationSec: 0.12, type: 'sine', peakGain: 0.16 },
    { frequency: 293.66, startOffsetSec: 0.14, durationSec: 0.19, type: 'sine', peakGain: 0.18 },
  ],
};

const RESUME_TIMEOUT_MS = 500;

async function resumeWithTimeout(ctx: AudioContext): Promise<boolean> {
  if (ctx.state !== 'suspended') return true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const outcome = await Promise.race([
      ctx.resume().then(() => 'resumed' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), RESUME_TIMEOUT_MS);
      }),
    ]);
    return outcome === 'resumed';
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/** 仅供单元测试重置全局 AudioContext 单例 */
export function resetAudioContextForTest(): void {
  sharedAudioContext = null;
}

/** 播放区分急放 / 急缩的短提示音；静音态不发声 */
export async function playAlertSound(direction: AlertDirection, muted: boolean): Promise<boolean> {
  if (muted) return false;
  const ctx = getAudioContext();
  if (!ctx) return false;

  try {
    const ready = await resumeWithTimeout(ctx);
    if (!ready) return false;

    const baseTime = ctx.currentTime + 0.01;
    const steps = ALERT_TONE_PATTERNS[direction];

    for (const step of steps) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = step.type;
      osc.frequency.setValueAtTime(step.frequency, baseTime + step.startOffsetSec);

      const t0 = baseTime + step.startOffsetSec;
      const tAttack = t0 + 0.012;
      const tEnd = t0 + step.durationSec;

      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(step.peakGain, tAttack);
      gain.gain.exponentialRampToValueAtTime(0.0001, tEnd);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(t0);
      osc.stop(tEnd + 0.02);
    }
    return true;
  } catch {
    // 无音频设备或策略拦截时静默降级，不影响其他告警通道
    return false;
  }
}
