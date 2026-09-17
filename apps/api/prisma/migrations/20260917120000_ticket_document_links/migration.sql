-- V12 8.4: a ticket ↔ requirements-document relationship ("Relate a doc with a task, right from the
-- task"). One row per pair; either side going away removes the link. Nothing existing changes.
--
-- Idempotent through the house information_schema + PREPARE guard (MySQL 8 has no CREATE TABLE IF
-- NOT EXISTS for the FK parts we need in a stable order; the table itself is guarded too).

SET @t := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TicketDocumentLink');
SET @ddl := IF(@t = 0, 'CREATE TABLE `TicketDocumentLink` (
  `id` VARCHAR(191) NOT NULL,
  `ticketId` VARCHAR(191) NOT NULL,
  `documentId` VARCHAR(191) NOT NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `TicketDocumentLink_ticketId_documentId_key` (`ticketId`, `documentId`),
  INDEX `TicketDocumentLink_documentId_idx` (`documentId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @f1 := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TicketDocumentLink' AND CONSTRAINT_NAME = 'TicketDocumentLink_ticketId_fkey');
SET @ddl := IF(@f1 = 0, 'ALTER TABLE `TicketDocumentLink` ADD CONSTRAINT `TicketDocumentLink_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @f2 := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TicketDocumentLink' AND CONSTRAINT_NAME = 'TicketDocumentLink_documentId_fkey');
SET @ddl := IF(@f2 = 0, 'ALTER TABLE `TicketDocumentLink` ADD CONSTRAINT `TicketDocumentLink_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `RequirementsDocument`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @f3 := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TicketDocumentLink' AND CONSTRAINT_NAME = 'TicketDocumentLink_createdById_fkey');
SET @ddl := IF(@f3 = 0, 'ALTER TABLE `TicketDocumentLink` ADD CONSTRAINT `TicketDocumentLink_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
