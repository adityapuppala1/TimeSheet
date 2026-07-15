/*
  Warnings:

  - You are about to drop the column `webhookOrgToken` on the `ChatIntegration` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX `ChatIntegration_webhookOrgToken_key` ON `ChatIntegration`;

-- AlterTable
ALTER TABLE `ChatIntegration` DROP COLUMN `webhookOrgToken`;
