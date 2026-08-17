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

Demo logins after seeding: `superadmin@timesheet.local` / `Admin@12345` (also `manager@…`,
`employee@…`).

**Don't rename or repurpose the seeded demo accounts in a dev workspace** — the Playwright
suites log in with those exact emails, so editing one (e.g. personalising the superadmin into
your own account) makes every suite fail at auth setup, and five retries later the login
lockout turns the symptom into 429s. Make yourself a *new* SUPER_ADMIN user instead and leave
the seeded three as fixtures.

## Before you open a PR

```bash
npm run lint                        # typecheck api + web
npm run build
npm run test -w apps/api            # unit (mocked, no DB, ~1s)
npm run test:integration -w apps/api # integration (real throwaway MySQL, ~13s)
npm run test:e2e                    # Playwright (needs the dev servers, or it starts them)
```

CI runs all of these. Run at least `lint`, `build`, and the unit tier locally — they're fast, and
they catch most of what CI would.

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
