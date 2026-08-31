/**
 * WHAT: the money and the time the console could not see — list MRR/ARR/ARPA, revenue by tier,
 * logo and revenue churn, net revenue retention, trial→paid conversion, a cohort-by-signup-month
 * retention table, and the seat-overage list.
 *
 * THE PAGE'S ONE JOB IS TO BE HONEST ABOUT WHAT ITS NUMBERS ARE. Every figure here is derived from
 * an operator-editable LIST PRICE, not from billed revenue: a discounted, annual or negotiated
 * customer pays something else, and Enterprise has no list price at all. So:
 *   - the basis is stated in the page description and again on the MRR tile, not buried;
 *   - workspaces on an unpriced tier are EXCLUDED from the total and the exclusion is printed
 *     beside it, because a confident $0 next to a deployment's largest customers is worse than a
 *     gap somebody can see;
 *   - a percentage the data cannot support renders as "—" with the reason, never as 0%.
 *
 * THERE IS EXACTLY ONE FIGURE ON THIS PAGE THAT IS NOT LIST PRICE, and it was added as a SECOND
 * number rather than as a reinterpretation of the first: the billed-revenue card at the foot,
 * `BilledRevenue` below. It shows what Stripe actually charges and the gap against list — which is
 * discounting — and it carries its own population, its own labels and its own "not reconciled yet"
 * state. Nothing above it changed meaning, and no list-price label was softened to make room.
 *
 * IT READS SNAPSHOTS. `OrgUsageSnapshot` is written nightly by a worker; nothing on this page opens
 * a tenant database, which is why it costs the same at four workspaces and four hundred. The series
 * starts the night the feature shipped and cannot be backfilled — there was never any history to
 * recover — so the coverage line at the top says what the numbers are actually made of.
 *
 * Anatomy copied from the console's other pages: `ConsolePage` → `KpiGrid` → `ConsoleSection`s with
 * `ConsoleTable` inside them, `PRIMARY_BTN` on the single primary action, `<Button variant="outline">`
 * everywhere else, and query keys under `["platform-admin", …]`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, CalendarClock, CameraIcon, LineChart, RefreshCw, TrendingDown, TrendingUp, Users, UserCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { platformCapabilities, platformRoleHas } from "@timesheet/shared";
import { platformRevenueApi, type CohortCell, type RevenueOverview } from "../../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../../store/platform-admin-auth";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, KpiCard, KpiGrid, Num, PRIMARY_BTN, SegmentedControl, TierPill, Toolbar, shortDate } from "./console-ui";

/* ------------------------------------------------------------------------------------------- */
/* Formatting — every one of these has an explicit "we do not know" branch                       */
/* ------------------------------------------------------------------------------------------- */

/** Minor units as money. `null` is NEVER money: it is the absence of a price, and it renders as an
 *  em dash so it cannot be mistaken for zero at a glance down a column. */
const money = (minor: number | null | undefined, currency: string, fractionDigits = 0) =>
  minor === null || minor === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(minor / 100);

