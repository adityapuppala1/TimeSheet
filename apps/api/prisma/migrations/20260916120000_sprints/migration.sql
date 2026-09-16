-- V12 sprints, behind a default-off workspace toggle.
--
-- WHAT THIS ADDS: a `Sprint` table (project-scoped iterations), two nullable columns on `Ticket`
-- (`sprintId`, `storyPoints`) and one Boolean on `GlobalPlanningSettings` (`enableSprints`,
-- default false). Nothing existing is altered and no row is touched: every ticket keeps NULL for
-- both new columns, every workspace stays with sprints OFF, and no page changes until a super
-- admin turns the toggle on.
--
-- WHY `SET NULL` ON THE TICKET → SPRINT FOREIGN KEY: a ticket outlives the iteration it was planned
-- into. Deleting a sprint must un-plan its tickets, never delete them.
--
-- WHY EVERY STATEMENT IS GUARDED: MySQL 8 has no `ADD COLUMN IF NOT EXISTS` (MariaDB does) and this
-- application runs on both, so the information_schema + PREPARE guard is the house pattern for an
-- idempotent migration (docs/DATABASE.md). `migrate deploy` re-running this file after an
-- interrupted first attempt cannot fail on a table, column, index or constraint already there.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- The sprint table itself. CREATE TABLE IF NOT EXISTS is portable across both engines.
CREATE TABLE IF NOT EXISTS `Sprint` (
  `id`          VARCHAR(191) NOT NULL,
  `projectId`   VARCHAR(191) NOT NULL,
  `name`        VARCHAR(120) NOT NULL,
  `goal`        VARCHAR(600) NULL,
  `startDate`   DATE NOT NULL,
  `endDate`     DATE NOT NULL,
  `status`      ENUM('PLANNED', 'ACTIVE', 'COMPLETED') NOT NULL DEFAULT 'PLANNED',
  `createdById` VARCHAR(191) NULL,
  `createdAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`   DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `Sprint_projectId_startDate_idx` (`projectId`, `startDate`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Sprint → Project (cascade: a project's sprints go with it, as its modules do).
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'Sprint' AND CONSTRAINT_NAME = 'Sprint_projectId_fkey'
);
SET @ddl := IF(@fk_exists = 0,
  'ALTER TABLE `Sprint` ADD CONSTRAINT `Sprint_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Ticket.sprintId
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Ticket' AND COLUMN_NAME = 'sprintId'
);
SET @ddl := IF(@col_exists = 0, 'ALTER TABLE `Ticket` ADD COLUMN `sprintId` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Ticket' AND INDEX_NAME = 'Ticket_sprintId_fkey'
);
SET @ddl := IF(@idx_exists = 0, 'CREATE INDEX `Ticket_sprintId_fkey` ON `Ticket`(`sprintId`)', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'Ticket' AND CONSTRAINT_NAME = 'Ticket_sprintId_fkey'
);
SET @ddl := IF(@fk_exists = 0,
  'ALTER TABLE `Ticket` ADD CONSTRAINT `Ticket_sprintId_fkey` FOREIGN KEY (`sprintId`) REFERENCES `Sprint`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Ticket.storyPoints
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Ticket' AND COLUMN_NAME = 'storyPoints'
);
SET @ddl := IF(@col_exists = 0, 'ALTER TABLE `Ticket` ADD COLUMN `storyPoints` DECIMAL(5, 1) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- GlobalPlanningSettings.enableSprints
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalPlanningSettings' AND COLUMN_NAME = 'enableSprints'
);
SET @ddl := IF(@col_exists = 0, 'ALTER TABLE `GlobalPlanningSettings` ADD COLUMN `enableSprints` BOOLEAN NOT NULL DEFAULT false', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
