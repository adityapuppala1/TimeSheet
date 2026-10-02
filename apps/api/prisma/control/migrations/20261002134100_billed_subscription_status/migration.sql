-- The Stripe status of the subscription a billed-MRR figure came from (analytics audit M17).
--
-- WHY. "Billed MRR" summed every reconciled subscription — trialing, unpaid and paused ones included —
-- and ignored coupons, while the console called the gap to list price "discounting". Stripe's own
-- MRR counts only `active` and `past_due` subscriptions, net of recurring discounts. The nightly
-- reconciliation now nets the discounts and writes the subscription's status here, and the revenue
-- screen counts only the two billable statuses; the rest are counted apart as "not billing".
--
-- WHAT EXISTING ROWS DO: the column starts NULL, which the screen reads as billable — exactly today's
-- behaviour — until the next nightly sweep (or "Reconcile now") records the real status and the
-- net-of-discount amount together. Nothing is backfilled: the status lives in Stripe, not here.
--
-- Guarded through information_schema + PREPARE, so a re-run is a no-op. CANONICAL CASING, written by
-- hand (docs/DATABASE.md).
-- @rerunnable

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Organization' AND COLUMN_NAME = 'billedSubscriptionStatus');
SET @ddl := IF(@c = 0, 'ALTER TABLE `Organization` ADD COLUMN `billedSubscriptionStatus` VARCHAR(32) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
