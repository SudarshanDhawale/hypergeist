# Requirements Document

## Introduction

This spec covers the initial scaffold of the HyperGeist repository: a pnpm monorepo with three packages (`packages/shared`, `apps/web`, `apps/worker`), the shared tooling (TypeScript, ESLint, Prettier, Vitest, fast-check, Playwright), a GitHub Actions pipeline, and the top-level documents required for the Kiroween 2026 submission.

The scaffold contains configuration and one trivial smoke test per package. It contains no stack format, engine, UI shell, AI orchestrator, or service code. Those belong to later specs.

Deployment shape: one Cloudflare Worker serves the built web app as static assets and also serves the `/api` routes, so the browser and the API share one origin and need no CORS setup.

The tech stack and tooling choices are locked in the workspace steering files (`tech-stack`, `architecture`, `conventions`). This spec does not restate them except where a requirement depends on them.

## Glossary

- **Repository**: The git repository at the workspace root, `hypergeist/`.
- **Developer**: A person who clones the Repository and works on it locally.
- **Workspace_Package**: One of the three pnpm workspace members: Shared_Package, Web_App, or Worker_App.
- **Shared_Package**: The package at `packages/shared`, named `@hypergeist/shared`.
- **Web_App**: The package at `apps/web`, named `@hypergeist/web`, a React and Vite application.
- **Worker_App**: The package at `apps/worker`, named `@hypergeist/worker`, a Hono application deployed as a Cloudflare Worker.
- **Public_Index**: The `src/index.ts` file of the Shared_Package, plus the declared subpath entry points `./format` and `./engine`.
- **Dependency_Check**: A script run from the repository root that scans Workspace_Package source files and reports import statements that violate the dependency rules in the `architecture` steering file.
- **Root_Scripts**: The scripts defined in the root `package.json`.
- **Test_Seed**: An integer that initializes the fast-check random number generator for a property test run.
- **Seed_Variable**: The environment variable `HYPERGEIST_TEST_SEED`, which supplies the Test_Seed.
- **Smoke_Test**: A minimal test that confirms a package is wired correctly and carries no product logic.
- **E2E_Smoke_Test**: The Playwright Smoke_Test that loads the placeholder page of the Web_App.
- **Placeholder_Page**: The single page of the Web_App that displays the text "HyperGeist" and nothing else of product significance.
- **Health_Endpoint**: The Worker_App route `GET /api/health`.
- **Deployable_Output**: The result of `pnpm build`: the built Web_App in `apps/web/dist` and a Worker_App that references that directory through a Wrangler assets binding.
- **CI_Workflow**: The GitHub Actions workflow file under `.github/workflows/`.
- **Lockfile**: The `pnpm-lock.yaml` file at the repository root.

## Requirements

### Requirement 1: Repository Initialization, License, and Ignore File

**User Story:** As a Developer, I want the repository initialized with a license and a correct ignore file, so that the project is a valid open-source submission from the first commit.

#### Acceptance Criteria

1. THE Repository SHALL be a git repository whose default branch is named `main`.
2. THE Repository SHALL contain a `LICENSE` file at the repository root holding the MIT License text.
3. THE `LICENSE` file SHALL name the HyperGeist project authors as the copyright holder and give 2026 as the copyright year.
4. THE Repository SHALL contain a `.gitignore` file that ignores `node_modules`, build output directories (`dist`), `.wrangler`, `.dev.vars`, `.env` files, `*.tsbuildinfo`, `coverage`, Playwright output directories (`test-results`, `playwright-report`), and `.DS_Store`.
5. THE `.gitignore` file SHALL contain no pattern that matches the `.kiro` directory or any file inside the `.kiro` directory.
6. WHEN the command `git check-ignore -v .kiro/specs/repo-scaffold/requirements.md` is run at the repository root, THE Repository SHALL report that the path is not ignored.
7. THE Repository SHALL contain a `.env.example` file that lists variable names without values and holds no secrets.

### Requirement 2: pnpm Workspace and Pinned Tooling

