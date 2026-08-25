-- Change management, enterprise scope (V8 phase 11b). Expands the module from the first cut to the
-- brief in full: classification, business justification, structured impact, a weighted risk score,
-- implementation steps, test cases, dependencies, release detail, communication plan, validation,
-- post-implementation review and closure - plus the master data an administrator maintains.
--
-- PORTABILITY NOTE (the 2.4.0 lesson, docs/DATABASE.md): generated with `prisma migrate diff` in
-- SCHEMA-TO-SCHEMA mode rather than against a shadow database. Replaying migrations into a shadow DB
-- on this Windows MariaDB emits `changerequest`/`user` in lower case, which works here and dies on
-- case-sensitive Linux MySQL; a datamodel-to-datamodel diff never touches a database and comes out in
-- canonical model casing. Verified: zero lower-cased table identifiers below.
--
-- WHAT IS DESTRUCTIVE AND WHY IT IS SAFE: `ChangeApprovalPolicy` is dropped. It shipped hours earlier
-- in the same UNRELEASED version and held only migration-seeded rows; the approval model it served has
-- been replaced by a fixed rule - the requester's own manager, or a super admin - so nothing reads it.
-- No customer data has ever been in it.
--
-- `changeKey` is added NULLABLE, backfilled, and only then made unique. The generated form adds it NOT
-- NULL with a unique index in one statement, which is correct only while every tenant's table is empty
-- - true today, and exactly the assumption that stops being true the one time it matters.

