-- An MCP credential can now expire on its own.
--
-- WHY IT MATTERS MORE THAN revokedAt, which already existed: revoking requires somebody to
-- remember. A standing bearer token carrying one person's full authority, held by a language
-- model, is precisely the capability nobody revisits — the same reasoning the guest approval links
-- took a 30-day expiry for.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none. The column is NULL for every existing credential and NULL
-- means "never expires", so nothing that works today stops working. Expiring existing integrations
-- retroactively on upgrade, with no warning, would be the wrong direction for a mistake to fail in.

-- AlterTable
ALTER TABLE `McpCredential` ADD COLUMN `expiresAt` DATETIME(3) NULL;
