/**
 * The console's landing page: what an operator needs to know in the first ten seconds of the day.
 * Tenants by state, trials in flight, what the retention programme is about to do, whether platform
 * mail is healthy, what customers are saying, and what changed recently — every number a link to
 * the page that explains it. Counts only; never row-level tenant content.
 *
 * LAYOUT (3.12.x). The page owns no geometry of its own any more — `KpiGrid`, `ConsoleSection` and
 * `ConsoleTable` do. Four decisions worth keeping:
 *   - the two card rows are `items-stretch` grids of five columns split 2:3, and every card is
 *     `h-full`, so each row reads as one band rather than two cards with a step between them;
 *   - the signups chart fills whatever height that stretch produces (`flex-1` body, `h-full` chart)
 *     over a width-tiered `min-h` floor, so it keeps a sensible aspect ratio at 390 as well as at
 *     1440 instead of being pinned to one fixed height that looks squat on a phone and thin wide;
 *   - "Tenants by state" was four blocks that looked unrelated (bar, legend, tier chips, a button
 *     stranded at the bottom). The count column is now a real table so the numbers line up under a
 *     header, the tier chips sit under their own label, and the link moved to the section's actions
 *     where every other "go to the page that explains this" link in the console lives;
 *   - the retention summary is a `<dl>`: a two-column grid of term and value, which is what a
 *     key/value list actually is and what makes the values share one right edge.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Building2, HeartHandshake, MailCheck, MailX, MessageSquareHeart, Sparkles, Star, Trash2, UserPlus } from "lucide-react";
import { Link } from "react-router";
import { Area, AreaChart, ResponsiveContainer, Tooltip as RTooltip, XAxis } from "recharts";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { platformAdminConsoleApi, type PlatformAuditRow } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, KpiCard, KpiGrid, Num, PRIMARY_BTN, TierPill, shortDateTime } from "./console-ui";

const STATUS_ORDER = ["ACTIVE", "GRACE", "SUSPENDED", "PROVISIONING", "ARCHIVED"] as const;
const STATUS_TONE: Record<(typeof STATUS_ORDER)[number], string> = {
  ACTIVE: "bg-success",
  GRACE: "bg-warning",
  SUSPENDED: "bg-destructive",
  PROVISIONING: "bg-info",
  ARCHIVED: "bg-muted-foreground/40"
};

const ACTION_LABEL: Record<string, string> = {
  "retention.workspace_deleted": "Workspace deleted under the retention policy",
  "retention.workspace_restored": "Workspace restored by its owner",
  "retention.feedback_received": "Feedback received",
  "retention.hold_set": "Deletion put on hold",
  "retention.hold_released": "Deletion hold released",
  "retention.settings_updated": "Retention policy changed",
  "retention.tick_run": "Retention pass run by hand",
  "platform_mail.updated": "Platform mail settings changed",
  "platform_email_template.updated": "Platform email template edited",
  "platform_email_template.reverted": "Platform email template reverted",
  "platform_email.resent": "Email resent",
  "platform_admin.created": "Platform admin created",
  "platform_admin.inactive": "Platform admin deactivated",
  "platform_admin.active": "Platform admin reactivated"
};

/**
 * One audit line. Three columns at `sm+` — marker, what happened, when — so the timestamps form a
 * column instead of trailing every sentence at a different x. On a phone the timestamp drops to its
 * own line under the label rather than fighting a long action name for the same row.
 */
function ActivityRow({ row }: { row: PlatformAuditRow }) {
  const label = ACTION_LABEL[row.action] ?? row.action;
  const who = row.actorType === "SYSTEM" ? "scheduler" : row.actorType === "CUSTOMER" ? `customer · ${row.actorLabel ?? ""}` : row.actorLabel ?? "platform admin";
  const slug = (row.metadata as { slug?: string } | null)?.slug;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-x-4 sm:px-5">
      <span aria-hidden className="mt-[0.4rem] h-2 w-2 rounded-full bg-accent" />
      <div className="min-w-0">
        <p className="text-sm text-foreground">
          {label}
          {slug && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{slug}</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">{who}</p>
      </div>
      {/* Column three at `sm+`, row two on a phone: same element, no duplicated copy. */}
      <p className="col-start-2 text-xs tabular-nums text-muted-foreground sm:col-start-3 sm:row-start-1 sm:whitespace-nowrap sm:text-right">
        <time dateTime={row.createdAt}>{shortDateTime(row.createdAt)}</time>
      </p>
    </li>
  );
}