-- AlterTable
-- Guarded on `actualDowntimeMinutes`: a half-applied run must not trip over its own column.
SET @g := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND COLUMN_NAME = 'actualDowntimeMinutes');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD COLUMN `actualDowntimeMinutes` INTEGER NULL,
    ADD COLUMN `actualResult` TEXT NULL,
    ADD COLUMN `apiChanges` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `appRestartRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `applicationId` VARCHAR(191) NULL,
    ADD COLUMN `backupEngineerId` VARCHAR(191) NULL,
    ADD COLUMN `backupLocation` VARCHAR(400) NULL,
    ADD COLUMN `backupRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `backupVerified` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `branch` VARCHAR(200) NULL,
    ADD COLUMN `buildNumber` VARCHAR(80) NULL,
    ADD COLUMN `businessBenefits` TEXT NULL,
    ADD COLUMN `businessConfirmation` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `businessOwnerId` VARCHAR(191) NULL,
    ADD COLUMN `businessUnit` VARCHAR(120) NULL,
    ADD COLUMN `businessValidationRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `changeKey` VARCHAR(64) NULL,
    ADD COLUMN `cicdPipeline` VARCHAR(400) NULL,
    ADD COLUMN `closedById` VARCHAR(191) NULL,
    ADD COLUMN `closureStatus` VARCHAR(30) NULL,
    ADD COLUMN `communicationChannel` VARCHAR(80) NULL,
    ADD COLUMN `communicationOwnerId` VARCHAR(191) NULL,
    ADD COLUMN `complianceImpact` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `complianceReference` VARCHAR(200) NULL,
    ADD COLUMN `configurationChanges` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `conflictOverridden` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `conflictOverrideReason` TEXT NULL,
    ADD COLUMN `costOfNotImplementing` TEXT NULL,
    ADD COLUMN `currentSituation` TEXT NULL,
    ADD COLUMN `customerAffected` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `customerImpactNotes` TEXT NULL,
    ADD COLUMN `customerNotificationRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `dataModified` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `databaseChanges` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `dbRestartRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `department` VARCHAR(120) NULL,
    ADD COLUMN `deploymentMethod` VARCHAR(120) NULL,
    ADD COLUMN `deploymentPackage` VARCHAR(400) NULL,
    ADD COLUMN `deploymentTool` VARCHAR(120) NULL,
    ADD COLUMN `documentationUpdated` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `downtimeEnd` DATETIME(3) NULL,
    ADD COLUMN `downtimeStart` DATETIME(3) NULL,
    ADD COLUMN `environment` ENUM(''DEVELOPMENT'', ''QA'', ''UAT'', ''STAGING'', ''PRODUCTION'', ''DR'') NOT NULL DEFAULT ''PRODUCTION'',
    ADD COLUMN `estimatedRollbackMinutes` INTEGER NULL,
    ADD COLUMN `expectedDurationMinutes` INTEGER NULL,
    ADD COLUMN `expectedOutcome` TEXT NULL,
    ADD COLUMN `expectedResultAchieved` BOOLEAN NULL,
    ADD COLUMN `externalIntegrationImpact` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `followUpActions` TEXT NULL,
    ADD COLUMN `followUpOwnerId` VARCHAR(191) NULL,
    ADD COLUMN `followUpTargetDate` DATETIME(3) NULL,
    ADD COLUMN `implementationIssues` TEXT NULL,
    ADD COLUMN `implementationNotes` TEXT NULL,
    ADD COLUMN `implementationObjective` TEXT NULL,
    ADD COLUMN `implementationSuccessful` BOOLEAN NULL,
    ADD COLUMN `implementationSummary` TEXT NULL,
    ADD COLUMN `incidentCreated` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `incidentReference` VARCHAR(120) NULL,
    ADD COLUMN `infrastructureChanges` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `internalCommRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `issuesEncountered` TEXT NULL,
    ADD COLUMN `lessonsLearned` TEXT NULL,
    ADD COLUMN `maintenanceWindowId` VARCHAR(191) NULL,
    ADD COLUMN `monitoringCompleted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `notificationAudience` TEXT NULL,
    ADD COLUMN `notificationDate` DATETIME(3) NULL,
    ADD COLUMN `prerequisites` TEXT NULL,
    ADD COLUMN `primaryEngineerId` VARCHAR(191) NULL,
    ADD COLUMN `problemStatement` TEXT NULL,
    ADD COLUMN `productName` VARCHAR(120) NULL,
    ADD COLUMN `productionAffected` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `projectReference` VARCHAR(200) NULL,
    ADD COLUMN `reasonForChange` TEXT NULL,
    ADD COLUMN `recommendations` TEXT NULL,
    ADD COLUMN `regulatoryRequirement` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `releaseTicket` VARCHAR(120) NULL,
    ADD COLUMN `releaseVersion` VARCHAR(80) NULL,
    ADD COLUMN `repository` VARCHAR(400) NULL,
    ADD COLUMN `requiredAccess` TEXT NULL,
    ADD COLUMN `requiredResources` TEXT NULL,
    ADD COLUMN `requiredTools` TEXT NULL,
    ADD COLUMN `restoreProcedure` TEXT NULL,
    ADD COLUMN `revenueImpact` TEXT NULL,
    ADD COLUMN `riskScore` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `rollbackCriteria` TEXT NULL,
    ADD COLUMN `rollbackEndedAt` DATETIME(3) NULL,
    ADD COLUMN `rollbackOwnerId` VARCHAR(191) NULL,
    ADD COLUMN `rollbackProcedure` TEXT NULL,
    ADD COLUMN `rollbackReason` TEXT NULL,
    ADD COLUMN `rollbackRequired` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `rollbackResult` TEXT NULL,
    ADD COLUMN `rollbackStartedAt` DATETIME(3) NULL,
    ADD COLUMN `rollbackStatus` VARCHAR(20) NOT NULL DEFAULT ''NOT_REQUIRED'',
    ADD COLUMN `securityImpact` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `serverRestartRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `serviceInterruption` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `serviceName` VARCHAR(120) NULL,
    ADD COLUMN `slaImpact` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `slaImpactNotes` TEXT NULL,
    ADD COLUMN `sourceId` VARCHAR(191) NULL,
    ADD COLUMN `stakeholderNotifyRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `technicalConfirmation` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `technicalOwnerId` VARCHAR(191) NULL,
    ADD COLUMN `testEnvironment` ENUM(''DEVELOPMENT'', ''QA'', ''UAT'', ''STAGING'', ''PRODUCTION'', ''DR'') NULL,
    ADD COLUMN `testingEnd` DATETIME(3) NULL,
    ADD COLUMN `testingStart` DATETIME(3) NULL,
    ADD COLUMN `testingTeam` VARCHAR(200) NULL,
    ADD COLUMN `uatRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `validationCriteria` TEXT NULL,
    ADD COLUMN `validationDate` DATETIME(3) NULL,
    ADD COLUMN `validationIssues` TEXT NULL,
    ADD COLUMN `validationOwnerId` VARCHAR(191) NULL,
    ADD COLUMN `validationResult` VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- DropTable
