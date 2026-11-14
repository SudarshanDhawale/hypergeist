# Implementation Plan: Repo Scaffold

## Overview

The plan has four stages. First come all files that need no package manager (git, license, docs, configs, and source files for every package). Then a checkpoint stops until pnpm is installed by the user. After that, dependencies are installed and the lockfile is created. Last, the full verification runs: format, lint, typecheck, dependency check, unit tests, build with the Wrangler dry run, and the Playwright smoke test.

Language: TypeScript (strict), as fixed by the `tech-stack` steering file. Tooling code uses erasable syntax only, with `.ts` import extensions, as described in the design.

Rules for the executor:

- No task before the pnpm checkpoint (task 8) runs `pnpm`, `npm install`, `corepack`, or any install command. Files written before the install cannot be type checked or tested yet; their verification commands run in task 12.
- Never install pnpm globally. If pnpm is missing, stop and ask the user.
- Do not commit, push, or deploy. Do not add any secret value to any file.
- Never add `.kiro` to `.gitignore`.

## Tasks

- [x] 1. Initialize the repository and add non-code files
  - [x] 1.1 Run `git init -b main`, write `.gitignore` and `.env.example`, and verify `.kiro` is not ignored
    - If `.git` already exists, do not re-initialize; confirm the branch is `main` with `git branch --show-current` (or `git symbolic-ref --short HEAD` when there are no commits).
    - `.gitignore` entries from the design: `node_modules/`, `dist/`, `.wrangler/`, `.dev.vars`, `.env`, `.env.*`, `!.env.example`, `*.tsbuildinfo`, `coverage/`, `test-results/`, `playwright-report/`, `.DS_Store`. No pattern may match `.kiro`.
    - `.env.example` contains one line: `HYPERGEIST_TEST_SEED=` (name only, no value).
    - Verify: `git check-ignore .kiro` prints nothing and exits with code 1. Also run `git check-ignore -v .kiro/specs/repo-scaffold/requirements.md` and confirm nothing is reported.
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.7, 2.6_

  - [x] 1.2 Write `LICENSE` with the MIT text
    - Copyright line: `Copyright (c) 2026 HyperGeist contributors`.
    - _Requirements: 1.2, 1.3_

  - [x] 1.3 Write `docs/assets-licenses.md` and `docs/kiro-journal.md`
    - `docs/assets-licenses.md`: a heading, one sentence stating that every font, sound, icon, and image entry requires a license that permits redistribution, and a table with columns Asset, Source URL, License, Used in, Date added and no data rows.
    - `docs/kiro-journal.md`: a heading, a one-paragraph purpose statement, and an entry template with date, what was done with Kiro, what worked, and what did not. No journal entry.
    - Do not touch the existing `docs/kiroween-2026-project-brief.md`.
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

