-- 3.6.0: workspace discovery, and custom domains.
--
-- Two new control-plane tables. Neither changes any existing behaviour on its own: nothing reads
-- them until the routes and the resolver that use them ship alongside.
--
-- `OrgUserDirectory` stores an HMAC, never an address. The control plane already holds the org
-- registry, the plan matrix and every tenant's database credentials; adding a plaintext list of
-- every user's email across every customer would turn one dump of it into a customer list and a
-- marketing list at the same time. The hash answers the one question the table is asked — does the
-- address someone just typed match this row — and cannot be enumerated or reversed into addresses.
--
-- `OrgDomain` is inert until `verifiedAt` is set, so a row claiming someone else's domain resolves
-- nothing. Verification is a DNS TXT record because "does this person control this domain" is the
-- question, and DNS is the only mechanism that actually asks it.
--
-- PORTABILITY NOTE: written in canonical casing by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- CreateTable
CREATE TABLE `OrgUserDirectory` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `emailHash` CHAR(64) NOT NULL,
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrgUserDirectory_emailHash_idx`(`emailHash`),
    UNIQUE INDEX `OrgUserDirectory_organizationId_emailHash_key`(`organizationId`, `emailHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrgDomain` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `domain` VARCHAR(253) NOT NULL,
    `verificationToken` VARCHAR(64) NOT NULL,
    `verifiedAt` DATETIME(3) NULL,
    `lastCheckedAt` DATETIME(3) NULL,
    `lastCheckError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrgDomain_domain_key`(`domain`),
    INDEX `OrgDomain_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OrgUserDirectory` ADD CONSTRAINT `OrgUserDirectory_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgDomain` ADD CONSTRAINT `OrgDomain_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
