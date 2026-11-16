import { describe, expect, it } from 'vitest';

import type { Stack } from '@hypergeist/shared/format';

import demoText from '../stacks/thin-slice-todo.json?raw';
import { MAX_IMPORT_BYTES, checkImportSize, parseImport, planImport } from './import-stack.ts';

function validStack(): Stack {
  const result = parseImport(demoText);
  if (!result.ok) throw new Error('bundled demo stack must parse');
  return result.stack;
}

function withExtra(extra: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(demoText) as Record<string, unknown>), ...extra });
}

describe('checkImportSize', () => {
  it('has a 5 MB limit', () => {
    expect(MAX_IMPORT_BYTES).toBe(5 * 1024 * 1024);
  });

  it('accepts 0 bytes, a normal size, and exactly 5 MB', () => {
    expect(checkImportSize(0)).toEqual({ ok: true });
    expect(checkImportSize(12_345)).toEqual({ ok: true });
    expect(checkImportSize(MAX_IMPORT_BYTES)).toEqual({ ok: true });
  });

  it('refuses one byte over 5 MB with a plain message that names the limit', () => {
    const result = checkImportSize(MAX_IMPORT_BYTES + 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('5 MB');
  });

  it('refuses sizes that are not usable numbers', () => {
    expect(checkImportSize(Number.NaN).ok).toBe(false);
    expect(checkImportSize(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(checkImportSize(-1).ok).toBe(false);
  });
});

describe('parseImport', () => {
  it('returns the stack for a valid file', () => {
    const result = parseImport(demoText);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stack.id).toBe('thin-slice-todo');
  });

  it('reports text that is not JSON as one INVALID_JSON error', () => {
    const result = parseImport('{ not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('INVALID_JSON');
    expect(result.more).toBe(0);
  });

  it('points at a wrong property with its path, message and hint', () => {
    const result = parseImport(withExtra({ colour: 'red' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('UNKNOWN_PROPERTY');
    expect(result.errors[0]?.path).toContain('colour');
    expect(result.errors[0]?.message).not.toBe('');
    expect(result.errors[0]?.hint).not.toBe('');
    expect(result.more).toBe(0);
  });

  it('shows exactly 5 errors and counts the rest when there are more', () => {
    const extras: Record<string, unknown> = {};
    for (let i = 0; i < 8; i += 1) extras[`extra${i}`] = i;
    const result = parseImport(withExtra(extras));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(5);
    expect(result.more).toBe(3);
  });

  it('shows 5 errors and no "more" when there are exactly 5', () => {
    const extras: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) extras[`extra${i}`] = i;
    const result = parseImport(withExtra(extras));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(5);
    expect(result.more).toBe(0);
  });

  it('never throws and never returns ok for hostile text', () => {
    const hostile: string[] = [
      '',
      '   \n\t ',
      'null',
      '[]',
      '"text"',
      '42',
      '{}',
      '\uFEFF' + demoText,
      '\uFEFF',
      '\uD800',
      '{"id":"\uD800"}',
      '\uDC00\uD800',
      '[]'.padStart(50_000, '['),
      '['.repeat(200_000),
      '{"a":'.repeat(100_000),
      '\u0000',
    ];
    for (const text of hostile) {
      const result = parseImport(text);
      expect(result.ok, JSON.stringify(text.slice(0, 20))).toBe(false);
      if (result.ok) continue;
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.length).toBeLessThanOrEqual(5);
      expect(result.more).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('planImport', () => {
  it('says new when the id is free (array or set)', () => {
    const stack = validStack();
    expect(planImport(stack, [])).toEqual({ kind: 'new' });
    expect(planImport(stack, ['other'])).toEqual({ kind: 'new' });
    expect(planImport(stack, new Set(['other']))).toEqual({ kind: 'new' });
  });

  it('says conflict with a free suggested id when the id is in use', () => {
    const stack = validStack();
    for (const existing of [
      ['thin-slice-todo'],
      new Set(['thin-slice-todo']),
      ['thin-slice-todo', 'thin-slice-todo-copy'],
    ]) {
      const plan = planImport(stack, existing);
      expect(plan.kind).toBe('conflict');
      if (plan.kind !== 'conflict') continue;
      const taken = new Set(existing);
      expect(taken.has(plan.suggestedId)).toBe(false);
      expect(plan.suggestedId).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    }
  });

  it('does not change its inputs', () => {
    const stack = validStack();
    const before = JSON.stringify(stack);
    const ids = ['thin-slice-todo'];
    planImport(stack, ids);
    expect(JSON.stringify(stack)).toBe(before);
    expect(ids).toEqual(['thin-slice-todo']);
  });
});
