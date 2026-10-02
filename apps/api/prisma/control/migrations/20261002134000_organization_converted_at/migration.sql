-- When a workspace FIRST became a paying customer (analytics audit M15/M16).
--
-- WHY. The console's "median days to convert" read four audit actions nothing in the codebase writes,
-- so it could never show a value, and "converted" had three definitions across Revenue, Signups and
-- retention. `Organization.convertedAt` records the moment at conversion, written by the two routes
-- that convert: a completed Stripe checkout (billing.controller.ts, only while it is NULL) and a
-- platform admin setting a paid plan on a trialling workspace (platform-admin.controller.ts).
--
-- THE BACKFILL TAKES ONLY WHAT THE CONTROL PLANE ACTUALLY RECORDED, and leaves the rest NULL:
--   (1) `organization.trial_converted` — the console's own conversion row, exact.
--   (2) the first `organization.updated` whose `before.planTier` was STARTER and whose `after.planTier`
--       is a paid tier, on a workspace that had a trial and is still converted today (no trial tier
--       left, a subscription, or a paid tier) — an operator moving a trial onto a paid plan before
--       the console wrote a conversion row of its own. A trial starts when its workspace is created,
--       so every such edit comes after the trial began.
-- A Stripe checkout before this migration left no control-plane trace, so those workspaces stay NULL:
-- they count as converted, and are left out of the median rather than given a guessed date.
--
-- WHAT EXISTING ROWS DO: nothing else changes. The column is nullable and nothing reads it as a gate.
--
-- Every statement is guarded, so a run interrupted anywhere replays safely: the ALTER through
-- information_schema + PREPARE, the backfills behind `convertedAt IS NULL`. Neither backfill reads
-- `Organization` in its derived table (MySQL error 1093). CANONICAL CASING, written by hand
-- (docs/DATABASE.md).
-- @rerunnable

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Organization' AND COLUMN_NAME = 'convertedAt');
SET @ddl := IF(@c = 0, 'ALTER TABLE `Organization` ADD COLUMN `convertedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `Organization` o
  JOIN (
    SELECT `entityId`, MIN(`createdAt`) AS `at`
      FROM `PlatformAuditLog`
     WHERE `entity` = 'Organization' AND `action` = 'organization.trial_converted' AND `entityId` IS NOT NULL
     GROUP BY `entityId`
  ) c ON c.`entityId` = o.`id`
   SET o.`convertedAt` = c.`at`
 WHERE o.`convertedAt` IS NULL;

UPDATE `Organization` o
  JOIN (
    SELECT `entityId`, MIN(`createdAt`) AS `at`
      FROM `PlatformAuditLog`
     WHERE `entity` = 'Organization' AND `action` = 'organization.updated' AND `entityId` IS NOT NULL
       AND JSON_UNQUOTE(JSON_EXTRACT(`before`, '$.planTier')) = 'STARTER'
       AND JSON_UNQUOTE(JSON_EXTRACT(`after`, '$.planTier')) IN ('TEAM', 'ENTERPRISE')
     GROUP BY `entityId`
  ) c ON c.`entityId` = o.`id`
   SET o.`convertedAt` = c.`at`
 WHERE o.`convertedAt` IS NULL
   AND o.`trialStartedAt` IS NOT NULL
   AND (o.`trialTier` IS NULL OR o.`stripeSubscriptionId` IS NOT NULL OR o.`planTier` <> 'STARTER');
