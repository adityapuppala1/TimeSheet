# Signup Phase 1 — one workspace per company domain: build plan

> **Audience:** whoever builds Phase 1 (human or agent) · **Type:** implementation plan ·
> [Documentation index](README.md)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** a second signup from a company domain that already has a workspace becomes a request to
join it — never a second database — and platform admins get a daily summary plus Signups and Company
domains pages in the console.

**Architecture:** signup gains a server-side verify step that returns a decision (member / join /
unavailable / create) and a continuation token, so the email code is checked before any workspace is
revealed and is no longer burned by a taken address. Company-domain claims (`OrgEmailDomain`, unique
per domain) and a signup funnel (`SignupAttempt`) live in the control plane; join requests live in the
target workspace's own database and are decided on Users → Requests. A daily digest is sent once per
day across replicas through a claim row (`PlatformJobClaim`).

**Tech stack:** Express 5, Prisma 6 (tenant + control-plane schemas, MySQL 8 / MariaDB), Vitest +
supertest, React 19 + TanStack Query, `tldts` (Public Suffix List).

**Spec:** [SIGNUP_AND_DOMAINS_PLAN.md](SIGNUP_AND_DOMAINS_PLAN.md) — read §2 (decisions 1–9) and §5
before any task. This plan argues from it.

## Global constraints

- Branch `V13-signup-domains`. **Never merge it into V13 or main, and never push, without the user's
  explicit confirmation.** Small conventional commits, each ending with the repo's Co-Authored-By line.
- Migrations are additive. Tenant migrations guard DDL with the house `information_schema` +
  `PREPARE` pattern; control-plane migrations are hand-written in canonical casing (Windows MariaDB
  lower-cases introspected names). Replay every new migration into an EMPTY database before
  committing (docs/DATABASE.md). Exception, recorded in Task 2: the unmerged Phase 0 migration is
  amended rather than followed by a second one.
- Only an **ACTIVE** workspace accepts join requests; GRACE, SUSPENDED and PROVISIONING answer
  "unavailable" (decision 8). ARCHIVED workspaces hold no claims.
- Join-request expiry comes from `PlatformSignupSettings.joinRequestTtlDays`, default **14** (decision 7).
- Operator notification mode is `DAILY` by default; `EACH` keeps Phase 0's per-signup email; `OFF`
  sends nothing (decision 6).
- Company domain = registrable domain via `tldts` with private suffixes ON, except
  `SHARED_EMAIL_HOSTS` (starting with `onmicrosoft.com`), where it stops one label below (decision 9, §5.2).
- Approved joiners default to `EMPLOYEE`; the approver may pick another role (decision 3).
- No workspace's existence is revealed before the email code is returned (verify-first, §5.6).
- No password is collected before approval; approval sends a single-use set-password link valid **72 hours**.
- The console page for email-domain claims is named **Company domains** (`/platform-admin/company-domains`)
  — "Domains" already means custom hostnames (`OrgDomain`, `DomainsDialog.tsx`).
- Lint ratchet: `npm run lint` must end at or below `lint-baseline.json`; fix new warnings, never raise
  ceilings. `npm test` (api + web) green. Every new safety rule gets a falsification check: break it,
  watch its test fail, restore.
- Use the Edit/Write tools for files containing backslashes (shell heredocs eat them here).

## Review focus

Inputs and conditions the spec implies but no happy-path test exercises — each one has its test in
the owning task:

1. **Two Microsoft 365 companies on default addresses** (`a@contoso.onmicrosoft.com`,
   `b@fabrikam.onmicrosoft.com`) must be two companies, not one — Task 1.
2. **Two people from a brand-new domain finishing signup at the same moment** must produce one
   workspace and one join path, never two databases — Task 7 (unique-claim race).
3. **A taken workspace address** must not burn the person's verification — they correct the address and
   continue — Task 7.
4. **A requester who is already a member** (an admin added them while the request was pending) must not
   get a second account on approval, nor a seat charged twice — Task 8.
5. **A join request for a workspace that became SUSPENDED after the request was made** must not be
   approvable into a seat-less, locked workspace without a clear message — Task 8 (approval refuses
   while the workspace is not ACTIVE).

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/utils/company-domain.ts` (new) | `companyDomainOf`, `SHARED_EMAIL_HOSTS` | 1 |
| `apps/api/package.json` | add `tldts` dependency | 1 |
| `apps/api/prisma/control/schema.prisma` | `PlatformSignupSettings.notifyMode/joinRequestTtlDays`; `OrgEmailDomain`, `SignupAttempt`, `PlatformJobClaim`, `Organization.createdVia` | 2, 3 |
| `apps/api/prisma/control/migrations/20261001120000_…/migration.sql` | amended (unmerged Phase 0) | 2 |
| `apps/api/prisma/control/migrations/20261002090000_company_domains_and_signup_funnel/migration.sql` (new) | Phase 1 control tables + `createdVia` backfill | 3 |
| `apps/api/src/services/platform-signup.service.ts` | notify mode, TTL setting | 2 |
| `apps/api/src/services/company-domain-claims.service.ts` (new) | claim / lookup / release / reassign / backfill | 4 |
| `apps/api/src/services/signup-funnel.service.ts` (new) | `recordSignupStage` | 5 |
| `apps/api/src/services/workspace-directory.service.ts` | continuation tokens | 6 |
| `apps/api/src/controllers/signup.controller.ts` | `/verify`, `/complete` via continuation, `/join` | 7 |
| `apps/api/prisma/schema.prisma` + tenant migration (new) | `JoinRequest` | 8 |
| `apps/api/src/services/join-request.service.ts` (new) | create / list / approve / decline / expiry | 8 |
| `apps/api/src/controllers/join-request.controller.ts` (new) | `/api/join-requests` | 8 |
| `apps/api/src/services/auth.service.ts` | `issueSetPasswordLink` | 8 |
| `apps/api/src/services/notify.service.ts` | `join.requested` category | 8 |
| `apps/api/src/services/template-store.service.ts`, `mail-templates.ts` | 3 tenant templates | 8 |
| `apps/web/src/pages/Signup.tsx`, `ResetPassword.tsx`, `services/api.ts` | new flow | 9 |
| `apps/web/src/pages/AdminPages.tsx` (+ new `JoinRequestsPanel.tsx`), `Inbox.tsx` | Requests tab | 10 |
| `apps/api/src/services/signup-digest.service.ts` (new), `workers/signup-digest.worker.ts` (new) | daily summary | 11 |
| `apps/api/src/services/signup-analytics.service.ts` (new), console controller, `pages/platform-admin/Signups.tsx` (new) | Signups page | 12 |
| console controller, `pages/platform-admin/CompanyDomains.tsx` (new) | Company domains page | 13 |
| console controller `/overview`, `Overview.tsx` | self-serve vs console split | 14 |
| docs, help article, CHANGELOG, README numbers | surfaces | 15 |

---

### Task 1: Which company an address belongs to

**Files:**
- Create: `apps/api/src/utils/company-domain.ts`
- Modify: `apps/api/package.json` (dependencies)
- Test: `apps/api/tests/unit/company-domain.test.ts`

**Interfaces:**
- Produces: `companyDomainOf(email: string): string | null`; `SHARED_EMAIL_HOSTS: ReadonlySet<string>`.

- [ ] **Step 1: Declare the dependency.** `tldts` 7.4.11 is in the lockfile only as a dev transitive
  of `tough-cookie`; a production install of `apps/api` would not have it.

```bash
npm install tldts@7.4.11 -w apps/api
```

Expected: `apps/api/package.json` lists `"tldts": "^7.4.11"`; `package-lock.json` marks it non-dev.

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/tests/unit/company-domain.test.ts
import { describe, expect, it } from "vitest";
import { companyDomainOf } from "../../src/utils/company-domain.js";

describe("companyDomainOf", () => {
  it.each([
    ["priya@acme.com", "acme.com"],
    ["priya@eng.acme.com", "acme.com"],
    ["  Priya@Mail.ACME.co.uk ", "acme.co.uk"],
    ["dev@eng.acme.co.in", "acme.co.in"],
    ["x@team.example.github.io", "example.github.io"]
  ])("rolls %s up to its registrable domain %s", (email, expected) => {
    expect(companyDomainOf(email)).toBe(expected);
  });

  it("keeps two Microsoft 365 default domains apart — onmicrosoft.com is not on the Public Suffix List", () => {
    expect(companyDomainOf("a@contoso.onmicrosoft.com")).toBe("contoso.onmicrosoft.com");
    expect(companyDomainOf("b@fabrikam.onmicrosoft.com")).toBe("fabrikam.onmicrosoft.com");
    expect(companyDomainOf("c@eng.contoso.onmicrosoft.com")).toBe("contoso.onmicrosoft.com");
  });

  it.each(["a@co.uk", "a@localhost", "a@10.0.0.1", "a@acme", "not-an-email", "a@onmicrosoft.com"])(
    "has no company domain for %s",
    (email) => {
      expect(companyDomainOf(email)).toBeNull();
    }
  );

  it("normalises an internationalised domain to ASCII so one company is one claim", () => {
    expect(companyDomainOf("a@bücher.de")).toBe("xn--bcher-kva.de");
    expect(companyDomainOf("a@xn--bcher-kva.de")).toBe("xn--bcher-kva.de");
  });
});
```

