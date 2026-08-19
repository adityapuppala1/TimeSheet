-- Ticket collaborators: extra people who may WORK ON a ticket alongside its reporter and assignee.
--
-- PORTABILITY NOTE (the 2.4.0 lesson, docs/DATABASE.md): table and column names are written in
-- canonical model casing by hand rather than taken from a Windows MariaDB introspection, which
-- lower-cases `User` and then dies on case-sensitive Linux MySQL.
--
-- Purely additive: one new table, no DML and no column added to an existing table, so no DDL guard
-- is required. Every existing ticket simply starts with an empty collaborator list, which is
-- exactly the pre-upgrade behaviour — `canWorkOnTicket()` falls through to reporter/assignee as
-- before. There is deliberately no backfill from `TicketWatcher`: a watcher is a notification
-- subscription anybody can self-grant, and copying those rows in would hand edit rights to every
-- person who had ever clicked "watch".

-- CreateTable
CREATE TABLE `TicketCollaborator` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `addedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TicketCollaborator_ticketId_userId_key`(`ticketId`, `userId`),
    INDEX `TicketCollaborator_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TicketCollaborator` ADD CONSTRAINT `TicketCollaborator_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketCollaborator` ADD CONSTRAINT `TicketCollaborator_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketCollaborator` ADD CONSTRAINT `TicketCollaborator_addedById_fkey` FOREIGN KEY (`addedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
