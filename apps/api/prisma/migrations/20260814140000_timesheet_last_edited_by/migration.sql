-- WHO last corrected a timesheet entry, and when.
--
-- `PATCH /timesheets/:id` (2026-08-14) let managers and super admins correct somebody else's
-- entry, and the audit log records that change field-by-field. But nothing on the READ path
-- surfaced it, so the History table and the entry dialog both showed a row that had been edited
-- exactly like one that had not — and the person whose entry it was had no way to notice.
--
-- Answering it from `AuditLog` would mean a scan per row for a whole page of history. This is the
-- one fact a reader needs at a glance, so it is a column.
--
-- Bare scalars with no foreign key, matching `reviewedById` in the same table: Timesheet already
-- relates to User via `userId`, and a second Prisma relation would force both to be named. The
-- display name is resolved with one batched lookup at the read boundary instead.
--
-- Not backfilled, and that is correct: NULL means "never edited since this column existed", which
-- is exactly what the UI should say about an entry nobody has touched. Inventing an editor from
-- the audit log would attribute edits made before anyone was told they were being recorded.
--
-- Canonical casing, per the CHANGELOG's Linux-MySQL upgrade note.
ALTER TABLE `Timesheet`
  ADD COLUMN `lastEditedById` VARCHAR(191) NULL,
  ADD COLUMN `lastEditedAt`   DATETIME(3)  NULL;