- [ ] **Step 3: Run it to watch it fail**

Run: `cd apps/api && npx vitest run tests/unit/company-domain.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/utils/company-domain.js"`.

- [ ] **Step 4: Implement**

```ts
// apps/api/src/utils/company-domain.ts
/**
 * WHAT: the company an email address belongs to — `eng.acme.com` is `acme.com` (decision 9 in
 * docs/SIGNUP_AND_DOMAINS_PLAN.md). One company domain may hold one workspace, so this function is
 * the identity of a customer for signup purposes; two answers for one company would let it open two
 * workspaces, and one answer for two companies would route a stranger into somebody else's.
 *
 * HOW: the registrable domain from the Public Suffix List (tldts, private suffixes ON, so
 * `x.github.io` stays `x.github.io`), with one deliberate exception below.
 */
import { domainToASCII } from "node:url";
import { getDomain } from "tldts";

/**
 * Hosts that hand every customer a sub-domain but are NOT on the Public Suffix List. Rolled up, two
 * unrelated companies on their default addresses would be one company. For these, the company domain
 * stops one label below. Measured 2026-10-01 against tldts 7.4.11: `getDomain("contoso.onmicrosoft.com")`
 * is "onmicrosoft.com" with private suffixes on and off.
 */
export const SHARED_EMAIL_HOSTS: ReadonlySet<string> = new Set(["onmicrosoft.com"]);

export function companyDomainOf(email: string): string | null {
  const normalised = email.trim().toLowerCase();
  const at = normalised.lastIndexOf("@");
  if (at < 1 || at === normalised.length - 1) return null;
  // IDN to ASCII first, so `bücher.de` and `xn--bcher-kva.de` are one claim, not two. An empty
  // result means the host was not a valid domain at all.
  const host = domainToASCII(normalised.slice(at + 1));
  if (!host) return null;
  const registrable = getDomain(host, { allowPrivateDomains: true });
  if (!registrable) return null;
  if (!SHARED_EMAIL_HOSTS.has(registrable)) return registrable;
  // One label below the shared host: `eng.contoso.onmicrosoft.com` → `contoso.onmicrosoft.com`.
  const labels = host.split(".");
  const sharedLabels = registrable.split(".").length;
  if (labels.length <= sharedLabels) return null; // the bare shared host is nobody's company
  return labels.slice(-(sharedLabels + 1)).join(".");
}
```

- [ ] **Step 5: Run it to watch it pass**

Run: `cd apps/api && npx vitest run tests/unit/company-domain.test.ts` — Expected: PASS.
Falsify: delete `SHARED_EMAIL_HOSTS` handling (return `registrable` unconditionally) → the
Microsoft 365 test must go red. Restore.

- [ ] **Step 6: Commit** — `feat(signup): one company, one domain — roll addresses up the Public Suffix List`

---

### Task 2: Signup settings — daily summary and join-request expiry

**Files:**
- Modify: `apps/api/prisma/control/schema.prisma` (`PlatformSignupSettings`)
- Modify: `apps/api/prisma/control/migrations/20261001120000_signup_settings_and_verification_codes/migration.sql`
- Modify: `apps/api/src/services/platform-signup.service.ts`, `apps/api/src/controllers/platform-admin-console.controller.ts` (schema of `PUT /signup/settings`)
- Modify: `apps/web/src/services/platform-admin-api.ts`, `apps/web/src/pages/platform-admin/Settings.tsx`
- Test: `apps/api/tests/unit/platform-signup.test.ts`, `apps/api/tests/unit/platform-console-permissions.test.ts`

**Interfaces:**
- Produces: `type SignupNotifyMode = "DAILY" | "EACH" | "OFF"`; `SignupSettings` gains
  `notifyMode: SignupNotifyMode` and `joinRequestTtlDays: number` (1–90) and LOSES `notifyOnSignup`.
  `notifySignupOutcome` sends only when `notifyMode === "EACH"`.

**Why amend instead of a second migration:** the Phase 0 migration is unmerged and unreleased; a
second migration that adds `notifyMode` and drops `notifyOnSignup` would ship a column that never
existed in any release. Amend it, then reset the local dev database's record of it.

- [ ] **Step 1: Amend the schema** — replace `notifyOnSignup Boolean @default(true)` with:

