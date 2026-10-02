/**
 * WHAT: the console's Signups page (signup Phase 1) — is self-serve working, who came in through it,
 * and are they staying. Every number comes from signup-analytics.service.ts; the reasoning for each
 * (what "converted" means, why seats can be unknown) is written there, once.
 *
 * READ IN THIS ORDER: the funnel (where people drop), the chart (self-serve against console-made, so
 * a dip in one is not mistaken for a dip in demand), who signed up and how each is doing, what failed
 * — those are people to write to today — and which domains are trying hardest.
 *
 * The daily summary's Preview and Send now live here too, because this is the page the summary
 * describes. Preview claims nothing; Send now claims the day, so the 08:15 run then stands down.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, BadgeCheck, Building2, MailCheck, Send, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { platformAdminConsoleApi } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, KpiCard, KpiGrid, Num, OrgStatusPill, SegmentedControl, TierPill, shortDate, shortDateTime } from "./console-ui";

type Period = "7" | "30" | "90";
const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

function DigestActions() {
  const preview = useMutation({
    mutationFn: () => platformAdminConsoleApi.runSignupDigest(true),
    onSuccess: (r) =>
      toast.info(`${r.counts.created} new, ${r.counts.failed} failed, ${r.counts.joinRequested} join requests in the last 24 hours`, { description: r.reason }),
    onError: (error) => toast.error("Could not preview", { description: errorMessageOf(error) })
  });
  const send = useMutation({
    mutationFn: () => platformAdminConsoleApi.runSignupDigest(false),
    onSuccess: (r) => (r.sent ? toast.success("Daily summary sent", { description: r.reason }) : toast.info("Nothing was sent", { description: r.reason })),
    onError: (error) => toast.error("Could not send", { description: errorMessageOf(error) })
  });
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => preview.mutate()} disabled={preview.isPending}>
        <MailCheck className="h-3.5 w-3.5" />
        Preview summary
      </Button>
      <Button size="sm" variant="outline" onClick={() => send.mutate()} disabled={send.isPending}>
        <Send className="h-3.5 w-3.5" />
        Send now
      </Button>
    </>
  );
}

export function PlatformAdminSignups() {
  const [period, setPeriod] = useState<Period>("30");
  const days = Number(period) as 7 | 30 | 90;
  const signups = useQuery({ queryKey: ["platform-admin", "signups", days], queryFn: () => platformAdminConsoleApi.signups(days), placeholderData: (previous) => previous });
  const d = signups.data;

  return (
    <ConsolePage
      eyebrow="Growth"
      title="Signups"
      description="Self-serve signup end to end: where people drop (counted as people whose first code went out in the period), who got a workspace, how each is doing, and what failed."
      actions={
        <>
          <SegmentedControl<Period>
            ariaLabel="Period"
            options={[
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" }
            ]}
            value={period}
            onChange={setPeriod}
          />
          <DigestActions />
        </>
      }
    >
      {signups.isLoading && <Skeleton className="h-96 w-full" />}
      {d && (
        <>
          <KpiGrid>
            {/* PEOPLE, not rows: everyone whose FIRST code went out in the period, and how far each got.
                A resend is not a second person, and no step can exceed the one before it. */}
            <KpiCard
              label="Verified their address"
              value={d.funnel.verified}
              icon={MailCheck}
              hint={d.funnel.codeSent ? `of ${d.funnel.codeSent} ${d.funnel.codeSent === 1 ? "person" : "people"} sent a first code (${pct(d.funnel.verified, d.funnel.codeSent)})` : "nobody was sent a code"}
            />
            <KpiCard
              label="New workspaces"
              value={d.funnel.created}
              icon={Building2}
              tone="accent"
              hint={d.funnel.verified ? `${pct(d.funnel.created, d.funnel.verified)} of the verified · ${d.funnel.existingMembers} already had one` : "nobody verified yet"}
              delay={0.05}
            />
            <KpiCard label="Asked to join" value={d.funnel.joinRequested} icon={UserPlus} hint="their company already had a workspace" delay={0.1} />
            {/* Counted on the server over every self-serve workspace in the period — the list below
                stops at a hundred, and a figure counted from it stopped there too. */}
            <KpiCard
              label="Converted to paid"
              value={d.selfServe.converted}
              icon={BadgeCheck}
              tone="success"
              hint={d.selfServe.total ? `of ${d.selfServe.total} self-serve workspaces (${pct(d.selfServe.converted, d.selfServe.total)})` : "no self-serve workspaces yet"}
              delay={0.15}
            />
            <KpiCard
              label="Failed"
              value={d.funnel.failed}
              icon={AlertTriangle}
              tone={d.funnel.failed > 0 ? "destructive" : "default"}
              hint={`${d.funnel.refused} refused (personal or blocked) · ${d.funnel.unavailable} company workspace unavailable`}
              delay={0.2}
            />
          </KpiGrid>

          <ConsoleSection title="New workspaces per day" description="Self-serve against those made in the console — so a quiet week for one is not mistaken for a quiet week for both.">
            <div className="h-56 w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={d.byDay} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(day: string) => day.slice(5)} axisLine={false} tickLine={false} minTickGap={16} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <RTooltip
                    contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, color: "hsl(var(--popover-foreground))" }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="selfServe" name="Self-serve" stackId="1" stroke="hsl(var(--accent))" fill="hsl(var(--accent))" fillOpacity={0.25} strokeWidth={2} />
                  <Area type="monotone" dataKey="console" name="Console" stackId="1" stroke="hsl(var(--muted-foreground))" fill="hsl(var(--muted-foreground))" fillOpacity={0.15} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </ConsoleSection>

          <ConsoleSection title="Who signed up" description="Self-serve workspaces created in the period, newest first. Seats are from the nightly usage snapshot — blank until the first one." flush>
            {d.recent.length === 0 ? (
              <div className="p-5">
                <EmptyState icon={Users} title="No self-serve workspaces in this period" description="When someone signs up, their workspace appears here with its trial and how it is doing." />
              </div>
            ) : (
              <ConsoleTable minWidth={860} className="rounded-none border-x-0 border-b-0">
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Trial left</TableHead>
                    <TableHead className="text-right">Seats</TableHead>
                    <TableHead>Signed up</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.recent.map((r) => (
                    <TableRow key={r.orgId}>
                      <TableCell>
                        <Link to={`/platform-admin/organizations/${r.orgId}`} className="focus-ring rounded font-medium text-foreground hover:underline">
                          {r.name}
                        </Link>
                        <div className="font-mono text-[11px] text-muted-foreground">{r.slug}</div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.domain ?? "—"}</TableCell>
                      <TableCell>
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <OrgStatusPill status={r.status} />
                          {r.converted && <Badge variant="success">converted</Badge>}
                        </span>
                      </TableCell>
                      <TableCell>
                        <TierPill tier={r.trialDaysLeft !== null ? "TEAM trial" : r.planTier} />
                      </TableCell>
                      <Num className={r.trialDaysLeft !== null && r.trialDaysLeft <= 3 ? "text-warning-ink" : undefined}>{r.trialDaysLeft === null ? "—" : `${r.trialDaysLeft}d`}</Num>
                      <Num>{r.activeSeats ?? "—"}</Num>
                      <TableCell className="whitespace-nowrap text-sm">{shortDate(r.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </ConsoleTable>
            )}
          </ConsoleSection>

          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
            <ConsoleSection
              title="Failed signups"
              description="Each is someone who proved their address, filled in the form, and was told it did not work. Worth a personal email today."
              flush
            >
              {d.failures.length === 0 ? (
                <div className="p-5">
                  <EmptyState icon={BadgeCheck} title="No failures in this period" />
                </div>
              ) : (
                <ConsoleTable minWidth={420} className="rounded-none border-x-0 border-b-0">
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Domain</TableHead>
                      <TableHead className="w-full">Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.failures.map((f) => (
                      <TableRow key={`${f.at}-${f.domain}`}>
                        <TableCell className="whitespace-nowrap text-sm">{shortDateTime(f.at)}</TableCell>
                        <TableCell className="text-sm">{f.domain ?? "—"}</TableCell>
                        <TableCell className="break-words font-mono text-xs text-muted-foreground">{f.detail ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </ConsoleTable>
              )}
            </ConsoleSection>

            <ConsoleSection title="Domains trying hardest" description="Every funnel step per company domain (refused personal addresses left out) — many steps and no workspace is worth a look. Joins are requests to join an existing workspace." flush>
              {d.topDomains.length === 0 ? (
                <div className="p-5">
                  <EmptyState icon={Building2} title="No signup attempts in this period" />
                </div>
              ) : (
                <ConsoleTable minWidth={420} className="rounded-none border-x-0 border-b-0">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-full">Domain</TableHead>
                      <TableHead className="text-right">Steps</TableHead>
                      <TableHead className="text-right">Created</TableHead>
                      <TableHead className="whitespace-nowrap text-right">Joins</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.topDomains.map((row) => (
                      <TableRow key={row.domain}>
                        <TableCell className="break-all text-sm">{row.domain}</TableCell>
                        <Num>{row.attempts}</Num>
                        <Num>{row.created}</Num>
                        <Num>{row.joinRequested}</Num>
                      </TableRow>
                    ))}
                  </TableBody>
                </ConsoleTable>
              )}
            </ConsoleSection>
          </div>
        </>
      )}
    </ConsolePage>
  );
}
