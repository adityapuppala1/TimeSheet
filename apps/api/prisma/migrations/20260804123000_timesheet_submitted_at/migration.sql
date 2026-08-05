-- Persist when a timesheet was submitted for approval.
--
-- The submit path already computed this and threw it away, keeping only the derived
-- `approvalDeadline`. That made approval latency (submit -> decision) unmeasurable: the only way
-- to reconstruct it was `approvalDeadline - project.slaApprovalHours`, which is right only while
-- that project's SLA setting has never changed, and silently wrong the moment it has.
--
-- Additive and nullable. Existing rows stay NULL and are NOT backfilled: inventing a submit time
-- from today's SLA setting would make every latency figure assert something untrue. The analytics
-- endpoint reports those rows as `unmeasurable` alongside the median, so a median computed over
-- three of two hundred entries cannot be read as covering all two hundred.
ALTER TABLE `Timesheet` ADD COLUMN `submittedAt` DATETIME(3) NULL;

-- Latency queries filter on "reviewed, and we know when it was submitted".
CREATE INDEX `Timesheet_submittedAt_reviewedAt_idx` ON `Timesheet`(`submittedAt`, `reviewedAt`);
