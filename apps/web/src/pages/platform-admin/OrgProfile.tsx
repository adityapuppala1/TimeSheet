/**
 * WHAT: Org 360 — one page that answers "what is going on with Acme".
 *
 * WHY IT EXISTS. Answering that question meant opening five screens: Organizations for the plan and
 * status, Monitoring for the database, Backups for whether the last run worked, Platform emails for
 * whether their mail is getting out, and the audit log for what an operator last did to them. Each
 * of those pages is right; none of them is the question. A support call does not have five tabs of
 * patience.
 *
 * IT COMPOSES, IT DOES NOT REWRITE. Every panel below is an existing endpoint rendered in a smaller
 * frame — `platformAdminOrgApi.get`, `platformOpsExtrasApi.trend`, `platformBackupApi.overview`,
 * `platformAdminConsoleApi.emailLog`, `platformAdminConsoleApi.audit`, `platformOpsExtrasApi.advice`
 * — plus the one genuinely new read, the usage snapshot series. Nothing here has its own copy of
 * anything, deliberately: a second implementation of "is this workspace healthy" that disagrees
 * with the first is worse than the five tabs were.
 *
 * WHAT IT NEVER SHOWS. Counts, sizes, statuses and timestamps. No ticket title, no comment, no
 * timesheet, nobody's name from inside the workspace — the same guarantee every cross-tenant screen
 * in this console holds, and the reason `platform-admin-analytics.service.ts` exists as a single
 * audited boundary. The one exception this page inherits is the platform's OWN email log, which
 * holds addresses the PLATFORM sent to, not the workspace's own correspondence.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Banknote,
  Brain,
  Building2,
  CheckCircle2,
  DatabaseBackup,
  HardDrive,
  History,
  KeyRound,
  Mails,
  Radio,
  ScrollText,
  Siren,
  UserCog,
  Users,
  type LucideIcon
} from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import {
  platformAdminConsoleApi,
  platformAdminOrgApi,
  platformAlertsApi,
  platformBackupApi,
  platformOpsExtrasApi,
  platformRevenueApi,
  type FeatureOverrideEffect,
  type TimelineEntry
} from "../../services/platform-admin-api";
import {
  ConsolePage,
  ConsoleSection,
  ConsoleTable,
  EmptyState,
  KpiCard,
  KpiGrid,
  Num,
  OrgStatusPill,
  PRIMARY_BTN,
  TierPill,
  Toolbar,
  formatBytes,
  shortDate,
  shortDateTime
} from "./console-ui";
import { HealthBandPill, HealthSignals } from "./health-ui";

const money = (minor: number | null, currency: string) =>
  minor === null ? "Not set" : new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

/** The forecast's own confidence, as a pill. `none` is `muted` rather than `destructive`: refusing
 *  to project is the correct answer on a young series, not a fault. */
const FORECAST_VARIANT: Record<string, "muted" | "info" | "warning" | "success"> = {
  none: "muted",
  low: "warning",
  moderate: "info",
  high: "success"
};

const TIMELINE_ICON: Record<TimelineEntry["kind"], LucideIcon> = {
  alert: Siren,
  "alert-cleared": CheckCircle2,
  backup: DatabaseBackup,
  operator: UserCog,
  maintenance: Radio,
  email: Mails
};

const TIMELINE_LABEL: Record<TimelineEntry["kind"], string> = {
  alert: "alert opened",
  "alert-cleared": "alert cleared",
  backup: "backup",
  operator: "operator",
  maintenance: "maintenance",
  email: "email"
};

/** What an override DOES, in a word. Maps rather than a ternary chain, so the vocabulary the
 *  operator reads is one greppable list beside the classification it comes from. */
const OVERRIDE_EFFECT_VARIANT: Record<FeatureOverrideEffect, "warning" | "info" | "muted"> = {
  grant: "warning",
  restrict: "info",
  noop: "muted"
};

