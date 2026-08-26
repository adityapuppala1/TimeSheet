-- Requirements Studio: optional "imported from an existing PRD/BRD" provenance — filename, size,
-- extracted text (never the raw uploaded bytes), who uploaded it, and when. All null together means
-- the document was created manually (the default, and every existing row today).
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RequirementsDocument' AND COLUMN_NAME = 'sourceDocumentName'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `RequirementsDocument` ADD COLUMN `sourceDocumentName` VARCHAR(255) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RequirementsDocument' AND COLUMN_NAME = 'sourceDocumentSize'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `RequirementsDocument` ADD COLUMN `sourceDocumentSize` INT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RequirementsDocument' AND COLUMN_NAME = 'sourceDocumentText'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `RequirementsDocument` ADD COLUMN `sourceDocumentText` TEXT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RequirementsDocument' AND COLUMN_NAME = 'sourceDocumentUploadedById'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `RequirementsDocument` ADD COLUMN `sourceDocumentUploadedById` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RequirementsDocument' AND COLUMN_NAME = 'sourceDocumentUploadedAt'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `RequirementsDocument` ADD COLUMN `sourceDocumentUploadedAt` DATETIME(3) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RequirementsDocument' AND CONSTRAINT_NAME = 'RequirementsDocument_sourceDocumentUploadedById_fkey'
);
SET @sql := IF(@fk = 0,
  'ALTER TABLE `RequirementsDocument` ADD CONSTRAINT `RequirementsDocument_sourceDocumentUploadedById_fkey` FOREIGN KEY (`sourceDocumentUploadedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
