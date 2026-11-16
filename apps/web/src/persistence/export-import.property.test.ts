import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arbEntityId, arbStack } from '../../../../packages/shared/test-support/arbitraries.ts';
import { assertProperty } from '../../../../packages/shared/test-support/seed.ts';
import { exportFilename, exportStack } from './export-stack.ts';
import { parseImport } from './import-stack.ts';

const FILE_NAME_PATTERN = /^[a-z0-9_-]+\.hypergeist\.json$/;
const EXTENSION = '.hypergeist.json';
/** 40 slug characters, one `-`, and a 64 character id. */
const MAX_STEM_LENGTH = 105;

const HAND_PICKED_NAMES: readonly string[] = [
  '',
  '   ',
  '👻👻👻',
  'Morning briefing ☀️',
  'مرحبا بالعالم',
  'שלום עולם',
  'Ünïcödé Ñame',
  '日本語のスタック',
  '../../etc/passwd',
  'a'.repeat(300),
];

const arbName: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.string({ unit: 'grapheme' }),
  fc.constantFrom(...HAND_PICKED_NAMES),
);

describe('export and import (property)', () => {
  it('Feature: local-persistence, Property 1: Export then import is lossless', () => {
    // **Validates: Requirements 7.7**
    assertProperty(
      fc.property(arbStack, (stack) => {
        const exported = exportStack(stack);
        expect(exported.ok).toBe(true);
        if (!exported.ok) return;
        const imported = parseImport(exported.text);
        expect(imported.ok).toBe(true);
        if (!imported.ok) return;
        expect(imported.stack).toEqual(stack);
      }),
    );
  });

  it('Feature: local-persistence, Property 5: File names are safe', () => {
    // **Validates: Requirements 6.1**
    assertProperty(
      fc.property(arbName, arbEntityId, (name, id) => {
        const filename = exportFilename(name, id);
        expect(filename).toMatch(FILE_NAME_PATTERN);
        expect(filename.endsWith(EXTENSION)).toBe(true);
        const stem = filename.slice(0, filename.length - EXTENSION.length);
        expect(stem.length).toBeLessThanOrEqual(MAX_STEM_LENGTH);
      }),
    );
  });
});
