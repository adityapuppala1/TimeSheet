-- AlterTable
ALTER TABLE `project` ADD COLUMN `budgetAlertPct` INTEGER NULL,
    ADD COLUMN `budgetAmount` DECIMAL(14, 2) NULL,
    ADD COLUMN `budgetCurrency` VARCHAR(3) NULL,
    ADD COLUMN `plannedEndDate` DATE NULL,
    ADD COLUMN `plannedStartDate` DATE NULL,
    ADD COLUMN `portfolioId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `ticket` ADD COLUMN `baselineEffortHours` DECIMAL(7, 2) NULL,
    ADD COLUMN `baselineEndDate` DATE NULL,
    ADD COLUMN `baselineSetAt` DATETIME(3) NULL,
    ADD COLUMN `baselineStartDate` DATE NULL,
    ADD COLUMN `endDate` DATE NULL,
    ADD COLUMN `isMilestone` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `parentId` VARCHAR(191) NULL,
    ADD COLUMN `progressPct` INTEGER NULL,
    ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `startDate` DATE NULL,
    ADD COLUMN `workflowStatusId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `ticketlink` ADD COLUMN `lagDays` INTEGER NULL,
    MODIFY `type` ENUM('BLOCKS', 'DUPLICATE', 'RELATES', 'FINISH_TO_START', 'START_TO_START', 'FINISH_TO_FINISH', 'START_TO_FINISH') NOT NULL;

-- AlterTable
ALTER TABLE `user` ADD COLUMN `plannedUtilizationPct` INTEGER NULL,
    ADD COLUMN `weeklyCapacityHours` DECIMAL(5, 2) NULL;

