-- Additive: a workspace policy requiring two-factor for password sign-in.
ALTER TABLE `OrgAuthMethod` ADD COLUMN `requireMfa` BOOLEAN NOT NULL DEFAULT false;
