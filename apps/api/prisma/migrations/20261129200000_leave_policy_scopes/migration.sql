-- 7.0.0: leave policies per location or employment type. Additive only: every new column is NULL,
-- and NULL means "everyone", so existing leave types and calendars apply exactly as before.
ALTER TABLE `User`
    ADD COLUMN `employmentType` ENUM('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN') NULL,
    ADD COLUMN `siteId` VARCHAR(191) NULL;

CREATE INDEX `User_siteId_idx` ON `User`(`siteId`);

ALTER TABLE `User` ADD CONSTRAINT `User_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `AttendanceSite`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `LeaveType`
    ADD COLUMN `scopeEmploymentTypes` JSON NULL,
    ADD COLUMN `scopeSiteIds` JSON NULL;

ALTER TABLE `HolidayCalendar`
    ADD COLUMN `scopeEmploymentTypes` JSON NULL,
    ADD COLUMN `scopeSiteIds` JSON NULL;
