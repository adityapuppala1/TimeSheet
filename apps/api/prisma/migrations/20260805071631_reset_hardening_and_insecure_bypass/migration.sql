-- AlterTable
ALTER TABLE `GlobalFaceVerificationSettings` ADD COLUMN `insecureContextBypass` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false;
