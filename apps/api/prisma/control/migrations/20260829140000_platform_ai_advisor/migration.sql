-- 4.0.0: the platform operator's own AI configuration, and every advisory it has produced.
--
-- WHY THE OPERATOR'S KEY IS SEPARATE FROM EVERY TENANT'S: a workspace's AI settings are its own —
-- its key, its budget, its data-residency choice. Borrowing one to reason about the fleet would
-- spend a customer's money on somebody else's problem and route one tenant's operational detail
-- through another tenant's provider. This is the platform's own key, for the platform's own screens,
-- and it is OFF until an operator sets it up. There is no fallback to a tenant's settings.
--
-- WHY EVERY ADVISORY IS KEPT, including the dismissed ones: the value of an advisor is not the
-- sentence it produced today, it is whether its sentences were right. That is only answerable if
-- the wrong ones are still sitting next to the right ones. A dismissal with a note is the most
-- useful row in this table.
--
-- NOTHING IN HERE EXECUTES ANYTHING. A finding names an action from a closed allowlist in code;
-- running it is a separate, human-initiated call to the same guarded endpoint the operator could
-- have used by hand. The model proposes, a person disposes — and `status`/`decidedBy` record which.
--
-- PORTABILITY NOTE: canonical casing by hand — `prisma migrate diff` introspected off Windows
-- MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- CreateTable
CREATE TABLE `PlatformAiSettings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'global',
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `provider` VARCHAR(32) NOT NULL DEFAULT 'ANTHROPIC',
    `baseUrl` VARCHAR(500) NULL,
    `model` VARCHAR(120) NOT NULL DEFAULT 'claude-sonnet-5',
    `encryptedApiKey` TEXT NULL,
    `dailyCallLimit` INTEGER NOT NULL DEFAULT 50,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedBy` VARCHAR(255) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformAiAdvice` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actorLabel` VARCHAR(255) NOT NULL,
    `model` VARCHAR(120) NOT NULL,
    `summary` TEXT NOT NULL,
    `findings` JSON NULL,
    `factsDigest` JSON NULL,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    `decidedAt` DATETIME(3) NULL,
    `decidedBy` VARCHAR(255) NULL,
    `decisionNote` TEXT NULL,

    INDEX `PlatformAiAdvice_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `PlatformAiAdvice_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PlatformAiAdvice` ADD CONSTRAINT `PlatformAiAdvice_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
