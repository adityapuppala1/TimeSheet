/**
 * The ONE place in this codebase allowed to loop over every tenant's database for reporting
 * purposes (the cron workers in src/workers/ also loop over every org, but to perform scheduled
 * actions, not to report on tenant content back to a human). This is the deliberate single
 * audit point for the "AI governance" / cross-tenant-isolation guarantee described in the
 * Track B plan: every query in this file is aggregate/count only (seat counts, ticket counts by
 * status, AI spend totals) — never a row-level ticket title, comment, or user's personal data.
 * If a future feature needs tenant row-level content surfaced to a platform admin, it does NOT
 * belong in this file — that would defeat the guarantee this file exists to uphold.
 *
 * ------------------------------------------------------------------------------------------
 * 5.0.0 — THE NIGHTLY SNAPSHOT, AND WHY IT LIVES HERE.
 *
 * `getPlatformAnalytics()` below opens a connection to EVERY tenant database on EVERY page load
 * and returns a live snapshot with no history. Two faults in one design:
 *
 *   1. it gets slower with each customer won, and
 *   2. because nothing was ever kept, no trend, cohort, churn or retention question could be
 *      ASKED — not "was hard to answer", could not be asked, because the data was never written
 *      down anywhere.
 *
 * `captureOrgUsageSnapshots()` is the fix for both: the same aggregate reads, taken once a night
 * by a worker, written to the control plane's `OrgUsageSnapshot`. Everything historical in the
 * console then reads THAT table — a control-plane query with no tenant connections at all — and
 * the live loop stays only for "as of right now".
 *
 * IT IS IN THIS FILE ON PURPOSE. Snapshotting means looping every tenant database for reporting,
 * which is precisely the thing this file exists to be the single audit point for. Putting it in a
 * new service would create a second such loop somewhere nobody is watching, and the guarantee
 * above would then be true of one file and false of the codebase. The DERIVED work — revenue,
 * churn, health scoring — lives in `platform-revenue.service.ts` and `platform-account-health.ts`
 * and touches no tenant database at all, by construction.
 *
 * THE SNAPSHOT IS AGGREGATE-ONLY, exactly like everything else here: counts, sums and timestamps.
 * No ticket title, no comment, no person, no email address is read, stored, or surfaced to a
 * platform admin — not on the live path and not on the nightly one.
 * ------------------------------------------------------------------------------------------
 */
import type { Prisma } from "../generated/control-client/index.js";
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

/* ------------------------------------------------------------------------------------------ */
/* The nightly snapshot                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * How long a daily snapshot is kept.
 *
 * Three years, not the 400 days `TenantDbSample` keeps. A capacity chart is about the last few
 * months; a cohort retention table is about what a customer who signed up two years ago is doing
 * now, and that question cannot be answered by a series that has already forgotten them. One row
 * per workspace per day is roughly 1,100 rows per customer over the whole period — nothing.
 */
export const USAGE_SNAPSHOT_RETENTION_DAYS = 1100;

/** The statuses that count as unfinished work. `REOPENED` is deliberately in here: a reopened
 *  ticket is open again, and counting it as done makes a struggling workspace look calm. */
const OPEN_TICKET_STATUSES = new Set(["OPEN", "IN_PROGRESS", "IN_REVIEW", "REOPENED"]);

export interface SnapshotSweepResult {
  /** UTC midnight of the day every row in this pass was written against. */
  day: string;
  captured: number;
  /** Workspaces whose tenant database could not be read. A row was still written for each. */
  failed: Array<{ slug: string; error: string }>;
  prunedRows: number;
}

/** Midnight UTC of the day `at` falls in — the snapshot's grain, and the second half of its
 *  uniqueness key. UTC rather than local so a deployment that moves timezone does not grow two
 *  rows for one day. */
export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Start of the calendar month `at` falls in, UTC — the window "month to date" means. */
function startOfUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** The tier a workspace is ENTITLED to, which is not what it has paid for while a trial runs.
 *  Inlined rather than imported from plan-limits.service.ts because that module's version compares
 *  against `Date.now()`, and a sweep replayed for a specific day has to ask about THAT day. */
