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
 * ADDITIONALLY shows the gap against real subscription amounts — see `reconcileAgainstStripe`
 * below, which is optional and degrades to nothing when Stripe is not configured, the common case.
 * That second number never reinterprets the first: it is a separate figure over a NAMED subset of
 * workspaces, and the list-price labelling above applies to everything else on the page unchanged.
 * The Stripe amounts themselves are fetched by a worker into `Organization.billed*` — see
 * `platform-billing-reconcile.service.ts` — because an outbound call per page render is a rate
 * limit waiting to happen, and this file still opens no socket.
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
import { platformDate, platformMonthKey } from "../utils/platform-time.js";
import {
  MIN_TREND_SNAPSHOTS,
  attentionExclusion,
  scoreAccountHealth,
  selectSeatOverage,
  type AccountHealth,
  type AttentionExclusion,
  type SeatOverageRow,
  type SeatUsageRow
} from "./platform-account-health.js";
import { BILLABLE_SUBSCRIPTION_STATUSES, isStripeConfigured } from "./stripe-client.service.js";
import { isConverted } from "./trial-conversion.js";

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
  /**
   * True when this reading could not reach the tenant database, so `activeSeats` is the last reading
   * that DID — carried forward — rather than the zero the unreachable row holds. An outage is not a
   * downgrade: reading it as one booked contraction and dragged NRR down for one bad night. Counted
   * and shown ("N unmeasured") so a carried figure is never mistaken for a fresh one.
   */
  unmeasured?: boolean;
  /** False when no reading of this workspace has EVER reached its database: its seat count is
   *  unknown, which is not zero. Absent means known. */
  seatsKnown?: boolean;
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

/**
 * A PAYING CUSTOMER — the population every logo count, ARPA, churn rate and NRR on the console is
 * about. ACTIVE, past its trial, on a paid tier, with list MRR above zero.
 *
 * "Above zero" means not KNOWN to be zero: a tier priced per contract (Enterprise, no list price) is a
 * paying customer whose MRR this product cannot see, and dropping it would hide every Enterprise
 * cancellation from the logo churn rate. A priced tier with nobody left in it bills nothing and is
 * not a customer; a workspace never once measured cannot be said to pay and is counted as unmeasured.
 *
 * Free Starter workspaces are NOT customers (`isFreeAccount`), and are reported beside them, never
 * among them. Counting them inflated the churn denominator with accounts that could not churn
 * revenue, and a paying customer cancelling to Starter — `customer.subscription.deleted` leaves the
 * workspace ACTIVE on STARTER — read as contraction rather than as the lost customer it is.
 */
export function isPayingCustomer(account: RevenueAccount, prices: TierPrices): boolean {
  if (!isRevenueBearing(account)) return false;
  if (isUnpricedTier(account.planTier, prices)) return true;
  if (account.seatsKnown === false) return false;
  return (accountMrrMinor(account, prices) ?? 0) > 0;
}

/** A tier with no list price — Enterprise, or a tier the price table has never heard of. Unpriced is
 *  not free: it is priced per contract, somewhere this product cannot see. */
function isUnpricedTier(planTier: string, prices: TierPrices): boolean {
  return (prices[planTier]?.perSeatMinor ?? null) === null;
}

/** A FREE ACCOUNT: active, past its trial, on a tier listed at zero (Starter). Reported on its own. */
export function isFreeAccount(account: RevenueAccount, prices: TierPrices): boolean {
  return isRevenueBearing(account) && prices[account.planTier]?.perSeatMinor === 0;
}

/** One account's list MRR in minor units, or `null` when its tier has no list price — or when its
 *  seats have never been measured, which is unknown rather than zero. */
