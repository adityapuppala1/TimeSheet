-- CreateTable
CREATE TABLE `WebhookDelivery` (
    `id` VARCHAR(191) NOT NULL,
    `webhookId` VARCHAR(191) NOT NULL,
    `event` VARCHAR(60) NOT NULL,
    `payload` JSON NOT NULL,
    `attempt` INTEGER NOT NULL DEFAULT 1,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `lastError` VARCHAR(500) NULL,
    `nextAttemptAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WebhookDelivery_webhookId_idx`(`webhookId`),
    INDEX `WebhookDelivery_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `WebhookDelivery` ADD CONSTRAINT `WebhookDelivery_webhookId_fkey` FOREIGN KEY (`webhookId`) REFERENCES `OutboundWebhook`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
