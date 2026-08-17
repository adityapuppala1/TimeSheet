-- V8 phase 6: flow dispatch. See docs/AGENTIC_UX_PLAN.md §3.2.
--
-- Two new tables and one nullable column, no DML, nothing existing rewritten. Pure ASCII by design:
-- no emoji or other multibyte literal appears in this DDL, after phase 3's `DEFAULT '<emoji>'` arrived
-- in the database as `'?'` and left `prisma migrate diff` permanently dirty.
--
-- The diff emitted `agentrun` in lower case (introspection off a case-insensitive Windows MariaDB);
-- corrected to `AgentRun` below. On a case-sensitive Linux MySQL the lower-case form does not exist
-- and the ALTER dies mid-deploy -- the 2.4.0 lesson, checked every time since.
--
-- `AgentRun.flowId` is the join that separates a flow's AI spend from the same capability invoked by
-- hand. SET NULL rather than CASCADE on purpose: retiring a flow must not erase the record of what it
-- spent.

-- AlterTable
ALTER TABLE `AgentRun` ADD COLUMN `flowId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `AutomationFlowRun` (
    `id` VARCHAR(191) NOT NULL,
    `flowId` VARCHAR(191) NOT NULL,
    `triggerKey` VARCHAR(190) NOT NULL,
    `trigger` VARCHAR(80) NOT NULL,
    `subjectType` VARCHAR(30) NULL,
    `subjectId` VARCHAR(64) NULL,
    `subjectLabel` VARCHAR(200) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
    `awaitingOrder` INTEGER NULL,
    `awaitingUserId` VARCHAR(191) NULL,
    `summary` VARCHAR(500) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    UNIQUE INDEX `AutomationFlowRun_triggerKey_key`(`triggerKey`),
    INDEX `AutomationFlowRun_flowId_startedAt_idx`(`flowId`, `startedAt`),
    INDEX `AutomationFlowRun_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AutomationFlowRunStep` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `kind` ENUM('ACTION', 'CAPABILITY', 'HUMAN_GATE', 'BRANCH') NOT NULL,
    `outcome` VARCHAR(20) NOT NULL,
    `detail` VARCHAR(500) NOT NULL,
    `agentRunId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AutomationFlowRunStep_runId_order_idx`(`runId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentRun` ADD CONSTRAINT `AgentRun_flowId_fkey` FOREIGN KEY (`flowId`) REFERENCES `AutomationFlow`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationFlowRun` ADD CONSTRAINT `AutomationFlowRun_flowId_fkey` FOREIGN KEY (`flowId`) REFERENCES `AutomationFlow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationFlowRun` ADD CONSTRAINT `AutomationFlowRun_awaitingUserId_fkey` FOREIGN KEY (`awaitingUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationFlowRunStep` ADD CONSTRAINT `AutomationFlowRunStep_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `AutomationFlowRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
