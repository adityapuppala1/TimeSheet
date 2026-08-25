-- AIUsageLog now records FAILED attempts too, not just successful calls — the missing half of
-- "which provider actually gets the job done" (as opposed to "which provider we spent money
-- with"). `success` defaults to true, which is exactly correct for every existing row: only
-- successful calls were ever logged before this column existed, so no backfill is needed or
-- possible to get wrong. Failed rows carry 0 tokens/cost (nothing was consumed or billed) and a
-- short human-readable reason in `errorReason`.

-- AlterTable
ALTER TABLE `AIUsageLog`
  ADD COLUMN `success` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `errorReason` VARCHAR(300) NULL;
