# Database Design

The Prisma schema in `apps/api/prisma/schema.prisma` defines the MySQL model.

## Before committing a migration: replay it into an EMPTY database

```bash
mysql -u root -e "DROP DATABASE IF EXISTS ts_migration_probe; CREATE DATABASE ts_migration_probe;"
cd apps/api
DATABASE_URL="mysql://root@127.0.0.1:3306/ts_migration_probe" npx prisma migrate deploy
```

**This is what tenant provisioning actually does** — a new organization gets an empty database and
the entire migration history replayed into it. `prisma migrate dev` against your own database only
proves the migration applies to *your* current state, which is a different and much weaker claim.

The two diverge in ways that are easy to miss. A real example from this repo: adding
`@@index([timesheetId])` to `Attachment` — a column MySQL already indexes to back its foreign key —
made Prisma emit a `RedefineIndex` that dropped `Attachment_timesheetId_fkey`. That index exists on
a database which already ran the original `CreateTable`, so the migration applied cleanly in
development. It does **not** exist on a fresh one, where the drop fails with
`Can't DROP INDEX ... (errno 1091)` and **every new organization fails to provision**.

Rules that follow from it:

- **Don't declare `@@index` on a foreign-key column.** MySQL creates one automatically; declaring
  it produces an index redefinition that isn't replayable from scratch.
- **Check the generated SQL for `DROP`,** and if there is one, understand exactly what it removes
  and whether the target is guaranteed to exist on a fresh database.
- **Never answer Prisma's "we need to reset the database" prompt on anything with real data.** If a
  committed migration has to be corrected, fix the file, reconcile the applied databases by hand
  (create replacements *before* dropping, so a foreign key is never without a backing index), and
  update the recorded `checksum` in `_prisma_migrations`. Verify constraint counts and row counts
  before and after.

## After merging a migration: fan it out to every tenant

Reaching `DATABASE_URL` is not the same as reaching the workspace — every organization has its own
database. After merging a migration:

```bash
npm run migrate:tenants -w apps/api
```

