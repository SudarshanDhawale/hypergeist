export type SoundName = 'click' | 'mode' | 'open' | 'close' | 'speak' | 'done';

export type SoundNote = { readonly freq: number; readonly ms: number };

/** Short square-wave blips: each name maps to a list of notes played in order. */
export const SOUND_TABLE: Readonly<Record<SoundName, readonly SoundNote[]>> = {
  click: [{ freq: 880, ms: 30 }],
  mode: [
    { freq: 440, ms: 50 },
    { freq: 660, ms: 50 },
  ],
  open: [
    { freq: 392, ms: 50 },
    { freq: 523, ms: 50 },
    { freq: 784, ms: 70 },
  ],
  close: [
    { freq: 784, ms: 50 },
    { freq: 523, ms: 50 },
    { freq: 392, ms: 70 },
  ],
  speak: [
    { freq: 600, ms: 40 },
    { freq: 720, ms: 40 },
    { freq: 540, ms: 60 },
  ],
  done: [
    { freq: 523, ms: 70 },
    { freq: 659, ms: 70 },
    { freq: 784, ms: 70 },
    { freq: 1047, ms: 120 },
  ],
};

export const SOUND_STORAGE_KEY = 'hypergeist.sound.enabled';
export const SOUND_WAVE = 'square';
export const SOUND_VOLUME = 0.08;

export type OscillatorLike = {
  type: string;
  frequency: { value: number };
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
};

export type GainLike = {
  gain: { value: number };
  connect(destination: unknown): unknown;
};

export type AudioContextLike = {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly state?: string;
  resume?(): unknown;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
};

export type AudioContextFactory = () => AudioContextLike;

export type SoundStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type SoundOptions = {
  /** Pass `null` to simulate an environment without an AudioContext. */
  audioContextFactory?: AudioContextFactory | null;
  /** Pass `null` for no storage. Defaults to `localStorage` when reachable. */
  storage?: SoundStorage | null;
};

export type Sound = {
  play(name: SoundName): void;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  isSupported(): boolean;
  notifyUserGesture(): void;
};

type AudioContextConstructor = new () => AudioContextLike;

function findConstructor(): AudioContextConstructor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function defaultFactory(): AudioContextFactory | null {
  const Ctor = findConstructor();
  return Ctor === null ? null : () => new Ctor();
}

function defaultStorage(): SoundStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createSound(options: SoundOptions = {}): Sound {
  const factory =
    options.audioContextFactory === undefined ? defaultFactory() : options.audioContextFactory;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;

  let enabled = true;
  try {
    const stored = storage?.getItem(SOUND_STORAGE_KEY);
    if (stored === '0') enabled = false;
    else if (stored === '1') enabled = true;
  } catch {
    enabled = true;
  }

  let gestured = false;
  let context: AudioContextLike | null = null;
  let failed = false;

  const getContext = (): AudioContextLike | null => {
    if (context !== null) return context;
    if (factory === null || failed) return null;
    try {
      context = factory();
    } catch {
      failed = true;
      context = null;
    }
    return context;
  };

  const resumeIfNeeded = (ctx: AudioContextLike): void => {
    try {
      if (ctx.state === 'suspended') void ctx.resume?.();
    } catch {
      // Resuming is best effort; sound is never essential.
    }
  };

  return {
    notifyUserGesture() {
      gestured = true;
      if (context !== null) resumeIfNeeded(context);
    },
    play(name) {
      if (!gestured || !enabled) return;
      const ctx = getContext();
      if (ctx === null) return;
      try {
        resumeIfNeeded(ctx);
        let t = ctx.currentTime;
        for (const note of SOUND_TABLE[name]) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = SOUND_WAVE;
          osc.frequency.value = note.freq;
          gain.gain.value = SOUND_VOLUME;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          t += note.ms / 1000;
          osc.stop(t);
        }
      } catch {
        // A failing audio backend must never break the UI.
      }
    },
    setEnabled(next) {
      enabled = next;
      try {
        storage?.setItem(SOUND_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Keep the value in memory for this session.
      }
    },
    isEnabled() {
      return enabled;
    },
    isSupported() {
      return factory !== null;
    },
  };
}
