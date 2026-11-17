# HyperGeist

HyperGeist is a browser-based retro "stack" environment inspired by HyperCard. You describe a small
tool in plain English, and AI builds it as a living, editable set of linked cards with buttons,
fields, lists, logic, and AI-powered fields. You can use the stack, edit it by hand, or reshape it by
talking to it. It is an entry in the Kiroween 2026 hackathon, in the **Resurrection** category.

This repository holds the monorepo scaffold and the first thin slice of the product: a stack format
with a validator, a pure action engine, a command-line validator, and a retro desktop that plays one
small to-do stack. Stacks are saved in the browser, and a Stacks window opens, exports, imports, and
deletes them. AI and sharing are not built yet (see [Limits](#limits-of-the-thin-slice)).

## What the app does today

Opening the app shows a retro desktop with a menu bar, one stack window, and a Ghost window.

- **The to-do stack.** The first time the app opens in a browser, it stores a bundled stack of three
  cards: To-do, About, and Limits, and opens it. On the To-do card you type a task into the "New
  item" field and press Add. The task appears in the list below. Links and buttons move between the
  three cards. The stack file is `apps/web/src/stacks/thin-slice-todo.json`. The app checks every
  bundled stack and every stored stack before it uses it.
- **Saving.** The app saves the open stack in the browser about a second after your last change.
  The stack window shows "Saved", "Saving", or "Not saved". After a reload, the app opens the stack
  you had open last. See [Saving and the Stacks window](#saving-and-the-stacks-window).
- **The Stacks window.** The Stacks button in the menu bar opens it. It lists your stacks and lets
  you open, export, and delete them. It also imports a stack file, restores the demo stacks, and
  keeps a trash for deleted stacks.
- **Interact mode.** The default. Buttons run their actions, fields take typing (read-only fields
  do not), and links navigate.
- **Edit mode.** Click an object to select it. The selected object gets a dashed outline with
  handles, and a read-only panel lists its properties. Nothing runs in Edit mode, and nothing can
  be changed there (see the limits below). Escape clears the selection.
- **Switching modes.** Use the Interact / Edit radio group in the menu bar, or press Alt+M. A hint
  line at the bottom of the stack window names the shortcut. It also shows messages from actions,
  such as "Item added.", for four seconds.
- **The Ghost.** A sleeping placeholder in a side window. It does nothing yet and says "AI arrives
  in a later release".

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
- `pnpm stack validate <file>`: validates a stack file (see
  [Validating a stack file](#validating-a-stack-file)).
- `pnpm test:e2e`: runs the Playwright tests against `wrangler dev`. Run `pnpm build` first.

Playwright needs its Chromium browser once per machine:

```sh
pnpm exec playwright install chromium
```

Run `pnpm test:e2e` in a normal terminal. Chromium cannot start inside some sandboxed environments
(such as an AI agent's shell), where the tests fail before they reach the app.

## Local development

1. Install dependencies and build once, so the Worker has a built web app in `apps/web/dist` to
   serve:

   ```sh
   pnpm install
   pnpm build
   ```

2. Start the Worker dev server on port 8787:

   ```sh
   pnpm --filter @hypergeist/worker dev
   ```

3. Open `http://localhost:8787`. The Worker serves the last built copy of the web app and the API
   from one origin. After you change web code, run `pnpm build` again and reload.

Optionally, for hot reload while you work on the web app, start the Vite dev server in a second
terminal (port 5173) and open `http://localhost:5173`:

```sh
pnpm --filter @hypergeist/web dev
```

Vite proxies every request whose path starts with `/api` to the Worker at
`http://localhost:8787`, so keep the Worker dev server running.

## Validating a stack file

```sh
pnpm stack validate <file>
```

The command reads the file as UTF-8 text and passes the text to the format validator without
parsing it first, so malformed JSON is reported as a validation error. It prints the result as JSON
(two-space indentation) to standard output. It does not change the file and makes no network call.

The result has three properties:

- `valid`: `true` or `false`.
- `errors`: an array. Each error has `code`, `path` (a JSON Pointer into the file), `message`,
  `expected`, `actual`, and `hint`. Errors follow the order of the document.
- `truncated`: `true` when more than 100 errors were found and only the first 100 are listed.

Exit codes:

| Code | Meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| 0    | The file holds a valid stack.                                                                   |
| 1    | The file is not a valid stack, including text that is not JSON (code `INVALID_JSON`).           |
| 2    | Usage error or unreadable file. One line goes to standard error and nothing to standard output. |

pnpm adds its own `ELIFECYCLE` line to standard error when the exit code is not 0.

Validating the bundled to-do stack:

```sh
pnpm stack validate apps/web/src/stacks/thin-slice-todo.json
```

```json
{
  "valid": true,
  "errors": [],
  "truncated": false
}
```

Validating a broken file (`scripts/stack/fixtures/invalid-stack.json`, which exits with code 1)
prints one entry per problem, for example:

```json
{
  "code": "DANGLING_REFERENCE",
  "path": "/startCardId",
  "message": "The id \"no-such-card\" does not match any entity in this stack.",
  "expected": "the id of a card in this stack",
  "actual": "\"no-such-card\"",
  "hint": "Use the id of a card that exists in this stack, or add the missing entity."
}
```

## Supported stack format

The format module in `packages/shared` supports `formatVersion` 1 in full:

- **Object types (five):** `button`, `field`, `image`, `list`, and `ai-field`.
- **Action types (nine):** `go_to_card`, `set_value`, `append_item`, `remove_item`,
  `show_message`, `run_ai_field`, `fetch_news`, `transcribe_audio`, and `schedule_notification`.
- Cards also hold links to other cards and an `onOpen` handler. A stack may carry an optional
  `remixedFrom` id.

Any other object or action type is reported as unknown (code `INVALID_VALUE`, with a hint that
lists the known types). Unknown properties are rejected, not ignored.

Two value rules worth knowing:

- **Image `src`.** Either an `https:` URL (lowercase `https://`, ASCII only, no user name or
  password, no spaces or backslashes, at most 2,000 characters) or a base64 `data:image/png`,
  `data:image/jpeg`, `data:image/gif`, or `data:image/webp` URI with a non-empty, well-formed
  payload (at most 1,000,000 characters). `http:`, `javascript:`, and `data:image/svg+xml` are
  rejected.
- **Timestamps.** The `at` property of `schedule_notification` is a UTC timestamp with seconds and
  a trailing `Z`, for example `2026-12-01T09:00:00Z` (a fraction is allowed). Offsets such as
  `+01:00`, a missing seconds part, a lowercase `z`, `24:00:00`, and impossible dates such as
  `2027-02-29` are rejected. The validator reads no clock, so a time in the past is valid.

### Entry points

`@hypergeist/shared/format` exports these functions. They are pure, never throw, and need no
browser or Worker API.

- `validateStack(input)`: returns `{ valid, errors, truncated }`. A string is treated as JSON text.
- `parseStack(input)`: validates in the same way and returns `{ ok: true, value }` with a typed
  `Stack`, or `{ ok: false, errors, truncated }`.
- `serializeStack(stack)`: returns `{ ok: true, value }` with canonical JSON text (two-space
  indentation, keys in the documented order, one trailing newline), or `{ ok: false, errors,
truncated }` for an invalid stack.
- `stackJsonSchema()`: returns a JSON Schema (draft 2020-12) for a stack, generated from the Zod
  schemas. It covers structure only. Cross-entity rules (duplicate ids, dangling references,
  bounds, and the 2,000-character limit on `https:` image sources) are checked by the validator,
  not by the schema.

## Stack engine

`@hypergeist/shared/engine` holds the pure operations over a stack. Nothing in it reads a clock,
generates a random id, touches the network, or modifies its input. Callers pass ids in, and equal
calls give deeply equal results.

- `executeHandler(stack, handler)`: runs a handler of all nine actions. It returns
  `{ stack, effects, navigateTo?, messages }`. Actions that need the outside world (`run_ai_field`,
  `fetch_news`, `transcribe_audio`, `schedule_notification`) are not carried out. They come back as
  plain-data effect requests in `effects`, for a later runtime to run.
- `applyOperation(stack, name, params)`: applies one of seven operations (`create_card`,
  `delete_card`, `add_object`, `update_object`, `remove_object`, `link_cards`, `set_action`). The
  result is `{ ok: true, stack, summary }` or `{ ok: false, errors, truncated }`. A rejected
  operation never carries a stack, and an accepted one always returns a stack that passes
  `validateStack`. The summary lists `created`, `updated` and `removed` ids and a `removedActions`
  count. Errors use the same `Validation_Error` shape as the validator (`code`, JSON Pointer
  `path`, `message`, `expected`, `actual`, `hint`).
- `OPERATIONS` and `operationJsonSchema(name)`: the name, description and parameter schema of each
  operation, and its JSON Schema. These come from the Zod schemas, so a tool registry can be built
  from them without a second copy.
- `buildRenderModel(stack, cardId)`: a plain, JSON-safe description of one card, ready to draw.
- `remixStack(stack, newId)`: copies a stack under a new id and records the old one in
  `remixedFrom`.
- `createStack(params)`: makes a valid one-card stack from an id, a name and optional sizes.

What is not connected yet: the app does not call `applyOperation` or `buildRenderModel`, and it does
not run effects. The app uses `createStack` only to make a new empty stack when the last one is
deleted, and `remixStack` only to make a copy on an id conflict. When a button runs an action that returns an effect
request, the status line says the feature arrives in a later release.

## Saving and the Stacks window

**What is stored, and where.** Stacks are stored in the browser's IndexedDB, in a database named
`hypergeist`, through the `idb` library. The data is private to that browser profile. Each stored
stack has a saved time and a label: "Demo" for a bundled stack, "Yours" for any other. Deleted
stacks go to a separate trash store, and the id of the stack you had open last is stored too. Every
stack is checked with the shared validator before it is written and when it is read. A stored record
that fails the check is set aside unchanged, and the Stacks window says how many were set aside. The
app does not store API keys or settings.

**First run.** When the database is new, the app writes the bundled demo stacks once and opens one.
A demo stack you delete does not come back on reload.

**Autosave.** About a second after your last change, the app writes the open stack. Several changes
in that second make one write. The label in the stack window reads "Saved", "Saving", or "Not saved"
with a reason. When storage is full, the label also offers to export the stack.

**Export.** Export downloads one stack as `<name>-<id>.hypergeist.json`. The name part is the stack
name in lower case, with other characters turned into `-`, cut to 40 characters. The file holds the
stack and nothing else. If the stack is invalid, the app shows the first problem and makes no file.

**Import.** An imported file is untrusted data. The app refuses a file over 5 MB before it reads it,
and then parses and validates the text. If that fails, it stores nothing and shows up to 5 errors,
and says how many more it left out. An import never overwrites a stack. If the id is already used,
the app offers to import a copy under a new id (the original id plus `-copy`), or to cancel. An
imported stack is never run as code. It only changes when you press its buttons.

**Trash and restore.** Delete moves a stack to the trash in one step. Restore moves it back. If its
id is in use by another stack, the app offers a copy under a new id. "Delete permanently" and "Empty
trash" ask for confirmation. If you delete the open stack, the app opens another one, or makes a new
empty stack if none is left.

**Restore demo stacks.** After you confirm, each bundled demo stack replaces the stored stack with
the same id, and any missing demo stack is added. A replaced stack that you had changed goes to the
trash. Stacks that are not demo stacks are not touched.

**Adding a demo stack.** Put one JSON file per stack directly in `apps/web/src/stacks/`. The app
reads every `.json` file in that folder at build time, so no code change is needed. A test fails if
a file is not a valid stack. A browser that already has a stored copy keeps it until you choose
"Restore demo stacks".

## AI orchestrator

The logic that lets a model build and edit stacks is in `apps/web/src/ai/`. It has no UI. **Nothing
in the app calls it yet.** The chat, the AI-edit mode and the settings dialog arrive with the
`ai-assistant-ui` spec. Until then it runs only in tests. Its tests use scripted and recorded
providers, so **no live model has been tried yet**. `docs/manual-verification-ai.md` is the checklist
for trying real providers.

- **A Turn.** `runTurn` sends one user message and a compact view of the stack to a provider and
  applies each tool call with `applyOperation`. The stack it returns is always valid. It also returns
  the stack from before the Turn, so the caller can undo the whole Turn.
- **Tools.** The seven operations of the stack engine, plus `say` (talk to the user) and
  `create_stack` (name a new stack, offered only when a Turn starts one). The tool schemas come from
  `OPERATIONS` and `operationJsonSchema`.
- **Limits of a Turn.** At most 8 model requests, 40 tool calls and 90 seconds. At most 6 rejected
  calls, and at most 2 repair rounds in a row.
- **Repair loop.** A rejected call goes back to the model as a short message built from the
  validation errors, and the model may try again. A Turn that applied some calls and then stopped
  (a limit, an error, or a call that stayed rejected) ends as `partial` and keeps the accepted
  changes. A Turn where no call was accepted and a call was rejected, or that stopped on an error,
  ends as `failed` and leaves the stack as it was. A Turn where the model only talks ends as `done`.
  A model that rejects tool calling is asked for one JSON object per reply instead.
- **Providers.** Demo mode (the default) tries the shared model through `POST /api/ai/chat` on the
  app's own origin, then falls back to recorded examples. The Worker has no such route yet, so today
  the demo fallback always ends on the recorded examples. An own key and base URL are optional. They
  go from the browser straight to that provider and never through the Worker. The key is kept in
  memory only and is never written to IndexedDB or to a stack. The base URL and model name are saved
  in a separate IndexedDB database, `hypergeist-settings`. The base URL must be `https:`, or `http:`
  for `localhost` and `127.0.0.1` only.
- **Demo examples.** The recorded provider knows two example prompts: `Make me a to-do list` (builds
  a new stack) and `Add a button` (adds a button to the current card). A prompt must match exactly,
  after the text is trimmed, lower-cased and has its spaces collapsed and any `.`, `!` or `?` removed
  at the end. There is no fuzzy matching. Any other prompt gets a reply that lists the examples and
  changes nothing. Add an example by putting a JSON file in `apps/web/src/ai/scenarios/`.
- **Text for AI fields.** `completeText` asks a provider for the text of one `ai-field`. It never
  changes a stack. Writing the text into the field is for a later spec.

## AI proxy (Worker)

The Worker has an AI proxy for demo mode: `POST /api/ai/chat` forwards a chat request to a model provider with a hosted key, and `GET /api/ai/quota` returns the day's request counts for a demo counter. The browser never sees the key. The key is a Cloudflare secret.

- **Providers.** `sarvam` (development) and `openai` (submission), chosen by the `AI_PROVIDERS` variable. The endpoints are fixed in the code. The model names are variables, and the AI stays disabled until they are set.
- **Limits.** Same origin only (an `Origin` check), a 128 KB body limit, strict request validation (the schema is in `@hypergeist/shared/ai-wire`, shared with the browser), a burst limit per visitor, and caps per visitor, per day and in total, in requests and in tokens. The counters live in a SQLite Durable Object. If the counters or the burst limiter fail, the proxy refuses to call the provider.
- **What the browser gets.** Only the message content, the tool calls and the finish reason. Provider errors, usage numbers and headers never leave the Worker.
- **Kill switch.** `AI_ENABLED=false`, or a missing key or model, makes every chat call answer `AI_DISABLED`.
- **Run it locally.** Copy `apps/worker/.dev.vars.example` to `apps/worker/.dev.vars`, fill in the values, set the model variables, then `pnpm --filter @hypergeist/worker dev`. See `docs/deployment.md`.

It is not deployed until the Developer deploys it (`docs/deployment.md`). Nothing in the web app calls it yet: the AI panel arrives with `ai-assistant-ui`. No real provider has been tried yet.

## Limits of the thin slice

- **No AI.** Nothing in the app talks to a model. The Ghost is a placeholder.
- **Stacks live in this browser only.** They are stored in IndexedDB. Nothing is sent to a server.
  Clearing the browser's site data deletes them. Export a stack to keep a copy.
- **Two tabs overwrite each other.** If two tabs have the same stack open, each save replaces the
  stored stack, so the last save wins. There is no live sync between tabs.
- **The last second may be lost.** A change is written about a second after you stop. When a tab is
  closed, the app starts the write at once, but a browser may end the page before it finishes. The
  "Saved" label shows when it is safe to close the tab.
- **The open card and the mode are not saved.** After a reload, the stack opens on its start card in
  Interact mode.
- **Memory mode.** If the browser blocks storage (some private windows do), the app still works and
  loads the demo stacks into memory. A banner says that changes are lost when the page closes. Export
  before you leave. Export and import still work.
- **Size limits.** An import file can be at most 5 MB. The trash keeps the 50 newest deleted stacks,
  and the oldest is deleted for good when a 51st arrives.
- **No object editing.** Edit mode is selection plus a read-only property view. You cannot move,
  resize, or change objects, and you cannot add cards.
- **`onOpen` handlers are validated but not run.** The bundled stack leaves them empty.
- **Empty Add appends an empty item.** The format has no conditionals, so the Add button cannot
  skip an empty field.
- **The format is ahead of the app.** The validator, parser, serializer, and JSON Schema know all
  five object types and all nine actions, but the app does not use them all yet. The action
  executor runs only `go_to_card`, `set_value`, `append_item`, and `show_message`; it skips the
  other five actions with a message. An `image` object shows a placeholder and never loads its
  `src`. An `ai-field` shows its stored value in a read-only box and does not call a model.
- **Closed set.** There are no other object or action types, no conditionals, no loops, and no
  scripts.

## New dependencies in the web app

- `zustand` holds the app state (current card, mode, selection, status message).
- `idb` is a small wrapper around IndexedDB. It stores the stacks in the browser.
- `fake-indexeddb` (dev dependency) is an in-memory IndexedDB for the tests, so they need no browser.
- `@fontsource/pixelify-sans` and `@fontsource/vt323` bundle the two fonts of the retro look. Both
  fonts are licensed under the SIL Open Font License 1.1 (see `docs/assets-licenses.md`). The Vite
  build emits the font files into `apps/web/dist`, so the app loads them from its own origin.

## Import extensions in shared sources

Node runs the CLI's TypeScript directly, with no build step, and it requires file extensions on
relative imports. In `packages/shared/src` and `scripts/`, write relative imports with an explicit
`.ts` extension (`import { x } from './x.ts'`) and use only erasable TypeScript syntax (no `enum`,
no namespaces with code, no parameter properties). An ESLint rule fails on a relative import
without `.ts` in those folders.

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
│   ├── web/             React + Vite app (@hypergeist/web); src/persistence/ holds browser storage
│   │                    src/ai/ holds the AI orchestrator (logic only, no UI yet)
│   └── worker/          Hono app on Cloudflare Workers (@hypergeist/worker)
├── docs/                project brief, asset licenses, Kiro journal
├── e2e/                 Playwright tests
├── packages/
│   └── shared/          shared package (@hypergeist/shared): format, validator, engine
└── scripts/
    ├── check-deps/      dependency-rule check behind `pnpm check:deps`
    └── stack/           stack validator CLI behind `pnpm stack`
```

Dependency rules, enforced by `pnpm check:deps`:

- `packages/shared` imports nothing from `apps/`.
- `apps/web` and `apps/worker` never import each other.
- Apps import the shared package only through `@hypergeist/shared`, `@hypergeist/shared/format`,
  `@hypergeist/shared/engine`, or `@hypergeist/shared/ai-wire`.

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
