-- 7.0.0: optional holidays people opt into, with a per-calendar yearly cap. Additive only: existing
-- calendars get no cap (NULL) and nobody is opted in.
ALTER TABLE `HolidayCalendar` ADD COLUMN `maxOptionalPerYear` INTEGER NULL;

CREATE TABLE `HolidayOptIn` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `holidayId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `HolidayOptIn_userId_holidayId_key`(`userId`, `holidayId`),
    INDEX `HolidayOptIn_holidayId_idx`(`holidayId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `HolidayOptIn` ADD CONSTRAINT `HolidayOptIn_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `HolidayOptIn` ADD CONSTRAINT `HolidayOptIn_holidayId_fkey` FOREIGN KEY (`holidayId`) REFERENCES `Holiday`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