/** A percentage the data could not support renders as an em dash, not as 0%. */
const pct = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${value.toFixed(1)}%`);

const WINDOWS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" }
] as const;

/** The colour of one cohort cell. Null (unobserved) is grey and empty — a shaded 0% would report a
 *  churn event that never happened, on the screen most likely to be shown to somebody deciding
 *  something. */
function cohortTone(cell: CohortCell): string {
  if (cell.percent === null) return "bg-muted/40 text-muted-foreground/60";
  if (cell.percent >= 90) return "bg-success/25 text-foreground";
  if (cell.percent >= 70) return "bg-success/15 text-foreground";
  if (cell.percent >= 40) return "bg-warning/20 text-foreground";
  return "bg-destructive/20 text-foreground";
}

/* ------------------------------------------------------------------------------------------- */
/* Page                                                                                          */
/* ------------------------------------------------------------------------------------------- */

export function PlatformAdminRevenue() {
  const queryClient = useQueryClient();
  const role = usePlatformAdminAuthStore((s) => s.admin?.role);
  const canSweep = role ? platformRoleHas(role, platformCapabilities.PLATFORM_OPERATE) : false;
  const [days, setDays] = useState<(typeof WINDOWS)[number]["value"]>("30");

  const revenue = useQuery({
    queryKey: ["platform-admin", "revenue", days],
    queryFn: () => platformRevenueApi.overview(Number(days))
  });

  const snapshot = useMutation({
    mutationFn: platformRevenueApi.snapshotNow,
    onSuccess: (result) => {
      toast.success(
        `Captured ${result.captured} workspace${result.captured === 1 ? "" : "s"}${result.failed.length ? `, ${result.failed.length} unreachable` : ""}.`
      );
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "revenue"] });
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "account-health"] });
    },
    onError: () => toast.error("The sweep could not be started.")
  });

  const data = revenue.data;

  return (
    <ConsolePage
      eyebrow="Tenants"
      title="Revenue & retention"
      description={
        <>
          Monthly recurring revenue, churn, retention and trial conversion, computed from the nightly usage snapshot.{" "}
          <strong className="text-foreground">Every figure here is LIST PRICE</strong> — what the plan advertises per seat, not what any customer is billed. A
          discount, an annual commitment or a negotiated Enterprise contract will differ. The one exception is the billed-revenue card at the foot of the page,
          which says so on every number it shows.
        </>
      }
      actions={
        <Toolbar>
          <SegmentedControl ariaLabel="Comparison window" options={WINDOWS} value={days} onChange={setDays} />
          {canSweep && (
            <Button variant="outline" size="sm" onClick={() => snapshot.mutate()} disabled={snapshot.isPending}>
              <CameraIcon className={cn("mr-1.5 h-3.5 w-3.5", snapshot.isPending && "animate-pulse")} />
              {snapshot.isPending ? "Capturing…" : "Snapshot now"}
            </Button>
          )}
          <Button size="sm" className={PRIMARY_BTN} onClick={() => revenue.refetch()} disabled={revenue.isFetching}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", revenue.isFetching && "animate-spin")} />
            {revenue.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </Toolbar>
      }
    >
      {revenue.isLoading && (
        <>
          <KpiGrid>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[6.5rem] w-full rounded-xl" />
            ))}
          </KpiGrid>
          <Skeleton className="h-64 w-full rounded-xl" />
        </>
      )}

      {!revenue.isLoading && data && (data.coverage.snapshots === 0 ? <NoHistoryYet canSweep={canSweep} /> : <Loaded data={data} />)}
    </ConsolePage>
  );
}

/**
 * Day one, and it is a real state rather than an error.
 *
 * There is nothing to backfill: every figure the snapshot holds is a point-in-time count of mutable
 * tenant state, so yesterday's is gone. Saying that plainly is better than showing a page of zeroes
 * an operator would reasonably read as a business with no customers.
 */
function NoHistoryYet({ canSweep }: { canSweep: boolean }) {
  return (
    <ConsoleSection title="No history yet" description="The nightly snapshot has not run.">
      <EmptyState
        icon={CalendarClock}
        title="Nothing has been captured yet."
        description={
          <>
            Revenue, churn and retention are all computed from a daily snapshot of every workspace, taken at 03:40 UTC. Nothing can be backfilled — the figures
            it records are point-in-time counts, and there was never any history to recover — so this page fills in from the first sweep onward.{" "}
            {canSweep ? "Use “Snapshot now” to take the first one immediately." : "An operator with platform:operate can take the first one immediately."}
          </>
        }
      />
    </ConsoleSection>
  );
}

function Loaded({ data }: { data: RevenueOverview }) {
  const { mrr, churn, trials, cohorts, seatOverage, coverage, stripe } = data;
  const currency = mrr.currency;

  return (
    <>
      <KpiGrid>
        <KpiCard
          icon={Banknote}
          label="List MRR"
          value={mrr.mrrMinor / 100}
          format={(n) => money(Math.round(n * 100), currency)}
          tone="accent"
          hint={mrr.unpricedAccounts > 0 ? `Excludes ${mrr.unpricedAccounts} workspace${mrr.unpricedAccounts === 1 ? "" : "s"} with no list price` : "List price, not billed revenue"}
        />
        <KpiCard icon={LineChart} label="List ARR" value={mrr.arrMinor / 100} format={(n) => money(Math.round(n * 100), currency)} delay={0.05} hint="MRR × 12" />
        <KpiCard
          icon={Users}
          label="ARPA"
          value={(mrr.arpaMinor ?? 0) / 100}
          format={(n) => (mrr.arpaMinor === null ? "—" : money(Math.round(n * 100), currency, 2))}
          delay={0.1}
          hint={mrr.arpaMinor === null ? "No paying workspaces yet" : `${mrr.payingAccounts} paying · ${mrr.freeAccounts} free`}
        />
        <KpiCard
          icon={churn.netRevenueRetentionPercent !== null && churn.netRevenueRetentionPercent >= 100 ? TrendingUp : TrendingDown}
          label={`Net revenue retention (${churn.windowDays}d)`}
          value={churn.netRevenueRetentionPercent ?? 0}
          format={() => pct(churn.netRevenueRetentionPercent)}
          tone={churn.netRevenueRetentionPercent === null ? "default" : churn.netRevenueRetentionPercent >= 100 ? "success" : "warning"}
          delay={0.15}
          hint={churn.netRevenueRetentionPercent === null ? "Not enough history to compare" : `Gross ${pct(churn.grossRevenueRetentionPercent)}`}
        />
      </KpiGrid>

      {/* The coverage line. It is the first thing on the page under the tiles on purpose: every
          number above it is only as good as the series it came from, and a short series is the
          normal state for a while after this ships. */}
      <p className="text-xs text-muted-foreground">
        {coverage.snapshots.toLocaleString()} snapshots covering {coverage.days} day{coverage.days === 1 ? "" : "s"}
        {coverage.firstDay ? ` — ${shortDate(coverage.firstDay)} to ${shortDate(coverage.lastDay)}` : ""}.{" "}
        {mrr.mixedCurrencies && <span className="font-semibold text-warning">Tiers are priced in more than one currency, so the totals above add unlike amounts.</span>}
      </p>

      <ConsoleSection
        title="Revenue by tier"
        description="Revenue-bearing workspaces only — active, not on a running trial."
        flush
      >
        <ConsoleTable minWidth={720}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Tier</TableHead>
              <TableHead className="text-right">List price / seat</TableHead>
              <TableHead className="text-right">Workspaces</TableHead>
              <TableHead className="text-right">Billable seats</TableHead>
              <TableHead className="text-right">List MRR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mrr.byTier.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No revenue-bearing workspaces in the latest snapshot.
                </TableCell>
              </TableRow>
            ) : (
              mrr.byTier.map((tier) => (
                <TableRow key={tier.tier}>
                  <TableCell>
                    <TierPill tier={tier.tier} />
                  </TableCell>
                  <Num>{tier.perSeatMinor === null ? <span className="text-muted-foreground">Not set</span> : money(tier.perSeatMinor, currency, 2)}</Num>
                  <Num>{tier.accounts}</Num>
                  <Num>{tier.seats.toLocaleString()}</Num>
                  {/* An unpriced tier shows why it contributes nothing, rather than a $0 an
                      operator would read as "these customers pay us nothing". */}
                  <Num>{tier.mrrMinor === null ? <span className="text-muted-foreground">Priced per contract</span> : money(tier.mrrMinor, currency)}</Num>
                </TableRow>
              ))
            )}
          </TableBody>
        </ConsoleTable>
      </ConsoleSection>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
        <ConsoleSection title={`Churn (${churn.windowDays} days)`} description="Measured about the workspaces that were revenue-bearing at the start of the window.">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Stat label="Logo churn" value={pct(churn.logoChurnPercent)} hint={`${churn.churnedAccounts} of ${churn.startAccounts} workspaces`} />
            <Stat label="Revenue churn" value={pct(churn.revenueChurnPercent)} hint="Lost plus contracted, over starting MRR" />
            <Stat label="Expansion" value={money(churn.expansionMinor, currency)} hint="Growth inside the starting cohort" />
            <Stat label="Contraction" value={money(churn.contractionMinor, currency)} hint="Shrinkage inside the starting cohort" />
            <Stat label="New workspaces" value={String(churn.newAccounts)} hint="Arrived inside the window; excluded from churn" />
            <Stat label="Churned MRR" value={money(churn.churnedMrrMinor, currency)} hint="List value of the workspaces that left" />
          </dl>
          {churn.logoChurnPercent === null && (
            <p className="mt-3 text-xs text-muted-foreground">
              Not enough history to compare yet — churn needs two observations of the same fleet, and the snapshot series is {coverage.days} day
              {coverage.days === 1 ? "" : "s"} long. It is left blank rather than shown as 0%.
            </p>
          )}
          {mrr.unpricedAccounts > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {mrr.unpricedAccounts} workspace{mrr.unpricedAccounts === 1 ? " is" : "s are"} on a tier with no list price. They count as logos in the churn rate
              above and contribute nothing to either side of the revenue ratios.
            </p>
          )}
        </ConsoleSection>

        <ConsoleSection title="Trial → paid" description="Derived from the trial clock, the workspace status and the audit trail.">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Stat label="Conversion" value={pct(trials.conversionPercent)} hint="Of DECIDED trials — running ones are excluded" />
            <Stat label="Converted" value={String(trials.converted)} hint="Subscribed, or still active after the trial ended" />
            <Stat label="Lapsed" value={String(trials.lapsed)} hint="Trial ended, no plan followed" />
            <Stat label="Still trialling" value={String(trials.stillTrialing)} hint="Clock still running" />
            <Stat label="Trials started" value={String(trials.trialsStarted)} hint="All time" />
            <Stat
              label="Median days to convert"
              value={trials.medianDaysToConvert === null ? "—" : String(trials.medianDaysToConvert)}
              hint={trials.medianDaysToConvert === null ? "No conversion has a recorded date yet" : "Median, not mean"}
            />
          </dl>
        </ConsoleSection>
      </div>

      <ConsoleSection
        title="Seat overage"
        description="Workspaces at or above 90% of a real seat ceiling — the warmest expansion list this product can produce."
        flush
      >
        {seatOverage.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState
              icon={UserCheck}
              title="Nobody is near a seat limit."
              description="Workspaces on an unlimited-seat tier are not listed: there is no ceiling for them to approach, so a row would be noise in the one list that has to stay short enough to act on."
            />
          </div>
        ) : (
          <ConsoleTable minWidth={820}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Workspace</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Seats used</TableHead>
                <TableHead className="text-right">Ceiling</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead className="text-right">Utilisation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {seatOverage.map((row) => (
                <TableRow key={row.orgId}>
                  <TableCell>
                    <Link to={`/platform-admin/organizations/${row.orgId}`} className="font-medium text-foreground hover:text-accent hover:underline">
                      {row.name}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{row.slug}</span>
                  </TableCell>
                  <TableCell>
                    <TierPill tier={row.planTier} />
                  </TableCell>
                  <Num>{row.seatsUsed}</Num>
                  <Num>{row.seatLimit}</Num>
                  <Num className={row.seatsRemaining <= 0 ? "text-destructive" : undefined}>{row.seatsRemaining}</Num>
                  <Num>
                    <Badge variant={row.utilisation >= 1 ? "destructive" : "warning"}>{Math.round(row.utilisation * 100)}%</Badge>
                  </Num>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        )}
      </ConsoleSection>

      <ConsoleSection
        title="Retention by signup month"
        description={
          cohorts.observedFrom
            ? `Each row is the workspaces that signed up that month; each cell is how many were still active N months later. Snapshots cover ${cohorts.observedFrom} to ${cohorts.observedTo} — every month outside that is blank, not zero.`
            : "No snapshots yet, so every cell is unknown."
        }
        flush
      >
        {cohorts.rows.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState icon={CalendarClock} title="No workspaces to bucket yet." />
          </div>
        ) : (
          <ConsoleTable minWidth={140 + (cohorts.maxOffset + 1) * 64}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Cohort</TableHead>
                <TableHead className="text-right">Signed up</TableHead>
                {Array.from({ length: cohorts.maxOffset + 1 }, (_, i) => (
                  <TableHead key={i} className="text-right">
                    M{i}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohorts.rows.map((row) => (
                <TableRow key={row.cohort}>
                  <TableCell className="font-mono text-xs">{row.cohort}</TableCell>
                  <Num>{row.signedUp}</Num>
                  {row.cells.map((cell) => (
                    <Num key={cell.monthOffset} className="p-1">
                      <span
                        className={cn("inline-flex h-7 w-full min-w-[3rem] items-center justify-center rounded text-xs tabular-nums", cohortTone(cell))}
                        title={cell.percent === null ? "No snapshot covers this month" : `${cell.retained} of ${row.signedUp} still active`}
                      >
                        {cell.percent === null ? "·" : `${Math.round(cell.percent)}%`}
                      </span>
                    </Num>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        )}
      </ConsoleSection>

      {/* Only rendered when Stripe is actually configured. The common deployment assigns tiers by
          hand and has no Stripe account, and an empty "billed revenue" card on those installs would
          read as something broken. */}
      {stripe && <BilledRevenue stripe={stripe} />}
    </>
  );
}

/**
 * List against billed, and the gap — the one number on this page that is NOT list price.
 *
 * IT ADDS A SECOND NUMBER; IT DOES NOT REINTERPRET THE FIRST. Every list-price label above stays
 * exactly as it was, and this card names its own population rather than borrowing the page's: the
 * comparison covers only the workspaces that have a Stripe subscription, a successful
 * reconciliation, and a tier with a list price to be discounted from. Everything else is counted
 * as excluded and, where it failed, named.
 *
 * "NOT RECONCILED YET" IS NOT "NO GAP", and keeping those apart is most of the work here. A
 * `billedMrrMinor` of null renders as an em dash with the reason underneath; it must never render
 * as $0, because $0 billed against a real list MRR is a 100% discount — a spectacular claim to make
 * about a deployment whose nightly job simply has not run.
 */
/** The sentence under the discounting figure. Three states, and the third is a real one: billed
 *  ABOVE list happens (a legacy price, an amount edited by hand in Stripe) and is shown as such
 *  rather than clamped, because the only evidence the two disagree is the sign. */
function discountHint(stripe: NonNullable<RevenueOverview["stripe"]>): string {
  if (stripe.discountMinor === null) return "Needs a reconciled amount to compare";
  if (stripe.discountMinor >= 0) return `${pct(stripe.discountPercent)} below list`;
  return `${pct(stripe.discountPercent === null ? null : Math.abs(stripe.discountPercent))} ABOVE list`;
}

function BilledRevenue({ stripe }: { stripe: NonNullable<RevenueOverview["stripe"]> }) {
  const queryClient = useQueryClient();
  const role = usePlatformAdminAuthStore((s) => s.admin?.role);
  const canReconcile = role ? platformRoleHas(role, platformCapabilities.PLATFORM_BILLING) : false;
  const currency = stripe.currency;

  const reconcile = useMutation({
    mutationFn: platformRevenueApi.reconcileBilling,
    onSuccess: (result) => {
      if (!result.configured) toast.error("Stripe is not configured on this deployment.");
      else if (result.failed.length) toast.warning(`${result.reconciled} of ${result.attempted} reconciled — ${result.failed.map((f) => f.slug).join(", ")} failed.`);
      else toast.success(`Reconciled ${result.reconciled} workspace${result.reconciled === 1 ? "" : "s"} against Stripe.`);
      queryClient.invalidateQueries({ queryKey: ["platform-admin", "revenue"] });
    },
    onError: () => toast.error("The reconciliation could not be run.")
  });

  const reconciled = stripe.billedMrrMinor !== null;

  return (
    <ConsoleSection
      title="Billed revenue vs list price"
      description="What Stripe actually charges these workspaces, against what their plans advertise. The difference is discounting."
      actions={
        canReconcile ? (
          <Toolbar>
            <Button variant="outline" size="sm" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
              <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", reconcile.isPending && "animate-spin")} />
              {reconcile.isPending ? "Reconciling…" : "Reconcile now"}
            </Button>
          </Toolbar>
        ) : undefined
      }
    >
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="List MRR (compared)"
          value={money(stripe.comparableListMrrMinor, currency)}
          hint={reconciled ? `${stripe.comparedAccounts} of ${stripe.subscribedAccounts} subscribed workspaces` : "Nothing to compare yet"}
        />
        <Stat
          label="Billed MRR"
          value={money(stripe.billedMrrMinor, currency)}
          /* The two sentences this card exists to keep apart. */
          hint={reconciled ? "What Stripe charges, normalised to a month" : "Not reconciled yet — this is not a gap of zero"}
        />
        <Stat label="Discounting" value={money(stripe.discountMinor, currency)} hint={discountHint(stripe)} />
        <Stat
          label="Last reconciled"
          value={stripe.lastReconciledAt ? shortDate(stripe.lastReconciledAt) : "—"}
          hint={stripe.lastReconciledAt ? "Nightly at 03:50 UTC" : "The nightly sweep has not run"}
        />
      </dl>

      <p className="mt-3 text-xs text-muted-foreground">
        {stripe.note} The fleet's whole list MRR is {money(stripe.listMrrMinor, currency)}; only the workspaces named above are part of this comparison.{" "}
        {stripe.mixedCurrencies && <span className="font-semibold text-warning">The compared workspaces are not all in one currency, so the subtraction adds unlike amounts.</span>}
      </p>

      {/* Named, not counted. An operator cannot chase "3 failed"; they can chase three slugs. */}
      {stripe.failures.length > 0 && (
        <ul className="mt-3 grid gap-2">
          {stripe.failures.map((failure) => (
            <li key={failure.orgId} className="min-w-0 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              <Link to={`/platform-admin/organizations/${failure.orgId}`} className="font-medium text-foreground hover:text-accent hover:underline">
                {failure.name}
              </Link>
              <span className="ml-2 font-mono text-xs text-muted-foreground">{failure.slug}</span>
              <p className="mt-1 text-xs text-muted-foreground">{failure.message} Excluded from the figures above rather than counted as zero.</p>
            </li>
          ))}
        </ul>
      )}
    </ConsoleSection>
  );
}

/** A labelled figure with the sentence that makes it mean something. The hint is not decoration:
 *  it is what stops "12.4%" being read as the wrong 12.4%. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border p-3">
      <dt className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-black tabular-nums tracking-tight text-foreground">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
