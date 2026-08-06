/**
 * WHAT: read-only, filterable list of a user's past timesheet entries (date range, project,
 * status), via `timesheetApi.list`.
 * WHY almost read-only: editing an already-submitted/approved entry has real audit/SLA
 * implications (see `sla.service.ts`), so this page is for reviewing history, not amending it —
 * `Timesheet.tsx` is where new entries are logged. The ONE exception is deleting a DRAFT or
 * REJECTED entry, which had no home anywhere in the product: an entry logged by mistake could
 * only be edited into something else or left in the list forever. Submitted and approved entries
 * deliberately have no delete control, matching the API rule.
 * WHO calls the backing API: `controllers/timesheet.controller.ts`'s list route.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Clock, FileText, Filter, Layers, Paperclip, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { DataTable } from "../components/ui/data-table";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { StatCard } from "../components/ui/stat-card";
import { computeTrend, type Trend } from "../lib/trend";
import { projectApi, timesheetApi } from "../services/api";
import { safeHtml } from "../lib/safe-html";
import { toast } from "../components/ui/toaster";
import { DateRangePicker } from "../components/ui/date-range-picker";

function startOfWeek(date: Date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

type StatusFilter = "ALL" | "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";

const statusVariant: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  APPROVED: "success",
  SUBMITTED: "warning",
  DRAFT: "muted",
  REJECTED: "destructive"
};

export function History() {
  const timesheets = useQuery({ queryKey: ["timesheets"], queryFn: timesheetApi.list, refetchInterval: 30_000 });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [projectId, setProjectId] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  /** The entry awaiting confirmation. Deleting is irreversible from the user's side, so it never
   *  happens on a single click. */
  const [pendingDelete, setPendingDelete] = useState<any | null>(null);
  const queryClient = useQueryClient();

  const removeEntry = useMutation({
    mutationFn: (id: string) => timesheetApi.remove(id),
    onSuccess: () => {
      toast.success("Entry deleted");
      setPendingDelete(null);
      // Both lists move: History is this page, and the dashboard's day timeline and weekly
      // rollups read the same rows.
      queryClient.invalidateQueries({ queryKey: ["timesheets"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err: any) =>
      toast.error("Could not delete", { description: err?.response?.data?.message ?? "Try again." })
  });

  const rows: any[] = Array.isArray(timesheets.data) ? timesheets.data : [];

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (status !== "ALL" && row.status !== status) return false;
      if (projectId !== "all" && row.projectId !== projectId) return false;
      if (from && String(row.workDate).slice(0, 10) < from) return false;
      if (to && String(row.workDate).slice(0, 10) > to) return false;
      return true;
    });
  }, [rows, status, projectId, from, to]);

  const summary = useMemo(() => {
    return filtered.reduce(
      (acc, row) => {
        const hours = Number(row.totalHours ?? 0);
        acc.hours += hours;
        acc.count += 1;
        if (row.status === "APPROVED") acc.approved += hours;
        if (row.status === "SUBMITTED") acc.pending += hours;
        if (row.status === "REJECTED") acc.rejected += hours;
        return acc;
      },
      { hours: 0, count: 0, approved: 0, pending: 0, rejected: 0 }
    );
  }, [filtered]);

  const weekTrends = useMemo(() => {
    const now = new Date();
    const thisWeekStart = startOfWeek(now);
    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    const thisWeek = { count: 0, hours: 0, approved: 0, pending: 0 };
    const lastWeek = { count: 0, hours: 0, approved: 0, pending: 0 };
    for (const row of rows) {
      const work = new Date(String(row.workDate));
      if (Number.isNaN(work.getTime())) continue;
      const hours = Number(row.totalHours ?? 0);
      let bucket: typeof thisWeek | null = null;
      if (work >= thisWeekStart) bucket = thisWeek;
      else if (work >= lastWeekStart && work < thisWeekStart) bucket = lastWeek;
      if (!bucket) continue;
      bucket.count += 1;
      bucket.hours += hours;
      if (row.status === "APPROVED") bucket.approved += hours;
      if (row.status === "SUBMITTED") bucket.pending += hours;
    }
    return {
      count: computeTrend(thisWeek.count, lastWeek.count, true),
      hours: computeTrend(thisWeek.hours, lastWeek.hours, true),
      approved: computeTrend(thisWeek.approved, lastWeek.approved, true),
      pending: computeTrend(thisWeek.pending, lastWeek.pending, false)
    } as Record<string, Trend | null>;
  }, [rows]);

  function resetFilters() {
    setStatus("ALL");
    setProjectId("all");
    setFrom("");
    setTo("");
  }

  const historyColumns = useMemo<ColumnDef<any, any>[]>(
    () => [
      {
        id: "date",
        accessorFn: (row: any) => row.workDate,
        header: "Date",
        cell: ({ row }) => <span className="whitespace-nowrap font-medium">{String(row.original.workDate).slice(0, 10)}</span>
      },
      {
        id: "projectModule",
        accessorFn: (row: any) => row.project?.name,
        header: "Project / Module",
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.project?.name}</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Layers className="h-3 w-3" />
              {row.original.module?.name}
              {row.original.submodule ? ` / ${row.original.submodule.name}` : ""}
            </p>
            {row.original.ticket && <Badge variant="outline" className="mt-1 font-mono text-[10px]">{row.original.ticket.key}</Badge>}
          </div>
        )
      },
      { accessorKey: "activityType", header: "Activity" },
      {
        id: "time",
        accessorFn: (row: any) => row.startTime,
        header: "Time",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">
            <Clock className="h-3 w-3" />
            {row.original.startTime}–{row.original.endTime}
          </span>
        )
      },
      {
        id: "hours",
        accessorFn: (row: any) => Number(row.totalHours),
        header: () => <span className="block text-right">Hours</span>,
        cell: ({ row }) => <span className="block text-right font-semibold">{Number(row.original.totalHours).toFixed(2)}</span>
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant={statusVariant[row.original.status] ?? "muted"}>{row.original.status}</Badge>
            {row.original.identityVerified && (
              /* The submitter's own receipt that their identity check was accepted — the
                 in-dialog confirmation vanishes; this persists. */
              <Badge
                variant="success"
                title={row.original.identityVerifiedAt ? `Identity confirmed ${new Date(row.original.identityVerifiedAt).toLocaleString()}` : "Identity confirmed"}
              >
                <ShieldCheck className="mr-0.5 h-3 w-3" />ID
              </Badge>
            )}
          </div>
        )
      },
      {
        id: "task",
        accessorFn: (row: any) => row.taskDescription ?? "",
        header: "Task",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="max-w-md">
            <div className="flex items-start gap-1 text-foreground/80">
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="prose-sm line-clamp-2" dangerouslySetInnerHTML={safeHtml(row.original.taskDescription)} />
            </div>
            {row.original.attachments?.length ? (
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Paperclip className="h-3 w-3" />
                {row.original.attachments.length} attachment(s)
              </p>
            ) : null}
            {row.original.status === "REJECTED" && row.original.rejectionReason ? (
              <p className="mt-1 text-xs text-destructive">Reason: {row.original.rejectionReason}</p>
            ) : null}
          </div>
        )
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          // Only DRAFT and REJECTED can go — the API enforces the same rule for the same reason:
          // a SUBMITTED entry is awaiting someone's decision, and an APPROVED one underpins the
          // billing record. Hiding the control on the others means the button never lies about
          // what it can do.
          row.original.status === "DRAFT" || row.original.status === "REJECTED" ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Delete entry for ${String(row.original.workDate).slice(0, 10)}`}
              disabled={removeEntry.isPending}
              onClick={() => setPendingDelete(row.original)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null
      }
    ],
    [removeEntry.isPending]
  );

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Timesheet history</h1>
        <p className="mt-1 text-sm text-muted-foreground">Filter and review every entry you've logged. Hours roll up live as you adjust filters.</p>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
        <StatCard label="Entries" value={summary.count} trend={weekTrends.count} trendLabel="this week vs last week" />
        <StatCard label="Logged hours" value={summary.hours.toFixed(2)} trend={weekTrends.hours} trendLabel="this week vs last week" />
        <StatCard label="Approved hours" value={summary.approved.toFixed(2)} tone="success" trend={weekTrends.approved} trendLabel="this week vs last week" />
        <StatCard label="Pending hours" value={summary.pending.toFixed(2)} tone="warning" trend={weekTrends.pending} trendLabel="this week vs last week" />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="h-4 w-4" /> Filters
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            <RotateCcw className="h-3.5 w-3.5" />Reset
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-4">
            <div className="grid gap-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All statuses</SelectItem>
                  <SelectItem value="DRAFT">Draft</SelectItem>
                  <SelectItem value="SUBMITTED">Submitted</SelectItem>
                  <SelectItem value="APPROVED">Approved</SelectItem>
                  <SelectItem value="REJECTED">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All projects</SelectItem>
                  {(projects.data ?? []).map((project: any) => (
                    <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">

              {/* One range instead of two unrelated inputs — nothing previously stopped `to` preceding

                  `from`, and "last month" needed two taps and a mental calendar. */}

              <Label htmlFor="history-range">Date range</Label>

              <DateRangePicker

                id="history-range"

                value={{ from, to }}

                onChange={(range) => { setFrom(range.from); setTo(range.to); }}

                placeholder="All time"

              />

            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <DataTable
            columns={historyColumns}
            data={filtered}
            isLoading={timesheets.isLoading}
            searchPlaceholder="Search task, activity, notes..."
            emptyMessage="No entries match the current filters."
            pageSize={20}
          />
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete && (
                <>
                  {Number(pendingDelete.totalHours).toFixed(2)}h on {String(pendingDelete.workDate).slice(0, 10)} for{" "}
                  {pendingDelete.project?.name}. This can't be undone, and the time slot becomes free to log again.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removeEntry.isPending}
              onClick={(e) => {
                // Radix closes the dialog on action-click by default; deferring lets the mutation's
                // own error path keep it open with the reason visible instead of vanishing.
                e.preventDefault();
                removeEntry.mutate(pendingDelete.id);
              }}
            >
              Delete entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
