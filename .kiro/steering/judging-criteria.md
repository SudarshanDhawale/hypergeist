---
inclusion: auto
name: judging-criteria
description: Kiroween 2026 judging criteria (Potential Impact, Technological Implementation, Design, Innovation/Idea, Presentation) and the pre-submission self-audit procedure. Use when planning features, writing the Kiro usage write-up, the blog post, the demo video, the README, or when asked to validate or audit the project before submission.
---

# Kiroween 2026: Judging Criteria and Pre-Submission Audit

Source: the contest site. The official rules win if anything here conflicts with them: https://kiroween.devpost.com/rules. Deadline: **Dec 4, 2026, 2:00 PM PST**, no extensions.

Stage one is pass/fail: the project fits the category (Resurrection) and genuinely uses Kiro. Stage two scores five equal criteria. Anything we build should help at least one of them, and the audit below checks all five.

## The five criteria (as published)

1. **Potential Impact.** Does the project make a credible case for solving a real problem for a real audience? Does the solution address that problem based on what is demonstrated? How useful, intuitive and accessible is it? Would someone actually use this?
2. **Technological Implementation.** How thoroughly and skillfully does the project use Kiro? Was there a thoughtful strategy to AI development? Was a variety of Kiro tools used impactfully? Does the project show a deep understanding of Kiro features? Was there experimentation?
3. **Design.** Does the project deliver a complete, coherent product experience, not just a technical proof of concept? Is the design intuitive, polished and intentional?
4. **Innovation/Idea.** How creative and novel is the concept, and does the project differ from existing concepts? Are any unusual technologies or public resources (like datasets) leveraged or combined in a unique way?
5. **Presentation.** Does the video clearly demonstrate the project working end to end? Does the pitch communicate what problem is solved, who it is for and why it matters? Is the overall presentation easy to follow? Is it creative and memorable?

## What we must be able to show, per criterion

### 1. Potential Impact
- A concrete audience and problem: ordinary people who need small day-to-day tools (trackers, planners, study aids, reminders) and cannot or do not want to code.
- The demo follows one person's ordinary day across stacks, with real use, not a feature tour.
- Works for a judge in one click with no key (demo mode); BYO key for those who have one.
- Accessible: keyboard operable, visible focus, contrast, reduced motion, honest limits stated in the app (stacks live only in this browser, reminders only while open).
- Evidence someone would use it: a stack that solves a real task end to end (Smart To-Do with reminders is the strongest candidate).

### 2. Technological Implementation (the Kiro write-up is judged here)
- **Specs:** one per subsystem (requirements, design, tasks), with the spec-versus-vibe comparison actually measured, not asserted.
- **Steering:** product, tech stack, architecture, conventions, design language, project status, judging criteria.
- **Hooks:** tests on save, stack JSON validation, `.kiro` and API-key guards, journal reminder. (Not created yet.)
- **MCP, powers, custom agents, Crew, CLI or Web:** try at least a couple and write down what each made possible or did not.
- **Property-based testing:** the named properties (render, closure, rejected-unchanged, lossless round trip, determinism, schema acceptance) with reproducible seeds.
- **Strategy:** orchestrator mode with sub-agents running spec tasks in parallel waves, dependency graphs, safety rules learned from failures, thin vertical slices.
- **Experimentation and honesty:** `docs/kiro-journal.md` records what worked and what failed (pnpm 12 `allowBuilds`, TypeScript 7 incompatibility, the sandbox emptying `node_modules`, test timeouts). Keep adding entries.
- `/.kiro` is committed at the repo root and never in `.gitignore`.

### 3. Design
- A complete retro desktop, not a prototype: menu bar, windows, dithered desktop, sound, mode switch always visible, Ghost window with states, charming empty states, onboarding.
- Every UI task meets the Definition of Done in `design-language.md` (tokens only, integer scales, all states, keyboard, reduced motion, accent for AI only, assets licensed, still frame looks right).
- No default browser styling, no placeholder text, no dead controls, no layout breaks at 1x, 2x and 3x.
- No third-party trademarks or unlicensed assets; `docs/assets-licenses.md` is complete.

### 4. Innovation/Idea
- AI as the scripting layer of a HyperCard-style environment: sentence to working multi-card app, edit by talking with screen context, AI-native objects.
- Typed tool registry with schema validation and a repair loop so weaker models cannot corrupt a stack; one strict, testable stack format shared by AI, UI and sharing.
- Bring-your-own OpenAI-compatible model plus capability detection; share and remix by link.
- Lead with what Decker cannot do, so the project does not read as a clone.

### 5. Presentation
- Video under 3 minutes, public on YouTube, no copyrighted music or trademarks, shows the app working end to end: type a sentence, get a working app, use it, talk to it to change it, share it.
- The first 20 seconds state the problem, the audience and why it matters.
- Script and storyboard early, rehearse, keep the hero stack decided (open question in the brief).
- Public URL works, README is clear, text description and Kiro write-up are ready, blog post and `#KiroweenHackathon26` social post done.

## Submission checklist (from the Devpost overview page)

