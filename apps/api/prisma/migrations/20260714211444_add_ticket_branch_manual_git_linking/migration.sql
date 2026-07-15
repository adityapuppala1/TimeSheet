-- CreateTable
CREATE TABLE `TicketBranch` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `repository` VARCHAR(255) NOT NULL,
    `branch` VARCHAR(255) NOT NULL,
    `prUrl` VARCHAR(500) NULL,
    `prStatus` ENUM('NONE', 'OPEN', 'MERGED', 'CLOSED') NOT NULL DEFAULT 'NONE',
    `addedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TicketBranch_ticketId_idx`(`ticketId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TicketBranch` ADD CONSTRAINT `TicketBranch_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketBranch` ADD CONSTRAINT `TicketBranch_addedById_fkey` FOREIGN KEY (`addedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
