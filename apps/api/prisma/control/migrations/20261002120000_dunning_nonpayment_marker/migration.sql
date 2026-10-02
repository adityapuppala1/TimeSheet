-- Which Stripe subscription a lapsed workspace is waiting on — so paying it can bring the workspace
-- back even after the grace window ran out.
--
-- THE BUG. `invoice.payment_failed` moves a subscribed workspace to GRACE; fourteen days later the
-- trial-lifecycle worker suspends any GRACE workspace; and `invoice.paid` restored only from GRACE.
-- Stripe keeps retrying a failed renewal past day 14, so the payment that should have ended it often
-- arrived after the suspension and was ignored: the customer was charged for a workspace that no
-- longer resolved, and could not even sign in to complain.
--
-- WHY A COLUMN. Restoring from SUSPENDED must never undo an OPERATOR's suspension, and
-- `suspendedReason` cannot tell the two apart: it is free text, and the console's edit dialog
-- pre-fills it, so an operator suspending a non-payer by hand saves "A renewal payment failed."
-- verbatim. `nonPaymentSubscriptionId` is written only by the webhook (on a failed renewal), kept by
-- the worker's GRACE -> SUSPENDED step, and cleared by checkout, by the payment that restores the
-- workspace, and whenever an operator moves the status.
--
-- ===================================================================================
-- WHAT EXISTING ROWS DO.
--
-- A workspace in GRACE right now because a renewal failed is backfilled with its current
-- subscription — `suspendedReason` there was written by the webhook (the console sends a null reason
-- for any status but SUSPENDED), so it is evidence in that one state. The guard is on ABSENCE
-- (`nonPaymentSubscriptionId IS NULL`), so a replay never re-marks a row an operator has since
-- decided.
--
-- A workspace already SUSPENDED is NOT backfilled, on purpose: from the row alone, a suspension by
-- the worker after a failed renewal and an operator's suspension carrying the same pre-filled reason
-- look identical, and guessing wrong would let a payment lift an operator's decision. Those few
-- workspaces are restored by hand, exactly as before this column existed.
-- ===================================================================================
--
-- Every statement is guarded — the column through an information_schema check + PREPARE, the
-- backfill by its own WHERE — so a run interrupted anywhere replays safely.
-- @rerunnable

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Organization' AND COLUMN_NAME = 'nonPaymentSubscriptionId');
SET @ddl := IF(@c = 0, 'ALTER TABLE `Organization` ADD COLUMN `nonPaymentSubscriptionId` VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `Organization`
   SET `nonPaymentSubscriptionId` = `stripeSubscriptionId`
 WHERE `status` = 'GRACE'
   AND `suspendedReason` = 'A renewal payment failed.'
   AND `stripeSubscriptionId` IS NOT NULL
   AND `nonPaymentSubscriptionId` IS NULL;