**User Story:** As a Developer, I want a pnpm workspace with pinned tooling versions, so that every machine and CI run resolves the same package manager.

#### Acceptance Criteria

1. THE Repository SHALL contain a `pnpm-workspace.yaml` file that includes `apps/*` and `packages/*`.
2. THE root `package.json` SHALL be marked `private: true` and SHALL declare a `packageManager` field with an exact pnpm version.
3. THE root `package.json` SHALL declare an `engines.node` range that matches the Node version used by the CI_Workflow.
4. THE Repository SHALL contain the Workspace_Packages `@hypergeist/shared`, `@hypergeist/web`, and `@hypergeist/worker`, each with its own `package.json` and `tsconfig.json`.
5. WHEN a Workspace_Package depends on the Shared_Package, THE Workspace_Package `package.json` SHALL declare that dependency with the `workspace:*` protocol.
6. THE Repository SHALL commit `.kiro/` at the repository root alongside the Workspace_Packages.

### Requirement 3: Strict TypeScript Baseline

**User Story:** As a Developer, I want one strict TypeScript baseline, so that every package compiles under the same rules.

#### Acceptance Criteria

1. THE Repository SHALL contain one `tsconfig.base.json` at the repository root with `strict` set to `true`.
2. THE `tsconfig.json` of each Workspace_Package SHALL extend `tsconfig.base.json`.
3. THE Shared_Package `tsconfig.json` SHALL exclude the `DOM` library and Cloudflare Worker type definitions, so that references to browser or Worker APIs fail type checking.
4. THE Web_App `tsconfig.json` SHALL include the `DOM` library.
5. THE Worker_App `tsconfig.json` SHALL include Cloudflare Worker type definitions.
6. WHEN `pnpm typecheck` runs on the scaffold, THE Repository SHALL complete type checking of all three Workspace_Packages with zero errors.

### Requirement 4: Root Scripts

**User Story:** As a Developer, I want a fixed set of root scripts, so that I can build, test, and check the whole repository with one command each.

#### Acceptance Criteria

1. THE Root_Scripts SHALL define `build`, `test`, `typecheck`, `lint`, and `format`.
2. THE Root_Scripts SHALL define `format:check`, `check:deps`, and `test:e2e`.
3. WHEN `pnpm build` runs, THE Root_Scripts SHALL build the Shared_Package, then the Web_App, then the Worker_App check, and exit with a non-zero code if any step fails.
4. WHEN `pnpm test` runs, THE Root_Scripts SHALL run the Vitest suites of every Workspace_Package in single-run mode, not watch mode.
5. WHEN `pnpm lint` runs, THE Root_Scripts SHALL run ESLint over all Workspace_Packages.
6. WHEN `pnpm format` runs, THE Root_Scripts SHALL rewrite files with Prettier formatting.
7. WHEN `pnpm format:check` runs, THE Root_Scripts SHALL report unformatted files and exit with a non-zero code without modifying any file.
8. WHEN `pnpm test:e2e` runs, THE Root_Scripts SHALL run the Playwright suite.

### Requirement 5: ESLint and Prettier

**User Story:** As a Developer, I want ESLint and Prettier configured once at the root, so that code style is consistent and enforced.

#### Acceptance Criteria

1. THE Repository SHALL contain one root ESLint configuration that covers TypeScript files in all Workspace_Packages.
2. THE ESLint configuration SHALL report an error for each use of the `any` type.
3. THE ESLint configuration SHALL report an error for each non-null assertion (`!`) operator.
4. THE ESLint configuration SHALL report an error for each default export in files outside framework-required locations (Vite, Playwright, and Vitest configuration files).
5. THE Repository SHALL contain one root Prettier configuration and a Prettier ignore file that excludes build output and the Lockfile.
6. WHEN `pnpm lint` and `pnpm format:check` run on the scaffold, THE Repository SHALL report zero errors.

### Requirement 6: Shared Package Public API

**User Story:** As a Developer, I want the Shared_Package to expose a small public API, so that apps cannot depend on shared internals.

