import * as fc from 'fast-check';
import { describe, it } from 'vitest';
import { assertProperty } from '../test-support/seed.ts';

describe('property smoke test', () => {
  // Feature: repo-scaffold, Property: addition is commutative
  // **Validates: Requirements 8.2, 8.3**
  it('Feature: repo-scaffold, Property: addition is commutative', () => {
    assertProperty(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
    );
  });
});
