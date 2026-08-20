-- Links an Ask AI exchange to its captured AIInteraction, so a thumb on the page reaches the same
-- quality loop and golden datasets every other capability's ratings feed. Guarded, as always: the
-- fan-out re-runs this against tenants that may already carry it.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiAskExchange' AND COLUMN_NAME = 'interactionId'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `AiAskExchange` ADD COLUMN `interactionId` VARCHAR(64) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
