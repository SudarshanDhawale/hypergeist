import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { deepCopy, deepFreeze } from '../../../test-support/freeze.ts';
import { createValidationError } from '../../format/index.ts';
import type { Stack, ValidationError } from '../../format/index.ts';
import { createStack } from '../create-stack.ts';
import { emptySummary } from '../operation-result.ts';
import { runDefinition } from './definition.ts';
import type { OperationDefinition, RunOutcome } from './definition.ts';

type FakeParams = { readonly name: string; readonly index?: number };

const FakeSchema = z.strictObject({
  name: z.string().min(1),
  index: z.int().min(0).optional(),
});

function makeStack(): Stack {
  const result = createStack({ id: 'stack-1', name: 'Test' });
  if (!result.ok) throw new Error('fixture stack must be valid');
  return result.stack;
}

function makeDefinition(
  run: (stack: Stack, params: FakeParams) => RunOutcome,
): OperationDefinition<FakeParams> {
  return { name: 'create_card', schema: FakeSchema, rangePaths: ['/index'], run };
}

/** A good outcome: the Stack with one more Card. */
function addCardOutcome(stack: Stack, name: string): RunOutcome {
  return {
    ok: true,
    candidate: {
      ...stack,
      cards: [...stack.cards, { id: 'card-2', name, objects: [], links: [], onOpen: [] }],
    },
    summary: { ...emptySummary(), created: ['card-2'] },
    mapPath: () => undefined,
  };
}

