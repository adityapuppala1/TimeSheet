-- Per-credential tool narrowing.
--
-- Until now an MCP credential carried its holder's ENTIRE authority. That is the right default —
-- an integration must never be able to do more than the person who set it up — but it was the only
-- option, so a super admin issuing a credential for their own desktop assistant handed that model
-- every admin power they have, in a context window, for as long as the token lived.
--
-- APPLIED AS AN INTERSECTION, NEVER A UNION (services/mcp.service.ts#narrowEnablementToCredential):
-- a tool must be enabled by the workspace AND listed here. This column can therefore only ever
-- narrow — it cannot grant anything the workspace or the holder does not already have.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none. NULL means "whatever the workspace allows", which is
-- exactly what every credential issued before today already did.

-- AlterTable
ALTER TABLE `McpCredential` ADD COLUMN `allowedTools` JSON NULL;
