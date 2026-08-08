-- AlterTable
ALTER TABLE `IngestionSettings` ADD COLUMN `autoCreateTicketOnCiFailureEnabled` BOOLEAN NOT NULL DEFAULT false;
