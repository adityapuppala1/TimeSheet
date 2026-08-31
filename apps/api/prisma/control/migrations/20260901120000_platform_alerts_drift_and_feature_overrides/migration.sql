-- 5.0.0: the alerts leave the room, the schema findings get a history, and one workspace can be
-- given one feature.
--
-- THREE OPERATIONAL GAPS, ONE MIGRATION. They are here together because they are the same gap seen
-- from three sides: the console knew things and had no way to act on them.
--
-- (1) ALERTS THAT NEVER LEFT. `platform-tenant-health.service.ts#deriveAlerts` has computed real,
--     severity-tiered fleet alerts since 4.0.0 — connections at 90%, an auto-increment key 94%
--     consumed, a workspace whose service is DOWN — and every one of them existed only while
--     somebody had the Monitoring page open. `PlatformAlertSettings` is where an operator says
--     where those should go; `PlatformAlertState` is what stops the going from becoming noise.
--
-- (2) FINDINGS WITH NO HISTORY. `getDatabaseMetrics` computed `tablesWithoutPrimaryKey` and
--     `indexHeavyTables`, raised an alert from them, and discarded them. So the only question an
--     operator ever asks about a schema finding — "when did this start?" — was unanswerable by any
--     route. Two counts and a name list now ride along on the hourly `TenantDbSample`.
--
-- (3) NO GENERAL PER-ORG ESCAPE. `Organization` already carried `seatLimitOverride` and
--     `aiMonthlyBudgetCeilingOverride`. Nothing else had one, so enabling a single beta for a
--     single design partner meant moving their whole tier — handing them nine other features
--     nobody agreed to, and changing what their entitlement checks say they have paid for.
--
-- ===================================================================================
-- WHAT EXISTING ROWS DO. READ THIS BEFORE EDITING.
--
-- `PlatformAlertSettings` and `PlatformAlertState` both start EMPTY, and there is NO backfill on
-- either — for `PlatformAlertState` there could not be one. Every row in it is the record of a
-- condition somebody was told about, and nobody has been told about anything yet; inventing rows
-- would claim a reporting history that did not happen, and the very first digest would then go out
-- silent about problems that are real today. The correct first run is the loud one: everything
-- currently wrong is NEW, is reported once, and is quiet from then on until it changes.
--
-- `PlatformAlertSettings` has no row until the console writes one, and every reader treats its
-- absence as the shipped defaults (digest on, floor at "warning", no webhook). Seeding a row here
-- would put an `updatedBy` of nobody against settings no operator has ever looked at.
--
-- `TenantDbSample.tablesWithoutPrimaryKey` / `indexHeavyTables` / `schemaFindings` are NULL on every
-- existing sample and are DELIBERATELY NOT BACKFILLED TO 0. NULL means "that hour did not record
-- this"; 0 means "we looked and the schema was clean". Writing 0 across the existing series would
-- manufacture a clean history and make the first real finding look like a regression that happened
-- the day this shipped. The chart is written to draw a gap, not a floor.
--
-- `Organization.featureOverrides` is NULL on every existing workspace, which is exactly right: null
-- means "no override, use the tier", and that is the state every workspace is in today. There is
-- nothing to migrate INTO it — `seatLimitOverride` and `aiMonthlyBudgetCeilingOverride` stay where
-- they are and are deliberately NOT moved in here. Two places to set one number is a bug waiting
-- for the day they disagree, and the reader in `plan-limits.service.ts` reads each from its own
-- column for that reason.
--
-- THIS FILE HAS NO DML AT ALL, which is the reason it needs no re-run guard: there is nothing here
-- whose second execution differs from its first. The rule the governance migration learned the hard
-- way — guard on ABSENCE, never on a value, because `WHERE role = 'READ_ONLY'` re-promoted
-- deliberate demotions on a replayed deploy — is honoured here by having nothing to guard. The
-- ALTERs are not idempotent, so an interrupted run wants a human, and this file is NOT marked
-- `@rerunnable`.
-- ===================================================================================
--
-- WHY EVERY ENUM-SHAPED COLUMN HERE IS A VARCHAR: `minSeverity`, `PlatformAlertState.severity`,
-- `reportedSeverity` and `area` are all vocabularies this product will extend — the severity tiers
-- and the five alert areas both come from a TypeScript union that has already grown once. Renaming
-- or extending a MySQL ENUM is a table rewrite, and `PlatformAdminUser.role`, `SalesLead.status`,
-- `TrialFeedback.stage` and every column on `OrgUsageSnapshot` made the same call for the same
-- reason.
--
-- WHY `PlatformAlertState` IS UNIQUE ON (organizationId, alertKey) AND NOT APPEND-ONLY: the table
-- answers "is this condition currently open, and have we said so" — one row per condition per
-- workspace, resolved and re-opened in place. An append-only log would make the question a GROUP BY
-- over a table that grows every six hours forever, and the whole anti-noise rule is a lookup on
-- exactly this key.
--
-- WHY `reportedSeverity` IS A SEPARATE COLUMN FROM `severity`: `severity` is what the last sweep
-- saw; `reportedSeverity` is what somebody was actually TOLD, written only when a channel accepted
-- the message. Collapsing them would mean a relay that was down silently swallows an alert forever
-- — the sweep would record it as seen, the next sweep would call it unchanged, and nobody would
-- ever hear about it. Keeping them apart makes a failed delivery self-healing on the next run.
--
-- WHY `encryptedWebhookSecret` IS TEXT: AES-256-GCM as `<iv>:<authTag>:<ciphertext>` hex, the same
-- shape and the same helper (utils/encryption.ts) as `PlatformMailSettings.encryptedPassword` and
-- `PlatformAiSettings.encryptedApiKey`. The server has to read it back to sign a body, so it is
-- encrypted rather than hashed.
--
-- WHY `schemaFindings` IS JSON AND THE COUNTS ARE NOT: the counts are what a trend is drawn from
-- and a SUM over a window must not walk a JSON document; the names are what makes a count
-- actionable, and their number is unbounded in principle. Table NAMES only — still aggregate, still
-- nothing about what any row contains, the line every cross-tenant column in this schema holds.
--
-- WHY `featureOverrides` IS JSON AND NOT TWENTY MORE `*Override` COLUMNS: a column per entitlement
-- is a migration every time a capability is added, which is precisely why this escape hatch was
-- never built. The keys are an ALLOWLIST in code (`platform-feature-overrides.service.ts`) and a key
-- outside it is dropped on read rather than honoured, so a typo — or a key from a build that has
-- since been rolled back — can never entitle anybody.
--
-- PORTABILITY NOTE: written in canonical casing by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `Organization` ADD COLUMN `featureOverrides` JSON NULL;

