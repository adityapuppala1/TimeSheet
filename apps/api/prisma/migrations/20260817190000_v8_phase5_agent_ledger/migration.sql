-- V8 phase 5: the agent ledger. See docs/AGENTIC_WORK_MANAGEMENT.md §4 — the differentiator.
--
-- One new table, no DML, nothing existing touched. Pure ASCII by design: no emoji or other multibyte
-- literal appears in this DDL, after phase 3's `DEFAULT '🤖'` arrived in the database as `'?'` and left
-- `prisma migrate diff` permanently dirty.
--
-- The diff that produced this emitted canonical table casing unaided (unlike the previous three), so
-- there was nothing to correct — checked rather than assumed.

-- CreateTable
CREATE TABLE `AgentWorkEntry` (
    `id` VARCHAR(191) NOT NULL,
    `agentRunId` VARCHAR(64) NOT NULL,
    `capability` VARCHAR(60) NOT NULL,
    `agentUserId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NULL,
    `durationSeconds` INTEGER NOT NULL,
    `costUsd` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `displacedMinutes` INTEGER NULL,
    `displacedBasis` VARCHAR(200) NULL,
    `billable` BOOLEAN NOT NULL DEFAULT false,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AgentWorkEntry_agentRunId_key`(`agentRunId`),
    INDEX `AgentWorkEntry_occurredAt_idx`(`occurredAt`),
    INDEX `AgentWorkEntry_agentUserId_occurredAt_idx`(`agentUserId`, `occurredAt`),
    INDEX `AgentWorkEntry_projectId_occurredAt_idx`(`projectId`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentWorkEntry` ADD CONSTRAINT `AgentWorkEntry_agentUserId_fkey` FOREIGN KEY (`agentUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentWorkEntry` ADD CONSTRAINT `AgentWorkEntry_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

