-- A public-API key can now expire on its own.
--
-- WHY IT MATTERS MORE THAN revokedAt, which already existed: revoking requires somebody to
-- remember. A long-lived bearer token pasted into a customer's Zapier account or a cron script is
-- precisely the credential nobody revisits, and `lastUsedAt` is the only signal it is still out
-- there at all. McpCredential took this same column, for the same reason, in
-- 20260808230000_mcp_credential_expiry — this closes the inconsistency of the OTHER standing
-- bearer credential in the product not having it.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none. The column is NULL for every existing key and NULL means
-- "never expires", so no integration that works today stops working. Back-dating an expiry onto
-- live keys during an upgrade, with no warning, is the wrong direction for a mistake to fail in;
-- the expiry is offered at CREATION instead, where somebody is present to choose it.

-- AlterTable
ALTER TABLE `ApiKey` ADD COLUMN `expiresAt` DATETIME(3) NULL;
