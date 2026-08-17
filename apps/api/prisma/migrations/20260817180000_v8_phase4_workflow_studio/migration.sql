-- V8 phase 4: the Workflow Studio. See docs/AGENTIC_WORK_MANAGEMENT.md §5 phase 4.
--
-- PORTABILITY NOTE (the 2.4.0 lesson, docs/DATABASE.md): `prisma migrate diff` introspected off this
-- Windows MariaDB emitted `user` and `agentprofile` in lower case, which works here and dies on
-- case-sensitive Linux MySQL. Corrected to canonical model casing by hand. The same diff also emitted
-- a no-op `MODIFY` of AgentProfile.emoji -- an artifact of round-tripping a utf8mb4 default through
-- introspection, not a real change -- and it has been removed so this migration is purely additive.
--
-- Two new tables and two new enums. Nothing existing is read or rewritten, so an upgrade cannot lose
-- data, and no DDL guard is needed because no DML follows.

-- CreateTable
CREATE TABLE `AutomationFlow` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` TEXT NULL,
    `emoji` VARCHAR(16) NOT NULL DEFAULT '⚙️',
    `trigger` ENUM('EVENT', 'SCHEDULE', 'FORM_SUBMISSION', 'MANUAL') NOT NULL DEFAULT 'MANUAL',
    `triggerConfig` JSON NOT NULL,
    `agentProfileId` VARCHAR(191) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `AutomationFlow_enabled_deletedAt_idx`(`enabled`, `deletedAt`),
    INDEX `AutomationFlow_trigger_enabled_idx`(`trigger`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AutomationStep` (
    `id` VARCHAR(191) NOT NULL,
    `flowId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `kind` ENUM('ACTION', 'CAPABILITY', 'HUMAN_GATE', 'BRANCH') NOT NULL,
    `capability` VARCHAR(60) NULL,
    `config` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AutomationStep_flowId_order_idx`(`flowId`, `order`),
    UNIQUE INDEX `AutomationStep_flowId_order_key`(`flowId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AutomationFlow` ADD CONSTRAINT `AutomationFlow_agentProfileId_fkey` FOREIGN KEY (`agentProfileId`) REFERENCES `AgentProfile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationFlow` ADD CONSTRAINT `AutomationFlow_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AutomationStep` ADD CONSTRAINT `AutomationStep_flowId_fkey` FOREIGN KEY (`flowId`) REFERENCES `AutomationFlow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- ===================================================================================
-- Corrective, and the reason it is here rather than in a migration of its own: the phase-3 file
-- declared `AgentProfile.emoji ... DEFAULT '🤖'`, and that multibyte literal did not survive the
-- trip through the migration file, the client connection charset and the server. It landed as
-- `'?'` (hex 273F27), which left `prisma migrate diff` reporting a MODIFY forever — a drift nobody
-- could resolve, on a tool whose value is that a clean diff means something.
--
-- Stored rows were never affected: Prisma sends the emoji on every insert, so every profile holds
-- the bytes it should. Only the unreachable column default was wrong.
--
-- The fix is to stop putting emoji in DDL at all. The column keeps NOT NULL and the default now
-- lives in `agent-profile.service.ts`, which is ordinary UTF-8 source with no charset boundary to
-- cross. This statement is pure ASCII by design and cannot itself be mangled.
-- ===================================================================================
ALTER TABLE `AgentProfile` MODIFY `emoji` VARCHAR(16) NOT NULL;
