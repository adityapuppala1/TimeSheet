-- The provider circuit breaker: a failure counter per AIProviderConfig row, a marker for when the
-- breaker itself moved one, and the workspace-wide opt-in toggle. Off by default, same as every
-- other automation in GlobalAISettings.
--
-- Guarded ALTERs throughout, so a re-run against a tenant database already carrying this
-- migration is a no-op rather than a failure that strands the migration half-applied.
SET @col1 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AIProviderConfig' AND COLUMN_NAME = 'consecutiveFailures'
);
SET @sql := IF(@col1 = 0,
  'ALTER TABLE `AIProviderConfig` ADD COLUMN `consecutiveFailures` INTEGER NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col2 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AIProviderConfig' AND COLUMN_NAME = 'autoDemotedAt'
);
SET @sql := IF(@col2 = 0,
  'ALTER TABLE `AIProviderConfig` ADD COLUMN `autoDemotedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col3 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalAISettings' AND COLUMN_NAME = 'aiAutoFailoverEnabled'
);
SET @sql := IF(@col3 = 0,
  'ALTER TABLE `GlobalAISettings` ADD COLUMN `aiAutoFailoverEnabled` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
