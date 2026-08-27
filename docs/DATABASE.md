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

### Three traps when a migration has to READ the table it writes

All three were hit writing `20260817100000_session_device_identity`, whose cleanup revokes each
user's oldest sessions — inherently "rank rows in a table, then update that same table". They are
worth reading in order, because each one was the *fix* for the previous one.

`apps/api/tests/unit/migration-portability.test.ts` enforces all three statically, so the next
occurrence is caught in review rather than on an operator's machine.

**1. A derived table is not a portable escape from error 1093.** MySQL refuses `UPDATE t … WHERE
… (SELECT … FROM t)` with *"You can't specify target table for update in FROM clause"*. Wrapping
the read in a derived table (`UPDATE t JOIN (SELECT … FROM t) d`) is the classic workaround
because it forces materialisation — and it works on MariaDB. **MySQL 8.0.14+ can MERGE that
derived table back into the outer query**, which puts 1093 straight back. If your dev machine runs
one engine and production the other, this passes every local test and breaks provisioning for
every new organization. This one shipped.

**2. A scratch table with a DECLARED collation will not join.** The fix for (1) is a scratch table
holding the ids to update. Writing it the obvious way —

```sql
CREATE TABLE `_scratch` (`id` VARCHAR(191) NOT NULL, PRIMARY KEY (`id`))
  ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;   -- WRONG
```

— fails with **error 1267, *"Illegal mix of collations"***, on any database whose real table
carries a different one. And the default is exactly what differs between engines: **MySQL 8.0 ships
`utf8mb4_0900_ai_ci`; MySQL 5.7 and MariaDB ship `utf8mb4_general_ci`**; an operator who created
the database with an explicit `COLLATE` has a third answer. The failure is *late* — the `CREATE`
succeeds, the `INSERT` succeeds, and the `JOIN` two statements later dies with
*"Please check the query number 5 from the migration file"*, which names nothing.

Use `CREATE TABLE … AS SELECT` instead. It **inherits** the source column's character set and
collation, so the join cannot mismatch:

```sql
DROP TABLE IF EXISTS `_scratch`;
CREATE TABLE `_scratch` AS SELECT `t`.`id` AS `id` FROM `t` WHERE …;
CREATE INDEX `_scratch_id_idx` ON `_scratch` (`id`);   -- CTAS has no keys; the join needs one
UPDATE `t` JOIN `_scratch` `s` ON `s`.`id` = `t`.`id` SET …;
DROP TABLE `_scratch`;
```

`CREATE TEMPORARY TABLE` is fine here and was wrongly blamed for this failure at the time —
`20260804013530_service_incident_single_open` uses two of them across five statements and is
applied on production MySQL 8.0.46. The migration engine does hold one connection. An ordinary
table is used above only because it is the weaker assumption.

**3. A migration that mixes DDL with data changes must survive re-running itself.** MySQL DDL is
**not transactional** and Prisma does not roll a migration back. So when trap (1) killed the
cleanup, the `ALTER TABLE … ADD COLUMN` and `CREATE INDEX` before it had already landed — and
`_prisma_migrations` recorded the migration as **failed**, which blocks every later migration with
**P3009**. Recovery re-runs the file, so a bare `ADD COLUMN` then dies as a duplicate and the
database is stuck for a second reason.

MySQL has no `ADD COLUMN IF NOT EXISTS` (MariaDB does — relying on it reintroduces the engine split
that caused all of this). The portable guard is `information_schema` plus a prepared statement,
with `DO 0` as the no-op branch:

```sql
SET @stmt := (
  SELECT IF(COUNT(*) = 0, 'ALTER TABLE `Session` ADD COLUMN `deviceId` VARCHAR(64) NULL', 'DO 0')
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'Session' AND `COLUMN_NAME` = 'deviceId'
);
PREPARE `guarded_stmt` FROM @stmt; EXECUTE `guarded_stmt`; DEALLOCATE PREPARE `guarded_stmt`;
```

The same shape against `information_schema.STATISTICS` (`INDEX_NAME = …`) guards a `CREATE INDEX`.

