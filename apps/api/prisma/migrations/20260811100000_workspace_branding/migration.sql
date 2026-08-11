-- The workspace's own logo + display name (singleton, id = "global").
-- Bytes live in the branding storage subtree and are streamed by GET /api/branding/logo, which is
-- public on purpose: the logo has to render on the login page, where no signed file grant exists.
CREATE TABLE `WorkspaceBranding` (
  `id`          VARCHAR(191) NOT NULL,
  `logoFile`    VARCHAR(200) NULL,
  `logoMime`    VARCHAR(80)  NULL,
  `displayName` VARCHAR(60)  NULL,
  `updatedAt`   DATETIME(3)  NOT NULL,
  `updatedById` VARCHAR(191) NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
