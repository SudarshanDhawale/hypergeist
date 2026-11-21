import { describe, expect, it } from 'vitest';
import {
  SOUND_STORAGE_KEY,
  SOUND_TABLE,
  SOUND_WAVE,
  createSound,
  type AudioContextLike,
  type SoundName,
  type SoundStorage,
} from './sound.ts';

type FakeOsc = { type: string; freq: number; start: number; stop: number };

function fakeAudio() {
  const oscs: FakeOsc[] = [];
  let created = 0;
  const factory = (): AudioContextLike => {
    created += 1;
    return {
      currentTime: 1,
      destination: {},
      createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
      createOscillator: () => {
        const rec: FakeOsc = { type: '', freq: 0, start: -1, stop: -1 };
        oscs.push(rec);
        return {
          set type(v: string) {
            rec.type = v;
          },
          get type() {
            return rec.type;
          },
          frequency: {
            set value(v: number) {
              rec.freq = v;
            },
            get value() {
              return rec.freq;
            },
          },
          connect: () => undefined,
          start: (w?: number) => {
            rec.start = w ?? 0;
          },
          stop: (w?: number) => {
            rec.stop = w ?? 0;
          },
        };
      },
    };
  };
  return { factory, oscs, created: () => created };
}

function memoryStorage(): SoundStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const throwingStorage: SoundStorage = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
};

describe('createSound', () => {
  it('does nothing before a user gesture', () => {
    const a = fakeAudio();
    const s = createSound({ audioContextFactory: a.factory, storage: memoryStorage() });
    s.play('click');
    expect(a.created()).toBe(0);
    expect(a.oscs).toHaveLength(0);
  });

  it('creates oscillators with the table values after a gesture', () => {
    const a = fakeAudio();
    const s = createSound({ audioContextFactory: a.factory, storage: memoryStorage() });
    expect(a.created()).toBe(0);
    s.notifyUserGesture();
    expect(a.created()).toBe(0);
    const names: SoundName[] = ['click', 'mode', 'open', 'close', 'speak', 'done'];
    for (const name of names) {
      a.oscs.length = 0;
      s.play(name);
      const notes = SOUND_TABLE[name];
      expect(a.oscs).toHaveLength(notes.length);
      let t = 1;
      notes.forEach((note, i) => {
        expect(a.oscs[i]?.freq).toBe(note.freq);
        expect(a.oscs[i]?.type).toBe(SOUND_WAVE);
        expect(a.oscs[i]?.start).toBeCloseTo(t);
        t += note.ms / 1000;
        expect(a.oscs[i]?.stop).toBeCloseTo(t);
      });
    }
    expect(a.created()).toBe(1);
  });

  it('is enabled by default and does nothing when disabled', () => {
    const a = fakeAudio();
    const s = createSound({ audioContextFactory: a.factory, storage: memoryStorage() });
    expect(s.isEnabled()).toBe(true);
    s.notifyUserGesture();
    s.setEnabled(false);
    expect(s.isEnabled()).toBe(false);
    s.play('click');
    expect(a.oscs).toHaveLength(0);
    s.setEnabled(true);
    s.play('click');
    expect(a.oscs).toHaveLength(1);
  });

  it('persists the enabled flag across instances', () => {
    const storage = memoryStorage();
    const first = createSound({ audioContextFactory: fakeAudio().factory, storage });
    first.setEnabled(false);
    expect(storage.map.get(SOUND_STORAGE_KEY)).toBe('0');
    const second = createSound({ audioContextFactory: fakeAudio().factory, storage });
    expect(second.isEnabled()).toBe(false);
    second.setEnabled(true);
    const third = createSound({ audioContextFactory: fakeAudio().factory, storage });
    expect(third.isEnabled()).toBe(true);
  });

  it('keeps working in memory when storage throws', () => {
    const a = fakeAudio();
    const s = createSound({ audioContextFactory: a.factory, storage: throwingStorage });
    expect(s.isEnabled()).toBe(true);
    s.notifyUserGesture();
    s.setEnabled(false);
    expect(s.isEnabled()).toBe(false);
    s.play('click');
    expect(a.oscs).toHaveLength(0);
    s.setEnabled(true);
    s.play('click');
    expect(a.oscs).toHaveLength(1);
  });

  it('reports unsupported when there is no AudioContext', () => {
    const s = createSound({ audioContextFactory: null, storage: memoryStorage() });
    expect(s.isSupported()).toBe(false);
    s.notifyUserGesture();
    expect(() => s.play('click')).not.toThrow();
  });

  it('reports supported with a factory, and survives a factory that throws', () => {
    const ok = createSound({ audioContextFactory: fakeAudio().factory, storage: null });
    expect(ok.isSupported()).toBe(true);
    const bad = createSound({
      audioContextFactory: () => {
        throw new Error('no audio');
      },
      storage: null,
    });
    bad.notifyUserGesture();
    expect(() => bad.play('click')).not.toThrow();
  });
});
