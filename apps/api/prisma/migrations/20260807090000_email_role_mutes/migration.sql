-- Per-role email suppression map for GlobalNotificationSettings.
--
-- Nullable with no default: an existing row reads back NULL, which the application treats as
-- "no role is muted anywhere", i.e. byte-for-byte today's delivery behaviour. Rolling this
-- migration out therefore changes nothing until a super admin actually unticks a cell in
-- Workspace settings -> Email channels.
ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `emailRoleMutes` JSON NULL;
