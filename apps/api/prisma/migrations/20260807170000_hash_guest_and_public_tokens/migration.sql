-- Guest approval links and public request-form links were stored in the clear, so any read of
-- the database — a backup, a dump, one injected SELECT — handed over live, usable capabilities.
-- These become SHA-256 lookups, the way AttestationShareLink.tokenHash already works.
--
-- ROLLOUT: this is PHASE 1 of two, and it deliberately does NOT drop or blank the plaintext
-- columns. Every outstanding link is backfilled here with MySQL's own SHA2(), so nothing breaks
-- at the moment this runs; keeping the plaintext for one release means rolling the application
-- back does not strand every guest approval and every printed form URL, which is the failure
-- mode worth engineering around. Phase 2 (a separate migration, once no row still needs the
-- fallback) drops `ApprovalStep.guestToken` and `RequestForm.publicToken`.
--
-- No expiry is backfilled onto existing guest links: `guestTokenExpiresAt` stays NULL for them,
-- which the application reads as "open-ended, as it always was". Stamping a date on links already
-- in people's inboxes would have invalidated them retroactively.

-- AlterTable
ALTER TABLE `ApprovalStep`
    ADD COLUMN `guestTokenHash` VARCHAR(64) NULL,
    ADD COLUMN `guestTokenExpiresAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `RequestForm`
    ADD COLUMN `publicTokenHash` VARCHAR(64) NULL;

-- Backfill. SHA2(x, 256) returns the lowercase hex digest, which is byte-for-byte what
-- node:crypto's createHash("sha256").digest("hex") produces for the same input.
UPDATE `ApprovalStep` SET `guestTokenHash` = SHA2(`guestToken`, 256) WHERE `guestToken` IS NOT NULL;
UPDATE `RequestForm` SET `publicTokenHash` = SHA2(`publicToken`, 256) WHERE `publicToken` IS NOT NULL;

-- Unique, not just indexed: the hash is now the identity the public routes look a row up by, and
-- a duplicate would make that lookup ambiguous. Added AFTER the backfill so the constraint is
-- validated against the final data in one pass.
CREATE UNIQUE INDEX `ApprovalStep_guestTokenHash_key` ON `ApprovalStep`(`guestTokenHash`);
CREATE UNIQUE INDEX `RequestForm_publicTokenHash_key` ON `RequestForm`(`publicTokenHash`);
