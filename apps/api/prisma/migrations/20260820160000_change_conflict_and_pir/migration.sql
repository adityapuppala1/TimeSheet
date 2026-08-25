-- Two more change capabilities: the conflict brief and the post-implementation-review assistant.
--
-- Guarded, like every column this module has added. These fan out to every tenant database, and a
-- re-run against one already carrying them must be a no-op rather than a failure that strands the
-- migration half-applied.

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalAISettings' AND COLUMN_NAME = 'changeConflictBriefEnabled'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `GlobalAISettings` ADD COLUMN `changeConflictBriefEnabled` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalAISettings' AND COLUMN_NAME = 'changePirAssistEnabled'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `GlobalAISettings` ADD COLUMN `changePirAssistEnabled` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
