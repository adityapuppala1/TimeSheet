/**
 * WHAT: the money and the time the platform console could not see — MRR, ARR, ARPA, revenue by
 * tier, trial→paid conversion, logo and revenue churn, net revenue retention, and a
 * cohort-by-signup-month retention table.
 *
 * IT READS SNAPSHOTS, NEVER TENANTS. Every function here queries the CONTROL database only:
 * `OrgUsageSnapshot`, `Organization`, `PlanTierLimit`, `BackupRun`. It opens no tenant connection
 * and cannot — that boundary belongs to `platform-admin-analytics.service.ts`, which is the single
 * audited place in this codebase permitted to loop tenant databases, and which writes the snapshots
 * this file reads. Nothing here can reach a ticket title, a comment or a person, by construction
 * rather than by discipline.
 *
 * EVERY FIGURE IS LIST PRICE, NOT BILLED REVENUE, AND THE UI SAYS SO. There is one price in this
 * product — `PlanTierLimit.listPricePerSeatMinor`, which an operator edits and which the landing
 * page's pricing cards render from the same shared constant. A customer on a discount, an annual
 * commitment or a negotiated Enterprise contract pays something else. Presenting a list-price MRR
 * as revenue would be a number an operator quotes to a board, so every response from this file
 * carries `basis: "list-price"` and the console labels it. Where Stripe is configured the console
 * may additionally show the gap against real subscription amounts — see `reconcileAgainstStripe`
 * below, which is optional and degrades to nothing when Stripe is not configured, the common case.
 *
 * AN UNSET PRICE IS NOT ZERO. Enterprise has no list price on purpose. Those workspaces are
 * EXCLUDED from the MRR total and counted in `unpricedAccounts`, never summed as zero — a
 * confident $0 next to a deployment's largest customers is worse than an honest gap.
 *
 * THE HISTORY IS SHORT AND STAYS SHORT FOR A WHILE. Snapshots begin the night the feature ships;
 * there is nothing to backfill, because every figure they hold is a point-in-time count of mutable
 * tenant state. Every function below therefore returns `null` rather than a number when the window
 * it was asked about contains too little to divide by, and the console renders those as "not enough
 * history yet" rather than as 0%.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { MIN_TREND_SNAPSHOTS, scoreAccountHealth, selectSeatOverage, type AccountHealth, type SeatOverageRow, type SeatUsageRow } from "./platform-account-health.js";

/** Every figure this service produces is derived from an operator-editable LIST price. Carried in
 *  the payload rather than assumed by the client, so a future billed-revenue source can be added
 *  without any screen silently changing what its numbers mean. */
export const REVENUE_BASIS = "list-price" as const;

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------------------------------ */
/* Pure: pricing one account                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface TierPrice {
  /** Per seat per month, minor units. `null` = this tier has no list price. */
  perSeatMinor: number | null;
  currency: string;
}

export type TierPrices = Record<string, TierPrice>;

/** One workspace as the revenue functions see it — a day's snapshot plus its identity. */
export interface RevenueAccount {
  orgId: string;
  slug: string;
  name: string;
  planTier: string;
  status: string;
  /** Active, non-agent users. The only seats anybody is ever billed for. */
  activeSeats: number;
  /** Automation identities. Present so the exclusion is VISIBLE and testable, never so it can be
   *  added in. */
  agentSeats: number;
  /** True while a trial clock is still running — a trialling workspace is pipeline, not revenue. */
  trialing: boolean;
  subscribed: boolean;
}

/**
 * The seats a workspace is BILLED for.
 *
 * ONE LINE, AND IT EARNS ITS OWN FUNCTION. An agent's identity is a real `User` row precisely so
 * that assignment, workload, audit and attestation keep working unchanged — it is not a person,
 * nobody signs in as it, and pricing it would turn the agent roster into a per-agent upsell by
 * accident. Written here rather than inlined into the sum so that "MRR never bills a robot" is a
 * property one test can break, rather than a comment three call sites are trusted to have read.
 */
export function billableSeats(account: Pick<RevenueAccount, "activeSeats" | "agentSeats">): number {
  return account.activeSeats;
}

/**
 * Whether an account contributes list revenue at all.
 *
 * ACTIVE and not trialling. A GRACE, SUSPENDED or ARCHIVED workspace is not paying, and counting a
 * live trial as revenue is how a pipeline gets mistaken for a business.
 */
export function isRevenueBearing(account: RevenueAccount): boolean {
  return account.status === "ACTIVE" && !account.trialing;
}

/** One account's list MRR in minor units, or `null` when its tier has no list price. */
export function accountMrrMinor(account: RevenueAccount, prices: TierPrices): number | null {
  if (!isRevenueBearing(account)) return 0;
  const price = prices[account.planTier];
  if (!price || price.perSeatMinor === null) return null;
  return price.perSeatMinor * billableSeats(account);
}

/* ------------------------------------------------------------------------------------------ */
/* Pure: MRR / ARR / ARPA                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface TierRevenue {
  tier: string;
  accounts: number;
  seats: number;
  /** Null when the tier has no list price — never 0. */
  mrrMinor: number | null;
  perSeatMinor: number | null;
}

