# HyperGeist: Tech Stack (locked)

Do not swap these without asking the user.

## Language and frontend
- TypeScript everywhere, strict mode.
- React + Vite. Desktop browsers first, phones usable but secondary. Installable as a PWA. No native desktop or mobile builds.
- State: Zustand.
- Local storage: IndexedDB through `idb`.

## Validation and schemas
- **Zod 4** is the single source of truth for the stack format and for every tool-call schema. Zod 4 is required: `z.toJSONSchema()` is built in and targets JSON Schema draft 2020-12 by default.
- Zod refinements and some checks do not survive conversion to JSON Schema. JSON Schema output covers structure only. Cross-entity rules live in the semantic validator.

## Backend
- Hono on Cloudflare Workers. Workers KV for share links (the only shared data).
- Hosting: Cloudflare free plan. No accounts, no SQL database, no always-on server.
- Endpoints: AI proxy, news/RSS fetch (CORS), transcription forwarding, share/remix store.
- The demo API key is a Worker secret and never reaches the browser.
- AI proxy: per-IP rate limit, model allowlist, daily cap.
- Providers sit behind one OpenAI-compatible adapter: Groq primary, Gemini fallback, then recorded-response fallback.

## Browser APIs
MediaRecorder (voice), Web Audio (retro sounds), Notifications.

## Testing
- Vitest for unit and integration tests.
- fast-check for property-based tests. Seeds must be reproducible and reported on failure.
- Playwright for end-to-end tests.

## Tooling (proposed, confirm with the user before relying on it)
- pnpm workspaces for the monorepo.
- ESLint and Prettier. One root `tsconfig.base.json` with `strict: true`.
- Wrangler for Worker dev and deploy.
