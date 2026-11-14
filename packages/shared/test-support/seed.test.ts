import * as fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_VARIABLE, parseSeed, replayCommand, resolveSeed } from './seed';

type SeedModule = typeof import('./seed');

/** Loads a fresh copy of the helper, because getTestSeed memoizes per module instance. */
async function loadSeedModule(seedValue: string): Promise<SeedModule> {
  vi.resetModules();
  vi.stubEnv(SEED_VARIABLE, seedValue);
  return await import('./seed');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveSeed', () => {
  it('uses the injected generator when the variable is unset', () => {
    const generate = vi.fn(() => 123);
    expect(resolveSeed({}, generate)).toBe(123);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('uses the injected generator when the variable is undefined', () => {
    const generate = vi.fn(() => -5);
    expect(resolveSeed({ [SEED_VARIABLE]: undefined }, generate)).toBe(-5);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('uses the injected generator when the variable is an empty string', () => {
    const generate = vi.fn(() => 456);
    expect(resolveSeed({ [SEED_VARIABLE]: '' }, generate)).toBe(456);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('returns a valid explicit value without calling the generator', () => {
    const generate = vi.fn(() => 1);
    expect(resolveSeed({ [SEED_VARIABLE]: '42' }, generate)).toBe(42);
    expect(resolveSeed({ [SEED_VARIABLE]: '-2147483648' }, generate)).toBe(-2147483648);
    expect(resolveSeed({ [SEED_VARIABLE]: '2147483647' }, generate)).toBe(2147483647);
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['1.5', '0x10', ' 7', '2147483648'])(
    'throws naming the variable and the raw value for %j',
    (raw) => {
      const generate = vi.fn(() => 1);
      let message = '';
      try {
        resolveSeed({ [SEED_VARIABLE]: raw }, generate);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(SEED_VARIABLE);
      expect(message).toContain(`"${raw}"`);
      expect(generate).not.toHaveBeenCalled();
    },
  );
});

describe('parseSeed', () => {
  it('reports failure for the invalid examples', () => {
    for (const raw of ['1.5', '0x10', ' 7', '2147483648']) {
      expect(parseSeed(raw).ok).toBe(false);
    }
  });
});

describe('same seed gives the same inputs', () => {
  async function sampleInputs(seedValue: string): Promise<readonly number[]> {
    const helper = await loadSeedModule(seedValue);
    const seen: number[] = [];
    helper.assertProperty(
      fc.property(fc.integer(), (n) => {
        seen.push(n);
        return true;
      }),
      { numRuns: 25 },
    );
    return seen;
  }

  it('generates an identical input sequence for the same seed supplied twice', async () => {
    const first = await sampleInputs('987654');
    const second = await sampleInputs('987654');
    expect(first).toHaveLength(25);
    expect(second).toEqual(first);
  });

  it('generates a different input sequence for a different seed', async () => {
    const first = await sampleInputs('987654');
    const other = await sampleInputs('987655');
    expect(other).not.toEqual(first);
  });

  it('passes the seed from the variable to fast-check and ignores a seed override', async () => {
    const helper = await loadSeedModule('777');
    expect(helper.propertyParams().seed).toBe(777);
    expect(helper.propertyParams({ seed: 1 }).seed).toBe(777);
  });
});

describe('assertProperty failure output', () => {
  it('prints the seed and the replay command, then rethrows', async () => {
    const helper = await loadSeedModule('31337');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => {
      helper.assertProperty(fc.property(fc.integer(), () => false));
    }).toThrow();

    const printed = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(printed).toContain('31337');
    expect(printed).toContain(replayCommand(31337));
    expect(replayCommand(31337)).toBe(
      `${SEED_VARIABLE}=31337 pnpm --filter @hypergeist/shared test`,
    );
  });

  it('prints nothing when the property holds', async () => {
    const helper = await loadSeedModule('31337');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    helper.assertProperty(fc.property(fc.integer(), () => true));

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