function entitledTier(org: { planTier: string; trialTier: string | null; trialEndsAt: Date | null }, at: Date): string {
  if (org.trialTier && org.trialEndsAt && org.trialEndsAt.getTime() > at.getTime()) return org.trialTier;
  return org.planTier;
}

/**
 * Take one reading of every workspace's usage and write it as that day's row.
 *
 * SEQUENTIAL AND PER-ORG ISOLATED, the same two rules `sampleAllTenantDatabases` follows and for
 * the same reasons: forty fresh connections at once against the box the whole platform runs on is a
 * self-inflicted outage, and one unreachable tenant must never abort the sweep — the other
 * thirty-nine rows are exactly what the operator needs in order to notice that the fortieth is
 * missing. An unreachable workspace still gets a row, carrying the control plane's own facts with
 * `reachable: false`, because a gap a reader can see is honest and a silent zero looks like a
 * customer who stopped working.
 *
 * IDEMPOTENT ON A SAME-DAY RE-RUN, by UPSERT on (organizationId, day). This is not a nicety: the
 * worker skips-rather-than-queues like every other sweep here, an operator can trigger a pass by
 * hand, and a retried night that appended a second row would double every workspace inside every
 * fleet total that sums the day.
 */
export async function captureOrgUsageSnapshots(now = new Date()): Promise<SnapshotSweepResult> {
  const day = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);

  const [orgs, tierLimits] = await Promise.all([
    controlPrisma.organization.findMany({ include: { database: true }, orderBy: { createdAt: "asc" } }),
    controlPrisma.planTierLimit.findMany()
  ]);
  const limitFor = new Map(tierLimits.map((limit) => [String(limit.tier), limit]));

  const failed: SnapshotSweepResult["failed"] = [];
  let captured = 0;

  for (const org of orgs) {
    // Every field the CONTROL plane already knows. These are written whether or not the tenant
    // database answers, which is what makes an unreachable workspace still appear in a cohort.
    const tier = entitledTier({ planTier: String(org.planTier), trialTier: org.trialTier ? String(org.trialTier) : null, trialEndsAt: org.trialEndsAt }, now);
    const limit = limitFor.get(tier);
    const controlFacts = {
      seatLimit: org.seatLimitOverride ?? limit?.seatLimit ?? 0,
      aiBudgetCeilingUsd: (org.aiMonthlyBudgetCeilingOverride ?? limit?.aiMonthlyBudgetCeilingUsd ?? 0) as Prisma.Decimal | number,
      planTier: String(org.planTier),
      status: String(org.status),
      trialStartedAt: org.trialStartedAt,
      trialEndsAt: org.trialEndsAt,
      trialTier: org.trialTier ? String(org.trialTier) : null,
      stripeSubscriptionId: org.stripeSubscriptionId
    };

    // Size comes from the hourly sampler's most recent reading rather than from a fresh metadata
    // query: that connection has already been paid for, and there is no reason to pay twice.
    const lastSample = await controlPrisma.tenantDbSample
      .findFirst({ where: { organizationId: org.id }, orderBy: { sampledAt: "desc" }, select: { totalBytes: true } })
      .catch(() => null);

    let tenantFacts = {
      activeSeats: 0,
      agentSeats: 0,
      ticketCountsByStatus: {} as Record<string, number>,
      ticketsTotal: 0,
      ticketsOpen: 0,
      aiSpendMonthToDateUsd: 0,
      emailsSentMonthToDate: 0,
      emailsFailedMonthToDate: 0,
      lastActivityAt: null as Date | null,
      reachable: false
    };

    if (org.database) {
      try {
        tenantFacts = await readTenantUsage(org, decryptSecret(org.database.encryptedDsn), monthStart);
      } catch (error) {
        // Recorded and skipped. It must never stop the fleet: the other workspaces' rows are what
        // let an operator SEE that this one is missing.
        failed.push({ slug: org.slug, error: (error as Error).message.slice(0, 200) });
      }
    }

    const data = {
      ...controlFacts,
      ...tenantFacts,
      ticketCountsByStatus: tenantFacts.ticketCountsByStatus as Prisma.InputJsonValue,
      databaseBytes: lastSample?.totalBytes ?? null,
      capturedAt: now
    };

    await controlPrisma.orgUsageSnapshot.upsert({
      where: { organizationId_day: { organizationId: org.id, day } },
      update: data,
      create: { organizationId: org.id, day, ...data }
    });
    captured += 1;
  }

  const cutoff = new Date(day.getTime() - USAGE_SNAPSHOT_RETENTION_DAYS * 86_400_000);
  const pruned = await controlPrisma.orgUsageSnapshot.deleteMany({ where: { day: { lt: cutoff } } });

  return { day: day.toISOString(), captured, failed, prunedRows: pruned.count };
}

