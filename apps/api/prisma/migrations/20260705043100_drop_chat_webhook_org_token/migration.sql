/*
  Warnings:

  - You are about to drop the column `webhookOrgToken` on the `chatintegration` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX `ChatIntegration_webhookOrgToken_key` ON `chatintegration`;

-- AlterTable
ALTER TABLE `chatintegration` DROP COLUMN `webhookOrgToken`;
