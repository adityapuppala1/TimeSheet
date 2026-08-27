-- 3.8.0: keep the generated practice update, and archive the ones that were sent.
--
-- WHY: the draft lived in React state and nowhere else, so a refresh, a tab close or a walk to
-- another screen discarded a document that had just cost a full model run — and the only way back
-- was to spend those tokens again. Persisting it is the fix, and it is the same table that gives
-- the archive, because a sent update IS a draft that was mailed.
--
-- ONE DRAFT AT A TIME is a real constraint, not a convention: two concurrent generates must not
-- leave a workspace with two documents each claiming to be the current one. MySQL has no partial
-- unique index, so the application enforces it (delete-then-create inside one transaction) and the
-- `status, sentAt` index below is what makes both the "current draft" lookup and the archive
-- listing cheap.
--
-- `sentHtml` is LONGTEXT and holds what was ACTUALLY mailed. The archive renders that rather than
-- re-deriving from `data`, so a later change to the email template cannot rewrite history.
--
-- PORTABILITY NOTE: written in canonical casing by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- CreateTable
CREATE TABLE `PracticeUpdateRecord` (
    `id` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'SENT') NOT NULL DEFAULT 'DRAFT',
    `periodFrom` DATETIME(3) NOT NULL,
    `periodTo` DATETIME(3) NOT NULL,
    `periodLabel` VARCHAR(120) NOT NULL,
    `data` JSON NOT NULL,
    `narrative` JSON NULL,
    `aiFailed` TEXT NULL,
    `sentSubject` VARCHAR(400) NULL,
    `sentHtml` LONGTEXT NULL,
    `sentAt` DATETIME(3) NULL,
    `sentTo` JSON NULL,
    `generatedById` VARCHAR(191) NULL,
    `sentById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PracticeUpdateRecord_status_sentAt_idx`(`status`, `sentAt`),
    INDEX `PracticeUpdateRecord_generatedById_idx`(`generatedById`),
    INDEX `PracticeUpdateRecord_sentById_idx`(`sentById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey. SET NULL rather than CASCADE: an archived update must survive the person who
-- generated it leaving the company — deleting the record would be deleting the history.
ALTER TABLE `PracticeUpdateRecord` ADD CONSTRAINT `PracticeUpdateRecord_generatedById_fkey`
    FOREIGN KEY (`generatedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PracticeUpdateRecord` ADD CONSTRAINT `PracticeUpdateRecord_sentById_fkey`
    FOREIGN KEY (`sentById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