Source: https://kiroween.devpost.com/ (overview and prizes). The `/rules`, FAQ and Resources pages could not be fetched on 2026-11-15, so read them yourself and add anything they require. Items marked **(verify)** are not stated on the overview page.

### Eligibility and category
- [ ] **New project only.** Built during the Submission Period (Oct 30 to Dec 4, 2026). Evidence: git history starts 2026-11-14 with the scaffold commit. Keep every commit date, do not squash or rewrite history, and disclose any pre-existing code in the README. No reuse of a Kiroween 2025 project.
- [ ] **One category: Resurrection.** The pitch must say plainly which dead technology is resurrected (HyperCard-style stacks), what is reimagined with today's technology (AI as the scripting layer), and what problem that solves. A project can win one Overall or one Category prize, not both. Bonus prizes can stack.
- [ ] **Personal eligibility (verify).** Age of majority in the country of residence, and the country is not on the excluded list shown on the page (Argentina, Australia, Belarus, Brazil, Crimea, Cuba, Donetsk, Iran, Italy, North Korea, Luhansk, Philippines, Quebec, Russia, Syria, UAE). Teams have up to three members; the submission must name every member.
- [ ] **Kiro credits.** Request them from the Resources tab before **12:00 PM PT on Dec 1**. Registered participants only.

### What the submission form needs
- [ ] **Public GitHub repository** (not GitLab or Bitbucket) with all source code, assets and instructions needed to run it.
- [ ] **Open source license file detectable by GitHub**, visible at the top of the repo page (About section). Check after pushing: the About box shows "MIT license".
- [ ] **`/.kiro` directory at the repo root** with specs, steering and hooks, and **not in `.gitignore`** (doing so can disqualify the project). Check `git check-ignore .kiro` prints nothing, and that the files are tracked: `git ls-files .kiro | head`.
- [ ] **URL to the working app.** Public, no login. If credentials were needed they would go in the private Devpost field; we need none, and that is a selling point.
- [ ] **Text description** of features and functionality.
- [ ] **Demo video:** under 3 minutes (judges need not watch more), shows the project working on the device it was built for (a desktop browser), uploaded to YouTube and **public**, no third-party trademarks and no copyrighted music or material without permission.
- [ ] **Kiro write-up** (see the table below).
- [ ] **Bonus prizes chosen** on the form (see below).
- [ ] **Typical Devpost fields (verify):** project name, one-line pitch, about section (inspiration, what it does, how it was built, challenges, what we are proud of, what we learned, what is next), "built with" tags, try-it-out links (app and repo), image gallery with captions, thumbnail. Start the draft early; Devpost saves drafts.

### The Kiro write-up: every question the page asks, and our answer today

Judges must understand how effectively Kiro was used. Answer each point with evidence (file path, spec, journal entry, test or video moment). A point we did not try is better stated honestly than invented.

| Question on the page | What we have | Gap to close before Dec 1 |
|---|---|---|
| Kiro IDE, CLI, Web or Crew: how did they differ? | IDE with orchestrator-mode sub-agents | Try at least CLI and Web (or Crew) on one real task each, and write 3 to 5 plain sentences on the difference. |
| Custom agents | None | Create one useful custom agent (for example a spec-task reviewer or a stack-JSON linter) and record how it changed the work. |
| Agent hooks | None yet | Create the planned hooks (tests on save, validate stack JSON on save, `.kiro` and API-key guards, journal reminder) and record what each caught. |
| Spec-driven development vs vibe coding | Seven specs with requirements, design and tasks; thin slice built first | Measure a comparison: a small feature built by vibe coding versus by spec, with time, defects and rework. Write the numbers, not the opinion. |
| Steering docs | product, tech-stack, architecture, conventions, design-language, project-status, judging-criteria | Name the strategy that mattered most (for example the locked tech stack and the status file read at the start of every chat). |
| MCP | None | Add one MCP server that helps the build (for example docs lookup or a browser/Playwright server) and record what it made possible. |
| Property-based testing | Properties for closure, rejected-unchanged, purity, lossless export/import, repository agreement | Collect the real findings (for example: the contract test found a data-loss bug in the memory repository; the closure test timed out under load) in `docs/kiro-journal.md`. |
| Kiro powers | None | Check which powers fit (for example Cloudflare or testing powers) and use at least one, or say honestly that none fit. |

