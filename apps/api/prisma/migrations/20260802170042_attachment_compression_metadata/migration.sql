-- AlterTable
ALTER TABLE `attachment` ADD COLUMN `checksumSha256` VARCHAR(64) NULL,
    ADD COLUMN `compression` VARCHAR(10) NULL,
    ADD COLUMN `fileCategory` VARCHAR(20) NULL,
    ADD COLUMN `height` INTEGER NULL,
    ADD COLUMN `originalSizeBytes` INTEGER NULL,
    ADD COLUMN `storageKey` VARCHAR(255) NULL,
    ADD COLUMN `uploadedById` VARCHAR(191) NULL,
    ADD COLUMN `width` INTEGER NULL;

-- AlterTable
ALTER TABLE `ticketattachment` ADD COLUMN `checksumSha256` VARCHAR(64) NULL,
    ADD COLUMN `compression` VARCHAR(10) NULL,
    ADD COLUMN `fileCategory` VARCHAR(20) NULL,
    ADD COLUMN `height` INTEGER NULL,
    ADD COLUMN `originalSizeBytes` INTEGER NULL,
    ADD COLUMN `storageKey` VARCHAR(255) NULL,
    ADD COLUMN `width` INTEGER NULL;

-- CreateIndex
CREATE INDEX `Attachment_fileCategory_idx` ON `Attachment`(`fileCategory`);

-- CreateIndex
CREATE INDEX `TicketAttachment_fileCategory_idx` ON `TicketAttachment`(`fileCategory`);

-- AddForeignKey
ALTER TABLE `Attachment` ADD CONSTRAINT `Attachment_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