- [x] 2. Write the root configuration files (no pnpm needed)
  - [x] 2.1 Write `pnpm-workspace.yaml` and the root `package.json`
    - `pnpm-workspace.yaml`: `packages: [apps/*, packages/*]` and `allowBuilds: { esbuild: true, workerd: true }` (pnpm 12 ignores `onlyBuiltDependencies`).
    - Root `package.json`: `name: hypergeist`, `private: true`, `type: module`, `engines.node: ">=22.18.0 <25"`, and the scripts `build`, `test`, `typecheck`, `lint`, `format`, `format:check`, `check:deps`, `test:e2e` exactly as in the design. Leave out `packageManager` and all dependency fields for now; task 9.1 and 9.2 add them.
    - `build` runs shared, then web, then the Worker dry run, chained with `&&`. `test` is `vitest run`.
    - _Requirements: 2.1, 2.2, 2.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 2.2 Write `tsconfig.base.json`
    - Use the compiler options from the design: `strict: true`, `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `lib: [ES2022]`, `types: []`, `noEmit`, `skipLibCheck`, `isolatedModules`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `erasableSyntaxOnly`.
    - _Requirements: 3.1_

  - [x] 2.3 Write `.prettierrc.json` and `.prettierignore`
    - Config: `singleQuote: true`, `semi: true`, `trailingComma: all`, `printWidth: 100`.
    - Ignore: `node_modules`, `dist`, `.wrangler`, `coverage`, `test-results`, `playwright-report`, `pnpm-lock.yaml`, `.kiro`, `docs/kiroween-2026-project-brief.md`, `scripts/check-deps/fixtures`.
    - _Requirements: 5.5_

  - [x] 2.4 Write `eslint.config.mjs`
    - Flat config using `@eslint/js` recommended and `typescript-eslint` recommended, for `**/*.{ts,tsx}`.
    - Ignores: `**/dist`, `**/.wrangler`, `**/coverage`, `**/test-results`, `**/playwright-report`, `scripts/check-deps/fixtures`.
    - Set `@typescript-eslint/no-explicit-any` and `@typescript-eslint/no-non-null-assertion` to `error`.
    - Enable core `no-restricted-exports` with `restrictDefaultExports` (all options on). Turn it off for `**/vite.config.ts`, `**/vitest.config.ts`, `playwright.config.ts`, and `apps/worker/src/index.ts` (Workers require a default export; see Open Item 2 in the design).
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 2.5 Write the root `vitest.config.ts`
    - `test.projects`: `packages/*`, `apps/*`, and an inline `scripts` project (`name: 'scripts'`, `environment: 'node'`, `include: ['scripts/**/*.test.ts']`).
    - _Requirements: 4.4_

  - [x] 2.6 Write `playwright.config.ts`
    - Chromium project only, `testDir: 'e2e'`, `timeout: 30_000`, `baseURL: http://127.0.0.1:8787`.
    - `webServer`: `pnpm --filter @hypergeist/worker exec wrangler dev --ip 127.0.0.1 --port 8787`, `url` set to the health endpoint, `timeout: 120_000`, `reuseExistingServer: !process.env.CI`, `env: { WRANGLER_SEND_METRICS: 'false' }`.
    - CI settings from the design: `forbidOnly`, one retry in CI, HTML reporter with `open: 'never'` in CI.
    - _Requirements: 12.1, 12.2, 12.5_

- [x] 3. Create the Shared_Package (`packages/shared`)
  - [x] 3.1 Write the package manifest and TypeScript and Vitest configs
    - `package.json`: name `@hypergeist/shared`, `private`, `type: module`, `exports` map with exactly `.`, `./format`, `./engine` pointing at `src/*.ts`; scripts `build` (`tsc -p tsconfig.json`), `typecheck` (both tsconfigs), `test` (`vitest run`). Do not add dependency fields yet (task 9.2 adds `zod` 4 and the dev dependencies).
    - `tsconfig.json`: extends the base, `lib: [ES2022]`, `types: []`, include `src`, exclude `**/*.test.ts`. No DOM, no Worker types, no Node types.
    - `tsconfig.test.json`: extends `./tsconfig.json`, `types: ["node"]`, include `src` and `test-support`, no exclude.
    - `vitest.config.ts`: `name: 'shared'`, `environment: 'node'`, include `src/**/*.test.ts` and `test-support/**/*.test.ts`.
    - _Requirements: 2.4, 3.2, 3.3, 6.1, 8.1, 16.3_

  - [x] 3.2 Write the empty public entry points and the shared Smoke_Test
    - `src/index.ts`, `src/format/index.ts`, `src/engine/index.ts` each contain only `export {};`. Do not import `zod` anywhere.
    - `src/smoke.test.ts` imports the three entry modules and asserts they load.
    - _Requirements: 6.2, 6.4, 6.5, 8.1, 16.1, 16.3_

  - [x] 3.3 Write the seed helper `test-support/seed.ts`
    - Implement `SEED_VARIABLE`, `parseSeed`, `resolveSeed`, `generateSeed`, `getTestSeed` (memoized), `replayCommand`, `propertyParams` (default `numRuns` 100, seed applied last so overrides cannot replace it), and `assertProperty` (prints the seed and replay command with `console.error`, then rethrows) as specified in the design.
    - An unset or empty variable generates a seed. A valid value matches `^-?\d+$` and lies in the signed 32-bit range. Any other value makes `resolveSeed` throw an error naming `HYPERGEIST_TEST_SEED` and the raw value.
    - Do not export the helper from `src/index.ts`.
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7, 16.1_

  - [x] 3.4 Write unit tests `test-support/seed.test.ts`
    - Cover: unset and empty variable use the injected generator (8.4); explicit invalid values `"1.5"`, `"0x10"`, `" 7"`, `"2147483648"` throw with the variable name and raw value (8.5); the same seed supplied twice gives the same sampled input sequence (8.7); a failing property prints the seed and replay command through a `console.error` spy (8.6).
    - _Requirements: 8.4, 8.5, 8.6, 8.7, 8.8_

  - [x] 3.5 Write the required property smoke test `src/smoke.property.test.ts`
    - Assert that integer addition is commutative, using `assertProperty`. Name the file `*.property.test.ts`. Import the helper by relative path from `test-support/`.
    - Tag format: `Feature: repo-scaffold, Property: addition is commutative`.
    - _Requirements: 8.2, 8.3_

  - [ ]* 3.6 Write property test for seed resolution
    - Create `test-support/seed.property.test.ts`.
    - **Property 1: Seed resolution**
    - **Validates: Requirements 8.4, 8.5**

  - [ ]* 3.7 Write property test for same-seed reproducibility
    - Add to `test-support/seed.property.test.ts`.
    - **Property 2: Same seed, same input sequence**
    - **Validates: Requirements 8.3, 8.7**

