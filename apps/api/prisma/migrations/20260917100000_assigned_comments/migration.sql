-- V12 8.3: a comment can be assigned to a person as an action item and resolved.
--
-- WHAT EXISTING ROWS DO: every column is NULL — an ordinary comment, exactly as before. Nothing
-- on any screen changes on deploy; only comments assigned from now on carry these.
--
-- Idempotent through the house information_schema + PREPARE guard (MySQL 8 has no ADD COLUMN IF
-- NOT EXISTS; MariaDB does; this app runs on both). Canonical casing written by hand. The two
-- user references are nullable and SET NULL on delete: a departed assignee un-assigns the
-- comment rather than blocking the person's deletion.

SET @c1 := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TicketComment' AND COLUMN_NAME = 'assigneeId');
SET @ddl := IF(@c1 = 0, 'ALTER TABLE `TicketComment` ADD COLUMN `assigneeId` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c2 := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TicketComment' AND COLUMN_NAME = 'resolvedAt');
SET @ddl := IF(@c2 = 0, 'ALTER TABLE `TicketComment` ADD COLUMN `resolvedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c3 := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TicketComment' AND COLUMN_NAME = 'resolvedById');
SET @ddl := IF(@c3 = 0, 'ALTER TABLE `TicketComment` ADD COLUMN `resolvedById` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @i1 := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TicketComment' AND INDEX_NAME = 'TicketComment_assigneeId_resolvedAt_idx');
SET @ddl := IF(@i1 = 0, 'CREATE INDEX `TicketComment_assigneeId_resolvedAt_idx` ON `TicketComment`(`assigneeId`, `resolvedAt`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @f1 := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TicketComment' AND CONSTRAINT_NAME = 'TicketComment_assigneeId_fkey');
SET @ddl := IF(@f1 = 0, 'ALTER TABLE `TicketComment` ADD CONSTRAINT `TicketComment_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @f2 := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TicketComment' AND CONSTRAINT_NAME = 'TicketComment_resolvedById_fkey');
SET @ddl := IF(@f2 = 0, 'ALTER TABLE `TicketComment` ADD CONSTRAINT `TicketComment_resolvedById_fkey` FOREIGN KEY (`resolvedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
