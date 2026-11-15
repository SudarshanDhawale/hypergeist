import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OPERATION_NAMES, applyOperation } from '../src/engine/operations/index.ts';
import type { OperationResult } from '../src/engine/operation-result.ts';
import type { Stack } from '../src/format/index.ts';
import { arbStack } from './arbitraries.ts';
import { deepCopy, deepFreeze } from './freeze.ts';
import {
  MAX_SEQUENCE_LENGTH,
  OPERATION_FAULTS,
  UNKNOWN_OPERATION_NAMES,
  arbOperationSequence,
  arbOperationTemplate,
  resolveOperation,
} from './operation-arbitraries.ts';
import type { OperationTemplate, ResolvedOperation } from './operation-arbitraries.ts';
import { assertProperty } from './seed.ts';

/** The coverage tests use a fixed seed, so a failure is the same on every run. */
const COVERAGE_SEED = 20_261_115;
const SAMPLE_SIZE = 200;

type Step = {
  readonly template: OperationTemplate;
  readonly resolved: ResolvedOperation;
  readonly result: OperationResult;
};

/** Resolves and applies a sequence, holding the Stack after each accepted step. */
function runSequence(start: Stack, templates: readonly OperationTemplate[]): Step[] {
  const steps: Step[] = [];
  let held = start;
  for (const template of templates) {
    const resolved = resolveOperation(held, template);
    const result = applyOperation(held, resolved.name, resolved.params);
    steps.push({ template, resolved, result });
    if (result.ok) held = result.stack;
  }
  return steps;
}

const arbRun: fc.Arbitrary<[Stack, OperationTemplate[]]> = fc.tuple(arbStack, arbOperationSequence);

describe('arbOperationTemplate', () => {
  const templates = fc.sample(arbOperationTemplate, { numRuns: SAMPLE_SIZE, seed: COVERAGE_SEED });

  it('holds fractions in [0, 1) and short non-empty texts', () => {
    for (const template of templates) {
      expect(template.picks.length).toBeGreaterThan(0);
      for (const pick of template.picks) {
        expect(pick).toBeGreaterThanOrEqual(0);
        expect(pick).toBeLessThan(1);
      }
      for (const text of template.texts) {
        const length = [...text].length;
        expect(length).toBeGreaterThanOrEqual(1);
        expect(length).toBeLessThanOrEqual(30);
      }
    }
  });

  it('produces every Operation name, every fault tag, and unknown names', () => {
    expect(new Set(templates.map((t) => t.name))).toEqual(new Set(OPERATION_NAMES));
    expect(new Set(templates.map((t) => t.fault))).toEqual(new Set(OPERATION_FAULTS));
    const unknown = templates.filter((t) => t.unknownName !== undefined);
    expect(unknown.length).toBeGreaterThan(0);
    for (const template of unknown) {
      expect(UNKNOWN_OPERATION_NAMES).toContain(template.unknownName);
    }
  });
});

describe('resolveOperation', () => {
  it('is deterministic and leaves a frozen Stack unmodified', () => {
    assertProperty(
      fc.property(arbStack, arbOperationTemplate, (stack, template) => {
        const frozen = deepFreeze(deepCopy(stack));
        const first = resolveOperation(frozen, template);
        const second = resolveOperation(frozen, template);
        expect(second).toEqual(first);
        expect(frozen).toEqual(stack);
      }),
    );
  });

  it('builds a call that names real ids when there is no fault', () => {
    assertProperty(
      fc.property(arbStack, arbOperationTemplate, (stack, template) => {
        const resolved = resolveOperation(stack, {
          ...template,
          fault: 'none',
          unknownName: undefined,
        });
        expect(resolved.name).toBe(template.name);
        expect(typeof resolved.params).toBe('object');
        // Without a fault the call is only marked rejected when it is known to be rejected
        // for a reason of the Stack (the last Card, a full Card or a full Stack).
        const result = applyOperation(stack, resolved.name, resolved.params);
        if (resolved.expectedCode !== undefined) {
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.errors.map((e) => e.code)).toContain(resolved.expectedCode);
          }
        }
      }),
    );
  });

  it('gives an unknown name INVALID_VALUE at /operation', () => {
    assertProperty(
      fc.property(arbStack, arbOperationTemplate, (stack, template) => {
        const resolved = resolveOperation(stack, { ...template, unknownName: 'nope' });
        expect(resolved.name).toBe('nope');
        expect(resolved.expectedCode).toBe('INVALID_VALUE');
        const result = applyOperation(stack, resolved.name, resolved.params);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.errors.map((e) => [e.code, e.path])).toEqual([
            ['INVALID_VALUE', '/operation'],
          ]);
        }
      }),
    );
  });
});

describe('arbOperationSequence', () => {
  it('holds 0 to 50 templates', () => {
    const lengths = fc
      .sample(arbOperationSequence, { numRuns: SAMPLE_SIZE, seed: COVERAGE_SEED })
      .map((sequence) => sequence.length);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(MAX_SEQUENCE_LENGTH);
  });

  it('rejects every call that carries an expected code, with that code among the errors', () => {
    assertProperty(
      fc.property(arbRun, ([start, templates]) => {
        for (const { resolved, result } of runSequence(start, templates)) {
          if (resolved.expectedCode === undefined) continue;
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.errors.map((error) => error.code)).toContain(resolved.expectedCode);
          }
        }
      }),
    );
  });
});

describe('coverage over 200 sequences with a fixed seed', () => {
  const runs = fc.sample(arbRun, { numRuns: SAMPLE_SIZE, seed: COVERAGE_SEED });
  const sequences = runs.map(([, templates]) => templates);
  const steps = runs.flatMap(([start, templates]) => runSequence(start, templates));

  it('contains a sequence of length 0 and one of length 50', () => {
    const lengths = new Set(sequences.map((sequence) => sequence.length));
    expect(lengths.has(0)).toBe(true);
    expect(lengths.has(MAX_SEQUENCE_LENGTH)).toBe(true);
  });

  it('calls every Operation name', () => {
    const names = new Set(steps.map((step) => step.resolved.name));
    for (const name of OPERATION_NAMES) {
      expect(names.has(name), `no call to ${name}`).toBe(true);
    }
  });

  it('has both accepted and rejected results, for every Operation', () => {
    expect(steps.some((step) => step.result.ok)).toBe(true);
    expect(steps.some((step) => !step.result.ok)).toBe(true);
    for (const name of OPERATION_NAMES) {
      const own = steps.filter((step) => step.resolved.name === name);
      expect(
        own.some((step) => step.result.ok),
        `${name} is never accepted`,
      ).toBe(true);
      expect(
        own.some((step) => !step.result.ok),
        `${name} is never rejected`,
      ).toBe(true);
    }
  });

  it('applies every fault tag to at least one call', () => {
    for (const fault of OPERATION_FAULTS) {
      if (fault === 'none') continue;
      const applied = steps.some(
        (step) =>
          step.template.fault === fault &&
          step.template.unknownName === undefined &&
          step.resolved.expectedCode !== undefined,
      );
      expect(applied, `fault ${fault} is never applied`).toBe(true);
    }
  });

  it('rejects unknown Operation names', () => {
    const unknown = steps.filter((step) => step.template.unknownName !== undefined);
    expect(unknown.length).toBeGreaterThan(0);
    for (const step of unknown) {
      expect(step.result.ok).toBe(false);
    }
  });
});
