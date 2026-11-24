-- 7.0.0: birthday and work-anniversary strip. Additive and OFF by default: celebrationsEnabled is
-- false and nobody has a date yet, so nothing is shown until an admin turns it on.
ALTER TABLE `User`
    ADD COLUMN `dateOfBirth` DATE NULL,
    ADD COLUMN `joinDate` DATE NULL,
    ADD COLUMN `celebrationsOptOut` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `GlobalAttendanceSettings`
    ADD COLUMN `celebrationsEnabled` BOOLEAN NOT NULL DEFAULT false;