Fans it out across every `ACTIVE`/`SUSPENDED` org's own database, skipping any already on the
latest version and isolating one org's failure from the rest — see
[DEPLOYMENT.md](DEPLOYMENT.md#keeping-every-tenants-schema-current) and
`scripts/migrate-all-tenants.ts`. `docker-compose.yml`'s `prisma migrate deploy` only ever migrates
one database.

Both migrations in the 2026-08-07 batch need this step: `20260807090000_email_role_mutes` adds a
column read on every outbound-email path, and `20260807140000_api_request_telemetry` creates the
table the request-telemetry middleware writes into. A tenant left behind has neither.

## Backfills

A migration that adds a column the application will *gate* on must backfill existing rows in the
same migration. `20260802171943_user_onboarding_completed_at` is the worked example: without its
`UPDATE user SET onboardingCompletedAt = createdAt`, switching on the first-run gate would have
locked out every existing user whose profile happened to be missing a field — punishing people for
a configuration change they had no part in. See
[ONBOARDING_AND_TOUR.md](ONBOARDING_AND_TOUR.md).

### Backfilling a new PERMISSION is a special case (read before adding one)

`prisma/seed.ts` is a **one-time bootstrap**. `docker-compose.yml` runs `prisma migrate deploy`
on every API boot and `update.sh`/`update.ps1` then run `npm run migrate:tenants`, but **nothing
re-runs the seed on upgrade** — and it must not, because it does
`rolePermission.deleteMany` + `createMany` and would wipe any hand-customised grants.

So a permission key added to `@timesheet/shared` reaches a *fresh* install through `seed.ts` and
reaches an *existing* one **only** through SQL in the migration. Add both, in the same commit, or
the feature silently 403s for every customer who upgrades. `20260803064315_v6_phase1_planning_foundation`
is the worked example: it inserts the five planning permission keys and their role grants with
`INSERT … SELECT … WHERE NOT EXISTS` guards, mirroring the `grants` map in `seed.ts`.

The same applies to any row the application will *read and expect to exist*: the system Default
workflow and the `GlobalPlanningSettings` singleton are both created by that migration **and** by
`seed.ts`, using identical deterministic ids (`wf-default`, `wfs-open`, …) so the two paths
converge on byte-identical rows. Verified by seeding a freshly-replayed database and confirming
the grants match what the migration produces on an existing one.

Every such statement must be **guarded so re-running is a no-op** — `migrate deploy` runs a
migration once, but an interrupted deploy gets retried, and a tenant provisioned mid-upgrade
replays the whole history.

Core tables:

- `users`, `roles`, `permissions`, `role_permissions`
- `sessions`, `password_reset_tokens`, `email_verification_tokens`
- `projects`, `modules`, `submodules`, `user_project_assignments`
- `activity_types`, `timesheets`, `attachments`
- `notifications`, `audit_logs`, `form_configurations`
- `GlobalFaceVerificationSettings`, `FaceEnrollment`, `FaceVerificationAttempt` (optional
  face/identity verification — see below and [FACE_VERIFICATION.md](FACE_VERIFICATION.md))
- `ApiRequestSample` (optional per-request telemetry, off by default — see below)

## Planning layer tables (V6)

See [ARCHITECTURE.md §3.9](ARCHITECTURE.md#39-the-planning-layer-v6--additive-by-construction)
for why this layer is shaped the way it is. All of it is inert until an admin turns a toggle on.

| Group | Tables | Note |
|---|---|---|
| Hierarchy & schedule | *(columns on `Ticket`)* | `parentId`, `startDate`/`endDate`, `isMilestone`, `progressPct`, `sortOrder`, `baseline*`, `workflowStatusId` — all nullable/defaulted. `estimatedHours` already existed and **is** effort; don't add a second field. |
| Dependencies | *(columns on `TicketLink`)* | `TicketLinkType` gains the four `*_TO_*` scheduling kinds plus `lagDays`. `BLOCKS` is treated by the solver as finish-to-start, so dependencies recorded before V6 keep meaning what they meant. |
| Portfolio | `Portfolio` | One level above `Project` (`Project.portfolioId`). Deliberately thin — budget/risk/schedule are *derived* from its projects, never entered twice. |
| Workflows | `Workflow`, `WorkflowStatus`, `WorkflowTransition` | `WorkflowStatus.legacyStatus` is the compatibility hinge. The system row (`wf-default`) is seeded from `ticketStatusTransitions` and is not editable. |
| Custom fields | `CustomField`, `CustomFieldValue` | Rows, not a JSON blob on `Ticket`, because values must be filterable and reportable. Exactly one of `ticketId`/`projectId` is set — enforced in `custom-field.service.ts`, since Prisma on MySQL has no CHECK support. |
| Views | `SavedView` | Persisted filter/column/sort per view type. |
| Resourcing | `ResourceBooking` + `User.weeklyCapacityHours`/`plannedUtilizationPct` | Bookings are the *plan*; approved `Timesheet` rows are the *actual*. `hoursPerDay` is per **working** day, not per calendar day. |
| Budget | *(columns on `Project`)* | `budgetAmount`/`budgetCurrency`/`budgetAlertPct`. Burn is **not stored** — it is summed live from the `Timesheet.billedAmount` rate snapshots, so the budget card and a Verified Work Attestation can never disagree. |
| Intake | `RequestForm`, `RequestFormSubmission`, `Blueprint` | Form schemas and blueprint payloads are JSON (authored and rendered whole). Blueprint dates are **relative day offsets**, which is what makes a blueprint reusable. The public link follows `AttestationShareLink`'s capability model right down to storing only `publicTokenHash` — so the URL is shown once, at publish, and is not recoverable afterwards. |
| Approvals & proofing | `ApprovalRequest`, `ApprovalStep`, `ProofAnnotation` | Approves **deliverables**; the timesheet approval flow (`Timesheet.status` + `Escalation`) approves **hours** and is untouched. Guest approvers use a single-use token rather than a half-real `User` row, stored as `guestTokenHash` with a `guestTokenExpiresAt` (NULL on pre-hashing rows, which stay open-ended). |
| Service health | `ServiceHealthSample`, `ServiceIncident` | Samples are the raw probe stream, pruned at 45 days. Incidents are recorded separately **because they must outlive the samples that produced them** — deriving them on read would let a pruning job silently rewrite history. |
| Dashboards & reports | `Dashboard`, `ReportSubscription` | Widgets are JSON; recipients are email strings, not necessarily `User`s. |
| AI, human-in-the-loop | `AiProposal`, `AiProposalChange`, `ProjectRiskSnapshot` | No AI planning feature writes directly — it emits a proposal whose changes are individually accept/rejectable. `riskScore` is computed arithmetically; the LLM only writes `aiNarrative`. |
| Settings | `GlobalPlanningSettings` | Singleton (`id = "global"`), every toggle default false. |

Control plane: `PlanTierLimit` gains six boolean capabilities and five numeric quotas, all
defaulting to the **restrictive** value so a tier row that missed initialisation
under-entitles rather than over-entitles. The values come from `PLAN_TIER_LIMITS` in
`@timesheet/shared` — the same constant the pricing table renders from — and are pinned by
`apps/api/tests/unit/plan-tier-claims.test.ts`.

## Face (identity) verification tables

Only populated when the feature is switched on (it is off by default). These hold **biometric
data**, which is why their design differs from every other table here.

| Model | Purpose | Notes |
|---|---|---|
| `GlobalFaceVerificationSettings` | Singleton (`id = "global"`), same shape as the other settings singletons. | Master switch, scope (`ALL` vs `SELECTED`), per-action requirements (`requireForTimesheet`/`requireForTicket`/`requireForApproval`), the `challengeEnabled` anti-replay toggle, calibrated thresholds, retention window, consent wording, and `entitlementLostAt` (the downgrade grace-window clock). |
| `FaceEnrollment` | One per user — the reference face they're matched against. | `encryptedEmbedding` is **AES-256-GCM ciphertext**, never a raw vector. `modelVersion` is recorded because embeddings are *not* comparable across model versions — a model upgrade must force re-enrollment rather than silently rejecting everyone. `consentAt`/`consentText`/`consentIp` are the durable consent record. |
| `FaceVerificationAttempt` | One row per attempt, pass **or** fail. | Failures are deliberately kept: "this account failed identity check four times at 2am" is the signal the feature exists to surface. `consumedAt` + `timesheetId`/`ticketId` make a passed check single-use. `imagePath` is nulled and `purgedAt` set by the retention worker. Also carries the anti-injection evidence: `deviceLabel`/`virtualCameraSuspected`/`unfamiliarNetwork` (review *signals*, never verdicts — both are client-influenced) and the challenge measurements (`challengeInstruction`, `challengeYawDelta`/`challengePitchDelta`, `frameSimilarity` — recorded but not yet enforced, so direction/consistency floors can later be set from real data instead of guesses). |
| `FaceChallenge` | Single-use liveness challenge (random head movement, 90s expiry). | Holds **no biometric data** — just which movement was demanded and when. Redeemed via conditional `updateMany` (the race guard); rows are deleted a day after expiry by the retention worker. |

`User.faceVerificationRequired` is the per-user opt-in, in the same "global switch + per-user
field" shape as `User.hourlyRate` + `GlobalTicketSettings.enableCostAnalytics`. On the
**control plane**, `PlanTierLimit.faceVerificationEnabled` (seeded `true` only for ENTERPRISE)
is the per-tier entitlement the whole feature hangs off.

Two deliberate choices worth knowing before changing anything here:

- **Embeddings are encrypted, which rules out SQL-side vector search.** Accepted knowingly: a
  verification compares against exactly one row (that user's own enrollment), never a
  whole-table nearest-neighbour scan, so the comparison happens in Node after decryption.
- **Image *paths* are stored, but the files live outside the public `/uploads` mount.** That
  mount is served with no authentication at all, so anything under it is readable by anyone who
  guesses a filename. Face imagery is served only via an authenticated API route.

## Per-role email mutes (`GlobalNotificationSettings.emailRoleMutes`)

Added by `20260807090000_email_role_mutes` as one nullable `JSON` column, no default and **no
backfill** — which is the design, not an omission:

```sql
ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `emailRoleMutes` JSON NULL;
```

- **NULL / absent means "no role is muted anywhere — everyone receives."** An existing row reads
  back NULL and delivery is byte-for-byte what it was before the migration, so rolling this out
  changes nothing until a super admin actually unticks a cell. This is the case the
  [Backfills](#backfills) rule explicitly does *not* cover: nothing gates on the column, so there
  is no existing row that a missing value would lock out.
- **It stores the MUTES, not the ticks.** The shape is category → the roles that must *not* get
  that email (`{"emailDailyReminder":["MANAGER","SUPER_ADMIN"]}`), and the API drops any category
  whose list is empty. Storing the ticked cells instead would make the default state 135 explicit
  `true`s that have to exist before anything works, and every new notification category would then
  need a migration to add its cells to every workspace's grid. Storing the exceptions is what
  keeps "nothing recorded" the correct default forever.
- **One JSON column rather than category × role boolean columns.** The matrix is 27 categories × 5
  roles = 135 cells. A new notification category should keep costing one enum member and one
  boolean column (see `notify.service.ts`'s header), not five more.
- **It gates the EMAIL leg only.** The in-app `Notification` row is written regardless, so muting a
  role never hides an escalation — it only keeps it out of an inbox. Enforced in
  `notify.service.ts`, and in `mail.service.ts` for the super-admin audit BCC, through the single
  `isEmailRoleMuted` predicate in `@timesheet/shared` that the settings UI also reads, so the
  ticked box and the delivered mail cannot disagree.

MySQL JSON is free-form, so the Zod schema on `PATCH /api/settings/notifications` is this column's
**only** integrity check — unknown keys and roles are rejected there. See
[API.md](API.md#the-emailrolemutes-map).

## API request telemetry (`ApiRequestSample`)

One row per completed HTTP request, as measured by the instance that served it. Created by
`20260807140000_api_request_telemetry`; written by `middleware/request-telemetry.ts` (buffered and
batched, never inline in the request), read by `services/api-performance.service.ts`, pruned by
`workers/api-telemetry-retention.worker.ts`. Collection is **off by default**
(`API_TELEMETRY_ENABLED`), so on an untouched deployment the table stays empty. Endpoints:
[API.md](API.md#api-performance-telemetry).

It deliberately does not replace the access log: no bodies, no query strings, no headers, no IPs.

| Column | Type | Notes |
|---|---|---|
| `id` | `VARCHAR(191)` PK | UUID, like every other table here. |
| `apiName` | `VARCHAR(220)` | Human-readable endpoint identity, e.g. `GET /api/tickets/:id`. Method and pattern together, so a GET and a DELETE on one path never average into each other. |
| `method` | `VARCHAR(10)` | |
| `apiPath` | `VARCHAR(200)` | The **route pattern**, never the raw URL — see below. |
| `statusCode` | `INT` | |
| `userId` | `VARCHAR(191)` NULL | Id only, and **no foreign key** — see below. NULL for an unauthenticated request, which is a real answer rather than missing data. |
| `apiRequestAt`, `apiResponseAt` | `DATETIME(3)` | |
| `apiResponseTime` | `INT` | Milliseconds, wall clock. |
| `dbResponseTime` | `INT` NULL | Real Prisma time inside the request, accumulated by the client extension in `config/prisma.ts`. NULL means **not measured** (telemetry enabled mid-request, or the request touched no database) — never zero. |
| `dbQueryCount` | `INT` NULL | Same null semantics. |
| `hostname` | `VARCHAR(120)` | From `os.hostname()`. |
| `podName`, `podNamespace`, `cluster` | `VARCHAR(120)` NULL | Kubernetes downward-API identity (`POD_NAME`/`POD_NAMESPACE`/`CLUSTER_NAME`). NULL off-cluster rather than faked. |
| `osType` | `VARCHAR(80)` | |
| `cpuPercent`, `memUsedPercent`, `diskUsedPercent` | `DOUBLE` NULL | From one cached host snapshot refreshed on an interval, **not** measured per request. |
| `eventLoopLagMs` | `DOUBLE` NULL | "Network" as this app can honestly measure it — the latency that actually degrades responses. NIC byte counters are not portably readable from Node; same reasoning as `system-health.service.ts`. |
| `createdAt` | `DATETIME(3)` default now | What every index and the prune are anchored on. |

Five indexes. Every query this table serves is "some slice of the last N hours", so four of them
are `(<filter>, createdAt)` composites:

| Index | Serves |
|---|---|
| `(createdAt)` | The window itself — the totals, the time series, and the retention sweep. |
| `(apiPath, createdAt)` | The per-endpoint breakdown and the drill-down's `path` filter. |
| `(statusCode, createdAt)` | The status-class mix and the `statusClass` filter. |
| `(hostname, createdAt)` | The per-host/pod split. |
| `(apiResponseTime, createdAt)` | The `minMs` filter and the slowest-first drill-down. |

**No foreign key to `User`, on purpose.** `userId` is a bare column; names and emails are joined in
at read time by the drill-down only. Two things follow, and both are the reason:

- **No PII lives in the table.** The only identity it carries is an opaque id, so a fortnight of
  telemetry is not a fortnight of who-did-what, and a user erased from `User` disappears from this
  view instead of living on in it.
- **A deleted user cannot cascade.** With a foreign key, removing one person would either take
  their samples with them — silently rewriting the latency history of every endpoint they touched
  — or block the delete outright. Neither is acceptable for a table whose only job is to describe
  the past accurately.

**`apiPath` is a route pattern, never the raw URL.** `/api/tickets/:id` is one row's worth of
cardinality; `/api/tickets/<uuid>` is one group per ticket ever viewed, which makes every `GROUP
BY` return thousands of one-hit groups and the indexes above useless.

**The host columns are denormalised deliberately.** They repeat on every row rather than pointing
at a host table because the whole point is comparing hosts *within* a time window ("pod-7 is the
slow one"), and a join per aggregate to save a few bytes per row on a table pruned every fortnight
is the wrong trade.

**Retention: 14 days by default** (`API_TELEMETRY_RETENTION_DAYS`), pruned nightly at **04:10**
across every tenant by `workers/api-telemetry-retention.worker.ts`. It gets its own worker rather
than a sweep inside the writer because this table grows with **traffic** — a moderately busy
workspace produces more rows in an hour than the `ServiceHealthSample` probe stream does in a year
— and a delete on that scale must never run on the path that is also trying to flush new telemetry.
It deletes in bounded batches (ids selected first, 10,000 per statement, at most 20 rounds per
tenant per tick) so no single statement locks and replicates a fortnight of rows, and so one
tenant's backlog cannot hold the org loop open and starve the tenants after it; the next night's
tick continues where it stopped. 04:10 sits after the AI sweep at 03:40 so the two never contend
for the same tenant connections, and the schedule runs even when collection is switched off —
turning recording off must not strand the rows it already wrote.

Design notes:

- UUID primary keys for distributed safety.
- Soft delete fields via `deletedAt`.
- Audit fields via `createdAt` and `updatedAt`.
- Indexed foreign keys and common report filters.
- Role and permission mapping supports dynamic RBAC.
- Biometric columns (`FaceEnrollment.encryptedEmbedding`) are encrypted at rest with the same
  AES-256-GCM helper used for API keys and DSNs, never stored as plaintext vectors.
