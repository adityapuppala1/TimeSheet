/**
 * WHAT: the numbers behind the console's Signups page (signup Phase 1) — is self-serve working, who
 * came in through it, and are they staying.
 *
 * WHERE EACH NUMBER COMES FROM, because each has a trap:
 *  - The funnel is the SignupAttempt rows (signup-funnel.service.ts). They carry a domain and a keyed
 *    hash, never an address, so this page can be read by any console role without exposing people.
 *    It counts PEOPLE — distinct hashes — as a cohort: everyone whose FIRST code was sent in the
 *    period, and how many of THEM went on to each step. It used to count rows per stage, so a resend
 *    was a second "code sent", an existing member signing in was a "verified" prospect, and a step
 *    rate could pass 100%.
 *  - "Converted" is trial-conversion.ts#isConverted — the rule Revenue, retention and the lifecycle
 *    worker use: a checkout (which clears the trial tier), a subscription, or a paid tier set by hand.
 *    A trial grants Team through `trialTier` on top of STARTER, so a running trial is never converted.
 *    The page used to have its own rule (ACTIVE, no trial running, a paid tier or a subscription),
 *    which disagreed with Revenue about every converted workspace that later lapsed to grace.
 *  - "Converted of N" is counted here over EVERY self-serve workspace in the period. The page used to
 *    count it in the browser from the hundred rows listed, so past a hundred signups it was wrong.
 *  - Seats are the LATEST usage snapshot (org-usage-snapshot.worker.ts) and null before the first —
 *    a workspace created this morning has not been measured, which is not the same as zero people.
 *  - Self-serve vs console is Organization.createdVia; anything not SELF_SERVE (including rows from
 *    before the column existed and were backfilled) counts as console-made.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { companyDomainOf } from "../utils/company-domain.js";
import { platformDayKey, platformWeekStartKey, shiftDayKey } from "../utils/platform-time.js";
import { isConverted } from "./trial-conversion.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIODS = [7, 30, 90] as const;
export type SignupPeriod = (typeof PERIODS)[number];

export interface SignupAnalytics {
  days: SignupPeriod;
  /** People, not rows. `codeSent` is the cohort; every later step counts cohort members who reached
   *  it AND the step before it, so no rate exceeds 100%. `existingMembers` verified only to reach a
   *  workspace they already belong to. `refused` is people refused before a code went out — outside
   *  the cohort by definition. */
  funnel: { codeSent: number; verified: number; existingMembers: number; created: number; joinRequested: number; unavailable: number; refused: number; failed: number };
  byDay: Array<{ day: string; selfServe: number; console: number }>;
  /** Every self-serve workspace created in the period, and how many of them have converted. */
  selfServe: { total: number; converted: number };
  /** The newest self-serve workspaces, at most `RECENT_LIMIT`. A list, not the population: counts
   *  come from `selfServe`. */
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

/** The steps after verification, as the funnel key each one is counted under. */
const AFTER_VERIFIED: Array<[string, keyof SignupAnalytics["funnel"]]> = [
  ["EXISTING_MEMBER", "existingMembers"],
  ["CREATED", "created"],
  ["JOIN_REQUESTED", "joinRequested"],
  ["UNAVAILABLE", "unavailable"],
  ["FAILED", "failed"]
];

/** Days are the platform's (Asia/Kolkata by default), never UTC's — see utils/platform-time.ts. */
const dayKey = platformDayKey;

type DomainStageCount = { stage: string; domain: string | null; _count: { _all: number } };
type CreatedOrg = {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  createdVia: string | null;
  createdAt: Date;
  status: string;
  planTier: string;
  trialTier: string | null;
  trialEndsAt: Date | null;
  stripeSubscriptionId: string | null;
};

/** How many self-serve workspaces the page lists. The counts above it are over all of them. */
const RECENT_LIMIT = 100;

/**
 * The funnel as people. The cohort is every hash whose FIRST `CODE_SENT` ever falls inside the
 * period — someone who first asked for a code last month and verified this week belongs to last
 * month's cohort, not this one. Each later step is counted among the cohort members who verified,
 * so a step can never exceed the one before it. Rows with no hash (none are written today) cannot be
 * told apart and are left out.
 */
