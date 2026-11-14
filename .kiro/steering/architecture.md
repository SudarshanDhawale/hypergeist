# HyperGeist: Architecture

## Repo layout
```
hypergeist/
├── .kiro/            specs, steering, hooks (never gitignored)
├── docs/
├── apps/web/         React app (UI shell, orchestrator client, services)
├── apps/worker/      Hono API on Cloudflare Workers
└── packages/shared/  Zod schemas, stack format, validator, engine, tool registry types
```
Web and Worker import schemas from `packages/shared`, so validation is identical on both sides.

## Dependency rules
- `packages/shared` imports no app code and no browser or Worker APIs.
- `apps/web` and `apps/worker` may import `packages/shared`. They never import each other.
- The engine is pure: no network, storage, timers, clock, randomness, or DOM. IDs and timestamps are passed in by callers.

## Layers
1. **Stack format and validator** (`packages/shared`). Strict Zod schemas. Stack > Cards > Objects (button, field, image, list, ai-field), Links, and declarative Actions (no scripts, no loops). Validation returns structured, machine-readable errors that an AI repair loop can consume.
2. **Stack engine** (`packages/shared`). Pure operations over a stack (`create_card`, `delete_card`, `add_object`, `update_object`, `remove_object`, `link_cards`, `set_action`), an action executor that emits effect requests as plain data, a render-model builder, canonical serialization, and remix.
3. **Retro UI shell** (`apps/web`). Renders the render model. Modes: Interact, Edit, AI-edit.
4. **AI orchestrator** (`apps/web`). Context builder, typed tool registry, provider adapter, capability detection, retry/repair loop.
5. **Services**: news proxy, transcription, notifications, share/remix store, local persistence.

## Format and validation rules
- Zod objects are strict. Unknown properties are rejected, never silently stripped.
- Two validation passes: structural (Zod), then semantic (duplicate IDs, dangling references, bounds, limits). Both map to the same `Validation_Error` shape: `code`, JSON Pointer `path`, `message`, `expected`, `actual`, `hint`.
- Effects that need the outside world (AI call, news, transcription, notification) are returned by the executor as effect requests. The orchestrator and services carry them out.
- The Zod schemas, JSON Schemas, and tool registry entries come from one definition. Do not hand-write a second copy.

## AI rules
- Every capability is a typed tool in a registry: name, description, Zod schema.
- Every tool call is schema-validated, with a retry/repair loop. A tool call must never leave a stack invalid.
- Context sent to the model is compact: current card and selection, not the whole stack. Free-tier token limits are tight.
- BYO key: the user's key and base URL go from the browser straight to the provider, never through the Worker. Keys live in a settings store, never inside a stack, an export, or a share link.
- Detect provider capabilities (for example transcription) and degrade gracefully with a clear message.
- Demo mode: Worker AI proxy with the hosted key, then recorded-response fallback.

## Persistence
- IndexedDB is per-browser and private. Reviewers never see developer data.
- First run seeds the showcase stacks from bundled JSON. Export and import stacks as JSON. A "restore demo stacks" button resets them.
- Share links use Workers KV. A shared stack is plain data. Opening one never runs code.
