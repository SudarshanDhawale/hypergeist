import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  arbArbitraryText,
  arbBomJsonText,
  arbCrlfJsonText,
  arbDeletedCharText,
  arbInsertedCharText,
  arbJsonText,
  arbTruncatedText,
  arbValidJsonText,
} from './json-text-arbitraries.ts';
import { getTestSeed } from './seed.ts';

const SAMPLE_SIZE = 300;

function sample(arbitrary: fc.Arbitrary<string>): string[] {
  return fc.sample(arbitrary, { numRuns: SAMPLE_SIZE, seed: getTestSeed() });
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

describe('json-text arbitraries', () => {
  it('arbValidJsonText always parses', () => {
    expect(sample(arbValidJsonText).every(parses)).toBe(true);
  });

  it('arbValidJsonText uses more than one layout', () => {
    const texts = sample(arbValidJsonText);
    expect(texts.some((text) => text.includes('\r\n'))).toBe(true);
    expect(texts.some((text) => text.includes('\t'))).toBe(true);
    expect(texts.some((text) => text.includes('\n  '))).toBe(true);
  });

  it('every generator gives both parsing and failing texts, except the BOM generator', () => {
    for (const arbitrary of [
      arbArbitraryText,
      arbDeletedCharText,
      arbInsertedCharText,
      arbTruncatedText,
      arbCrlfJsonText,
      arbJsonText,
    ]) {
      const results = sample(arbitrary).map(parses);
      expect(results).toContain(false);
    }
  });

  it('arbCrlfJsonText contains CRLF line breaks', () => {
    expect(sample(arbCrlfJsonText).some((text) => text.includes('\r\n'))).toBe(true);
  });

  it('arbBomJsonText starts with a byte order mark and never parses', () => {
    const texts = sample(arbBomJsonText);
    expect(texts.every((text) => text.startsWith('\uFEFF'))).toBe(true);
    expect(texts.some(parses)).toBe(false);
  });

  it('arbTruncatedText is shorter than the valid text it came from, so it can end early', () => {
    const texts = sample(arbTruncatedText);
    expect(texts.some((text) => text.length === 0)).toBe(true);
    expect(texts.some((text) => text.length > 0)).toBe(true);
  });

  it('is deterministic for a fixed seed', () => {
    expect(sample(arbJsonText)).toEqual(sample(arbJsonText));
  });
});
