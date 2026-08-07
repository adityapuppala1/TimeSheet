-- MCP server (Model Context Protocol) — see prisma/schema.prisma's GlobalMcpSettings and
-- McpCredential doc comments, and controllers/mcp.controller.ts.
--
-- NOTE FOR EXISTING WORKSPACES: no backfill row is inserted on purpose. The settings singleton is
-- upserted on first read (services/mcp.service.ts#getGlobalMcpSettings, the same pattern as every
-- other Global* settings table), and every column here defaults to the closed position — so an
-- upgraded workspace has no live MCP endpoint until its super admin turns one on.

-- CreateTable
CREATE TABLE `GlobalMcpSettings` (
    `id` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `allowWrites` BOOLEAN NOT NULL DEFAULT false,
    `toolOverrides` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `McpCredential` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `tokenPrefix` VARCHAR(16) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,

    UNIQUE INDEX `McpCredential_tokenHash_key`(`tokenHash`),
    INDEX `McpCredential_tokenHash_idx`(`tokenHash`),
    INDEX `McpCredential_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- CASCADE, not SET NULL: a credential acts AS its user, so it must die with the account rather
-- than survive as an unattributable key holding that person's permissions.
ALTER TABLE `McpCredential` ADD CONSTRAINT `McpCredential_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `McpCredential` ADD CONSTRAINT `McpCredential_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
