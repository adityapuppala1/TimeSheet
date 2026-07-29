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

**One known flake:** `platform-admin › hamburger drawer reaches every nav item below lg` fails
intermittently under full-suite load but passes reliably in isolation. If that's your only
failure, it isn't you.

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

## Security

Don't file a public issue for a vulnerability — see [.github/SECURITY.md](.github/SECURITY.md).
