import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const tsFiles = ['**/*.{ts,tsx}'];

export default [
  {
    ignores: [
      '**/dist',
      '**/.wrangler',
      '**/coverage',
      '**/test-results',
      '**/playwright-report',
      'scripts/check-deps/fixtures',
    ],
  },
  { ...js.configs.recommended, files: tsFiles },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: tsFiles })),
  {
    files: tsFiles,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
    },
  },
  {
    // Framework-required default exports: Vite, Vitest and Playwright configs,
    // and the Cloudflare Workers entry point.
    files: [
      '**/vite.config.ts',
      '**/vitest.config.ts',
      'playwright.config.ts',
      'apps/worker/src/index.ts',
    ],
    rules: {
      'no-restricted-exports': 'off',
    },
  },
];
