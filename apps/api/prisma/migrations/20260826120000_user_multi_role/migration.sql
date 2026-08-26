-- Multi-role accounts: an account can now be ALLOWED to hold several roles (assigned only by a
-- super admin), with `User.roleId` continuing to mean the currently ACTIVE one — every existing
-- permission check in the app already reads `User.roleId`/`role`, so nothing else needs to change.
-- `UserRole` records which roles an account may switch into; the backfill below gives every
-- existing account exactly the one role it already has, so nothing changes on upgrade day.
--
-- CREATE TABLE IF NOT EXISTS + guarded FK, so a re-run against a tenant database already carrying
-- this migration is a no-op rather than a failure that strands it half-applied.
CREATE TABLE IF NOT EXISTS `UserRole` (
  `id`     VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `roleId` VARCHAR(191) NOT NULL,

  UNIQUE INDEX `UserRole_userId_roleId_key`(`userId`, `roleId`),
  INDEX `UserRole_userId_idx`(`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @fk1 := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserRole' AND CONSTRAINT_NAME = 'UserRole_userId_fkey'
);
SET @sql := IF(@fk1 = 0,
  'ALTER TABLE `UserRole` ADD CONSTRAINT `UserRole_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk2 := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserRole' AND CONSTRAINT_NAME = 'UserRole_roleId_fkey'
);
SET @sql := IF(@fk2 = 0,
  'ALTER TABLE `UserRole` ADD CONSTRAINT `UserRole_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill: every existing account already effectively "holds" its one current role. INSERT IGNORE
-- is what makes this safe to re-run — the (userId, roleId) unique index above turns a second run
-- into a no-op rather than a duplicate-key error.
INSERT IGNORE INTO `UserRole` (`id`, `userId`, `roleId`)
SELECT UUID(), `id`, `roleId` FROM `User`;
