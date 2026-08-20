-- The Ask AI page's memory: one row per question-and-answer, with what each answer cost.
--
-- CREATE TABLE IF NOT EXISTS, so a re-run against a tenant already carrying it is a no-op rather
-- than a failure that strands the migration half-applied. JSON NOT NULL is safe here because the
-- table is created empty — the add-nullable-backfill-tighten dance is only for ALTERs.
CREATE TABLE IF NOT EXISTS `AiAskExchange` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `prompt` TEXT NOT NULL,
  `answer` TEXT NULL,
  `error` VARCHAR(500) NULL,
  `toolCalls` JSON NOT NULL,
  `model` VARCHAR(120) NULL,
  `provider` VARCHAR(40) NULL,
  `inputTokens` INTEGER NOT NULL DEFAULT 0,
  `outputTokens` INTEGER NOT NULL DEFAULT 0,
  `costUsd` DECIMAL(10, 6) NULL,
  `durationMs` INTEGER NOT NULL DEFAULT 0,
  `feedback` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `AiAskExchange_userId_createdAt_idx`(`userId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- FK added separately and guarded: IF NOT EXISTS does not cover constraints, and a re-run must not
-- fail on a constraint that is already there.
SET @fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiAskExchange' AND CONSTRAINT_NAME = 'AiAskExchange_userId_fkey'
);
SET @sql := IF(@fk = 0,
  'ALTER TABLE `AiAskExchange` ADD CONSTRAINT `AiAskExchange_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
