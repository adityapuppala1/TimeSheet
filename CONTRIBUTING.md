# Contributing

## Getting a working checkout

```bash
npm run setup    # install, generate Prisma clients, create+migrate both databases, seed
npm run dev      # api on :4000, web on :5173
```

`npm run setup` is self-healing — it creates both databases if they don't exist and applies every
migration. On a **clean clone** the first run stops after creating `apps/api/.env`, because the
template's `ENCRYPTION_KEY` is a deliberately invalid placeholder: fill that file in and run `setup`
again ([INSTALLATION.md § Manual local install](docs/INSTALLATION.md#manual-local-install-no-docker)
walks through every variable). If anything about the environment looks wrong, **run `npm run doctor -w apps/api`
first**: it validates `.env`, scans the machine for running MySQL servers (identifying each by its
actual handshake, not just an open port), and tells you the specific fix. `npm run doctor:fix-env
-w apps/api` will correct a wrong host/port in `.env` for you.

**After a `git pull` you do not need to remember `npm install`.** `npm run dev` and `npm run build`
compare `node_modules` against `package-lock.json` first (`scripts/ensure-deps.mjs`, wired to npm's
own `predev`/`prebuild` hooks) and install when the lockfile has moved. Before that, pulling a
release which added a dependency failed with `Cannot find package '…'` — a stack trace deep inside
Vite naming a package you had never heard of, which never says "run npm install". It is silent when
the tree is healthy, and it never fails the command: offline, you get a warning and the app still
starts.

Demo logins after seeding: `superadmin@timesheet.local` / `Admin@12345` (also `manager@…`,
`employee@…`).

**Don't rename or repurpose the seeded demo accounts in a dev workspace** — the Playwright
suites log in with those exact emails, so editing one (e.g. personalising the superadmin into
your own account) makes every suite fail at auth setup, and five retries later the login
lockout turns the symptom into 429s. Make yourself a *new* SUPER_ADMIN user instead and leave
the seeded three as fixtures.

## The local CI gate (runs before every push)

`npm install` installs a `pre-push` git hook that runs `scripts/local-ci.mjs`: lint (both
typechecks, the Sonar/promise rules, the warning ratchet), the production-dependency audit gate, and
the API and web unit suites — the same checks as CI's main job, minus MySQL integration and e2e.
It takes a few minutes the first time and is skipped for a commit that already passed on this machine
(or whose only changes since a pass are docs). Run it by hand with `npm run ci:local`.

**Why it exists:** the repository is private, so every GitHub Actions minute is billed. CI now runs on
pushes to `main`, on pull requests and on demand (`workflow_dispatch`) — not on every branch push.
A broken push is caught here, for free, instead of there. Emergency only: `git push --no-verify`;
CI on `main` still runs everything, including integration and e2e.

**The rest of CI, in local Docker: `npm run ci:docker`** (`-- --e2e` adds the browser suite,
`-- --keep` leaves the containers up). It runs what the pre-push gate cannot: the production build,
migrations against an empty MySQL 8.4, both seeds and the integration suite - inside the Playwright
Linux image with the same env values as CI, on your committed tree plus uncommitted edits. Run it
before a release or after touching migrations, seeds, Dockerfiles or anything Linux-sensitive; a
Linux- or database-only failure then shows up here instead of as a red run on `main`. Needs Docker
Desktop; the first run downloads the image (~2 GB).

## Before you open a PR

```bash
npm run lint                         # typecheck api + web, the SonarQube rules, floating promises, the ratchet
npm run build
npm test                             # BOTH unit suites (api, then web) — mocked, no DB
npm run test -w apps/api             # just the api tier
npm run test -w apps/web             # just the web tier (jsdom)
npm run test:integration -w apps/api # integration (real throwaway MySQL)
npm run test:e2e                     # Playwright (needs the dev servers, or it starts them)
```

What each of these covers, and which e2e variant to run when, is in [Testing](#testing) below. Run
at least `lint`, `build`, and the unit suites locally — they're fast, and they catch most of what CI
would.

CI runs the same commands, but not all of them on every push. Lint, build, both unit suites and the
integration tier run on every push to every branch. End-to-end runs as a light tier on pull requests
(the `desktop` and `responsive-phone` projects only) and in full on `main` — or on any branch whose
pushed commit message contains `[full-ci]`; a push to any other branch gets no e2e at all. So
Firefox, WebKit and the tablet/laptop/4K widths are first exercised by CI after you merge: run them
yourself when a change could differ there. The reasoning, and the billed minutes behind it, is at the
top of `.github/workflows/ci.yml`.

### Reading `npm run lint`

It runs `tsc --noEmit` over both apps and then `eslint` (`npm run lint:sonar`) with the SonarJS rule
set — the same analyzer SonarQube uses for JS/TS, so you see locally what the dashboard would say,
with no server or token involved.

**0 errors and a warning count at or below `lint-baseline.json` is the healthy state, and the
command exits 0.** Warnings are not a broken build; they are tracked debt. Most are three structural
style rules (nested ternaries, cognitive complexity, nested template literals) across code that
predates the config, and the policy is to gate *new* code and burn the rest down as files get
touched. Rewriting ~100k lines for style would be a large unreviewable diff with no behavioural
benefit, and a permanently-red lint is one everybody learns to scroll past.

**The ratchet.** That policy had one failure mode: nothing stopped the pile growing. It went from
roughly 400 to 700 without anybody deciding to let it, and at 700 the fifty warnings that might be
real bugs are indistinguishable from the six hundred that are formatting opinions. So `npm run lint`
ends with `scripts/lint-ratchet.mjs`, which reads `lint-baseline.json` — a per-rule ceiling — and
fails when any rule's count goes *up*. Going down is applauded and the script tells you to lower the
ceiling (`node scripts/lint-ratchet.mjs --update`, committed with the change). Per rule rather than
a total, so removing a nested ternary cannot pay for adding a slow regex — those are not the same
kind of warning. A rule vanishing from the report entirely also fails, so switching one off is a
visible edit to the baseline rather than a silent drop.

**Floating promises — a second, type-aware pass (`npm run lint:promises`).** SonarQube's S9383
("promises must be awaited, end with `.catch`, or be marked with `void`") needs type information to
know what a promise is, and the main pass has none, so it never saw one — 280 had accumulated in
`apps/web` before SonarQube for IDE showed them. None was a bug (cache refreshes and navigations that
cannot usefully reject), but nothing would have flagged one that was. `eslint.promises.config.mjs`
runs exactly one rule, `@typescript-eslint/no-floating-promises`, with types, in about twenty
seconds, and **fails on any hit** — there is no ceiling to hide under. It is a separate file because
giving the main pass types would change what dozens of sonarjs rules report and invalidate the
ratchet. Fixing a hit without changing behaviour:

- a plain function call or an async IIFE → `void navigate("/x")`, `void (async () => …)()`;
- a method call or a `.then` chain → `runInBackground(queryClient.invalidateQueries(…))`
  (`apps/web/src/lib/run-in-background.ts`) — `void` on a *method* call trips the local
  `sonarjs/void-use`, which cannot see types and only exempts plain calls;
- or, where the caller should wait, `await` it or `return` it from the handler.

When the ratchet fails you, in order of preference: fix the warning; or suppress it *at the line*
with a comment saying why (an `eslint-disable-next-line` with a reason is a decision someone can
review — put the reason on the lines above and the directive as the last line before the code, or
ESLint reports the directive as unused); or raise the ceiling in its own commit, with the reason
in the message. `AdminPages.tsx`'s project-form effect shows the suppression style.

**The rules that are questions, not defects — and the answer is to measure.** `sonarjs/slow-regex`
says "make sure this cannot lead to denial of service". It is asking. When the flagged regexes in
`backup-destination.service.ts` were first *timed* against their own worst-case input, the result
inverted the obvious fix: the alternation `/^\/+|\/+$/g`, flagged eleven times, is **linear** at
fifty thousand characters, while the innocuous-looking `/\/+$/` beside it is **quadratic** —
0.3ms at a thousand slashes, 797ms at fifty thousand. Splitting the alternation "to be safe" would
have introduced eleven copies of the only genuinely slow pattern in the file. The quadratic one is
gone; `apps/api/tests/unit/regex-redos-budget.test.ts` now drives every assessed pattern at
pathological size and fails if one regresses. **A newly flagged regex gets added to that file as
part of assessing it** — the number, not the opinion, is what closes the warning. The same goes for
`react-hooks/exhaustive-deps`: read the effect and decide whether it is keyed on an identity on
purpose (usually) or has a genuinely stale closure (occasionally, and those have bitten — see the
practice-update draft restore in the 5.2.0 notes).

So: **keep errors at zero; never let a rule's count rise; and answer the "question" rules with a
measurement rather than a rewrite.** If your change adds an error, fix the code rather than the
config. The security-hotspot rules (`sonarjs/pseudo-random`, `sonarjs/no-hardcoded-passwords`) are
errors deliberately — a new `Math.random()` should fail until somebody confirms it isn't generating
a token. When it genuinely isn't, mark it inline with the verdict rather than disabling the rule
globally; `utils/security.ts` and `middleware/request-telemetry.ts` show the comment style.

`tsconfig.base.json` sets `noUnusedLocals`, so dead imports and unused locals are build errors.
Unused *parameters* are deliberately still allowed — Express handlers and React callbacks
legitimately name arguments they don't use.

## Testing

There are two kinds of suite, and they answer different questions. **Unit tests** check the rules
— the schedule solver, the change risk score, the SLA clocks, the CSV escaper, the changelog parser
— against no database at all, which is why the api suite's thousands of tests finish in under a
minute and why a failure points at a rule rather than a fixture. **End-to-end specs** drive a real
browser against a real seeded database, and are where anything needing one belongs. A small
**integration tier** sits between them for the few behaviours a mock cannot prove.

Current test and spec counts are in README's [By the numbers](README.md#by-the-numbers), which is
recounted each release; they are deliberately not repeated here.

### Unit tests

```bash
npm test                             # both suites: apps/api (node), then apps/web (jsdom)
npm run test:coverage -w apps/api    # the api suite with v8 coverage (text + lcov, which Sonar reads)
```

`apps/api/vitest.config.ts` points `DATABASE_URL` at a database that must never be reached, so a
unit test that forgets to mock something fails fast and loudly rather than quietly touching real
data. The mocking approach differs by area and is written in each test file's header — read the
neighbouring file's before adding one.

**Why there are two unit tiers.** `apps/api`'s vitest runs in `node`; `apps/web`'s runs in `jsdom`,
because it was created for `src/lib/safe-html.ts` — a sanitizer, and DOMPurify needs a DOM. It has
since grown to cover other web-side logic, but it is still deliberately not a component-testing
harness (see the header of `apps/web/vitest.config.ts`). `safe-html.ts` is the *only* sanitizer for
two of its callers (Ask AI's model-authored markdown, and the What's-new page's release notes
fetched from GitHub), so it is a security control rather than a formatting helper.

If you touch a security control, **mutation-test the suite before trusting it**: break the control on
purpose and confirm the tests go red. Disabling `safe-html`'s hook fails 12 of its 27. This is not
ceremony — the first version of that suite ran under `happy-dom`, where DOMPurify strips *every*
element, so "the dangerous thing is absent" assertions passed while proving nothing at all.

### Integration tier

```bash
npm run test:integration -w apps/api
```

Runs against a real throwaway MySQL: the tenant and control-plane test databases are dropped,
recreated, migrated and seeded at the start of every run and dropped at the end
(`apps/api/tests/setup/global-setup.integration.ts`). It is for what a mock assertion can't prove —
that the Stripe webhook really persists `Organization.planTier`, and that SCIM's seat limit,
duplicate-email 409 and status transitions hold against real unique constraints and real counts.
`multi-workspace-routing.integration.test.ts` lives here too: it drives the real CORS and
tenant-resolution middleware over HTTP, because the pure-function tests of each had passed
throughout the period when subdomain routing didn't work in a browser at all. Files run serially
(`fileParallelism: false`) since they share one pair of databases.

### End-to-end (Playwright)

```bash
npm run test:e2e             # everything: 7 projects — 5 viewports + Firefox + WebKit
npm run test:e2e:quick       # day-to-day loop: every FUNCTIONAL spec once, desktop project only
npm run test:e2e:responsive  # layout-only matrix: responsive.spec.ts at phone/tablet/laptop/4K, 2 workers in parallel
npm run test:e2e:browsers    # engine coverage: a functional subset on Firefox (Gecko) + WebKit (Safari/iOS)
npm run test:e2e:report      # open the last run's HTML report
```

**Cross-browser needs a one-time download:** `npx playwright install firefox webkit`. Three engines
cover every browser this product gets asked about — Chrome, Edge, Opera, Brave and Arc are all
Chromium; Firefox is Gecko; Safari is WebKit, **as is every browser on iOS**, whatever its icon
says. Testing "Chrome on iPhone" is testing WebKit. The two engine projects run a subset (auth,
tickets, timesheet, dashboard, settings, user-management — see `playwright.config.ts`), because the
question there is whether the app *functions* on each engine, not whether viewport assertions pass
three times.

**Which one to run:** `test:e2e:quick` while iterating (it exercises every feature spec once —
the viewport projects only re-run `responsive.spec.ts` at other sizes); `test:e2e` before a push.
Three things keep the clock down and are worth knowing:

- **Keep `npm run dev` running between test runs.** `webServer.reuseExistingServer` is on, so a
  live dev stack skips booting both servers on every invocation.
- **The responsive matrix is parallel (2 workers) on purpose, and the functional suite is
  serial on purpose.** `responsive.spec.ts` is read-mostly, so its four viewport projects can
  overlap safely. The functional specs CANNOT be parallelised: they share one seeded MySQL
  database, one login rate-limiter, and several deliberately mutate workspace-wide state
  (maintenance mode locks the workspace; force-logout revokes sessions) — two of those running
  at once would fail each other in ways that look nothing like their cause.
- **Never run `quick` and `responsive` at the same time** for the same reason: the maintenance
  spec's lockout window would 503 every page the layout sweep is measuring.

A one-time `setup` project logs in as each demo role and saves the resulting session for the
other specs to reuse. Some specs deliberately log in fresh instead, and `tests/e2e/auth.setup.ts`
explains why: every refresh rotates the session's secret, and an older secret is accepted only if
it is the immediately-previous one and still inside the rotation grace window (see session handling
in [.github/SECURITY.md](.github/SECURITY.md)). Two specs sharing a snapshot can revoke each other,
and a spec with many tests exhausts its own snapshot partway through — so a multi-test spec signs
in per test.

That costs nothing against the login rate limiter, which counts only failed attempts — and that
is also why **the long-standing "hamburger drawer" flake is fixed** (2026-07-30). It was never flaky
logic. `/api/auth/login`'s rate limiter counted *successful* logins, and `responsive.spec.ts` signs
in per test across five viewport projects (~75 logins), so late-suite specs 429'd on login and
failed as "element not visible". The limiter now uses `skipSuccessfulRequests` (only failed
attempts count — the actual brute-force surface), which also stops ~20 colleagues behind one
office NAT from locking out the 21st.

If a spec creates timesheets or tickets, wrap it with `suspendFaceGate()` from
`tests/e2e/helpers/face-gate.ts` — with face verification enabled workspace-wide those
creations return 428, and the failure surfaces as something unrelated (a detail sheet whose
ticket never loads).

### Face verification

```bash
npm run verify:face -w apps/api       # ML layer: embeddings, anti-spoof/liveness, encryption round-trip
npm run verify:face:e2e -w apps/api   # full HTTP flow against a RUNNING API, incl. challenge–response and the approval gate
```

These sit outside the unit suite because the ML half can't be unit-tested: it needs the real ~10MB
models and real face images. What each script checks — plus the presentation-attack self-test
(`verify:face:pad`) and the `/api/face` rate limit that trips two back-to-back runs — is in
[docs/FACE_VERIFICATION.md](docs/FACE_VERIFICATION.md#verifying-it-works).

## How this codebase expects to be extended

The single most useful thing to internalise: **prefer extending an existing choke point over
adding a parallel system.** Most of what makes this codebase navigable is that there's exactly one
place for each kind of thing.

| If you're adding… | Extend this, don't build a new one |
|---|---|
| An AI capability | `services/ai.service.ts` — go through `preflight()` + `callChat()` so the master switch, per-feature toggle, and budget cap apply automatically |
| An admin-configurable toggle | A `Global*Settings` singleton (`id = "global"`, upsert-on-read) + a Workspace Settings card |
| A scheduled job | A `workers/*.worker.ts` wrapping its body in `runForEveryOrg()` — cron has no request to resolve a tenant from |
| A database query | The `prisma` proxy from `config/prisma.ts` — it resolves to the active tenant's client automatically. Never construct a `PrismaClient` in a request path |
| An endpoint accepting a file | Wrap the multer middleware in `preserveTenantContext()` — see its header for the size-dependent bug that exists without it |
| A per-user admin-set field | Mirror `User.designation` / `User.hourlyRate` (schema → create/patch zod → `data` assignment → both admin forms) |

## Code comments

**Every non-trivial file opens with a header comment** answering four questions: **what** it does,
**why** it exists (the actual reason, not a restatement of the filename), **how** it fits into the
surrounding system, and **who** calls it. New files get one too.

Below the header, this repo comments *why*, not *what*. A comment that restates the code earns
nothing; a comment explaining a non-obvious constraint, a rejected alternative, or a bug that a
"simplification" would reintroduce is worth a lot. Several files carry load-bearing header comments
of exactly this kind (`services/face.service.ts`'s model-loading notes,
`middleware/upload.ts#preserveTenantContext`, `controllers/sso.controller.ts`'s mount-order
warning) — please don't strip them.

Individual functions get inline comments only where the logic itself is genuinely non-obvious —
clear naming and the file header cover the rest, and a function-by-function narration rots into
noise as the code changes around it. Match the density around you: most functions need nothing,
and a new file should be neither undocumented nor commented line by line.

## Keeping docs current

**[docs/README.md](docs/README.md) is the map of which document owns which topic.** Check it before
writing, and give a new doc a row there. Two rules keep the set navigable:

- **One canonical home per topic.** Every other doc — `README.md` included — links to it rather
  than restating it, because a fact written in two places eventually disagrees with itself.
  `README.md` stays a front door: the overview, the feature table, "By the numbers", the quick start
  and links, and nothing a doc in `docs/` already explains.
- **`docs/` is flat, and doc file names are permanent.** Their paths are referenced from code
  comments, CI, the UI and applied migrations, so a rename or a move breaks links in places no
  reviewer will look. When a topic outgrows its doc, add a new file and link to it.

`docs/ARCHITECTURE.md` is treated as a bug when out of date. If your change adds a
service/controller/worker, changes what a module depends on, or introduces a data flow, update it
in the **same** PR. Same for `docs/API.md` (endpoints), `docs/DATABASE.md` (schema), and
`README.md`'s feature table (a headline capability).

**Three records, three jobs.** `docs/ROADMAP.md` looks forward: themes, and a backlog that is a
living audit trail — resolved items stay (struck through) alongside open ones, with dates and file
references, so the history of what was found and fixed stays visible. `docs/ENGINEERING_LOG.md` is
the dated narrative of a unit of work — what was found, decided, measured and fixed — with new
entries appended at the **end**, oldest first. `CHANGELOG.md` is the user-facing release notes,
which the in-app What's-new page parses (see [Releasing a version](#releasing-a-version)).

### Regenerating README's "By the numbers"

That table is counted, not estimated, so it goes stale silently. Re-run these from the repo root
before a release and correct any that moved:

```bash
echo "routes      $(grep -rhoE '\.(get|post|put|patch|delete)\("' apps/api/src/controllers/*.ts | wc -l)"
echo "controllers $(ls apps/api/src/controllers/*.ts | wc -l)"
echo "models      $(grep -c '^model ' apps/api/prisma/schema.prisma)"
echo "enums       $(grep -c '^enum ' apps/api/prisma/schema.prisma)"
echo "migrations  $(ls apps/api/prisma/migrations | grep -c '^2')"
# The control plane migrates SEPARATELY from the tenants and its count moves on its own — the two
# have drifted in the README before, because one command runs both and nothing prints the split.
echo "ctrl migr   $(ls apps/api/prisma/control/migrations | grep -c '^2')"
echo "services    $(ls apps/api/src/services/*.ts | wc -l)"
echo "workers     $(ls apps/api/src/workers/*.ts | wc -l)"
echo "web pages   $(find apps/web/src/pages -name '*.tsx' | wc -l)"
echo "e2e specs   $(find tests -name '*.spec.ts' | wc -l)"
# SCOPED TO THE OBJECT'S OWN BRACES, and that is not a nicety. The unscoped version of this line
# matched every `KEY: "value"` in the whole FILE and answered 88 — it had already swept up the
# plan-tier and status-bucket records, and 5.0.0's `platformCapabilities` block made the gap
# impossible to miss. The RBAC answer is 20. Same failure shape as the email-template note below:
# a pattern that happens to agree with the truth once, and is never checked again.
echo "permissions $(sed -n '/^export const permissions = {/,/^} as const;/p' packages/shared/src/index.ts | grep -cE '^\s+[A-Z_]+:\s*\"')"
# The platform console's operator capabilities are a SECOND, separate authority model — five
# capabilities over five console roles, in the control plane, never mixed with the tenant RBAC keys
# above. Counted apart because adding the two together would describe a role nobody holds.
echo "console cap $(sed -n '/^export const platformCapabilities = {/,/^} as const;/p' packages/shared/src/index.ts | grep -cE '^\s+[A-Z_]+:\s*\"')"
# Ask the script that enumerates them, rather than pattern-matching the source. Two patterns have
# already under-counted this: one that only matched the SEED file (22, while the editor lists every
# registered key), and one that only matched QUOTED keys (32, missing the three bare ones like
# `welcome:`). TEMPLATE_KEYS is what the editor renders, so it is the only honest answer.
echo "email tmpl  $(cd apps/api && npx tsx scripts/send-test-email.ts --list 2>/dev/null | grep -cE '^  [a-z]')"
```

Test and lint counts come from the tools themselves — `npm test -w apps/api` prints the suite total,
and `npm run lint` prints `N problems (E errors, W warnings)` followed by the ratchet's per-rule
line. The README quotes the ratchet's total; `lint-baseline.json` is the number it is held to.

### Checking the Mermaid diagrams

`README.md` and `docs/ARCHITECTURE.md` carry Mermaid diagrams. A diagram that does not parse renders
on GitHub as a raw red error box — strictly worse than no diagram — and nothing else here catches it,
because a broken fence is still valid markdown. **Check one when you add or edit it.**

Either paste the block into [mermaid.live](https://mermaid.live), or run the whole set through
mermaid itself. There is deliberately no repo script for this: mermaid needs a DOM even to validate,
so it drags in jsdom, and neither belongs in this project's dependency tree for a docs check. Node's
ESM resolver also ignores `NODE_PATH`, so `npx -p mermaid` alone will *not* work — the checker has to
live beside its own install:

```bash
mkdir -p /tmp/mermaid-check && cd /tmp/mermaid-check
npm init -y && npm install mermaid@11 jsdom
cat > check.mjs <<'EOF'
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const mermaid = (await import("mermaid")).default;
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
let bad = 0;
for (const f of process.argv.slice(2)) {
  const text = readFileSync(f, "utf8").split("\r").join("");
  for (const [, body] of text.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    const head = body.trim().split("\n")[0];
    try { await mermaid.parse(body); console.log("  ok   ", head); }
    catch (e) { bad++; console.log("  FAIL ", head, "—", String(e.message).split("\n")[0]); }
  }
}
process.exit(bad ? 1 : 0);
EOF
node check.mjs /path/to/repo/README.md /path/to/repo/docs/ARCHITECTURE.md
```

Twelve diagrams parse as of v3.0.0.

## Migrations

```bash
npx prisma migrate dev --name descriptive_name --schema=prisma/schema.prisma
```

One migration folder per change. In the multi-org SaaS shape, a new migration must reach every
tenant database — `npm run migrate:tenants -w apps/api` fans it out.

## Releasing a version

**`VERSION` + `CHANGELOG.md` ARE the release, and step 1 alone is enough for every surface inside
a running installation.** The in-app **What's new** page (`/app/whats-new`) builds its Release
history from the CHANGELOG.md that ships in the build (`changelog-releases.service.ts`), and the
upgrade announcement in everyone's bell (`release-announce.service.ts`) reads the same file. The
git tag and the GitHub Release still matter — for CD, for `update.sh`, and for telling *other*
installations that something newer exists — but nothing in the product waits on them any more.

That is deliberate, and it is the fix for a real failure: the page used to render GitHub's list, so
`2.1.0`, `2.2.0` and the running `2.4.0` were invisible on it for as long as their tags went
unpushed — while the notes sat in the very bundle being served. See
`update-check.service.ts#withBundledHistory`.

1. **Bump `VERSION`** (the repo-root file — the single source; nothing reads package.json
   versions) and rename `## Unreleased` in `CHANGELOG.md` to `## <version> — <name> — <date>`,
   then open a fresh `## Unreleased` above it. Write for the people using the app, not for the
   diff. Group into `###` sections — ✨ Features / 🐛 Fixes / 🔒 Security / ⚡ Performance /
   🚢 Deployment / 📦 Dependencies, or a sentence carrying one of those emoji. **The emoji is a
   category tag, not decoration:** What's-new reads it to label each section (see
   `NOTE_CATEGORIES` in `apps/web/src/pages/WhatsNew.tsx`), and a section with no recognisable
   emoji or keyword shows up as a generic grey "Changes" chip.
2. **Commit, then tag**: `git tag v1.2.0 && git push origin main v1.2.0`. The tag must match
   VERSION exactly (`v` prefix on the tag only) — `update.sh` verifies the server reports the
   tag's version after upgrading, so a mismatch fails every customer's update.

   **Push the branch and the tag in that ONE command.** CI no longer runs on tag pushes (a tag
   points at a commit `main` has already tested, and re-running it cost 120 billed minutes per
   release — see the note on `on.push` in `.github/workflows/ci.yml`). The "Every changelog version
   is tagged" job runs on `main`, so if you push the branch first and the tag afterwards, that job
   fails on the branch run and **stays** failed until the next push to `main` — a workflow run
   belongs to one ref, and the later tag push starts no run that could clear it. Pushed together,
   the tag already exists when the job looks for it. This is not hypothetical: it is what turned
   `main` red on 2026-09-28.
3. **Create the GitHub Release** for the tag, pasting the CHANGELOG section as the body. Optional
   for the What's-new page (it already has these notes), and still worth doing: a Release body can
   be corrected after shipping, and GitHub's copy wins the merge when it is non-empty.
4. CD builds and pushes the tagged images automatically — nothing to do.

**The guards — and run the WHOLE suite after step 1, not before it.**
`apps/api/tests/unit/changelog-releases.service.test.ts` fails the build when `VERSION` has no
matching CHANGELOG.md heading, or when the `## Unreleased` section has gone missing. Step 1
half-done is therefore a red test, not a stale page nobody notices — which is how eighteen sections
of finished work once sat under `## Unreleased` for nine days.
`apps/api/tests/unit/update-check.service.test.ts` fails when any version in CHANGELOG.md is missing
from the What's-new release history. That one reads the *real* changelog, so **the version bump is
itself a change the full suite has to run after** — 5.2.0 went out red on both branches because the
suite had run before the bump and only the parser test after, and the new heading was the 41st
entry that tripped a cap nobody remembered was there.

## Security

Don't file a public issue for a vulnerability — see [.github/SECURITY.md](.github/SECURITY.md).