#### Acceptance Criteria

1. THE Shared_Package `package.json` SHALL declare an `exports` map that exposes `.`, `./format`, and `./engine` and no other entry point.
2. THE Shared_Package SHALL provide `src/index.ts`, `src/format/index.ts`, and `src/engine/index.ts` as the targets of those entry points.
3. WHEN an application file imports from `@hypergeist/shared` with a path other than `@hypergeist/shared`, `@hypergeist/shared/format`, or `@hypergeist/shared/engine`, THE Dependency_Check SHALL report a violation that names the file and the import path.
4. THE `src/format/index.ts` and `src/engine/index.ts` files SHALL contain only an empty export, because stack format and engine code belong to later specs.
5. THE Shared_Package SHALL contain no import of application code, no browser API reference, and no Cloudflare Worker API reference.

### Requirement 7: Dependency-Rule Check

**User Story:** As a Developer, I want an automated dependency-rule check, so that architecture rules are enforced by tooling and not by memory.

#### Acceptance Criteria

1. WHEN `pnpm check:deps` runs, THE Dependency_Check SHALL scan all `.ts` and `.tsx` source files under `apps/` and `packages/`.
2. IF a file under `packages/shared` imports a path that resolves into `apps/`, THEN THE Dependency_Check SHALL report a violation and exit with a non-zero code.
3. IF a file under `apps/web` imports a path that resolves into `apps/worker`, or a file under `apps/worker` imports a path that resolves into `apps/web`, THEN THE Dependency_Check SHALL report a violation and exit with a non-zero code.
4. IF a file under `apps/` imports a Shared_Package path outside the Public_Index, THEN THE Dependency_Check SHALL report a violation and exit with a non-zero code.
5. WHEN the scan finds no violation, THE Dependency_Check SHALL exit with code zero.
6. THE Dependency_Check SHALL include a Vitest test that runs the check against fixture files containing one violation of each kind in criteria 2, 3, and 4, and asserts that each is reported.
7. THE CI_Workflow SHALL run `pnpm check:deps` as a required step.

### Requirement 8: Vitest, fast-check, and Reproducible Seeds

**User Story:** As a Developer, I want Vitest and fast-check set up in the Shared_Package with a reproducible seed convention, so that property-test failures can be replayed.

#### Acceptance Criteria

1. THE Shared_Package SHALL contain a Vitest configuration and a Smoke_Test named `*.test.ts` that runs under `pnpm test`.
2. THE Shared_Package SHALL contain one fast-check property test named `*.property.test.ts` that asserts a trivial invariant, such as addition of two integers being commutative.
3. THE Shared_Package SHALL provide a test helper that reads the Test_Seed from the Seed_Variable and passes the Test_Seed to every fast-check run.
4. WHERE the Seed_Variable is unset, THE test helper SHALL generate a Test_Seed at the start of the test run.
5. IF the Seed_Variable is set to a value that is not a 32-bit signed integer, THEN THE test helper SHALL throw an error that names the Seed_Variable and the invalid value.
6. WHEN a fast-check property fails, THE test helper SHALL print the Test_Seed and the command that replays the run with that Test_Seed.
7. WHEN the same Test_Seed is supplied twice through the Seed_Variable, THE test helper SHALL cause fast-check to generate the same sequence of inputs in both runs.
8. THE test helper SHALL have a unit test covering criteria 4, 5, and 7.
9. THE README SHALL document the Seed_Variable and the replay command.

### Requirement 9: Web App Placeholder

**User Story:** As a Developer, I want a minimal React and Vite Web_App, so that later specs have a build and dev pipeline to build on.

#### Acceptance Criteria

