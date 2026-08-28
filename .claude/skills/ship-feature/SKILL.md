---
name: ship-feature
description: The checklist for landing ANY new feature in TimeSphere so every surface that describes the product moves with it — landing page, web pitch deck, PPTX/HTML pitch exports, the in-app Help manual, Ask AI's capabilities, changelog/version/Helm/README, install/update scripts, compose/Helm/CI. Use whenever a feature is added, renamed or removed, and before any release. Also fixes the UI-component rule (in-tree reactbits/magicui/untitledui patterns or plain Tailwind — never vendored).
---

# Shipping a feature in TimeSphere

A feature is not shipped when its code merges. It is shipped when every surface that *describes*
the product agrees it exists. This repo has been bitten repeatedly by two hand-written copies of
the same list drifting apart (connectors, proposal target types, pitch exports, help vs assistant),
so most of the work below is now **derived from one source and guarded by a test** — the job is
to know which source to touch, and to let the guard tell you what you forgot.

## 1. The surfaces, and the one place each is fed from

| Surface | Fed from | Guard that fails if you forget |
|---|---|---|
| Landing page feature grid + stat band | `apps/web/src/pages/Landing.tsx` → `FEATURES` (count is derived, never typed) | — write the entry; the count moves itself |
| Landing "Connects to…" diagram + count | `apps/web/src/components/marketing/connectors.ts` | count derived from the same array |
| Web pitch deck (`/pitch`) | `apps/web/src/pages/PitchDeck.tsx` → `SLIDES`, `SURFACES`, `MOATS`, `NEXT` | `apps/web/tests/unit/pitch-export.test.ts` |
| PPTX + HTML pitch exports | `scripts/pitch-export/content.mjs` (**second copy of the deck's words — deliberate, guarded**) | same test: every page slide must exist in the export, in order; `ask`/`team` are export-only |
| In-app Help manual (`/app/help`) | `packages/shared/src/help-articles.ts` | `apps/api/tests/unit/help-articles.test.ts` (ids unique, steps present, screenshots exist, role gating) |
| Ask AI how-to answers | **the same** `help-articles.ts` via the `help_articles` tool — nothing to do twice | same test |
| Ask AI data capabilities | `apps/api/src/services/ai-chat-tools.ts` / `ai-chat-admin-tools.ts` + the READING INTENT lines in `ai.service.ts` | `ask-ai-chat.test.ts` pins the exact tool list — add the name there |
| Enum-keyed marks (chat platforms, SSO, AI providers) | `apps/web/src/components/ui/connector-marks.tsx` `Record<Enum, Mark>` | total records: a new enum member fails to compile until it has a mark |
| Plan-tier claims on pricing | `packages/shared` `PLAN_TIER_LIMITS` (never typed into the dialog) | `plan-tier-claims.test.ts` |

**Rule of thumb:** if you are about to write the same feature name into a second file by hand,
stop and check the table — there is almost certainly a derived source and a test.

## 2. What a new feature touches, in order

1. **Code + tests** — the feature itself. Prefer pure functions for the rules; mock Prisma only
   at the edges. Run the falsification check: break the rule on purpose, watch the test go red.
2. **Help article** — add to `help-articles.ts`: `where` is a real nav path, `steps` are real
   clicks, `roles` gates the reader, `screenshot` only if a real capture exists in
   `apps/web/public/product/`. This *is* the Ask AI update; there is no second step.
3. **Ask AI capability** (only if the feature exposes new data) — a read tool in the registry, a
   READING INTENT hint line, the pinned-list test. Every tool is a read; the guard greps for
   Prisma write verbs.
4. **Landing `FEATURES` entry** — one paragraph, every clause mapping to shipped code. Claim no
   traction, ever (`docs/MARKETING_PAGES.md`).
5. **Pitch deck** — `SURFACES`/`MOATS`/`NEXT` in `PitchDeck.tsx` *and* the matching prose in
   `scripts/pitch-export/content.mjs`; then `npm run pitch` and look at both outputs. If a slide
   is added, the export test tells you the moment the two lists disagree.
6. **Screenshots** — if the feature has a screen worth showing, capture it via
   `tests/e2e/screenshots.spec.ts` (anonymised) and reference it from the help article and deck.
7. **Docs** — `docs/API.md` for endpoints/tools, `README.md` feature table if it is a headline
   capability, `docs/NEW_ORGANIZATION_SETUP.md` if operators must configure something.
8. **Operations** — new env var? Add it to `apps/api/src/config/env.ts` **and** forward it in
   `docker-compose.yml`, `docker-compose.external-db.yml`, `deploy/helm/timesphere/values.yaml`
   + `templates/configmap.yaml` — a variable that exists only in `.env` does not exist inside a
   container. New migration? `install.*`/`update.*` already run `migrate deploy`; confirm
   `npm run setup` still passes from a clean clone. CI needs nothing unless a new workspace or
   service appears.
9. **Release** — `VERSION`, `CHANGELOG.md` (emoji-tagged `###` sections; check them through
   `parseChangelogReleases`), `deploy/helm/timesphere/Chart.yaml` `appVersion` (CI asserts it
   matches VERSION), README "By the numbers" recounted from the one-liners in CONTRIBUTING.md.
   Then tag, push `V10` and `main`, `gh release create`, watch CI.

## 3. Verify in the running app, not by reading

Use the `run-timesphere` skill. For anything visual, screenshot both themes and a phone width; for
anything the assistant should know, ask it the question as the least-privileged role that should
get an answer and check `toolCalls` in the response. A claim verified only by tests passing has
been wrong in this repo more than once.

## 4. The UI-component rule

Patterns from reactbits.dev, magicui.design and untitledui are **implemented in-tree against the
theme tokens** (`hsl(var(--primary))` etc.), never vendored as a dependency — see `BorderGlow`,
`AnimatedBeam`, `AnimatedThemeToggler`, `MarketSizing` for the house versions. Plain Tailwind is
the alternative. Two hard constraints: nothing animation-heavy on the landing page's default path
(three.js is a gated dynamic import), and no always-running animation of a non-compositable
property (measure with `RecalcStyleCount`; the AI-label incident is documented in `index.css`).
Brand marks (Google, Microsoft, Slack…) keep their own colours in both themes; protocol glyphs use
`currentColor`. Every icon is a lucide component or an inline SVG in `connector-marks.tsx` /
`provider-marks.tsx` — no icon fonts, no remote images.

## 5. Traps that have cost rounds here

- Heredocs eat backslashes (`\b` → 0x08, `\n` → newline). Any content with a backslash goes
  through the Write/Edit tool. Byte-check touched files for 0x00/0x08 before committing.
- `size-*` Tailwind utilities do not reach this project's stylesheet; use `h-* w-*`.
- A background job's working directory is wherever the shell was; release scripts must `cd` to
  the repo root or they silently skip.
- `/app/...` arguments through Git Bash get rewritten to a Windows path; use the PowerShell tool.
