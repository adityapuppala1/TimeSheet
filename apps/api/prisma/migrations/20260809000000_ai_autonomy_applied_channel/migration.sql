-- The email channel for "a capability applied its own change set".
--
-- DEFAULT TRUE, unlike most new channels, and it is a precondition rather than a preference:
-- AUTO_APPLY moves a person's job from approving a change to vetoing it, and a veto nobody is told
-- about is not a veto. A workspace can still switch it off, but that is the decision to let a
-- machine change the plan silently — which is a choice somebody should make on purpose.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none in practice. Nothing sends this category until a super admin
-- raises a capability above SUGGEST, which requires the autonomy master latch to be on, which
-- defaults off.

-- AlterTable
ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `emailAiAutonomyApplied` BOOLEAN NOT NULL DEFAULT true;
