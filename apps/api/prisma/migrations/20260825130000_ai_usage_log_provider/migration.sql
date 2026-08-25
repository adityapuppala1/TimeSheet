-- AIUsageLog now records which provider actually served each call and how long it took.
--
-- WHY NO BACKFILL: GlobalAISettings.provider/baseUrl can change over time, and this column
-- records what was true AT THE CALL, not what is true now. Guessing the current provider onto
-- historical rows would misattribute past spend the first time a workspace switches providers.
-- Existing rows show NULL ("Unknown" in the UI) instead.
--
-- durationMs mirrors AIInteraction.latencyMs (nullable, no default) rather than defaulting to 0:
-- several call sites never measure a single-call duration, and 0 would read as "instant" rather
-- than "not measured".

-- AlterTable
ALTER TABLE `AIUsageLog`
  ADD COLUMN `provider` VARCHAR(40) NULL,
  ADD COLUMN `durationMs` INTEGER NULL;

-- CreateIndex
CREATE INDEX `AIUsageLog_provider_createdAt_idx` ON `AIUsageLog`(`provider`, `createdAt`);