/**
 * One workspace's aggregates, read inside its own tenant context.
 *
 * EVERY QUERY HERE IS A COUNT, A GROUP-BY COUNT, OR A SUM. That is the boundary this whole file
 * exists to hold, and the snapshot does not get an exemption from it just because the result is
 * stored rather than rendered. Nothing selects a title, a body, a name or an address.
 */
async function readTenantUsage(
  org: { id: string; slug: string },
  dsn: string,
  monthStart: Date
): Promise<{
  activeSeats: number;
  agentSeats: number;
  ticketCountsByStatus: Record<string, number>;
  ticketsTotal: number;
  ticketsOpen: number;
  aiSpendMonthToDateUsd: number;
  emailsSentMonthToDate: number;
  emailsFailedMonthToDate: number;
  lastActivityAt: Date | null;
  reachable: boolean;
}> {
  const client = await getTenantClient(org.id, dsn);
  return tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, async () => {
    const [activeSeats, agentSeats, ticketGroups, aiSpend, lastLogin, emailGroups] = await Promise.all([
      // `isAgent: false`, matching countActiveSeats() and the live summary above: this is the seat
      // count the revenue figures are priced off, and billing a workspace for its automation
      // identities would turn the agent roster into a per-agent upsell by accident.
      client.user.count({ where: { status: "ACTIVE", deletedAt: null, isAgent: false } }),
      // Counted separately rather than excluded silently — agent adoption is worth seeing, and two
      // columns are what let a test assert that only one of them is ever priced.
      client.user.count({ where: { status: "ACTIVE", deletedAt: null, isAgent: true } }),
      client.ticket.groupBy({ by: ["status"], _count: { _all: true } }),
      client.aIUsageLog.aggregate({ _sum: { costUsdEstimate: true }, where: { createdAt: { gte: monthStart } } }),
      client.user.aggregate({ _max: { lastLoginAt: true } }),
      client.emailLog.groupBy({ by: ["status"], where: { createdAt: { gte: monthStart } }, _count: { _all: true } })
    ]);

    const ticketCountsByStatus = Object.fromEntries(ticketGroups.map((group) => [group.status, group._count._all]));
    const counts = Object.entries(ticketCountsByStatus);
    const emailByStatus = (status: string) => emailGroups.find((row) => row.status === status)?._count._all ?? 0;

    return {
      activeSeats,
      agentSeats,
      ticketCountsByStatus,
      ticketsTotal: counts.reduce((total, [, count]) => total + count, 0),
      ticketsOpen: counts.reduce((total, [status, count]) => total + (OPEN_TICKET_STATUSES.has(status) ? count : 0), 0),
      aiSpendMonthToDateUsd: Number(aiSpend._sum.costUsdEstimate ?? 0),
      emailsSentMonthToDate: emailByStatus("SENT"),
      emailsFailedMonthToDate: emailByStatus("FAILED"),
      lastActivityAt: lastLogin._max.lastLoginAt ?? null,
      reachable: true
    };
  });
}
