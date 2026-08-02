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

## Backfills

A migration that adds a column the application will *gate* on must backfill existing rows in the
same migration. `20260802171943_user_onboarding_completed_at` is the worked example: without its
`UPDATE user SET onboardingCompletedAt = createdAt`, switching on the first-run gate would have
locked out every existing user whose profile happened to be missing a field — punishing people for
a configuration change they had no part in. See
[ONBOARDING_AND_TOUR.md](ONBOARDING_AND_TOUR.md).

Core tables:

- `users`, `roles`, `permissions`, `role_permissions`
- `sessions`, `password_reset_tokens`, `email_verification_tokens`
- `projects`, `modules`, `submodules`, `user_project_assignments`
- `activity_types`, `timesheets`, `attachments`
- `notifications`, `audit_logs`, `form_configurations`
- `GlobalFaceVerificationSettings`, `FaceEnrollment`, `FaceVerificationAttempt` (optional
  face/identity verification — see below and [FACE_VERIFICATION.md](FACE_VERIFICATION.md))

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

Design notes:

- UUID primary keys for distributed safety.
- Soft delete fields via `deletedAt`.
- Audit fields via `createdAt` and `updatedAt`.
- Indexed foreign keys and common report filters.
- Role and permission mapping supports dynamic RBAC.
- Biometric columns (`FaceEnrollment.encryptedEmbedding`) are encrypted at rest with the same
  AES-256-GCM helper used for API keys and DSNs, never stored as plaintext vectors.
