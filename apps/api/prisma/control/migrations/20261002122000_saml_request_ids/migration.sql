-- SAML AuthnRequest ids move out of process memory and into the control plane.
--
-- WHY. `validateInResponseTo: always` (the SAML replay control) needs somewhere to remember the
-- AuthnRequest ids this deployment issued. That was a Map in each API process, and its own comment
-- said it was safe "only because the app runs as a single Node process". The Helm chart runs two
-- replicas and autoscales to ten, with no session affinity, so `/saml/start` and `/saml/acs` land on
-- different pods and a genuine response is refused as "InResponseTo is not valid" — at random, which
-- is the worst kind of sign-in failure to field because retrying usually works. `SsoHandoffCode`
-- (20260928120000) was moved here for exactly this reason; this is the same move for SAML.
--
-- SINGLE USE ACROSS REPLICAS. Accepting a response CLAIMS its id with a DELETE that reports how many
-- rows it removed: two pods racing to accept the same response produce one winner, and a replay of a
-- captured response finds nothing. `value` is the IssueInstant node-saml stored with the id.
--
-- LIFETIME: ten minutes, the same as the signed RelayState. Expired rows are swept on every new
-- request; the `expiresAt` index makes that cheap. ON DELETE CASCADE from Organization: an archived
-- workspace's in-flight sign-ins are meaningless.
--
-- WHAT EXISTING DEPLOYMENTS SEE: nothing to migrate. In-flight requests held in the old in-memory map
-- are lost on the deploy that ships this, which costs a person mid-sign-in one retry — the same cost a
-- restart always had.
--
-- CANONICAL CASING, written by hand: Windows MariaDB emits lowercase table names (docs/DATABASE.md).
-- Every statement is guarded, so a run interrupted anywhere replays safely.
-- @rerunnable

CREATE TABLE IF NOT EXISTS `SamlRequestId` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(128) NOT NULL,
    `value` VARCHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SamlRequestId_organizationId_requestId_key`(`organizationId`, `requestId`),
    INDEX `SamlRequestId_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @f := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'SamlRequestId' AND CONSTRAINT_NAME = 'SamlRequestId_organizationId_fkey');
SET @ddl := IF(@f = 0, 'ALTER TABLE `SamlRequestId` ADD CONSTRAINT `SamlRequestId_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
