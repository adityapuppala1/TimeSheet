/**
 * WHAT: the numbers behind the console's Signups page (signup Phase 1) — is self-serve working, who
 * came in through it, and are they staying.
 *
 * WHERE EACH NUMBER COMES FROM, because each has a trap:
 *  - The funnel is the SignupAttempt rows (signup-funnel.service.ts). They carry a domain and a keyed
 *    hash, never an address, so this page can be read by any console role without exposing people.
 *  - "Converted" is paying for real: ACTIVE, no trial still running, and either a paid tier or a live
 *    subscription. A trial grants Team on top of STARTER, so "planTier is TEAM" alone would count a
 *    workspace that has never paid.
 *  - Seats are the LATEST usage snapshot (org-usage-snapshot.worker.ts) and null before the first —
 *    a workspace created this morning has not been measured, which is not the same as zero people.
 *  - Self-serve vs console is Organization.createdVia; anything not SELF_SERVE (including rows from
 *    before the column existed and were backfilled) counts as console-made.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { companyDomainOf } from "../utils/company-domain.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIODS = [7, 30, 90] as const;
export type SignupPeriod = (typeof PERIODS)[number];

export interface SignupAnalytics {
  days: SignupPeriod;
  funnel: { codeSent: number; verified: number; created: number; joinRequested: number; unavailable: number; refused: number; failed: number };
  byDay: Array<{ day: string; selfServe: number; console: number }>;
  recent: Array<{
    orgId: string;
    name: string;
    slug: string;
    domain: string | null;
    ownerEmail: string | null;
    createdAt: string;
    status: string;
    planTier: string;
    trialEndsAt: string | null;
    trialDaysLeft: number | null;
    converted: boolean;
    activeSeats: number | null;
  }>;
  failures: Array<{ at: string; domain: string | null; detail: string | null }>;
  topDomains: Array<{ domain: string; attempts: number; created: number; joinRequested: number }>;
}

/** 7, 30 or 90 — the nearest, so a hand-edited `?days=` cannot ask for a year-long scan. */
export function clampSignupPeriod(days: number): SignupPeriod {
  if (!Number.isFinite(days)) return 30;
  return PERIODS.reduce((best, p) => (Math.abs(p - days) < Math.abs(best - days) ? p : best), PERIODS[0]);
}

const STAGE_KEY: Record<string, keyof SignupAnalytics["funnel"]> = {
  CODE_SENT: "codeSent",
  VERIFIED: "verified",
  CREATED: "created",
  JOIN_REQUESTED: "joinRequested",
  UNAVAILABLE: "unavailable",
  REFUSED: "refused",
  FAILED: "failed"
};

const dayKey = (value: Date) => value.toISOString().slice(0, 10);

type StageCount = { stage: string; _count: { _all: number } };
type DomainStageCount = StageCount & { domain: string | null };
type CreatedOrg = {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  createdVia: string | null;
  createdAt: Date;
  status: string;
  planTier: string;
  trialEndsAt: Date | null;
  stripeSubscriptionId: string | null;
};

function funnelFrom(stageCounts: StageCount[]): SignupAnalytics["funnel"] {
  const funnel: SignupAnalytics["funnel"] = { codeSent: 0, verified: 0, created: 0, joinRequested: 0, unavailable: 0, refused: 0, failed: 0 };
  for (const row of stageCounts) {
    const key = STAGE_KEY[row.stage];
    if (key) funnel[key] += row._count._all;
  }
  return funnel;
}

/** Every day of the period, oldest first, so an empty day draws as zero rather than vanishing. */
function byDayFrom(created: CreatedOrg[], days: number, now: Date): SignupAnalytics["byDay"] {
  const byDay = Array.from({ length: days }, (_, i) => ({ day: dayKey(new Date(now.getTime() - (days - 1 - i) * DAY_MS)), selfServe: 0, console: 0 }));
  const bucket = new Map(byDay.map((d) => [d.day, d]));
  for (const o of created) {
    const entry = bucket.get(dayKey(o.createdAt));
    if (!entry) continue;
    if (o.createdVia === "SELF_SERVE") entry.selfServe += 1;
    else entry.console += 1;
  }
  return byDay;
}

/** The newest usage snapshot's seat count per workspace; absent before the first snapshot. */
async function latestSeatsFor(orgIds: string[]): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  if (orgIds.length === 0) return latest;
  const snapshots = await controlPrisma.orgUsageSnapshot.findMany({
    where: { organizationId: { in: orgIds } },
    select: { organizationId: true, activeSeats: true, day: true },
    orderBy: { day: "desc" }
  });
  for (const s of snapshots) if (!latest.has(s.organizationId)) latest.set(s.organizationId, s.activeSeats);
  return latest;
}

