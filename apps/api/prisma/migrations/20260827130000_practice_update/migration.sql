-- Weekly AI/ML Practice Update: the consolidated executive digest.
--
-- Four columns, and the split between them is the two-layer gate every digest in this app uses
-- (see schema.prisma on GlobalNotificationSettings): the AI toggle decides whether the NARRATIVE
-- is drafted at all, the notification toggle decides whether EMAIL leaves. Both default off,
-- which is the house rule for digests — a new install must not start mailing anyone.
--
-- Idempotent by column existence, because this runs against tenant databases that may already
-- have been migrated by a prior partial run.

-- 1. The email category gate (GlobalNotificationSettings.emailPracticeUpdate).
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalNotificationSettings' AND COLUMN_NAME = 'emailPracticeUpdate'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `emailPracticeUpdate` BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Who receives it. A JSON array of email addresses, set by a SUPER_ADMIN and nobody else.
--    NULL means "nobody has been chosen yet", which is a different state from "an empty list was
--    saved deliberately" — the send path refuses on both, but the UI can tell them apart.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalNotificationSettings' AND COLUMN_NAME = 'practiceUpdateRecipients'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `practiceUpdateRecipients` JSON NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. The optional Monday cadence. Off by default: the button is the primary path, and an
--    unreviewed digest going to a CEO every week is not something to switch on for people.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalNotificationSettings' AND COLUMN_NAME = 'practiceUpdateWeekly'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `practiceUpdateWeekly` BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. The AI-layer gate (GlobalAISettings.practiceUpdateEnabled). The figures are counted from the
--    database and send regardless; this only decides whether a model writes the narrative around
--    them — the correction weekly-digest.worker.ts already carries in its header.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalAISettings' AND COLUMN_NAME = 'practiceUpdateEnabled'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `GlobalAISettings` ADD COLUMN `practiceUpdateEnabled` BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