> The "replay into an EMPTY database" rule above is necessary and **not sufficient**. A replay
> proves the schema applies; it does **not** exercise a data migration, because every table is
> empty — and it runs on *your* engine, which is how traps (1) and (2) both survived local
> testing. Seed representative rows into the probe, and when the migration touches data, also
> replay it against a database created with a different default collation.

### Recovering from P3009 — "failed migrations in the target database"

This is what an operator sees after a migration dies part-way.

**`npm run setup` recovers from this on its own when the migration allows it.** The doctor detects
P3009, reads the named migration, and if it carries a **`@rerunnable`** marker in its SQL comments
it clears the failed record and re-applies the file unattended. No row data is deleted or
rewritten by either step.

Marking a migration `@rerunnable` is a promise about two things, and it is the author's to make:

1. **Re-running the file over its own partial effects completes** — its DDL is guarded per trap (3)
   above, so `ADD COLUMN` on a column that already exists is a no-op rather than a duplicate error.
2. **Its data changes are idempotent** — running twice equals running once. The session cleanup
   qualifies because it writes `revokedAt` behind `WHERE revokedAt IS NULL`; a second pass finds
   nothing left to do.

Nothing can infer property (2) from the SQL. `UPDATE Ledger SET total = total + 1` is
indistinguishable from an idempotent backfill to any static check, and re-running it silently
doubles every row — so **an unmarked migration is never auto-recovered**, and the doctor prints the
manual steps instead. `apps/api/tests/unit/migration-portability.test.ts` fails the build if a
migration carries the marker without guarded DDL or with an unconditional write.

To do it by hand — and this is what the doctor prints for an unmarked migration:

```bash
cd apps/api
npx prisma migrate resolve --rolled-back <migration_name> --schema=prisma/schema.prisma
npx prisma migrate deploy --schema=prisma/schema.prisma
```

The first command clears the failed record so the migration is retried; the second re-runs it.
**No data is dropped by either.**

- `--rolled-back` means *"re-run it"*, and is correct when the migration is guarded per trap (3).
- `--applied` means *"treat it as done"*, and is correct only when you have verified by hand that
  every statement's effect is already present.
- **Never `prisma migrate reset`.** It DROPS the database. Prisma's own error links to a page that
  mentions it; that page is not written for a workspace holding real data.

If `deploy` then fails on a duplicate column or index, the migration is not re-runnable over its
own partial effects. Guard its DDL as in trap (3) and try again — reconciling the `checksum` in
`_prisma_migrations` for any database that already applied the old version.

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

All three migrations in the 2026-08-07 batch need this step: `20260807090000_email_role_mutes`
adds a column read on every outbound-email path, `20260807140000_api_request_telemetry` creates the
table the request-telemetry middleware writes into, and `20260807170000_hash_guest_and_public_tokens`
adds the columns every guest-approval and public-form lookup now resolves through. A tenant left
behind has none of them.

