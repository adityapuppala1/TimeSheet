/**
 * WHAT: the console's cross-tenant metrics screen — three totals as KPI tiles, then one row per
 * organization (seats, ticket volume, AI spend, outbound mail health, practice-update adoption).
 *
 * WHY the table is rendered here rather than handed to the shared `<DataTable>`: DataTable owns
 * its own `<td>`s, so a page cannot give a column the console's numeric cell (`Num` — right
 * aligned, monospaced, tabular figures), and its table carries no minimum width, so below ~1100px
 * the browser resolved the overflow by wrapping eight columns into three-line cells instead of
 * scrolling. Every behaviour DataTable provided is kept: this file still drives the same headless
 * @tanstack/react-table (search across the row's values, sortable headers, client-side paging with
 * the same page-size options) and only owns the MARKUP, which it takes from the console kit —
 * `ConsoleTable` for the scroll container and honest minimum width, `Num` for every count, amount
 * and date. A column of numbers you can compare down the column is the entire point of this page.
 */
import { useQuery } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Building2,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  RefreshCw,
  Search,
  Users
} from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/utils";
import { platformAdminAnalyticsApi, type OrgAnalyticsSummary } from "../../services/platform-admin-api";
import {
  ConsolePage,
  ConsoleSection,
  ConsoleTable,
  EmptyState,
  Field,
  KpiCard,
  KpiGrid,
  Num,
  PRIMARY_BTN,
  Toolbar,
  shortDate
} from "./console-ui";

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/** A stable empty array: a fresh `[]` on every render would re-seat the table's row models. */
const NO_ORGS: OrgAnalyticsSummary[] = [];

/**
 * An ALIAS, not a second copy.
 *
 * This was a hand-maintained interface mirroring `OrgAnalyticsSummary` in the API client — which
 * is a shape that drifts silently: the service can add a field, the client type can gain it, and
 * this page still cannot see it. Aliasing means a new metric reaches the table's `accessorFn`
 * the moment the service returns it.
 */
type OrgAnalyticsRow = OrgAnalyticsSummary;

/**
 * The columns whose values are counts, amounts or dates — rendered in `Num` and headed
 * `text-right`. A set of column ids rather than a `meta: { numeric: true }` flag on each def,
 * because TanStack's `ColumnMeta` is an app-wide module augmentation: one boolean this page needs
 * is not worth widening a type every other table then inherits.
 */
const NUMERIC_COLUMNS = new Set([
  "seatCount",
  "openTickets",
  "totalTickets",
  "aiSpendThisMonthUsd",
  "mail",
  "practiceUpdatesSentThisMonth",
  "lastActivityAt"
]);

