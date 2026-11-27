import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_TONE_PATTERNS,
  playAlertSound,
  resetAudioContextForTest,
} from '../../src/renderer/src/audio/alertSound';

interface FakeOscillator {
  type: OscillatorType;
  frequencies: number[];
  startedAt: number[];
  stoppedAt: number[];
  frequency: { setValueAtTime: (value: number, time: number) => void };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function installFakeAudioContext(
  initialState: AudioContextState = 'running',
  resumeImpl?: () => Promise<void>
) {
  const oscillators: FakeOscillator[] = [];
  const resumeSpy = vi.fn(resumeImpl ?? (async () => {}));

  class FakeAudioContext {
    state: AudioContextState = initialState;
    currentTime = 1.0;
    destination = {};
    resume = async () => {
      await resumeSpy();
      this.state = 'running';
    };
    createOscillator = () => {
      const osc: FakeOscillator = {
        type: 'sine',
        frequencies: [],
        startedAt: [],
        stoppedAt: [],
        frequency: {
          setValueAtTime: (val: number) => {
            osc.frequencies.push(val);
          },
        },
        connect: vi.fn(),
        start: vi.fn((t: number) => osc.startedAt.push(t)),
        stop: vi.fn((t: number) => osc.stoppedAt.push(t)),
      };
      oscillators.push(osc);
      return osc as unknown as OscillatorNode;
    };
    createGain = () =>
      ({
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      }) as unknown as GainNode;
  }

  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  return { oscillators, resumeSpy };
}

afterEach(() => {
  resetAudioContextForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('alertSound (Web Audio)', () => {
  it('short-circuits without creating oscillators when muted', async () => {
    const { oscillators } = installFakeAudioContext('running');
    const played = await playAlertSound('SURGE', true);
    expect(played).toBe(false);
    expect(oscillators).toHaveLength(0);
  });

  it('plays distinct ascending 3-pulse tone for SURGE and descending 2-pulse tone for SHRINK', async () => {
    const { oscillators, resumeSpy } = installFakeAudioContext('suspended');

    const surgeOk = await playAlertSound('SURGE', false);
    expect(surgeOk).toBe(true);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(oscillators).toHaveLength(ALERT_TONE_PATTERNS.SURGE.length);
    expect(oscillators.map((o) => o.frequencies[0])).toEqual([587.33, 880, 1174.66]);
    expect(oscillators.map((o) => o.type)).toEqual(['triangle', 'triangle', 'sine']);

    oscillators.length = 0;
    const shrinkOk = await playAlertSound('SHRINK', false);
    expect(shrinkOk).toBe(true);
    expect(oscillators).toHaveLength(ALERT_TONE_PATTERNS.SHRINK.length);
    expect(oscillators.map((o) => o.frequencies[0])).toEqual([440, 293.66]);
    expect(oscillators.map((o) => o.type)).toEqual(['sine', 'sine']);
  });

  it('degrades gracefully when AudioContext is unavailable or resume hangs', async () => {
    vi.stubGlobal('window', {});
    expect(await playAlertSound('SURGE', false)).toBe(false);

    vi.useFakeTimers();
    resetAudioContextForTest();
    installFakeAudioContext('suspended', () => new Promise<void>(() => {}));
    const pending = playAlertSound('SHRINK', false);
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toBe(false);
  });
});
