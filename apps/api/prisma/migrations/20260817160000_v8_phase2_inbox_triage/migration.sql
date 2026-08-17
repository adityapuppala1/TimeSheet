-- V8 phase 2: inbox triage state on Notification.
--
-- PORTABILITY NOTE (the 2.4.0 lesson, docs/DATABASE.md): `prisma migrate diff` introspected off
-- this Windows MariaDB emitted `notification` in lower case, which works here and dies on
-- case-sensitive Linux MySQL. Corrected to canonical model casing by hand.
--
-- Purely additive: two nullable columns and one index. No DML, so no DDL guard is required — the
-- migration-portability test only demands the information_schema + PREPARE pattern where fallible
-- data changes follow the schema change and a re-run could meet its own output.

-- AlterTable
ALTER TABLE `Notification` ADD COLUMN `handledAt` DATETIME(3) NULL,
    ADD COLUMN `snoozedUntil` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Notification_userId_handledAt_createdAt_idx` ON `Notification`(`userId`, `handledAt`, `createdAt`);
