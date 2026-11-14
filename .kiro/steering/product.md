# HyperGeist: Product

HyperGeist is a browser-based retro "stack" environment, inspired by HyperCard. The user describes what they need in plain English. AI builds a living, editable set of linked cards (real buttons, fields, lists, logic, and AI-powered fields). The user can use the stack, edit it by hand, or reshape it by talking to it.

- Hackathon: Kiroween 2026, category **Resurrection**. Submission deadline **Dec 4, 2026, 2:00 PM PST**, no extensions.
- Full brief and locked decisions D1-D13: `docs/kiroween-2026-project-brief.md`. Read it when scope or priorities are in question. It is not auto-included.
- If the brief conflicts with the official rules (https://kiroween.devpost.com/rules), the rules win.

## Product shape
- One **engine** plus several **showcase stacks**. Not an "everything app". Slides, to-dos, reminders and similar are stacks built on the engine, never separate features.
- Audience: ordinary people making small day-to-day tools. The demo follows one person's day across stacks.
- Interface: retro desktop/Mac-style UI (windows, cards, retro sound). It is not a drawing, note-taking, or animation tool.
- Modes: **Interact**, **Edit**, and **AI-edit** (click an object and talk about it).
- AI is the scripting layer. Cards can also contain runtime AI fields.

## Use cases (priority order)
Showcase: 1 Morning Briefing, 2 Voice Notes to Action Cards, 3 Smart To-Do with Reminders, 4 Study Deck.
Supporting templates: 5 Expense Ledger, 6 Letter and Email Writer, 7 Pocket Tutor, 8 Weekly Planner.
Stretch (only after everything else is polished): pixel-art images, stack marketplace.

## Firm scope cuts
No full slide editor, no drawing or animation tools, no plugin system, no marketplace, no user accounts.

## Must always hold
- A judge with no API key can use the app in one click (demo mode).
- Reviewers can bring their own key and base URL (any OpenAI-compatible endpoint).
- Stacks are local-first, shareable by link, and remixable.
- The app states its limits honestly. Example: browser notifications only fire while the app is open or installed as a PWA.
- The `.kiro/` directory is committed at the repo root. **Never add `.kiro` to `.gitignore`.**
- All project code is newly written after Oct 30, 2026. Disclose any pre-existing code.
