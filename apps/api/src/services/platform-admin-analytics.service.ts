/**
 * The ONE place in this codebase allowed to loop over every tenant's database for reporting
 * purposes (the cron workers in src/workers/ also loop over every org, but to perform scheduled
 * actions, not to report on tenant content back to a human). This is the deliberate single
 * audit point for the "AI governance" / cross-tenant-isolation guarantee described in the
 * Track B plan: every query in this file is aggregate/count only (seat counts, ticket counts by
 * status, AI spend totals) — never a row-level ticket title, comment, or user's personal data.
 * If a future feature needs tenant row-level content surfaced to a platform admin, it does NOT
 * belong in this file — that would defeat the guarantee this file exists to uphold.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { getTenantClient } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { decryptSecret } from "../utils/encryption.js";

export interface OrgAnalyticsSummary {
  orgId: string;
  slug: string;
  name: string;
  status: string;
  planTier: string;
  seatCount: number;
  ticketCountsByStatus: Record<string, number>;
  aiSpendThisMonthUsd: number;
  /**
   * Outbound mail this month, as a sent/failed pair.
   *
   * A platform operator's most common real question about an org is "is their mail getting out" —
   * every workspace brings its own SMTP, so one org's credentials expiring is invisible from
   * anywhere else. Counts only: no recipient, no subject, no body ever leaves the tenant.
   */
  emailsSentThisMonth: number;
  emailsFailedThisMonth: number;
  /** Adoption of the Weekly AI/ML practice update, the one plan-gated capability whose whole
   *  output is an email — so "entitled but never used" is visible without reading anything. */
  practiceUpdatesSentThisMonth: number;
  lastActivityAt: string | null;
  reachable: boolean;
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

async function summarizeOrg(org: { id: string; slug: string; name: string; status: string; planTier: string }, dsn: string): Promise<OrgAnalyticsSummary> {
  const client = await getTenantClient(org.id, dsn);
  return tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, async () => {
    const [seatCount, ticketGroups, aiSpend, lastLogin, emailGroups, practiceUpdates] = await Promise.all([
      // `isAgent: false` for the same reason seat-count.service.ts excludes them: this figure is
      // what a platform admin reads as the org's seat usage, and counting automation identities
      // would inflate every roster-using org's apparent headcount. Written inline rather than
      // calling countActiveSeats() because this runs against an INJECTED tenant client (it walks
      // every org), not the ambient request-scoped one.
      client.user.count({ where: { status: "ACTIVE", deletedAt: null, isAgent: false } }),
      client.ticket.groupBy({ by: ["status"], _count: { _all: true } }),
      client.aIUsageLog.aggregate({ _sum: { costUsdEstimate: true }, where: { createdAt: { gte: startOfMonth() } } }),
      client.user.aggregate({ _max: { lastLoginAt: true } }),
      // Grouped by status rather than two counts: SENT/FAILED/QUEUED come from one scan, and a
      // queued row is neither a success nor a failure yet — collapsing it into either would make a
      // provider outage look like a delivery problem, or hide one.
      client.emailLog.groupBy({ by: ["status"], where: { createdAt: { gte: startOfMonth() } }, _count: { _all: true } }),
      client.emailLog.count({ where: { template: "digest.practice_update", status: { in: ["SENT", "QUEUED"] }, createdAt: { gte: startOfMonth() } } })
    ]);

    const emailByStatus = (status: string) =>
      emailGroups.find((row) => row.status === status)?._count._all ?? 0;

    return {
      orgId: org.id,
      slug: org.slug,
      name: org.name,
      status: org.status,
      planTier: org.planTier,
      seatCount,
      ticketCountsByStatus: Object.fromEntries(ticketGroups.map((g) => [g.status, g._count._all])),
      aiSpendThisMonthUsd: Number(aiSpend._sum.costUsdEstimate ?? 0),
      emailsSentThisMonth: emailByStatus("SENT"),
      emailsFailedThisMonth: emailByStatus("FAILED"),
      practiceUpdatesSentThisMonth: practiceUpdates,
      lastActivityAt: lastLogin._max.lastLoginAt?.toISOString() ?? null,
      reachable: true
    };
  });
}

/** Loops every org regardless of status (an unreachable/suspended org still shows up in the
 *  console, just flagged `reachable: false` rather than silently vanishing from the list). */
export async function getPlatformAnalytics(): Promise<{ orgs: OrgAnalyticsSummary[]; totals: { orgCount: number; seatCount: number; aiSpendThisMonthUsd: number } }> {
  const orgs = await controlPrisma.organization.findMany({ include: { database: true }, orderBy: { createdAt: "asc" } });

  const summaries: OrgAnalyticsSummary[] = [];
  for (const org of orgs) {
    if (!org.database) {
      summaries.push({
        orgId: org.id,
        slug: org.slug,
        name: org.name,
        status: org.status,
        planTier: org.planTier,
        seatCount: 0,
        ticketCountsByStatus: {},
        aiSpendThisMonthUsd: 0,
        emailsSentThisMonth: 0,
        emailsFailedThisMonth: 0,
        practiceUpdatesSentThisMonth: 0,
        lastActivityAt: null,
        reachable: false
      });
      continue;
    }
    try {
      const dsn = decryptSecret(org.database.encryptedDsn);
      summaries.push(await summarizeOrg(org, dsn));
    } catch (error) {
      console.error(`[platform-admin-analytics] failed to summarize org "${org.slug}":`, (error as Error).message);
      summaries.push({
        orgId: org.id,
        slug: org.slug,
        name: org.name,
        status: org.status,
        planTier: org.planTier,
        seatCount: 0,
        ticketCountsByStatus: {},
        aiSpendThisMonthUsd: 0,
        emailsSentThisMonth: 0,
        emailsFailedThisMonth: 0,
        practiceUpdatesSentThisMonth: 0,
        lastActivityAt: null,
        reachable: false
      });
    }
  }

  const totals = summaries.reduce(
    (acc, s) => ({
      orgCount: acc.orgCount + 1,
      seatCount: acc.seatCount + s.seatCount,
      aiSpendThisMonthUsd: acc.aiSpendThisMonthUsd + s.aiSpendThisMonthUsd
    }),
    { orgCount: 0, seatCount: 0, aiSpendThisMonthUsd: 0 }
  );

  return { orgs: summaries, totals };
}
