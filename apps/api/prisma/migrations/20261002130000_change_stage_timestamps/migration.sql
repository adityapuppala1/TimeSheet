-- Change stage timestamps belong to the CURRENT pass through each stage.
--
-- WHY: a change's stage clocks run between `submittedAt`, `approvedAt`, `actualStart` and
-- `actualEnd`. Until this release every one of them was written `existing ?? now` and never
-- cleared, so the first pass through a stage was the only one that counted:
--   * a change reworked (VALIDATION → IMPLEMENTING) kept its first hand-over time, so implementation
--     read MET while the rework ran;
--   * a change rejected, reworked and resubmitted kept round 1's `submittedAt`, so round 2's
--     approval clock started days before round 2 existed;
--   * a change reopened as a draft kept every stamp from its earlier pass, so a draft showed a
--     running approval clock.
-- The code now resets them on every move (`stageStampsOnEnter` in change.service.ts). This brings
-- the rows already in that state into line, so in-flight changes read correctly from deploy.
--
-- WHAT IT CHANGES — only stamps that are later than the stage the change is in now, which can only
-- be left over from an earlier pass:
--   1. DRAFT: all four stage stamps.
--   2. AWAITING_APPROVAL: approval, implementation start and hand-over.
--   3. APPROVED / SCHEDULED: implementation start and hand-over (nothing leads back into these from
--      IMPLEMENTING, so a stamp here is from a pass that was cancelled).
--   4. IMPLEMENTING: the hand-over (a rework in progress).
--   5. Any change past DRAFT whose `submittedAt` is earlier than its latest approval round opened:
--      moved to that round's opening, which is the moment it was last submitted.
-- The audit trail still holds every earlier transition. Data only — no table, column or index
-- changes.
--
-- Step 5 is a correlated subquery over `ChangeApproval` while writing `ChangeRequest` — two
-- different tables, and no derived table, so MySQL's error 1093 does not arise on either engine. A
-- change with no approval rows gets NULL from the subquery, which compares as unknown and is left
-- alone.
--
-- IDEMPOTENT: every statement is guarded by the condition it corrects, so a second run finds nothing
-- to do.

UPDATE `ChangeRequest`
SET `submittedAt` = NULL, `approvedAt` = NULL, `actualStart` = NULL, `actualEnd` = NULL
WHERE `state` = 'DRAFT'
  AND (`submittedAt` IS NOT NULL OR `approvedAt` IS NOT NULL OR `actualStart` IS NOT NULL OR `actualEnd` IS NOT NULL);

UPDATE `ChangeRequest`
SET `approvedAt` = NULL, `actualStart` = NULL, `actualEnd` = NULL
WHERE `state` = 'AWAITING_APPROVAL'
  AND (`approvedAt` IS NOT NULL OR `actualStart` IS NOT NULL OR `actualEnd` IS NOT NULL);

UPDATE `ChangeRequest`
SET `actualStart` = NULL, `actualEnd` = NULL
WHERE `state` IN ('APPROVED', 'SCHEDULED')
  AND (`actualStart` IS NOT NULL OR `actualEnd` IS NOT NULL);

UPDATE `ChangeRequest`
SET `actualEnd` = NULL
WHERE `state` = 'IMPLEMENTING' AND `actualEnd` IS NOT NULL;

UPDATE `ChangeRequest` AS `cr`
SET `cr`.`submittedAt` = (
  SELECT MIN(`ca`.`createdAt`)
  FROM `ChangeApproval` AS `ca`
  WHERE `ca`.`changeId` = `cr`.`id`
    AND `ca`.`round` = (SELECT MAX(`latest`.`round`) FROM `ChangeApproval` AS `latest` WHERE `latest`.`changeId` = `cr`.`id`)
)
WHERE `cr`.`state` <> 'DRAFT'
  AND `cr`.`submittedAt` IS NOT NULL
  AND `cr`.`submittedAt` < (
    SELECT MIN(`ca`.`createdAt`)
    FROM `ChangeApproval` AS `ca`
    WHERE `ca`.`changeId` = `cr`.`id`
      AND `ca`.`round` = (SELECT MAX(`latest`.`round`) FROM `ChangeApproval` AS `latest` WHERE `latest`.`changeId` = `cr`.`id`)
  );