-- AlterTable
ALTER TABLE `TenantDbSample` ADD COLUMN `tablesWithoutPrimaryKey` INTEGER NULL,
    ADD COLUMN `indexHeavyTables` INTEGER NULL,
    ADD COLUMN `schemaFindings` JSON NULL;

-- CreateTable
CREATE TABLE `PlatformAlertSettings` (
    `id` VARCHAR(191) NOT NULL,
    `digestEnabled` BOOLEAN NOT NULL DEFAULT true,
    `minSeverity` VARCHAR(16) NOT NULL DEFAULT 'warning',
    `recipients` JSON NULL,
    `webhookUrl` VARCHAR(500) NULL,
    `encryptedWebhookSecret` TEXT NULL,
    `lastRunAt` DATETIME(3) NULL,
    `lastSentAt` DATETIME(3) NULL,
    `lastWebhookAt` DATETIME(3) NULL,
    `lastWebhookStatus` VARCHAR(64) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedBy` VARCHAR(255) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformAlertState` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `alertKey` VARCHAR(191) NOT NULL,
    `severity` VARCHAR(16) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `detail` TEXT NOT NULL,
    `area` VARCHAR(24) NOT NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL,
    `lastReportedAt` DATETIME(3) NULL,
    `reportedSeverity` VARCHAR(16) NULL,
    `resolvedAt` DATETIME(3) NULL,

    INDEX `PlatformAlertState_resolvedAt_severity_idx`(`resolvedAt`, `severity`),
    INDEX `PlatformAlertState_organizationId_lastSeenAt_idx`(`organizationId`, `lastSeenAt`),
    UNIQUE INDEX `PlatformAlertState_organizationId_alertKey_key`(`organizationId`, `alertKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PlatformAlertState` ADD CONSTRAINT `PlatformAlertState_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
