/**
 * WHAT: org-wide Security & DevOps analytics — open findings by severity/type, a weighted
 * age-decayed risk score, findings-over-time trend, mean time to remediate, and top repos by
 * open-finding count. The "Security & DevOps" settings tab configures ingestion; this page is
 * where an admin reads the result of it.
 * WHY a separate page from Insights.tsx rather than one more tab there: security findings are a
 * distinct data domain from ticket/timesheet analytics (different source — CI/scanners, not
 * this app's own workflows) — same reasoning Insights.tsx itself gives for being separate from
 * Dashboard.
 * WHO calls the backing API: `controllers/report.controller.ts`'s `GET /reports/security-insights`.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Boxes, Clock, ShieldAlert, ShieldCheck, TrendingUp } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
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

const TYPE_LABEL: Record<string, string> = {
  SAST: "Static (SAST)",
  DAST: "Dynamic (DAST)",
  SSAT: "Secrets (SSAT)",
  SSCT: "Supply chain (SSCT)",
  VAPT: "Pentest (VAPT)"
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
          supply-chain. Configure ingestion from Workspace Settings → Security &amp; DevOps.
        </p>
      </div>

      {insights.isLoading && <Skeleton className="h-32 w-full" />}

      {!insights.isLoading && data && (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
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
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldAlert className="h-4 w-4 text-primary" />
                  Open findings by severity
                </CardTitle>
                <CardDescription>Currently OPEN or ACKNOWLEDGED — resolved/accepted-risk findings excluded.</CardDescription>
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
                <CardDescription>SAST, DAST, secrets (SSAT), supply-chain (SSCT), and pentest (VAPT).</CardDescription>
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
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
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
              <CardDescription>New findings ingested per week, last 8 weeks.</CardDescription>
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
