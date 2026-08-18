-- V8 phase 3: the agent roster. See docs/AGENTIC_WORK_MANAGEMENT.md §5 phase 3.
--
-- PORTABILITY NOTE (the 2.4.0 lesson, docs/DATABASE.md): `prisma migrate diff` introspected off
-- this Windows MariaDB emitted `user` in lower case, which works here and dies on case-sensitive
-- Linux MySQL. Corrected to canonical model casing by hand.
--
-- Additive: one defaulted column on `User` and one new table. No DML, so no DDL guard is required
-- (the portability test demands the information_schema + PREPARE pattern only where fallible data
-- changes follow the schema change).
--
-- `isAgent` defaults FALSE, which is the safe direction for both invariants it carries: every
-- existing row keeps its seat and keeps its ability to sign in. A default of TRUE would have
-- locked out an entire workspace on upgrade.

-- AlterTable
ALTER TABLE `User` ADD COLUMN `isAgent` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `AgentProfile` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `emoji` VARCHAR(16) NOT NULL DEFAULT '🤖',
    `description` TEXT NULL,
    `identityUserId` VARCHAR(191) NOT NULL,
    `capabilities` JSON NOT NULL,
    `scopeProjectIds` JSON NOT NULL,
    `maxCostUsdPerDay` DECIMAL(10, 4) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `templateKey` VARCHAR(60) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `AgentProfile_identityUserId_key`(`identityUserId`),
    INDEX `AgentProfile_enabled_deletedAt_idx`(`enabled`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentProfile` ADD CONSTRAINT `AgentProfile_identityUserId_fkey` FOREIGN KEY (`identityUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentProfile` ADD CONSTRAINT `AgentProfile_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