2.3.0 adds one more: **`20260808120000_mcp_server`**, which creates `GlobalMcpSettings` and
`McpCredential` (see [below](#mcp-server-tables-globalmcpsettings-mcpcredential)). A tenant that
misses it does not merely lack the feature — `getGlobalMcpSettings` upserts the settings singleton
on first read, so the *settings page* itself fails against a database where the table does not
exist. Nothing else in 2.3.0 touches the schema.

**The server now tells you at boot when a tenant is behind**, because until it did, a missed fan-out
looked exactly like healthy code. `services/tenant-schema-check.service.ts` compares every
`ACTIVE`/`SUSPENDED` org's recorded `schemaVersion` against `getLatestMigrationName()` and, if any is
behind, prints which orgs, what they are on, what this build expects, and the command that fixes it.
It **warns rather than refusing to start**: one org being behind must not take down the ones that are
fine, the same isolation `migrate-all-tenants.ts` already applies. It is silent when everything is
current, so it stays worth reading.

This was added after the V8 batch was applied to one developer's `DATABASE_URL` and never fanned out.
The second organization threw `The table 'automationflow' does not exist` once a minute from the
schedule sweep, and nothing at boot said so — the error named a missing table rather than the missed
step, which is a long way to travel to reach `npm run migrate:tenants`.

`update.sh`/`update.ps1` already run this fan-out for you on the Compose shape (unconditionally,
before verification — it is a fast no-op when the default org is the only one), and `npm run setup`
runs it as its last step on a local checkout. Neither needs a per-release edit: the target is
whatever `getLatestMigrationName()` reads off the checked-out `prisma/migrations` directory, so each
release's newest migration is picked up by name. Manual and Kubernetes deployments run it
themselves; nothing else will.

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

## Goals / OKRs tables (V8 phase 1)

Plan and rationale: [AGENTIC_WORK_MANAGEMENT.md](AGENTIC_WORK_MANAGEMENT.md). Additive in the same
way the V6 layer is: three new tables, one defaulted column, and nothing that reads or rewrites an
existing row.

| Table | Note |
|---|---|
| `Goal` | Objective → key result via `parentId` (the `Ticket.parentId` shape). Two levels is enforced in the service, not the schema — a database cannot express "no grandchildren" without a maintained depth column. Soft-deleted like `Portfolio`, because a goal that shaped a quarter's decisions is audit trail. |
| `GoalLink` | What the goal is measured OVER: `PROJECT`, `PORTFOLIO` or `TICKET`. Deliberately **not** a foreign key — three target tables, one column — so a dangling id (a soft-deleted project) is skipped at read time rather than erroring. A `PORTFOLIO` link is expanded to its projects **on read**, never stored expanded, so a portfolio that gains a project widens every goal linked to it. |
| `GoalProgressOverride` | Append-only. Records the stated percentage, the note (required), and **`measuredValue`/`measuredPct` as they stood at that moment** — the receipt. There is no update or delete path: a correction is another row. |
| *(column on `GlobalPlanningSettings`)* | `enableGoals`, default false. Guarded with the `information_schema` + `PREPARE` pattern because the same migration ends in DML and so can die half-applied. |

**Progress is not a column anywhere**, by design. `goal-progress.service.ts` derives every number on
read from `Timesheet`, `Ticket`, `TicketEscalation` and `ProjectRiskSnapshot` — the same tables the
portfolio roll-up and the attestation read. A stored progress figure would need a recompute worker,
and a stale one on a goals page is the "talked up in a status meeting" failure the whole design
exists to prevent.

Control plane: `PlanTierLimit` gains `goalsEnabled` and `maxGoals`, restrictive-defaulted and
initialised by a guarded one-time `UPDATE` in
`prisma/control/migrations/20260817150100_v8_goals_entitlements`, exactly as the V6 block was.

The permission `goals:manage` is backfilled by idempotent SQL inside
`20260817150000_v8_phase1_goals` **and** granted in `prisma/seed.ts` — both are needed, and the
replay check proved why: on a fresh database the migration's `RolePermission` insert matches nothing
because roles do not exist yet, so a migration-only change would have shipped the permission with no
grants to any role on every new install.

## Agent and automation tables (V8 phases 3–7)

Plan and rationale: [AGENTIC_WORK_MANAGEMENT.md](AGENTIC_WORK_MANAGEMENT.md) and
[AGENTIC_UX_PLAN.md](AGENTIC_UX_PLAN.md). Additive throughout: eight new tables and two nullable
columns, nothing that rewrites an existing row.

| Table | Note |
|---|---|
| `AgentProfile` | A named teammate: an emoji, a description, an owned set of capability ids, and a daily spend ceiling. `identityUserId` points at a **non-login `User` with `isAgent = true`** — the decision that lets assignment, workload, comments, audit and attestation all work unchanged. One capability has one owner, enforced at enable time with a 409 rather than in the schema, because ownership is a claim over a JSON array. |
| `AgentRun` | THE QUEUE ENTRY — there is no separate queue table. `triggerKey` is unique, which is what makes a doubled tick, a retried webhook and a restart mid-tick collapse to one row, and unlike an in-memory guard it survives the restart. `level` is COPIED at queue time so a policy edit cannot escalate a run already in flight. `taintedAt` clamps authority to SUGGEST from the moment externally-authored text enters. `flowId` (nullable, `SET NULL`) is the join behind per-workflow spend — retiring a flow must not erase the record of what it spent. |
| `AgentRunStep` | What it thought, called and got back. `resultText`/`argsJson` are governed by `aiCaptureContentEnabled` exactly like `AIInteraction.promptText`: an agent trace is prompt content by another name, and a second content store outside the retention sweep would be a compliance regression. |
| `AgentWorkEntry` | The ledger, shaped like `Timesheet` rather than a parallel reporting path. Idempotent on `agentRunId`. `displacedMinutes` is a **median** over this workspace's own approved hours and is `NULL` — never 0 — where fewer than five comparable entries exist. `billable` is false and there is deliberately no route that flips it: the commercial decision comes before the switch for it. |
| `AutomationFlow` | A trigger plus ordered steps, off until somebody activates it. `triggerConfig` is JSON because the four trigger kinds share no columns and four nullable columns would be three-quarters empty. |
| `AutomationStep` | Explicit `order` rather than a linked list — the builder renders a list and reorders by rewriting these, and a broken `nextStepId` chain is unreadable in a database row. `config` carries what the step DOES *and* its canvas position as `{x, y}`, which is why the canvas needed no migration. |
| `AutomationFlowRun` | One execution against one subject. A row rather than a log line because a gate can wait days, so the run's position has to survive a restart. `triggerKey` is unique and **carries the subject id** — without that, the first ticket through a flow would be the only one it ever touched. |
| `AutomationFlowRunStep` | Every step's outcome, including the ones where nothing happened: a step absent from a report reads as "there was nothing there", which is a different claim from "it was not reached". `agentRunId` and `proposalId` are plain columns, not relations, for the reason `AgentRun.proposalId` is not one — the record of what produced something should outlive the thing. |
| *(columns on `GlobalNotificationSettings`)* | `emailWorkflowApproval` (default **true** — a gate blocks everything after it) and `emailGoalDigest` (default **false**, like every other digest). |

**`AiProposalChange.targetType` is a `VarChar`, not an enum**, which is why adding the `TICKET_LABEL`
target needed no migration at all. That target exists because a proposal-only flow — which a triage
flow is *by construction*, since the taint clamp guarantees it — previously could not even propose a
label, only report that it had been held back.

Every one of these migrations was replayed into an empty database before commit, per the rule at the
top of this file. Two of them needed the lower-case table name the diff emitted (`agentrun`,
`automationflowrunstep`) corrected to canonical casing first — the 2.4.0 lesson, checked every time.

## Change management tables (V8)

`ChangeRequest` is an **extension row on a ticket**, not a parallel entity: it holds a required
`ticketId` and the governance columns a ticket cannot express. Comments, attachments, watchers,
links, the audit trail and project-scoped visibility all come from the ticket half for free, which is
why this module added no second visibility rule to keep in step.

| Table | What it holds |
|---|---|
| `ChangeRequest` | The governance record — kind, category, environment, the business case, the impact and risk assessment, the schedule, the plans (implementation, backout, test, communication), and the outcome. `changeKey` is uniquely indexed; `state` is the lifecycle. |
| `ChangeImplementationStep` | The runbook, numbered. `stepNumber` is issued from the current maximum, not the row count, so deleting step 2 of 3 does not make the next new step a second step 3. |
| `ChangeTestCase` | How anyone will know it worked. `reference` defaults to `TC-01`, `TC-02`… when not supplied — requiring somebody to invent an identifier first is how test sections end up empty. |
| `ChangeDependency` | What has to be true first. `PREDECESSOR`/`BLOCKS` left `OPEN` refuse the move to `IMPLEMENTING`; `SUCCESSOR`/`RELATED` never block. |
| `ChangeApproval` | One row per approver per **round**. A rejection opens a new round rather than overwriting the first, so the original objection survives the rework. `dueAt` is the approval SLA clock. |
| `ChangeCollaborator`, `ChangeTicketLink` | Who else is working on it, and which closed tickets it delivers. |
| `ChangeCategory`, `ChangeSource`, `ChangeApplication` | Admin-editable master data. `requiresSecurityReview` on a category forces the review gate. |
| `MaintenanceWindow`, `BlackoutPeriod` | When change is welcome, and when it is refused. Both feed the calendar and the conflict check. |
| `ChangeRiskParameter` | The weighted questions behind the risk score. Deactivating one removes it from the required set as well as the maths — the two must not drift. |
| `ChangeSlaConfig` | One budget + warning fraction per stage. An **inactive** row means the stage has no clock, not a zero-hour one. |
| `GlobalChangeSettings` | Workspace toggles, the approval SLA, and the freeze policy. |

Also added: `TicketCollaborator` (multiple people on one ticket, distinct from the single `assignee`),
`ApprovalRequest.quorum`, and thirteen `emailChange*` columns on `GlobalNotificationSettings` so the
new mail obeys the same category × role grid as everything else.

### Why the risk score is stored, not derived at read time

`riskScore` and `riskLevel` are columns. The score normalises across whichever parameters were
**active when the assessment was made**, and recomputing it later against a changed parameter set
would silently re-band historical changes — including ones whose backout plan was waived because they
banded LOW at the time. The stored pair is the record of what was decided; `ChangeRiskParameter` is
only the input to the next one.

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

## Guest and public link tokens are stored hashed

`20260807170000_hash_guest_and_public_tokens` moves guest approval links and public request-form
links onto SHA-256 lookups, the way `AttestationShareLink.tokenHash` already worked. They were
stored in the clear, so any read of the database — a backup, a dump, one injected `SELECT` —
handed over live, usable capabilities.

```sql
ALTER TABLE `ApprovalStep` ADD COLUMN `guestTokenHash` VARCHAR(64) NULL,
                           ADD COLUMN `guestTokenExpiresAt` DATETIME(3) NULL;
ALTER TABLE `RequestForm`  ADD COLUMN `publicTokenHash` VARCHAR(64) NULL;
UPDATE `ApprovalStep` SET `guestTokenHash` = SHA2(`guestToken`, 256) WHERE `guestToken` IS NOT NULL;
UPDATE `RequestForm`  SET `publicTokenHash` = SHA2(`publicToken`, 256) WHERE `publicToken` IS NOT NULL;
CREATE UNIQUE INDEX `ApprovalStep_guestTokenHash_key` ON `ApprovalStep`(`guestTokenHash`);
CREATE UNIQUE INDEX `RequestForm_publicTokenHash_key` ON `RequestForm`(`publicTokenHash`);
```

- **This is phase 1 of two, and it deliberately does not drop or blank the plaintext columns.**
  Keeping `ApprovalStep.guestToken` and `RequestForm.publicToken` for one release is what makes
  `update.sh`'s code-only rollback honest: roll back and the older code still finds the column it
  reads, instead of stranding every outstanding guest approval and every printed form URL. Phase 2
  drops them in a separate migration, once no row still needs the fallback.
- **The backfill is the exception the [Backfills](#backfills) rule exists for**, and it is done in
  SQL rather than application code so it cannot be half-applied. `SHA2(x, 256)` returns the
  lowercase hex digest, byte-for-byte what `node:crypto`'s `createHash("sha256").digest("hex")`
  produces for the same input — which is why an existing link keeps working without anyone
  re-issuing it.
- **Unique, not merely indexed.** The hash is now the identity the public routes look a row up by,
  and a duplicate would make that lookup ambiguous. The index is added *after* the backfill so the
  constraint is validated against the final data in one pass.
- **No expiry is backfilled.** `guestTokenExpiresAt` stays NULL on pre-existing rows, which the
  application reads as "open-ended, as it always was". Stamping a date onto links already sitting
  in people's inboxes would have invalidated them retroactively — a silent breakage disguised as a
  security improvement.

## Columns added since the last DATABASE.md pass

Small additions that need no section of their own, recorded so the file stays a complete account:

| Column | Migration | Notes |
|---|---|---|
| `Timesheet.submittedAt` `DATETIME(3)` NULL, plus index `Timesheet_submittedAt_reviewedAt_idx` | `20260804123000_timesheet_submitted_at` | When a timesheet entered the approval queue, so approval **latency** is measurable rather than inferred from `createdAt`. Not backfilled: NULL means "submitted before this column existed", and consumers report those rows as `unmeasurable` rather than dropping them, so a median over a handful is never mistaken for one over everything. Reconstructing it from `approvalDeadline - project.slaApprovalHours` is correct only while that project's SLA setting has never changed. The composite index serves the latency query directly. |
| `User.mustChangePassword` `BOOLEAN NOT NULL DEFAULT false` | `20260805071631_reset_hardening_and_insecure_bypass` | Set by admin account creation and by every admin-driven reset; cleared when the user picks their own password. **Drives a prompt, never a lockout** — the default of `false` is what keeps every existing account unaffected. |
| `GlobalFaceVerificationSettings.insecureContextBypass` `BOOLEAN NOT NULL DEFAULT false` | `20260805071631_reset_hardening_and_insecure_bypass` | Lets a workspace proceed without a face check when the browser origin is not a secure context (no camera is available there at all). Off by default, and an attempt taken under it is recorded as a `SKIPPED_INSECURE` row rather than as a pass — the audit trail must not claim a check that never happened. |
| `Session.deviceId` `VARCHAR(64)` NULL, plus index `Session_userId_deviceId_revokedAt_idx` | `20260817100000_session_device_identity` | Which BROWSER a session belongs to, so a repeat sign-in replaces its own row instead of adding one. Before it, `establishSession` INSERTed on every login and nothing reaped the result — **7,486 live sessions measured for a single user**, 6,952 with the identical user-agent string. NOT an authenticator: the lookup pairs it with `userAgent` and only runs after credentials are verified, so a forged or stale value merely fails to match and falls back to a new row. NULL on rows predating the column and on cookie-less clients; both are bounded by `MAX_ACTIVE_SESSIONS_PER_USER` instead. **The migration also revokes every live session beyond each user's 10 most recently active** — without that the fix only stops the bleeding, since nothing else ever clears the existing rows. Ordered by `lastSeenAt` (falling back to `createdAt`) so the session someone is signed in on right now is the one kept, and an upgrade does not sign the workspace out mid-shift. |
| `EmailLog.attempts` `INT NOT NULL DEFAULT 0`, `.nextAttemptAt` / `.lastAttemptAt` `DATETIME(3)` NULL, `.payload` `JSON` NULL, plus index `EmailLog_status_nextAttemptAt_idx` | `20260814100000_email_send_queue` | Turns this table from an audit trail into the outbound **queue**. It always had a `QUEUED` status and nothing ever re-drove a row out of it, so a provider's `451 too many messages` lost that email permanently. `FAILED` now means *given up on*; `QUEUED` means *due at `nextAttemptAt`*. **`payload` holds the rendered body only while the row is still deliverable** and is cleared on SENT or on giving up — keeping it forever would turn an audit log into a copy of every email the workspace ever sent. The index serves the drain query (`status = QUEUED AND nextAttemptAt <= now()`) directly. Nothing is backfilled: existing rows have `attempts = 0` and a NULL `nextAttemptAt`, and the worker only treats such a row as an orphan if it is also older than five minutes — so historical SENT/FAILED rows are never re-sent. |
| `GlobalMailSettings.maxConnections` `INT NOT NULL DEFAULT 3`, `.maxMessagesPerWindow` `INT NOT NULL DEFAULT 25`, `.rateWindowMs` `INT NOT NULL DEFAULT 60000` | `20260814100000_email_send_queue` | The per-workspace SMTP throttle, mapped onto nodemailer's `maxConnections` / `rateLimit` / `rateDelta`. Defaults are the conservative intersection of the common providers (Office 365: 30 messages/minute, 3 concurrent connections; Gmail SMTP ~20 concurrent; SES a per-account rate), leaving headroom for the audit BCC. Clamped again in `mail.service.ts` regardless of what is stored — a `maxConnections` of 0 would wedge the pool and one of 500 would earn the rejection the setting exists to prevent. |
| `Timesheet.lastEditedById` `VARCHAR(191)` NULL, `.lastEditedAt` `DATETIME(3)` NULL | `20260814140000_timesheet_last_edited_by` | WHO last corrected an entry, and when. `PATCH /timesheets/:id` records a field-by-field diff in `AuditLog`, but nothing on the READ path surfaced it — an edited row looked identical to an untouched one, and the person whose entry it was had no way to notice. Answering it from `AuditLog` means a scan per row for a whole page of history, so it is a column. **Bare scalars with no foreign key**, matching `reviewedById` in the same table: `Timesheet` already relates to `User` via `userId`, and a second Prisma relation would force both to be named — the display names are resolved for a whole page in one batched lookup at the read boundary instead. Not backfilled: NULL means "never edited since this column existed", which is what the UI should say; inventing an editor from the audit log would attribute edits made before anyone was told they were being recorded. |
| `GlobalNotificationSettings.emailPracticeUpdate` `BOOLEAN NOT NULL DEFAULT false`, `.practiceUpdateRecipients` `JSON` NULL, `.practiceUpdateWeekly` `BOOLEAN NOT NULL DEFAULT false`; `GlobalAISettings.practiceUpdateEnabled` `BOOLEAN NOT NULL DEFAULT false` | `20260827130000_practice_update` | The Weekly AI/ML Practice Update. Four columns across two singletons, and the split between them is this app's standard **two-layer digest gate**: the AI toggle decides whether the NARRATIVE is drafted, the notification toggle decides whether EMAIL leaves. Both default off, which is the house rule for digests — a new install must not start mailing anyone. `practiceUpdateRecipients` holds **plain email addresses, not user ids**: the audience is leadership, and a CEO or practice head often has no account in the workspace the update is about (`ReportSubscription.recipients` made the same call for the same reason). NULL means "nobody has been chosen yet", which is a different state from an empty array saved deliberately — the send path refuses on both, only the UI distinguishes them. `practiceUpdateWeekly` arms the Monday 07:30 cron; off by default because the button is the primary path and an unreviewed digest reaching a CEO every week is not something to switch on for somebody. All four are guarded by `information_schema` existence checks, so the migration is safe to replay against a tenant a prior partial run already touched. |
| `ActivityType` (existing table, first reader) | — | Seeded since the first migration and **never read** until 2026-08: both apps imported a frozen twelve-item array from `@timesheet/shared`. No schema change was needed — see [API.md § Activity types](API.md#activity-types) for why `Timesheet.activityType` stays a string rather than becoming a foreign key. |

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

## MCP server tables (`GlobalMcpSettings`, `McpCredential`)

The two tables behind TimeSphere's own MCP server — the second authenticated inbound surface, after
the public REST API. Created by `20260808120000_mcp_server` (2.3.0); written and read by
`services/mcp.service.ts` and `controllers/settings.controller.ts`, consumed per request by
`controllers/mcp.controller.ts` and `middleware/mcp-auth.ts`. Concept and threat model:
[ARCHITECTURE.md §3.11](ARCHITECTURE.md#311-mcp-server--a-second-inbound-surface-that-acts-as-a-person).
Endpoints: [API.md](API.md#mcp-server).

**The migration inserts no rows at all**, on purpose. The settings singleton is upserted on first
read (the same convention every other `Global*` settings table uses), and every column defaults to
the closed position — so an upgraded workspace has no live MCP endpoint until a super admin turns
one on, and nothing needs backfilling.

### `GlobalMcpSettings`

One row, `id = "global"`, matching `GlobalAISettings`/`GlobalTicketSettings`.

| Column | Type | Notes |
|---|---|---|
| `id` | `VARCHAR(191)` PK | Always the literal `global` — a singleton, not a UUID. |
| `enabled` | `BOOLEAN NOT NULL DEFAULT false` | The master switch. While false `/api/mcp` refuses every caller, valid credential included — with a **404**, so a workspace that has not switched this on does not confirm the endpoint exists. |
| `allowWrites` | `BOOLEAN NOT NULL DEFAULT false` | The read-only latch. While false, no mutating tool is listed *or* callable whatever `toolOverrides` says, so "stop the agent writing, now" is one boolean rather than an audit of individual tools. |
| `toolOverrides` | `JSON NOT NULL` (Prisma default `{}`) | Per-tool opt-in/opt-out, `{ "<tool name>": true \| false }`. A tool **absent** from the map falls back to its own default in `services/mcp-tools.ts` — reads on, writes off — which is what makes a write tool added by a future release arrive disabled in every existing workspace instead of switching itself on during an upgrade. |
| `updatedAt` | `DATETIME(3)` | `@updatedAt`. |
| `updatedById` | `VARCHAR(191)` NULL | The super admin who last changed it. A bare column, no foreign key — the same choice `ApiRequestSample.userId` makes, so deleting an account cannot rewrite or block a settings row. |

MySQL JSON is free-form, so the Zod schema on `PATCH /api/settings/mcp` is this column's **only**
integrity check: it rejects any key that is not a tool the server actually publishes, because a
typo persisting as a key nobody reads looks exactly like a tool that refuses to turn on.

### `McpCredential`

A bearer credential for `/api/mcp`, **bound to one user**. There is no such thing as an
unattributed MCP credential here: every authorization helper in this codebase decides from
`req.user`, so the credential *is* a user, and a tool call sees exactly what that person sees.

| Column | Type | Notes |
|---|---|---|
| `id` | `VARCHAR(191)` PK | UUID. |
| `name` | `VARCHAR(120)` | Operator-chosen label, e.g. "Priya's Claude Desktop". |
| `tokenHash` | `VARCHAR(64)` **UNIQUE** | SHA-256 hex of the plaintext token, never the token — the same one-time-reveal convention as `ApiKey.keyHash`, `AttestationShareLink.tokenHash` and the security-ingestion token. The plaintext (`tsm_` + 32 random bytes, hex) is returned exactly once, by `POST /api/settings/mcp/credentials`. |
| `tokenPrefix` | `VARCHAR(16)` | The leading 12 characters only, so two credentials can be told apart in the settings list without the full token ever being readable again. |
| `userId` | `VARCHAR(191)` NOT NULL | The acting user. **Required**, unlike `ApiKey.createdById` — see the cascade below. |
| `createdById` | `VARCHAR(191)` NULL | The super admin who issued it. Separate from `userId` because "who granted this" and "who does it act as" are different questions and an audit trail needs both. |
| `lastUsedAt` | `DATETIME(3)` NULL | Stamped fire-and-forget on every successful resolve; bookkeeping must never fail a call. NULL means never used. |
| `createdAt` | `DATETIME(3)` default now | |
| `revokedAt` | `DATETIME(3)` NULL | Revocation is a soft stamp, not a delete, so the audit rows that reference this credential id still resolve. A revoked row is refused by `resolveMcpPrincipal` and hidden from the settings list. |

Two indexes beyond the unique constraint:

| Index | Serves |
|---|---|
| `McpCredential_tokenHash_idx` | Every authenticated request — the token→principal lookup, which is the one query on the hot path. |
| `McpCredential_userId_idx` | The per-user view, and the cascade below. |

**`userId` cascades on delete; `createdById` sets null.** The asymmetry is the point:

- **A credential must die with the account it acts as.** An offboarded person's credential is that
  person's permissions in a form nobody is watching — surviving as an orphan is the one outcome
  that turns account deletion into a silent no-op for the integration surface. `ON DELETE CASCADE`.
- **An issuer leaving must not delete other people's credentials.** `createdById` is provenance,
  so it degrades to NULL (`ON DELETE SET NULL`) exactly like every other "who did this" column
  here, rather than taking live credentials with it.

Deactivation is covered separately and does not rely on the cascade: `resolveMcpPrincipal` re-reads
the bound user on every request and returns null for a deleted, soft-deleted or non-`ACTIVE`
account — so suspending someone stops their credential immediately, without a row changing.

Design notes:

- UUID primary keys for distributed safety.
- Soft delete fields via `deletedAt`.
- Audit fields via `createdAt` and `updatedAt`.
- Indexed foreign keys and common report filters.
- Role and permission mapping supports dynamic RBAC.
- Biometric columns (`FaceEnrollment.encryptedEmbedding`) are encrypted at rest with the same
  AES-256-GCM helper used for API keys and DSNs, never stored as plaintext vectors.
