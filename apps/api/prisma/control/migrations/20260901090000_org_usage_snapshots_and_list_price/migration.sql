-- 5.0.0: the business the console could not see — a daily usage snapshot, and a price for a seat.
--
-- TWO STRUCTURAL FAULTS, ONE MIGRATION.
--
-- (1) NO HISTORY. `platform-admin-analytics.service.ts` opened a connection to every tenant
--     database on every page load and returned a live snapshot. It got slower with each customer
--     won, and — the worse half — nothing was ever kept, so no trend, cohort, churn or retention
--     question could be ASKED. Not "was hard to answer": could not be asked, because the data to
--     answer it was never written down. `OrgUsageSnapshot` is one row per workspace per day,
--     written by a nightly worker, and the console reads it instead of the fleet.
--
-- (2) NO PRICE. There was no money anywhere in this database. `PlatformBillingSettings` holds
--     Stripe Price IDs, whose amounts live in Stripe, and a deployment that assigns tiers by hand
--     has no Stripe account at all — so MRR was not derivable by any route.
--     `PlanTierLimit.listPricePerSeatMinor` is the operator-editable list price that makes it so.
--
-- ===================================================================================
-- WHAT EXISTING ROWS DO. READ THIS BEFORE EDITING.
--
-- `OrgUsageSnapshot` starts EMPTY and there is no backfill, because a backfill is impossible.
-- Every column in it is a point-in-time count of mutable tenant state — seats active on a day,
-- tickets open on a day, spend so far that month. Yesterday's values are simply gone; nothing in
-- either database records them. The series therefore begins the first night the worker runs, and
-- every reader in the codebase is written to survive a one-row history: no percentage off two
-- points, no division by a zero-length window, no cohort table that renders NaN on day one.
--
-- `PlanTierLimit` rows DO get a value, and choosing it is the only real decision in this file:
--   * STARTER  -> 0     ("free" is a price, and a real one).
--   * TEAM     -> 800   ($8.00 per seat per month), the figure the landing page has always shown.
--   * ENTERPRISE -> stays NULL, deliberately. Enterprise is priced per contract and the pricing
--     page says "Custom". Inventing a list price for it would put a fabricated number into an MRR
--     figure an operator would then quote to somebody.
--
-- NULL IS NOT ZERO, and the console must never blur the two: an unset price renders as "Not set",
-- those workspaces are EXCLUDED from the MRR total, and the count of exclusions is shown beside
-- it. A confident $0 against a deployment's largest customers is worse than no number at all.
--
-- The two values come from `PLAN_TIER_LIST_PRICES` in @timesheet/shared, which is also what the
-- landing page's pricing cards render and what `prisma/control/seed.ts` writes on a fresh install
-- — so the page a buyer reads and the MRR an operator quotes cannot disagree. Same one-source rule
-- the entitlement columns above already follow with `PLAN_TIER_LIMITS`.
--
-- THE UPDATES ARE GUARDED ON `IS NULL`, not on the value. `listPricePerSeatMinor = 0` is a
-- perfectly ordinary state an operator may have chosen deliberately (a free promotional tier), so
-- a `WHERE listPricePerSeatMinor = 0` guard would silently re-price it on a replay. `IS NULL` is
-- the honest condition: it is true exactly once, on the run that introduced the column. This is
-- the same lesson `20260831180000_platform_console_governance` learned the hard way about
-- `WHERE role = 'READ_ONLY'`.
--
-- This file is NOT marked `@rerunnable` — that marker authorises `npm run setup` to clear a failed
-- migration record and re-apply the file unattended against live data, and it is reserved for
-- migrations whose DDL is itself guarded on information_schema. The DML here is idempotent, but
-- the ALTER above it is not, so an interrupted run wants a human.
-- ===================================================================================
--
-- WHY EVERY ENUM-SHAPED COLUMN IN `OrgUsageSnapshot` IS A VARCHAR: `planTier`, `status` and
-- `trialTier` are a HISTORICAL record. A tier renamed or retired later must not rewrite the past
-- or make old rows unreadable — and renaming a MySQL ENUM is a table rewrite. `SalesLead.status`,
-- `TrialFeedback.stage` and `PlatformAdminUser.role` all made the same call for the same reason.
--
-- WHY `ticketCountsByStatus` IS JSON: the tenant status vocabulary is admin-extensible (custom
-- workflows), so a column per status would need a migration every time a customer invents one.
-- `ticketsTotal` and `ticketsOpen` are denormalised beside it so the fleet aggregates are a SUM
-- rather than a JSON walk over every row in the window.
--
-- WHY `activeSeats` AND `agentSeats` ARE TWO COLUMNS: only the first is billable. An agent's
-- identity is a real `User` row so assignment, workload and audit keep working, and folding the two
-- together would make the roster a per-agent upsell by accident. Keeping them apart is also what
-- lets a unit test BREAK "MRR never bills a robot" rather than trust a comment about it.
--
-- WHY THE MONEY COLUMNS ARE DECIMAL AND THE PRICE IS AN INT: spend is an accumulated estimate with
-- real fractional cents (DECIMAL(12,4), matching the tenant AI ledger's precision), while a list
-- price is an exact amount in minor units and must never touch a float.
--
-- WHY `databaseBytes` IS NULLABLE AND FLOAT: it is copied from the most recent `TenantDbSample`
-- rather than measured again — the hourly sampler already paid for that connection — and it is
-- NULL when the sampler has not reached that workspace yet. FLOAT matches `TenantDbSample`.
--
-- WHY `reachable` EXISTS: an unreachable workspace still gets a row, carrying the control plane's
-- own facts (plan, status, trial clock) with the tenant counts at zero and this flag false. A gap a
-- reader can see is honest; a silent zero looks exactly like a customer who stopped working.
--
-- PORTABILITY NOTE: written in canonical casing by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `PlanTierLimit` ADD COLUMN `listPricePerSeatMinor` INTEGER NULL,
    ADD COLUMN `listPriceCurrency` VARCHAR(3) NOT NULL DEFAULT 'USD';

-- Seed the two tiers that have a published list price. Guarded on IS NULL so a replay, or a later
-- deliberate edit by an operator, is never overwritten. Enterprise is left NULL on purpose.
UPDATE `PlanTierLimit` SET `listPricePerSeatMinor` = 0 WHERE `tier` = 'STARTER' AND `listPricePerSeatMinor` IS NULL;
UPDATE `PlanTierLimit` SET `listPricePerSeatMinor` = 800 WHERE `tier` = 'TEAM' AND `listPricePerSeatMinor` IS NULL;

-- CreateTable
CREATE TABLE `OrgUsageSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `day` DATETIME(3) NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `activeSeats` INTEGER NOT NULL,
    `agentSeats` INTEGER NOT NULL DEFAULT 0,
    `seatLimit` INTEGER NOT NULL,
    `ticketCountsByStatus` JSON NOT NULL,
    `ticketsTotal` INTEGER NOT NULL,
    `ticketsOpen` INTEGER NOT NULL,
    `aiSpendMonthToDateUsd` DECIMAL(12, 4) NOT NULL,
    `aiBudgetCeilingUsd` DECIMAL(10, 2) NOT NULL,
    `emailsSentMonthToDate` INTEGER NOT NULL,
    `emailsFailedMonthToDate` INTEGER NOT NULL,
    `databaseBytes` DOUBLE NULL,
    `lastActivityAt` DATETIME(3) NULL,
    `planTier` VARCHAR(24) NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `trialStartedAt` DATETIME(3) NULL,
    `trialEndsAt` DATETIME(3) NULL,
    `trialTier` VARCHAR(24) NULL,
    `stripeSubscriptionId` VARCHAR(255) NULL,
    `reachable` BOOLEAN NOT NULL DEFAULT true,

    INDEX `OrgUsageSnapshot_day_idx`(`day`),
    UNIQUE INDEX `OrgUsageSnapshot_organizationId_day_key`(`organizationId`, `day`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OrgUsageSnapshot` ADD CONSTRAINT `OrgUsageSnapshot_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