export interface MrrBreakdown {
  basis: typeof REVENUE_BASIS;
  currency: string;
  /** True when priced tiers disagree about currency. The sum is then meaningless and the console
   *  says so instead of quietly adding dollars to euros. */
  mixedCurrencies: boolean;
  mrrMinor: number;
  arrMinor: number;
  /** MRR ÷ paying accounts. Null when there are none — not 0, which would read as "our customers
   *  pay nothing" rather than "we have no paying customers". */
  arpaMinor: number | null;
  /** Revenue-bearing accounts on a tier whose list price is above zero. */
  payingAccounts: number;
  /** Revenue-bearing accounts on a tier priced at exactly zero (Starter). Free is not unpriced. */
  freeAccounts: number;
  /** Revenue-bearing accounts whose tier has NO list price (Enterprise). Excluded from `mrrMinor`
   *  and stated here so the exclusion is visible rather than silent. */
  unpricedAccounts: number;
  unpricedSeats: number;
  billableSeats: number;
  trialingAccounts: number;
  byTier: TierRevenue[];
}

export function computeListMrr(accounts: RevenueAccount[], prices: TierPrices): MrrBreakdown {
  const currencies = new Set(Object.values(prices).filter((price) => price.perSeatMinor !== null).map((price) => price.currency));

  let mrrMinor = 0;
  let payingAccounts = 0;
  let freeAccounts = 0;
  let unpricedAccounts = 0;
  let unpricedSeats = 0;
  let seats = 0;
  let trialingAccounts = 0;

  const tiers = new Map<string, { accounts: number; seats: number; mrrMinor: number | null }>();

  for (const account of accounts) {
    if (account.trialing) trialingAccounts += 1;
    if (!isRevenueBearing(account)) continue;

    const accountSeats = billableSeats(account);
    const price = prices[account.planTier];
    seats += accountSeats;

    const bucket = tiers.get(account.planTier) ?? { accounts: 0, seats: 0, mrrMinor: price && price.perSeatMinor !== null ? 0 : null };
    bucket.accounts += 1;
    bucket.seats += accountSeats;

    if (!price || price.perSeatMinor === null) {
      unpricedAccounts += 1;
      unpricedSeats += accountSeats;
      bucket.mrrMinor = null;
    } else {
      const amount = price.perSeatMinor * accountSeats;
      mrrMinor += amount;
      if (price.perSeatMinor > 0) payingAccounts += 1;
      else freeAccounts += 1;
      if (bucket.mrrMinor !== null) bucket.mrrMinor += amount;
    }
    tiers.set(account.planTier, bucket);
  }

  return {
    basis: REVENUE_BASIS,
    currency: [...currencies][0] ?? "USD",
    mixedCurrencies: currencies.size > 1,
    mrrMinor,
    arrMinor: mrrMinor * 12,
    // Rounded to the minor unit: an ARPA of 833.333 cents is a false precision an operator would
    // read as exact. Guarded, because dividing by zero paying accounts yields Infinity, not an error.
    arpaMinor: payingAccounts > 0 ? Math.round(mrrMinor / payingAccounts) : null,
    payingAccounts,
    freeAccounts,
    unpricedAccounts,
    unpricedSeats,
    billableSeats: seats,
    trialingAccounts,
    byTier: [...tiers.entries()]
      .map(([tier, bucket]) => ({ tier, ...bucket, perSeatMinor: prices[tier]?.perSeatMinor ?? null }))
      .sort((a, b) => (b.mrrMinor ?? -1) - (a.mrrMinor ?? -1))
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Pure: churn and retention                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface ChurnWindow {
  basis: typeof REVENUE_BASIS;
  /** How many days the comparison actually spans. 0 means there is one day of history and every
   *  figure below is null — which is the honest answer, not zero churn. */
  windowDays: number;
  startAccounts: number;
  endAccounts: number;
  churnedAccounts: number;
  newAccounts: number;
  startMrrMinor: number;
  /** What the START cohort is worth at the END. The numerator of NRR. */
  retainedMrrMinor: number;
  expansionMinor: number;
  contractionMinor: number;
  churnedMrrMinor: number;
  /** Percentages, all null when their denominator is zero rather than 0 — "no customers churned"
   *  and "we had no customers" are different sentences. */
  logoChurnPercent: number | null;
  revenueChurnPercent: number | null;
  netRevenueRetentionPercent: number | null;
  grossRevenueRetentionPercent: number | null;
}

const percent = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;

/**
 * Churn and retention between two observations of the same fleet.
 *
 * THE COHORT IS THE ACCOUNTS THAT WERE REVENUE-BEARING AT THE START. Everything is measured about
 * them: an account that both arrived and left inside the window is `new` and never joins the churn
 * denominator, which is the standard treatment and the one that stops a good month of signups
 * flattering the churn rate.
 *
 * NRR counts the start cohort's value at the END — expansion and contraction included, churn
 * included, new logos excluded. GRR is the same without the expansion, which is why the two are
 * reported side by side: NRR above 100% with GRR well below it is a business growing on its
 * existing customers while quietly losing others, and one number alone hides that.
 *
 * UNPRICED (Enterprise) ACCOUNTS COUNT AS LOGOS AND NOT AS REVENUE. They have no list price, so
 * they contribute nothing to either side of the revenue ratios. That is stated in the console
 * beside the number, because a deployment whose largest customers are all Enterprise has a revenue
 * churn figure that describes a minority of its business.
 */
export function computeChurn(start: RevenueAccount[], end: RevenueAccount[], prices: TierPrices, windowDays: number): ChurnWindow {
  const startBearing = start.filter(isRevenueBearing);
  const endBearing = end.filter(isRevenueBearing);
  const endById = new Map(endBearing.map((account) => [account.orgId, account]));
  const startIds = new Set(startBearing.map((account) => account.orgId));

  const mrrOf = (account: RevenueAccount) => accountMrrMinor(account, prices) ?? 0;

  let startMrrMinor = 0;
  let retainedMrrMinor = 0;
  let expansionMinor = 0;
  let contractionMinor = 0;
  let churnedMrrMinor = 0;
  let churnedAccounts = 0;

  for (const account of startBearing) {
    const before = mrrOf(account);
    startMrrMinor += before;
    const after = endById.get(account.orgId);
    if (!after) {
      churnedAccounts += 1;
      churnedMrrMinor += before;
      continue;
    }
    const now = mrrOf(after);
    retainedMrrMinor += now;
    if (now > before) expansionMinor += now - before;
    else if (now < before) contractionMinor += before - now;
  }

  const newAccounts = endBearing.filter((account) => !startIds.has(account.orgId)).length;

  // A window with no span is not a window. Reporting 0% churn off one observation is the exact
  // dishonesty this whole module's header warns about, so everything derived goes null.
  const comparable = windowDays > 0 && startBearing.length > 0;

  return {
    basis: REVENUE_BASIS,
    windowDays,
    startAccounts: startBearing.length,
    endAccounts: endBearing.length,
    churnedAccounts,
    newAccounts,
    startMrrMinor,
    retainedMrrMinor,
    expansionMinor,
    contractionMinor,
    churnedMrrMinor,
    logoChurnPercent: comparable ? percent(churnedAccounts, startBearing.length) : null,
    revenueChurnPercent: comparable ? percent(churnedMrrMinor + contractionMinor, startMrrMinor) : null,
    netRevenueRetentionPercent: comparable ? percent(retainedMrrMinor, startMrrMinor) : null,
    grossRevenueRetentionPercent: comparable ? percent(startMrrMinor - churnedMrrMinor - contractionMinor, startMrrMinor) : null
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Pure: trial → paid                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface TrialLifecycle {
  orgId: string;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  status: string;
  subscribed: boolean;
  /** When the workspace became a customer, if it is known — read from `PlatformAuditLog`. Null on
   *  a conversion that predates the audit trail, or one done by hand with no logged action. */
  convertedAt: Date | null;
}

export interface TrialConversion {
  trialsStarted: number;
  converted: number;
  lapsed: number;
  stillTrialing: number;
  /** Over DECIDED trials only — converted ÷ (converted + lapsed). Trials still running are
   *  excluded from the denominator on purpose: counting them as failures understates the rate for
   *  as long as they run, which makes the number swing on nothing but the calendar. */
  conversionPercent: number | null;
  /** Median, not mean: one workspace that converted after a year would drag an average nowhere
   *  useful. Null when nothing with a known conversion date has converted. */
  medianDaysToConvert: number | null;
}

/**
 * Trial→paid, derived entirely from columns that already exist.
 *
 * WHAT COUNTS AS A CONVERSION, and why it is not simply "has a Stripe subscription": the very
 * common deployment here has no Stripe account at all and assigns tiers by hand. A workspace that
 * was still ACTIVE after its trial ended is a customer in exactly the way that matters, so both
 * routes count. A workspace that ended its trial and slid into GRACE, SUSPENDED or ARCHIVED lapsed.
 */
export function computeTrialConversion(lifecycles: TrialLifecycle[], now = new Date()): TrialConversion {
  const trials = lifecycles.filter((row) => row.trialStartedAt !== null);
  let converted = 0;
  let lapsed = 0;
  let stillTrialing = 0;
  const daysToConvert: number[] = [];

  for (const row of trials) {
    const running = row.trialEndsAt !== null && row.trialEndsAt.getTime() > now.getTime();
    const isCustomer = row.subscribed || (row.status === "ACTIVE" && !running);

    if (isCustomer) {
      converted += 1;
      if (row.convertedAt && row.trialStartedAt) {
        daysToConvert.push((row.convertedAt.getTime() - row.trialStartedAt.getTime()) / DAY_MS);
      }
    } else if (running) {
      stillTrialing += 1;
    } else {
      lapsed += 1;
    }
  }

  const decided = converted + lapsed;
  daysToConvert.sort((a, b) => a - b);
  const middle = Math.floor(daysToConvert.length / 2);

  return {
    trialsStarted: trials.length,
    converted,
    lapsed,
    stillTrialing,
    conversionPercent: decided > 0 ? Math.round((converted / decided) * 1000) / 10 : null,
    medianDaysToConvert: daysToConvert.length
      ? Math.round(daysToConvert.length % 2 === 1 ? daysToConvert[middle] : (daysToConvert[middle - 1] + daysToConvert[middle]) / 2)
      : null
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Pure: cohort retention by signup month                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface CohortOrg {
  orgId: string;
  createdAt: Date;
  /** The `YYYY-MM` months in which this workspace was observed alive — ACTIVE with at least one
   *  active seat — according to the snapshots. */
  activeMonths: Set<string>;
}

export interface CohortCell {
  monthOffset: number;
  /** Null when no snapshot covers that month at all, which is the normal state for every month
   *  before this feature shipped. Rendering it as 0% would report a mass churn that never happened. */
  retained: number | null;
  percent: number | null;
}

export interface CohortRow {
  /** `YYYY-MM` of signup. */
  cohort: string;
  signedUp: number;
  cells: CohortCell[];
}

export interface CohortTable {
  rows: CohortRow[];
  maxOffset: number;
  /** The months the snapshot series actually covers. Everything outside this is `null`, not zero,
   *  and the console prints this range so the gaps explain themselves. */
  observedFrom: string | null;
  observedTo: string | null;
}

/** `YYYY-MM` in UTC. Deliberately UTC everywhere in this module: a deployment that moves timezone
 *  must not reshuffle which cohort a customer belongs to. */
export function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

function addMonths(key: string, offset: number): string {
  const [year, month] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return monthKey(date);
}

/**
 * Retention by signup month.
 *
 * A CELL IS NULL, NOT ZERO, WHEN NOTHING WAS OBSERVED. The snapshot series starts the night this
 * shipped and cannot be backfilled, so every month before that is genuinely unknown. A table that
 * printed 0% for those would show a catastrophic churn event that never happened, on the screen
 * most likely to be shown to somebody making a decision.
 */
export function buildSignupCohorts(orgs: CohortOrg[], observed: { from: string | null; to: string | null }, maxOffset = 12): CohortTable {
  const byCohort = new Map<string, CohortOrg[]>();
  for (const org of orgs) {
    const key = monthKey(org.createdAt);
    const bucket = byCohort.get(key) ?? [];
    bucket.push(org);
    byCohort.set(key, bucket);
  }

  const inWindow = (month: string) => observed.from !== null && observed.to !== null && month >= observed.from && month <= observed.to;

  const rows: CohortRow[] = [...byCohort.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([cohort, members]) => ({
      cohort,
      signedUp: members.length,
      cells: Array.from({ length: maxOffset + 1 }, (_, monthOffset) => {
        const month = addMonths(cohort, monthOffset);
        if (!inWindow(month)) return { monthOffset, retained: null, percent: null };
        const retained = members.filter((member) => member.activeMonths.has(month)).length;
        return { monthOffset, retained, percent: members.length > 0 ? Math.round((retained / members.length) * 1000) / 10 : null };
      })
    }));

  return { rows, maxOffset, observedFrom: observed.from, observedTo: observed.to };
}

/* ------------------------------------------------------------------------------------------ */
/* Readers — control plane only                                                                */
/* ------------------------------------------------------------------------------------------ */

/** The operator-editable list prices, as the pure functions want them. */
export async function getTierPrices(): Promise<TierPrices> {
  const rows = await controlPrisma.planTierLimit.findMany();
  return Object.fromEntries(
    rows.map((row) => [String(row.tier), { perSeatMinor: row.listPricePerSeatMinor ?? null, currency: row.listPriceCurrency ?? "USD" }])
  );
}

type SnapshotRow = Awaited<ReturnType<typeof controlPrisma.orgUsageSnapshot.findMany>>[number];

/** A snapshot row plus its workspace's identity, as a `RevenueAccount`. `trialing` is decided
 *  against the day the snapshot describes, not against now — that is the whole reason the trial
 *  columns are carried on the row. */
function toAccount(row: SnapshotRow, org: { slug: string; name: string }): RevenueAccount {
  return {
    orgId: row.organizationId,
    slug: org.slug,
    name: org.name,
    planTier: row.planTier,
    status: row.status,
    activeSeats: row.activeSeats,
    agentSeats: row.agentSeats,
    trialing: row.trialEndsAt !== null && row.trialEndsAt.getTime() > row.day.getTime(),
    subscribed: Boolean(row.stripeSubscriptionId)
  };
}

/** The most recent snapshot per workspace, and the earliest one inside `since`. One query, split in
 *  memory: two `DISTINCT ON`-shaped queries is two full scans of the same window. */
async function windowEdges(since: Date) {
  const rows = await controlPrisma.orgUsageSnapshot.findMany({ where: { day: { gte: since } }, orderBy: { day: "asc" } });
  const first = new Map<string, SnapshotRow>();
  const last = new Map<string, SnapshotRow>();
  for (const row of rows) {
    if (!first.has(row.organizationId)) first.set(row.organizationId, row);
    last.set(row.organizationId, row);
  }
  return { rows, first, last };
}

export interface RevenueOverview {
  basis: typeof REVENUE_BASIS;
  /** What the snapshot series actually covers, so every screen can be honest about a short history
   *  instead of each one deciding for itself. */
  coverage: { days: number; firstDay: string | null; lastDay: string | null; snapshots: number };
  mrr: MrrBreakdown;
  churn: ChurnWindow;
  trials: TrialConversion;
  cohorts: CohortTable;
  seatOverage: SeatOverageRow[];
  /** Set only when Stripe is configured AND the reconciliation could be computed. Null otherwise,
   *  which is the common case and is not an error. */
  stripe: StripeReconciliation | null;
}

/**
 * Everything the revenue screen shows, in one control-plane read.
 *
 * `windowDays` is the churn/retention comparison window. It is clamped to what the snapshot series
 * actually covers, and the coverage is returned so the console can say "28 of the 30 days you asked
 * for" rather than pretending it had them.
 */
export async function getRevenueOverview(windowDays = 30): Promise<RevenueOverview> {
  const now = new Date();
  const since = new Date(now.getTime() - windowDays * DAY_MS);

  const [prices, orgs, { rows, first, last }] = await Promise.all([
    getTierPrices(),
    controlPrisma.organization.findMany({ select: { id: true, slug: true, name: true, createdAt: true, status: true, trialStartedAt: true, trialEndsAt: true, stripeSubscriptionId: true } }),
    windowEdges(since)
  ]);

  const orgById = new Map(orgs.map((org) => [org.id, org]));
  const identify = (row: SnapshotRow) => orgById.get(row.organizationId) ?? { slug: row.organizationId, name: row.organizationId };

  const startAccounts = [...first.values()].map((row) => toAccount(row, identify(row)));
  const endAccounts = [...last.values()].map((row) => toAccount(row, identify(row)));

  const days = [...new Set(rows.map((row) => row.day.getTime()))].sort((a, b) => a - b);
  const spanDays = days.length >= 2 ? Math.round((days[days.length - 1] - days[0]) / DAY_MS) : 0;

  // Cohort membership: a workspace counts as alive in a month if any snapshot that month found it
  // ACTIVE with at least one seat in use. "ACTIVE with nobody in it" is not retention.
  const activeMonths = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.status !== "ACTIVE" || row.activeSeats <= 0) continue;
    const set = activeMonths.get(row.organizationId) ?? new Set<string>();
    set.add(monthKey(row.day));
    activeMonths.set(row.organizationId, set);
  }
  // Cohorts want the WHOLE observed history, not the churn window — a 30-day window would make
  // every cohort a single column.
  const [firstEver, lastEver] = await Promise.all([
    controlPrisma.orgUsageSnapshot.findFirst({ orderBy: { day: "asc" }, select: { day: true } }),
    controlPrisma.orgUsageSnapshot.findFirst({ orderBy: { day: "desc" }, select: { day: true } })
  ]);
  const allActive = await loadActiveMonths();

  const seatRows: SeatUsageRow[] = endAccounts.map((account) => {
    const row = last.get(account.orgId)!;
    return { orgId: account.orgId, slug: account.slug, name: account.name, planTier: account.planTier, status: account.status, seatsUsed: row.activeSeats, seatLimit: row.seatLimit };
  });

  // Computed ONCE and handed to the reconciliation: it is the same fleet, and computing it twice
  // is how two figures on the same screen end up disagreeing after somebody edits one call site.
  const mrr = computeListMrr(endAccounts, prices);

  return {
    basis: REVENUE_BASIS,
    coverage: {
      days: spanDays,
      firstDay: firstEver?.day.toISOString() ?? null,
      lastDay: lastEver?.day.toISOString() ?? null,
      snapshots: rows.length
    },
    mrr,
    churn: computeChurn(startAccounts, endAccounts, prices, spanDays),
    trials: computeTrialConversion(await loadTrialLifecycles(orgs), now),
    cohorts: buildSignupCohorts(
      orgs.map((org) => ({ orgId: org.id, createdAt: org.createdAt, activeMonths: allActive.get(org.id) ?? new Set<string>() })),
      { from: firstEver ? monthKey(firstEver.day) : null, to: lastEver ? monthKey(lastEver.day) : null }
    ),
    seatOverage: selectSeatOverage(seatRows),
    stripe: await reconcileAgainstStripe(mrr)
  };
}

/** Every month each workspace was observed alive, across the WHOLE series. Selected narrowly — a
 *  cohort table over three years of daily rows must not pull the whole table into memory. */
async function loadActiveMonths(): Promise<Map<string, Set<string>>> {
  const rows = await controlPrisma.orgUsageSnapshot.findMany({
    where: { status: "ACTIVE", activeSeats: { gt: 0 } },
    select: { organizationId: true, day: true }
  });
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = out.get(row.organizationId) ?? new Set<string>();
    set.add(monthKey(row.day));
    out.set(row.organizationId, set);
  }
  return out;
}

/**
 * The trial lifecycle, from `Organization` plus the audit trail.
 *
 * `convertedAt` comes from `PlatformAuditLog` because that is where a plan change is recorded —
 * both the Stripe webhook's and a platform admin's manual move. It is genuinely absent for
 * conversions that predate the audit trail, and the median simply excludes those rather than
 * guessing a date.
 */
async function loadTrialLifecycles(
  orgs: Array<{ id: string; status: string; trialStartedAt: Date | null; trialEndsAt: Date | null; stripeSubscriptionId: string | null }>
): Promise<TrialLifecycle[]> {
  const trialOrgIds = orgs.filter((org) => org.trialStartedAt !== null).map((org) => org.id);
  const conversions = trialOrgIds.length
    ? await controlPrisma.platformAuditLog.findMany({
        where: { entity: "Organization", entityId: { in: trialOrgIds }, action: { in: ["organization.plan_changed", "org.plan_changed", "billing.subscription_active", "plan_tier.assigned"] } },
        orderBy: { createdAt: "asc" },
        select: { entityId: true, createdAt: true }
      })
    : [];
  const convertedAt = new Map<string, Date>();
  for (const row of conversions) {
    if (row.entityId && !convertedAt.has(row.entityId)) convertedAt.set(row.entityId, row.createdAt);
  }

  return orgs.map((org) => ({
    orgId: org.id,
    trialStartedAt: org.trialStartedAt,
    trialEndsAt: org.trialEndsAt,
    status: org.status,
    subscribed: Boolean(org.stripeSubscriptionId),
    convertedAt: convertedAt.get(org.id) ?? null
  }));
}

/* ------------------------------------------------------------------------------------------ */
/* Optional: the gap between list price and what Stripe actually bills                         */
/* ------------------------------------------------------------------------------------------ */

export interface StripeReconciliation {
  /** How many workspaces carry a Stripe subscription at all. */
  subscribedAccounts: number;
  /** Their list-price MRR — the only half this deployment can compute without calling Stripe. */
  listMrrMinor: number;
  /** Reserved for a future live read of the real subscription amounts. Null means "not fetched",
   *  and the console renders it as such rather than as a zero gap. */
  billedMrrMinor: number | null;
  discountMinor: number | null;
  note: string;
}

/**
 * The gap between list price and billed revenue, WHEN it can be known.
 *
 * That gap IS discounting, and it is worth seeing: a deployment whose billed MRR sits 18% under its
 * list MRR is one where every deal is being closed on a discount nobody decided to standardise.
 *
 * IT DEGRADES TO NOTHING, DELIBERATELY. Most installations have no Stripe account — they assign
 * tiers by hand — and this returns `null` for them, which is not an error and not a zero. Even when
 * Stripe IS configured this does not call it: an outbound HTTP request per page load, on a screen
 * an operator refreshes, is a rate limit waiting to happen. It reports the subscribed population
 * and their list value, and leaves `billedMrrMinor` null with a note saying why. Filling it in is a
 * reconciliation job, not a page render — that is the honest place for it and it is not built yet.
 */
export async function reconcileAgainstStripe(mrr: MrrBreakdown): Promise<StripeReconciliation | null> {
  const settings = await controlPrisma.platformBillingSettings.findUnique({ where: { id: "global" } }).catch(() => null);
  if (!settings?.encryptedSecretKey) return null;

  const subscribed = await controlPrisma.organization.count({ where: { stripeSubscriptionId: { not: null }, status: "ACTIVE" } });
  return {
    subscribedAccounts: subscribed,
    listMrrMinor: mrr.mrrMinor,
    billedMrrMinor: null,
    discountMinor: null,
    note: "Stripe is configured, but billed amounts are not fetched on page load — that is a reconciliation job, not a render. Everything shown is list price."
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Account health, across the fleet                                                            */
/* ------------------------------------------------------------------------------------------ */

export interface AccountHealthRow {
  orgId: string;
  slug: string;
  name: string;
  planTier: string;
  status: string;
  seatsUsed: number;
  seatLimit: number;
  aiSpendUsd: number;
  aiBudgetCeilingUsd: number;
  daysSinceLastActivity: number | null;
  health: AccountHealth;
}

/**
 * Health for every workspace, from snapshots plus backup outcomes.
 *
 * NO TENANT CONNECTIONS. Everything here was written down by the nightly sweep, so this screen
 * costs one control-plane query set however many customers the deployment has — which is the whole
 * reason the snapshot table exists.
 */
export async function getFleetAccountHealth(windowDays = 30): Promise<{ rows: AccountHealthRow[]; coverage: { firstDay: string | null; lastDay: string | null }; seatOverage: SeatOverageRow[] }> {
  const now = new Date();
  const since = new Date(now.getTime() - windowDays * DAY_MS);

  const [orgs, snapshots, backupFailures] = await Promise.all([
    controlPrisma.organization.findMany({ select: { id: true, slug: true, name: true, trialEndsAt: true } }),
    controlPrisma.orgUsageSnapshot.findMany({ where: { day: { gte: since } }, orderBy: { day: "asc" } }),
    controlPrisma.backupRun.groupBy({ by: ["organizationId"], where: { status: "FAILED", startedAt: { gte: since } }, _count: { _all: true } })
  ]);

  const failuresByOrg = new Map(backupFailures.map((row) => [row.organizationId, row._count._all]));
  const byOrg = new Map<string, SnapshotRow[]>();
  for (const row of snapshots) {
    const bucket = byOrg.get(row.organizationId) ?? [];
    bucket.push(row);
    byOrg.set(row.organizationId, bucket);
  }

  const rows: AccountHealthRow[] = [];
  for (const org of orgs) {
    const series = byOrg.get(org.id) ?? [];
    const latest = series[series.length - 1];
    // A workspace with no snapshot yet is not scored: there is genuinely nothing to score it on,
    // and inventing a HEALTHY for it would be the most misleading row on the page.
    if (!latest) continue;

    const velocity = ticketVelocity(series);
    rows.push({
      orgId: org.id,
      slug: org.slug,
      name: org.name,
      planTier: latest.planTier,
      status: latest.status,
      seatsUsed: latest.activeSeats,
      seatLimit: latest.seatLimit,
      aiSpendUsd: Number(latest.aiSpendMonthToDateUsd),
      aiBudgetCeilingUsd: Number(latest.aiBudgetCeilingUsd),
      daysSinceLastActivity: latest.lastActivityAt ? Math.floor((now.getTime() - latest.lastActivityAt.getTime()) / DAY_MS) : null,
      health: scoreAccountHealth({
        status: latest.status,
        reachable: latest.reachable,
        seatsUsed: latest.activeSeats,
        seatLimit: latest.seatLimit,
        aiSpendUsd: Number(latest.aiSpendMonthToDateUsd),
        aiBudgetCeilingUsd: Number(latest.aiBudgetCeilingUsd),
        daysSinceLastActivity: latest.lastActivityAt ? Math.floor((now.getTime() - latest.lastActivityAt.getTime()) / DAY_MS) : null,
        ticketsPerDayRecent: velocity.recent,
        ticketsPerDayPrior: velocity.prior,
        emailsSent: latest.emailsSentMonthToDate,
        emailsFailed: latest.emailsFailedMonthToDate,
        backupFailures: failuresByOrg.get(org.id) ?? 0,
        trialDaysRemaining: org.trialEndsAt ? (org.trialEndsAt.getTime() - now.getTime()) / DAY_MS : null,
        snapshots: series.length
      })
    });
  }

  // At-risk first, then expansion, then healthy — the order the work is in.
  const bandRank = { AT_RISK: 0, EXPANSION: 1, HEALTHY: 2 } as const;
  rows.sort((a, b) => bandRank[a.health.band] - bandRank[b.health.band] || a.health.score - b.health.score);

  const seatRows: SeatUsageRow[] = rows.map((row) => ({ orgId: row.orgId, slug: row.slug, name: row.name, planTier: row.planTier, status: row.status, seatsUsed: row.seatsUsed, seatLimit: row.seatLimit }));

  return {
    rows,
    coverage: { firstDay: snapshots[0]?.day.toISOString() ?? null, lastDay: snapshots[snapshots.length - 1]?.day.toISOString() ?? null },
    seatOverage: selectSeatOverage(seatRows)
  };
}

/**
 * Tickets created per day, recent half of the series against the half before it.
 *
 * `ticketsTotal` is cumulative, so the DELTA between two snapshots is what was created between
 * them — the actual velocity. A negative delta (tickets deleted, or a workspace restored from a
 * backup) is clamped to zero rather than reported as negative creation.
 *
 * Both halves are null under `MIN_TREND_SNAPSHOTS`, and the scorer emits no velocity signal then.
 * A trend drawn through two points is a line, not a trend.
 */
export function ticketVelocity(series: Array<{ day: Date; ticketsTotal: number }>): { recent: number | null; prior: number | null } {
  if (series.length < MIN_TREND_SNAPSHOTS) return { recent: null, prior: null };
  const middle = Math.floor(series.length / 2);
  const rate = (from: { day: Date; ticketsTotal: number }, to: { day: Date; ticketsTotal: number }): number | null => {
    const days = (to.day.getTime() - from.day.getTime()) / DAY_MS;
    if (days <= 0) return null;
    return Math.max(0, to.ticketsTotal - from.ticketsTotal) / days;
  };
  return { prior: rate(series[0], series[middle]), recent: rate(series[middle], series[series.length - 1]) };
}

/* ------------------------------------------------------------------------------------------ */
/* The fleet's own usage trend                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface FleetUsagePoint {
  day: string;
  workspaces: number;
  activeSeats: number;
  agentSeats: number;
  ticketsOpen: number;
  ticketsTotal: number;
  aiSpendUsd: number;
  unreachable: number;
}

/** Seats, tickets and AI spend across the whole fleet, per day. The chart the console never had,
 *  and the first thing the snapshot table makes possible. */
export async function getFleetUsageTrend(days = 90): Promise<FleetUsagePoint[]> {
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await controlPrisma.orgUsageSnapshot.findMany({ where: { day: { gte: since } }, orderBy: { day: "asc" } });

  const byDay = new Map<string, FleetUsagePoint>();
  for (const row of rows) {
    const key = row.day.toISOString();
    const point = byDay.get(key) ?? { day: key, workspaces: 0, activeSeats: 0, agentSeats: 0, ticketsOpen: 0, ticketsTotal: 0, aiSpendUsd: 0, unreachable: 0 };
    point.workspaces += 1;
    point.activeSeats += row.activeSeats;
    point.agentSeats += row.agentSeats;
    point.ticketsOpen += row.ticketsOpen;
    point.ticketsTotal += row.ticketsTotal;
    point.aiSpendUsd += Number(row.aiSpendMonthToDateUsd);
    if (!row.reachable) point.unreachable += 1;
    byDay.set(key, point);
  }
  return [...byDay.values()];
}

/* ------------------------------------------------------------------------------------------ */
/* One workspace, for the Org 360 page                                                         */
/* ------------------------------------------------------------------------------------------ */

export interface OrgUsageProfile {
  orgId: string;
  /** Newest last, so a chart can render it directly. */
  series: Array<{
    day: string;
    activeSeats: number;
    agentSeats: number;
    seatLimit: number;
    ticketsOpen: number;
    ticketsTotal: number;
    aiSpendUsd: number;
    emailsSent: number;
    emailsFailed: number;
    databaseBytes: number | null;
    reachable: boolean;
  }>;
  health: AccountHealth | null;
  /**
   * Exactly the inputs the scorer was given for the most recent day.
   *
   * Returned rather than left for a caller to re-derive, because two of the callers — the Org 360
   * page and the AI advisor's fact sheet — need to SHOW what was scored, and a second derivation
   * is a second chance to disagree with the band beside it. Null when there is no snapshot yet.
   */
  latest: {
    day: string;
    status: string;
    planTier: string;
    seatsUsed: number;
    seatLimit: number;
    aiSpendUsd: number;
    aiBudgetCeilingUsd: number;
    daysSinceLastActivity: number | null;
    backupFailures: number;
  } | null;
  /** This workspace's own list MRR, minor units. Null when its tier has no list price. */
  listMrrMinor: number | null;
  currency: string;
  coverage: { snapshots: number; firstDay: string | null; lastDay: string | null };
}

export async function getOrgUsageProfile(orgId: string, windowDays = 60): Promise<OrgUsageProfile> {
  const now = new Date();
  const since = new Date(now.getTime() - windowDays * DAY_MS);

  const [org, series, prices, backupFailures] = await Promise.all([
    controlPrisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, name: true, trialEndsAt: true } }),
    controlPrisma.orgUsageSnapshot.findMany({ where: { organizationId: orgId, day: { gte: since } }, orderBy: { day: "asc" } }),
    getTierPrices(),
    controlPrisma.backupRun.count({ where: { organizationId: orgId, status: "FAILED", startedAt: { gte: since } } })
  ]);

  const latest = series[series.length - 1];
  const velocity = ticketVelocity(series);
  const price = latest ? prices[latest.planTier] : undefined;
  const daysSinceLastActivity = latest?.lastActivityAt ? Math.floor((now.getTime() - latest.lastActivityAt.getTime()) / DAY_MS) : null;

  return {
    orgId,
    series: series.map((row) => ({
      day: row.day.toISOString(),
      activeSeats: row.activeSeats,
      agentSeats: row.agentSeats,
      seatLimit: row.seatLimit,
      ticketsOpen: row.ticketsOpen,
      ticketsTotal: row.ticketsTotal,
      aiSpendUsd: Number(row.aiSpendMonthToDateUsd),
      emailsSent: row.emailsSentMonthToDate,
      emailsFailed: row.emailsFailedMonthToDate,
      databaseBytes: row.databaseBytes,
      reachable: row.reachable
    })),
    health: latest
      ? scoreAccountHealth({
          status: latest.status,
          reachable: latest.reachable,
          seatsUsed: latest.activeSeats,
          seatLimit: latest.seatLimit,
          aiSpendUsd: Number(latest.aiSpendMonthToDateUsd),
          aiBudgetCeilingUsd: Number(latest.aiBudgetCeilingUsd),
          daysSinceLastActivity,
          ticketsPerDayRecent: velocity.recent,
          ticketsPerDayPrior: velocity.prior,
          emailsSent: latest.emailsSentMonthToDate,
          emailsFailed: latest.emailsFailedMonthToDate,
          backupFailures,
          trialDaysRemaining: org?.trialEndsAt ? (org.trialEndsAt.getTime() - now.getTime()) / DAY_MS : null,
          snapshots: series.length
        })
      : null,
    latest: latest
      ? {
          day: latest.day.toISOString(),
          status: latest.status,
          planTier: latest.planTier,
          seatsUsed: latest.activeSeats,
          seatLimit: latest.seatLimit,
          aiSpendUsd: Number(latest.aiSpendMonthToDateUsd),
          aiBudgetCeilingUsd: Number(latest.aiBudgetCeilingUsd),
          daysSinceLastActivity,
          backupFailures
        }
      : null,
    // `undefined` price and `null` price are the same answer here — "no list price for this tier" —
    // and both must render as "Not set" rather than as nothing owed.
    listMrrMinor: latest && price && price.perSeatMinor !== null ? price.perSeatMinor * latest.activeSeats : null,
    currency: price?.currency ?? "USD",
    coverage: { snapshots: series.length, firstDay: series[0]?.day.toISOString() ?? null, lastDay: latest?.day.toISOString() ?? null }
  };
}
