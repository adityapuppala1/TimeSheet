/**
 * Control-plane seed — run once (and safe to re-run, everything is upsert-on-slug/tier).
 * Seeds the static per-tier limits (PlanTierLimit) and a DEFAULT_ORG row that points at
 * whatever this environment's existing DATABASE_URL already is. This is what makes Phase B1's
 * tenant-resolution middleware a no-op for the current single-tenant setup: there is exactly
 * one Organization, its OrgDatabase DSN is the same database the app already talks to today,
 * so nothing behaves differently until a second, real organization is provisioned.
 */
import { PrismaClient } from "../../src/generated/control-client/index.js";
import { encryptSecret } from "../../src/utils/encryption.js";
import { hashPassword } from "../../src/utils/security.js";

const controlPrisma = new PrismaClient();

const DEFAULT_ORG_SLUG = process.env.DEFAULT_ORG_SLUG ?? "default";

function parseDsn(dsn: string): { host: string; databaseName: string } {
  const url = new URL(dsn);
  return { host: url.hostname, databaseName: url.pathname.replace(/^\//, "") || "unknown" };
}

async function main() {
  const tenantDsn = process.env.DATABASE_URL;
  if (!tenantDsn) throw new Error("DATABASE_URL must be set to seed the default organization's database connection.");

  await controlPrisma.planTierLimit.upsert({
    where: { tier: "STARTER" },
    update: {},
    create: {
      tier: "STARTER",
      seatLimit: 10,
      aiMonthlyBudgetCeilingUsd: 0,
      allowedSsoProviders: ["GOOGLE"],
      allowedChatPlatforms: []
    }
  });
  await controlPrisma.planTierLimit.upsert({
    where: { tier: "TEAM" },
    update: {},
    create: {
      tier: "TEAM",
      seatLimit: 1_000_000,
      aiMonthlyBudgetCeilingUsd: 200,
      allowedSsoProviders: ["GOOGLE", "MICROSOFT"],
      allowedChatPlatforms: ["SLACK", "TELEGRAM"]
    }
  });
  await controlPrisma.planTierLimit.upsert({
    where: { tier: "ENTERPRISE" },
    // The one targeted `update`: existing deployments predate the faceVerificationEnabled
    // column (added Enterprise-only), and without this a re-seed would leave their ENTERPRISE
    // row on the column default (false) — silently disabling a feature that worked yesterday.
    update: { faceVerificationEnabled: true },
    create: {
      tier: "ENTERPRISE",
      seatLimit: 1_000_000,
      aiMonthlyBudgetCeilingUsd: 5000,
      allowedSsoProviders: ["GOOGLE", "MICROSOFT", "SAML", "LDAP"],
      allowedChatPlatforms: ["SLACK", "MICROSOFT_TEAMS", "GOOGLE_CHAT", "TELEGRAM"],
      faceVerificationEnabled: true
    }
  });
  console.log("Seeded PlanTierLimit rows (STARTER, TEAM, ENTERPRISE).");

  const { host, databaseName } = parseDsn(tenantDsn);
  const org = await controlPrisma.organization.upsert({
    where: { slug: DEFAULT_ORG_SLUG },
    update: {},
    create: { slug: DEFAULT_ORG_SLUG, name: "Default Organization", status: "ACTIVE", planTier: "ENTERPRISE" }
  });

  await controlPrisma.orgDatabase.upsert({
    where: { organizationId: org.id },
    update: { encryptedDsn: encryptSecret(tenantDsn), host, databaseName },
    create: { organizationId: org.id, encryptedDsn: encryptSecret(tenantDsn), host, databaseName }
  });

  await controlPrisma.orgAuthMethod.upsert({
    where: { organizationId: org.id },
    update: {},
    create: { organizationId: org.id, passwordLoginEnabled: true, requireSsoOnly: false }
  });

  console.log(`Seeded Organization "${DEFAULT_ORG_SLUG}" (${org.id}) pointing at the existing tenant database.`);

  // Dev bootstrap credentials — same convention as prisma/seed.ts's tenant superadmin
  // ("Admin@12345"). Rotate this in any real deployment; it exists purely so there's a way to
  // log into /platform-admin at all on a fresh environment.
  const platformAdminEmail = "platform-admin@timesphere.local";
  await controlPrisma.platformAdminUser.upsert({
    where: { email: platformAdminEmail },
    update: {},
    create: { email: platformAdminEmail, name: "Platform Admin", passwordHash: await hashPassword("PlatformAdmin@12345"), status: "ACTIVE" }
  });
  console.log(`Seeded PlatformAdminUser "${platformAdminEmail}" (password: PlatformAdmin@12345 — change in production).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => controlPrisma.$disconnect());