- [x] 4. Create the Dependency_Check (`scripts/`)
  - [x] 4.1 Write the pure core `scripts/check-deps/rules.ts`
    - Export `RuleId`, `SourceFile`, `Violation`, `SHARED_PUBLIC_ENTRY_POINTS`, `extractSpecifiers`, `checkFile`, `checkFiles`.
    - `extractSpecifiers` uses `ts.preProcessFile(text, true, true)` and derives 1-based line numbers from `pos`. `checkFiles` sorts by file, line, rule.
    - Classification follows the design's rule table: `shared-imports-app`, `cross-app-import`, `shared-internal-import`. Resolve relative specifiers with `path.posix`; a path that escapes the repo root is external; unknown `@hypergeist/*` names are external.
    - _Requirements: 6.3, 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 4.2 Write `scan.ts`, `cli.ts`, and `scripts/tsconfig.json`
    - `collectFiles(root, dirs = ['apps', 'packages'])` walks recursively, keeps `.ts` and `.tsx`, skips `node_modules`, `dist`, `.wrangler`, `coverage`, and returns repo-relative POSIX paths.
    - `cli.ts` prints one line per violation as `<file>:<line>  [<rule>]  <message>  (<specifier>)`. Exit 0 with no violations, 1 with violations, 2 with a message on stderr if the scan fails.
    - `scripts/tsconfig.json`: extends the base, `types: ["node"]`, `allowImportingTsExtensions: true`, include `.`, `../vitest.config.ts`, `../playwright.config.ts`, exclude `check-deps/fixtures`. Use `.ts` import extensions in all tooling code.
    - _Requirements: 3.2, 7.1, 7.2, 7.5_

  - [x] 4.3 Write fixtures and the fixture test `check-deps.test.ts`
    - `fixtures/violations/`: a shared file importing `../../../../apps/web/src/App`, a web file importing `@hypergeist/worker`, and a worker file importing `@hypergeist/shared/src/engine/index`, each under a mirrored `packages/shared/src`, `apps/web/src`, `apps/worker/src` layout.
    - `fixtures/clean/`: one file per package using only allowed imports (including `@hypergeist/shared`, `@hypergeist/shared/format`, `@hypergeist/shared/engine`).
    - Tests call `collectFiles(fixtureRoot)` and `checkFiles`, and assert one violation per rule with the expected file names, zero violations on the clean tree, and extra examples for `import('x')`, `export * from`, type-only imports, and the walker skipping `node_modules` and `dist`.
    - _Requirements: 6.3, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [ ]* 4.4 Write property test for specifier extraction
    - Create `scripts/check-deps/check-deps.property.test.ts`, importing the seed helper by relative path `../../packages/shared/test-support/seed.ts` and using `assertProperty`.
    - **Property 3: Specifier extraction round trip**
    - **Validates: Requirements 7.1**

  - [ ]* 4.5 Write property test for import classification
    - Add to `scripts/check-deps/check-deps.property.test.ts`.
    - **Property 4: Import classification follows the rule table**
    - **Validates: Requirements 6.3, 7.2, 7.3, 7.4, 7.5**

  - [ ]* 4.6 Write property test for order independence
    - Add to `scripts/check-deps/check-deps.property.test.ts`.
    - **Property 5: Check result is independent of file order**
    - **Validates: Requirements 7.1, 7.5**

