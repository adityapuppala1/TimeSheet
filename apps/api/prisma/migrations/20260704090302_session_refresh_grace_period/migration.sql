-- AlterTable
ALTER TABLE `session` ADD COLUMN `previousRefreshHash` VARCHAR(191) NULL,
    ADD COLUMN `refreshRotatedAt` DATETIME(3) NULL;