```prisma
  /// How operators hear about signups: "DAILY" (one summary a day, the default — decision 6),
  /// "EACH" (one email per created or failed signup), or "OFF". VARCHAR, not an enum, like every
  /// enum-shaped column in this schema.
  notifyMode String @default("DAILY") @db.VarChar(8)

  /// Days before an unanswered join request expires — a business setting (decision 7), default 14.
  joinRequestTtlDays Int @default(14)
```

and in the migration replace the `notifyOnSignup` column line with:

```sql
    `notifyMode` VARCHAR(8) NOT NULL DEFAULT 'DAILY',
    `joinRequestTtlDays` INTEGER NOT NULL DEFAULT 14,
```

Update the migration's header comment ("notify on" → "a daily summary") accordingly.

- [ ] **Step 2: Re-apply locally**

```bash
/c/xampp/mysql/bin/mysql.exe -u root timesphere_control -e "DROP TABLE IF EXISTS PlatformSignupSettings; DROP TABLE IF EXISTS EmailVerificationCode; DELETE FROM _prisma_migrations WHERE migration_name='20261001120000_signup_settings_and_verification_codes';"
cd apps/api && npx prisma migrate deploy --schema prisma/control/schema.prisma && npm run control:generate
```

Expected: the migration applies; replay it into an empty probe database as in Phase 0.

- [ ] **Step 3: Write the failing tests** (add to `platform-signup.test.ts`; adapt its `settingsRow`
  fixture to `notifyMode` / `joinRequestTtlDays`, replacing every `notifyOnSignup`):

```ts
it("sends NO per-signup email in the default DAILY mode — the summary carries it", async () => {
  openSignup({ notifyMode: "DAILY" });
  await request(buildApp()).post("/api/signup/complete").send(completeBody);
  expect(sendPlatformTemplate.mock.calls.some(([key]) => key === "platform.signup_created")).toBe(false);
});

it("sends one per signup in EACH mode", async () => {
  openSignup({ notifyMode: "EACH" });
  await request(buildApp()).post("/api/signup/complete").send(completeBody);
  expect(sendPlatformTemplate.mock.calls.filter(([key]) => key === "platform.signup_created")).toHaveLength(2);
});

it("clamps the join-request expiry to 1–90 days", async () => {
  const saved = await updateSignupSettings({ joinRequestTtlDays: 400 }, "ops@test");
  expect(saved.joinRequestTtlDays).toBe(90);
});
```

(These `completeBody` tests become continuation-based in Task 7; keep them passing at each commit by
running them against the current `/complete` contract here.)

- [ ] **Step 4: Implement** in `platform-signup.service.ts`:

```ts
export type SignupNotifyMode = "DAILY" | "EACH" | "OFF";
const NOTIFY_MODES: readonly SignupNotifyMode[] = ["DAILY", "EACH", "OFF"];
const asNotifyMode = (value: unknown): SignupNotifyMode =>
  NOTIFY_MODES.includes(value as SignupNotifyMode) ? (value as SignupNotifyMode) : "DAILY";
const clampTtl = (days: unknown): number => Math.min(90, Math.max(1, Math.round(Number(days) || 14)));
```

`DEFAULT_SIGNUP_SETTINGS` becomes `{ enabled: false, blockedDomains: [], notifyMode: "DAILY", joinRequestTtlDays: 14 }`;
`getSignupSettings` maps `notifyMode: asNotifyMode(row.notifyMode)`, `joinRequestTtlDays: clampTtl(row.joinRequestTtlDays)`;
`updateSignupSettings` accepts and clamps both; `notifySignupOutcome` returns early unless
`settings.notifyMode === "EACH"`. The console route's zod body gains
`notifyMode: z.enum(["DAILY","EACH","OFF"]).optional(), joinRequestTtlDays: z.number().int().optional()`
and drops `notifyOnSignup`.

- [ ] **Step 5: Console card** (`Settings.tsx`): replace the "Email me about every signup" switch
  with a `SegmentedControl` (from `./console-ui`) labelled "Tell me about signups" with options
  Daily summary / Every signup / Off, and add a number `Field` "Join requests expire after (days)"
  (1–90). Update `PlatformSignupSettingsView` in `platform-admin-api.ts` to match.

- [ ] **Step 6: Run** `npx vitest run tests/unit/platform-signup.test.ts tests/unit/platform-console-permissions.test.ts`
  and `npx tsc --noEmit -p apps/web` — Expected: PASS / exit 0.

- [ ] **Step 7: Commit** — `feat(signup): a daily summary by default, and a join-request expiry the business sets`

---

### Task 3: Phase 1 control-plane tables

**Files:**
- Modify: `apps/api/prisma/control/schema.prisma`
- Create: `apps/api/prisma/control/migrations/20261002090000_company_domains_and_signup_funnel/migration.sql`
- Modify: `apps/api/src/controllers/platform-admin.controller.ts:252` (console org create → `createdVia: "CONSOLE"`)

**Interfaces:**
- Produces Prisma models `OrgEmailDomain`, `SignupAttempt`, `PlatformJobClaim`, and
  `Organization.createdVia String? @db.VarChar(16)` (`"SELF_SERVE" | "CONSOLE"`).

