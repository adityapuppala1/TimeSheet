import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, Building2, DollarSign, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { DataTable } from "../../components/ui/data-table";
import { Skeleton } from "../../components/ui/skeleton";
import { platformAdminAnalyticsApi, type OrgAnalyticsSummary } from "../../services/platform-admin-api";

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// Same dark slate/amber chrome override as Organizations.tsx — see that file's comment.
const DARK_TABLE_CLASSNAME = "[&_thead_tr]:border-slate-800 [&_th]:text-slate-400 [&>div]:border-slate-800";
const DARK_ROW_CLASSNAME = "border-slate-800 hover:bg-slate-800/40";

/**
 * An ALIAS, not a second copy.
 *
 * This was a hand-maintained interface mirroring `OrgAnalyticsSummary` in the API client — which
 * is a shape that drifts silently: the service can add a field, the client type can gain it, and
 * this page still cannot see it. Aliasing means a new metric reaches the table's `accessorFn`
 * the moment the service returns it.
 */
type OrgAnalyticsRow = OrgAnalyticsSummary;

const columns: ColumnDef<OrgAnalyticsRow, any>[] = [
  {
    accessorKey: "name",
    header: "Organization",
    cell: ({ row }) => (
      <span className="font-medium text-slate-100">
        {row.original.name}
        {!row.original.reachable && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs text-amber-400">
            <AlertTriangle className="h-3 w-3" />unreachable
          </span>
        )}
      </span>
    )
  },
  { accessorKey: "seatCount", header: "Seats", cell: (info) => <span className="text-slate-300">{info.getValue()}</span> },
  {
    id: "openTickets",
    accessorFn: (row) => (row.ticketCountsByStatus.OPEN ?? 0) + (row.ticketCountsByStatus.IN_PROGRESS ?? 0),
    header: "Open tickets",
    cell: (info) => <span className="text-slate-300">{info.getValue()}</span>
  },
  {
    id: "totalTickets",
    accessorFn: (row) => Object.values(row.ticketCountsByStatus).reduce((a, b) => a + b, 0),
    header: "Total tickets",
    cell: (info) => <span className="text-slate-300">{info.getValue()}</span>
  },
  {
    accessorKey: "aiSpendThisMonthUsd",
    header: "AI spend",
    cell: (info) => <span className="text-slate-300">{currency.format(info.getValue() as number)}</span>
  },
  {
    id: "mail",
    accessorFn: (row) => row.emailsSentThisMonth,
    header: "Mail (sent / failed)",
    cell: ({ row }) => (
      <span className="text-slate-300 tabular-nums">
        {row.original.emailsSentThisMonth}
        {" / "}
        {/* Only a NON-ZERO failure count is coloured. A red 0 trains an operator to ignore the
            column, which is the opposite of what a health signal is for. */}
        <span className={row.original.emailsFailedThisMonth > 0 ? "text-amber-400" : "text-slate-500"}>
          {row.original.emailsFailedThisMonth}
        </span>
      </span>
    )
  },
  {
    accessorKey: "practiceUpdatesSentThisMonth",
    header: "Practice updates",
    cell: (info) => {
      const count = info.getValue() as number;
      // An em dash, not a 0: zero sends and "the tier does not include it" look identical in a
      // number, and this column exists to make "entitled but unused" visible.
      return <span className="text-slate-300 tabular-nums">{count > 0 ? count : <span className="text-slate-600">—</span>}</span>;
    }
  },
  {
    accessorKey: "lastActivityAt",
    header: "Last activity",
    cell: (info) => {
      const value = info.getValue() as string | null;
      return <span className="text-xs text-slate-500">{value ? new Date(value).toLocaleDateString() : "—"}</span>;
    }
  }
];

/** The only screen in the console that surfaces cross-tenant NUMBERS (seat counts, ticket
 *  counts by status, AI spend, outbound mail health, practice-update adoption) — never row-level
 *  content. Backed by the single
 *  cross-tenant-loop service (platform-admin-analytics.service.ts) by design. */
export function PlatformAdminAnalytics() {
  const analytics = useQuery({ queryKey: ["platform-admin", "analytics"], queryFn: platformAdminAnalyticsApi.get });

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-slate-400">Aggregate metrics across every organization — seat counts, ticket volume, AI spend, outbound mail health and practice-update adoption. Counts only: no ticket, comment, timesheet or email content ever surfaces here.</p>
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
              <DataTable
                columns={columns}
                data={analytics.data.orgs}
                className={DARK_TABLE_CLASSNAME}
                rowClassName={DARK_ROW_CLASSNAME}
                searchPlaceholder="Search organizations..."
                emptyMessage="No organizations yet."
                pageSize={20}
              />
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
