-- AlterTable
ALTER TABLE `globalfaceverificationsettings` ADD COLUMN `insecureContextBypass` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `user` ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false;
