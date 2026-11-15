import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shared',
    environment: 'node',
    // Property tests run 100 generated stacks each. Their time depends on the seed and on machine
    // load (0.9 s to 2.9 s alone for one test, more when the whole workspace runs in parallel),
    // so the 5 s default times out at random.
    testTimeout: 30_000,
    include: ['src/**/*.test.ts', 'test-support/**/*.test.ts'],
  },
});
