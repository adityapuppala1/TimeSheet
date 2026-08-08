-- The AI budget gate becomes a reservation instead of a check.
--
-- assertWithinBudget read an aggregate of AIUsageLog and compared — so two calls arriving
-- together both saw the same remaining figure and both spent it. This table is the fix: one row
-- per calendar month, and admission is an atomic conditional increment
-- (UPDATE ... WHERE committedUsd < budget) that MySQL serializes on the row lock. Of N
-- simultaneous calls, only those that fit are admitted; the overshoot is bounded by one in-flight
-- reservation rather than by N.
--
-- AIUsageLog remains the source of truth for reporting. This row is only the gate, and it is
-- reconciled against the aggregate periodically so a reservation leaked by a crash cannot shrink
-- the month's budget forever.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none until the first AI call of a month, which seeds the row
-- from the existing aggregate — history carries over, a mid-month upgrade grants no fresh budget.

-- CreateTable
CREATE TABLE `AiSpendMonth` (
    `id` VARCHAR(7) NOT NULL,
    `committedUsd` DECIMAL(12, 6) NOT NULL DEFAULT 0,
    `reconciledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
