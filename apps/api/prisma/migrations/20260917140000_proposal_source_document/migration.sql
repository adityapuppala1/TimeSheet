-- V12 9.4: where a proposal came from, when it came from a requirements document.
--
-- WHAT EXISTING ROWS DO: NULL — a proposal with no document behind it, which is every proposal
-- written before this release and every one that does not start in the Studio. Nothing on any
-- screen changes; the column is only read when a ticket CREATE is applied.
--
-- WHY ON THE PROPOSAL AND NOT IN THE CHANGE PAYLOAD: a change's `after` is model-authored. The
-- proposal's scope fields are the ones both authorization checks already trust, and this joins them.
--
-- Idempotent through the house information_schema + PREPARE guard.

SET @c1 := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiProposal' AND COLUMN_NAME = 'sourceDocumentId');
SET @ddl := IF(@c1 = 0, 'ALTER TABLE `AiProposal` ADD COLUMN `sourceDocumentId` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @i1 := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiProposal' AND INDEX_NAME = 'AiProposal_sourceDocumentId_idx');
SET @ddl := IF(@i1 = 0, 'CREATE INDEX `AiProposal_sourceDocumentId_idx` ON `AiProposal`(`sourceDocumentId`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @f1 := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiProposal' AND CONSTRAINT_NAME = 'AiProposal_sourceDocumentId_fkey');
SET @ddl := IF(@f1 = 0, 'ALTER TABLE `AiProposal` ADD CONSTRAINT `AiProposal_sourceDocumentId_fkey` FOREIGN KEY (`sourceDocumentId`) REFERENCES `RequirementsDocument`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
