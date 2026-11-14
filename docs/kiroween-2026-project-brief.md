# Kiroween 2026: Project Brief & Locked Decisions

> Status: **Idea locked. Architecture and specs next.**
> Written: Nov 13, 2026 · Submission deadline: **Dec 4, 2026, 2:00 PM PST** (no extensions)

---

## 1. One-Line Pitch

**A browser-based retro "stack" environment where you describe what you need in plain English and AI builds a living, editable set of linked cards (real buttons, fields, logic and AI-powered fields) that you can use, edit by hand, or reshape by talking to it.**

Name: **HyperGeist** (HyperCard-inspired).

**Category:** Resurrection (HyperCard reborn for the AI era)
**Also competing for:** Overall prizes, Best Demo, Bonus Blog, Social Blitz, Best Ghost of Kiroween Past (if registered in 2025), Best Student / Startup (if eligible)

---

## 2. Why This Idea

### The dead technology
HyperCard (Bill Atkinson, 1987): anyone could build software by assembling cards, buttons and fields, and scripting in near-English (HyperTalk). Reference to study: Decker (https://beyondloom.com/decker/tour.html), a modern HyperCard-style environment.

### What we keep from HyperCard
1. **The card is the atom.** Everything is cards holding objects; cards link to each other.
2. **Using and building live in one place.** (We refine this with an explicit mode toggle. See Locked Decisions.)
3. **Programming for non-programmers.** HyperTalk looked like English.

### What changes in 2026
**AI becomes the new HyperTalk.** English is no longer something that *resembles* code; it is how the app gets written and edited. Cards can also contain AI themselves (runtime AI fields), so the stacks are intelligent, not just static.

### How we avoid being "just a Decker clone"
Decker already exists and is excellent. Our differentiator is what it cannot do: **sentence to working multi-card app, conversational editing with full screen context, and AI-powered objects**, all with a bring-your-own-model design.

### The real-world problem
Most people cannot build the small tools they need (trackers, planners, study aids, reminder systems) and do not want to learn to code or juggle five apps. This lets anyone create and own those tools in a minute, in a friendly, familiar interface.

---

## 3. Locked Decisions

| # | Decision | Detail |
|---|----------|--------|
| D1 | **Category** | Resurrection (HyperCard). |
| D2 | **Product shape** | One *engine* plus several *showcase stacks*. Not an "everything app." Slides, to-dos, notification cards, etc. are stacks built on the engine, not separate features. |
| D3 | **Audience** | Generic, for people's day-to-day life. The demo follows **one person's ordinary day** across stacks so the Impact story stays concrete. |
| D4 | **Interface** | Retro desktop/Mac-style UI (windows, cards, retro sound). Not a drawing, note-taking or animation tool. |
| D5 | **Interact / Edit toggle** | An explicit mode switch to prevent accidental edits and unnecessary hover/click behavior. Plus a quick **AI-edit mode**: click an object and talk about it. |
| D6 | **AI architecture** | Full on-screen context (current stack, card, selected object) is passed to the model. Every capability is a **typed tool in a registry** with a description and schema. |
| D7 | **Tool-call safety** | Every tool call is **schema-validated**, with a retry/repair loop, so weaker models cannot corrupt a stack. |
| D8 | **Model flexibility (BYO)** | Reviewers can enter their own API key and base URL (any **OpenAI-compatible** endpoint). Model capabilities are detected and features degrade gracefully (e.g., transcription not offered by every provider). |
| D9 | **Demo mode** | A built-in path for judges with no key (limited hosted key and/or recorded/fallback responses). The app must work for a judge in one click. |
| D10 | **Sharing** | Stacks are shareable by link and **remixable** ("make this for my class"). |
| D11 | **Persistence** | Local-first storage so stacks survive reloads. |
| D12 | **Scope cuts (firm)** | No full slide editor, no drawing/animation tools, no plugin system, no marketplace. |
| D13 | **Scope: nothing swapped** | All 8 use cases below stay in. Priority order protects the schedule. |

---

## 4. Use Cases (all 8 locked)

### Showcase stacks (featured in the demo video)
1. **Morning Briefing:** fetches news/RSS for your interests; AI summarizes into cards. *(needs a small proxy for CORS)*
2. **Voice Notes to Action Cards:** record audio, transcribe, AI extracts to-dos, dates and a summary into cards.
3. **Smart To-Do with Reminders:** natural-language tasks ("dentist Thursday 5pm") with notification cards.
4. **Study Deck:** paste notes or a topic and get flashcards, a quiz and a slide-style walkthrough (covers the "presentation" idea without a slide editor).

### Supporting stacks (same engine, shown briefly or shipped as templates)
5. **Expense Ledger:** type "spent 250 on lunch"; it logs and totals.
6. **Letter & Email Writer:** text generation with a tone control card.
7. **Pocket Tutor:** a card with a runtime AI field for any subject.
8. **Weekly Planner:** meals, habits or workouts, generated and editable.

### Stretch only (only if everything else is polished)
- Pixel-art image generation per card
- Stack marketplace

---

## 5. Platform Features (the engine)

**Core (must ship)**
- Prompt-to-stack generation (sentence to linked cards with working buttons and fields)
- Edit-by-talking, with the AI seeing the current screen and selection
- Interact / Edit mode toggle (plus AI-edit mode)
- Retro desktop UI with windows, drag, and sound
- Share link and open-a-shared-stack
- BYO API key and base URL; demo mode
- Typed tool registry with schema validation and repair loop
- Local persistence

**Differentiators**
- Runtime AI fields (cards that call AI when used)
- Remix of any shared stack
- Notification cards (scheduled reminders)
- Audio transcription
- News/RSS fetching via proxy

---

## 6. Preliminary Architecture (to be refined in specs)

```
┌───────────────────────────────────────────────────┐
│  Retro UI shell (windows, cards, objects, sound)  │
│  Modes: Interact | Edit | AI-edit                 │
└──────────────┬────────────────────────────────────┘
               │ renders / mutates
┌──────────────▼────────────────────────────────────┐
│  Stack Engine (pure, testable)                    │
│  Stack > Cards > Objects (button, field, image,   │
│  list, ai-field...) + links + scripts/actions     │
│  Strict JSON stack format + validator             │
└──────────────┬────────────────────────────────────┘
               │ tool calls (validated)
┌──────────────▼────────────────────────────────────┐
│  AI Orchestrator                                  │
│  - context builder (stack, card, selection)       │
│  - tool registry (name, description, schema)      │
│  - provider adapter (OpenAI-compatible, BYO key)  │
│  - capability detection, retry/repair loop        │
└──────────────┬────────────────────────────────────┘
               │
┌──────────────▼────────────────────────────────────┐
│  Services: news proxy · transcription ·           │
│  notifications · share/remix store · local storage│
└───────────────────────────────────────────────────┘
```

### Initial tool registry (draft)
`create_card` · `delete_card` · `add_object` · `update_object` · `remove_object` · `link_cards` · `set_action` · `fetch_news` · `transcribe_audio` · `generate_text` · `schedule_notification` · `read_stack_context`

Principle: **the stack format is simple and strict**, because everything (AI, UI, sharing, tests) depends on it. Design this first.

---

## 7. How This Maps to the Judging Criteria

Stage One is pass/fail: fits the category and genuinely uses Kiro. Stage Two is five equal criteria (10 points each):

| Criterion | Our answer |
|-----------|-----------|
| **Potential Impact** | Non-coders build the daily tools they need; concrete "one person's day" story. |
| **Technological Implementation** | Deep, varied Kiro use (see section 8); typed tools, validation, provider abstraction, property-based tests. |
| **Design** | A complete, polished retro environment with consistent visual language and sound, not a proof of concept. |
| **Innovation / Idea** | HyperCard's philosophy plus AI as the scripting layer, AI-native objects, BYO-model design. |
| **Presentation** | Under 3 minutes: type a sentence, get a working app, use it, talk to it to change it, share it. |

---

## 8. Kiro Usage Plan (the write-up is judged)

Judges must understand *how effectively* we used Kiro. Plan to use and document:

- **Spec-driven development:** separate specs for stack format, engine, AI orchestrator, UI shell, each showcase stack. Compare against vibe coding in the write-up.
- **Steering docs:** retro design language, stack-format rules, coding conventions, tool-registry conventions.
- **Agent hooks:** validate stack JSON on change, run tests on save, lint generated stacks, keep docs in sync.
- **MCP:** use for external capabilities relevant to the build (e.g., docs, news/data sources). Document what it made possible.
- **Property-based testing:** e.g., "any valid stack renders without error," "any sequence of valid tool calls leaves the stack valid," "export then import is lossless."
- **Custom agents / Kiro powers / Crew / CLI / Web:** try at least a couple, and note differences (the write-up asks for this).
- **Repo requirement:** the `/.kiro` directory must be committed at the repo root. **Never add it to `.gitignore`.**

---

## 9. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Weaker BYO models produce bad tool calls | Schema validation, repair/retry loop, capability detection, tested against several providers. |
| Judge has no API key | Demo mode (hosted limited key and/or recorded responses). |
| Transcription unsupported by some providers | Detect capability; degrade gracefully with a clear message. |
| News fetch blocked by CORS | Small server-side proxy. |
| Scope creep (8 use cases) | Engine first; strict priority order; stretch items only after polish. |
| "Just a Decker clone" perception | Lead the demo and write-up with AI authoring and AI-native objects. |
| Weak demo video | Script and storyboard early; rehearse; keep under 3 minutes. |
| Reminders need a background process | Decide mechanism early (in-app notification cards and browser notifications while open; document limits). |

---

## 10. Build Priority and Timeline (about 3 weeks)

**Priority order**
1. Stack format and engine (with tests)
2. Retro UI shell and mode toggle
3. AI orchestrator, tool registry, BYO key, demo mode
4. Prompt-to-stack and edit-by-talking
5. Showcase stacks 1 to 4 (Briefing, Voice Notes, Smart To-Do, Study Deck)
6. Share and remix
7. Supporting stacks 5 to 8 (as templates)
8. Polish, sound, onboarding, demo video, write-ups

**Rough schedule**
- **Nov 13 to 16:** Finalize name, stack format spec, steering docs, repo setup with `/.kiro` and license.
- **Nov 17 to 23:** Engine, UI shell, AI orchestrator.
- **Nov 24 to Dec 1:** Showcase stacks, share/remix, supporting stacks.
- **Dec 1:** Request Kiro credits **before 12:00 PM PT** (request form is in the official rules).
- **Dec 1 to 3:** Polish, deploy, record and edit video, write the Kiro write-up and blog post.
- **Dec 4 (before 2:00 PM PST):** Submit. Don't wait until the last hour.

---

## 11. Submission Checklist

- [ ] Working app at a public URL (credentials in the form if needed)
- [ ] Public **GitHub** repo (not GitLab/Bitbucket) with a visible **open-source license**
- [ ] `/.kiro` directory committed at repo root (specs, hooks, steering), **not** in `.gitignore`
- [ ] Text description of features and functionality
- [ ] Demo video, **under 3 minutes**, public on YouTube, shows the app working end to end, no copyrighted music/trademarks
- [ ] Write-up on how Kiro was used (IDE/CLI/Web/Crew, custom agents, hooks, specs, steering, MCP, PBT, powers)
- [ ] Category selected: **Resurrection**
- [ ] Disclose any pre-existing code (the project must be newly built after Oct 30)
- [ ] Bonus: blog post (mentions Kiroween 2026, published in submission window)
- [ ] Bonus: social post starting with **#KiroweenHackathon26** (link in form)
- [ ] Bonus: Ghost of Kiroween Past (only if registered for 2025)
- [ ] Bonus: Student / Startup details (only if eligible)
- [ ] Verify eligibility and any regional Kiro restrictions for your location

---

## 12. Open Questions (decide next)

1. ~~**Name** and visual identity~~ Resolved: the name is HyperGeist and the look is 1-bit classic Mac style. See `.kiro/steering/design-language.md`.
2. **Stack format** details: object types, action/script model (declarative actions vs small sandboxed scripts).
3. **Hosting and backend:** where the proxy, share store and demo-mode key live.
4. **Reminder mechanism** and its limits.
5. **Which stack becomes the "hero" of the demo video.**
6. Whether to attempt the Kiro Crew bonus.

---

## 13. Source of Truth

Official rules: https://kiroween.devpost.com/rules
If anything here conflicts with the official rules, **the official rules win.** Re-check them before submitting.
