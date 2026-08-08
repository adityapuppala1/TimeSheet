-- Agent runs: the envelope a capability executes inside when nobody is watching.
--
-- `triggerKey` is UNIQUE and that is the mechanism, not decoration. There is no separate queue
-- table — this row IS the queue entry — so a doubled cron tick, a retried webhook, or a restart
-- mid-tick all collapse to one run because the database refuses the second insert. An in-memory
-- guard could not survive the restart, which is precisely the case that matters.
--
-- `level` is copied at queue time rather than looked up at execution: a run must be judged by what
-- it was allowed when it started, and a run already in flight must not be ESCALATED by somebody
-- editing the autonomy policy underneath it.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none. Nothing queues a run until a capability is raised above
-- SUGGEST, which needs the autonomy master latch, which defaults off. The worker ticks every
-- minute, finds nothing, and does nothing.

-- CreateTable
CREATE TABLE `AgentRun` (
    `id` VARCHAR(191) NOT NULL,
    `capability` VARCHAR(60) NOT NULL,
    `trigger` VARCHAR(80) NOT NULL,
    `triggerKey` VARCHAR(190) NOT NULL,
    `onBehalfOfId` VARCHAR(191) NOT NULL,
    `level` ENUM('SUGGEST', 'AUTO_APPLY', 'AUTONOMOUS') NOT NULL,
    `taintedAt` DATETIME(3) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    `abortRequestedAt` DATETIME(3) NULL,
    `abortedById` VARCHAR(191) NULL,
    `stepCount` INTEGER NOT NULL DEFAULT 0,
    `maxSteps` INTEGER NOT NULL,
    `costUsd` DECIMAL(10, 4) NULL,
    `maxCostUsd` DECIMAL(10, 4) NULL,
    `scopeProjectId` VARCHAR(191) NULL,
    `goal` TEXT NULL,
    `proposalId` VARCHAR(64) NULL,
    `error` VARCHAR(500) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AgentRun_triggerKey_key`(`triggerKey`),
    INDEX `AgentRun_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `AgentRun_capability_createdAt_idx`(`capability`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentRunStep` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `index` INTEGER NOT NULL,
    `kind` VARCHAR(20) NOT NULL,
    `toolName` VARCHAR(60) NULL,
    `argsJson` JSON NULL,
    `resultText` TEXT NULL,
    `aiInteractionId` VARCHAR(64) NULL,
    `error` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AgentRunStep_runId_index_idx`(`runId`, `index`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentRun` ADD CONSTRAINT `AgentRun_onBehalfOfId_fkey` FOREIGN KEY (`onBehalfOfId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentRunStep` ADD CONSTRAINT `AgentRunStep_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `AgentRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
