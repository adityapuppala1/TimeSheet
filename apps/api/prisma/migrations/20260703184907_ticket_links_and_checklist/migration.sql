-- CreateTable
CREATE TABLE `TicketLink` (
    `id` VARCHAR(191) NOT NULL,
    `sourceTicketId` VARCHAR(191) NOT NULL,
    `targetTicketId` VARCHAR(191) NOT NULL,
    `type` ENUM('BLOCKS', 'DUPLICATE', 'RELATES') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TicketLink_targetTicketId_idx`(`targetTicketId`),
    UNIQUE INDEX `TicketLink_sourceTicketId_targetTicketId_type_key`(`sourceTicketId`, `targetTicketId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TicketChecklistItem` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `done` BOOLEAN NOT NULL DEFAULT false,
    `position` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TicketChecklistItem_ticketId_position_idx`(`ticketId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TicketLink` ADD CONSTRAINT `TicketLink_sourceTicketId_fkey` FOREIGN KEY (`sourceTicketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketLink` ADD CONSTRAINT `TicketLink_targetTicketId_fkey` FOREIGN KEY (`targetTicketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketChecklistItem` ADD CONSTRAINT `TicketChecklistItem_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
