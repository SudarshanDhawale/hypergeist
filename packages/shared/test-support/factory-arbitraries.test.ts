import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ENTITY_ID_PATTERN, LIMITS } from '../src/format/index.ts';
import {
  CREATE_STACK_PARAM_ORDER,
  arbCorruptedCreateStackParams,
  arbCreateStackParams,
} from './factory-arbitraries.ts';
import type {
  CorruptedCreateStackParams,
  CreateStackErrorCode,
  CreateStackParamKey,
  ExpectedCreateStackError,
} from './factory-arbitraries.ts';

/** The coverage tests use a fixed seed, so a failure is the same on every run. */
const COVERAGE_SEED = 20_261_115;
const SAMPLE_SIZE = 200;

function sample<T>(arbitrary: fc.Arbitrary<T>, numRuns = SAMPLE_SIZE): T[] {
  return fc.sample(arbitrary, { numRuns, seed: COVERAGE_SEED });
}

function codePoints(text: string): number {
  return [...text].length;
}

/**
 * An oracle for one parameter, written from the requirements (8.9 to 8.13) and the format
 * limits and not from `createStack`. `undefined` means the value is valid.
 */
function classify(
  key: CreateStackParamKey,
  params: Record<string, unknown>,
): CreateStackErrorCode | undefined {
  if (!Object.hasOwn(params, key)) {
    return key === 'id' || key === 'name' ? 'MISSING_PROPERTY' : undefined;
  }
  const value = params[key];
  switch (key) {
    case 'id':
    case 'firstCardId':
      return typeof value === 'string' && ENTITY_ID_PATTERN.test(value)
        ? undefined
        : 'INVALID_VALUE';
    case 'name':
    case 'firstCardName': {
      if (typeof value !== 'string') return 'INVALID_VALUE';
      if (value === '') return 'INVALID_VALUE';
      return codePoints(value) > LIMITS.stackName.max ? 'LIMIT_EXCEEDED' : undefined;
    }
    case 'cardWidth':
    case 'cardHeight': {
      if (typeof value !== 'number') return 'WRONG_TYPE';
      const valid =
        Number.isInteger(value) && value >= LIMITS.cardSize.min && value <= LIMITS.cardSize.max;
      return valid ? undefined : 'OUT_OF_RANGE';
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('arbCreateStackParams', () => {
  const sets = sample(arbCreateStackParams);

  it('gives only known parameters, and every parameter passes the oracle', () => {
    for (const params of sets) {
      expect(
        Object.keys(params).every((key) =>
          (CREATE_STACK_PARAM_ORDER as readonly string[]).includes(key),
        ),
      ).toBe(true);
      expect(Object.hasOwn(params, 'id')).toBe(true);
      expect(Object.hasOwn(params, 'name')).toBe(true);
      for (const key of CREATE_STACK_PARAM_ORDER) {
        expect(classify(key, params)).toBeUndefined();
      }
    }
  });

  it('covers the size limits, an in-between size, and both name limits (fixed seed, 200 sets)', () => {
    for (const key of ['cardWidth', 'cardHeight'] as const) {
      const sizes = sets.flatMap((params) => (params[key] === undefined ? [] : [params[key]]));
      expect(sizes).toContain(LIMITS.cardSize.min);
      expect(sizes).toContain(LIMITS.cardSize.max);
      expect(sizes.some((size) => size > LIMITS.cardSize.min && size < LIMITS.cardSize.max)).toBe(
        true,
      );
    }
    for (const key of ['name', 'firstCardName'] as const) {
      const lengths = sets.flatMap((params) =>
        params[key] === undefined ? [] : [codePoints(params[key])],
      );
      expect(lengths).toContain(LIMITS.stackName.min);
      expect(lengths).toContain(LIMITS.stackName.max);
      expect(lengths.some((length) => length > 1 && length < 100)).toBe(true);
    }
  });

  it('has each optional parameter both present and omitted (fixed seed, 200 sets)', () => {
    for (const key of ['cardWidth', 'cardHeight', 'firstCardId', 'firstCardName'] as const) {
      expect(sets.some((params) => Object.hasOwn(params, key))).toBe(true);
      expect(sets.some((params) => !Object.hasOwn(params, key))).toBe(true);
    }
  });

  it('uses ASCII and astral characters in the longest names', () => {
    const longest = sets.filter((params) => codePoints(params.name) === LIMITS.stackName.max);
    expect(longest.some((params) => params.name.length === LIMITS.stackName.max)).toBe(true);
    expect(longest.some((params) => params.name.length > LIMITS.stackName.max)).toBe(true);
  });

  it('puts the keys in more than one order', () => {
    const orders = new Set(sets.map((params) => Object.keys(params).join(',')));
    expect(orders.size).toBeGreaterThan(10);
  });

  it('gives the same sets for the same seed', () => {
    expect(sample(arbCreateStackParams)).toEqual(sets);
  });
});

describe('arbCorruptedCreateStackParams', () => {
  const cases: CorruptedCreateStackParams[] = sample(arbCorruptedCreateStackParams, 400);

  it('breaks at least one parameter and lists one expected error per broken parameter', () => {
    for (const { params, expectedErrors, broken } of cases) {
      expect(broken.length).toBeGreaterThan(0);
      expect(expectedErrors).toHaveLength(broken.length);
      expect(isRecord(params)).toBe(true);
    }
  });

  it('breaks exactly the parameters the oracle rejects, with the code it gives', () => {
    for (const { params, broken, expectedErrors } of cases) {
      const rejected = CREATE_STACK_PARAM_ORDER.filter(
        (key) => classify(key, params) !== undefined,
      );
      expect(rejected).toEqual(broken);
      // Each error carries the code the oracle gives, and its path follows the parameter.
      for (const key of broken) {
        const code = classify(key, params);
        const path = Object.hasOwn(params, key) ? `/${key}` : '';
        expect(expectedErrors).toContainEqual({ code, path });
      }
    }
  });

  it('orders the expected errors: omitted parameters first, then the others in reporting order', () => {
    for (const { params, broken, expectedErrors } of cases) {
      const omitted = broken.filter((key) => !Object.hasOwn(params, key));
      const present = broken.filter((key) => Object.hasOwn(params, key));
      const expected: ExpectedCreateStackError[] = [
        ...omitted.map((): ExpectedCreateStackError => ({ code: 'MISSING_PROPERTY', path: '' })),
        ...present.map((key): ExpectedCreateStackError => {
          const code = classify(key, params);
          if (code === undefined) throw new Error(`${key} is not broken`);
          return { code, path: `/${key}` };
        }),
      ];
      expect(expectedErrors).toEqual(expected);
      // Only `id` and `name` can be omitted.
      expect(omitted.every((key) => key === 'id' || key === 'name')).toBe(true);
    }
  });

  it('keeps every unbroken parameter valid', () => {
    for (const { params, broken } of cases) {
      for (const key of CREATE_STACK_PARAM_ORDER) {
        if (!broken.includes(key)) {
          expect(classify(key, params)).toBeUndefined();
        }
      }
    }
  });

  it('covers every parameter broken and unbroken, and every code (fixed seed, 400 cases)', () => {
    for (const key of CREATE_STACK_PARAM_ORDER) {
      expect(cases.some((c) => c.broken.includes(key))).toBe(true);
      expect(cases.some((c) => !c.broken.includes(key))).toBe(true);
    }
    const codes = new Set(cases.flatMap((c) => c.expectedErrors.map((error) => error.code)));
    expect([...codes].sort()).toEqual(
      ['INVALID_VALUE', 'LIMIT_EXCEEDED', 'MISSING_PROPERTY', 'OUT_OF_RANGE', 'WRONG_TYPE'].sort(),
    );
    // `id` and `name` are each omitted in some case, and every case that breaks them gives each kind of error.
    expect(cases.some((c) => c.broken.includes('id') && !Object.hasOwn(c.params, 'id'))).toBe(true);
    expect(cases.some((c) => c.broken.includes('name') && !Object.hasOwn(c.params, 'name'))).toBe(
      true,
    );
    // Both sizes see both an out-of-range number and a value that is not a number.
    for (const key of ['cardWidth', 'cardHeight'] as const) {
      const codesForKey = cases.flatMap((c) =>
        c.expectedErrors.filter((error) => error.path === `/${key}`).map((error) => error.code),
      );
      expect(codesForKey).toContain('OUT_OF_RANGE');
      expect(codesForKey).toContain('WRONG_TYPE');
    }
  });

  it('covers the boundary values just outside the limits', () => {
    const widths = cases.flatMap((c) =>
      typeof c.params.cardWidth === 'number' ? [c.params.cardWidth] : [],
    );
    expect(widths.some((width) => !Number.isInteger(width))).toBe(true);
    expect(widths.some((width) => width < LIMITS.cardSize.min)).toBe(true);
    expect(widths.some((width) => width > LIMITS.cardSize.max)).toBe(true);
    const names = cases.flatMap((c) => (typeof c.params.name === 'string' ? [c.params.name] : []));
    expect(names).toContain('');
    expect(names.some((name) => codePoints(name) > LIMITS.stackName.max)).toBe(true);
  });

  it('gives the same cases for the same seed', () => {
    expect(sample(arbCorruptedCreateStackParams, 400)).toEqual(cases);
  });
});