describe('runDefinition: stage A (parameter schema)', () => {
  it('rejects bad parameters before run is called, with errors in the parameters', () => {
    const run = vi.fn();
    const result = runDefinition(makeDefinition(run), makeStack(), { name: 5 });
    expect(run).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('WRONG_TYPE');
    expect(result.errors[0]?.path).toBe('/name');
    expect('stack' in result).toBe(false);
  });

  it('reports a missing parameter at the parameters root', () => {
    const run = vi.fn();
    const result = runDefinition(makeDefinition(run), makeStack(), {});
    expect(run).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('MISSING_PROPERTY');
    expect(result.errors[0]?.path).toBe('');
  });

  it('applies rangePaths, so an out-of-range integer is OUT_OF_RANGE', () => {
    const run = vi.fn();
    const result = runDefinition(makeDefinition(run), makeStack(), { name: 'A', index: -1 });
    expect(run).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('OUT_OF_RANGE');
    expect(result.errors[0]?.path).toBe('/index');
  });

  it('does not throw for parameters that are not an object', () => {
    const definition = makeDefinition(vi.fn());
    for (const params of [undefined, null, 7, 'text', [], () => 1]) {
      const result = runDefinition(definition, makeStack(), params);
      expect(result.ok).toBe(false);
    }
  });

  it('does not throw for a cyclic parameter object', () => {
    const cyclic: Record<string, unknown> = { name: 'A' };
    cyclic['self'] = cyclic;
    const result = runDefinition(makeDefinition(vi.fn()), makeStack(), cyclic);
    expect(result.ok).toBe(false);
  });

  it('passes the truncated flag of a capped error list', () => {
    const schema = z.array(z.string());
    const definition: OperationDefinition<string[]> = {
      name: 'create_card',
      schema,
      rangePaths: [],
      run: vi.fn(),
    };
    const result = runDefinition(
      definition,
      makeStack(),
      Array.from({ length: 150 }, () => 1),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });
});

describe('runDefinition: stage B (operation logic)', () => {
  it('passes the parsed parameters and the Stack to run', () => {
    const stack = makeStack();
    const run = vi.fn((s: Stack, p: FakeParams) => addCardOutcome(s, p.name));
    runDefinition(makeDefinition(run), stack, { name: 'Second', index: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(stack, { name: 'Second', index: 1 });
  });

  it('returns precondition errors as they are and no Stack', () => {
    const error = createValidationError({
      code: 'UNKNOWN_ENTITY',
      path: '/cardId',
      message: 'No such Card.',
      expected: 'the id of a Card',
      actual: 'nope',
      hint: 'Use card-1.',
    });
    const result = runDefinition(
      makeDefinition(() => ({ ok: false, errors: [error] })),
      makeStack(),
      { name: 'A' },
    );
    expect(result).toEqual({ ok: false, errors: [error], truncated: false });
    expect('stack' in result).toBe(false);
  });

  it('stops before stage C when run fails, even if the Stack is unusable', () => {
    const error = createValidationError({
      code: 'DUPLICATE_ID',
      path: '/id',
      message: 'Used.',
      expected: 'an unused id',
      hint: 'Pick another id.',
    });
    const bad = { not: 'a stack' } as unknown as Stack;
    const result = runDefinition(
      makeDefinition(() => ({ ok: false, errors: [error] })),
      bad,
      { name: 'A' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([error]);
  });

  it('lets an exception from run surface (a programmer error is not hidden)', () => {
    const definition = makeDefinition(() => {
      throw new Error('bug in run');
    });
    expect(() => runDefinition(definition, makeStack(), { name: 'A' })).toThrow('bug in run');
  });
});

describe('runDefinition: stage C (validateStack safety net)', () => {
  /** A candidate whose startCardId names no Card. */
  function danglingOutcome(mapPath: (pointer: string) => string | undefined): RunOutcome {
    return {
      ok: true,
      candidate: { ...makeStack(), startCardId: 'missing-card' },
      summary: emptySummary(),
      mapPath,
    };
  }

  it('rejects an invalid candidate with no Stack and remapped error paths', () => {
    const result = runDefinition(
      makeDefinition(() =>
        danglingOutcome((pointer) => (pointer === '/startCardId' ? '/cardId' : undefined)),
      ),
      makeStack(),
      { name: 'A' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.map((e) => e.path)).toContain('/cardId');
    expect('stack' in result).toBe(false);
    expect('summary' in result).toBe(false);
  });

  it('maps an unmappable pointer to /stack plus the Stack pointer', () => {
    const result = runDefinition(
      makeDefinition(() => danglingOutcome(() => undefined)),
      makeStack(),
      { name: 'A' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    for (const error of result.errors) expect(error.path.startsWith('/stack')).toBe(true);
    expect(result.errors.map((e) => e.path)).toContain('/stack/startCardId');
  });

  it('keeps code, message, expected, actual and hint when it remaps a path', () => {
    const unmapped = runDefinition(
      makeDefinition(() => danglingOutcome(() => undefined)),
      makeStack(),
      { name: 'A' },
    );
    const mapped = runDefinition(
      makeDefinition(() => danglingOutcome(() => '/x')),
      makeStack(),
      { name: 'A' },
    );
    if (unmapped.ok || mapped.ok) throw new Error('both must be rejected');
    const withoutPath = (errors: readonly ValidationError[]) =>
      errors.map((error) => ({ ...error, path: '' }));
    expect(withoutPath(mapped.errors)).toEqual(withoutPath(unmapped.errors));
  });

  it('accepts a good candidate and returns it with the summary', () => {
    const stack = makeStack();
    const result = runDefinition(
      makeDefinition((s, p) => addCardOutcome(s, p.name)),
      stack,
      { name: 'Second' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stack.cards.map((c) => c.id)).toEqual(['card-1', 'card-2']);
    expect(result.summary).toEqual({
      created: ['card-2'],
      updated: [],
      removed: [],
      removedActions: 0,
    });
  });
});

describe('runDefinition: purity', () => {
  it('does not modify a frozen input Stack, on success or on rejection', () => {
    const stack = deepFreeze(makeStack());
    const before = deepCopy(stack);

    const good = runDefinition(
      makeDefinition((s, p) => addCardOutcome(s, p.name)),
      stack,
      { name: 'Second' },
    );
    expect(good.ok).toBe(true);
    expect(stack).toEqual(before);

    const bad = runDefinition(
      makeDefinition(() => ({
        ok: true,
        candidate: { ...stack, startCardId: 'missing-card' },
        summary: emptySummary(),
        mapPath: () => undefined,
      })),
      stack,
      { name: 'Second' },
    );
    expect(bad.ok).toBe(false);
    expect(stack).toEqual(before);
  });

  it('returns deeply equal results for equal calls', () => {
    const definition = makeDefinition((s, p) => addCardOutcome(s, p.name));
    const first = runDefinition(definition, makeStack(), { name: 'Second' });
    const second = runDefinition(definition, makeStack(), { name: 'Second' });
    expect(second).toEqual(first);
  });
});
