-- AlterTable
ALTER TABLE `ingestionsettings` ADD COLUMN `autoCreateTicketOnCiFailureEnabled` BOOLEAN NOT NULL DEFAULT false;