- [ ] **Step 1: Schema** (append; add `emailDomains OrgEmailDomain[]` to `Organization`'s relations):

```prisma
/// One company's claim on its email domain (Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.4). `domain`
/// is UNIQUE: that index — not application logic — is what stops two simultaneous signups from one
/// new domain both creating a workspace. Distinct from `OrgDomain`, which is a custom HOSTNAME.
model OrgEmailDomain {
  id             String       @id @default(uuid())
  domain         String       @unique @db.VarChar(253)
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  /// "UNVERIFIED" until Phase 2's DNS check exists; then "VERIFIED".
  status         String       @default("UNVERIFIED") @db.VarChar(16)
  /// "SIGNUP" | "BACKFILL" | "ADMIN" — how the claim came to exist.
  source         String       @db.VarChar(16)
  verifiedAt     DateTime?
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@index([organizationId])
}

/// One row per stage a signup reached — the funnel the console's Signups page draws. Holds the
/// company domain and a KEYED hash of the address, never the address itself: an abandoned attempt
/// is somebody who chose not to become a customer.
model SignupAttempt {
  id             String   @id @default(uuid())
  /// CODE_SENT | REFUSED | VERIFIED | CREATED | JOIN_REQUESTED | UNAVAILABLE | FAILED
  stage          String   @db.VarChar(16)
  domain         String?  @db.VarChar(253)
  emailHash      String?  @db.Char(64)
  organizationId String?
  detail         String?  @db.VarChar(500)
  createdAt      DateTime @default(now())

  @@index([createdAt])
  @@index([stage, createdAt])
  @@index([organizationId, stage, createdAt])
}

/// "This job ran for this period." The primary key is the lock: every API replica runs the same cron,
/// and only the replica whose INSERT succeeds does the work — the others get a unique violation and
/// stand down. Used first by the daily signup summary.
model PlatformJobClaim {
  job       String   @db.VarChar(64)
  periodKey String   @db.VarChar(32)
  claimedAt DateTime @default(now())

  @@id([job, periodKey])
}
```

and on `Organization`:

```prisma
  /// "SELF_SERVE" (signup) or "CONSOLE" (a platform admin) — so the console can count customers who
  /// arrived on their own apart from ones an operator created. Backfilled by the migration.
  createdVia String? @db.VarChar(16)
```

- [ ] **Step 2: Migration** — generate the DDL with
  `npx prisma migrate diff --from-schema-datamodel <HEAD schema> --to-schema-datamodel prisma/control/schema.prisma --script`,
  then hand-write the file in canonical casing with a header in the house style. Guard every
  statement so the file can carry `-- @rerunnable`: `CREATE TABLE IF NOT EXISTS` for the three tables,
  the `information_schema` + `PREPARE` guard for the `Organization.createdVia` column and for the
  `OrgEmailDomain_organizationId_fkey` constraint, and an idempotent backfill:

```sql
UPDATE `Organization`
   SET `createdVia` = IF(`trialStartedAt` IS NOT NULL, 'SELF_SERVE', 'CONSOLE')
 WHERE `createdVia` IS NULL;
```

`apps/api/tests/unit/migration-portability.test.ts` enforces the `@rerunnable` contract — run it.

- [ ] **Step 3: Replay into an empty database, re-run the SQL a second time (proves rerunnable), apply
  to dev, regenerate** — same commands as Phase 0. Expected: 25 control migrations applied; second run
  of the file succeeds; `npx prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --exit-code`
  shows only the pre-existing `Organization_trialEndsAt_idx` drift.

- [ ] **Step 4: Console create** — in `platform-admin.controller.ts`, add `createdVia: "CONSOLE"` to the
  `organization.create` data. Run `npx vitest run tests/unit/platform-admin-rescue.test.ts tests/unit/migration-portability.test.ts`.

- [ ] **Step 5: Commit** — `feat(control): company-domain claims, a signup funnel, and a once-per-day job claim`

---

### Task 4: Company-domain claims service

**Files:**
- Create: `apps/api/src/services/company-domain-claims.service.ts`
- Modify: `apps/api/src/services/retention.service.ts` (release in the deletion transaction, ~L557)
- Modify: `apps/api/src/services/platform-backup.service.ts` (re-claim on snapshot restore, ~L240)
- Test: `apps/api/tests/unit/company-domain-claims.test.ts`

**Interfaces:**
- Consumes: `companyDomainOf` (Task 1).
- Produces:
  - `type ClaimLookup = { domain: string; organization: { id: string; name: string; slug: string; status: OrgStatus } } | null`
  - `findClaimForEmail(email: string): Promise<ClaimLookup>` — ARCHIVED orgs are treated as no claim.
  - `class DomainAlreadyClaimedError extends Error { constructor(public readonly domain: string) }`
  - `claimDomainInTransaction(tx, domain: string, organizationId: string, source: "SIGNUP"|"BACKFILL"|"ADMIN"): Promise<void>` — throws `DomainAlreadyClaimedError` on P2002.
  - `claimsForOrg(organizationId: string): Promise<Array<{ domain: string; status: string; source: string; createdAt: Date }>>`
  - `releaseClaimsForOrg(tx, organizationId: string): Promise<number>`
  - `assignClaim(domain, organizationId, actorLabel): Promise<void>` / `releaseClaim(domain, actorLabel): Promise<void>` (audited)
  - `planBackfill(): Promise<{ toClaim: Array<{domain; organizationId; orgName}>; conflicts: Array<{domain; orgs: Array<{id; name; slug}>}>; skipped: number }>`
  - `applyBackfill(actorLabel): Promise<{ claimed: number; conflicts: number }>`

- [ ] **Step 1: Failing tests** (fake `controlPrisma` like `platform-signup.test.ts` does; P2002 is an
  object with `code: "P2002"`):

```ts
it("treats an ARCHIVED workspace's leftover claim as no claim", async () => { /* findUnique returns status ARCHIVED → null */ });
it("rolls a sub-domain address up before looking — eng.acme.com finds acme.com's workspace", async () => { /* … */ });
it("turns a unique violation into DomainAlreadyClaimedError — the race loser learns it lost", async () => { /* create rejects {code:"P2002"} */ });
it("backfill: one workspace per domain is claimed; two sharing a domain are a CONFLICT and neither is claimed", async () => {
  // orgs: A ownerEmail a@acme.com, B ownerEmail b@acme.com, C ownerEmail c@globex.com, D ownerEmail d@gmail.com
  // expect toClaim = [globex.com→C]; conflicts = [acme.com: A,B]; gmail.com skipped as personal
});
it("backfill skips a domain that is already claimed, and archived workspaces", async () => { /* … */ });
```

Write each body fully against the fake before implementing.

- [ ] **Step 2: Implement.** `findClaimForEmail` → `companyDomainOf(email)` → `orgEmailDomain.findUnique({ where: { domain }, include: { organization: { select: { id, name, slug, status } } } })`.
  Personal domains (`isFreeMailAddress`/`isDisposableAddress`) never get claims (backfill skips them).
  `assignClaim`/`releaseClaim` write `platformAudit("PLATFORM_ADMIN", actor, "company_domain.assigned"|"company_domain.released", "OrgEmailDomain", domain, {...})`.

- [ ] **Step 3: Retention + restore.** Add `controlPrisma.orgEmailDomain.deleteMany({ where: { organizationId: org.id } })`
  to the deletion `$transaction` in `retention.service.ts`; in `platform-backup.service.ts` after a
  restore sets `GRACE`, re-claim `companyDomainOf(org.ownerEmail)` with source `SIGNUP` if it is free
  (best-effort, logged; a taken domain is reported in the restore result, never stolen).

- [ ] **Step 4: Run** `npx vitest run tests/unit/company-domain-claims.test.ts tests/unit/retention-plan.test.ts`. Falsify the
  conflict rule (claim the first of two) → the conflict test goes red. Restore.

- [ ] **Step 5: Commit** — `feat(signup): company-domain claims, released with the workspace and backfilled with conflicts named`

---

### Task 5: The signup funnel recorder

**Files:**
- Create: `apps/api/src/services/signup-funnel.service.ts`
- Test: `apps/api/tests/unit/signup-funnel.test.ts`

**Interfaces:**
- Produces: `type SignupStage = "CODE_SENT"|"REFUSED"|"VERIFIED"|"CREATED"|"JOIN_REQUESTED"|"UNAVAILABLE"|"FAILED"`;
  `recordSignupStage(stage: SignupStage, args: { email?: string; organizationId?: string | null; detail?: string }): Promise<void>` — never throws;
  stores `domain = companyDomainOf(email) ?? emailDomainOf(email)`, `emailHash = directoryHash(email)`, `detail` truncated to 500.

- [ ] **Step 1: Failing test** — asserts the stored row has the domain and a 64-hex `emailHash`, never
  the address (`expect(JSON.stringify(row)).not.toContain("priya@")`), and that a rejected `create`
  resolves (best-effort).
- [ ] **Step 2: Implement** (≈25 lines, `try { create } catch { console.warn }`).
- [ ] **Step 3: Run, falsify (store the email) → red, restore.**
- [ ] **Step 4: Commit** — `feat(signup): record each stage a signup reaches, without keeping the address`

---

### Task 6: Continuation tokens

**Files:**
- Modify: `apps/api/src/services/workspace-directory.service.ts`
- Test: `apps/api/tests/unit/workspace-directory.test.ts`

**Interfaces:**
- Produces:
  - `issueSignupContinuation(email: string): Promise<string>` — returns `"<token>.<secret>"`; stored as an
    `EmailVerificationCode` row with `purpose: "signup_cont"`, TTL **30 minutes** (time to fill the form).
  - `peekSignupContinuation(value: string): Promise<{ ok: true; email: string } | { ok: false }>` — does NOT consume.
  - `redeemSignupContinuation(value: string): Promise<boolean>` — single-use `deleteMany` count === 1.
  - `VerificationPurpose` gains `"signup_cont"` (fits `VARCHAR(16)`).

The secret is 32 random bytes, so guessing is not a threat and peeks do not spend attempts; what matters
is single use and expiry. Reusing the code table means no new schema and the same sweep.

- [ ] **Step 1: Failing tests** — peek twice succeeds; redeem once true, twice false; a `signup`-purpose
  code token is refused by peek; malformed values (`"abc"`, `"a.b.c"`) are `{ ok: false }`; expiry at 30 min.
- [ ] **Step 2: Implement** using the existing `codeStoreHash` and the fake-table semantics already
  in the test file (extend the fake's `findUnique` only if needed).
- [ ] **Step 3: Run; falsify single use (skip the delete) → red; restore.**
- [ ] **Step 4: Commit** — `feat(signup): a continuation token, so a verified address carries through the form`

---

### Task 7: Signup API — verify, join, and create without burning the code

**Files:**
- Modify: `apps/api/src/controllers/signup.controller.ts`
- Test: `apps/api/tests/unit/platform-signup.test.ts` (rewrite the `/complete` fixtures to the new contract)

**Interfaces:**
- Consumes: Tasks 1, 4, 5, 6; `findWorkspacesForEmail`; `createJoinRequest` (Task 8 — until Task 8
  lands, `/join` returns 501 and its tests are `it.todo`; Task 8 fills them in).
- Produces (HTTP):
  - `POST /api/signup/verify { token, code }` →
    `200 { next: "member", workspaces: DiscoveredWorkspace[] }` |
    `200 { next: "join", workspace: { name }, continuation }` |
    `200 { next: "unavailable", workspace: { name } }` |
    `200 { next: "create", continuation }`. 400 wrong/expired code, 422 refused address.
  - `POST /api/signup/complete { continuation, workspaceName, slug, adminName, adminPassword }` →
    201 as today; 409 `{ code: "SLUG_TAKEN" }` (continuation NOT consumed); 409 `{ code: "DOMAIN_CLAIMED" }` if another
    signup claimed the domain first (continuation not consumed; client re-verifies into the join path).
  - `POST /api/signup/join { continuation, name, message? }` → 201 `{ status: "requested", workspace: { name } }` |
    200 `{ status: "already_pending" }` | 409 `{ code: "WORKSPACE_UNAVAILABLE" }` | 200 `{ next: "member" }`.
  - `GET /api/signup/status` gains `rootDomain: string | null` (null on single-org), so the page can show
    the real workspace address instead of a hard-coded `.timesphere.app`.

- [ ] **Step 1: Failing tests** (fake `orgEmailDomain`, `signupAttempt` tables; mock
  `company-domain-claims.service` where simpler):

```ts
it("verify → create, with a continuation, when the domain is new", async () => { /* … expect next:"create" */ });
it("verify → join, naming only the workspace, when an ACTIVE workspace holds the domain", async () => {
  /* claim → {status:"ACTIVE", name:"Acme"}; expect body {next:"join", workspace:{name:"Acme"}, continuation: any String}; no slug/url/admin in body */
});
it.each(["GRACE", "SUSPENDED", "PROVISIONING"])("verify → unavailable for a %s workspace, and no continuation", async (status) => { /* … */ });
it("verify → member when the address already belongs to a workspace", async () => { /* findWorkspacesForEmail → [..] */ });
it("a taken address does NOT burn the verification — fix the slug and finish", async () => {
  // first /complete: organization.findUnique(slug) → {id} → 409 SLUG_TAKEN; redeem not called
  // second /complete with a new slug → 201
});
it("two simultaneous signups from one new domain: one workspace, the other told DOMAIN_CLAIMED", async () => {
  // org create + claim run in $transaction; the second transaction rejects {code:"P2002"} → 409 DOMAIN_CLAIMED; no provision call for it
});
it("records CODE_SENT, VERIFIED and CREATED in the funnel", async () => { /* recordSignupStage calls */ });
```

- [ ] **Step 2: Implement.** `/start` unchanged except `recordSignupStage("CODE_SENT"|"REFUSED", …)`.
  `/verify`: `assertSignupOpen` → `checkVerificationCode(token, code, "signup")` → refusal → members →
  `companyDomainOf` (null → 422) → `findClaimForEmail` → decision; `recordSignupStage("VERIFIED"|"UNAVAILABLE")`.
  `/complete`: `peekSignupContinuation` → refusal → slug checks (409 before any consumption) →
  `controlPrisma.$transaction(async (tx) => { org = tx.organization.create({... createdVia: "SELF_SERVE" }); await claimDomainInTransaction(tx, domain, org.id, "SIGNUP"); })`
  → on `DomainAlreadyClaimedError` 409 `DOMAIN_CLAIMED` → `redeemSignupContinuation` (false → delete org, 400)
  → provision (failure path as today, plus `recordSignupStage("FAILED", { detail })`; the org delete cascades the claim)
  → success path as today plus `recordSignupStage("CREATED", { organizationId })`.
  `/join`: Task 8 completes it.
- [ ] **Step 3: Run the file; falsify the slug-before-redeem order (redeem first) → the "does not burn"
  test goes red; restore.**
- [ ] **Step 4: Commit** — `feat(signup): verify before revealing anything, and stop a taken address from burning the code`

---

### Task 8: Join requests in the workspace

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (add `JoinRequest`, `JoinRequestStatus`; `User` back-relation `decidedJoinRequests JoinRequest[] @relation("JoinRequestDecider")`)
- Create: `apps/api/prisma/migrations/20261002100000_join_requests/migration.sql` (house guard pattern, `@rerunnable`)
- Create: `apps/api/src/services/join-request.service.ts`, `apps/api/src/controllers/join-request.controller.ts`
- Modify: `apps/api/src/app.ts` (mount `/api/join-requests` with the tenant routers), `apps/api/src/controllers/signup.controller.ts` (`/join`)
- Modify: `apps/api/src/services/auth.service.ts` (`issueSetPasswordLink`)
- Modify: `apps/api/src/services/notify.service.ts` (`"join.requested"` in `NotificationCategory`, `SETTINGS_FIELD["join.requested"] = null`)
- Modify: `apps/api/src/services/template-store.service.ts` + `mail-templates.ts` (`workspace.join_request`, `workspace.join_approved`, `workspace.join_declined`)
- Test: `apps/api/tests/unit/join-request.test.ts`, `platform-signup.test.ts` (`/join`), `email-template-registry.test.ts` (must stay green)

**Interfaces:**
- Produces:
  - `createJoinRequest({ email, name, message, ttlDays }): Promise<{ status: "requested" | "already_pending" | "member"; id?: string }>` (tenant context required)
  - `listJoinRequests(filter: "pending" | "decided"): Promise<JoinRequestRow[]>` — pending rows past `expiresAt` are returned as `EXPIRED` and written so (lazy expiry)
  - `approveJoinRequest(id, actor: { id: string; role: string }, role: RoleName = "EMPLOYEE", orgId: string): Promise<{ userId: string }>`
  - `declineJoinRequest(id, actorId, note?: string): Promise<void>`
  - `issueSetPasswordLink(userId: string, ttlMs: number): Promise<string>` → `${tenantBaseUrl()}/reset-password?token=…&welcome=1`
  - HTTP: `GET /api/join-requests?filter=pending|decided`, `POST /api/join-requests/:id/approve { role? }`, `POST /api/join-requests/:id/decline { note? }` — `requireAuth` + `requirePermission(USERS_MANAGE)`; choosing a role above EMPLOYEE requires SUPER_ADMIN (same rule as `roles` on user create).

- [ ] **Step 1: Model**

```prisma
enum JoinRequestStatus {
  PENDING
  APPROVED
  DECLINED
  EXPIRED
}

/// Somebody from this workspace's company domain asking to join (signup Phase 1). Lives in the
/// workspace's OWN database, with the people who decide it — never in a cross-tenant table.
model JoinRequest {
  id            String            @id @default(uuid())
  email         String            @db.VarChar(255)
  name          String            @db.VarChar(120)
  message       String?           @db.VarChar(1000)
  status        JoinRequestStatus @default(PENDING)
  expiresAt     DateTime
  decidedById   String?
  decidedBy     User?             @relation("JoinRequestDecider", fields: [decidedById], references: [id], onDelete: SetNull)
  decidedAt     DateTime?
  decisionNote  String?           @db.VarChar(500)
  roleGranted   RoleName?
  createdUserId String?
  createdAt     DateTime          @default(now())
  updatedAt     DateTime          @updatedAt

  @@index([status, createdAt])
  @@index([email, status])
}
```

- [ ] **Step 2: Failing tests** (`join-request.test.ts`, fake tenant prisma):

```ts
it("creates one pending request per address — a second ask returns already_pending", async () => {});
it("answers member, and creates nothing, when the address already has an account", async () => {});
it("approval refuses at the seat limit with a 402 the admin can act on", async () => {});
it("approval refuses while the workspace is not ACTIVE", async () => { /* control status GRACE → 409 */ });
it("approval of someone who became a member meanwhile links the existing account — no second user, no second seat", async () => {});
it("approval creates an EMPLOYEE by default with no usable password and mails a 72-hour set-password link", async () => {
  /* passwordResetToken.create expiresAt ≈ now + 72h; dispatchTransactional templateKey "workspace.join_approved" with setPasswordUrl containing "welcome=1" */
});
it("only a super admin may grant a role above EMPLOYEE", async () => {});
it("a pending request past expiresAt reads as EXPIRED and cannot be approved", async () => {});
it("decline records the note and mails the requester", async () => {});
```

and in `platform-signup.test.ts` replace the `/join` todos:

```ts
it("join: creates the request in the claimed workspace's database and alerts its super admins", async () => {});
it("join: refuses with WORKSPACE_UNAVAILABLE when the workspace stopped being ACTIVE since verify", async () => {});
it("join: records JOIN_REQUESTED with the organization, for the funnel and the per-day cap", async () => {});
it("join: a domain past its daily cap of requests gets 429", async () => {});
```

- [ ] **Step 3: Implement.**
  - `createJoinRequest` runs inside `withOrgTenant(slug, …)` from `/join`; on create,
    `dispatchInAppToMany({ userIds: <active SUPER_ADMIN ids>, category: "join.requested", title: "<name> asked to join", body, link: "/app/users?tab=requests" })`
    and one `dispatchTransactional({ templateKey: "workspace.join_request", … })` per super admin.
  - Per-day cap: `signupAttempt.count({ where: { stage: "JOIN_REQUESTED", organizationId, createdAt: { gte: now - 24h } } }) >= 25` → 429.
  - `approveJoinRequest`: status ACTIVE check via `controlPrisma.organization.findUnique` → 409 `WORKSPACE_UNAVAILABLE`;
    seat check `getEffectiveSeatLimit(orgId)` vs `countActiveSeats()` → 402; existing user → link, mark APPROVED;
    else `user.create({ name, email, roleId, status: "ACTIVE", passwordHash: await hashPassword(opaqueToken()), mustChangePassword: false, emailVerifiedAt: now, notificationPreference: { create: {} } })`
    + `userRole.create` + `audit(actor.id, "join_request.approved", "JoinRequest", id, { userId })`
    + `syncSubscriptionSeats(orgId)` + `rememberWorkspaceMembership(orgId, email)`
    + `issueSetPasswordLink(userId, 72h)` + `workspace.join_approved` email.
  - `issueSetPasswordLink` mirrors `requestPasswordReset` (`opaqueToken`, `hashToken`, `passwordResetToken.create`) with the given TTL.
  - Templates: register each in `TEMPLATE_VARIABLES`, `TEMPLATE_DESCRIPTIONS`, `sampleVariables`,
    `TEMPLATE_DEFAULTS` (via `shell`, >400 chars, contains `<table`); the registry test enumerates the rules.
  - Tenant migration: `CREATE TABLE IF NOT EXISTS JoinRequest` with the enum inline, FK via the guard pattern.
    Replay the TENANT chain into an empty database, then `npm run db:migrate:tenants` locally.
- [ ] **Step 4: Run** `npx vitest run tests/unit/join-request.test.ts tests/unit/platform-signup.test.ts tests/unit/email-template-registry.test.ts tests/unit/migration-portability.test.ts`.
  Falsify: the seat check, the ACTIVE check, and the existing-member link — each red, each restored.
- [ ] **Step 5: Commit** — `feat(join): a request to join the workspace your company already has, decided by its admins`

---

### Task 9: Web — the signup flow

**Files:**
- Modify: `apps/web/src/pages/Signup.tsx`, `apps/web/src/services/api.ts` (`signupVerify`, `signupComplete` new payload, `signupJoin`), `apps/web/src/pages/ResetPassword.tsx`

**Interfaces:**
- Consumes the HTTP contract of Task 7/8.

- [ ] **Step 1:** steps become `"email" | "code" | "member" | "join" | "joined" | "unavailable" | "workspace" | "done"`.
  The code form now calls `authApi.signupVerify(token, code)` and routes on `next`:
  - `member` → list `workspaces` with sign-in links (same rendering as `/find-workspace`).
  - `join` → "‹name› already uses TimeSphere" + a form (your name, optional message ≤1000) → `signupJoin` → `joined`
    ("We've asked ‹name›'s administrators. You'll get an email when they decide.") plus
    a "Need a separate workspace?" link to `/contact?reason=separate-workspace` — a person decides;
    it is never self-serve.
  - `unavailable` → "‹name›'s workspace isn't available right now. Contact its administrator." — no form.
  - `create` → the existing workspace form, posting `continuation` instead of `code`.
  - `409 SLUG_TAKEN` → field error, stay on the form (continuation intact). `409 DOMAIN_CLAIMED` →
    "Someone from your company just created a workspace" + button back to the code step.
  - Replace the hard-coded `.timesphere.app` suffix with `<slug>.<rootDomain>` from
    `GET /api/signup/status` (Task 7). Do not derive it from `window.location`: the signup page may be
    served from the apex or from any workspace's host, and stripping a label guesses wrong on both.
- [ ] **Step 2:** `ResetPassword.tsx`: when `welcome=1`, title "Set your password" and copy "Choose a
  password to finish joining your workspace."
- [ ] **Step 3:** `npx tsc --noEmit -p apps/web`; run the dev stack and walk the four branches with
  `.claude/skills/run-timesphere` (set up an ACTIVE claim on the dev control DB for one, a GRACE one for
  `unavailable`); screenshot both themes at desktop and 390px.
- [ ] **Step 4: Commit** — `feat(web): signup asks who you are before it offers anything, and offers the right door`

---

### Task 10: Web — Users → Requests

**Files:**
- Create: `apps/web/src/pages/JoinRequestsPanel.tsx`
- Modify: `apps/web/src/pages/AdminPages.tsx` (`UsersPage`: `Tabs` — "People" (existing content) | "Requests" with a pending-count badge; honour `?tab=requests`)
- Modify: `apps/web/src/services/api.ts` (`joinRequestApi.list/approve/decline`), `apps/web/src/pages/Inbox.tsx` (`CATEGORY_PREFIXES` gains `"join."`, label "Join request")

- [ ] **Step 1:** panel = table (name, email, message, requested, expires-in, actions). Approve opens a
  small dialog with a role `Select` (EMPLOYEE default; other roles only for super admins), showing the
  seat line "Uses 1 of N seats (M free)". Decline opens a dialog with an optional note. Decided tab lists
  APPROVED/DECLINED/EXPIRED with who and when. A 402 renders "Your plan is out of seats — upgrade or
  free one" with a link to Billing.
- [ ] **Step 1b: Workspace Settings → Company domains (super admin, read-only).** A tenant route
  `GET /api/settings/company-domains` (`requireSuperAdmin`) returns `claimsForOrg(requireTenantContext().orgId)`
  (Task 4); a small card lists each claimed domain with "Unverified — people from this domain can ask to
  join" and the sentence "Domain verification arrives later; ask the TimeSphere team to change a claim."
  No edit controls — reassigning is an operator action (Task 13).
- [ ] **Step 2:** typecheck; drive it live: create a request through `/join` on the dev stack, approve it,
  confirm the bell entry, the user row, and the `workspace.join_approved` email in Email templates →
  log; screenshot.
- [ ] **Step 3: Commit** — `feat(web): approve or decline people asking to join, on the Users page`

---

### Task 11: The daily signup summary

**Files:**
- Create: `apps/api/src/services/signup-digest.service.ts`, `apps/api/src/workers/signup-digest.worker.ts`
- Modify: `apps/api/src/services/platform-mail-templates.ts` (`platform.signup_digest`, group "Operator"), `apps/api/src/server.ts` (start the worker), console controller (`POST /signups/digest/run { dryRun }`, `operate`)
- Test: `apps/api/tests/unit/signup-digest.test.ts`

**Why also an immediate email:** a daily summary is right for news, wrong for an outage. If
provisioning is broken, every customer who signs up today fails, and the summary would say so tomorrow.
Fleet alerts cannot carry it (they are per workspace, and `PlatformAlertState` has a foreign key to
`Organization`; a failed signup has no workspace), so the second `FAILED` stage within 60 minutes sends
one `platform.signup_failing` email to the alert recipients — once per hour, through the same claim —
whatever the notify mode except `OFF`.

**Interfaces:**
- Produces: `claimJobPeriod(job: string, periodKey: string): Promise<boolean>`;
  `alertIfProvisioningFailing(now: Date): Promise<boolean>` (called by `recordSignupStage("FAILED")`'s caller in Task 7's failure path);
  `runSignupDigest(now: Date, opts?: { dryRun?: boolean }): Promise<{ sent: boolean; reason: string; recipients: number; counts: { created; failed; joinRequested; refused } }>`.

- [ ] **Step 1: Failing tests:**

```ts
it("sends nothing unless the mode is DAILY", async () => {});
it("sends nothing on a day with nothing created, failed or requested — refusals alone are not news", async () => {});
it("lists each created workspace with its domain and trial end, and each failure with its error", async () => {});
it("is sent ONCE per day even when two replicas run the cron at the same minute", async () => {
  // two concurrent runSignupDigest(sameDay): platformJobClaim.create resolves for the first, rejects {code:"P2002"} for the second
  // expect sendPlatformTemplate called recipients.length times total, not twice that
});
it("a dry run claims nothing and sends nothing", async () => {});
it("the SECOND failure within an hour sends one 'provisioning is failing' email, even in DAILY mode", async () => {});
it("a third failure in the same hour sends nothing more — one email per hour", async () => {});
it("OFF silences the failing alert too", async () => {});
```

- [ ] **Step 2: Implement.** Window `[now − 24h, now)`; created = `organization.findMany({ where: { createdVia: "SELF_SERVE", createdAt: window } })`;
  failed/join/refused from `signupAttempt` by stage; claim `("signup-digest", now.toISOString().slice(0,10))`
  only when there is something to send and not a dry run; recipients `resolveAlertRecipients(await getAlertSettings())`;
  one `sendPlatformTemplate("platform.signup_digest", { to, vars, metadata: { counts } })` each;
  `platformAudit("SYSTEM", "scheduler", "signup.digest_sent", "PlatformSignupSettings", "global", counts)`.
  Template modelled on `platform.alert_digest` (sections in `alertBlock`, `"None."` when empty).
  Worker: `cron.schedule("15 8 * * *", …)` with the house `running` guard and logging.
- [ ] **Step 3: Run; falsify the claim (skip it) → the two-replica test goes red; restore.**
- [ ] **Step 4: Commit** — `feat(console): a daily signup summary, sent once however many replicas run`

---

### Task 12: Console — Signups page

**Files:**
- Create: `apps/api/src/services/signup-analytics.service.ts`, `apps/web/src/pages/platform-admin/Signups.tsx`
- Modify: console controller (`GET /signups?days=7|30|90`), `apps/web/src/services/platform-admin-api.ts`, `apps/web/src/layouts/PlatformAdminLayout.tsx` (Growth: "Signups", icon `UserPlus`), `apps/web/src/App.tsx`, `apps/api/tests/unit/platform-console-permissions.test.ts`, `tests/e2e/responsive.spec.ts` (`PLATFORM_ADMIN_PAGES`)
- Test: `apps/api/tests/unit/signup-analytics.test.ts`

**Interfaces:**
- Produces `getSignupAnalytics(days: number, now: Date): Promise<SignupAnalytics>` where

```ts
interface SignupAnalytics {
  funnel: { codeSent: number; verified: number; created: number; joinRequested: number; unavailable: number; refused: number; failed: number };
  byDay: Array<{ day: string; selfServe: number; console: number }>;
  recent: Array<{ orgId: string; name: string; slug: string; domain: string | null; ownerEmail: string | null; createdAt: string;
                  status: OrgStatus; trialEndsAt: string | null; trialDaysLeft: number | null; converted: boolean; activeSeats: number | null }>;
  failures: Array<{ at: string; domain: string | null; detail: string | null }>;
  topDomains: Array<{ domain: string; attempts: number; created: number; joinRequested: number }>;
}
```

- [ ] **Step 1: Failing tests** — funnel counts from seeded `signupAttempt` rows; `converted` = ACTIVE,
  no running trial, `planTier !== "STARTER"` or a Stripe subscription; `activeSeats` from the latest
  reachable `OrgUsageSnapshot` (null when none yet); `days` clamped to 7/30/90.
- [ ] **Step 2: Implement service + route (READ) + permissions entry (`{ method: "get", path: "/signups", cap: READ }`) + console page**
  modelled on `Feedback.tsx`: `KpiGrid` of the funnel, an area chart self-serve vs console by day,
  `ConsoleTable` of recent workspaces with `OrgStatusPill`/`TierPill` and trial days left, a failures
  table, top domains. Period via `SegmentedControl` (7/30/90).
- [ ] **Step 3:** run tests; `console-shots.mjs` (add the page to its list) both themes; `overflow-probe.mjs /platform-admin/signups 390`.
- [ ] **Step 4: Commit** — `feat(console): a Signups page — the funnel, who signed up, and how each one is doing`

---

### Task 13: Console — Company domains page

**Files:**
- Create: `apps/web/src/pages/platform-admin/CompanyDomains.tsx`
- Modify: console controller (`GET /company-domains`, `POST /company-domains { domain, organizationId }`, `DELETE /company-domains/:domain`, `POST /company-domains/backfill { dryRun }`), permissions test (GET READ; the three writes OPERATE), nav (Tenants: "Company domains", icon `AtSign`), `App.tsx`, `Overview.tsx` `ACTION_LABEL` (`company_domain.assigned`, `company_domain.released`, `company_domain.backfilled`), responsive list

- [ ] **Step 1:** route tests in `platform-console-permissions.test.ts` (fake `orgEmailDomain`) plus a
  service test that `POST` refuses a personal domain (`gmail.com`) and an ARCHIVED target.
- [ ] **Step 2:** page: claims table (domain, workspace, status, source, since) with Reassign / Release
  (reason prompt, as other sensitive console actions); "Backfill from signup emails" → dry-run preview
  listing what would be claimed and the CONFLICTS, then Apply. Copy states that a conflict needs an
  operator to choose — nothing picks one automatically.
- [ ] **Step 3:** tests; shots both themes; overflow probe at 390.
- [ ] **Step 4: Commit** — `feat(console): Company domains — see, reassign and backfill who owns which domain`

---

### Task 14: Overview — self-serve apart from console

**Files:** console controller `/overview`; `apps/web/src/pages/platform-admin/Overview.tsx`; `apps/web/src/services/platform-admin-api.ts` (`PlatformOverview`)

- [ ] **Step 1:** `signups30` becomes `{ selfServe, console }` (orgs with `createdVia` null count as console);
  `signupsByWeek` rows become `{ week, selfServe, console }`. Update the permissions-test fake if it reads the shape.
- [ ] **Step 2:** tile "Signups, 30 days" shows self-serve with console in the hint; the chart stacks two
  areas (self-serve in accent, console muted) and its description loses "together".
- [ ] **Step 3:** typecheck, shots, commit — `feat(console): count customers who signed up apart from ones you created`

---

### Task 15: Surfaces, gates and the record

- [ ] Help article (`packages/shared/src/help-articles.ts`, category "People & roles", `roles: ADMIN`):
  "Approving people who ask to join" — where "User management → Requests", steps, keywords
  `["join","request","approve","domain","access"]` (avoid terms that outrank the pinned searches).
  Fix the stale "39 editable templates" in `email-setup` from the real count.
- [ ] CHANGELOG `## Unreleased`: one `🔐`/`✨` section for Phase 1 (decision table in prose; upgrade
  action: run the Company domains backfill once, read its conflicts).
- [ ] docs: API.md (verify/join/complete contract, join-request routes, console routes), DATABASE.md
  (three control tables, `createdVia`, `JoinRequest`), ARCHITECTURE.md module rows, DEPLOYMENT.md
  version note (backfill), NEW_ORGANIZATION_SETUP.md (reviewing claims and conflicts), spec status →
  "Phase 1 built", docs hub row.
- [ ] README "By the numbers" recounted with CONTRIBUTING's one-liners (models, migrations, services,
  workers, pages, routes, email templates, tests).
- [ ] Gates: `npm run lint` (ratchet holds), `npm test`, `npm run test:integration -w apps/api`,
  `npm run build`, and `npm run test:e2e:quick` with the dev stack up (record pass/fail honestly).
- [ ] Session Log entry in `docs/V12_UiUx_ClickUp_PLAN.md`; commit — `docs(signup): Phase 1 everywhere it is described`.
- [ ] **Stop. Report to the user. Do not merge.**
