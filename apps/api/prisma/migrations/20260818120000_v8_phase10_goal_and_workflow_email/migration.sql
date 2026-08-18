-- V8 phase 10: the two email legs V8 shipped without.
--
-- Two nullable-by-default booleans, no DML, nothing existing rewritten. Pure ASCII by design, for the
-- reason the previous phases give.
--
-- The diff emitted `globalnotificationsettings` in lower case (introspection off a case-insensitive
-- Windows MariaDB); corrected to `GlobalNotificationSettings` below. On a case-sensitive Linux MySQL
-- the lower-case form does not exist and the ALTER dies mid-deploy -- the 2.4.0 lesson.
--
-- WHY THE DEFAULTS DIFFER: `emailGoalDigest` is OFF like every other digest in this table, because a
-- weekly send every workspace inherits is a send people filter. `emailWorkflowApproval` is ON for the
-- same reason `emailAiAutonomyApplied` is: a gate blocks everything after it, and an approval request
-- nobody sees is a workflow that looks broken rather than blocked.

-- AlterTable
ALTER TABLE `GlobalNotificationSettings`
  ADD COLUMN `emailGoalDigest` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `emailWorkflowApproval` BOOLEAN NOT NULL DEFAULT true;
