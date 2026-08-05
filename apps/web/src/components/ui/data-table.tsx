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
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
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
  /** Overrides for pages with a different visual theme (platform-admin's dark/amber chrome). */
  className?: string;
  rowClassName?: string;
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
  className,
  rowClassName
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  // With pagination off, every row the parent hands over renders — the parent's server-side
  // pager owns the real page boundaries.
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: enablePagination ? pageSize : Number.MAX_SAFE_INTEGER });

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, pagination },
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
      {(enableSearch || toolbar) && (
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
          {toolbar}
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
        {!isLoading && rows.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>}
        {!isLoading &&
          rows.map((row) => {
            const Wrapper = onRowClick ? "button" : "div";
            return (
              <Wrapper
                key={row.id}
                type={onRowClick ? "button" : undefined}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
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
              </Wrapper>
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
              <TableRow>
                <TableCell colSpan={columns.length} className="py-10 text-center text-sm text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn(onRowClick && "cursor-pointer", rowClassName)}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))
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