const columns: ColumnDef<OrgAnalyticsRow, any>[] = [
  {
    accessorKey: "name",
    header: "Organization",
    cell: ({ row }) => (
      // A row, not inline text: as a `<span>` after the name the marker sat on the name's own
      // baseline and pushed it around whenever it appeared. A badge in a flex row leaves the
      // name where it is on every line of the column.
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-foreground">{row.original.name}</span>
        {!row.original.reachable && (
          <Badge variant="warning" className="shrink-0 gap-1 whitespace-nowrap">
            <AlertTriangle className="h-3 w-3" />
            Unreachable
          </Badge>
        )}
      </div>
    )
  },
  { accessorKey: "seatCount", header: "Seats", cell: (info) => info.getValue() },
  {
    id: "openTickets",
    accessorFn: (row) => (row.ticketCountsByStatus.OPEN ?? 0) + (row.ticketCountsByStatus.IN_PROGRESS ?? 0),
    header: "Open Tickets",
    cell: (info) => info.getValue()
  },
  {
    id: "totalTickets",
    accessorFn: (row) => Object.values(row.ticketCountsByStatus).reduce((a, b) => a + b, 0),
    header: "Total Tickets",
    cell: (info) => info.getValue()
  },
  {
    accessorKey: "aiSpendThisMonthUsd",
    header: "AI Spend",
    cell: (info) => currency.format(info.getValue() as number)
  },
  {
    id: "mail",
    accessorFn: (row) => row.emailsSentThisMonth,
    header: "Mail (Sent / Failed)",
    cell: ({ row }) => (
      <>
        {row.original.emailsSentThisMonth}
        {" / "}
        {/* Only a NON-ZERO failure count is coloured. A red 0 trains an operator to ignore the
            column, which is the opposite of what a health signal is for. */}
        <span className={row.original.emailsFailedThisMonth > 0 ? "text-warning" : "text-muted-foreground"}>
          {row.original.emailsFailedThisMonth}
        </span>
      </>
    )
  },
  {
    accessorKey: "practiceUpdatesSentThisMonth",
    header: "Practice Updates",
    cell: (info) => {
      const count = info.getValue() as number;
      // An em dash, not a 0: zero sends and "the tier does not include it" look identical in a
      // number, and this column exists to make "entitled but unused" visible.
      return count > 0 ? count : <span className="text-muted-foreground/60">—</span>;
    }
  },
  {
    accessorKey: "lastActivityAt",
    header: "Last Activity",
    // A date belongs in the same right-aligned rail as the counts: it is read down the column
    // ("who went quiet"), never as prose. `shortDate` already renders null as an em dash.
    cell: (info) => <span className="text-muted-foreground">{shortDate(info.getValue() as string | null)}</span>
  }
];

/** The header's sort affordance. Its own component so a header cell stays one expression instead
 *  of a three-way ternary chain; `false` is TanStack's "not sorted by this column". */
function SortIcon({ direction }: { direction: false | "asc" | "desc" }) {
  if (direction === "asc") return <ArrowUp className="h-3 w-3" />;
  if (direction === "desc") return <ArrowDown className="h-3 w-3" />;
  return <ArrowUpDown className="h-3 w-3 opacity-40" />;
}

/** The only screen in the console that surfaces cross-tenant NUMBERS (seat counts, ticket
 *  counts by status, AI spend, outbound mail health, practice-update adoption) — never row-level
 *  content. Backed by the single
 *  cross-tenant-loop service (platform-admin-analytics.service.ts) by design. */
