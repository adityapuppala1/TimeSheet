-- Change management (V8 phase 11): a change request is a Ticket plus a 1:1 extension row.
--
-- PORTABILITY NOTE (the 2.4.0 lesson, docs/DATABASE.md): every table and column name below is
-- written in canonical model casing by hand rather than taken from a Windows MariaDB
-- introspection, which lower-cases `User`/`Ticket` and then dies on case-sensitive Linux MySQL.
--
-- Additive apart from one nullable column on `ApprovalRequest`. The DML at the end — the
-- permission backfill — is guarded with the information_schema + PREPARE pattern the portability
-- test demands, because it runs against tenant databases whose migration history varies.
--
-- `ApprovalRequest.quorum` is NULL for every existing row, and NULL means "every step must
-- approve" — exactly what those rows did before this column existed. Backfilling a number would
-- have completed somebody's half-decided approval on upgrade.

-- AlterTable
ALTER TABLE `ApprovalRequest` ADD COLUMN `quorum` INTEGER NULL;

-- CreateTable
CREATE TABLE `ChangeCategory` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `color` VARCHAR(20) NULL,
    `requiresSecurityReview` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ChangeCategory_name_key`(`name`),
    INDEX `ChangeCategory_isActive_order_idx`(`isActive`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChangeRequest` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `justification` TEXT NOT NULL,
    `changeKind` ENUM('STANDARD', 'NORMAL', 'EMERGENCY', 'MAJOR') NOT NULL DEFAULT 'NORMAL',
    `categoryId` VARCHAR(191) NULL,
    `state` ENUM('DRAFT', 'SUBMITTED', 'RISK_ASSESSMENT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'IMPLEMENTING', 'PIR', 'CLOSED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `impact` ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL DEFAULT 'LOW',
    `likelihood` ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL DEFAULT 'LOW',
    `riskLevel` ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL DEFAULT 'LOW',
    `riskScoredAt` DATETIME(3) NULL,
    `affectedServices` JSON NOT NULL,
    `affectedUserCount` INTEGER NULL,
    `requiresDowntime` BOOLEAN NOT NULL DEFAULT false,
    `downtimeMinutes` INTEGER NULL,
    `securityReviewRequired` BOOLEAN NOT NULL DEFAULT false,
    `dataMigration` BOOLEAN NOT NULL DEFAULT false,
    `complianceTags` JSON NOT NULL,
    `implementationPlan` TEXT NULL,
    `backoutPlan` TEXT NULL,
    `testPlan` TEXT NULL,
    `communicationPlan` TEXT NULL,
    `plannedStart` DATETIME(3) NULL,
    `plannedEnd` DATETIME(3) NULL,
    `actualStart` DATETIME(3) NULL,
    `actualEnd` DATETIME(3) NULL,
    `freezeOverrideReason` TEXT NULL,
    `outcome` ENUM('SUCCESSFUL', 'SUCCESSFUL_WITH_ISSUES', 'FAILED', 'ROLLED_BACK') NULL,
    `pirNotes` TEXT NULL,
    `closureNotes` TEXT NULL,
    `approvalRequestId` VARCHAR(36) NULL,
    `submittedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ChangeRequest_ticketId_key`(`ticketId`),
    INDEX `ChangeRequest_state_plannedStart_idx`(`state`, `plannedStart`),
    INDEX `ChangeRequest_riskLevel_state_idx`(`riskLevel`, `state`),
    INDEX `ChangeRequest_changeKind_idx`(`changeKind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChangeApprovalPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `matchKind` ENUM('STANDARD', 'NORMAL', 'EMERGENCY', 'MAJOR') NULL,
    `matchRiskLevel` ENUM('LOW', 'MEDIUM', 'HIGH') NULL,
    `matchCategoryId` VARCHAR(191) NULL,
    `isCatchAll` BOOLEAN NOT NULL DEFAULT false,
    `isSequential` BOOLEAN NOT NULL DEFAULT true,
    `quorum` INTEGER NULL,
    `steps` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ChangeApprovalPolicy_enabled_order_idx`(`enabled`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GlobalChangeSettings` (
    `id` VARCHAR(191) NOT NULL,
    `enableChangeManagement` BOOLEAN NOT NULL DEFAULT false,
    `approvalSlaHours` INTEGER NOT NULL DEFAULT 48,
    `remindHoursBefore` JSON NOT NULL,
    `requireFaceOnApproval` BOOLEAN NOT NULL DEFAULT false,
    `updatedById` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `ChangeCategory`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the default change taxonomy. INSERT IGNORE against the unique name, so re-running the
-- migration (or a tenant that already has one of these) is a no-op rather than a duplicate-key
-- failure. UUID() is fine here: these rows are never referenced across databases.
INSERT IGNORE INTO `ChangeCategory` (`id`, `name`, `color`, `requiresSecurityReview`, `isActive`, `order`, `createdAt`, `updatedAt`) VALUES
  (UUID(), 'Application',    '#3B82F6', false, true, 0, NOW(3), NOW(3)),
  (UUID(), 'Infrastructure', '#8B5CF6', false, true, 1, NOW(3), NOW(3)),
  (UUID(), 'Database',       '#0EA5E9', false, true, 2, NOW(3), NOW(3)),
  (UUID(), 'Network',        '#14B8A6', false, true, 3, NOW(3), NOW(3)),
  (UUID(), 'Security',       '#DC2626', true,  true, 4, NOW(3), NOW(3)),
  (UUID(), 'Process',        '#94A3B8', false, true, 5, NOW(3), NOW(3));

-- The catch-all approval policy. A workspace with change management on and no policy would have
-- changes that reach AWAITING_APPROVAL with nobody able to decide them — so the floor is seeded
-- here rather than left to an admin to remember.
INSERT IGNORE INTO `ChangeApprovalPolicy` (`id`, `name`, `order`, `isCatchAll`, `isSequential`, `steps`, `enabled`, `createdAt`, `updatedAt`)
SELECT UUID(), 'Default — the implementer''s manager', 100, true, true, JSON_ARRAY(JSON_OBJECT('kind', 'MANAGER_OF_IMPLEMENTER')), true, NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `ChangeApprovalPolicy` WHERE `isCatchAll` = true);

-- Emergency changes need a fast path or people route around the whole module. Any ONE admin can
-- sign one off (quorum = 1), rather than waiting for a full board.
INSERT IGNORE INTO `ChangeApprovalPolicy` (`id`, `name`, `order`, `matchKind`, `isCatchAll`, `isSequential`, `quorum`, `steps`, `enabled`, `createdAt`, `updatedAt`)
SELECT UUID(), 'Emergency — any one admin', 10, 'EMERGENCY', false, false, 1, JSON_ARRAY(JSON_OBJECT('kind', 'ROLE', 'value', 'ADMIN'), JSON_OBJECT('kind', 'ROLE', 'value', 'SUPER_ADMIN')), true, NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `ChangeApprovalPolicy` WHERE `matchKind` = 'EMERGENCY');

-- Permission backfill. The seed (prisma/seed.ts) is a ONE-TIME bootstrap that never runs on
-- upgrade, so a key added there alone would reach fresh installs and never reach existing ones.
-- Guarded with the information_schema + PREPARE pattern: a tenant database that predates the
-- Permission/RolePermission tables must skip this rather than fail the whole migration.
SET @has_perm := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Permission');
SET @has_rp   := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RolePermission');

SET @sql := IF(@has_perm > 0,
  'INSERT IGNORE INTO `Permission` (`id`, `key`, `description`) VALUES (UUID(), ''changes:write'', ''changes:write''), (UUID(), ''changes:approve'', ''changes:approve''), (UUID(), ''changes:manage'', ''changes:manage'')',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- changes:write — everyone who can already raise a ticket can raise a change.
SET @sql := IF(@has_perm > 0 AND @has_rp > 0,
  'INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`) SELECT r.id, p.id FROM `Role` r CROSS JOIN `Permission` p WHERE p.`key` = ''changes:write'' AND r.name IN (''SUPER_ADMIN'', ''ADMIN'', ''MANAGER'', ''TEAM_LEAD'', ''EMPLOYEE'')',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- changes:approve — from TEAM_LEAD up. An employee raises; somebody accountable signs off.
SET @sql := IF(@has_perm > 0 AND @has_rp > 0,
  'INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`) SELECT r.id, p.id FROM `Role` r CROSS JOIN `Permission` p WHERE p.`key` = ''changes:approve'' AND r.name IN (''SUPER_ADMIN'', ''ADMIN'', ''MANAGER'', ''TEAM_LEAD'')',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- changes:manage — policies and categories are workspace configuration, so admins only.
SET @sql := IF(@has_perm > 0 AND @has_rp > 0,
  'INSERT IGNORE INTO `RolePermission` (`roleId`, `permissionId`) SELECT r.id, p.id FROM `Role` r CROSS JOIN `Permission` p WHERE p.`key` = ''changes:manage'' AND r.name IN (''SUPER_ADMIN'', ''ADMIN'')',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The thirteen notification toggles. Additive and defaulted, so an upgrade lands with the module's
-- transactional messages enabled and its digest off — matching the defaults every other category
-- block here ships with, and matching PLAN defaults rather than surprising an existing workspace.
ALTER TABLE `GlobalNotificationSettings`
    ADD COLUMN `emailChangeSubmitted` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangeApprovalRequested` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangeApproved` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangeRejected` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangeScheduled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangeWindowReminder` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangeImplementationStarted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `emailChangeCompleted` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangeFailed` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangePirDue` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangeFreezeConflict` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangeOverdueApproval` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailChangeWeeklyDigest` BOOLEAN NOT NULL DEFAULT false;
