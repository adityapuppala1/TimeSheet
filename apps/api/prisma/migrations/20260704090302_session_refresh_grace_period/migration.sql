-- AlterTable
ALTER TABLE `Session` ADD COLUMN `previousRefreshHash` VARCHAR(191) NULL,
    ADD COLUMN `refreshRotatedAt` DATETIME(3) NULL;
