-- At-most-once semantics for MCP write tools.
--
-- Retrying is what agents do — a timeout, a dropped connection, a model that decides its first
-- attempt failed — and `create_ticket` called twice created two tickets. The MCP annotations
-- already advertised `idempotentHint` for reads, which was honest, and nothing for writes, which
-- was also honest and worse.
--
-- The unique constraint is the mechanism, not decoration: the key is CLAIMED before the handler
-- runs, so two calls arriving together are decided by the database rather than both creating a
-- ticket. Checking first and recording afterwards would leave exactly the window that matters open.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none. `idempotencyKey` is optional on every tool, so a client
-- that does not send one behaves precisely as it did before.

-- CreateTable
CREATE TABLE `McpToolInvocation` (
    `id` VARCHAR(191) NOT NULL,
    `callerId` VARCHAR(64) NOT NULL,
    `toolName` VARCHAR(60) NOT NULL,
    `idempotencyKey` VARCHAR(120) NOT NULL,
    `resultJson` JSON NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `McpToolInvocation_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `McpToolInvocation_callerId_toolName_idempotencyKey_key`(`callerId`, `toolName`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