export function PlatformAdminAnalytics() {
  const analytics = useQuery({ queryKey: ["platform-admin", "analytics"], queryFn: platformAdminAnalyticsApi.get });
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data: analytics.data?.orgs ?? NO_ORGS,
    columns,
    state: { sorting, globalFilter },
    initialState: { pagination: { pageIndex: 0, pageSize: 20 } },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel()
  });

  const rows = table.getRowModel().rows;
  const totalRows = table.getFilteredRowModel().rows.length;
  const { pageIndex, pageSize } = table.getState().pagination;
  const firstRowShown = totalRows === 0 ? 0 : pageIndex * pageSize + 1;
  const lastRowShown = Math.min((pageIndex + 1) * pageSize, totalRows);
  const hasOrgs = (analytics.data?.orgs.length ?? 0) > 0;

  return (
    <ConsolePage
      eyebrow="Tenants"
      title="Analytics"
      description="Aggregate metrics across every organization — seat counts, ticket volume, AI spend, outbound mail health and practice-update adoption. Counts only: no ticket, comment, timesheet or email content ever surfaces here."
      actions={
        // A read-only snapshot has exactly one action, so refetching IS this page's primary one.
        <Button size="sm" className={PRIMARY_BTN} onClick={() => analytics.refetch()} disabled={analytics.isFetching}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", analytics.isFetching && "animate-spin")} />
          {analytics.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      }
    >
      {/* The skeleton mirrors the layout it becomes — tiles then a card — so nothing jumps when
          the numbers land. */}
      {analytics.isLoading && (
        <>
          <KpiGrid>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[6.5rem] w-full rounded-xl" />
            ))}
          </KpiGrid>
          <Skeleton className="h-64 w-full rounded-xl" />
        </>
      )}

      {!analytics.isLoading && analytics.data && (
        <>
          <KpiGrid>
            <KpiCard icon={Building2} label="Organizations" value={analytics.data.totals.orgCount} tone="accent" />
            <KpiCard icon={Users} label="Total seats" value={analytics.data.totals.seatCount} delay={0.05} />
            <KpiCard
              icon={DollarSign}
              label="AI spend this month"
              value={analytics.data.totals.aiSpendThisMonthUsd}
              format={(n) => currency.format(n)}
              delay={0.1}
            />
          </KpiGrid>

          <ConsoleSection
            title="Per-organization breakdown"
            description="This month, aggregated per org."
            bodyClassName="grid gap-4"
            actions={
              hasOrgs ? (
                <Toolbar className="w-full sm:w-auto">
                  {/* No visible label: the placeholder and aria-label name it, and a label above a
                      section header's control would sit taller than the heading beside it. */}
                  <Field className="w-full sm:w-64">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={globalFilter}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                        placeholder="Search organizations..."
                        aria-label="Search organizations"
                        className="pl-9"
                      />
                    </div>
                  </Field>
                </Toolbar>
              ) : undefined
            }
          >
            {!hasOrgs ? (
              <EmptyState
                icon={Building2}
                title="No organizations yet."
                description="Provision a workspace and its seats, tickets, AI spend and mail health appear here."
              />
            ) : (
              <>
                {/* 1040px: eight columns, one of which carries a name plus a badge. Below that the
                    grid scrolls INSIDE this card — the page body never moves sideways. */}
                <ConsoleTable minWidth={1040}>
                  <TableHeader>
                    {table.getHeaderGroups().map((headerGroup) => (
                      <TableRow key={headerGroup.id} className="hover:bg-transparent">
                        {headerGroup.headers.map((header) => {
                          const numeric = NUMERIC_COLUMNS.has(header.column.id);
                          return (
                            <TableHead key={header.id} className={numeric ? "text-right" : undefined}>
                              {header.isPlaceholder ? null : (
                                <button
                                  type="button"
                                  // Reversed on a numeric column so the LABEL stays flush with the
                                  // right rail its numbers line up on, and the arrow sits outside it.
                                  className={cn("inline-flex items-center gap-1 hover:text-foreground", numeric && "flex-row-reverse")}
                                  onClick={header.column.getToggleSortingHandler()}
                                >
                                  {flexRender(header.column.columnDef.header, header.getContext())}
                                  <SortIcon direction={header.column.getIsSorted()} />
                                </button>
                              )}
                            </TableHead>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={columns.length} className="py-10 text-center text-sm text-muted-foreground">
                          No organizations match “{globalFilter}”.
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((row) => (
                        <TableRow key={row.id}>
                          {row.getVisibleCells().map((cell) => {
                            const content = flexRender(cell.column.columnDef.cell, cell.getContext());
                            return NUMERIC_COLUMNS.has(cell.column.id) ? (
                              <Num key={cell.id}>{content}</Num>
                            ) : (
                              <TableCell key={cell.id}>{content}</TableCell>
                            );
                          })}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </ConsoleTable>

                {totalRows > 0 && (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-muted-foreground">
                      Showing {firstRowShown}-{lastRowShown} of {totalRows}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={String(pageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
                        <SelectTrigger aria-label="Rows per page" className="h-8 w-[90px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAGE_SIZE_OPTIONS.map((size) => (
                            <SelectItem key={size} value={String(size)}>
                              {size} / page
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="Previous page"
                        onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage()}
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        Page {pageIndex + 1} of {Math.max(table.getPageCount(), 1)}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="Next page"
                        onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage()}
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </ConsoleSection>
        </>
      )}
    </ConsolePage>
  );
}
