-- AlterTable
ALTER TABLE `IngestionSettings` ADD COLUMN `fallbackProjectId` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `IngestionSettings` ADD CONSTRAINT `IngestionSettings_fallbackProjectId_fkey` FOREIGN KEY (`fallbackProjectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
