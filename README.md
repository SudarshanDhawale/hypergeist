# HyperGeist

HyperGeist is a browser-based retro "stack" environment inspired by HyperCard. You describe a small
tool in plain English, and AI builds it as a living, editable set of linked cards with buttons,
fields, lists, logic, and AI-powered fields. You can use the stack, edit it by hand, or reshape it by
talking to it. It is an entry in the Kiroween 2026 hackathon, in the **Resurrection** category.

This repository currently holds the project scaffold: the monorepo, tooling, CI, and a placeholder
page and health endpoint. Product features arrive through later specs.

## Requirements

- Node.js `>=22.18.0 <25` (the `engines.node` range in the root `package.json`).
- pnpm `12.18.0`, the exact version pinned in the `packageManager` field of the root
  `package.json`.

## Installing pnpm

Install the pinned version, `12.18.0`. A different pnpm version can resolve dependencies
differently from CI.

With Corepack, which is bundled with Node versions that include it:

```sh
corepack enable
```

Corepack then reads `packageManager` and uses the pinned pnpm version automatically.

Node versions that do not bundle Corepack (including Node 25) need pnpm installed through npm.
Install the pinned version explicitly:

```sh
npm install -g pnpm@12.18.0
```

Check the result with `pnpm -v`. Node 25 is outside the supported range above, so this path matters
mainly for other Node versions without Corepack.

## Getting started

```sh
pnpm install
```

Dependency build scripts are controlled by `allowBuilds` in `pnpm-workspace.yaml`. pnpm 11 and later
use `allowBuilds`, not `onlyBuiltDependencies`. `esbuild` and `workerd` are allowed.

TypeScript is pinned to 6.0.x on purpose. TypeScript 7 does not yet provide the stable JavaScript
compiler API that typescript-eslint and the dependency check script need.

When you add a workspace dependency with `pnpm add`, quote the spec so zsh does not expand it:

```sh
pnpm --filter @hypergeist/web add '@hypergeist/shared@workspace:*'
```

## Root scripts

Run these from the repository root.

- `pnpm build`: builds the shared package, then the web app, then runs the Worker's Wrangler dry
  run. It fails if any step fails.
- `pnpm test`: runs every Vitest suite once (no watch mode).
- `pnpm typecheck`: type checks all workspace packages, the `scripts/` folder, and `e2e/`.
- `pnpm lint`: runs ESLint over the repository.
- `pnpm format`: rewrites files with Prettier.
- `pnpm format:check`: reports files that Prettier would change, without modifying them.
- `pnpm check:deps`: scans `apps/` and `packages/` for imports that break the dependency rules
  (see Repository layout).
- `pnpm test:e2e`: runs the Playwright smoke test against `wrangler dev`. Run `pnpm build` first.

Playwright needs its Chromium browser once per machine:

```sh
pnpm exec playwright install chromium
```

## Local development

1. Build once, so the Worker has a built web app in `apps/web/dist` to serve:

   ```sh
   pnpm build
   ```

2. Start the Worker dev server on port 8787:

   ```sh
   pnpm --filter @hypergeist/worker dev
   ```

3. In a second terminal, start the Vite dev server (port 5173):

   ```sh
   pnpm --filter @hypergeist/web dev
   ```

   Vite proxies every request whose path starts with `/api` to the Worker at
   `http://localhost:8787`. Open the Vite URL while developing the web app. Opening
   `http://localhost:8787` serves the last built copy of the web app and the API from the Worker.

## Reproducible property tests

Property tests use fast-check. The seed comes from the environment variable
`HYPERGEIST_TEST_SEED`:

- If it is unset or empty, a random seed is generated for the run.
- If it is set, it must be a 32-bit signed integer. Any other value makes the test helper throw an
  error that names the variable and the invalid value.
- When a property fails, the helper prints the seed and the command that replays the run.

To replay a failing run:

```sh
HYPERGEIST_TEST_SEED=<seed> pnpm --filter @hypergeist/shared test
```

Replace `<seed>` with the number printed by the failing run.

## Repository layout

```text
hypergeist/
├── .github/workflows/   CI workflow (no deploy job)
├── .kiro/               Kiro specs, steering, and hooks (committed on purpose)
├── apps/
│   ├── web/             React + Vite app (@hypergeist/web)
│   └── worker/          Hono app on Cloudflare Workers (@hypergeist/worker)
├── docs/                project brief, asset licenses, Kiro journal
├── e2e/                 Playwright smoke test
├── packages/
│   └── shared/          shared package (@hypergeist/shared)
└── scripts/check-deps/  dependency-rule check behind `pnpm check:deps`
```

Dependency rules, enforced by `pnpm check:deps`:

- `packages/shared` imports nothing from `apps/`.
- `apps/web` and `apps/worker` never import each other.
- Apps import the shared package only through `@hypergeist/shared`, `@hypergeist/shared/format`, or
  `@hypergeist/shared/engine`.

## Deployment shape

One Cloudflare Worker serves both the built web app and the API. The Worker's Wrangler configuration
(`apps/worker/wrangler.jsonc`) has an assets binding that points at `apps/web/dist`. Requests whose
path starts with `/api` run the Worker code first. Other requests are served from the assets, and
unknown non-API paths fall back to `index.html`. The browser and the API share one origin, so no CORS
setup is needed.

Secrets are never written into `wrangler.jsonc` or any other file in the repository. Set them with
`wrangler secret`, for example `wrangler secret put <NAME>` from `apps/worker`. The scaffold needs no
secrets yet, and the CI workflow defines none.

## The `.kiro/` directory

The `.kiro/` directory holds the project's specs, steering files, and hooks. It is committed on
purpose, as part of the hackathon submission. Never add `.kiro` to `.gitignore`.

## Originality

All project code is newly written after October 30, 2026.

## License

MIT. See [LICENSE](LICENSE).
