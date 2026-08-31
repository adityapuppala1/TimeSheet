/**
 * WHAT: org-wide Security & DevOps analytics — open findings by severity/type, a weighted
 * age-decayed risk score, findings-over-time trend, mean time to remediate, top repos by
 * open-finding count, and open findings per MODULE of the work breakdown. The "Security & DevOps"
 * settings tab configures ingestion and the routing rules behind that last one; this page is where
 * an admin reads the result of it.
 * WHY a separate page from Insights.tsx rather than one more tab there: security findings are a
 * distinct data domain from ticket/timesheet analytics (different source — CI/scanners, not
 * this app's own workflows) — same reasoning Insights.tsx itself gives for being separate from
 * Dashboard.
 * WHO calls the backing API: `controllers/report.controller.ts`'s `GET /reports/security-insights`.
 */
import { useQuery } from "@tanstack/react-query";
import type { SecurityFindingType } from "@timesheet/shared";
import { AlertTriangle, Boxes, Clock, FolderTree, ShieldAlert, ShieldCheck, ShieldQuestion, TrendingUp, Wrench } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { computeTrend } from "../lib/trend";
import { reportApi } from "../services/api";

const SEVERITY_BADGE: Record<string, "destructive" | "warning" | "info" | "muted"> = {
  CRITICAL: "destructive",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "muted"
};

const SEVERITY_BAR_COLOR: Record<string, string> = {
  CRITICAL: "hsl(var(--destructive))",
  HIGH: "hsl(var(--warning))",
  MEDIUM: "hsl(var(--info))",
  LOW: "hsl(var(--muted-foreground))"
};

/** Exhaustive on `SecurityFindingType`, not `Record<string, string>` as it was: a loose record let a
 *  new type reach this chart with no label, and the bar rendered under its raw enum name (or, where
 *  a label was interpolated rather than defaulted, under the word `undefined`). */
const TYPE_LABEL: Record<SecurityFindingType, string> = {
  SAST: "Static (SAST)",
  DAST: "Dynamic (DAST)",
  SSAT: "Secrets (SSAT)",
  SSCT: "Supply chain (SSCT)",
  VAPT: "Pentest (VAPT)",
  QUALITY: "Code quality",
  LINT: "Lint"
};

