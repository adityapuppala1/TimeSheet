-- Gates the change-risk narrative capability.
--
-- Guarded rather than bare: this migration fans out to every tenant database, and a re-run against
-- one that already has the column must be a no-op rather than a failure that strands the migration
-- half-applied. Same information_schema + PREPARE pattern the change-management migrations use.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalAISettings' AND COLUMN_NAME = 'changeRiskNarrativeEnabled'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `GlobalAISettings` ADD COLUMN `changeRiskNarrativeEnabled` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