export function accountMrrMinor(account: RevenueAccount, prices: TierPrices): number | null {
  if (!isRevenueBearing(account)) return 0;
  const perSeatMinor = prices[account.planTier]?.perSeatMinor ?? null;
  if (perSeatMinor === null || account.seatsKnown === false) return null;
  return perSeatMinor * billableSeats(account);
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
  /** Priced MRR ÷ priced paying accounts. Null when there are none — not 0, which would read as "our
   *  customers pay nothing" rather than "we have no paying customers". */
  arpaMinor: number | null;
  /** Paying customers (`isPayingCustomer`) — the logo count. Includes the unpriced ones below. */
  payingAccounts: number;
  /** Active accounts on a tier priced at exactly zero (Starter). Never a customer, never a logo. */
  freeAccounts: number;
  /** Paying customers whose tier has NO list price (Enterprise). Excluded from `mrrMinor` and from
   *  ARPA's denominator, and stated here so the exclusion is visible rather than silent. */
  unpricedAccounts: number;
  unpricedSeats: number;
  billableSeats: number;
  trialingAccounts: number;
  /** Workspaces whose latest reading could not reach their database, priced from the last reading
   *  that could (see `RevenueAccount.unmeasured`). The console prints "N unmeasured". */
  unmeasuredAccounts: number;
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

  const tiers = new Map<string, { accounts: number; seats: number; mrrMinor: number | null }>();

  for (const account of accounts.filter(isRevenueBearing)) {
    const accountSeats = billableSeats(account);
    const amount = accountMrrMinor(account, prices);
    seats += accountSeats;
    if (isPayingCustomer(account, prices)) payingAccounts += 1;
    else if (isFreeAccount(account, prices)) freeAccounts += 1;

    const bucket = tiers.get(account.planTier) ?? { accounts: 0, seats: 0, mrrMinor: 0 };
    bucket.accounts += 1;
    bucket.seats += accountSeats;
    // An unpriced tier's bucket is null for good; one unknown seat count does not erase the rest.
    if (isUnpricedTier(account.planTier, prices)) {
      unpricedAccounts += 1;
      unpricedSeats += accountSeats;
      bucket.mrrMinor = null;
    } else if (amount !== null) {
      mrrMinor += amount;
      if (bucket.mrrMinor !== null) bucket.mrrMinor += amount;
    }
    tiers.set(account.planTier, bucket);
  }

  const pricedPaying = payingAccounts - unpricedAccounts;
  return {
    basis: REVENUE_BASIS,
    currency: [...currencies][0] ?? "USD",
    mixedCurrencies: currencies.size > 1,
    mrrMinor,
    arrMinor: mrrMinor * 12,
    // Rounded to the minor unit: an ARPA of 833.333 cents is a false precision an operator would
    // read as exact. Guarded, because dividing by zero paying accounts yields Infinity, not an error.
    arpaMinor: pricedPaying > 0 ? Math.round(mrrMinor / pricedPaying) : null,
    payingAccounts,
    freeAccounts,
    unpricedAccounts,
    unpricedSeats,
    billableSeats: seats,
    trialingAccounts: accounts.filter((account) => account.trialing).length,
    unmeasuredAccounts: accounts.filter((account) => account.unmeasured).length,
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
  /** Paying customers on the window's first snapshot day — the cohort every rate below is about. */
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
  /** Start-cohort accounts whose END reading was carried forward from an earlier night because the
   *  latest could not reach their database — retained at their last measured value, never booked as
   *  contraction, and counted here so the console can say so. */
  unmeasuredAccounts: number;
}

const percent = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;

/**
 * Churn and retention between two observations of the same fleet.
 *
 * THE COHORT IS THE PAYING CUSTOMERS AT THE START (`isPayingCustomer`) — the caller hands in the
 * fleet as it stood on the window's FIRST snapshot day, and anything absent that day is `new`
 * (ChartMogul's NRR convention). Everything is measured about them: an account that both arrived and
 * left inside the window never joins the churn denominator, which is what stops a good month of
 * signups flattering the churn rate. Free Starter workspaces are not in it at all.
 *
 * LOGO CHURN IS A CUSTOMER WHO STOPPED PAYING, by any route: suspended, archived, lapsed to grace, or
 * cancelled down to free Starter — which `customer.subscription.deleted` does while leaving the
 * workspace ACTIVE. Stripe and ChartMogul both book a downgrade to free as churn; booking it as
 * contraction hid every cancellation inside "shrinkage" and left the logo churn rate at 0%.
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
 *
 * "Unpriced" ON EITHER SIDE OF THE WINDOW. A Team customer who signs an Enterprise contract has an
 * unknown MRR at the end, not a zero one: read as zero it booked the platform's best upsell as 100%
 * contraction and halved NRR, and the move back booked expansion out of nothing. So a customer
 * unpriced at the start OR the end is a logo only — out of start MRR, retained, expansion and
 * contraction — and, still paying at the end, a retained logo. One that stops paying is churned
 * whatever its tier, with whatever priced MRR it started with.
 */
export function computeChurn(start: RevenueAccount[], end: RevenueAccount[], prices: TierPrices, windowDays: number): ChurnWindow {
  const startBearing = start.filter((account) => isPayingCustomer(account, prices));
  const endBearing = end.filter((account) => isPayingCustomer(account, prices));
  const endById = new Map(endBearing.map((account) => [account.orgId, account]));
  const startIds = new Set(startBearing.map((account) => account.orgId));

  let startMrrMinor = 0;
  let retainedMrrMinor = 0;
  let expansionMinor = 0;
  let contractionMinor = 0;
  let churnedMrrMinor = 0;
  let churnedAccounts = 0;
  let unmeasuredAccounts = 0;

  for (const account of startBearing) {
    const before = accountMrrMinor(account, prices);
    const after = endById.get(account.orgId);
    if (!after) {
      churnedAccounts += 1;
      startMrrMinor += before ?? 0;
      churnedMrrMinor += before ?? 0;
      continue;
    }
    if (after.unmeasured) unmeasuredAccounts += 1;
    const now = accountMrrMinor(after, prices);
    if (before === null || now === null) continue;
    startMrrMinor += before;
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
    grossRevenueRetentionPercent: comparable ? percent(startMrrMinor - churnedMrrMinor - contractionMinor, startMrrMinor) : null,
    unmeasuredAccounts
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Pure: trial → paid                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface TrialLifecycle {
  orgId: string;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  /** The three columns trial-conversion.ts#isConverted reads — the one "converted" rule. */
  trialTier: string | null;
  planTier: string;
  stripeSubscriptionId: string | null;
  /** `Organization.convertedAt`: when the workspace first became a customer. Null on a conversion
   *  that predates the column and left no trace to backfill it from — unknown, never guessed. */
  convertedAt: Date | null;
}

/** One set of trials, decided or not. The same shape for the headline and for each cohort row, so a
 *  cohort row and the headline cannot mean different things by "conversion". */
export interface TrialTally {
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
  /** Converted trials with no recorded conversion moment — left out of the median, and counted so
   *  the gap is visible rather than silently shrinking the sample. */
  convertedUndated: number;
}

export interface TrialConversion extends TrialTally {
  /** The window the headline covers: trials that STARTED in the last N days. Null = all time. */
  windowDays: number | null;
  /** By the month each trial STARTED (platform zone), newest first, the last twelve with any trial —
   *  the cohort view ChartMogul and Baremetrics use, so a month's rate is about that month's trials
   *  rather than about whichever trials happened to be decided during it. */
  byCohort: Array<TrialTally & { cohort: string }>;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
};

/** Converted, still running, or lapsed — in that order, so a converted trial is never "running". */
function trialOutcome(row: TrialLifecycle, now: Date): "converted" | "running" | "lapsed" {
  if (isConverted(row)) return "converted";
  return row.trialEndsAt !== null && row.trialEndsAt.getTime() > now.getTime() ? "running" : "lapsed";
}

function tallyTrials(trials: TrialLifecycle[], now: Date): TrialTally {
  const counts = { converted: 0, running: 0, lapsed: 0 };
  const daysToConvert: number[] = [];
  let convertedUndated = 0;
  for (const row of trials) {
    const outcome = trialOutcome(row, now);
    counts[outcome] += 1;
    if (outcome !== "converted") continue;
    if (row.convertedAt && row.trialStartedAt) daysToConvert.push(Math.max(0, row.convertedAt.getTime() - row.trialStartedAt.getTime()) / DAY_MS);
    else convertedUndated += 1;
  }
  const decided = counts.converted + counts.lapsed;
  return {
    trialsStarted: trials.length,
    converted: counts.converted,
    lapsed: counts.lapsed,
    stillTrialing: counts.running,
    conversionPercent: decided > 0 ? Math.round((counts.converted / decided) * 1000) / 10 : null,
    medianDaysToConvert: median(daysToConvert),
    convertedUndated
  };
}

/**
 * Trial→paid, as a cohort measure.
 *
 * WHAT COUNTS AS A CONVERSION is trial-conversion.ts#isConverted — the rule the lifecycle worker, the
 * retention programme and the console's plan edit already use: a Stripe checkout (which clears the
 * trial tier), a subscription, or a paid tier set by hand. It used to be "subscribed, or still ACTIVE
 * after the trial ended", which counted a lapse the worker had not processed yet as a customer and
 * disagreed with Signups and retention about the same workspace.
 *
 * WHICH TRIALS. The headline is the trials that STARTED inside `windowDays` (the Revenue page's window
 * selector — it used to be all time whatever the selector said), and `byCohort` groups every trial by
 * its start month in the platform's zone. Days to convert is `convertedAt − trialStartedAt`.
 */
export function computeTrialConversion(lifecycles: TrialLifecycle[], now = new Date(), windowDays: number | null = null): TrialConversion {
  const trials = lifecycles.filter((row): row is TrialLifecycle & { trialStartedAt: Date } => row.trialStartedAt !== null);
  const since = windowDays === null ? null : windowStart(windowDays, now).getTime();
  const inWindow = since === null ? trials : trials.filter((row) => row.trialStartedAt.getTime() >= since);

  const byMonth = new Map<string, TrialLifecycle[]>();
  for (const row of trials) {
    const key = platformMonthKey(row.trialStartedAt);
    byMonth.set(key, [...(byMonth.get(key) ?? []), row]);
  }

  return {
    ...tallyTrials(inWindow, now),
    windowDays,
    byCohort: [...byMonth.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, 12)
      .map(([cohort, rows]) => ({ cohort, ...tallyTrials(rows, now) }))
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

/** `YYYY-MM` of a DATE-ONLY value — a snapshot `day`, or a key built here — read off its UTC fields,
 *  which is where a date-only value keeps its date. An INSTANT (a signup, a trial start) takes the
 *  platform's month instead: `platformMonthKey`. */
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
    // The month the customer signed up IN INDIA (the platform's zone): 01:30 IST on 1 July is a July
    // signup, which UTC's month called June.
    const key = platformMonthKey(org.createdAt);
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

/** The columns a revenue reading needs — and only those. The window can be a year of daily rows per
 *  workspace, and `ticketCountsByStatus` is a JSON document per row that no revenue figure reads. */
const REVENUE_SNAPSHOT_SELECT = {
  organizationId: true,
  day: true,
  planTier: true,
  status: true,
  activeSeats: true,
  agentSeats: true,
  seatLimit: true,
  trialEndsAt: true,
  trialTier: true,
  stripeSubscriptionId: true,
  reachable: true
} as const;

type RevenueSnapshotRow = Pick<SnapshotRow, keyof typeof REVENUE_SNAPSHOT_SELECT>;

/** A reading after carry-forward: seats are the last REACHABLE ones, and it says whether they were. */
type CarriedRow = RevenueSnapshotRow & { unmeasured: boolean; seatsKnown: boolean };

/** Snapshot `day`s are date-only values (UTC midnight of the platform's date), so a window "the last
 *  N days" starts N calendar days before today's — not N×24h before this instant, which dropped the
 *  first day of every window. */
const windowStart = (windowDays: number, now = new Date()): Date => new Date(platformDate(now).getTime() - windowDays * DAY_MS);

/**
 * Seats carried forward over every reading that could not reach the tenant database.
 *
 * AN UNREACHABLE NIGHT IS NOT A DOWNGRADE. The sweep writes `activeSeats: 0, reachable: false` for a
 * workspace it could not read — honest in the table, because the zero is flagged — but read as a
 * seat count it priced an outage as lost revenue: one bad night on the last day of a window booked
 * the whole workspace as contraction and dragged NRR down. So each unreachable row takes the seats
 * of the last row that WAS reachable — from earlier in the window, or from the latest reading before
 * it (`seed`) — and is flagged `unmeasured` so the console can say how many figures are carried. A
 * workspace no reading has ever reached keeps its zero with `seatsKnown: false`: unknown, not none.
 */
export function carrySeatsForward<T extends Pick<SnapshotRow, "organizationId" | "reachable" | "activeSeats" | "agentSeats">>(
  rows: T[],
  seed: Map<string, { activeSeats: number; agentSeats: number }> = new Map()
): Array<T & { unmeasured: boolean; seatsKnown: boolean }> {
  const lastGood = new Map(seed);
  return rows.map((row) => {
    if (row.reachable) {
      lastGood.set(row.organizationId, { activeSeats: row.activeSeats, agentSeats: row.agentSeats });
      return { ...row, unmeasured: false, seatsKnown: true };
    }
    const carried = lastGood.get(row.organizationId);
    return carried ? { ...row, ...carried, unmeasured: true, seatsKnown: true } : { ...row, unmeasured: true, seatsKnown: false };
  });
}

/** The latest REACHABLE reading before `before` for each of `orgIds` — what an unreachable first
 *  reading carries forward from. One query; the first row per workspace wins. */
async function lastGoodReadings(orgIds: string[], before: Date): Promise<Map<string, { activeSeats: number; agentSeats: number }>> {
  const seed = new Map<string, { activeSeats: number; agentSeats: number }>();
  if (orgIds.length === 0) return seed;
  const rows = await controlPrisma.orgUsageSnapshot.findMany({
    where: { organizationId: { in: orgIds }, reachable: true, day: { lt: before } },
    orderBy: { day: "desc" },
    select: { organizationId: true, activeSeats: true, agentSeats: true }
  });
  for (const row of rows) if (!seed.has(row.organizationId)) seed.set(row.organizationId, { activeSeats: row.activeSeats, agentSeats: row.agentSeats });
  return seed;
}

/** Workspaces whose FIRST reading in a series could not reach their database — the ones that need a
 *  seed from before the series to carry forward. */
function unreachableFirst(rows: Array<Pick<SnapshotRow, "organizationId" | "reachable">>): string[] {
  const first = new Map<string, boolean>();
  for (const row of rows) if (!first.has(row.organizationId)) first.set(row.organizationId, row.reachable);
  return [...first.entries()].filter(([, reachable]) => !reachable).map(([orgId]) => orgId);
}

/** A carried reading plus its workspace's identity, as a `RevenueAccount`. `trialing` is decided
 *  against the day the snapshot describes, not against now — that is the whole reason the trial
 *  columns are carried on the row — and a workspace that has CONVERTED (trial-conversion.ts) is not
 *  trialling whatever its clock says: one converted by hand before the console cleared the clock was
 *  read as pipeline until the date passed. */
function toAccount(row: CarriedRow, org: { slug: string; name: string }): RevenueAccount {
  return {
    orgId: row.organizationId,
    slug: org.slug,
    name: org.name,
    planTier: row.planTier,
    status: row.status,
    activeSeats: row.activeSeats,
    agentSeats: row.agentSeats,
    trialing: row.trialEndsAt !== null && row.trialEndsAt.getTime() > row.day.getTime() && !isConverted(row),
    subscribed: Boolean(row.stripeSubscriptionId),
    unmeasured: row.unmeasured,
    seatsKnown: row.seatsKnown
  };
}

/**
 * The window's readings, carried forward, split into the two sides of a churn window.
 *
 * `start` is the fleet on the window's FIRST snapshot day — one day, every workspace on it — and not
 * "each workspace's first row in the window", which put a workspace provisioned on day 20 into the
 * starting cohort, booked its growth as NRR expansion and hid it from "new" (ChartMogul's convention:
 * the cohort is who was a customer on day one; anything absent that day is new). `last` is each
 * workspace's latest reading. One query for the window, plus one for the workspaces whose first
 * reading in it was unreachable and so needs its last good reading from before it.
 */
async function loadRevenueWindow(since: Date) {
  const rows = await controlPrisma.orgUsageSnapshot.findMany({ where: { day: { gte: since } }, orderBy: { day: "asc" }, select: REVENUE_SNAPSHOT_SELECT });
  const carried = carrySeatsForward(rows, await lastGoodReadings(unreachableFirst(rows), since));
  const firstDay = carried[0]?.day.getTime() ?? null;
  const last = new Map<string, CarriedRow>();
  for (const row of carried) last.set(row.organizationId, row);
  return { rows: carried, start: carried.filter((row) => row.day.getTime() === firstDay), last };
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
  const since = windowStart(windowDays, now);

  const [prices, orgs, { rows, start, last }] = await Promise.all([
    getTierPrices(),
    controlPrisma.organization.findMany({
      select: { id: true, slug: true, name: true, createdAt: true, planTier: true, trialTier: true, trialStartedAt: true, trialEndsAt: true, stripeSubscriptionId: true, convertedAt: true }
    }),
    loadRevenueWindow(since)
  ]);

  const orgById = new Map(orgs.map((org) => [org.id, org]));
  const identify = (row: CarriedRow) => orgById.get(row.organizationId) ?? { slug: row.organizationId, name: row.organizationId };

  const startAccounts = start.map((row) => toAccount(row, identify(row)));
  const endAccounts = [...last.values()].map((row) => toAccount(row, identify(row)));

  const days = [...new Set(rows.map((row) => row.day.getTime()))].sort((a, b) => a - b);
  const spanDays = days.length >= 2 ? Math.round((days[days.length - 1] - days[0]) / DAY_MS) : 0;

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
    trials: computeTrialConversion(
      orgs.map((org) => ({
        orgId: org.id,
        trialStartedAt: org.trialStartedAt,
        trialEndsAt: org.trialEndsAt,
        trialTier: org.trialTier,
        planTier: org.planTier,
        stripeSubscriptionId: org.stripeSubscriptionId,
        convertedAt: org.convertedAt
      })),
      now,
      windowDays
    ),
    cohorts: buildSignupCohorts(
      orgs.map((org) => ({ orgId: org.id, createdAt: org.createdAt, activeMonths: allActive.get(org.id) ?? new Set<string>() })),
      { from: firstEver ? monthKey(firstEver.day) : null, to: lastEver ? monthKey(lastEver.day) : null }
    ),
    seatOverage: selectSeatOverage(seatRows),
    // The SAME `endAccounts` and prices the list MRR above was computed from, handed over rather
    // than re-derived: the gap is list minus billed, and a second derivation of the list half is a
    // second chance for the two halves of one subtraction to disagree.
    stripe: await reconcileAgainstStripe(mrr, endAccounts, prices)
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

/* ------------------------------------------------------------------------------------------ */
/* Optional: the gap between list price and what Stripe actually bills                         */
/* ------------------------------------------------------------------------------------------ */

/** One workspace's stored reconciliation, exactly as the control plane holds it. Written by
 *  `platform-billing-reconcile.service.ts`; never fetched from Stripe on this path. */
export interface BilledRow {
  orgId: string;
  slug: string;
  name: string;
  /** Monthly, minor units. Null = never successfully reconciled. NEVER zero for "unknown". */
  billedMrrMinor: number | null;
  billedCurrency: string | null;
  billedReconciledAt: Date | null;
  billedReconcileError: string | null;
  /** The subscription's Stripe status at reconciliation. Null on a figure stored before the status
   *  was — read as billable until the next nightly sweep records it. */
  billedSubscriptionStatus?: string | null;
}

export interface StripeReconciliation {
  /** How many workspaces carry a Stripe subscription at all. */
  subscribedAccounts: number;
  /** Of those, how many are in the comparison below — reconciled, revenue-bearing, and on a tier
   *  that has a list price. Every other subscribed workspace is counted in `excluded`. */
  comparedAccounts: number;
  /**
   * Why each subscribed workspace is NOT in the comparison. Present so the exclusions are VISIBLE,
   * the same rule `MrrBreakdown.unpricedAccounts` follows: a total whose population is unstated is
   * a total nobody can check.
   */
  excluded: {
    /** The sweep has never succeeded here. Distinct from "no gap" — see `billedMrrMinor`. */
    neverReconciled: number;
    /** The last sweep FAILED. Counted here and named in `failures`, never folded in as zero: a
     *  Stripe outage reported as a 100% discount is worse than an honest gap. */
    failed: number;
    /** Reconciled, but the tier has no list price (Enterprise), so there is nothing to compare the
     *  billed amount against. Including it would fabricate a 100% discount. */
    unpriced: number;
    /** Reconciled and priced, but the workspace is not a paying customer right now — trialling,
     *  free, suspended, archived, or with no usage snapshot yet. Its list value is zero or unknown,
     *  so pairing it with a real billed amount would report a negative discount. */
    notRevenueBearing: number;
    /** Reconciled, but Stripe says the subscription is not billing — `trialing`, `unpaid` or
     *  `paused`. Not MRR by Stripe's own definition, so not in the billed total. */
    notBilling: number;
  };
  /** The workspaces whose reconciliation failed, BY NAME. An operator cannot chase a count. */
  failures: Array<{ orgId: string; slug: string; name: string; message: string }>;
  /** The WHOLE fleet's list MRR, unchanged from the tile at the top of the page — carried so the
   *  card can say what fraction of the business the comparison covers. */
  listMrrMinor: number;
  /** List MRR of the compared workspaces ONLY. The only half that is comparable with
   *  `billedMrrMinor`; comparing whole-fleet list against subscribed-only billed would invent a
   *  discount out of the customers who never had a Stripe subscription. */
  comparableListMrrMinor: number | null;
  /** What Stripe bills those same workspaces per month: active and past-due subscriptions, net of
   *  their recurring discounts. Null = nothing has been reconciled yet, and the console renders that
   *  as "not reconciled yet" rather than as a zero gap. */
  billedMrrMinor: number | null;
  /** Comparable list minus billed — the GAP TO LIST PRICE, not "discounting" alone: it holds the
   *  coupons, any price in Stripe that differs from the list price, and a billed seat quantity that
   *  differs from the active seats. Negative means billed ABOVE list, a real state (a legacy price, a
   *  manual override in Stripe) shown rather than clamped. */
  discountMinor: number | null;
  discountPercent: number | null;
  currency: string;
  /** True when the compared workspaces do not all share one currency. The subtraction is then
   *  meaningless and the console says so instead of quietly taking euros from dollars. */
  mixedCurrencies: boolean;
  /** The most recent successful reconciliation across the compared set, ISO. Null when there is
   *  none — which is what makes "not reconciled yet" a different sentence from "no gap". */
  lastReconciledAt: string | null;
  note: string;
}

/**
 * The gap between list price and billed revenue — PURE, and the reason it is pure.
 *
 * That gap IS discounting, and it is the number an operator most wants: a deployment whose billed
 * MRR sits 18% under its list MRR is one where every deal is closed on a discount nobody decided to
 * standardise. Getting the POPULATION wrong is how that number lies, and there are four ways to do
 * it — comparing the whole fleet's list against only-subscribed billed, pairing an Enterprise
 * workspace's absent list price with a real billed amount, pairing a suspended workspace's zero
 * with one, and folding a failed reconciliation in as zero. Each is one branch below and one test.
 *
 * NOTHING HERE CALLS STRIPE. The stored figures arrive as arguments; the sweep that fetched them is
 * `platform-billing-reconcile.service.ts`, run from a worker.
 */
type BilledVerdict =
  | { kind: keyof StripeReconciliation["excluded"] }
  | { kind: "compared"; listMinor: number; billedMinor: number; currency: string };

/**
 * Whether ONE workspace belongs in the comparison, and if so what it contributes.
 *
 * Its own function because these four exclusions ARE the feature — each is a way the gap could lie,
 * and reading them as a list of guards beside the arithmetic they guard makes both harder to
 * follow. The order is deliberate: a failure is checked before "never reconciled", because a
 * workspace that failed tonight may still hold last night's figure and must be reported as broken
 * rather than as stale.
 */
function judgeBilledRow(row: BilledRow, account: RevenueAccount | undefined, prices: TierPrices): BilledVerdict {
  if (row.billedReconcileError) return { kind: "failed" };
  if (row.billedMrrMinor === null) return { kind: "neverReconciled" };
  // Stripe's MRR counts active and past-due subscriptions only. A trialing, unpaid or paused one has
  // a recurring price and is not paying it.
  if (row.billedSubscriptionStatus && !BILLABLE_SUBSCRIPTION_STATUSES.has(row.billedSubscriptionStatus)) return { kind: "notBilling" };
  // No snapshot yet counts here too: a workspace nothing has measured has no list value to compare,
  // and pairing a real billed amount with an assumed zero is how a discount gets invented. A free
  // Starter workspace is not a paying customer either, whatever Stripe holds for it.
  if (!account || !isPayingCustomer(account, prices)) return { kind: "notRevenueBearing" };
  const price = prices[account.planTier];
  if (!price || price.perSeatMinor === null) return { kind: "unpriced" };
  return { kind: "compared", listMinor: price.perSeatMinor * billableSeats(account), billedMinor: row.billedMrrMinor, currency: price.currency.toUpperCase() };
}

/** The single pass over the subscribed workspaces. Separated from the shaping below so the loop is
 *  about sorting rows into buckets and nothing else. */
function tallyBilledRows(billed: BilledRow[], accountById: Map<string, RevenueAccount>, prices: TierPrices) {
  const excluded = { neverReconciled: 0, failed: 0, unpriced: 0, notRevenueBearing: 0, notBilling: 0 };
  const failures: StripeReconciliation["failures"] = [];
  const currencies = new Set<string>();
  let comparableListMinor = 0;
  let billedMinor = 0;
  let comparedAccounts = 0;
  let lastReconciledAt: Date | null = null;

  for (const row of billed) {
    const verdict = judgeBilledRow(row, accountById.get(row.orgId), prices);
    if (verdict.kind !== "compared") {
      excluded[verdict.kind] += 1;
      if (verdict.kind === "failed") failures.push({ orgId: row.orgId, slug: row.slug, name: row.name, message: row.billedReconcileError! });
      continue;
    }

    comparedAccounts += 1;
    comparableListMinor += verdict.listMinor;
    billedMinor += verdict.billedMinor;
    // BOTH currencies, the list one and the billed one. A workspace priced in dollars but billed in
    // euros makes the subtraction meaningless, and only comparing the two reveals it.
    currencies.add(verdict.currency);
    if (row.billedCurrency) currencies.add(row.billedCurrency.toUpperCase());
    if (row.billedReconciledAt && (!lastReconciledAt || row.billedReconciledAt > lastReconciledAt)) lastReconciledAt = row.billedReconciledAt;
  }

  return { excluded, failures, currencies, comparableListMinor, billedMinor, comparedAccounts, lastReconciledAt };
}

export function computeBilledReconciliation(
  billed: BilledRow[],
  accounts: RevenueAccount[],
  prices: TierPrices,
  fleetMrr: MrrBreakdown
): StripeReconciliation {
  const accountById = new Map(accounts.map((account) => [account.orgId, account]));
  const { excluded, failures, currencies, comparableListMinor, billedMinor, comparedAccounts, lastReconciledAt } = tallyBilledRows(billed, accountById, prices);

  // NOTHING COMPARED IS NOT A GAP OF ZERO. Every money field goes null and the note says which of
  // the two states this is, because "we have not looked yet" and "everybody pays list" would
  // otherwise render as the same $0 on the same card.
  const compared = comparedAccounts > 0;
  const discountMinor = compared ? comparableListMinor - billedMinor : null;

  return {
    subscribedAccounts: billed.length,
    comparedAccounts,
    excluded,
    failures,
    listMrrMinor: fleetMrr.mrrMinor,
    comparableListMrrMinor: compared ? comparableListMinor : null,
    billedMrrMinor: compared ? billedMinor : null,
    discountMinor,
    // Of the comparable LIST value, because that is the thing being discounted from. Guarded: a
    // compared set whose list value is zero would otherwise divide by nothing.
    discountPercent: compared && comparableListMinor > 0 ? Math.round(((comparableListMinor - billedMinor) / comparableListMinor) * 1000) / 10 : null,
    currency: [...currencies][0] ?? fleetMrr.currency,
    mixedCurrencies: currencies.size > 1,
    lastReconciledAt: lastReconciledAt ? (lastReconciledAt as Date).toISOString() : null,
    note: reconciliationNote(comparedAccounts, excluded)
  };
}

/** The sentence under the card. Written from the SAME counts the numbers came from, so the prose
 *  and the figures cannot drift into disagreeing about what was measured. */
/** One line per exclusion, written once. A table rather than a run of `if`s so the short reason and
 *  the long one for the same bucket sit beside each other and cannot describe different things. */
const EXCLUSION_PROSE: Array<{ key: keyof StripeReconciliation["excluded"]; short: string; long: (n: number) => string }> = [
  {
    key: "failed",
    short: "failed to reconcile",
    long: (n) => `${n} failed to reconcile and ${n === 1 ? "is" : "are"} named below rather than counted as zero.`
  },
  { key: "neverReconciled", short: "not reconciled yet", long: (n) => `${n} ${n === 1 ? "has" : "have"} never been reconciled.` },
  {
    key: "unpriced",
    short: "on a tier with no list price",
    long: (n) => `${n} ${n === 1 ? "is" : "are"} on a tier with no list price, so there is nothing to compare against.`
  },
  { key: "notRevenueBearing", short: "not a paying customer", long: (n) => `${n} ${n === 1 ? "is" : "are"} trialling, free, suspended or not yet snapshotted.` },
  {
    key: "notBilling",
    short: "not billing in Stripe",
    long: (n) => `${n} ${n === 1 ? "has a subscription that is" : "have subscriptions that are"} trialing, unpaid or paused in Stripe, which is not MRR.`
  }
];

function reconciliationNote(comparedAccounts: number, excluded: StripeReconciliation["excluded"]): string {
  const present = EXCLUSION_PROSE.filter((entry) => excluded[entry.key] > 0);

  if (comparedAccounts === 0) {
    if (present.length === 0) return "No workspace carries a Stripe subscription, so there is nothing to reconcile.";
    const reasons = present.map((entry) => `${excluded[entry.key]} ${entry.short}`).join(", ");
    return `Nothing can be compared yet — ${reasons}. This is not a gap of zero.`;
  }

  const opening = `Comparing ${comparedAccounts} workspace${comparedAccounts === 1 ? "" : "s"} that have both a list price and a reconciled Stripe amount.`;
  return [opening, ...present.map((entry) => entry.long(excluded[entry.key]))].join(" ");
}

/**
 * The stored reconciliation, read from the control plane.
 *
 * IT DEGRADES TO NOTHING, DELIBERATELY. Most installations have no Stripe account — they assign
 * tiers by hand — and this returns `null` for them, so the console renders no card at all rather
 * than an empty one implying something is broken.
 *
 * IT STILL DOES NOT CALL STRIPE, and that has not changed: an outbound HTTP request per page load,
 * on a screen an operator refreshes, is a rate limit waiting to happen. It reads the columns
 * `reconcileBilledRevenue()` wrote from a worker, which is the honest place for the call.
 */
export async function getBilledRevenueReconciliation(windowDays = 30): Promise<StripeReconciliation | null> {
  if (!(await isStripeConfigured())) return null;

  const [prices, orgs, { last }] = await Promise.all([
    getTierPrices(),
    controlPrisma.organization.findMany({ select: { id: true, slug: true, name: true } }),
    loadRevenueWindow(windowStart(windowDays))
  ]);
  const orgById = new Map(orgs.map((org) => [org.id, org]));
  const accounts = [...last.values()].map((row) => toAccount(row, orgById.get(row.organizationId) ?? { slug: row.organizationId, name: row.organizationId }));

  // The list half is computed from the SAME accounts the comparison will use, through the same
  // function the page's MRR tile uses. Two derivations of one subtraction's left-hand side is how
  // a gap ends up disagreeing with the tile above it.
  return reconcileAgainstStripe(computeListMrr(accounts, prices), accounts, prices);
}

export async function reconcileAgainstStripe(mrr: MrrBreakdown, accounts: RevenueAccount[], prices: TierPrices): Promise<StripeReconciliation | null> {
  if (!(await isStripeConfigured())) return null;

  const rows = await controlPrisma.organization.findMany({
    where: { stripeSubscriptionId: { not: null } },
    select: { id: true, slug: true, name: true, billedMrrMinor: true, billedCurrency: true, billedReconciledAt: true, billedReconcileError: true, billedSubscriptionStatus: true }
  });

  return computeBilledReconciliation(
    rows.map((row) => ({
      orgId: row.id,
      slug: row.slug,
      name: row.name,
      billedMrrMinor: row.billedMrrMinor,
      billedCurrency: row.billedCurrency,
      billedReconciledAt: row.billedReconciledAt,
      billedReconcileError: row.billedReconcileError,
      billedSubscriptionStatus: row.billedSubscriptionStatus
    })),
    accounts,
    prices,
    mrr
  );
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
  /** On the console's "Needs attention" list: not healthy, and not excluded below. Decided here so
   *  the list and its reason cannot drift apart in the browser. */
  needsAttention: boolean;
  /** Why a workspace is kept off that list — deleted under the policy, archived, or a lapsed trial
   *  past the retention window. Null for every live workspace. */
  attentionExclusion: AttentionExclusion | null;
}

/**
 * Health for every workspace, from snapshots plus backup outcomes.
 *
 * NO TENANT CONNECTIONS. Everything here was written down by the nightly sweep, so this screen
 * costs one control-plane query set however many customers the deployment has — which is the whole
 * reason the snapshot table exists.
 */
export async function getFleetAccountHealth(
  windowDays = 30,
  retentionDays = 90
): Promise<{ rows: AccountHealthRow[]; coverage: { firstDay: string | null; lastDay: string | null }; seatOverage: SeatOverageRow[] }> {
  const now = new Date();
  const since = windowStart(windowDays, now);

  const [orgs, snapshots, backupFailures] = await Promise.all([
    controlPrisma.organization.findMany({
      select: { id: true, slug: true, name: true, status: true, planTier: true, trialTier: true, trialEndsAt: true, stripeSubscriptionId: true, retentionDeletedAt: true }
    }),
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
    const exclusion = attentionExclusion({ status: org.status, retentionDeletedAt: org.retentionDeletedAt, trialEndsAt: org.trialEndsAt, converted: isConverted(org) }, retentionDays, now);
    const daysSinceLastActivity = latest.lastActivityAt ? Math.floor((now.getTime() - latest.lastActivityAt.getTime()) / DAY_MS) : null;
    const health = scoreAccountHealth({
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
      backupFailures: failuresByOrg.get(org.id) ?? 0,
      trialDaysRemaining: org.trialEndsAt ? (org.trialEndsAt.getTime() - now.getTime()) / DAY_MS : null,
      snapshots: series.length
    });
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
      daysSinceLastActivity,
      health,
      needsAttention: health.band !== "HEALTHY" && exclusion === null,
      attentionExclusion: exclusion
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
  /** This workspace's own list MRR, minor units — `accountMrrMinor`, the SAME rule the fleet total
   *  sums, so this tile and the Revenue page cannot disagree about one workspace. 0 while it is not
   *  revenue-bearing (trialling, lapsed, suspended); null when its tier has no list price or its seats
   *  have never been measured. */
  listMrrMinor: number | null;
  /** Which population the workspace is in on its latest reading, so the tile can say WHY a figure
   *  is zero or blank: a running trial and a free account both list at 0 for different reasons. */
  revenueState: RevenueState | null;
  currency: string;
  coverage: { snapshots: number; firstDay: string | null; lastDay: string | null };
}

/** The population one workspace is in, in the order the predicates are asked. */
export type RevenueState = "paying" | "free" | "trialing" | "not-active" | "unmeasured";

export function revenueStateOf(account: RevenueAccount, prices: TierPrices): RevenueState {
  if (account.trialing) return "trialing";
  if (account.status !== "ACTIVE") return "not-active";
  if (isPayingCustomer(account, prices)) return "paying";
  if (isFreeAccount(account, prices)) return "free";
  return account.seatsKnown === false ? "unmeasured" : "not-active";
}

export async function getOrgUsageProfile(orgId: string, windowDays = 60): Promise<OrgUsageProfile> {
  const now = new Date();
  const since = windowStart(windowDays, now);

  const [org, series, prices, backupFailures] = await Promise.all([
    controlPrisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, name: true, trialEndsAt: true } }),
    controlPrisma.orgUsageSnapshot.findMany({ where: { organizationId: orgId, day: { gte: since } }, orderBy: { day: "asc" } }),
    getTierPrices(),
    controlPrisma.backupRun.count({ where: { organizationId: orgId, status: "FAILED", startedAt: { gte: since } } })
  ]);

  const latest = series.at(-1);
  const velocity = ticketVelocity(series);
  // Priced from the carried-forward reading, through the fleet's own predicate. This tile used to
  // multiply the list price by the latest row's seats whatever the workspace's state — a running
  // trial showed list MRR the Revenue page did not count, and an unreachable night showed $0.
  const carried = latest ? carrySeatsForward(series, await lastGoodReadings(unreachableFirst(series), since)).at(-1) : undefined;
  const account = carried && org ? toAccount(carried, org) : null;
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
    listMrrMinor: account ? accountMrrMinor(account, prices) : null,
    revenueState: account ? revenueStateOf(account, prices) : null,
    currency: price?.currency ?? "USD",
    coverage: { snapshots: series.length, firstDay: series[0]?.day.toISOString() ?? null, lastDay: latest?.day.toISOString() ?? null }
  };
}
