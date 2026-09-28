-- A completed SSO sign-in, parked for the seconds it takes the browser to reach the workspace it
-- belongs to.
--
-- WHY THIS TABLE EXISTS. Google and Microsoft require the OAuth `redirect_uri` to be one exact
-- registered string, so every workspace's sign-in comes back to a single callback host. Working out
-- WHICH workspace was never the problem — the organization rides in the signed `state`. The session
-- was: a refresh cookie written for the callback host cannot be read by `acme.example.com`, so
-- somebody who had just authenticated successfully landed back on a login page. The callback now
-- parks the finished session behind a one-time code and redirects the browser to the workspace's own
-- hostname to redeem it, which makes the cookie be written by a request whose Host is the workspace.
--
-- WHY IT IS NOT AN IN-MEMORY MAP, which is what it was for one commit. That works on exactly one
-- process. On a deployment with several API replicas behind a round-robin balancer the code is
-- minted on one pod and redeemed on another, and the person sees a sign-in that fails at random —
-- the worst kind of bug to field, because retrying usually works. It also lost every in-flight
-- sign-in on a restart or a rolling deploy.
--
-- WHY THE CONTROL PLANE AND NOT A TENANT DATABASE. This is cross-tenant by nature. It is WRITTEN by
-- a callback that has not resolved a tenant from its Host header (it knows the org only from the
-- signed state) and READ by a request that has. There is no single tenant database both halves
-- could agree on, and putting it in one would mean the callback opening a tenant connection purely
-- to store something about a request that had not arrived there yet.
--
-- WHAT IS IN THE ROW, AND WHAT IS NOT. `codeHash` is an HMAC of the one-time code keyed with the
-- app's own secret — never the code, which exists only in the redirect URL. `encryptedPayload` is
-- the session, AES-encrypted with `ENCRYPTION_KEY`, exactly like tenant DSNs and BYOK provider keys:
-- it contains a usable refresh token for up to sixty seconds and deserves the same treatment as the
-- credentials it sits beside, not less. `organizationId` is the binding that stops a code minted for
-- one workspace being redeemed at another's origin.
--
-- LIFETIME: sixty seconds, single use. Redemption DELETES the row before it checks the
-- organization, so a code cannot be retried against every origin an attacker can reach. Expired rows
-- are swept opportunistically on mint; the `expiresAt` index is what makes that cheap.
--
-- ON DELETE CASCADE from Organization: an archived workspace's in-flight sign-ins are meaningless,
-- and leaving them would be the only rows in this table with no workspace to redeem them.
CREATE TABLE `SsoHandoffCode` (
    `id` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(64) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `encryptedPayload` TEXT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SsoHandoffCode_codeHash_key`(`codeHash`),
    INDEX `SsoHandoffCode_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SsoHandoffCode`
    ADD CONSTRAINT `SsoHandoffCode_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