async function peopleFunnel(gte: Date): Promise<SignupAnalytics["funnel"]> {
  const [firstCodes, refusedPeople] = await Promise.all([
    controlPrisma.signupAttempt.groupBy({
      by: ["emailHash"],
      where: { stage: "CODE_SENT", emailHash: { not: null } },
      _min: { createdAt: true },
      having: { createdAt: { _min: { gte } } }
    }),
    controlPrisma.signupAttempt.groupBy({ by: ["emailHash"], where: { stage: "REFUSED", emailHash: { not: null }, createdAt: { gte } }, _count: { _all: true } })
  ]);
  const cohort = firstCodes.map((row) => row.emailHash).filter((hash): hash is string => hash !== null);
  const funnel: SignupAnalytics["funnel"] = { codeSent: cohort.length, verified: 0, existingMembers: 0, created: 0, joinRequested: 0, unavailable: 0, refused: refusedPeople.length, failed: 0 };
  if (cohort.length === 0) return funnel;

  const reached = await controlPrisma.signupAttempt.findMany({
    where: { emailHash: { in: cohort }, stage: { in: ["VERIFIED", ...AFTER_VERIFIED.map(([stage]) => stage)] } },
    select: { emailHash: true, stage: true },
    distinct: ["emailHash", "stage"]
  });
  const peopleAt = (stage: string) => new Set(reached.filter((row) => row.stage === stage).map((row) => row.emailHash));
  const verified = peopleAt("VERIFIED");
  funnel.verified = verified.size;
  for (const [stage, key] of AFTER_VERIFIED) funnel[key] = [...peopleAt(stage)].filter((hash) => verified.has(hash)).length;
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
    converted: isConverted(o),
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
 *
 * THE WEEKS ARE CALENDAR WEEKS, Monday to Sunday in the platform's zone, each labelled by its Monday;
 * the last is this week so far. They were rolling 168-hour windows counted back from "now", so every
 * bucket shifted on every refetch and none of them was a week anybody could name.
 */
export function overviewSignups(orgs: Array<{ createdVia: string | null; createdAt: Date }>, now: Date) {
  const split = (from: Date, to: Date) => {
    const inRange = orgs.filter((o) => o.createdAt >= from && o.createdAt < to);
    const selfServe = inRange.filter((o) => o.createdVia === "SELF_SERVE").length;
    return { selfServe, console: inRange.length - selfServe };
  };
  const thisWeek = platformWeekStartKey(now);
  // Twelve weeks — enough to see a trend, not so many the chart is noise.
  const signupsByWeek = Array.from({ length: 12 }, (_, i) => ({ week: shiftDayKey(thisWeek, (i - 11) * 7), selfServe: 0, console: 0 }));
  const byWeek = new Map(signupsByWeek.map((bucket) => [bucket.week, bucket]));
  for (const o of orgs) {
    const bucket = byWeek.get(platformWeekStartKey(o.createdAt));
    if (!bucket) continue;
    if (o.createdVia === "SELF_SERVE") bucket.selfServe += 1;
    else bucket.console += 1;
  }
  return { signups30: split(new Date(now.getTime() - 30 * DAY_MS), new Date(now.getTime() + 1)), signupsByWeek };
}

export async function getSignupAnalytics(requestedDays: number, now = new Date()): Promise<SignupAnalytics> {
  const days = clampSignupPeriod(requestedDays);
  const gte = new Date(now.getTime() - days * DAY_MS);

  const [funnel, failures, created, domainStages] = await Promise.all([
    peopleFunnel(gte),
    controlPrisma.signupAttempt.findMany({
      where: { stage: "FAILED", createdAt: { gte } },
      select: { createdAt: true, domain: true, detail: true },
      orderBy: { createdAt: "desc" },
      take: 50
    }),
    controlPrisma.organization.findMany({
      where: { createdAt: { gte } },
      select: { id: true, name: true, slug: true, ownerEmail: true, createdVia: true, createdAt: true, status: true, planTier: true, trialTier: true, trialEndsAt: true, stripeSubscriptionId: true },
      orderBy: { createdAt: "desc" }
    }),
    controlPrisma.signupAttempt.groupBy({ by: ["domain", "stage"], where: { createdAt: { gte }, domain: { not: null } }, _count: { _all: true } })
  ]);

  const selfServe = created.filter((o) => o.createdVia === "SELF_SERVE");
  const listed = selfServe.slice(0, RECENT_LIMIT);
  const seats = await latestSeatsFor(listed.map((o) => o.id));
  return {
    days,
    funnel,
    byDay: byDayFrom(created, days, now),
    selfServe: { total: selfServe.length, converted: selfServe.filter(isConverted).length },
    recent: listed.map((o) => recentRow(o, seats, now)),
    failures: failures.map((f) => ({ at: f.createdAt.toISOString(), domain: f.domain, detail: f.detail })),
    topDomains: topDomainsFrom(domainStages)
  };
}