1. THE Web_App SHALL be built with Vite and React and SHALL render the Placeholder_Page into a root element.
2. THE Placeholder_Page SHALL display the heading text "HyperGeist".
3. THE Web_App SHALL contain a Vitest configuration and one Smoke_Test that renders the Placeholder_Page and asserts the heading text.
4. WHEN `pnpm --filter @hypergeist/web build` runs, THE Web_App SHALL write the production build to `apps/web/dist`.
5. WHILE the Vite dev server runs, THE Web_App SHALL proxy requests whose path starts with `/api` to the Worker_App dev server at `http://localhost:8787`.
6. THE Web_App SHALL load no external network resource at page load.
7. THE Web_App SHALL contain no application logic beyond the Placeholder_Page, and PWA manifest and service worker setup SHALL be left to a later spec.

### Requirement 10: Worker App and Single-Origin Serving

**User Story:** As a Developer, I want a minimal Hono Worker that serves the built app and the API from one origin, so that deployment is a single target without CORS configuration.

#### Acceptance Criteria

1. THE Worker_App SHALL be a Hono application with a Wrangler configuration file that sets `main`, a `compatibility_date`, and an `assets` binding whose directory is `../web/dist`.
2. WHEN a request arrives for a path outside `/api`, THE Worker_App SHALL serve the matching static asset from the assets binding.
3. WHEN a request for a non-API path matches no static asset, THE Worker_App SHALL serve `index.html` from the assets binding.
4. THE Wrangler configuration SHALL route requests whose path starts with `/api` to the Worker_App code before the assets binding.
5. WHEN a client sends `GET /api/health`, THE Worker_App SHALL respond with status 200 and a JSON body `{"ok":true}`.
6. IF a client sends a request to an `/api` path that has no route, THEN THE Worker_App SHALL respond with status 404 and a JSON body that carries a generic error message and no internal detail.
7. THE Worker_App SHALL add no CORS headers, because the browser and the API share one origin.
8. THE Worker_App SHALL contain a Vitest configuration and one Smoke_Test that calls the Hono application directly and asserts the response of the Health_Endpoint and the 404 response of an unknown `/api` path.
9. THE Worker_App SHALL declare no secret value in `wrangler.toml` or `wrangler.jsonc`, and the README SHALL state that secrets are set with `wrangler secret`.

### Requirement 11: Deployable Build Output

**User Story:** As a Developer, I want the build to produce one deployable output, so that a later deploy job needs only the build artifacts.

#### Acceptance Criteria

1. WHEN `pnpm build` completes with exit code zero, THE Repository SHALL contain `apps/web/dist/index.html`.
2. WHEN `pnpm build` completes with exit code zero, THE Worker_App SHALL be bundle-checkable by Wrangler through a dry run (`wrangler deploy --dry-run`) without a Cloudflare account login.
3. THE `pnpm build` script SHALL run the Wrangler dry run as its last step, so that a broken assets binding or Worker entry point fails the build.
4. THE Repository SHALL contain no deploy job in the CI_Workflow in this spec.

### Requirement 12: Playwright Smoke Test

**User Story:** As a Developer, I want a Playwright smoke test wired into the repository, so that end-to-end checks exist from the first commit and never depend on a live model.

#### Acceptance Criteria

1. THE Repository SHALL contain a Playwright configuration that targets Chromium.
2. THE Playwright configuration SHALL start the built application through the Worker_App dev server (`wrangler dev`) so that the test runs against the same single-origin setup used in deployment.
3. THE E2E_Smoke_Test SHALL load the root URL, assert that the heading "HyperGeist" is visible, and assert that `GET /api/health` returns status 200 with body `{"ok":true}`.
4. THE E2E_Smoke_Test SHALL issue no request to any AI provider host.
5. THE Playwright configuration SHALL set a test timeout of 30 seconds and a web server start timeout of 120 seconds.
6. WHEN `pnpm test:e2e` runs after `pnpm build`, THE Playwright suite SHALL pass.
7. IF a Playwright test fails in CI, THEN THE CI_Workflow SHALL upload the Playwright report as a build artifact.

### Requirement 13: Continuous Integration

**User Story:** As a Developer, I want a CI pipeline, so that every push and pull request is checked automatically.

#### Acceptance Criteria

