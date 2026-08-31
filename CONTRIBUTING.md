# Contributing

## Getting a working checkout

```bash
npm run setup    # install, generate Prisma clients, create+migrate both databases, seed
npm run dev      # api on :4000, web on :5173
```

`npm run setup` is self-healing — it creates both databases if they don't exist and applies every
migration. If anything about the environment looks wrong, **run `npm run doctor -w apps/api`
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

## Before you open a PR

```bash
npm run lint                        # typecheck api + web, then the SonarQube rules
npm run build
npm test                            # BOTH unit suites (api, then web) — mocked, no DB
npm run test -w apps/api            # just the api tier (~1s)
npm run test -w apps/web            # just the web tier (jsdom, ~2s)
npm run test:integration -w apps/api # integration (real throwaway MySQL, ~13s)
npm run test:e2e                    # Playwright (needs the dev servers, or it starts them)
```

CI runs all of these. Run at least `lint`, `build`, and the unit tier locally — they're fast, and
they catch most of what CI would.

**Why there are two unit tiers.** `apps/api`'s vitest runs in `node`; `apps/web`'s runs in `jsdom`,
because the one thing it currently covers — `src/lib/safe-html.ts` — is a sanitizer, and DOMPurify
needs a DOM. That file is the *only* sanitizer for two of its callers (Ask AI's model-authored
markdown, and the What's-new page's release notes fetched from GitHub), so it is a security control
rather than a formatting helper.

If you touch a security control, **mutation-test the suite before trusting it**: break the control on
purpose and confirm the tests go red. Disabling `safe-html`'s hook fails 12 of its 27. This is not
ceremony — the first version of that suite ran under `happy-dom`, where DOMPurify strips *every*
element, so "the dangerous thing is absent" assertions passed while proving nothing at all.

### Reading `npm run lint`

It runs `tsc --noEmit` over both apps and then `eslint` (`npm run lint:sonar`) with the SonarJS rule
set — the same analyzer SonarQube uses for JS/TS, so you see locally what the dashboard would say,
with no server or token involved.

**~400 warnings and 0 errors is the healthy state, and the command exits 0.** Warnings are not a
broken build; they are tracked debt. Most are three structural style rules (nested ternaries,
cognitive complexity, nested template literals) across code that predates the config, and the policy
— written down in `sonar-project.properties` — is to gate *new* code and burn the rest down as files
get touched. Rewriting ~100k lines for style would be a large unreviewable diff with no behavioural
benefit, and a permanently-red lint is one everybody learns to scroll past.

So: **keep errors at zero; don't chase the warning count, and don't switch rules off to lower it.**
If your change adds an error, fix the code rather than the config. The security-hotspot rules
(`sonarjs/pseudo-random`, `sonarjs/no-hardcoded-passwords`) are errors deliberately — a new
`Math.random()` should fail until somebody confirms it isn't generating a token. When it genuinely
isn't, mark it inline with the verdict rather than disabling the rule globally; `utils/security.ts`
and `middleware/request-telemetry.ts` show the comment style.

`tsconfig.base.json` sets `noUnusedLocals`, so dead imports and unused locals are build errors.
Unused *parameters* are deliberately still allowed — Express handlers and React callbacks
legitimately name arguments they don't use.

**The long-standing "hamburger drawer" flake is fixed** (2026-07-30) — it was never flaky logic.
`/api/auth/login`'s rate limiter counted *successful* logins, and `responsive.spec.ts` signs in
per test across five viewport projects (~75 logins), so late-suite specs 429'd on login and
failed as "element not visible". The limiter now uses `skipSuccessfulRequests` (only failed
attempts count — the actual brute-force surface), which also stops ~20 colleagues behind one
office NAT from locking out the 21st.

If a spec creates timesheets or tickets, wrap it with `suspendFaceGate()` from
`tests/e2e/helpers/face-gate.ts` — with face verification enabled workspace-wide those
creations return 428, and the failure surfaces as something unrelated (a detail sheet whose
ticket never loads).

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

This repo comments *why*, not *what*. A comment that restates the code earns nothing; a comment
explaining a non-obvious constraint, a rejected alternative, or a bug that a "simplification"
would reintroduce is worth a lot. Several files carry load-bearing header comments of exactly
this kind (`services/face.service.ts`'s model-loading notes,
`middleware/upload.ts#preserveTenantContext`, `controllers/sso.controller.ts`'s mount-order
warning) — please don't strip them.

Match the density around you. Most functions need nothing.

## Keeping docs current

`docs/ARCHITECTURE.md` is treated as a bug when out of date. If your change adds a
service/controller/worker, changes what a module depends on, or introduces a data flow, update it
in the **same** PR. Same for `docs/API.md` (endpoints), `docs/DATABASE.md` (schema), and
`README.md` (user-visible capability).

`docs/ROADMAP.md` is a living audit trail, not a changelog: resolved items stay (struck through)
alongside open ones, with dates and file references, so the history of what was found and fixed
stays visible.

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
and `npm run lint` prints `N problems (E errors, W warnings)`.

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
3. **Create the GitHub Release** for the tag, pasting the CHANGELOG section as the body. Optional
   for the What's-new page (it already has these notes), and still worth doing: a Release body can
   be corrected after shipping, and GitHub's copy wins the merge when it is non-empty.
4. CD builds and pushes the tagged images automatically — nothing to do.

**The guard.** `apps/api/tests/unit/changelog-releases.service.test.ts` fails the build when
`VERSION` has no matching CHANGELOG.md heading, or when the `## Unreleased` section has gone
missing. Step 1 half-done is therefore a red test, not a stale page nobody notices — which is how
eighteen sections of finished work once sat under `## Unreleased` for nine days.

## Security

Don't file a public issue for a vulnerability — see [.github/SECURITY.md](.github/SECURITY.md).