export function PlatformAdminOverview() {
  const overview = useQuery({ queryKey: ["platform-admin", "overview"], queryFn: platformAdminConsoleApi.overview, refetchInterval: 60_000 });
  const d = overview.data;

  return (
    <ConsolePage eyebrow="Control plane" title="Overview" description="Every tenant on the platform at a glance — lifecycle, trials, the retention programme, platform mail health and what customers are telling you.">
      {overview.isLoading && (
        <KpiGrid>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full sm:h-[6.5rem]" />
          ))}
        </KpiGrid>
      )}

      {d && (
        <>
          <KpiGrid>
            <KpiCard label="Organizations" value={d.orgs.total} icon={Building2} tone="accent" hint={`${d.orgs.byStatus.ACTIVE ?? 0} active · ${d.orgs.byStatus.GRACE ?? 0} in grace`} />
            <KpiCard label="Signups, 30 days" value={d.orgs.signups30} icon={UserPlus} tone="success" hint={`${d.orgs.trialsActive} trial${d.orgs.trialsActive === 1 ? "" : "s"} running now`} delay={0.05} />
            <KpiCard label="In retention" value={d.retention.inProgramme} icon={HeartHandshake} tone={d.retention.dueSoon > 0 ? "warning" : "default"} hint={d.retention.dueSoon > 0 ? `${d.retention.dueSoon} within 14 days of deletion` : d.retention.enabled ? "Programme on" : "Programme off"} delay={0.1} />
            <KpiCard label="Deleted under policy" value={d.orgs.deletedUnderPolicy} icon={Trash2} hint={d.retention.autoDeleteEnabled ? "Auto-delete on" : "Auto-delete OFF"} delay={0.15} />
            <KpiCard label="Emails sent, 30 days" value={d.email.sent30} icon={MailCheck} tone="success" hint={d.email.configured ? `Relay from ${d.email.source === "database" ? "console settings" : ".env"}` : "No relay configured"} delay={0.2} />
            <KpiCard label="Emails failed, 30 days" value={d.email.failed30 + d.email.skipped30} icon={MailX} tone={d.email.failed30 + d.email.skipped30 > 0 ? "destructive" : "default"} hint={d.email.skipped30 > 0 ? `${d.email.skipped30} skipped (no relay)` : undefined} delay={0.25} />
            <KpiCard label="Feedback responses" value={d.feedback.count} icon={MessageSquareHeart} delay={0.3} />
            <KpiCard label="Average rating" value={d.feedback.avgRating ?? 0} icon={Star} tone="accent" format={(n) => (d.feedback.avgRating === null ? "—" : `${n.toFixed(1)} / 5`)} delay={0.35} />
          </KpiGrid>

          {/* 2:3, not 1:2. A third of a 1024px console is ~190px of card interior — narrower than a
              state name beside its count — so the old one-third column made the legend either wrap
              or scroll. Five columns give the left card the width its content actually needs. */}
          <div className="grid min-w-0 items-stretch gap-6 lg:grid-cols-5">
            <ConsoleSection
              title="Tenants by state"
              description="Where every organization sits in its lifecycle."
              className="h-full lg:col-span-2"
              bodyClassName="grid content-start gap-4"
              actions={
                <Button asChild size="sm" className={PRIMARY_BTN}>
                  <Link to="/platform-admin/organizations">Open organizations</Link>
                </Button>
              }
            >
              {/* The bar is decoration for the table under it — same five numbers, same five colours
                  — so it is hidden from assistive tech rather than repeated as five title strings. */}
              <div aria-hidden className="flex h-3 w-full min-w-0 overflow-hidden rounded-full bg-muted">
                {STATUS_ORDER.map((s) => {
                  const n = d.orgs.byStatus[s] ?? 0;
                  return n > 0 ? <span key={s} className={`${STATUS_TONE[s]} transition-all`} style={{ width: `${(n / Math.max(1, d.orgs.total)) * 100}%` }} title={`${s}: ${n}`} /> : null;
                })}
              </div>

              {/* 200px is honest for two short columns — a state name plus a count — and is under
                  the ~240px this card gets at its narrowest (1024), so it never actually scrolls. */}
              <ConsoleTable minWidth={200}>
                <TableHeader>
                  <TableRow>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {STATUS_ORDER.map((s) => (
                    <TableRow key={s}>
                      <TableCell className="py-2">
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${STATUS_TONE[s]}`} />
                          {s.charAt(0) + s.slice(1).toLowerCase()}
                        </span>
                      </TableCell>
                      <Num className="py-2 text-foreground">{d.orgs.byStatus[s] ?? 0}</Num>
                    </TableRow>
                  ))}
                </TableBody>
              </ConsoleTable>

              <div className="grid gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">By plan tier</p>
                <div className="flex flex-wrap items-center gap-2">
                  {Object.entries(d.orgs.byTier).map(([tier, n]) => (
                    <span key={tier} className="inline-flex items-center gap-1.5">
                      <TierPill tier={tier} />
                      <span className="font-mono text-xs tabular-nums text-foreground">{n}</span>
                    </span>
                  ))}
                </div>
              </div>
            </ConsoleSection>

            <ConsoleSection
              title="Signups, last 12 weeks"
              description="New workspaces per week — self-serve trials and provisioned customers together."
              className="flex h-full flex-col lg:col-span-3"
              bodyClassName="flex flex-1 flex-col"
            >
              {/* `h-full` takes whatever the stretched row gives it (at `lg` the taller left card
                  sets that); the min-heights are the floor when this card is full width on its own,
                  tiered so the plot stays near 2:1 on a phone and near 3:1 on a tablet rather than
                  flattening into a letterbox at one fixed height. Root font here is 14px, so these
                  read 154 / 224 / 210 CSS px. */}
              <div className="h-full min-h-[11rem] w-full min-w-0 sm:min-h-[16rem] lg:min-h-[15rem]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d.signupsByWeek} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="signupFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="week" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(w: string) => w.slice(5)} axisLine={false} tickLine={false} minTickGap={16} />
                    <RTooltip
                      cursor={{ stroke: "hsl(var(--border))" }}
                      contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, color: "hsl(var(--popover-foreground))" }}
                      labelFormatter={(w) => `Week of ${w}`}
                    />
                    <Area type="monotone" dataKey="signups" stroke="hsl(var(--accent))" strokeWidth={2} fill="url(#signupFill)" dot={false} activeDot={{ r: 4 }} isAnimationActive />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </ConsoleSection>
          </div>

          {/* Same 2:3 split as the row above, so the two left cards share one edge down the page. */}
          <div className="grid min-w-0 items-stretch gap-6 lg:grid-cols-5">
            <ConsoleSection
              title="Retention programme"
              description="What the daily pass will do next."
              className="h-full lg:col-span-2"
              bodyClassName="grid content-start gap-4"
              actions={
                <Button asChild size="sm" variant="outline">
                  <Link to="/platform-admin/retention">Open queue</Link>
                </Button>
              }
            >
              {/* Term left, value right, one grid: the values share a right edge whatever the terms
                  wrap to, which a row of `justify-between` flexes could never guarantee. */}
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2.5 text-sm">
                <dt className="text-muted-foreground">Programme</dt>
                <dd className={d.retention.enabled ? "text-right font-medium text-success" : "text-right font-medium text-destructive"}>{d.retention.enabled ? "On" : "Off"}</dd>

                <dt className="text-muted-foreground">Auto-delete after the window</dt>
                <dd className={d.retention.autoDeleteEnabled ? "text-right font-medium text-success" : "text-right font-medium text-warning"}>{d.retention.autoDeleteEnabled ? "On" : "Off"}</dd>

                <dt className="text-muted-foreground">Workspaces in the programme</dt>
                <dd className="text-right font-mono tabular-nums text-foreground">{d.retention.inProgramme}</dd>

                <dt className="text-muted-foreground">Within 14 days of deletion</dt>
                <dd className={`text-right font-mono tabular-nums ${d.retention.dueSoon > 0 ? "text-warning" : "text-foreground"}`}>{d.retention.dueSoon}</dd>

                <dt className="text-muted-foreground">On hold</dt>
                <dd className="text-right font-mono tabular-nums text-foreground">{d.retention.held}</dd>
              </dl>
              {!d.email.configured && (
                <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  <span>
                    No platform mail relay is configured — every retention email is recorded as skipped until one is.{" "}
                    <Link to="/platform-admin/settings" className="font-medium underline">
                      Configure mail
                    </Link>
                  </span>
                </p>
              )}
            </ConsoleSection>

            {/* Flush only when there are rows: the dividers then run the full width of the card, but
                an empty state needs the padding back or it presses against the border. */}
            <ConsoleSection
              title="Recent activity"
              description="The control-plane audit trail — actions taken on tenants from outside them."
              className="h-full lg:col-span-3"
              flush={d.recentActivity.length > 0}
            >
              {d.recentActivity.length === 0 ? (
                <EmptyState icon={Sparkles} title="Nothing yet" description="Provisioning, rescues, retention decisions and settings changes will appear here." />
              ) : (
                <ul className="divide-y divide-border">
                  {d.recentActivity.map((row) => (
                    <ActivityRow key={row.id} row={row} />
                  ))}
                </ul>
              )}
            </ConsoleSection>
          </div>
        </>
      )}
    </ConsolePage>
  );
}
