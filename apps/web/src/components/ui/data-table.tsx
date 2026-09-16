/**
 * WHAT: a generic, reusable table with built-in client-side sorting, pagination, and a search
 * box — wraps @tanstack/react-table (headless, so it drives behavior while this file owns all
 * the markup/styling via the existing Table/TableHeader/TableRow/... primitives).
 * WHY this exists: every table in this app used to be a raw `<Table>` with the full dataset
 * dumped in — no way to sort a column or page through more than what fit on screen. This is the
 * one place that logic lives now, so every page gets it consistently instead of reinventing
 * page-size state and a "Prev/Next" pair per file.
 * WHAT this deliberately does NOT own: a page's own server-side filters (status/project/date
 * dropdowns that trigger a refetch) stay on the page — this component only sorts/searches/pages
 * through whatever array it's handed, same as `Array.prototype` operating on data someone else
 * fetched. `enableSearch={false}` lets a page that already has its own search box skip this
 * component's search bar instead of showing two.
 */
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type Row,
  type SortingState,
  type VisibilityState
} from "@tanstack/react-table";
import { Columns3, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { formatGroupLabel, groupCounts, groupRuns, type GroupRun } from "../../lib/group-rows";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { EmptyState } from "./empty-state";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Input } from "./input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

interface DataTableProps<TData> {
  columns: ColumnDef<TData, any>[];
  data: TData[];
  /** Row-click handler — only wire this for tables where the whole row navigates somewhere
   *  (e.g. Tickets' list view); tables with per-row action buttons should leave this unset. */
  onRowClick?: (row: TData) => void;
  /** Shows the built-in search box, filtering across every column's rendered text. Default on —
   *  set false on pages that already have their own search input to avoid showing two. */
  enableSearch?: boolean;
  searchPlaceholder?: string;
  /** Extra filter controls (Selects, toggle buttons) to render next to the search box — for
   *  pages that want everything in one toolbar row instead of a separate Card above the table. */
  toolbar?: ReactNode;
  /** Turn OFF the built-in client-side pagination (footer included) for tables whose paging
   *  happens on the SERVER — those render their own pager over the real total. Leaving this on
   *  produced two stacked pagers on the Users page: this one truthfully paging the 25 rows it
   *  could see, above the server's pager for the whole set. Two bars, one of them misleading. */
  enablePagination?: boolean;
  pageSize?: number;
  isLoading?: boolean;
  emptyMessage?: string;
  /** The honest next step when the table is empty — e.g. a "Clear filters" button. */
  emptyAction?: ReactNode;
  /** Overrides for pages with a different visual theme (platform-admin's dark/amber chrome). */
  className?: string;
  rowClassName?: string;
  /**
   * A column id to GROUP BY. The column becomes the primary sort (a person's own sort stays as the
   * secondary), and a header row — label and the group's size across the WHOLE filtered set — is
   * inserted wherever the value changes within the page. Groups collapse on click. Works in the
   * table and in the card list, from the same runs, so the two cannot disagree.
   */
  groupBy?: string;
  /** Renders a group's heading; default is `formatGroupLabel` ("IN_PROGRESS" → "In progress"). */
  groupLabel?: (value: unknown) => ReactNode;
  /** Rendered after a group's rows while it is expanded — e.g. an "add a row to this group"
   *  affordance. Receives the group's raw value. */
  groupFooter?: (value: unknown) => ReactNode;
  /**
   * CONTROLLED column visibility: the ids to show. Columns with `enableHiding: false` always show.
   * When provided, a "Columns" control appears in the toolbar and every change is reported through
   * `onVisibleColumnsChange` — the page owns the list so a saved view can carry it. Omit for the
   * old behaviour (every column, no control).
   */
  visibleColumns?: readonly string[];
  onVisibleColumnsChange?: (ids: string[]) => void;
}

