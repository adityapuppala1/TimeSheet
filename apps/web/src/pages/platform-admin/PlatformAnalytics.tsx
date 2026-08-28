import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, Building2, DollarSign, Users } from "lucide-react";
import { DataTable } from "../../components/ui/data-table";
import { Skeleton } from "../../components/ui/skeleton";
import { platformAdminAnalyticsApi, type OrgAnalyticsSummary } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, KpiCard } from "./console-ui";

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

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
      <span className="font-medium text-foreground">
        {row.original.name}
        {!row.original.reachable && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs text-warning">
            <AlertTriangle className="h-3 w-3" />unreachable
          </span>
        )}
      </span>
    )
  },
  { accessorKey: "seatCount", header: "Seats", cell: (info) => <span className="text-foreground">{info.getValue()}</span> },
  {
    id: "openTickets",
    accessorFn: (row) => (row.ticketCountsByStatus.OPEN ?? 0) + (row.ticketCountsByStatus.IN_PROGRESS ?? 0),
    header: "Open tickets",
    cell: (info) => <span className="text-foreground">{info.getValue()}</span>
  },
  {
    id: "totalTickets",
    accessorFn: (row) => Object.values(row.ticketCountsByStatus).reduce((a, b) => a + b, 0),
    header: "Total tickets",
    cell: (info) => <span className="text-foreground">{info.getValue()}</span>
  },
  {
    accessorKey: "aiSpendThisMonthUsd",
    header: "AI spend",
    cell: (info) => <span className="text-foreground">{currency.format(info.getValue() as number)}</span>
  },
  {
    id: "mail",
    accessorFn: (row) => row.emailsSentThisMonth,
    header: "Mail (sent / failed)",
    cell: ({ row }) => (
      <span className="text-foreground tabular-nums">
        {row.original.emailsSentThisMonth}
        {" / "}
        {/* Only a NON-ZERO failure count is coloured. A red 0 trains an operator to ignore the
            column, which is the opposite of what a health signal is for. */}
        <span className={row.original.emailsFailedThisMonth > 0 ? "text-warning" : "text-muted-foreground"}>
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
      return <span className="text-foreground tabular-nums">{count > 0 ? count : <span className="text-muted-foreground/60">—</span>}</span>;
    }
  },
  {
    accessorKey: "lastActivityAt",
    header: "Last activity",
    cell: (info) => {
      const value = info.getValue() as string | null;
      return <span className="text-xs text-muted-foreground">{value ? new Date(value).toLocaleDateString() : "—"}</span>;
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
    <ConsolePage
      eyebrow="Tenants"
      title="Analytics"
      description="Aggregate metrics across every organization — seat counts, ticket volume, AI spend, outbound mail health and practice-update adoption. Counts only: no ticket, comment, timesheet or email content ever surfaces here."
    >
      {analytics.isLoading && <Skeleton className="h-64 w-full" />}

      {!analytics.isLoading && analytics.data && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <KpiCard icon={Building2} label="Organizations" value={analytics.data.totals.orgCount} tone="accent" />
            <KpiCard icon={Users} label="Total seats" value={analytics.data.totals.seatCount} delay={0.05} />
            <KpiCard icon={DollarSign} label="AI spend this month" value={analytics.data.totals.aiSpendThisMonthUsd} format={(n) => currency.format(n)} delay={0.1} />
          </div>

          <ConsoleSection title="Per-organization breakdown" description="This month, aggregated per org.">
            <DataTable columns={columns} data={analytics.data.orgs} searchPlaceholder="Search organizations..." emptyMessage="No organizations yet." pageSize={20} />
          </ConsoleSection>
        </>
      )}
    </ConsolePage>
  );
}
