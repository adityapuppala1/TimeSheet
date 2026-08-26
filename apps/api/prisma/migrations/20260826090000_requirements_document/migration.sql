-- AI Requirements Studio: an AI-guided interview that produces a structured PRD/BRD, stored on one
-- row (interview transcript + generated sections, no separate message table — an interview is
-- naturally bounded, ~15-30 turns). Optionally attached to a Project; nullable because a document
-- can exist before any project does ("idea first, project second").
--
-- CREATE TABLE IF NOT EXISTS + guarded ALTERs/FKs throughout, so a re-run against a tenant database
-- already carrying this migration is a no-op rather than a failure that strands it half-applied.
CREATE TABLE IF NOT EXISTS `RequirementsDocument` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `docType` ENUM('PRD', 'BRD', 'BOTH') NOT NULL DEFAULT 'PRD',
  `status` ENUM('DRAFTING', 'READY', 'ARCHIVED') NOT NULL DEFAULT 'DRAFTING',
  `projectId` VARCHAR(191) NULL,
  `sections` JSON NULL,
  `interviewTranscript` JSON NOT NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `RequirementsDocument_projectId_idx`(`projectId`),
  INDEX `RequirementsDocument_status_createdAt_idx`(`status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @fk1 := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RequirementsDocument' AND CONSTRAINT_NAME = 'RequirementsDocument_projectId_fkey'
);
SET @sql := IF(@fk1 = 0,
  'ALTER TABLE `RequirementsDocument` ADD CONSTRAINT `RequirementsDocument_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk2 := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RequirementsDocument' AND CONSTRAINT_NAME = 'RequirementsDocument_createdById_fkey'
);
SET @sql := IF(@fk2 = 0,
  'ALTER TABLE `RequirementsDocument` ADD CONSTRAINT `RequirementsDocument_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- The Requirements Studio toggle (guards ai.service.ts#conductRequirementsInterviewTurn and
-- #generateRequirementsDocument).
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'GlobalAISettings' AND COLUMN_NAME = 'requirementsStudioEnabled'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `GlobalAISettings` ADD COLUMN `requirementsStudioEnabled` BOOLEAN NOT NULL DEFAULT false',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Widening AiProposal.kind. Written as the full MODIFY rather than an append, because MySQL has no
-- "add enum value" and the whole set has to be restated.
SET @kind := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiProposal'
    AND COLUMN_NAME = 'kind' AND COLUMN_TYPE LIKE '%REQUIREMENTS_DOC%'
);
SET @sql := IF(@kind = 0,
  'ALTER TABLE `AiProposal` MODIFY `kind` ENUM(''PLAN_BREAKDOWN'', ''SCHEDULE_ADJUSTMENT'', ''ASSIGNMENT_REBALANCE'', ''RISK_MITIGATION'', ''BLUEPRINT_SUGGESTION'', ''CHANGE_DRAFT'', ''REQUIREMENTS_DOC'') NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
