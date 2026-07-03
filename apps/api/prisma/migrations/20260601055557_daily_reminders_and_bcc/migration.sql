-- AlterTable
ALTER TABLE `globalnotificationsettings` ADD COLUMN `bccSuperAdminOnAllEmails` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `dailyReminderHour` INTEGER NOT NULL DEFAULT 16,
    ADD COLUMN `emailDailyEscalation` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailDailyReminder` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `escalationReminderHour` INTEGER NOT NULL DEFAULT 9,
    ADD COLUMN `remindOnWeekdaysOnly` BOOLEAN NOT NULL DEFAULT true;