1. WHEN a push to `main` or a pull request to `main` occurs, THE CI_Workflow SHALL start.
2. THE CI_Workflow SHALL install dependencies with `pnpm install --frozen-lockfile`.
3. THE CI_Workflow SHALL run, as separate jobs or steps with distinct names, type checking, linting with format checking, the dependency check, unit tests, and the E2E_Smoke_Test.
4. THE CI_Workflow SHALL build the Deployable_Output before the E2E_Smoke_Test runs.
5. THE CI_Workflow SHALL install the Playwright Chromium browser before the E2E_Smoke_Test runs.
6. THE CI_Workflow SHALL use the pnpm version and Node version declared in the root `package.json`.
7. THE CI_Workflow SHALL define no secret, API key, or Cloudflare credential.
8. THE CI_Workflow SHALL set `permissions` to `contents: read`.
9. WHEN `pnpm install` first generates the Lockfile, THE Developer SHALL commit the Lockfile, because criterion 2 fails without it.

### Requirement 14: README

**User Story:** As a reviewer or contributor, I want a README with exact setup steps, so that I can run the project without guessing.

#### Acceptance Criteria

1. THE README SHALL contain a one-paragraph description of HyperGeist and its Kiroween 2026 category (Resurrection).
2. THE README SHALL list the supported Node version and the pinned pnpm version.
3. THE README SHALL document installing pnpm through Corepack (`corepack enable`) and, for Node versions that do not bundle Corepack (including Node 25), through `npm install -g pnpm`, with a note to install the version pinned in `packageManager`.
4. THE README SHALL document `pnpm install`, each Root_Script, and the commands for local development: the Worker_App dev server on port 8787 and the Vite dev server with its `/api` proxy.
5. THE README SHALL describe the repository layout and the single-origin deployment shape.
6. THE README SHALL state that `.kiro/` is committed on purpose and must stay out of `.gitignore`.
7. THE README SHALL state that all project code is newly written after October 30, 2026.
8. THE README SHALL state the MIT license and link to `LICENSE`.
9. THE README SHALL contain no API key or secret value.

### Requirement 15: Documentation Placeholders

**User Story:** As the project owner, I want placeholder documents for asset licenses and the Kiro journal, so that submission records are collected from the start.

#### Acceptance Criteria

1. THE Repository SHALL contain `docs/assets-licenses.md` with a table whose columns are Asset, Source URL, License, Used in, and Date added, and with no data rows.
2. THE `docs/assets-licenses.md` file SHALL include one sentence stating that every fonts, sounds, icons, and images entry requires a license that permits redistribution.
3. THE Repository SHALL contain `docs/kiro-journal.md` with a heading, a one-paragraph purpose statement, and an entry template of date, what was done with Kiro, what worked, and what did not.
4. THE `docs/kiro-journal.md` file SHALL contain no journal entry.

### Requirement 16: Scaffold Scope Limits

**User Story:** As the project owner, I want this spec limited to scaffolding, so that product code arrives through its own specs.

#### Acceptance Criteria

1. THE scaffold SHALL contain no source code beyond configuration files, the Placeholder_Page, the Health_Endpoint and its 404 handler, the empty Public_Index entry points, the test seed helper, the Dependency_Check, and one Smoke_Test per Workspace_Package.
2. THE scaffold SHALL add as runtime or dev dependencies only: React, React DOM, Vite and its React plugin, Hono, Wrangler, `@cloudflare/workers-types`, Zod, TypeScript, ESLint with its TypeScript plugin and config packages, Prettier, Vitest, fast-check, Playwright with `@playwright/test`, and Testing Library packages needed by the Web_App Smoke_Test.
3. THE scaffold SHALL declare Zod 4 as a dependency of the Shared_Package without importing Zod in any source file.
4. WHEN the implementation phase for this spec runs, THE spec task list SHALL define the dependency installation as an explicit task that follows the Developer installing pnpm, and no earlier task SHALL run `pnpm install`.
5. IF pnpm is not available on the machine when a task needs it, THEN THE task SHALL stop and instruct the Developer to install pnpm as documented in the README.
