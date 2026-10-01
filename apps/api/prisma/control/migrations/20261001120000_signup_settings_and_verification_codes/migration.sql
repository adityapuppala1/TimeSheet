-- Self-serve signup gets an off switch, and email verification codes leave process memory.
--
-- (1) `PlatformSignupSettings` — the console's switch for `/api/signup`, the one public route that
--     provisions infrastructure. Until now it was mounted on every deployment with no way to turn
--     it off, and `.env.example` ships `TENANT_DB_PROVISION_BASE_URL` set, so a manual install
--     copied from the template would create a database for anyone with a company email address.
--     The switch is OFF unless an operator turns it on. A deployment that sells through signup
--     must enable it in Platform admin → Settings after upgrading; that is the one upgrade action
--     this migration implies, and it is stated in docs/DEPLOYMENT.md's version-specific notes.
--
-- (2) `EmailVerificationCode` — the six-digit codes behind signup and "Find your workspace". They
--     lived in a Map inside one API process, which a multi-replica deployment cannot share: the
--     code is minted on one pod and checked on another, and a correct code is refused at random.
--     Same cure the SSO handoff codes got on 2026-09-28 (`SsoHandoffCode`): the control plane,
--     hashed at rest, swept by expiry. Each code now also records its `purpose`, so a code minted
--     by "Find your workspace" can no longer be redeemed to complete a signup (or vice versa).
--
-- ===================================================================================
-- WHAT EXISTING ROWS DO. Nothing: both tables are new and start EMPTY, deliberately.
--
-- No `PlatformSignupSettings` row is seeded. Every reader treats its absence as the shipped
-- defaults (off, no extra blocked domains, a daily summary, 14-day join requests), the same rule
-- `PlatformAlertSettings` follows
-- — seeding one would record an `updatedBy` of nobody against a policy no operator has looked at.
--
-- No codes carry over. In-flight codes from the old in-memory store die with the process that held
-- them on this deploy, exactly as they did on every restart before; the person requests another.
--
-- CANONICAL CASING, written by hand: Windows MariaDB emits lowercase table names (the 2.4.0 lesson,
-- docs/DATABASE.md), and a lowercase `platformsignupsettings` would not match the client on Linux.
-- ===================================================================================
--
-- Both statements are guarded with IF NOT EXISTS, so a run interrupted between them replays safely.
-- @rerunnable

CREATE TABLE IF NOT EXISTS `PlatformSignupSettings` (
    `id` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `blockedDomains` JSON NULL,
    `notifyMode` VARCHAR(8) NOT NULL DEFAULT 'DAILY',
    `joinRequestTtlDays` INTEGER NOT NULL DEFAULT 14,
    `updatedBy` VARCHAR(255) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `EmailVerificationCode` (
    `tokenHash` CHAR(64) NOT NULL,
    `codeHash` CHAR(64) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `purpose` VARCHAR(16) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EmailVerificationCode_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`tokenHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
