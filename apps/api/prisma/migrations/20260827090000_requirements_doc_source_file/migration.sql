-- Keep the ORIGINAL uploaded file (not just its extracted text) so the in-app viewer can show a
-- real PDF/Word document. Null for anything imported before this shipped — those still carry
-- sourceDocumentText, and the viewer falls back to it.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RequirementsDocument' AND COLUMN_NAME = 'sourceDocumentPath'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `RequirementsDocument` ADD COLUMN `sourceDocumentPath` VARCHAR(255) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