- [x] 5. Create the Web_App (`apps/web`)
  - [x] 5.1 Write the manifest, configs, and `index.html`
    - `package.json`: name `@hypergeist/web`, `private`, `type: module`, scripts `dev` (`vite`), `build` (`vite build`), `typecheck`, `test`. No dependency fields yet (task 9.2 adds them, including `@hypergeist/shared` as `workspace:*`).
    - `tsconfig.json`: extends the base, `lib: [ES2022, DOM, DOM.Iterable]`, `types: []`, `jsx: react-jsx`, include `src` and `vite.config.ts`.
    - `vite.config.ts`: `defineConfig` from `vitest/config`, React plugin, `build.outDir: 'dist'`, dev server port 5173 with `/api` proxied to `http://localhost:8787`, and `test` block with `name: 'web'`, `environment: 'jsdom'`.
    - `index.html`: a `<div id="root">` and the module script `/src/main.tsx`. No CDN, web font, analytics, manifest, or service worker.
    - _Requirements: 2.4, 3.2, 3.4, 9.1, 9.4, 9.5, 9.6, 9.7_

  - [x] 5.2 Write the Placeholder_Page and its Smoke_Test
    - `src/main.tsx` renders `<App />` into `#root`. `src/App.tsx` has a named export `App` that renders `<h1>HyperGeist</h1>` and nothing else.
    - `src/App.test.tsx` renders `App` and asserts `getByRole('heading', { name: 'HyperGeist' })` is truthy, without `jest-dom`.
    - _Requirements: 9.1, 9.2, 9.3, 9.7, 16.1_

- [x] 6. Create the Worker_App (`apps/worker`)
  - [x] 6.1 Write the manifest, configs, and `wrangler.jsonc`
    - `package.json`: name `@hypergeist/worker`, `private`, `type: module`, scripts `dev` (`wrangler dev --port 8787`), `build` (`wrangler deploy --dry-run --outdir dist`), `typecheck`, `test`. No dependency fields yet (task 9.2 adds them).
    - `tsconfig.json`: extends the base, `lib: [ES2022]`, `types: ["@cloudflare/workers-types"]`, include `src` and `vitest.config.ts`.
    - `vitest.config.ts`: `name: 'worker'`, `environment: 'node'`.
    - `wrangler.jsonc`: `name: hypergeist`, `main: src/index.ts`, `compatibility_date` set to today's date (get it with `date +%F`, never a future date), and `assets` with `directory: ../web/dist`, `binding: ASSETS`, `not_found_handling: single-page-application`, `run_worker_first: ["/api/*"]`. No `vars`, no secrets.
    - _Requirements: 2.4, 3.2, 3.5, 10.1, 10.2, 10.3, 10.4, 10.9, 11.2, 11.3_

  - [x] 6.2 Write the Hono app and Workers entry
    - `src/app.ts`: `export const app = new Hono()` with `GET /api/health` returning `{ ok: true }`, `notFound` returning `{ error: 'Not found' }` with 404, and `onError` returning `{ error: 'Internal error' }` with 500 and no error detail. No CORS middleware.
    - `src/index.ts`: `export default app;`.
    - _Requirements: 10.5, 10.6, 10.7, 16.1_

  - [x] 6.3 Write the Worker Smoke_Test `src/app.test.ts`
    - Using `app.request`: `/api/health` returns 200 and `{ ok: true }`; `/api/unknown` and `POST /api/health` return 404 with the generic body; no response has an `access-control-*` header.
    - _Requirements: 10.5, 10.6, 10.7, 10.8_

- [x] 7. Create the E2E smoke test and the CI workflow
  - [x] 7.1 Write `e2e/tsconfig.json` and `e2e/smoke.spec.ts`
    - `e2e/tsconfig.json`: extends the base, `lib: [ES2022, DOM]`, `types: ["node"]`, `allowImportingTsExtensions: true`, include `.`.
    - Test 1: load `/`, assert the heading "HyperGeist" is visible, and assert every recorded request URL has the app origin (so no AI provider host is contacted).
    - Test 2: `GET /api/health` returns 200 and `{ ok: true }`.
    - Test 3: load `/some/unknown/path` and see the heading (SPA fallback); `GET /api/nope` returns 404 with a JSON body.
    - _Requirements: 9.6, 10.3, 12.3, 12.4_

  - [x] 7.2 Write `.github/workflows/ci.yml`
    - Single `verify` job, `permissions: contents: read`, triggers on push and pull request to `main`, `concurrency` group, `timeout-minutes: 20`.
    - Steps with distinct names, in order: checkout, `pnpm/action-setup` (reads `packageManager`), `actions/setup-node` with `node-version-file: package.json` and `cache: pnpm`, Install dependencies (`pnpm install --frozen-lockfile`), Type check, Lint, Format check, Dependency rules, Unit tests, Build, Install Playwright Chromium (`pnpm exec playwright install --with-deps chromium`), E2E smoke test, and a failure-only Playwright report upload.
    - Before writing, check for newer major versions of the actions used and prefer the latest. No secrets, no Cloudflare credentials, no deploy job.
    - _Requirements: 7.7, 11.4, 12.7, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_

