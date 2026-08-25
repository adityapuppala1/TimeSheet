-- AIProviderConfig: a ranked list of AI providers replaces GlobalAISettings' single
-- provider/baseUrl/apiKey/model quartet. Existing configuration is copied forward as priority 0,
-- so an upgrade does not change which provider answers a call — the four old columns stay on
-- GlobalAISettings, unread by any dispatch code from here on, purely as this migration's own
-- source (see the schema comment on GlobalAISettings for why they are not dropped).
--
-- A workspace with no GlobalAISettings row yet (a genuinely fresh install, before the app's own
-- upsert-on-read has ever run) migrates zero rows — ai.service.ts synthesizes the same implicit
-- ANTHROPIC/env-key default at read time when the list is empty, matching today's behavior for an
-- unconfigured workspace exactly.

-- CreateTable
CREATE TABLE `AIProviderConfig` (
  `id` VARCHAR(191) NOT NULL,
  `provider` ENUM('ANTHROPIC', 'OPENAI_COMPATIBLE') NOT NULL DEFAULT 'ANTHROPIC',
  `label` VARCHAR(60) NULL,
  `baseUrl` VARCHAR(300) NULL,
  `apiKey` TEXT NULL,
  `model` VARCHAR(80) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `priority` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `AIProviderConfig_priority_idx` ON `AIProviderConfig`(`priority`);

-- Data migration: whatever this workspace had configured becomes the first (priority 0) entry.
INSERT INTO `AIProviderConfig` (`id`, `provider`, `baseUrl`, `apiKey`, `model`, `enabled`, `priority`, `createdAt`, `updatedAt`)
SELECT UUID(), `provider`, `baseUrl`, `apiKey`, `model`, true, 0, NOW(3), NOW(3)
FROM `GlobalAISettings`
WHERE `id` = 'global';
