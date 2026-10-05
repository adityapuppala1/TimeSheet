-- Additive: an off-by-default switch for emailing a ticket's external reporter on resolution.
ALTER TABLE `EmailIntakeSettings` ADD COLUMN `notifyReporterOnResolve` BOOLEAN NOT NULL DEFAULT false;