-- IF EXISTS because this table only ever existed in an unreleased build: an installation that
-- upgrades straight past that build has nothing to drop, and a bare DROP would abort its upgrade.
DROP TABLE IF EXISTS `ChangeApprovalPolicy`;

-- CreateTable
CREATE TABLE IF NOT EXISTS `ChangeSource` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ChangeSource_name_key`(`name`),
    INDEX `ChangeSource_isActive_order_idx`(`isActive`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `ChangeApplication` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `code` VARCHAR(40) NULL,
    `ownerId` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ChangeApplication_name_key`(`name`),
    INDEX `ChangeApplication_isActive_name_idx`(`isActive`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `MaintenanceWindow` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `environment` ENUM('DEVELOPMENT', 'QA', 'UAT', 'STAGING', 'PRODUCTION', 'DR') NOT NULL DEFAULT 'PRODUCTION',
    `dayOfWeek` INTEGER NOT NULL,
    `startMinute` INTEGER NOT NULL,
    `endMinute` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MaintenanceWindow_isActive_environment_dayOfWeek_idx`(`isActive`, `environment`, `dayOfWeek`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `BlackoutPeriod` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `reason` TEXT NULL,
    `environment` ENUM('DEVELOPMENT', 'QA', 'UAT', 'STAGING', 'PRODUCTION', 'DR') NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `BlackoutPeriod_isActive_startsAt_endsAt_idx`(`isActive`, `startsAt`, `endsAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `ChangeRiskParameter` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(60) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `weight` INTEGER NOT NULL DEFAULT 10,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ChangeRiskParameter_key_key`(`key`),
    INDEX `ChangeRiskParameter_isActive_order_idx`(`isActive`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `ChangeSlaConfig` (
    `id` VARCHAR(191) NOT NULL,
    `stage` VARCHAR(40) NOT NULL,
    `hours` INTEGER NOT NULL DEFAULT 48,
    `warnAtPct` INTEGER NOT NULL DEFAULT 75,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ChangeSlaConfig_stage_key`(`stage`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `ChangeImplementationStep` (
    `id` VARCHAR(191) NOT NULL,
    `changeId` VARCHAR(191) NOT NULL,
    `stepNumber` INTEGER NOT NULL,
    `description` TEXT NOT NULL,
    `ownerId` VARCHAR(191) NULL,
    `plannedStart` DATETIME(3) NULL,
    `plannedEnd` DATETIME(3) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED',
    `comments` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ChangeImplementationStep_changeId_stepNumber_idx`(`changeId`, `stepNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `ChangeTestCase` (
    `id` VARCHAR(191) NOT NULL,
    `changeId` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(40) NOT NULL,
    `description` TEXT NOT NULL,
    `expectedResult` TEXT NULL,
    `actualResult` TEXT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED',
    `testerId` VARCHAR(191) NULL,
    `comments` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ChangeTestCase_changeId_idx`(`changeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `ChangeDependency` (
    `id` VARCHAR(191) NOT NULL,
    `changeId` VARCHAR(191) NOT NULL,
    `dependencyType` VARCHAR(20) NOT NULL DEFAULT 'PREDECESSOR',
    `description` TEXT NOT NULL,
    `relatedChangeId` VARCHAR(64) NULL,
    `application` VARCHAR(120) NULL,
    `team` VARCHAR(120) NULL,
    `ownerId` VARCHAR(191) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ChangeDependency_changeId_status_idx`(`changeId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `ChangeCollaborator` (
    `id` VARCHAR(191) NOT NULL,
    `changeId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `roleLabel` VARCHAR(80) NULL,
    `addedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChangeCollaborator_userId_idx`(`userId`),
    UNIQUE INDEX `ChangeCollaborator_changeId_userId_key`(`changeId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `ChangeTicketLink` (
    `id` VARCHAR(191) NOT NULL,
    `changeId` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `addedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChangeTicketLink_ticketId_idx`(`ticketId`),
    UNIQUE INDEX `ChangeTicketLink_changeId_ticketId_key`(`changeId`, `ticketId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE IF NOT EXISTS `ChangeApproval` (
    `id` VARCHAR(191) NOT NULL,
    `changeId` VARCHAR(191) NOT NULL,
    `round` INTEGER NOT NULL DEFAULT 1,
    `approverId` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(40) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `comments` TEXT NULL,
    `decidedAt` DATETIME(3) NULL,
    `dueAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChangeApproval_changeId_round_idx`(`changeId`, `round`),
    INDEX `ChangeApproval_approverId_status_idx`(`approverId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
-- Guarded on `ChangeRequest_changeKey_key`.
SET @g := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND INDEX_NAME = 'ChangeRequest_changeKey_key');
SET @sql := IF(@g = 0, 'CREATE UNIQUE INDEX `ChangeRequest_changeKey_key` ON `ChangeRequest`(`changeKey`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- CreateIndex
-- Guarded on `ChangeRequest_environment_state_idx`.
SET @g := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND INDEX_NAME = 'ChangeRequest_environment_state_idx');
SET @sql := IF(@g = 0, 'CREATE INDEX `ChangeRequest_environment_state_idx` ON `ChangeRequest`(`environment`, `state`)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_sourceId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_sourceId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_sourceId_fkey` FOREIGN KEY (`sourceId`) REFERENCES `ChangeSource`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_applicationId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_applicationId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `ChangeApplication`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_businessOwnerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_businessOwnerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_businessOwnerId_fkey` FOREIGN KEY (`businessOwnerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_technicalOwnerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_technicalOwnerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_technicalOwnerId_fkey` FOREIGN KEY (`technicalOwnerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_primaryEngineerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_primaryEngineerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_primaryEngineerId_fkey` FOREIGN KEY (`primaryEngineerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_backupEngineerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_backupEngineerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_backupEngineerId_fkey` FOREIGN KEY (`backupEngineerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_rollbackOwnerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_rollbackOwnerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_rollbackOwnerId_fkey` FOREIGN KEY (`rollbackOwnerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_communicationOwnerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_communicationOwnerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_communicationOwnerId_fkey` FOREIGN KEY (`communicationOwnerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_validationOwnerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_validationOwnerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_validationOwnerId_fkey` FOREIGN KEY (`validationOwnerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_followUpOwnerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_followUpOwnerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_followUpOwnerId_fkey` FOREIGN KEY (`followUpOwnerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeRequest_closedById_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND CONSTRAINT_NAME = 'ChangeRequest_closedById_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD CONSTRAINT `ChangeRequest_closedById_fkey` FOREIGN KEY (`closedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeApplication_ownerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeApplication' AND CONSTRAINT_NAME = 'ChangeApplication_ownerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeApplication` ADD CONSTRAINT `ChangeApplication_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeImplementationStep_changeId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeImplementationStep' AND CONSTRAINT_NAME = 'ChangeImplementationStep_changeId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeImplementationStep` ADD CONSTRAINT `ChangeImplementationStep_changeId_fkey` FOREIGN KEY (`changeId`) REFERENCES `ChangeRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeImplementationStep_ownerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeImplementationStep' AND CONSTRAINT_NAME = 'ChangeImplementationStep_ownerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeImplementationStep` ADD CONSTRAINT `ChangeImplementationStep_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeTestCase_changeId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeTestCase' AND CONSTRAINT_NAME = 'ChangeTestCase_changeId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeTestCase` ADD CONSTRAINT `ChangeTestCase_changeId_fkey` FOREIGN KEY (`changeId`) REFERENCES `ChangeRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeTestCase_testerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeTestCase' AND CONSTRAINT_NAME = 'ChangeTestCase_testerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeTestCase` ADD CONSTRAINT `ChangeTestCase_testerId_fkey` FOREIGN KEY (`testerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeDependency_changeId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeDependency' AND CONSTRAINT_NAME = 'ChangeDependency_changeId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeDependency` ADD CONSTRAINT `ChangeDependency_changeId_fkey` FOREIGN KEY (`changeId`) REFERENCES `ChangeRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeDependency_ownerId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeDependency' AND CONSTRAINT_NAME = 'ChangeDependency_ownerId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeDependency` ADD CONSTRAINT `ChangeDependency_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeCollaborator_changeId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeCollaborator' AND CONSTRAINT_NAME = 'ChangeCollaborator_changeId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeCollaborator` ADD CONSTRAINT `ChangeCollaborator_changeId_fkey` FOREIGN KEY (`changeId`) REFERENCES `ChangeRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeCollaborator_userId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeCollaborator' AND CONSTRAINT_NAME = 'ChangeCollaborator_userId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeCollaborator` ADD CONSTRAINT `ChangeCollaborator_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeCollaborator_addedById_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeCollaborator' AND CONSTRAINT_NAME = 'ChangeCollaborator_addedById_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeCollaborator` ADD CONSTRAINT `ChangeCollaborator_addedById_fkey` FOREIGN KEY (`addedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeTicketLink_changeId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeTicketLink' AND CONSTRAINT_NAME = 'ChangeTicketLink_changeId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeTicketLink` ADD CONSTRAINT `ChangeTicketLink_changeId_fkey` FOREIGN KEY (`changeId`) REFERENCES `ChangeRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeTicketLink_ticketId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeTicketLink' AND CONSTRAINT_NAME = 'ChangeTicketLink_ticketId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeTicketLink` ADD CONSTRAINT `ChangeTicketLink_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeApproval_changeId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeApproval' AND CONSTRAINT_NAME = 'ChangeApproval_changeId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeApproval` ADD CONSTRAINT `ChangeApproval_changeId_fkey` FOREIGN KEY (`changeId`) REFERENCES `ChangeRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- AddForeignKey
-- Guarded on `ChangeApproval_approverId_fkey`.
SET @g := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeApproval' AND CONSTRAINT_NAME = 'ChangeApproval_approverId_fkey');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeApproval` ADD CONSTRAINT `ChangeApproval_approverId_fkey` FOREIGN KEY (`approverId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;




-- ---------------------------------------------------------------------------------------------
-- JSON columns, added the long way round.
--
-- MariaDB implements JSON as LONGTEXT plus a `json_valid()` CHECK. Adding one NOT NULL in the same
-- ALTER as everything else makes every existing row take the implicit empty-string default, which
-- fails that check and aborts the whole statement — the exact failure this migration hit on a
-- workspace that already held one change. Added nullable, backfilled with a real empty array, then
-- tightened: three cheap statements instead of one that only works on an empty table.
-- ---------------------------------------------------------------------------------------------
-- Guarded on `affectedApis`: a half-applied run must not trip over its own column.
SET @g := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND COLUMN_NAME = 'affectedApis');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD COLUMN `affectedApis` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `ChangeRequest` SET `affectedApis` = '[]' WHERE `affectedApis` IS NULL;
ALTER TABLE `ChangeRequest` MODIFY COLUMN `affectedApis` JSON NOT NULL;
-- Guarded on `affectedApplications`: a half-applied run must not trip over its own column.
SET @g := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND COLUMN_NAME = 'affectedApplications');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD COLUMN `affectedApplications` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `ChangeRequest` SET `affectedApplications` = '[]' WHERE `affectedApplications` IS NULL;
ALTER TABLE `ChangeRequest` MODIFY COLUMN `affectedApplications` JSON NOT NULL;
-- Guarded on `affectedCustomers`: a half-applied run must not trip over its own column.
SET @g := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND COLUMN_NAME = 'affectedCustomers');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD COLUMN `affectedCustomers` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `ChangeRequest` SET `affectedCustomers` = '[]' WHERE `affectedCustomers` IS NULL;
ALTER TABLE `ChangeRequest` MODIFY COLUMN `affectedCustomers` JSON NOT NULL;
-- Guarded on `affectedDatabases`: a half-applied run must not trip over its own column.
SET @g := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND COLUMN_NAME = 'affectedDatabases');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD COLUMN `affectedDatabases` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `ChangeRequest` SET `affectedDatabases` = '[]' WHERE `affectedDatabases` IS NULL;
ALTER TABLE `ChangeRequest` MODIFY COLUMN `affectedDatabases` JSON NOT NULL;
-- Guarded on `affectedDepartments`: a half-applied run must not trip over its own column.
SET @g := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND COLUMN_NAME = 'affectedDepartments');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD COLUMN `affectedDepartments` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `ChangeRequest` SET `affectedDepartments` = '[]' WHERE `affectedDepartments` IS NULL;
ALTER TABLE `ChangeRequest` MODIFY COLUMN `affectedDepartments` JSON NOT NULL;
-- Guarded on `affectedInfrastructure`: a half-applied run must not trip over its own column.
SET @g := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND COLUMN_NAME = 'affectedInfrastructure');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD COLUMN `affectedInfrastructure` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `ChangeRequest` SET `affectedInfrastructure` = '[]' WHERE `affectedInfrastructure` IS NULL;
ALTER TABLE `ChangeRequest` MODIFY COLUMN `affectedInfrastructure` JSON NOT NULL;
-- Guarded on `affectedIntegrations`: a half-applied run must not trip over its own column.
SET @g := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND COLUMN_NAME = 'affectedIntegrations');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD COLUMN `affectedIntegrations` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `ChangeRequest` SET `affectedIntegrations` = '[]' WHERE `affectedIntegrations` IS NULL;
ALTER TABLE `ChangeRequest` MODIFY COLUMN `affectedIntegrations` JSON NOT NULL;
-- Guarded on `affectedLocations`: a half-applied run must not trip over its own column.
SET @g := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND COLUMN_NAME = 'affectedLocations');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD COLUMN `affectedLocations` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `ChangeRequest` SET `affectedLocations` = '[]' WHERE `affectedLocations` IS NULL;
ALTER TABLE `ChangeRequest` MODIFY COLUMN `affectedLocations` JSON NOT NULL;
-- Guarded on `riskInputs`: a half-applied run must not trip over its own column.
SET @g := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ChangeRequest' AND COLUMN_NAME = 'riskInputs');
SET @sql := IF(@g = 0, 'ALTER TABLE `ChangeRequest` ADD COLUMN `riskInputs` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `ChangeRequest` SET `riskInputs` = '{}' WHERE `riskInputs` IS NULL;
ALTER TABLE `ChangeRequest` MODIFY COLUMN `riskInputs` JSON NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Backfill `changeKey`, then enforce it. Format matches change-key.service.ts:
-- PROJECTCODE-YYYYMMDD-NNNN, so a backfilled key is indistinguishable from a freshly minted one.
-- ---------------------------------------------------------------------------------------------
UPDATE `ChangeRequest` cr
JOIN `Ticket` t ON t.`id` = cr.`ticketId`
JOIN `Project` p ON p.`id` = t.`projectId`
SET cr.`changeKey` = CONCAT(p.`code`, '-', DATE_FORMAT(cr.`createdAt`, '%Y%m%d'), '-', LPAD(RIGHT(cr.`id`, 4), 4, '0'))
WHERE cr.`changeKey` IS NULL;

-- Anything the join could not reach (a soft-deleted project) still needs a value, because the column
-- is about to become NOT NULL. Falling back to the row id keeps it unique without inventing a code.
UPDATE `ChangeRequest` SET `changeKey` = CONCAT('CHG-', `id`) WHERE `changeKey` IS NULL;

ALTER TABLE `ChangeRequest` MODIFY COLUMN `changeKey` VARCHAR(64) NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Master data. INSERT IGNORE / guarded inserts throughout, so re-running the migration or applying it
-- to a tenant that already has a row is a no-op rather than a duplicate-key failure.
-- ---------------------------------------------------------------------------------------------
INSERT IGNORE INTO `ChangeSource` (`id`, `name`, `isActive`, `order`, `createdAt`, `updatedAt`) VALUES
  (UUID(), 'Incident', true, 0, NOW(3), NOW(3)),
  (UUID(), 'Problem', true, 1, NOW(3), NOW(3)),
  (UUID(), 'Project', true, 2, NOW(3), NOW(3)),
  (UUID(), 'Service request', true, 3, NOW(3), NOW(3)),
  (UUID(), 'Maintenance', true, 4, NOW(3), NOW(3)),
  (UUID(), 'Audit', true, 5, NOW(3), NOW(3)),
  (UUID(), 'Security', true, 6, NOW(3), NOW(3));

-- The risk model, as weights rather than as code. An administrator retunes these; the score a board
-- approved against is frozen on the change itself, so retuning never rewrites history.
INSERT IGNORE INTO `ChangeRiskParameter` (`id`, `key`, `label`, `weight`, `isActive`, `order`, `createdAt`, `updatedAt`) VALUES
  (UUID(), 'businessImpact', 'Business impact', 20, true, 0, NOW(3), NOW(3)),
  (UUID(), 'technicalComplexity', 'Technical complexity', 12, true, 1, NOW(3), NOW(3)),
  (UUID(), 'customerImpact', 'Customer impact', 16, true, 2, NOW(3), NOW(3)),
  (UUID(), 'securityImpact', 'Security impact', 14, true, 3, NOW(3), NOW(3)),
  (UUID(), 'downtime', 'Downtime required', 12, true, 4, NOW(3), NOW(3)),
  (UUID(), 'systemsAffected', 'Systems affected', 8, true, 5, NOW(3), NOW(3)),
  (UUID(), 'usersAffected', 'Users affected', 8, true, 6, NOW(3), NOW(3)),
  (UUID(), 'implementationComplexity', 'Implementation complexity', 8, true, 7, NOW(3), NOW(3)),
  (UUID(), 'rollbackComplexity', 'Rollback complexity', 14, true, 8, NOW(3), NOW(3)),
  (UUID(), 'dependencyRisk', 'Dependency risk', 10, true, 9, NOW(3), NOW(3)),
  (UUID(), 'dataRisk', 'Data risk', 18, true, 10, NOW(3), NOW(3));

INSERT IGNORE INTO `ChangeSlaConfig` (`id`, `stage`, `hours`, `warnAtPct`, `isActive`, `createdAt`, `updatedAt`) VALUES
  (UUID(), 'APPROVAL', 48, 75, true, NOW(3), NOW(3)),
  (UUID(), 'IMPLEMENTATION', 72, 80, true, NOW(3), NOW(3)),
  (UUID(), 'VALIDATION', 48, 75, true, NOW(3), NOW(3)),
  (UUID(), 'PIR', 120, 80, true, NOW(3), NOW(3)),
  (UUID(), 'CLOSURE', 168, 85, true, NOW(3), NOW(3));

-- A default production window so conflict detection has something to check against on day one.
-- Saturday 22:00 to Sunday 02:00 UTC, in minutes past midnight; an end smaller than the start is how
-- a window that crosses midnight is written.
INSERT IGNORE INTO `MaintenanceWindow` (`id`, `name`, `environment`, `dayOfWeek`, `startMinute`, `endMinute`, `isActive`, `createdAt`, `updatedAt`)
SELECT UUID(), 'Weekend production window', 'PRODUCTION', 6, 1320, 120, true, NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `MaintenanceWindow`);
