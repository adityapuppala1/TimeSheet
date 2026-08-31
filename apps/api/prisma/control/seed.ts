/**
 * Control-plane seed — run once (and safe to re-run, everything is upsert-on-slug/tier).
 * Seeds the static per-tier limits (PlanTierLimit) and a DEFAULT_ORG row that points at
 * whatever this environment's existing DATABASE_URL already is. This is what makes Phase B1's
 * tenant-resolution middleware a no-op for the current single-tenant setup: there is exactly
 * one Organization, its OrgDatabase DSN is the same database the app already talks to today,
 * so nothing behaves differently until a second, real organization is provisioned.
 */
import { PLAN_TIER_LIMITS, PLAN_TIER_LIST_PRICES, planTiers } from "@timesheet/shared";
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

  // Values come from @timesheet/shared's PLAN_TIER_LIMITS rather than being written out here.
  // They used to be literals in this file, and the marketing pricing table restated them from
  // memory — which drifted: the comparison table advertised face verification on TEAM while this
  // seed grants it to ENTERPRISE only, and that feature fails CLOSED. Sharing the constant means
  // the table and the enforcement can no longer disagree.
  for (const tier of planTiers) {
    const limits = PLAN_TIER_LIMITS[tier];
    await controlPrisma.planTierLimit.upsert({
      where: { tier },
      // Only faceVerificationEnabled is force-updated on re-seed: deployments that predate that
      // column would otherwise keep the default (false) and silently lose a feature that worked
      // yesterday. Everything else is left alone so a platform admin's per-tier tuning survives.
      update: { faceVerificationEnabled: limits.faceVerificationEnabled },
      // SPREAD, NOT A HAND-WRITTEN FIELD LIST. The list that used to be here had fallen behind
      // twice — goals and change management both landed with their column, their migration and
      // their enforcement, and never reached this object. The guarded UPDATEs in the
      // `*_entitlements` migrations hid it from every existing install: they run BEFORE this seed,
      // so on an upgrade they fix the row and on a FRESH database they match zero rows and this
      // `create` is what the row ends up being. A new customer on Team or Enterprise was therefore
      // told goals and change management were not in their plan. Measured, not deduced — deleting
      // the TEAM row and re-running this seed reproduced it exactly.
      //
      // `PlanTierLimits` and the `PlanTierLimit` model carry the same field names by design, and
      // `plan-tier-limit-parity.test.ts` pins that. So the spread is exhaustive by construction,
      // and if the two ever diverge this stops compiling instead of quietly dropping a column.
      //
      // Still NOT spread into the `update` branch above, unlike faceVerificationEnabled: that
      // would give a platform admin's per-tier tuning a second chance to be silently reverted by a
      // re-seed. Create-only is the correct half of that trade.
      //
      // The list price (5.0.0) is passed EXPLICITLY beside the spread rather than folded into
      // `PlanTierLimits`, because everything on that interface is something the server enforces and
      // a price enforces nothing. It comes from the same shared constant the landing page's pricing
      // cards render, so a buyer's page and the operator's MRR cannot disagree about what a seat
      // costs. Enterprise's is `null` on purpose — priced per contract, shown as "Custom", and
      // excluded from the MRR total rather than counted as zero.
      create: {
        tier,
        ...limits,
        listPricePerSeatMinor: PLAN_TIER_LIST_PRICES[tier].perSeatMinor,
        listPriceCurrency: PLAN_TIER_LIST_PRICES[tier].currency
      }
    });
  }
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
    /*
     * `role: "OWNER"` ON THE CREATE BRANCH IS LOAD-BEARING, AND ITS ABSENCE WAS A REAL BUG.
     *
     * `PlatformAdminUser.role` defaults to READ_ONLY — the right default for a column added by
     * migration, so a row that misses its initialisation is under-privileged rather than over.
     * The migration that adds it promotes every PRE-EXISTING admin to OWNER, which covers every
     * upgrade. A FRESH install has no pre-existing admin: the migration's UPDATE matches nothing
     * because the table is empty, and then THIS create runs. Without the role named here the
     * bootstrap admin lands READ_ONLY, the deployment has no owner at all, and nobody can grant
     * one — because granting a role is the single thing only an owner can do.
     *
     * This is the same seed-versus-migration seam the PlanTierLimit entitlements were bitten by
     * twice, in the same direction, and only ever visible on a fresh database.
     */
    update: {},
    create: { email: platformAdminEmail, name: "Platform Admin", role: "OWNER", passwordHash: await hashPassword("PlatformAdmin@12345"), status: "ACTIVE" }
  });

  /*
   * The one repair the update branch above deliberately does not do, done here instead.
   *
   * A create-only role is correct — re-seeding must never revert a demotion an operator chose,
   * which is exactly why the entitlement values above are create-only too. But there is one state
   * that is not a choice and cannot be recovered from inside the product: an install with no active
   * OWNER anywhere. Guarded on precisely that, so it fires only when the alternative is a console
   * nobody can administer, and matches the `NOT EXISTS` guard in the governance migration.
   */
  if ((await controlPrisma.platformAdminUser.count({ where: { status: "ACTIVE", role: "OWNER" } })) === 0) {
    const repaired = await controlPrisma.platformAdminUser.updateMany({ where: { status: "ACTIVE" }, data: { role: "OWNER" } });
    if (repaired.count > 0) console.log(`No active platform OWNER existed — promoted ${repaired.count} active admin(s), since nobody could have granted the role from the console.`);
  }

  console.log(`Seeded PlatformAdminUser "${platformAdminEmail}" (password: PlatformAdmin@12345 — change in production).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => controlPrisma.$disconnect());