function recentRow(o: CreatedOrg, seats: Map<string, number>, now: Date): SignupAnalytics["recent"][number] {
  const trialRunning = o.trialEndsAt !== null && o.trialEndsAt > now;
  return {
    orgId: o.id,
    name: o.name,
    slug: o.slug,
    domain: o.ownerEmail ? companyDomainOf(o.ownerEmail) : null,
    ownerEmail: o.ownerEmail,
    createdAt: o.createdAt.toISOString(),
    status: o.status,
    planTier: o.planTier,
    trialEndsAt: o.trialEndsAt?.toISOString() ?? null,
    trialDaysLeft: trialRunning ? Math.ceil((o.trialEndsAt!.getTime() - now.getTime()) / DAY_MS) : null,
    converted: o.status === "ACTIVE" && !trialRunning && (o.planTier !== "STARTER" || Boolean(o.stripeSubscriptionId)),
    activeSeats: seats.get(o.id) ?? null
  };
}

function topDomainsFrom(domainStages: DomainStageCount[]): SignupAnalytics["topDomains"] {
  const perDomain = new Map<string, SignupAnalytics["topDomains"][number]>();
  for (const row of domainStages) {
    // A refused address is personal or blocked — counted in the funnel, but gmail.com trying hard is
    // not a company trying hard.
    if (!row.domain || row.stage === "REFUSED") continue;
    const entry = perDomain.get(row.domain) ?? { domain: row.domain, attempts: 0, created: 0, joinRequested: 0 };
    entry.attempts += row._count._all;
    if (row.stage === "CREATED") entry.created += row._count._all;
    if (row.stage === "JOIN_REQUESTED") entry.joinRequested += row._count._all;
    perDomain.set(row.domain, entry);
  }
  return [...perDomain.values()].sort((a, b) => b.attempts - a.attempts || a.domain.localeCompare(b.domain)).slice(0, 15);
}

/**
 * The console Overview's signup tile and chart: the last 30 days and twelve weekly buckets, each split
 * into customers who signed themselves up and workspaces an operator made. Before this the two were
 * one number, so a week of console provisioning read as demand. A null createdVia (a row from before
 * the column, not backfilled) counts as console — self-serve is only what the signup route recorded.
 */
export function overviewSignups(orgs: Array<{ createdVia: string | null; createdAt: Date }>, now: Date) {
  const split = (from: Date, to: Date) => {
    const inRange = orgs.filter((o) => o.createdAt >= from && o.createdAt < to);
    const selfServe = inRange.filter((o) => o.createdVia === "SELF_SERVE").length;
    return { selfServe, console: inRange.length - selfServe };
  };
  const end = new Date(now.getTime() + 1);
  return {
    signups30: split(new Date(now.getTime() - 30 * DAY_MS), end),
    // Twelve weekly buckets — enough to see a trend, not so many the chart is noise.
    signupsByWeek: Array.from({ length: 12 }, (_, i) => {
      const start = new Date(now.getTime() - (11 - i + 1) * 7 * DAY_MS + 1);
      const stop = new Date(start.getTime() + 7 * DAY_MS);
      return { week: start.toISOString().slice(0, 10), ...split(start, i === 11 ? end : stop) };
    })
  };
}

export async function getSignupAnalytics(requestedDays: number, now = new Date()): Promise<SignupAnalytics> {
  const days = clampSignupPeriod(requestedDays);
  const gte = new Date(now.getTime() - days * DAY_MS);

  const [stageCounts, failures, created, domainStages] = await Promise.all([
    controlPrisma.signupAttempt.groupBy({ by: ["stage"], where: { createdAt: { gte } }, _count: { _all: true } }),
    controlPrisma.signupAttempt.findMany({
      where: { stage: "FAILED", createdAt: { gte } },
      select: { createdAt: true, domain: true, detail: true },
      orderBy: { createdAt: "desc" },
      take: 50
    }),
    controlPrisma.organization.findMany({
      where: { createdAt: { gte } },
      select: { id: true, name: true, slug: true, ownerEmail: true, createdVia: true, createdAt: true, status: true, planTier: true, trialEndsAt: true, stripeSubscriptionId: true },
      orderBy: { createdAt: "desc" }
    }),
    controlPrisma.signupAttempt.groupBy({ by: ["domain", "stage"], where: { createdAt: { gte }, domain: { not: null } }, _count: { _all: true } })
  ]);

  const selfServe = created.filter((o) => o.createdVia === "SELF_SERVE").slice(0, 100);
  const seats = await latestSeatsFor(selfServe.map((o) => o.id));
  return {
    days,
    funnel: funnelFrom(stageCounts),
    byDay: byDayFrom(created, days, now),
    recent: selfServe.map((o) => recentRow(o, seats, now)),
    failures: failures.map((f) => ({ at: f.createdAt.toISOString(), domain: f.domain, detail: f.detail })),
    topDomains: topDomainsFrom(domainStages)
  };
}
