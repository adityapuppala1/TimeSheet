-- The drafting assistant: one toggle, and one new proposal kind.
--
-- Both guarded. This fans out to every tenant database, and a re-run against one already carrying
-- them must be a no-op rather than a failure that strands the migration half-applied.

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalAISettings' AND COLUMN_NAME = 'changeDraftAssistEnabled'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `GlobalAISettings` ADD COLUMN `changeDraftAssistEnabled` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Widening an enum column. Written as the full MODIFY rather than an append, because MySQL has no
-- "add enum value" and the whole set has to be restated — which is also why it is spelled out here
-- rather than generated: a missing member would silently truncate existing rows to ''.
SET @kind := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiProposal'
    AND COLUMN_NAME = 'kind' AND COLUMN_TYPE LIKE '%CHANGE_DRAFT%'
);
SET @sql := IF(@kind = 0,
  'ALTER TABLE `AiProposal` MODIFY `kind` ENUM(''PLAN_BREAKDOWN'', ''SCHEDULE_ADJUSTMENT'', ''ASSIGNMENT_REBALANCE'', ''RISK_MITIGATION'', ''BLUEPRINT_SUGGESTION'', ''CHANGE_DRAFT'') NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
