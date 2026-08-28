/**
 * The console's landing page: what an operator needs to know in the first ten seconds of the day.
 * Tenants by state, trials in flight, what the retention programme is about to do, whether platform
 * mail is healthy, what customers are saying, and what changed recently — every number a link to
 * the page that explains it. Counts only; never row-level tenant content.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Building2, HeartHandshake, MailCheck, MailX, MessageSquareHeart, Sparkles, Star, Trash2, UserPlus } from "lucide-react";
import { Link } from "react-router";
import { Area, AreaChart, ResponsiveContainer, Tooltip as RTooltip, XAxis } from "recharts";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { platformAdminConsoleApi, type PlatformAuditRow } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, EmptyState, KpiCard, shortDateTime } from "./console-ui";

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

function ActivityRow({ row }: { row: PlatformAuditRow }) {
  const label = ACTION_LABEL[row.action] ?? row.action;
  const who = row.actorType === "SYSTEM" ? "scheduler" : row.actorType === "CUSTOMER" ? `customer · ${row.actorLabel ?? ""}` : row.actorLabel ?? "platform admin";
  const slug = (row.metadata as { slug?: string } | null)?.slug;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          {label}
          {slug && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{slug}</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          {who} · {shortDateTime(row.createdAt)}
        </p>
      </div>
    </li>
  );
}

export function PlatformAdminOverview() {
  const overview = useQuery({ queryKey: ["platform-admin", "overview"], queryFn: platformAdminConsoleApi.overview, refetchInterval: 60_000 });
  const d = overview.data;

  return (
    <ConsolePage eyebrow="Control plane" title="Overview" description="Every tenant on the platform at a glance — lifecycle, trials, the retention programme, platform mail health and what customers are telling you.">
      {overview.isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {d && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Organizations" value={d.orgs.total} icon={Building2} tone="accent" hint={`${d.orgs.byStatus.ACTIVE ?? 0} active · ${d.orgs.byStatus.GRACE ?? 0} in grace`} />
            <KpiCard label="Signups, 30 days" value={d.orgs.signups30} icon={UserPlus} tone="success" hint={`${d.orgs.trialsActive} trial${d.orgs.trialsActive === 1 ? "" : "s"} running now`} delay={0.05} />
            <KpiCard label="In retention" value={d.retention.inProgramme} icon={HeartHandshake} tone={d.retention.dueSoon > 0 ? "warning" : "default"} hint={d.retention.dueSoon > 0 ? `${d.retention.dueSoon} within 14 days of deletion` : d.retention.enabled ? "Programme on" : "Programme off"} delay={0.1} />
            <KpiCard label="Deleted under policy" value={d.orgs.deletedUnderPolicy} icon={Trash2} hint={d.retention.autoDeleteEnabled ? "Auto-delete on" : "Auto-delete OFF"} delay={0.15} />
            <KpiCard label="Emails sent, 30 days" value={d.email.sent30} icon={MailCheck} tone="success" hint={d.email.configured ? `Relay from ${d.email.source === "database" ? "console settings" : ".env"}` : "No relay configured"} delay={0.2} />
            <KpiCard label="Emails failed, 30 days" value={d.email.failed30 + d.email.skipped30} icon={MailX} tone={d.email.failed30 + d.email.skipped30 > 0 ? "destructive" : "default"} hint={d.email.skipped30 > 0 ? `${d.email.skipped30} skipped (no relay)` : undefined} delay={0.25} />
            <KpiCard label="Feedback responses" value={d.feedback.count} icon={MessageSquareHeart} delay={0.3} />
            <KpiCard label="Average rating" value={d.feedback.avgRating ?? 0} icon={Star} tone="accent" format={(n) => (d.feedback.avgRating === null ? "—" : `${n.toFixed(1)} / 5`)} delay={0.35} />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <ConsoleSection title="Tenants by state" description="Where every organization sits in its lifecycle." className="lg:col-span-1">
              <div className="grid gap-3">
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
                  {STATUS_ORDER.map((s) => {
                    const n = d.orgs.byStatus[s] ?? 0;
                    return n > 0 ? <span key={s} className={`${STATUS_TONE[s]} transition-all`} style={{ width: `${(n / Math.max(1, d.orgs.total)) * 100}%` }} title={`${s}: ${n}`} /> : null;
                  })}
                </div>
                <ul className="grid gap-1.5 text-sm">
                  {STATUS_ORDER.map((s) => (
                    <li key={s} className="flex items-center justify-between">
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <span className={`h-2.5 w-2.5 rounded-sm ${STATUS_TONE[s]}`} />
                        {s.charAt(0) + s.slice(1).toLowerCase()}
                      </span>
                      <span className="font-mono tabular-nums text-foreground">{d.orgs.byStatus[s] ?? 0}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 flex flex-wrap gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
                  {Object.entries(d.orgs.byTier).map(([tier, n]) => (
                    <span key={tier} className="rounded-md bg-muted px-2 py-0.5 font-mono">
                      {tier} <span className="text-foreground">{n}</span>
                    </span>
                  ))}
                </div>
                <Button asChild variant="outline" size="sm" className="mt-1 w-fit">
                  <Link to="/platform-admin/organizations">Open organizations</Link>
                </Button>
              </div>
            </ConsoleSection>

            <ConsoleSection title="Signups, last 12 weeks" description="New workspaces per week — self-serve trials and provisioned customers together." className="lg:col-span-2">
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d.signupsByWeek} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="signupFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="week" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(w: string) => w.slice(5)} axisLine={false} tickLine={false} />
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

          <div className="grid gap-6 lg:grid-cols-3">
            <ConsoleSection
              title="Retention programme"
              description="What the daily pass will do next."
              actions={
                <Button asChild size="sm" variant="outline">
                  <Link to="/platform-admin/retention">Open queue</Link>
                </Button>
              }
            >
              <ul className="grid gap-2 text-sm">
                <li className="flex items-center justify-between">
                  <span className="text-muted-foreground">Programme</span>
                  <span className={d.retention.enabled ? "font-medium text-success" : "font-medium text-destructive"}>{d.retention.enabled ? "On" : "Off"}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-muted-foreground">Auto-delete after the window</span>
                  <span className={d.retention.autoDeleteEnabled ? "font-medium text-success" : "font-medium text-warning"}>{d.retention.autoDeleteEnabled ? "On" : "Off"}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-muted-foreground">Workspaces in the programme</span>
                  <span className="font-mono tabular-nums">{d.retention.inProgramme}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-muted-foreground">Within 14 days of deletion</span>
                  <span className={`font-mono tabular-nums ${d.retention.dueSoon > 0 ? "text-warning" : ""}`}>{d.retention.dueSoon}</span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="text-muted-foreground">On hold</span>
                  <span className="font-mono tabular-nums">{d.retention.held}</span>
                </li>
              </ul>
              {!d.email.configured && (
                <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  No platform mail relay is configured — every retention email is recorded as skipped until one is.{" "}
                  <Link to="/platform-admin/settings" className="font-medium underline">
                    Configure mail
                  </Link>
                </p>
              )}
            </ConsoleSection>

            <ConsoleSection title="Recent activity" description="The control-plane audit trail — actions taken on tenants from outside them." className="lg:col-span-2">
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
