# HyperGeist: Conventions

## Code
- TypeScript `strict`. No `any`; use `unknown` and narrow it. No non-null `!` without a comment saying why.
- Prefer pure functions over plain data. No classes for stack data.
- Expected failures return a result value, for example `{ ok: true, value } | { ok: false, errors }`. Throw only for programmer errors.
- Never mutate inputs. Return new values.
- Derive types from Zod with `z.infer`. Do not hand-write a type that duplicates a schema.
- Entity IDs match `^[a-z0-9][a-z0-9_-]{0,63}$`.
- Default-deny on external data: parse with the shared schema at every trust boundary (Worker request bodies, imported JSON, share-link payloads, model tool calls, IndexedDB reads).
- Keep dependencies few. Ask before adding one.

## Naming and layout
- Files `kebab-case.ts`. React components `PascalCase.tsx`. Tests next to code as `*.test.ts`. Property tests as `*.property.test.ts`.
- Named exports. No default exports except where a framework requires one.
- Each package exposes a small public API from `index.ts`. Do not import another package's internals.

## Testing
- Every shared-package module ships with unit tests and, where an invariant exists, a property test.
- Property tests use fast-check with a fixed or reported seed. Core properties: any valid stack renders, any sequence of tool calls leaves the stack valid, export then import is lossless, a rejected operation leaves the stack unchanged, the validator is deterministic.
- UI behavior that spans modes, AI calls, or persistence gets a Playwright test. Playwright runs against the recorded-response provider, never a live model.

## Security and secrets
- No API keys, tokens, or secrets in code, fixtures, logs, or stacks. Worker secrets use `wrangler secret`.
- Validate and size-limit every Worker request body. Return generic errors to clients.
- Treat shared and imported stacks as untrusted data. Image sources are limited to `https:` URLs and a fixed set of `data:image` types.

## UI copy and honesty
- State real limits in the app. Example: reminders only fire while the app is open or installed.
- Retro design language (look, sound, spacing, accessibility, definition of done for UI): see the `design-language` steering file. It loads automatically for UI work.

## Git and Kiro
- Small commits with clear messages. Commit `.kiro/` and keep it out of `.gitignore`.
- Each subsystem gets its own spec under `.kiro/specs/`. Specs reference this steering instead of repeating it.
