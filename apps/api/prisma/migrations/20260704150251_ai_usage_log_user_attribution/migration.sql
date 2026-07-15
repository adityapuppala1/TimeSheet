-- AlterTable
ALTER TABLE `AIUsageLog` ADD COLUMN `userId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `AIUsageLog_model_createdAt_idx` ON `AIUsageLog`(`model`, `createdAt`);

-- CreateIndex
CREATE INDEX `AIUsageLog_userId_idx` ON `AIUsageLog`(`userId`);

-- AddForeignKey
ALTER TABLE `AIUsageLog` ADD CONSTRAINT `AIUsageLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
