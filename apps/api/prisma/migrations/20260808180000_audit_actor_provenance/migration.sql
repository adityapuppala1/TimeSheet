-- Audit provenance: WHO acted, and WHAT changed.
--
-- Until now every automated actor in the product wrote `actorId = NULL` — email intake, chat
-- intake, the SLA sweeps, the security ingest, a guest clicking an emailed approval link — and the
-- only way to tell them apart was to string-match the `action` column. `metadata` is freeform, so
-- a row could describe an action but never be diffed.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none. `actorType` defaults to USER, which is what every one of
-- the ~181 existing call sites means today, and every other column is nullable and unwritten until
-- a caller passes it. `ipAddress` already existed and was never written by anything.

-- AlterTable
ALTER TABLE `AuditLog`
    ADD COLUMN `actorType` ENUM('USER', 'SYSTEM', 'AGENT', 'INTEGRATION', 'GUEST') NOT NULL DEFAULT 'USER',
    ADD COLUMN `actorLabel` VARCHAR(120) NULL,
    ADD COLUMN `before` JSON NULL,
    ADD COLUMN `after` JSON NULL,
    ADD COLUMN `aiInteractionId` VARCHAR(64) NULL,
    ADD COLUMN `agentRunId` VARCHAR(64) NULL;

-- CreateIndex
CREATE INDEX `AuditLog_actorType_createdAt_idx` ON `AuditLog`(`actorType`, `createdAt`);

-- CreateIndex
CREATE INDEX `AuditLog_agentRunId_idx` ON `AuditLog`(`agentRunId`);

-- Reporter/author of record for rows an AI agent creates, following the four accounts that already
-- exist for exactly this purpose (email intake, chat intake, security ingestion, git integration).
--
-- WHY HERE AND NOT IN seed.ts: the seed is a one-time bootstrap that never runs again on an
-- existing workspace, so an account added there would exist only in databases created after this
-- release — and the agent runtime would then fail its first foreign key on every upgraded install.
--
-- WHY THE PASSWORD HASH IS A LITERAL AND NOT A HASH OF ANYTHING: this is bcrypt's format with a
-- salt and digest that no password produces. The account must be unable to sign in, and the
-- existing accounts achieve that by hashing a random UUID nobody keeps. SQL has no bcrypt, so an
-- unusable constant is the honest equivalent rather than a weak hash of a known string.
--
-- WHY status = 'INACTIVE': this account is a foreign-key target, never a principal. Every agent run
-- acts as the named human accountable for it, and `principal.service.ts#loadRequestUser` refuses
-- any account that is not ACTIVE — so shipping it INACTIVE makes "the agent account can never be
-- loaded as an acting identity" true in the DATA, not merely by convention. Being INACTIVE does not
-- affect its use as `reporterId`/`authorId`: a foreign key only needs the row to exist.
--
-- Idempotent by the WHERE NOT EXISTS: re-running this migration, or running it on a database where
-- something already created the account, changes nothing. `email` is unique, so a plain INSERT
-- would fail the whole migration instead.
INSERT INTO `User` (`id`, `name`, `email`, `passwordHash`, `roleId`, `status`, `bio`, `emailVerifiedAt`, `createdAt`, `updatedAt`)
SELECT
    UUID(),
    'AI Agent',
    'ai-agent@system.local',
    '$2b$12$000000000000000000000uGZfWJm5nSvBpFa1Kx0oHxJ0oQZ8Xy9Iq',
    (SELECT `id` FROM `Role` WHERE `name` = 'EMPLOYEE' LIMIT 1),
    'INACTIVE',
    'System account — author of record for rows created by an AI agent run. Never a principal: every agent run acts as the named person who is accountable for it, and is refused exactly what they are refused.',
    NOW(3),
    NOW(3),
    NOW(3)
WHERE EXISTS (SELECT 1 FROM `Role` WHERE `name` = 'EMPLOYEE')
  AND NOT EXISTS (SELECT 1 FROM `User` WHERE `email` = 'ai-agent@system.local');
