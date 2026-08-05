-- AlterTable
ALTER TABLE `globalaisettings` ADD COLUMN `aiPrInlineReviewEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `assigneeSuggestionAiEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `bugPatternDigestEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `staleTicketNudgeEnabled` BOOLEAN NOT NULL DEFAULT false;