export function SecurityInsightsPage() {
  const insights = useQuery({
    queryKey: ["reports", "security-insights"],
    queryFn: reportApi.securityInsights,
    refetchInterval: 60_000
  });
  const sbom = useQuery({
    queryKey: ["reports", "sbom-inventory"],
    queryFn: reportApi.sbomInventory,
    refetchInterval: 60_000
  });

  const data = insights.data;
  const severityRows = data ? (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((severity) => ({ severity, count: data.openBySeverity[severity] })) : [];
  const maxSeverityCount = Math.max(1, ...severityRows.map((r) => r.count));

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Security &amp; DevOps insights</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Open findings, risk trend, and remediation speed across every connected scan source — SAST, DAST, secrets, and
          supply-chain. Code-quality and lint results are ingested too and reported in their own section further down; they never
          count towards the security figures. Configure ingestion from Workspace Settings → Security &amp; DevOps.
        </p>
      </div>

      {insights.isLoading && <Skeleton className="h-32 w-full" />}

      {!insights.isLoading && data && (
        <>
          {/* Five cards, so `xl` gets one row and everything below it wraps 4 + 1 rather than
              squeezing five tiles into a tablet's width. */}
          <div data-tour="security-overview" className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4 xl:grid-cols-5">
            <StatCard
              label="Open findings"
              value={data.totalOpen}
              icon={<ShieldAlert className="h-4 w-4" />}
              tone={data.totalOpen > 0 ? "warning" : "success"}
              trend={computeTrend(data.totalOpen, data.totalOpenYesterday, false)}
              trendLabel="vs yesterday"
            />
            <StatCard
              label="Risk score"
              value={data.riskScore}
              icon={<TrendingUp className="h-4 w-4" />}
              tone={data.riskScore > 30 ? "destructive" : data.riskScore > 10 ? "warning" : "success"}
              trend={computeTrend(data.riskScore, data.riskScoreYesterday, false)}
              trendLabel="vs yesterday"
            />
            <StatCard
              label="Critical + high open"
              value={data.openBySeverity.CRITICAL + data.openBySeverity.HIGH}
              icon={<AlertTriangle className="h-4 w-4" />}
              tone={data.openBySeverity.CRITICAL + data.openBySeverity.HIGH > 0 ? "destructive" : "success"}
            />
            <StatCard
              label="Mean time to remediate"
              value={`${data.meanTimeToRemediateHours.toFixed(1)}h`}
              icon={<Clock className="h-4 w-4" />}
              hint={
                data.verifiedFixedCount > 0
                  ? `${data.verifiedFixedCount} of these were confirmed gone by a scan; the rest are estimated from when the row last changed.`
                  : "Estimated from when each finding's row last changed. Turn on verified remediation to measure it instead."
              }
            />
            {/* The queue this whole feature creates: fixes somebody has claimed and no scan has
                confirmed. Deliberately not toned as a failure — a non-zero number here is the system
                working, and only becomes a problem if it stops falling. */}
            <StatCard
              label="Awaiting proof"
              value={data.awaitingVerificationCount}
              icon={<ShieldQuestion className="h-4 w-4" />}
              tone={data.awaitingVerificationCount > 0 ? "warning" : "success"}
              hint="Findings marked fixed that no scan by the tool which found them has confirmed yet. They keep counting as open until one does."
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldAlert className="h-4 w-4 text-primary" />
                  Open findings by severity
                </CardTitle>
                {/* Kept literally accurate because people reconcile this panel against their
                    scanner's own numbers. A finding awaiting verification is counted here on
                    purpose: the fix is claimed, not proven. Only confirmed fixes and consciously
                    accepted risks drop out. */}
                <CardDescription>Currently OPEN, ACKNOWLEDGED or awaiting verification — fixed and accepted-risk findings excluded.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                {severityRows.every((r) => r.count === 0) ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                    <ShieldCheck className="h-4 w-4 text-success" />
                    No open findings — clean slate.
                  </div>
                ) : (
                  severityRows.map((row) => (
                    <div key={row.severity} className="grid gap-1">
                      <div className="flex items-center justify-between text-sm">
                        <Badge variant={SEVERITY_BADGE[row.severity]}>{row.severity}</Badge>
                        <span className="font-semibold">{row.count}</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(row.count / maxSeverityCount) * 100}%`,
                            backgroundColor: SEVERITY_BAR_COLOR[row.severity]
                          }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldAlert className="h-4 w-4 text-primary" />
                  Open findings by type
                </CardTitle>
                <CardDescription>
                  SAST, DAST, secrets (SSAT), supply-chain (SSCT), and pentest (VAPT). Code-quality and lint findings are
                  reported separately below — they are not security exposure and are never counted here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.byType.map((row) => ({ name: TYPE_LABEL[row.type] ?? row.type, count: row.count }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} interval={0} angle={-15} textAnchor="end" height={50} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} />
                      <RTooltip
                        contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }}
                      />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]}>
                        <LabelList
                          dataKey="count"
                          position="top"
                          fill="hsl(var(--muted-foreground))"
                          fontSize={11}
                          formatter={(value: number) => (value > 0 ? value : "")}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="h-4 w-4 text-primary" />
                Findings over time
              </CardTitle>
              <CardDescription>New security findings ingested per week, last 8 weeks.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.findingsOverTime} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="findingsGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--destructive))" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="hsl(var(--destructive))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="weekStart" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} />
                    <RTooltip
                      contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }}
                    />
                    <Area type="monotone" dataKey="count" stroke="hsl(var(--destructive))" fill="url(#findingsGrad)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top repositories by open findings</CardTitle>
              <CardDescription>Where open risk is concentrated right now.</CardDescription>
            </CardHeader>
            <CardContent>
              {data.topRepositories.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">No repository-attributed findings yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Repository</TableHead>
                        <TableHead className="text-right">Open findings</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.topRepositories.map((row) => (
                        <TableRow key={row.repository}>
                          <TableCell className="font-mono text-xs">{row.repository}</TableCell>
                          <TableCell className="text-right font-semibold">{row.count}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Modeled on "Top repositories" above — same table, one level further in. A repository is
              what a scanner can tell you; a module is what your teams are organised around, and no
              scanner owns that mapping because no scanner owns the work breakdown. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FolderTree className="h-4 w-4 text-primary" />
                Open findings by module
              </CardTitle>
              <CardDescription>
                Which part of the product carries the risk. Your scanners report a repository and a file; TimeSphere is the system
                that also knows which module owns that file, so this is a breakdown a scan report cannot give you. It is only as
                complete as your routing rules — Workspace Settings → Security &amp; DevOps.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {data.openByModule.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No findings are routed to a module yet. Add repository and path rules in Workspace Settings → Security &amp; DevOps,
                  and findings pick up a module as scans re-report them.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Module</TableHead>
                        <TableHead>Project</TableHead>
                        <TableHead className="text-right">Open findings</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.openByModule.map((row) => (
                        <TableRow key={row.moduleId ?? row.moduleName}>
                          <TableCell className="font-medium">{row.moduleName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{row.projectName}</TableCell>
                          <TableCell className="text-right font-semibold">{row.count}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {/* Stated rather than left to be inferred: a table of five modules means something
                  very different when four hundred findings are routed nowhere. */}
              {data.openWithoutModuleCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {data.openWithoutModuleCount} open finding{data.openWithoutModuleCount === 1 ? "" : "s"} not routed to any module —
                  no path rule claims their file, or they arrived without one.
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── THE OTHER DISCIPLINE, and the reason it is a separate card rather than more bars on
              the charts above ──────────────────────────────────────────────────────────────────
              SonarQube and ESLint post into the same findings table as the security scanners, and a
              busy repository produces code smells by the thousand. Mixed into the panels above they
              would dominate every one of them and a workspace's "security posture" would quietly
              become a measure of how much linting it does. So: same data source, same remediation
              machinery, deliberately different section — and no risk score of its own, because a
              maintainability backlog is a cost, not an exposure. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wrench className="h-4 w-4 text-primary" />
                Code quality
              </CardTitle>
              <CardDescription>
                Bugs, code smells and lint results from SonarQube, ESLint and similar. Tracked, routed, deduplicated and verified
                exactly like a security finding — and deliberately excluded from every number above, including the risk score.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {data.quality.totalOpen === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No open code-quality findings. Point SonarQube's quality-gate webhook or your <code>eslint --format json</code>{" "}
                  output at the ingestion URLs in Workspace Settings → Security &amp; DevOps.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
                    <StatCard label="Open quality findings" value={data.quality.totalOpen} icon={<Wrench className="h-4 w-4" />} />
                    {data.quality.byType.map((row) => (
                      <StatCard key={row.type} label={TYPE_LABEL[row.type] ?? row.type} value={row.count} icon={<Wrench className="h-4 w-4" />} />
                    ))}
                  </div>
                  <div className="grid gap-2">
                    {/* Severity is shown, but as a plain row rather than the coloured bars the
                        security panel uses: a CRITICAL code smell and a CRITICAL SQL injection are
                        not the same news, and giving them the same red would say they were. */}
                    {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((severity) => (
                      <div key={severity} className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{severity}</span>
                        <span className="font-semibold">{data.quality.openBySeverity[severity]}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Boxes className="h-4 w-4 text-primary" />
                Software supply chain (SBOM)
              </CardTitle>
              <CardDescription>
                Dependency inventory from ingested SPDX/CycloneDX documents — Workspace Settings → Security &amp; DevOps → SBOM
                webhook. Not a live vulnerability scanner: only components a scan tool itself flagged show a known CVE here.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {sbom.isLoading && <Skeleton className="h-20 w-full" />}
              {!sbom.isLoading && sbom.data && sbom.data.totalComponents === 0 && (
                <p className="text-sm text-muted-foreground">No SBOM has been ingested yet.</p>
              )}
              {!sbom.isLoading && sbom.data && sbom.data.totalComponents > 0 && (
                <>
                  <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-2">
                    <StatCard label="Tracked components" value={sbom.data.totalComponents} icon={<Boxes className="h-4 w-4" />} />
                    <StatCard
                      label="Known-vulnerable"
                      value={sbom.data.vulnerableCount}
                      icon={<AlertTriangle className="h-4 w-4" />}
                      tone={sbom.data.vulnerableCount > 0 ? "destructive" : "success"}
                    />
                  </div>
                  {sbom.data.vulnerableComponents.length > 0 && (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Component</TableHead>
                            <TableHead>Ecosystem</TableHead>
                            <TableHead>License</TableHead>
                            <TableHead>Known CVE</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {sbom.data.vulnerableComponents.slice(0, 20).map((c) => (
                            <TableRow key={c.id}>
                              <TableCell className="font-mono text-xs">{c.name}@{c.version}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{c.ecosystem ?? "—"}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{c.license ?? "—"}</TableCell>
                              <TableCell><Badge variant="destructive">{c.knownCve}</Badge></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
