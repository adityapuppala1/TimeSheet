-- Just-in-time account creation on SSO sign-in becomes a per-provider setting (audit H5).
--
-- WHAT CHANGES. `completeSsoLogin` has always created an EMPLOYEE account for any identity a provider
-- authenticated and no account matched — no switch, no domain limit, no audit row. For a Google OAuth
-- client set to External, or a Microsoft configuration with no tenant ID, that is "anyone on the
-- internet, up to the seat cap". Two columns on `OrgSsoConfig` make it a decision:
--
--   `jitEnabled`         — create accounts on first sign-in at all. DEFAULT TRUE.
--   `jitAllowedDomains`  — JSON array of email domains an account may be created for. NULL = any.
--
-- WHAT EXISTING ROWS DO: NOTHING DIFFERENT. Every existing configuration gets `jitEnabled = 1` from the
-- column default and `jitAllowedDomains = NULL` — precisely the behaviour it has today. Nobody who can
-- sign in now is refused after this migration; the settings card is where an admin tightens it.
--
-- Every ALTER is guarded through information_schema + PREPARE, so a run interrupted anywhere replays
-- safely. CANONICAL CASING, written by hand (docs/DATABASE.md).
-- @rerunnable

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrgSsoConfig' AND COLUMN_NAME = 'jitEnabled');
SET @ddl := IF(@c = 0, 'ALTER TABLE `OrgSsoConfig` ADD COLUMN `jitEnabled` BOOLEAN NOT NULL DEFAULT true', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrgSsoConfig' AND COLUMN_NAME = 'jitAllowedDomains');
SET @ddl := IF(@c = 0, 'ALTER TABLE `OrgSsoConfig` ADD COLUMN `jitAllowedDomains` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
