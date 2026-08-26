-- Per-provider concurrency ceiling (ai-concurrency.service.ts). Default 2, matching the
-- conservative reality of a self-hosted Ollama; a hosted API can be raised well above it.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AIProviderConfig' AND COLUMN_NAME = 'maxConcurrent'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `AIProviderConfig` ADD COLUMN `maxConcurrent` INT NOT NULL DEFAULT 2',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
