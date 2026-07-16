-- AlterTable
ALTER TABLE `Ticket` ADD COLUMN `errorFingerprint` VARCHAR(128) NULL;

-- CreateIndex
CREATE INDEX `Ticket_errorFingerprint_idx` ON `Ticket`(`errorFingerprint`);