-- CreateTable
CREATE TABLE `Portfolio` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `color` VARCHAR(20) NULL,
    `ownerId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Portfolio_code_key`(`code`),
    INDEX `Portfolio_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Workflow` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` TEXT NULL,
    `appliesToTicketType` VARCHAR(60) NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Workflow_appliesToTicketType_key`(`appliesToTicketType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkflowStatus` (
    `id` VARCHAR(191) NOT NULL,
    `workflowId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `category` ENUM('TODO', 'ACTIVE', 'REVIEW', 'DONE', 'CANCELLED') NOT NULL,
    `legacyStatus` ENUM('OPEN', 'IN_PROGRESS', 'IN_REVIEW', 'RESOLVED', 'CLOSED', 'REOPENED') NOT NULL,
    `color` VARCHAR(20) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `isInitial` BOOLEAN NOT NULL DEFAULT false,
    `isFinal` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WorkflowStatus_workflowId_order_idx`(`workflowId`, `order`),
    UNIQUE INDEX `WorkflowStatus_workflowId_name_key`(`workflowId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkflowTransition` (
    `id` VARCHAR(191) NOT NULL,
    `workflowId` VARCHAR(191) NOT NULL,
    `fromStatusId` VARCHAR(191) NOT NULL,
    `toStatusId` VARCHAR(191) NOT NULL,
    `requiresApproval` BOOLEAN NOT NULL DEFAULT false,
    `requiredPermission` VARCHAR(60) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WorkflowTransition_fromStatusId_idx`(`fromStatusId`),
    UNIQUE INDEX `WorkflowTransition_workflowId_fromStatusId_toStatusId_key`(`workflowId`, `fromStatusId`, `toStatusId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomField` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(60) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `type` ENUM('TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'MULTI_SELECT', 'CHECKBOX', 'USER', 'CURRENCY', 'URL') NOT NULL,
    `description` VARCHAR(300) NULL,
    `options` JSON NULL,
    `isRequired` BOOLEAN NOT NULL DEFAULT false,
    `appliesTo` ENUM('TICKET', 'PROJECT') NOT NULL DEFAULT 'TICKET',
    `ticketTypeFilter` VARCHAR(60) NULL,
    `showOnRequestForm` BOOLEAN NOT NULL DEFAULT false,
    `order` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CustomField_key_key`(`key`),
    INDEX `CustomField_appliesTo_isActive_order_idx`(`appliesTo`, `isActive`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomFieldValue` (
    `id` VARCHAR(191) NOT NULL,
    `fieldId` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NULL,
    `projectId` VARCHAR(191) NULL,
    `value` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CustomFieldValue_ticketId_idx`(`ticketId`),
    INDEX `CustomFieldValue_projectId_idx`(`projectId`),
    UNIQUE INDEX `CustomFieldValue_fieldId_ticketId_key`(`fieldId`, `ticketId`),
    UNIQUE INDEX `CustomFieldValue_fieldId_projectId_key`(`fieldId`, `projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SavedView` (
    `id` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `scope` VARCHAR(20) NOT NULL DEFAULT 'PERSONAL',
    `viewType` VARCHAR(20) NOT NULL DEFAULT 'LIST',
    `filters` JSON NULL,
    `columns` JSON NULL,
    `sort` JSON NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SavedView_ownerId_viewType_idx`(`ownerId`, `viewType`),
    INDEX `SavedView_scope_idx`(`scope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ResourceBooking` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NULL,
    `ticketId` VARCHAR(191) NULL,
    `startDate` DATE NOT NULL,
    `endDate` DATE NOT NULL,
    `hoursPerDay` DECIMAL(4, 2) NOT NULL,
    `note` VARCHAR(300) NULL,
    `isTimeOff` BOOLEAN NOT NULL DEFAULT false,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ResourceBooking_userId_startDate_endDate_idx`(`userId`, `startDate`, `endDate`),
    INDEX `ResourceBooking_projectId_idx`(`projectId`),
    INDEX `ResourceBooking_ticketId_idx`(`ticketId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RequestForm` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(80) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `projectId` VARCHAR(191) NOT NULL,
    `moduleId` VARCHAR(191) NULL,
    `ticketType` VARCHAR(60) NOT NULL DEFAULT 'BUG',
    `defaultPriority` ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL DEFAULT 'MEDIUM',
    `defaultAssigneeId` VARCHAR(191) NULL,
    `blueprintId` VARCHAR(191) NULL,
    `isPublic` BOOLEAN NOT NULL DEFAULT false,
    `publicToken` VARCHAR(64) NULL,
    `maxSubmissionsPerHour` INTEGER NOT NULL DEFAULT 20,
    `schema` JSON NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RequestForm_slug_key`(`slug`),
    UNIQUE INDEX `RequestForm_publicToken_key`(`publicToken`),
    INDEX `RequestForm_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RequestFormSubmission` (
    `id` VARCHAR(191) NOT NULL,
    `formId` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NULL,
    `submitterName` VARCHAR(160) NULL,
    `submitterEmail` VARCHAR(255) NULL,
    `answers` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `aiConfidence` DOUBLE NULL,
    `needsReview` BOOLEAN NOT NULL DEFAULT true,
    `ipHash` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RequestFormSubmission_formId_createdAt_idx`(`formId`, `createdAt`),
    INDEX `RequestFormSubmission_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Blueprint` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `kind` ENUM('PROJECT', 'WORK_ITEM') NOT NULL DEFAULT 'PROJECT',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `payload` JSON NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Blueprint_kind_isActive_idx`(`kind`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ApprovalRequest` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `description` TEXT NULL,
    `dueAt` DATETIME(3) NULL,
    `isSequential` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `requestedById` VARCHAR(191) NOT NULL,
    `pendingTransitionStatusId` VARCHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `ApprovalRequest_ticketId_status_idx`(`ticketId`, `status`),
    INDEX `ApprovalRequest_status_dueAt_idx`(`status`, `dueAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ApprovalStep` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `approverId` VARCHAR(191) NULL,
    `guestEmail` VARCHAR(255) NULL,
    `guestToken` VARCHAR(64) NULL,
    `decision` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `comment` TEXT NULL,
    `decidedAt` DATETIME(3) NULL,
    `remindedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ApprovalStep_guestToken_key`(`guestToken`),
    INDEX `ApprovalStep_requestId_order_idx`(`requestId`, `order`),
    INDEX `ApprovalStep_approverId_decision_idx`(`approverId`, `decision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProofAnnotation` (
    `id` VARCHAR(191) NOT NULL,
    `attachmentId` VARCHAR(191) NOT NULL,
    `authorId` VARCHAR(191) NULL,
    `guestEmail` VARCHAR(255) NULL,
    `x` DOUBLE NOT NULL,
    `y` DOUBLE NOT NULL,
    `w` DOUBLE NULL,
    `h` DOUBLE NULL,
    `pageIndex` INTEGER NULL,
    `body` TEXT NOT NULL,
    `resolvedAt` DATETIME(3) NULL,
    `parentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProofAnnotation_attachmentId_createdAt_idx`(`attachmentId`, `createdAt`),
    INDEX `ProofAnnotation_parentId_idx`(`parentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Dashboard` (
    `id` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `scope` VARCHAR(20) NOT NULL DEFAULT 'PERSONAL',
    `widgets` JSON NOT NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Dashboard_ownerId_idx`(`ownerId`),
    INDEX `Dashboard_scope_idx`(`scope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReportSubscription` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `reportKey` VARCHAR(60) NULL,
    `dashboardId` VARCHAR(191) NULL,
    `filters` JSON NULL,
    `cadence` ENUM('DAILY', 'WEEKLY', 'MONTHLY') NOT NULL DEFAULT 'WEEKLY',
    `dayOfWeek` INTEGER NULL,
    `dayOfMonth` INTEGER NULL,
    `hourUtc` INTEGER NOT NULL DEFAULT 7,
    `recipients` JSON NOT NULL,
    `format` VARCHAR(10) NOT NULL DEFAULT 'HTML',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `lastSentAt` DATETIME(3) NULL,
    `lastSendError` VARCHAR(500) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReportSubscription_isActive_cadence_hourUtc_idx`(`isActive`, `cadence`, `hourUtc`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiProposal` (
    `id` VARCHAR(191) NOT NULL,
    `kind` ENUM('PLAN_BREAKDOWN', 'SCHEDULE_ADJUSTMENT', 'ASSIGNMENT_REBALANCE', 'RISK_MITIGATION', 'BLUEPRINT_SUGGESTION') NOT NULL,
    `scopeProjectId` VARCHAR(191) NULL,
    `scopeTicketId` VARCHAR(191) NULL,
    `title` VARCHAR(200) NOT NULL,
    `rationale` TEXT NULL,
    `confidence` DOUBLE NULL,
    `model` VARCHAR(80) NULL,
    `promptVersionId` VARCHAR(191) NULL,
    `status` ENUM('PENDING_REVIEW', 'PARTIALLY_APPLIED', 'APPLIED', 'REJECTED', 'EXPIRED') NOT NULL DEFAULT 'PENDING_REVIEW',
    `requestedById` VARCHAR(191) NULL,
    `reviewedById` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `appliedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiProposal_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `AiProposal_scopeProjectId_status_idx`(`scopeProjectId`, `status`),
    INDEX `AiProposal_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiProposalChange` (
    `id` VARCHAR(191) NOT NULL,
    `proposalId` VARCHAR(191) NOT NULL,
    `targetType` VARCHAR(20) NOT NULL,
    `targetId` VARCHAR(191) NULL,
    `op` ENUM('CREATE', 'UPDATE', 'LINK') NOT NULL,
    `before` JSON NULL,
    `after` JSON NOT NULL,
    `summary` VARCHAR(300) NOT NULL,
    `accepted` BOOLEAN NULL,
    `appliedAt` DATETIME(3) NULL,
    `applyError` VARCHAR(500) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiProposalChange_proposalId_order_idx`(`proposalId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProjectRiskSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `riskScore` INTEGER NOT NULL,
    `band` ENUM('GREEN', 'AMBER', 'RED') NOT NULL,
    `signals` JSON NOT NULL,
    `aiNarrative` TEXT NULL,
    `aiProposalId` VARCHAR(191) NULL,

    INDEX `ProjectRiskSnapshot_projectId_computedAt_idx`(`projectId`, `computedAt`),
    INDEX `ProjectRiskSnapshot_band_computedAt_idx`(`band`, `computedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GlobalPlanningSettings` (
    `id` VARCHAR(191) NOT NULL,
    `enablePlanning` BOOLEAN NOT NULL DEFAULT false,
    `enableResourceManagement` BOOLEAN NOT NULL DEFAULT false,
    `enableApprovals` BOOLEAN NOT NULL DEFAULT false,
    `enableProofing` BOOLEAN NOT NULL DEFAULT false,
    `enableRequestForms` BOOLEAN NOT NULL DEFAULT false,
    `enableCustomWorkflows` BOOLEAN NOT NULL DEFAULT false,
    `workingDays` JSON NOT NULL,
    `defaultWeeklyCapacityHours` DECIMAL(5, 2) NOT NULL DEFAULT 40,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Project_portfolioId_idx` ON `Project`(`portfolioId`);

-- CreateIndex
CREATE INDEX `Ticket_parentId_sortOrder_idx` ON `Ticket`(`parentId`, `sortOrder`);

-- CreateIndex
CREATE INDEX `Ticket_projectId_startDate_endDate_idx` ON `Ticket`(`projectId`, `startDate`, `endDate`);

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_portfolioId_fkey` FOREIGN KEY (`portfolioId`) REFERENCES `Portfolio`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Ticket` ADD CONSTRAINT `Ticket_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `Ticket`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Ticket` ADD CONSTRAINT `Ticket_workflowStatusId_fkey` FOREIGN KEY (`workflowStatusId`) REFERENCES `WorkflowStatus`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Portfolio` ADD CONSTRAINT `Portfolio_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowStatus` ADD CONSTRAINT `WorkflowStatus_workflowId_fkey` FOREIGN KEY (`workflowId`) REFERENCES `Workflow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowTransition` ADD CONSTRAINT `WorkflowTransition_workflowId_fkey` FOREIGN KEY (`workflowId`) REFERENCES `Workflow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowTransition` ADD CONSTRAINT `WorkflowTransition_fromStatusId_fkey` FOREIGN KEY (`fromStatusId`) REFERENCES `WorkflowStatus`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowTransition` ADD CONSTRAINT `WorkflowTransition_toStatusId_fkey` FOREIGN KEY (`toStatusId`) REFERENCES `WorkflowStatus`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomFieldValue` ADD CONSTRAINT `CustomFieldValue_fieldId_fkey` FOREIGN KEY (`fieldId`) REFERENCES `CustomField`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomFieldValue` ADD CONSTRAINT `CustomFieldValue_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomFieldValue` ADD CONSTRAINT `CustomFieldValue_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SavedView` ADD CONSTRAINT `SavedView_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResourceBooking` ADD CONSTRAINT `ResourceBooking_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResourceBooking` ADD CONSTRAINT `ResourceBooking_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResourceBooking` ADD CONSTRAINT `ResourceBooking_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResourceBooking` ADD CONSTRAINT `ResourceBooking_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RequestForm` ADD CONSTRAINT `RequestForm_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RequestForm` ADD CONSTRAINT `RequestForm_blueprintId_fkey` FOREIGN KEY (`blueprintId`) REFERENCES `Blueprint`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RequestForm` ADD CONSTRAINT `RequestForm_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RequestFormSubmission` ADD CONSTRAINT `RequestFormSubmission_formId_fkey` FOREIGN KEY (`formId`) REFERENCES `RequestForm`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RequestFormSubmission` ADD CONSTRAINT `RequestFormSubmission_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Blueprint` ADD CONSTRAINT `Blueprint_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ApprovalRequest` ADD CONSTRAINT `ApprovalRequest_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ApprovalRequest` ADD CONSTRAINT `ApprovalRequest_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ApprovalStep` ADD CONSTRAINT `ApprovalStep_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `ApprovalRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ApprovalStep` ADD CONSTRAINT `ApprovalStep_approverId_fkey` FOREIGN KEY (`approverId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProofAnnotation` ADD CONSTRAINT `ProofAnnotation_attachmentId_fkey` FOREIGN KEY (`attachmentId`) REFERENCES `TicketAttachment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProofAnnotation` ADD CONSTRAINT `ProofAnnotation_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProofAnnotation` ADD CONSTRAINT `ProofAnnotation_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `ProofAnnotation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Dashboard` ADD CONSTRAINT `Dashboard_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReportSubscription` ADD CONSTRAINT `ReportSubscription_dashboardId_fkey` FOREIGN KEY (`dashboardId`) REFERENCES `Dashboard`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReportSubscription` ADD CONSTRAINT `ReportSubscription_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiProposal` ADD CONSTRAINT `AiProposal_scopeProjectId_fkey` FOREIGN KEY (`scopeProjectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiProposal` ADD CONSTRAINT `AiProposal_scopeTicketId_fkey` FOREIGN KEY (`scopeTicketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiProposal` ADD CONSTRAINT `AiProposal_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiProposal` ADD CONSTRAINT `AiProposal_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiProposalChange` ADD CONSTRAINT `AiProposalChange_proposalId_fkey` FOREIGN KEY (`proposalId`) REFERENCES `AiProposal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectRiskSnapshot` ADD CONSTRAINT `ProjectRiskSnapshot_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectRiskSnapshot` ADD CONSTRAINT `ProjectRiskSnapshot_aiProposalId_fkey` FOREIGN KEY (`aiProposalId`) REFERENCES `AiProposal`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ===================================================================================
-- DATA BACKFILL — the part that makes V6 upgrade-safe on an EXISTING install.
--
-- WHY THIS IS IN THE MIGRATION AND NOT IN prisma/seed.ts:
--   `npm run seed` is a ONE-TIME BOOTSTRAP. docker-compose.yml runs `prisma migrate deploy`
--   on every API boot and update.sh/update.ps1 then run `npm run migrate:tenants`, but NEITHER
--   ever runs the seed again -- deliberately, because seed.ts does
--   `rolePermission.deleteMany` + `createMany` and re-running it would wipe any hand-customised
--   grants. So a new permission key added to @timesheet/shared reaches a FRESH install through
--   seed.ts and reaches an EXISTING install only through SQL like this. Both are updated in the
--   same commit and must agree.
--
-- WHY EVERY STATEMENT IS GUARDED:
--   `prisma migrate deploy` runs a migration once, but this file also has to survive a
--   re-run of an interrupted deploy and a tenant DB that was provisioned mid-upgrade. Every
--   INSERT below is `SELECT ... WHERE NOT EXISTS`, so running it twice changes nothing.
--
-- WHAT IT DOES NOT DO: it never UPDATEs or DELETEs an existing row. The only writes are
-- inserts of rows that did not exist. An org upgrading to V6 keeps every permission grant,
-- every ticket and every setting exactly as it was.
-- ===================================================================================

-- -----------------------------------------------------------------------------------
-- 1. New permission keys (mirrors `permissions` in packages/shared/src/index.ts).
-- -----------------------------------------------------------------------------------
INSERT INTO `Permission` (`id`, `key`, `description`)
SELECT UUID(), 'portfolios:manage', 'portfolios:manage'
WHERE NOT EXISTS (SELECT 1 FROM `Permission` WHERE `key` = 'portfolios:manage');

INSERT INTO `Permission` (`id`, `key`, `description`)
SELECT UUID(), 'plan:write', 'plan:write'
WHERE NOT EXISTS (SELECT 1 FROM `Permission` WHERE `key` = 'plan:write');

INSERT INTO `Permission` (`id`, `key`, `description`)
SELECT UUID(), 'resources:manage', 'resources:manage'
WHERE NOT EXISTS (SELECT 1 FROM `Permission` WHERE `key` = 'resources:manage');

INSERT INTO `Permission` (`id`, `key`, `description`)
SELECT UUID(), 'approvals:manage', 'approvals:manage'
WHERE NOT EXISTS (SELECT 1 FROM `Permission` WHERE `key` = 'approvals:manage');

INSERT INTO `Permission` (`id`, `key`, `description`)
SELECT UUID(), 'dashboards:share', 'dashboards:share'
WHERE NOT EXISTS (SELECT 1 FROM `Permission` WHERE `key` = 'dashboards:share');

-- -----------------------------------------------------------------------------------
-- 2. Grants. Matches the `grants` map in prisma/seed.ts exactly.
--    SUPER_ADMIN and ADMIN get everything (seed.ts gives them `Object.values(permissions)`).
--    MANAGER and TEAM_LEAD get the two rights that are part of running delivery -- editing the
--    plan and routing approvals -- but not portfolio/tier administration or dashboard
--    publishing, matching how they already get TIMESHEETS_APPROVE but not USERS_MANAGE.
--    EMPLOYEE gets none: an employee reads the plan (no permission needed) but does not edit it.
-- -----------------------------------------------------------------------------------
INSERT INTO `RolePermission` (`roleId`, `permissionId`)
SELECT r.`id`, p.`id`
FROM `Role` r
CROSS JOIN `Permission` p
WHERE r.`name` IN ('SUPER_ADMIN', 'ADMIN')
  AND p.`key` IN ('portfolios:manage', 'plan:write', 'resources:manage', 'approvals:manage', 'dashboards:share')
  AND NOT EXISTS (
    SELECT 1 FROM `RolePermission` rp WHERE rp.`roleId` = r.`id` AND rp.`permissionId` = p.`id`
  );

INSERT INTO `RolePermission` (`roleId`, `permissionId`)
SELECT r.`id`, p.`id`
FROM `Role` r
CROSS JOIN `Permission` p
WHERE r.`name` IN ('MANAGER', 'TEAM_LEAD')
  AND p.`key` IN ('plan:write', 'approvals:manage')
  AND NOT EXISTS (
    SELECT 1 FROM `RolePermission` rp WHERE rp.`roleId` = r.`id` AND rp.`permissionId` = p.`id`
  );

-- -----------------------------------------------------------------------------------
-- 3. The system "Default" workflow.
--
-- This reproduces V5's hard-coded six statuses and `ticketStatusTransitions` AS ROWS. It is
-- what lets custom workflows exist without changing behaviour for anyone who never opens the
-- workflow editor: every ticket keeps writing `Ticket.status` from `legacyStatus`, and the
-- transition rows below are byte-for-byte the same graph packages/shared already enforces.
--
-- Deterministic ids (not UUID()) so the rows are addressable from seed.ts, from tests, and from
-- a later migration, and so re-running this file is trivially a no-op.
-- -----------------------------------------------------------------------------------
INSERT INTO `Workflow` (`id`, `name`, `description`, `appliesToTicketType`, `isDefault`, `isActive`, `isSystem`, `createdAt`, `updatedAt`)
SELECT 'wf-default', 'Default', 'The built-in ticket workflow. Reproduces the six statuses and transitions this app has always enforced.', NULL, TRUE, TRUE, TRUE, NOW(3), NOW(3)
WHERE NOT EXISTS (SELECT 1 FROM `Workflow` WHERE `id` = 'wf-default');

INSERT INTO `WorkflowStatus` (`id`, `workflowId`, `name`, `category`, `legacyStatus`, `color`, `order`, `isInitial`, `isFinal`, `createdAt`, `updatedAt`)
SELECT * FROM (
  SELECT 'wfs-open'        AS id, 'wf-default' AS workflowId, 'Open'        AS name, 'TODO'   AS category, 'OPEN'        AS legacyStatus, NULL AS color, 0 AS `order`, TRUE  AS isInitial, FALSE AS isFinal, NOW(3) AS createdAt, NOW(3) AS updatedAt
  UNION ALL SELECT 'wfs-in-progress', 'wf-default', 'In progress', 'ACTIVE', 'IN_PROGRESS', NULL, 1, FALSE, FALSE, NOW(3), NOW(3)
  UNION ALL SELECT 'wfs-in-review',   'wf-default', 'In review',   'REVIEW', 'IN_REVIEW',   NULL, 2, FALSE, FALSE, NOW(3), NOW(3)
  UNION ALL SELECT 'wfs-resolved',    'wf-default', 'Resolved',    'DONE',   'RESOLVED',    NULL, 3, FALSE, FALSE, NOW(3), NOW(3)
  -- isFinal is FALSE on every built-in status, including Closed: `ticketStatusTransitions` in
  -- packages/shared allows CLOSED -> REOPENED, so nothing in the default workflow is actually
  -- terminal. Marking Closed as final here would have been the one place this seed disagreed
  -- with the map it is supposed to reproduce. prisma/seed.ts derives the same value as
  -- `transitions.length === 0`, so the two can never drift.
  UNION ALL SELECT 'wfs-closed',      'wf-default', 'Closed',      'DONE',   'CLOSED',      NULL, 4, FALSE, FALSE, NOW(3), NOW(3)
  UNION ALL SELECT 'wfs-reopened',    'wf-default', 'Reopened',    'TODO',   'REOPENED',    NULL, 5, FALSE, FALSE, NOW(3), NOW(3)
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM `WorkflowStatus` WHERE `workflowId` = 'wf-default');

-- The transition graph, copied from `ticketStatusTransitions` in packages/shared/src/index.ts.
-- If that map ever changes, this seed and seed.ts must change with it -- they are three
-- statements of one rule and the API validates against the rows, so drift would show up as a
-- board that offers a move the server refuses.
INSERT INTO `WorkflowTransition` (`id`, `workflowId`, `fromStatusId`, `toStatusId`, `requiresApproval`, `requiredPermission`, `createdAt`)
SELECT * FROM (
  SELECT 'wft-open-inprog'      AS id, 'wf-default' AS workflowId, 'wfs-open'        AS fromStatusId, 'wfs-in-progress' AS toStatusId, FALSE AS requiresApproval, NULL AS requiredPermission, NOW(3) AS createdAt
  UNION ALL SELECT 'wft-inprog-inrev',  'wf-default', 'wfs-in-progress', 'wfs-in-review',   FALSE, NULL, NOW(3)
  UNION ALL SELECT 'wft-inprog-open',   'wf-default', 'wfs-in-progress', 'wfs-open',        FALSE, NULL, NOW(3)
  UNION ALL SELECT 'wft-inrev-res',     'wf-default', 'wfs-in-review',   'wfs-resolved',    FALSE, NULL, NOW(3)
  UNION ALL SELECT 'wft-inrev-inprog',  'wf-default', 'wfs-in-review',   'wfs-in-progress', FALSE, NULL, NOW(3)
  UNION ALL SELECT 'wft-res-closed',    'wf-default', 'wfs-resolved',    'wfs-closed',      FALSE, NULL, NOW(3)
  UNION ALL SELECT 'wft-res-reopen',    'wf-default', 'wfs-resolved',    'wfs-reopened',    FALSE, NULL, NOW(3)
  UNION ALL SELECT 'wft-closed-reopen', 'wf-default', 'wfs-closed',      'wfs-reopened',    FALSE, NULL, NOW(3)
  UNION ALL SELECT 'wft-reopen-inprog', 'wf-default', 'wfs-reopened',    'wfs-in-progress', FALSE, NULL, NOW(3)
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM `WorkflowTransition` WHERE `workflowId` = 'wf-default');

-- -----------------------------------------------------------------------------------
-- 4. Backfill `Ticket.workflowStatusId` from the status each ticket is already in.
--
-- Every existing ticket is placed on the Default workflow at the status matching its current
-- `Ticket.status`. Nothing about the ticket changes -- `status` is untouched, this only fills in
-- the new pointer so the planning views and the legacy views agree from the first request after
-- the upgrade rather than only after the ticket is next edited.
-- -----------------------------------------------------------------------------------
UPDATE `Ticket` t
JOIN `WorkflowStatus` ws ON ws.`workflowId` = 'wf-default' AND ws.`legacyStatus` = t.`status`
SET t.`workflowStatusId` = ws.`id`
WHERE t.`workflowStatusId` IS NULL;

-- -----------------------------------------------------------------------------------
-- 5. The planning settings singleton, with every capability OFF.
--
-- Created here rather than lazily on first read so that "did this install get V6?" is one row
-- to look at, and so the settings API never has to branch on a missing row. Everything false
-- means the upgrade is invisible until an admin opts in -- the same posture aiEnabled,
-- enableAttestations and the face-verification switch already take.
-- -----------------------------------------------------------------------------------
INSERT INTO `GlobalPlanningSettings`
  (`id`, `enablePlanning`, `enableResourceManagement`, `enableApprovals`, `enableProofing`,
   `enableRequestForms`, `enableCustomWorkflows`, `workingDays`, `defaultWeeklyCapacityHours`,
   `updatedAt`, `updatedById`)
SELECT 'global', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, '[1,2,3,4,5]', 40.00, NOW(3), NULL
WHERE NOT EXISTS (SELECT 1 FROM `GlobalPlanningSettings` WHERE `id` = 'global');