### Bonus prizes: decide by Nov 28
- [ ] **Best Demo ($1,000).** No extra steps; every eligible submission is considered. A tight video is the entry.
- [ ] **Bonus Blog Prize (100 winners, 2,000 Kiro credits each).** Highest odds of any prize. Publish a public post on a third-party platform (dev.to, Medium, Hashnode) **during the Submission Period**, about Kiro and the project, and **say it is written for the Kiroween 2026 hackathon**. Add the URL to the submission. Publish by Dec 2.
- [ ] **Social Blitz Prize (5 winners, 3-month Kiro Pro+).** One public post with **`#KiroweenHackathon26` at the very start**, about your favorite thing in Kiro and how it changed the way you build. Quality and insight are judged. Add the post URL.
- [ ] **Best Kiro Crew App ($1,000).** Needs a public GitHub repo URL for a Kiro Crew app and a description of its features. Decide whether to build a small Crew app (it may be a separate small repo). Open question in the brief.
- [ ] **Best Ghost of Kiroween Past ($2,000).** Only if registered for Kiroween 2025 (checked against 2025 records). Confirm; the project itself must still be new.
- [ ] **Best Startup Project ($10,000)** needs a founder confirmation, LinkedIn and a startup website. **Best Student Project: Resurrection ($1,500 plus a year of Kiro Pro Max)** needs every team member to be a student, with LinkedIn, student email, year, degree and school, and possible proof of enrollment. Decide honestly whether either applies; do not claim one that does not.

### Risks the existing criteria do not cover
- **Trademark wording (verify against the rules).** The rules forbid third-party trademarks in the video and materials. "HyperCard" and "Mac" are trademarks. Use "HyperCard" only as plain descriptive text for what is resurrected (for example "a HyperCard-style environment"), never a logo, screenshot or original sound or font, and never "Macintosh", "Finder", "System 6" or the Apple logo. Check the final video, README, thumbnail and app text for this. Also check for stray brand names of the AI providers in the UI; naming Groq or Gemini in text is fine, using their logos is not.
- **The demo must survive judging.** Judges test after Dec 4, possibly for days and possibly all at once. The shared free-tier model key can hit its rate limit or daily cap. Demo mode must degrade to recorded examples with a clear message, never to an error. Keep the Cloudflare Worker, the KV namespace and the hosted key alive until results are announced, and do not rotate or delete them. Run a smoke test of the deployed URL on Dec 3 and again on the last day of judging if known.
- **No secrets in the public repo.** The hosted key is a Worker secret (`wrangler secret`). Search git history, not only the working tree, before making the repo public or submitting: `git log -p | grep -i -E "api[_-]?key|sk-|gsk_|AIza"`. `.env.example` must hold names only.
- **The repo must run from the README on a clean machine.** Clone, install, run, open. Test that once on a fresh clone without your local files, including `pnpm` version, Node version and what to do with no key (demo mode).
- **Licenses of everything shipped.** Fonts (OFL), sounds, icons and the Ghost sprite listed in `docs/assets-licenses.md`; dependency licenses compatible with the repo license. AI-generated assets (if any) should be noted.
- **First 30 seconds matter.** Judges review many projects. The deployed app must show something alive and charming with no clicks, and one click must reach a working stack.
- **Devpost deadline arithmetic.** The page shows "Dec 4 at 5:00pm EST", which is 2:00 PM PST. Submit on Dec 3, not Dec 4. Re-open the submission after submitting and check every link and the video in a private window.
- **Accessibility claims must be true.** If the write-up says keyboard operable, contrast checked or reduced motion respected, the audit must have tested it (see `docs/manual-verification-persistence.md` for the pattern, and write one for the whole app).
- **Honest limits visible in the app and the write-up.** Examples: reminders fire only while the app is open or installed, stacks live only in this browser, the demo model is shared and rate limited, an own key is kept only in memory.
- **Video fidelity.** Record the deployed URL, not localhost. Use the recorded-provider fallback only if the live model is down, and say so; do not present recorded answers as live ones.

## Pre-submission audit procedure

Run it three times: about **Nov 28** (course correction), **Dec 1** (before the credits request deadline, 12:00 PM PT), and **Dec 3** (final).

1. Re-read the official rules and the submission checklist in `docs/kiroween-2026-project-brief.md`.
2. For each criterion, give a score from 0 to 10 and list the evidence (file, spec, test, screenshot, journal entry or video timestamp). A score without evidence counts as 0.
3. List every gap as a concrete task. Fix the highest-value gap per criterion first. Cut anything that does not raise a score.
4. Walk the app as a first-time judge with no key: one click to a working stack, nothing confusing, nothing broken, honest limits visible.
5. Walk the repo as a judge: `/.kiro` visible with specs, steering and hooks; license present; README runs the project; no secrets.
6. Watch the video cold. Does it show the app working end to end in under 3 minutes? Is the problem clear in 20 seconds?
7. Walk the **Submission checklist** above and tick every box with evidence; an unticked box is a gap.
8. Record the scores and gaps in the table below, with the date.

## Audit log

| Date | Impact | Tech | Design | Innovation | Presentation | Biggest gaps |
|---|---|---|---|---|---|---|
| 2026-11-15 (snapshot, not scored) | n/a | n/a | n/a | n/a | n/a | Hooks, MCP and custom agents not tried yet. No AI layer yet. UI is a first pass. No demo mode, no share link, no showcase stacks. Video not planned. |

## Red flags (fix before submitting)
- Any claim in the write-up that the repo cannot show.
- Features described in the video that are not in the deployed app.
- A UI state that looks like a prototype (default fonts, gray buttons, orange used for non-AI things).
- A judge needing a key or an account to see the product work.
- Missing license, `.kiro` ignored, or secrets in the repo.
