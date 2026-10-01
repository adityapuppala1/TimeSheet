-- Signup Phase 1 (docs/SIGNUP_AND_DOMAINS_PLAN.md §5.3): a person whose company already has this
-- workspace can ask to join it instead of opening a second one. The request lives HERE, in the
-- workspace's own database, with the people who decide it; it is decided on Users → Requests.
--
-- One new table, `JoinRequest`, and nothing existing changes. No password is stored in it — ever:
-- approval creates the account with an unusable password and mails a single-use set-password link.
--
-- WHAT EXISTING ROWS DO: nothing; the table starts empty.
--
-- WHY EVERY STATEMENT IS GUARDED: the house pattern (docs/DATABASE.md) — CREATE TABLE IF NOT EXISTS
-- for the table, and the information_schema check + PREPARE for the foreign key, which MySQL cannot
-- add conditionally any other way. A run interrupted between the two replays cleanly.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off Windows
-- MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).
-- @rerunnable

CREATE TABLE IF NOT EXISTS `JoinRequest` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `message` VARCHAR(1000) NULL,
    `status` ENUM('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `expiresAt` DATETIME(3) NOT NULL,
    `decidedById` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(500) NULL,
    `roleGranted` ENUM('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'TEAM_LEAD', 'EMPLOYEE') NULL,
    `createdUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `JoinRequest_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `JoinRequest_email_status_idx`(`email`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @f := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'JoinRequest' AND CONSTRAINT_NAME = 'JoinRequest_decidedById_fkey');
SET @ddl := IF(@f = 0, 'ALTER TABLE `JoinRequest` ADD CONSTRAINT `JoinRequest_decidedById_fkey` FOREIGN KEY (`decidedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