export function DataTable<TData>({
  columns,
  data,
  onRowClick,
  enableSearch = true,
  searchPlaceholder = "Search...",
  toolbar,
  enablePagination = true,
  pageSize = 10,
  isLoading = false,
  emptyMessage = "No results.",
  emptyAction,
  className,
  rowClassName,
  groupBy,
  groupLabel,
  groupFooter,
  visibleColumns,
  onVisibleColumnsChange
}: DataTableProps<TData>) {
  // MEMOISED for the same reason `effectiveSorting` is: react-table treats a fresh state object as
  // a change, and a change here re-derives row models on every render.
  const columnVisibility = useMemo<VisibilityState>(() => {
    if (!visibleColumns) return {};
    const shown = new Set(visibleColumns);
    const out: VisibilityState = {};
    for (const col of columns) {
      const id = col.id ?? (col as { accessorKey?: string }).accessorKey;
      if (id && col.enableHiding !== false) out[id] = shown.has(id);
    }
    return out;
  }, [columns, visibleColumns]);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // The group column sorts first; whatever the person sorted by stays as the tie-breaker within
  // each group. Their own sorting state is kept untouched so removing the grouping restores it.
  //
  // MEMOISED, AND THIS IS LOAD-BEARING: react-table resets the page index whenever the sorting
  // state it is handed changes identity. A fresh array on every render therefore meant reset →
  // re-render → fresh array → reset, and the tab's main thread never came back (measured: a
  // keyboard press timed out at 150 s). The array must only change when its inputs do.
  const effectiveSorting = useMemo<SortingState>(
    () => (groupBy ? [{ id: groupBy, desc: false }, ...sorting.filter((s) => s.id !== groupBy)] : sorting),
    [groupBy, sorting]
  );
  const [globalFilter, setGlobalFilter] = useState("");
  // With pagination off, every row the parent hands over renders — the parent's server-side
  // pager owns the real page boundaries.
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: enablePagination ? pageSize : Number.MAX_SAFE_INTEGER });

  const table = useReactTable({
    data,
    columns,
    state: { sorting: effectiveSorting, globalFilter, pagination, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel()
  });

  const rows = table.getRowModel().rows;
  const totalRows = table.getFilteredRowModel().rows.length;
  // Runs over the PAGE (what is on screen); counts over the FILTERED SET (what the heading claims).
  const keyOf = (row: Row<TData>) => (groupBy ? row.getValue(groupBy) : undefined);
  const runs = groupBy ? groupRuns(rows, keyOf) : null;
  const counts = groupBy ? groupCounts(table.getFilteredRowModel().rows, keyOf) : null;
  const toggleGroup = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const renderGroupLabel = (raw: unknown) => (groupLabel ? groupLabel(raw) : formatGroupLabel(raw));
  /** What to render, in order: plain rows, or each group's header followed by its rows unless
   *  that group is collapsed. One function for both the card list and the table body. */
  const footerNode = (run: GroupRun<Row<TData>>, as: "card" | "row"): ReactNode => {
    if (!groupFooter) return null;
    const inner = groupFooter(run.rows[0]?.getValue(groupBy!));
    if (!inner) return null;
    if (as === "card") return <div key={`footer-${run.key}`}>{inner}</div>;
    return (
      <TableRow key={`footer-${run.key}`} className="hover:bg-transparent" data-group-footer>
        <TableCell colSpan={columns.length} className="p-1">{inner}</TableCell>
      </TableRow>
    );
  };
  const entriesFor = (as: "card" | "row"): Array<Row<TData> | ReactNode> => {
    if (!runs) return rows;
    return runs.flatMap((run) => (collapsed.has(run.key) ? [groupHeader(run, as)] : [groupHeader(run, as), ...run.rows, footerNode(run, as)]));
  };
  const groupHeader = (run: GroupRun<Row<TData>>, as: "card" | "row") => {
    const open = !collapsed.has(run.key);
    const total = counts?.get(run.key) ?? run.count;
    const button = (
      <button
        type="button"
        onClick={() => toggleGroup(run.key)}
        aria-expanded={open}
        className="focus-ring flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />
        <span className="truncate normal-case text-sm font-semibold text-foreground">{renderGroupLabel(run.rows[0]?.getValue(groupBy!))}</span>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums">{total}</span>
      </button>
    );
    if (as === "card") return <div key={`group-${run.key}`} className="mt-1">{button}</div>;
    return (
      <TableRow key={`group-${run.key}`} className="bg-muted/40 hover:bg-muted/40" data-group-row>
        <TableCell colSpan={columns.length} className="p-1">{button}</TableCell>
      </TableRow>
    );
  };
  const { pageIndex, pageSize: currentPageSize } = table.getState().pagination;
  const firstRowShown = totalRows === 0 ? 0 : pageIndex * currentPageSize + 1;
  const lastRowShown = Math.min((pageIndex + 1) * currentPageSize, totalRows);

  return (
    // `grid-cols-[minmax(0,1fr)]` is load-bearing, same trap as WorkspaceSettings.tsx's tabs
    // grid: a grid ITEM defaults to `min-width: auto`, so the desktop-table wrapper sized
    // itself to the TABLE's min-content width and grew right past the viewport instead of
    // letting its `overflow-auto` scroll — at tablet width every wide DataTable page was
    // silently clipped at the right edge with no scrollbar at all. An explicit minmax(0,1fr)
    // track lets items shrink below min-content, which is what finally lets the inner
    // overflow container do its job.
    <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-3", className)}>
      {(enableSearch || toolbar || visibleColumns) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {enableSearch ? (
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder={searchPlaceholder}
                className="pl-9"
              />
            </div>
          ) : (
            <div />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {toolbar}
            {visibleColumns && (
              <ColumnsControl
                columns={table.getAllLeafColumns().filter((c) => c.getCanHide())}
                visible={visibleColumns}
                onChange={(ids) => onVisibleColumnsChange?.(ids)}
              />
            )}
          </div>
        </div>
      )}

      {/* Mobile card list — a wide table has no readable layout below ~sm; a phone user
          scrolling it sideways sees 1-2 columns at a time with no context. Every column
          renders as its own label/value line instead, using the same column defs (and the
          same sorted/filtered/paginated row set) the desktop table below uses, so the two
          never drift out of sync on data. `sm:hidden` / `hidden sm:block` split, same pattern
          this app already used for Tickets/Team before DataTable existed. */}
      <div className="grid gap-2 sm:hidden">
        {isLoading && Array.from({ length: 3 }).map((_, i) => <div key={`skel-${i}`} className="h-24 w-full animate-pulse rounded-lg bg-muted" />)}
        {!isLoading && rows.length === 0 && <EmptyState compact title={emptyMessage} action={emptyAction} />}
        {!isLoading &&
          entriesFor("card").map((entry) => {
            if (entry === null || entry === undefined) return null;
            if (!("original" in (entry as object))) return entry as ReactNode;
            const row = entry as Row<TData>;
            // A div with the button role rather than a <button>: cells may carry their own controls
            // (a status pill), and a button inside a button is invalid HTML. Enter/Space still open.
            return (
              <div
                key={row.id}
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row.original);
                        }
                      }
                    : undefined
                }
                className={cn(
                  "grid gap-1.5 rounded-lg border border-border bg-card p-3 text-left text-sm shadow-sm",
                  onRowClick && "cursor-pointer"
                )}
              >
                {row.getVisibleCells().map((cell) => {
                  const header = cell.column.columnDef.header;
                  // A column can opt out of carrying its header into the card layout.
                  //
                  // WHY THIS EXISTS: the card view repeats each column's header as a label beside
                  // its value, once PER ROW. That is right for a text header and wrong for an
                  // interactive one — a select-all checkbox in the header renders once in the
                  // table and once per card, so a page of eight users showed nine identical
                  // "select everyone" controls, all of which did the same thing to the same set.
                  const meta = cell.column.columnDef.meta as { cardLabel?: boolean } | undefined;
                  const label =
                    meta?.cardLabel === false
                      ? null
                      : typeof header === "string"
                        ? header
                        : flexRender(header, { column: cell.column, header: cell.column, table } as any);
                  return (
                    <div key={cell.id} className="flex items-start justify-between gap-3">
                      {label ? <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span> : null}
                      <span className="min-w-0 flex-1 break-words text-right [overflow-wrap:anywhere]">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
      </div>

      <div className="hidden rounded-lg border border-border sm:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDirection = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sortDirection === "asc" ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : sortDirection === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-40" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-10 text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="p-3">
                  <EmptyState compact title={emptyMessage} action={emptyAction} />
                </TableCell>
              </TableRow>
            ) : (
              entriesFor("row").map((entry) => {
                if (entry === null || entry === undefined) return null;
                if (!("original" in (entry as object))) return entry as ReactNode;
                const row = entry as Row<TData>;
                return (
                  <TableRow
                    key={row.id}
                    className={cn(onRowClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", rowClassName)}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    // V12 4.3 keyboard pass: a clickable row is reachable by Tab and opens on
                    // Enter/Space — a keyboard user had no way to open a ticket from the table.
                    // Keys from controls INSIDE the row (the status pill) are theirs, not the row's.
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onRowClick(row.original);
                            }
                          }
                        : undefined
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                    ))}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {enablePagination && totalRows > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Showing {firstRowShown}-{lastRowShown} of {totalRows}
          </p>
          <div className="flex items-center gap-2">
            <Select value={String(currentPageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
              <SelectTrigger className="h-8 w-[90px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>{size} / page</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {pageIndex + 1} of {Math.max(table.getPageCount(), 1)}
            </span>
            <Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The "Columns" popover: one checkbox per hideable column, labelled by its header when that is a
 * string and by its id otherwise. Emits the full visible list, so the page (and a saved view)
 * holds one plain array rather than a diff.
 */
function ColumnsControl<TData>({
  columns,
  visible,
  onChange
}: Readonly<{ columns: Column<TData, unknown>[]; visible: readonly string[]; onChange: (ids: string[]) => void }>) {
  const shown = new Set(visible);
  const hiddenCount = columns.filter((c) => !shown.has(c.id)).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-[44px] gap-1.5" aria-label="Choose columns">
          <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
          Columns
          {hiddenCount > 0 && <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{hiddenCount} hidden</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-2">
        <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Columns</p>
        <ul className="grid gap-0.5" role="group" aria-label="Visible columns">
          {columns.map((col) => {
            const header = col.columnDef.header;
            const label = typeof header === "string" ? header : ((col.columnDef.meta as { label?: string } | undefined)?.label ?? col.id);
            const on = shown.has(col.id);
            return (
              <li key={col.id}>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted">
                  <Checkbox
                    checked={on}
                    onCheckedChange={(c) => {
                      const next = new Set(shown);
                      if (c) next.add(col.id);
                      else next.delete(col.id);
                      // Keep the table's own order so the saved list reads the way the header does.
                      onChange(columns.filter((k) => next.has(k.id)).map((k) => k.id));
                    }}
                  />
                  <span className="truncate">{label}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