const OVERRIDE_EFFECT_LABEL: Record<FeatureOverrideEffect, string> = {
  grant: "grants beyond plan",
  restrict: "restricts",
  noop: "matches plan"
};

const TIMELINE_TONE: Record<TimelineEntry["severity"], string> = {
  critical: "bg-destructive/15 text-destructive",
  warning: "bg-warning/15 text-warning",
  info: "bg-muted text-muted-foreground"
};

export function PlatformAdminOrgProfile() {
  const { orgId = "" } = useParams();

  /* Six independent queries rather than one composite endpoint. That is the point of composing:
     each panel fails, loads and refetches on its own, so an unreachable database does not blank the
     plan and the audit trail beside it — which is exactly when an operator most needs to read them. */
  const org = useQuery({ queryKey: ["platform-admin", "org-profile", orgId], queryFn: () => platformAdminOrgApi.get(orgId), enabled: Boolean(orgId) });
  const usage = useQuery({ queryKey: ["platform-admin", "org-usage", orgId], queryFn: () => platformRevenueApi.orgUsage(orgId), enabled: Boolean(orgId) });
  const trend = useQuery({ queryKey: ["platform-admin", "org-db-trend", orgId], queryFn: () => platformOpsExtrasApi.trend(orgId, 30), enabled: Boolean(orgId) });
  const backups = useQuery({ queryKey: ["platform-admin", "backups-overview"], queryFn: platformBackupApi.overview });
  const emails = useQuery({ queryKey: ["platform-admin", "org-emails", orgId], queryFn: () => platformAdminConsoleApi.emailLog({ orgId, limit: 10 }), enabled: Boolean(orgId) });
  const audit = useQuery({ queryKey: ["platform-admin", "org-audit", orgId], queryFn: () => platformAdminConsoleApi.audit({ entity: "Organization", limit: 100 }), enabled: Boolean(orgId) });
  const advice = useQuery({ queryKey: ["platform-admin", "org-advice", orgId], queryFn: () => platformOpsExtrasApi.advice(orgId), enabled: Boolean(orgId) });
  const timeline = useQuery({ queryKey: ["platform-admin", "org-timeline", orgId], queryFn: () => platformAlertsApi.timeline(orgId, 90), enabled: Boolean(orgId) });

  const latest = usage.data?.latest ?? null;
  const runs = (backups.data?.recentRuns ?? []).filter((run) => run.organizationId === orgId).slice(0, 6);
  const policy = backups.data?.workspaces.find((workspace) => workspace.organizationId === orgId)?.policy ?? null;
  // The audit endpoint filters by ENTITY, not by id, so the id filter happens here. Cheap, and it
  // avoids a new query parameter on a route that four other screens already use.
  const auditRows = (audit.data?.rows ?? []).filter((row) => row.entityId === orgId).slice(0, 12);

  return (
    <ConsolePage
      eyebrow="Tenants"
      title={org.data?.name ?? "Workspace"}
      description={
        org.data ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{org.data.slug}</span>
            <OrgStatusPill status={org.data.status} />
            <TierPill tier={org.data.planTier} />
            <span>Created {shortDate(org.data.createdAt)}</span>
          </span>
        ) : (
          "Everything the console knows about one workspace, composed from the pages that already had it."
        )
      }
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link to="/platform-admin/organizations">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            All workspaces
          </Link>
        </Button>
      }
    >
      {usage.isLoading && (
        <KpiGrid>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[6.5rem] w-full rounded-xl" />
          ))}
        </KpiGrid>
      )}

      {!usage.isLoading && (
        <KpiGrid>
          <KpiCard icon={Users} label="Seats in use" value={latest?.seatsUsed ?? 0} tone="accent" hint={latest ? `Ceiling ${latest.seatLimit >= 1_000_000 ? "unlimited" : latest.seatLimit}` : "No snapshot yet"} />
          <KpiCard
            icon={Banknote}
            label="List MRR"
            value={(usage.data?.listMrrMinor ?? 0) / 100}
            format={() => money(usage.data?.listMrrMinor ?? null, usage.data?.currency ?? "USD")}
            delay={0.05}
            hint="List price, not billed revenue"
          />
          <KpiCard
            icon={Activity}
            label="Days since sign-in"
            value={latest?.daysSinceLastActivity ?? 0}
            format={(n) => (latest?.daysSinceLastActivity === null || latest === null ? "—" : Math.round(n).toString())}
            delay={0.1}
            hint={latest?.daysSinceLastActivity === null ? "Nobody has ever signed in" : undefined}
          />
          <KpiCard
            icon={HardDrive}
            label="Database"
            value={usage.data?.series[usage.data.series.length - 1]?.databaseBytes ?? 0}
            format={(n) => formatBytes(n || null)}
            delay={0.15}
            hint={trend.data?.growth.bytesPerDay ? `${formatBytes(trend.data.growth.bytesPerDay)}/day` : "No growth rate yet"}
          />
        </KpiGrid>
      )}

      {/* Health first, because it is the panel that says what to do about everything below it. */}
      <ConsoleSection
        title="Account health"
        description="Scored from the nightly snapshots. The band is never shown without the signal that produced it."
        actions={usage.data?.health ? <HealthBandPill band={usage.data.health.band} score={usage.data.health.score} /> : undefined}
      >
        {usage.isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : usage.data?.health ? (
          <HealthSignals health={usage.data.health} />
        ) : (
          <EmptyState
            icon={Activity}
            title="No snapshot for this workspace yet."
            description="Health is scored from the daily usage snapshot, which runs at 03:40 UTC. It cannot be backfilled, so this fills in from the first sweep onward."
          />
        )}
        {usage.data && usage.data.coverage.snapshots > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            {usage.data.coverage.snapshots} daily snapshot{usage.data.coverage.snapshots === 1 ? "" : "s"} — {shortDate(usage.data.coverage.firstDay)} to{" "}
            {shortDate(usage.data.coverage.lastDay)}.
          </p>
        )}
      </ConsoleSection>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
        <ConsoleSection title="Usage, day by day" description="Seats, backlog and AI spend from the snapshot series." flush>
          {(usage.data?.series.length ?? 0) === 0 ? (
            <div className="p-4 sm:p-5">
              <EmptyState icon={Building2} title="Nothing captured yet." />
            </div>
          ) : (
            <ConsoleTable minWidth={620}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Seats</TableHead>
                  <TableHead className="text-right">Agents</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Tickets</TableHead>
                  <TableHead className="text-right">AI spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Newest first for reading; the series arrives oldest-first for charting. */}
                {[...(usage.data?.series ?? [])].reverse().slice(0, 14).map((point) => (
                  <TableRow key={point.day} className={point.reachable ? undefined : "opacity-60"}>
                    <TableCell className="whitespace-nowrap">
                      {shortDate(point.day)}
                      {!point.reachable && (
                        <Badge variant="warning" className="ml-2">
                          Unreachable
                        </Badge>
                      )}
                    </TableCell>
                    <Num>{point.activeSeats}</Num>
                    <Num>{point.agentSeats || <span className="text-muted-foreground/60">—</span>}</Num>
                    <Num>{point.ticketsOpen}</Num>
                    <Num>{point.ticketsTotal}</Num>
                    <Num>${point.aiSpendUsd.toFixed(2)}</Num>
                  </TableRow>
                ))}
              </TableBody>
            </ConsoleTable>
          )}
        </ConsoleSection>

        <ConsoleSection title="Database" description="From the hourly sampler — the same series the Monitoring page charts.">
          {trend.isLoading ? (
            <Skeleton className="h-24 w-full rounded-lg" />
          ) : (trend.data?.points.length ?? 0) === 0 ? (
            <EmptyState icon={HardDrive} title="No database samples yet." />
          ) : (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Fact label="Size" value={formatBytes(trend.data!.points[trend.data!.points.length - 1].totalBytes)} />
              <Fact label="Growth" value={trend.data!.growth.bytesPerDay === null ? "—" : `${formatBytes(trend.data!.growth.bytesPerDay)}/day`} />
              <Fact label="Change over window" value={trend.data!.growth.percentChange === null ? "—" : `${trend.data!.growth.percentChange.toFixed(1)}%`} />
              <Fact
                label="Days to 50 GB"
                value={trend.data!.growth.daysToTarget === null ? "Flat or shrinking" : Math.round(trend.data!.growth.daysToTarget).toLocaleString()}
              />
              <Fact label="Samples" value={String(trend.data!.growth.samples)} />
              <Fact label="Last sample" value={shortDateTime(trend.data!.growth.lastSampleAt)} />
              {/*
               * THE FORECAST, AND ITS REFUSAL, given the same weight (5.0.0).
               *
               * The two facts above measure what the series DID between its ends. This one infers
               * what it will do next, and it declines far more often than it commits — "not enough
               * history" and "too noisy to project" are the honest answers on a young or lumpy
               * series, and a page that showed a confident date in those cases would be worse than
               * a page that showed nothing. So the reason is rendered whether or not there is a
               * projection: the number is only usable beside the evidence for it.
               */}
              <div className="min-w-0 rounded-lg border border-border p-3 sm:col-span-2">
                <dt className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Capacity forecast
                  <Badge variant={FORECAST_VARIANT[trend.data!.forecast.confidence]}>
                    {trend.data!.forecast.confidence === "none" ? "no projection" : `${trend.data!.forecast.confidence} confidence`}
                  </Badge>
                </dt>
                <dd className="mt-1 text-sm font-semibold text-foreground">
                  {trend.data!.forecast.daysToTarget === null
                    ? "Not projected"
                    : `Reaches ${formatBytes(trend.data!.forecast.targetBytes)} in about ${Math.round(trend.data!.forecast.daysToTarget).toLocaleString()} days — ${shortDate(
                        trend.data!.forecast.reachesTargetAt
                      )}`}
                </dd>
                <dd className="mt-1 text-xs text-muted-foreground">{trend.data!.forecast.reason}</dd>
              </div>
              {/* Persisted since 5.0.0, so "when did this start" finally has an answer. Null means
                  the sample predates the columns — a gap, not a clean bill of health. */}
              {trend.data!.schemaFindings.tablesWithoutPrimaryKey !== null && (
                <Fact
                  label="Tables without a primary key"
                  value={
                    trend.data!.schemaFindings.tablesWithoutPrimaryKey === 0
                      ? "None"
                      : `${trend.data!.schemaFindings.tablesWithoutPrimaryKey} — since ${shortDate(trend.data!.schemaFindings.firstSeen.tablesWithoutPrimaryKey)}`
                  }
                />
              )}
              {trend.data!.schemaFindings.indexHeavyTables !== null && (
                <Fact
                  label="Index-heavy tables"
                  value={
                    trend.data!.schemaFindings.indexHeavyTables === 0
                      ? "None"
                      : `${trend.data!.schemaFindings.indexHeavyTables} — since ${shortDate(trend.data!.schemaFindings.firstSeen.indexHeavyTables)}`
                  }
                />
              )}
            </dl>
          )}
          <Button variant="outline" size="sm" className="mt-4" asChild>
            <Link to="/platform-admin/monitoring">Open Monitoring</Link>
          </Button>
        </ConsoleSection>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
        <ConsoleSection
          title="Backups"
          description={policy ? `${policy.enabled ? "Scheduled" : "Policy off"} — the last runs, newest first.` : "No managed-backup policy configured."}
          flush
        >
          {runs.length === 0 ? (
            <div className="p-4 sm:p-5">
              <EmptyState icon={DatabaseBackup} title="No backup runs recorded." />
            </div>
          ) : (
            <ConsoleTable minWidth={560}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Started</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="whitespace-nowrap">{shortDateTime(run.startedAt)}</TableCell>
                    <TableCell>{run.kind}</TableCell>
                    <TableCell className="truncate">{run.destinationName ?? "—"}</TableCell>
                    <Num>
                      <Badge variant={run.status === "SUCCEEDED" ? "success" : run.status === "FAILED" ? "destructive" : "muted"}>{run.status}</Badge>
                    </Num>
                  </TableRow>
                ))}
              </TableBody>
            </ConsoleTable>
          )}
        </ConsoleSection>

        <ConsoleSection title="Platform email" description="What THIS platform sent to this workspace — never the workspace's own correspondence." flush>
          {(emails.data?.length ?? 0) === 0 ? (
            <div className="p-4 sm:p-5">
              <EmptyState icon={Mails} title="No platform email to this workspace." />
            </div>
          ) : (
            <ConsoleTable minWidth={560}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Sent</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(emails.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">{shortDateTime(row.createdAt)}</TableCell>
                    <TableCell className="truncate font-mono text-xs">{row.templateKey}</TableCell>
                    <Num>
                      <Badge variant={row.status === "SENT" ? "success" : row.status === "FAILED" ? "destructive" : "muted"}>{row.status}</Badge>
                    </Num>
                  </TableRow>
                ))}
              </TableBody>
            </ConsoleTable>
          )}
        </ConsoleSection>
      </div>

      {/* THE MERGE, and it is the reason this section exists at all: the five panels above are five
          lists, and "when did this start?" is a question you can only answer by reading them side by
          side and merging by eye, under pressure. That merge is mechanical, so the server does it. */}
      <ConsoleSection
        title="Incident timeline"
        description="Alerts opening and clearing, backup runs, maintenance windows, failed platform email and every operator action — one chronology, newest first."
        flush
      >
        {timeline.isLoading && <div className="p-4 sm:p-5"><Skeleton className="h-48 w-full rounded-lg" /></div>}
        {!timeline.isLoading && (timeline.data?.entries.length ?? 0) === 0 && (
          <div className="p-4 sm:p-5">
            <EmptyState icon={History} title="Nothing recorded in the last 90 days." description="No alert, backup, broadcast, email failure or operator action touched this workspace." />
          </div>
        )}
        {(timeline.data?.entries.length ?? 0) > 0 && (
          <ol className="divide-y divide-border">
            {(timeline.data?.entries ?? []).map((entry, index) => (
              <li key={`${entry.at}-${entry.kind}-${index}`} className="flex min-w-0 items-start gap-3 p-4 sm:p-5">
                <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg", TIMELINE_TONE[entry.severity])}>
                  {(() => {
                    const Icon = TIMELINE_ICON[entry.kind];
                    return <Icon className="h-3.5 w-3.5" />;
                  })()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words text-sm font-medium text-foreground">{entry.title}</span>
                    <Badge variant="muted">{TIMELINE_LABEL[entry.kind]}</Badge>
                  </p>
                  {entry.detail && <p className="mt-0.5 break-words text-xs text-muted-foreground">{entry.detail}</p>}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {shortDateTime(entry.at)}
                    {entry.actor ? ` · ${entry.actor}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </ConsoleSection>

      <FeatureOverridesCard orgId={orgId} />

      <ConsoleSection title="What operators did to this workspace" description="The control-plane audit trail, filtered to this workspace." flush>
        {auditRows.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState icon={ScrollText} title="No recorded actions." />
          </div>
        ) : (
          <ConsoleTable minWidth={720}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Operator</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">{shortDateTime(row.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{row.action}</TableCell>
                  <TableCell className="truncate">{row.actorLabel ?? row.actorType}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        )}
      </ConsoleSection>

      <ConsoleSection title="AI advisor" description="Advisories generated for this workspace. Nothing here runs on its own." flush>
        {(advice.data?.advice.length ?? 0) === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState icon={Brain} title="No advisories yet." description="Generate one from Monitoring, where the advisor lives." />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {(advice.data?.advice ?? []).slice(0, 4).map((row) => (
              <li key={row.id} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={row.status === "PENDING" ? "warning" : row.status === "APPLIED" ? "success" : "muted"}>{row.status}</Badge>
                  <span className="text-xs text-muted-foreground">{shortDateTime(row.createdAt)}</span>
                  <span className="font-mono text-xs text-muted-foreground">{row.model}</span>
                </div>
                <p className={cn("mt-2 text-sm text-foreground")}>{row.summary || "No summary."}</p>
                {row.findings && row.findings.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.findings.length} finding{row.findings.length === 1 ? "" : "s"} — {row.findings[0].title}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </ConsoleSection>
    </ConsolePage>
  );
}

/**
 * Per-org feature overrides — the general escape from the tier defaults.
 *
 * THE GRANT IS NEVER SILENT, and this card is where that promise is kept in the interface. Every
 * key the operator has changed is shown with its EFFECT against the workspace's current tier, and a
 * key that grants something the plan forbids paints as a warning and is listed by name in a
 * confirmation the operator has to tick. The server refuses the write without that tick and records
 * the granting keys in the audit trail, so the console is the explanation and not the enforcement.
 *
 * READ-ONLY UNTIL THE OPERATOR ASKS. Overrides are rare and consequential; a form permanently open
 * on the org profile invites a stray click. Editing is behind a toggle, the way every other
 * consequential control in this console is.
 */
function FeatureOverridesCard({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const overrides = useQuery({ queryKey: ["platform-admin", "org-overrides", orgId], queryFn: () => platformAlertsApi.featureOverrides(orgId), enabled: Boolean(orgId) });
  const [draft, setDraft] = useState<Record<string, boolean | number> | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const view = overrides.data;
  const editing = draft !== null;
  /* Judged against the tier as it stands, using the same classification the server will apply — so
     the warning the operator reads and the refusal they would get cannot disagree. */
  const draftGrants = view
    ? Object.entries(draft ?? {})
        .filter(([key, value]) => {
          const known = view.available.find((entry) => entry.key === key);
          if (!known) return false;
          return typeof value === "boolean" ? value === true && known.tierValue === false : typeof known.tierValue === "number" && value > known.tierValue;
        })
        .map(([key]) => key)
    : [];

  const save = useMutation({
    mutationFn: () => platformAlertsApi.saveFeatureOverrides(orgId, draft ?? {}, acknowledged),
    onSuccess: () => {
      toast.success("Overrides saved");
      setDraft(null);
      setAcknowledged(false);
      queryClient.invalidateQueries({ queryKey: ["platform-admin", "org-overrides", orgId] });
      queryClient.invalidateQueries({ queryKey: ["platform-admin", "org-timeline", orgId] });
    },
    onError: (error) => toast.error("Could not save overrides", { description: errorMessageOf(error) })
  });

  return (
    <ConsoleSection
      title="Feature overrides"
      description={
        view
          ? `Per-workspace exceptions to the ${view.effectiveTier} plan. An override that grants something the plan does not include is recorded in the audit trail against your name.`
          : "Per-workspace exceptions to the plan defaults."
      }
      actions={
        view ? (
          <Toolbar>
            {editing ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDraft(null);
                    setAcknowledged(false);
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" className={PRIMARY_BTN} onClick={() => save.mutate()} disabled={save.isPending || (draftGrants.length > 0 && !acknowledged)}>
                  {save.isPending ? "Saving…" : "Save overrides"}
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setDraft({ ...view.overrides })}>
                Edit overrides
              </Button>
            )}
          </Toolbar>
        ) : undefined
      }
      bodyClassName="grid gap-4"
    >
      {overrides.isLoading && <Skeleton className="h-24 w-full rounded-lg" />}

      {view && !editing && view.classified.length === 0 && (
        <EmptyState
          icon={KeyRound}
          title="No overrides — this workspace gets exactly what its plan includes."
          description="Use one to switch a single beta on for a design partner without moving their whole tier and handing them nine other features nobody agreed to."
        />
      )}

      {view && !editing && view.classified.length > 0 && (
        <ul className="grid gap-2">
          {view.classified.map((entry) => (
            <li key={entry.key} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.key}</span>
              <span className="tabular-nums text-muted-foreground">
                plan {String(entry.tierValue)} → <span className="font-semibold text-foreground">{String(entry.overrideValue)}</span>
              </span>
              <Badge variant={OVERRIDE_EFFECT_VARIANT[entry.effect]}>{OVERRIDE_EFFECT_LABEL[entry.effect]}</Badge>
            </li>
          ))}
        </ul>
      )}

      {view && editing && (
        <>
          {/* The capability switches. Offered from the SERVER'S allowlist (`available`), not from
              the keys this workspace happens to have set — otherwise a workspace with no overrides
              would present an editor with nothing in it, which is the common case. */}
          <div className="grid gap-2 sm:grid-cols-2">
            {view.available
              .filter((entry) => entry.kind === "boolean")
              .map((entry) => {
                const current = draft?.[entry.key];
                const value = current === undefined ? Boolean(entry.tierValue) : Boolean(current);
                const grants = value && entry.tierValue === false;
                return (
                  <label
                    key={entry.key}
                    className={cn("flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm", grants ? "border-warning/40 bg-warning/10" : "border-border")}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-[hsl(var(--accent))]"
                      checked={value}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setDraft((d) => {
                          const copy = { ...(d ?? {}) };
                          // Back at the plan default means NO override, not an override that agrees
                          // with the plan — otherwise a tier change later would leave a stale key
                          // silently pinning this workspace to yesterday's answer.
                          if (next === Boolean(entry.tierValue)) delete copy[entry.key];
                          else copy[entry.key] = next;
                          return copy;
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={entry.key}>
                      {entry.key}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">plan: {String(entry.tierValue)}</span>
                  </label>
                );
              })}
          </div>
          {/* Quotas are numbers, and a spinner per quota beside seventeen checkboxes reads as a
              form nobody wants to meet. They keep their existing values and can be cleared; setting
              a new one is rare enough to belong in a later pass rather than in a crowded card. */}
          {view.available.filter((entry) => entry.kind === "quota" && draft?.[entry.key] !== undefined).length > 0 && (
            <ul className="grid gap-2">
              {view.available
                .filter((entry) => entry.kind === "quota" && draft?.[entry.key] !== undefined)
                .map((entry) => (
                  <li key={entry.key} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.key}</span>
                    <span className="tabular-nums text-muted-foreground">
                      plan {String(entry.tierValue)} → <span className="font-semibold text-foreground">{String(draft?.[entry.key])}</span>
                    </span>
                    <Button variant="outline" size="sm" onClick={() => setDraft((d) => { const copy = { ...(d ?? {}) }; delete copy[entry.key]; return copy; })}>
                      Remove
                    </Button>
                  </li>
                ))}
            </ul>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => {
              setDraft({});
              setAcknowledged(false);
            }}
          >
            Clear every override
          </Button>

          {draftGrants.length > 0 && (
            /* The acknowledgement. Not a nicety: the server refuses the write without it, names the
               same keys in its refusal, and records them in the audit row. */
            <label className="flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--accent))]" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span className="min-w-0">
                This grants <span className="font-mono text-xs">{draftGrants.join(", ")}</span> beyond what the {view.effectiveTier} plan includes. That is allowed — confirm it, and it is recorded
                against your name in the control-plane audit trail.
              </span>
            </label>
          )}
        </>
      )}
    </ConsoleSection>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border p-3">
      <dt className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
