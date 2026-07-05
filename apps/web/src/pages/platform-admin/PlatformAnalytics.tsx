import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Building2, DollarSign, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { platformAdminAnalyticsApi } from "../../services/platform-admin-api";

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** The only screen in the console that surfaces cross-tenant NUMBERS (seat counts, ticket
 *  counts by status, AI spend) — never row-level content. Backed by the single
 *  cross-tenant-loop service (platform-admin-analytics.service.ts) by design. */
export function PlatformAdminAnalytics() {
  const analytics = useQuery({ queryKey: ["platform-admin", "analytics"], queryFn: platformAdminAnalyticsApi.get });

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-slate-400">Aggregate metrics across every organization — seat counts, ticket volume, and AI spend only. No ticket, comment, or timesheet content ever surfaces here.</p>
      </div>

      {analytics.isLoading && <Skeleton className="h-64 w-full bg-slate-800" />}

      {!analytics.isLoading && analytics.data && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard icon={Building2} label="Organizations" value={analytics.data.totals.orgCount.toString()} />
            <StatCard icon={Users} label="Total seats" value={analytics.data.totals.seatCount.toLocaleString()} />
            <StatCard icon={DollarSign} label="AI spend this month" value={currency.format(analytics.data.totals.aiSpendThisMonthUsd)} />
          </div>

          <Card className="border-slate-800 bg-slate-900/60">
            <CardHeader>
              <CardTitle className="text-base text-slate-100">Per-organization breakdown</CardTitle>
              <CardDescription className="text-slate-400">This month, aggregated per org.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-800 hover:bg-transparent">
                    <TableHead className="text-slate-400">Organization</TableHead>
                    <TableHead className="text-slate-400">Seats</TableHead>
                    <TableHead className="text-slate-400">Open tickets</TableHead>
                    <TableHead className="text-slate-400">Total tickets</TableHead>
                    <TableHead className="text-slate-400">AI spend</TableHead>
                    <TableHead className="text-slate-400">Last activity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analytics.data.orgs.map((org) => {
                    const totalTickets = Object.values(org.ticketCountsByStatus).reduce((a, b) => a + b, 0);
                    const openTickets = (org.ticketCountsByStatus.OPEN ?? 0) + (org.ticketCountsByStatus.IN_PROGRESS ?? 0);
                    return (
                      <TableRow key={org.orgId} className="border-slate-800 hover:bg-slate-800/40">
                        <TableCell className="font-medium text-slate-100">
                          {org.name}
                          {!org.reachable && (
                            <span className="ml-2 inline-flex items-center gap-1 text-xs text-amber-400">
                              <AlertTriangle className="h-3 w-3" />unreachable
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-slate-300">{org.seatCount}</TableCell>
                        <TableCell className="text-slate-300">{openTickets}</TableCell>
                        <TableCell className="text-slate-300">{totalTickets}</TableCell>
                        <TableCell className="text-slate-300">{currency.format(org.aiSpendThisMonthUsd)}</TableCell>
                        <TableCell className="text-xs text-slate-500">{org.lastActivityAt ? new Date(org.lastActivityAt).toLocaleDateString() : "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                  {analytics.data.orgs.length === 0 && (
                    <TableRow className="border-slate-800">
                      <TableCell colSpan={6} className="text-center text-slate-500">No organizations yet.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: typeof Building2; label: string; value: string }) {
  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardContent className="flex items-center gap-4 pt-6">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-400">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
          <p className="text-xl font-bold text-slate-100">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