- [x] 8. Checkpoint - pnpm must be installed by the user
  - Run `pnpm -v`.
  - If the command fails or pnpm is not found, STOP. Tell the user pnpm is not installed and ask them to install it (for example `corepack enable`, or `npm install -g pnpm` on Node versions without Corepack), then wait for their confirmation and re-run `pnpm -v`. Do NOT install pnpm, run `corepack`, or run `npm install -g` yourself.
  - If it succeeds, record the version for task 9.1 and continue.
  - Confirm that no earlier task ran an install command.
  - _Requirements: 16.4, 16.5_

- [x] 9. Install dependencies and create the lockfile
  - [x] 9.1 Pin the pnpm version in the root `package.json`
    - Set `packageManager` to `pnpm@<exact version from pnpm -v>`.
    - _Requirements: 2.2, 13.6_

  - [x] 9.2 Add all dependencies with `pnpm add`, which creates `pnpm-lock.yaml`
    - Run the commands one after another (they write the same lockfile).
    - Root (`-w`, dev): `typescript@~6.0.0` (TypeScript 7's JavaScript compiler API is not stable until 7.1, and `typescript-eslint` and `ts.preProcessFile` in the Dependency_Check need 6.x), `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`, `vitest`, `@playwright/test`, `@types/node`.
    - `@hypergeist/shared`: dependency `zod@^4`; dev `fast-check`, `vitest`, `@types/node`.
    - `@hypergeist/web`: dependencies `react`, `react-dom`, `@hypergeist/shared@workspace:*`; dev `vite`, `@vitejs/plugin-react`, `@testing-library/react`, `@testing-library/dom`, `@types/react`, `@types/react-dom`, `jsdom`, `vitest`.
    - `@hypergeist/worker`: dependencies `hono`, `@hypergeist/shared@workspace:*`; dev `wrangler`, `@cloudflare/workers-types`, `vitest`.
    - Confirm that `zod` resolved to a 4.x version and that `pnpm-lock.yaml` exists at the repo root.
    - _Requirements: 2.5, 13.2, 13.9, 16.2, 16.3, 16.4, 16.6_

  - [x] 9.3 Handle dependency build scripts (`approve-builds`)
    - Run `pnpm ignored-builds` to list packages whose install scripts were skipped. `pnpm approve-builds` is interactive, so do not run it unattended; edit the `allowBuilds` map in `pnpm-workspace.yaml` by hand instead (pnpm 12 ignores `onlyBuiltDependencies`).
    - Keep `esbuild: true` and `workerd: true`. Add any other package from the list that Vite, Vitest, or Wrangler needs (for example `sharp`). Leave unrelated packages out.
    - Run `pnpm install` again so the approved builds run, then confirm `pnpm ignored-builds` lists nothing that is needed.
    - _Requirements: 16.2, 16.4, 16.7_

  - [x] 9.4 Verify the lockfile is in sync
    - Run `pnpm install --frozen-lockfile` and confirm it exits 0. Do not commit, push, or deploy; leave the lockfile for the Developer to commit.
    - Confirm `git check-ignore pnpm-lock.yaml` prints nothing.
    - _Requirements: 13.2, 13.9_

- [x] 10. Install the Playwright browser
  - [x] 10.1 Install Chromium for Playwright
    - Run `pnpm exec playwright install chromium` (no `--with-deps` locally).
    - _Requirements: 12.1, 13.5_

- [x] 11. Write the README
  - [x] 11.1 Write `README.md`
    - One paragraph describing HyperGeist and the Kiroween 2026 category (Resurrection).
    - Supported Node range and the exact pinned pnpm version from `packageManager`.
    - pnpm install steps: Corepack (`corepack enable`), and `npm install -g pnpm` for Node versions without Corepack (including Node 25), with a note to install the pinned version.
    - `pnpm install`, every root script, and local development: run `pnpm build` once, then the Worker dev server on port 8787 and the Vite dev server with its `/api` proxy.
    - Seed variable `HYPERGEIST_TEST_SEED` and the replay command `HYPERGEIST_TEST_SEED=<seed> pnpm --filter @hypergeist/shared test`.
    - Repository layout and the single-origin deployment shape; secrets are set with `wrangler secret`.
    - `.kiro/` is committed on purpose and must stay out of `.gitignore`; all project code is newly written after October 30, 2026; MIT license with a link to `LICENSE`. No API key or secret value.
    - _Requirements: 8.9, 10.9, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9_

- [x] 12. Run the full verification
  - [x] 12.1 Format and lint
    - Run `pnpm format`, then `pnpm format:check` and `pnpm lint`. Fix any error and re-run until both exit 0.
    - _Requirements: 4.5, 4.6, 4.7, 5.6_

  - [x] 12.2 Type check
    - Run `pnpm typecheck`. All three packages plus `scripts/` and `e2e/` must report zero errors.
    - _Requirements: 3.6_

  - [x] 12.3 Dependency check and unit tests
    - Run `pnpm check:deps` (exit 0 on the real tree), then `pnpm test` (single run). All Smoke_Tests, the seed unit test, the smoke property test, and the check-deps fixture test must pass. Optional property tests run if they were written.
    - _Requirements: 4.4, 7.5, 7.6, 8.1, 8.2, 8.8, 9.3, 10.8_

  - [x] 12.4 Build with the Wrangler dry run
    - Run `pnpm build`. Confirm exit 0, that `apps/web/dist/index.html` exists, and that the Wrangler dry run was the last step and ran without a Cloudflare login.
    - _Requirements: 4.3, 9.4, 11.1, 11.2, 11.3_

  - [x] 12.5 Playwright smoke test
    - Run `pnpm test:e2e` after the build. The suite must pass against `wrangler dev` on port 8787.
    - _Requirements: 4.8, 12.2, 12.3, 12.4, 12.6_

  - [x] 12.6 Final repository checks
    - Run `git check-ignore .kiro` (must print nothing, exit 1) and `git status --short` to confirm `.kiro/` and `pnpm-lock.yaml` show as untracked or modified, not ignored. Do not commit, push, or deploy.
    - Grep the repo (excluding `node_modules`) to confirm no API key or secret value is present.
    - _Requirements: 1.5, 1.6, 2.6, 13.7, 13.9, 14.9_

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional property tests (Properties 1 to 5 from the design). The required property smoke test (task 3.5) and all unit and smoke tests are not optional.
- Files written before task 9 cannot be type checked or run until the install finishes; their verification is in task 12.
- Design Open Items resolved here: `jsdom` and `@testing-library/dom` are added as web dev dependencies (the latter is a peer of `@testing-library/react`); the Worker entry gets an ESLint default-export override; `engines.node` is `>=22.18.0 <25`; `.kiro` and the brief are excluded from Prettier; `compatibility_date` and `packageManager` are filled during implementation.
- No task commits, pushes, or deploys. The Developer commits the lockfile.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "3.1", "5.1", "6.1", "7.2"] },
    { "id": 1, "tasks": ["3.2", "3.3", "4.1", "5.2", "6.2", "7.1"] },
    { "id": 2, "tasks": ["3.4", "3.5", "3.6", "4.2", "6.3"] },
    { "id": 3, "tasks": ["3.7", "4.3", "4.4"] },
    { "id": 4, "tasks": ["4.5"] },
    { "id": 5, "tasks": ["4.6"] },
    { "id": 6, "tasks": ["9.1"] },
    { "id": 7, "tasks": ["9.2"] },
    { "id": 8, "tasks": ["9.3"] },
    { "id": 9, "tasks": ["9.4", "10.1", "11.1"] },
    { "id": 10, "tasks": ["12.1"] },
    { "id": 11, "tasks": ["12.2", "12.3"] },
    { "id": 12, "tasks": ["12.4"] },
    { "id": 13, "tasks": ["12.5"] },
    { "id": 14, "tasks": ["12.6"] }
  ]
}
```
