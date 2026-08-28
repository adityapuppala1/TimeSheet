-- 4.0.0: a maintenance window a workspace cannot switch off.
--
-- WHY THIS EXISTS. Until now every maintenance window in a workspace belonged to that workspace's
-- own super admins, which is right when they are the ones doing the maintenance. It is wrong when
-- the PLATFORM is: a deployment-wide window that any one tenant can clear is not a window, it is a
-- suggestion — and the migration it was protecting then runs against a live database with people
-- writing to it. So a platform-armed window carries a flag, and `updateMaintenanceSettings` refuses
-- a tenant-sourced write while the flag holds. Only the platform's own clear releases it.
--
-- The default is FALSE, so every existing row keeps exactly the behaviour it had: a window a
-- workspace armed for itself is still entirely theirs to change or cancel.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `MaintenanceSettings`
    ADD COLUMN `managedByPlatform` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `managedByLabel` VARCHAR(255) NULL,
    ADD COLUMN `managedReference` VARCHAR(64) NULL;
