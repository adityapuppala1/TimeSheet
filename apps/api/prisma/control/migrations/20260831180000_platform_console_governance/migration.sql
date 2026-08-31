-- 5.0.0: the platform console stops being one all-powerful role.
--
-- Until now `requirePlatformAdmin` was the console's entire authorization surface: it proved you
-- were *an* admin and nothing else. Every platform admin could therefore drop any tenant's
-- database, restore a snapshot over one, retune every plan tier, and read every stored AI
-- credential. This migration adds the four things that turn that into a governed surface: a role
-- per operator, a second factor, a countersignature on the irreversible actions, and a recorded
-- reason on the rows that touch a customer.
--
-- ===================================================================================
-- THE BACKFILL BELOW IS THE LOAD-BEARING PART OF THIS FILE. READ IT BEFORE EDITING.
--
-- `PlatformAdminUser.role` defaults to 'READ_ONLY'. That is the correct default for a column
-- added by migration and it is the rule this codebase states twice — in packages/shared's
-- permissions block ("a new key must ALSO be backfilled by idempotent SQL inside the migration
-- that introduces it") and on PlanTierLimit's entitlement columns ("a tier row that has not been
-- re-seeded is under-entitled rather than over-entitled").
--
-- It is also, on its own, a way to lock every existing install out of its own console. The
-- bootstrap admin is created by an UPSERT in prisma/control/seed.ts whose `update` branch is `{}`,
-- and the seed is a one-time bootstrap that never runs again on upgrade. So nothing would ever
-- move an existing row off the default, there would be no OWNER anywhere, and the only people who
-- could promote somebody are the people who just lost the ability to.
--
-- Anyone holding a platform-admin account today already has unrestricted power over this
-- deployment. An upgrade must PRESERVE what they had; taking it away silently is not a security
-- improvement, it is an outage. Every pre-existing admin is therefore promoted to OWNER here, and
-- the operator can demote colleagues from the console afterwards — which is the first thing the
-- feature is for.
--
-- THE GUARD IS "IS THERE AN OWNER AT ALL", NOT "IS THIS ROW STILL AT THE DEFAULT", and the
-- difference was found by testing a re-run rather than by reasoning about one. The *_entitlements
-- migrations guard on `WHERE goalsEnabled = FALSE AND maxGoals = 0`, and that works there because a
-- tier sitting at exactly the shipped defaults is not a state anybody chooses. Here it does not:
-- READ_ONLY is a perfectly ordinary steady state for an operator somebody deliberately demoted, so
-- a naive `WHERE role = 'READ_ONLY'` would silently promote that person back to OWNER the next time
-- an interrupted deploy replayed this file. Measured on a scratch database: it does exactly that.
--
-- `NOT EXISTS (… role = 'OWNER')` is the honest condition. On the first run there is no owner
-- anywhere, so everybody who already had unrestricted power keeps it. On any later run there is at
-- least one, so the statement matches nothing and a deliberate demotion stands. It also self-heals
-- the one genuinely broken state — an install with no owner at all, which nobody can fix from the
-- console because granting a role is the thing only an owner can do.
--
-- The derived table in the subquery is not decoration: MySQL refuses a subquery that reads the same
-- table an UPDATE is writing, and wrapping it in `(SELECT …) AS existing` is the standard way past
-- that restriction.
-- ===================================================================================
--
-- WHY EVERY ENUM-SHAPED COLUMN IS A VARCHAR: `role`, `PendingPlatformAction.status` and `action`
-- are all things this product will rename, and renaming a MySQL ENUM is a table rewrite.
-- `SalesLead.status` and `TrialFeedback.stage` made the same call for the same reason.
--
-- WHY `mfaSecret` IS TEXT AND THE RECOVERY CODES ARE NOT: the TOTP secret is stored with
-- AES-256-GCM (`<iv>:<authTag>:<ciphertext>` hex, utils/encryption.ts) because the server has to
-- read it back to compute a code. A recovery code is only ever compared against what somebody
-- typed, so it is bcrypt-hashed like every other token in this app and is unreadable even to us.
--
-- WHY `mfaLastUsedStep` IS A BIGINT: it holds a Unix-time-divided-by-30 counter, which passes
-- INT's range in 2038 and is the kind of thing nobody wants to discover then.
--
-- PORTABILITY NOTE: written in canonical casing by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `PlatformAdminUser` ADD COLUMN `role` VARCHAR(16) NOT NULL DEFAULT 'READ_ONLY',
    ADD COLUMN `mfaEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `mfaSecret` TEXT NULL,
    ADD COLUMN `mfaEnrolledAt` DATETIME(3) NULL,
    ADD COLUMN `mfaLastUsedStep` BIGINT NULL;

-- Every admin that existed before roles did already had unrestricted power. Keep it.
UPDATE `PlatformAdminUser`
SET `role` = 'OWNER'
WHERE `role` = 'READ_ONLY'
  AND NOT EXISTS (SELECT 1 FROM (SELECT `role` FROM `PlatformAdminUser`) AS existing WHERE existing.`role` = 'OWNER');

-- AlterTable
ALTER TABLE `PlatformAuditLog` ADD COLUMN `reason` TEXT NULL,
    ADD COLUMN `before` JSON NULL,
    ADD COLUMN `after` JSON NULL,
    ADD COLUMN `ipAddress` VARCHAR(64) NULL;

-- CreateTable
CREATE TABLE `PlatformAdminRecoveryCode` (
    `id` VARCHAR(191) NOT NULL,
    `adminUserId` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(191) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PlatformAdminRecoveryCode_adminUserId_usedAt_idx`(`adminUserId`, `usedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PendingPlatformAction` (
    `id` VARCHAR(191) NOT NULL,
    `action` VARCHAR(40) NOT NULL,
    `route` VARCHAR(255) NOT NULL,
    `method` VARCHAR(8) NOT NULL,
    `params` JSON NOT NULL,
    `body` JSON NOT NULL,
    `reason` TEXT NOT NULL,
    `requestedById` VARCHAR(191) NOT NULL,
    `requestedByLabel` VARCHAR(255) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `requestedIp` VARCHAR(64) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `approvedById` VARCHAR(191) NULL,
    `approvedByLabel` VARCHAR(255) NULL,
    `approvedAt` DATETIME(3) NULL,
    `resolutionNote` TEXT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `PendingPlatformAction_status_expiresAt_idx`(`status`, `expiresAt`),
    INDEX `PendingPlatformAction_requestedById_idx`(`requestedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PlatformAdminRecoveryCode` ADD CONSTRAINT `PlatformAdminRecoveryCode_adminUserId_fkey` FOREIGN KEY (`adminUserId`) REFERENCES `PlatformAdminUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
