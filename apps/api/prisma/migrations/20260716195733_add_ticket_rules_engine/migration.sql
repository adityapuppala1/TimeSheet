-- CreateTable
CREATE TABLE `TicketRule` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `order` INTEGER NOT NULL DEFAULT 0,
    `conditionProjectId` VARCHAR(191) NULL,
    `conditionPriority` ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NULL,
    `conditionSource` ENUM('MANUAL', 'EMAIL', 'API', 'CHAT') NULL,
    `conditionSenderDomain` VARCHAR(255) NULL,
    `actionAssigneeId` VARCHAR(191) NULL,
    `actionLabelId` VARCHAR(191) NULL,
    `actionNotifyUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TicketRule_isActive_order_idx`(`isActive`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TicketRule` ADD CONSTRAINT `TicketRule_conditionProjectId_fkey` FOREIGN KEY (`conditionProjectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketRule` ADD CONSTRAINT `TicketRule_actionAssigneeId_fkey` FOREIGN KEY (`actionAssigneeId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketRule` ADD CONSTRAINT `TicketRule_actionLabelId_fkey` FOREIGN KEY (`actionLabelId`) REFERENCES `Label`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketRule` ADD CONSTRAINT `TicketRule_actionNotifyUserId_fkey` FOREIGN KEY (`actionNotifyUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
