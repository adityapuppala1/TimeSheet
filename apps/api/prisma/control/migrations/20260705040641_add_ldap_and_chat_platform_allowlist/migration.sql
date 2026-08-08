-- AlterTable
ALTER TABLE `OrgSsoConfig` ADD COLUMN `encryptedLdapBindCredential` TEXT NULL,
    ADD COLUMN `ldapBindDn` VARCHAR(500) NULL,
    ADD COLUMN `ldapSearchBase` VARCHAR(500) NULL,
    ADD COLUMN `ldapTlsRejectUnauthorized` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `ldapUrl` VARCHAR(500) NULL,
    ADD COLUMN `ldapUserFilter` VARCHAR(255) NULL,
    MODIFY `providerType` ENUM('GOOGLE', 'MICROSOFT', 'SAML', 'LDAP') NOT NULL;

-- AlterTable
ALTER TABLE `PlanTierLimit` ADD COLUMN `allowedChatPlatforms` JSON NOT NULL;
