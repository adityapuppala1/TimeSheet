/**
 * WHAT: filterable list of a user's past timesheet entries (date range, project, status), via
 * `timesheetApi.list` — and, since every row is now a door, the way into the full entry.
 *
 * WHY IT USED TO BE READ-ONLY, AND WHAT CHANGED: editing a submitted/approved entry has real
 * audit and SLA implications (see `sla.service.ts`), so this page deliberately showed rather than
 * amended. The cost of that was steeper than it looked: an approved entry leaves the approvals
 * queue, so this table became the ONLY remaining record of it — and it showed a two-line clamp of
 * the task, a COUNT of the attachments, and no reviewer at all. "Who logged this, against what,
 * and what did they attach" was unanswerable for the entire history of the workspace.
 *
 * So the amendment rule moved to where it belongs — the server (`PATCH /timesheets/:id`), which
 * audits every field change and notifies the submitter — and this page opens the shared
 * `TimesheetEntryDialog` on any row. Reading is unchanged for everyone; editing appears only for
 * whoever the API would actually allow. Deleting keeps its narrower rule (DRAFT/REJECTED only),
 * because erasure and correction are different things.
 *
 * DEEP LINK: `?entry=<id>` opens one directly, so a notification, a dashboard timeline block or a
 * pasted URL can all point at a specific entry rather than at "the list".
 *
 * WHO calls the backing API: `controllers/timesheet.controller.ts`'s list + detail routes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Clock, Eye, FileText, Filter, Layers, Paperclip, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
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
import { TimesheetEntryDialog } from "../components/TimesheetEntryDialog";

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

  /**
   * The open entry. Held in the URL rather than in state alone so the dialog is linkable — the
   * dashboard's day timeline sends people straight here, and a notification about an edited entry
   * should be able to as well. The row the user clicked is kept alongside it purely as a paint
   * seed; the dialog refetches by id regardless, because this list is capped at 100 rows and an
   * older entry reached by URL is simply not in it.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const openEntryId = searchParams.get("entry");
  const [entrySeed, setEntrySeed] = useState<any | null>(null);

  const openEntry = (row: any) => {
    setEntrySeed(row);
    // `replace` so the browser Back button leaves the page rather than walking back through every
    // entry the user peeked at.
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.set("entry", row.id);
      return next;
    }, { replace: true });
  };
  const closeEntry = () => {
    setEntrySeed(null);
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.delete("entry");
      return next;
    }, { replace: true });
  };

  // A stale `?entry=` (deleted row, someone else's link) must not leave the dialog stuck open on
  // an error. The dialog reports the failure; this clears the parameter once it has.
  useEffect(() => {
    if (openEntryId && entrySeed && entrySeed.id !== openEntryId) setEntrySeed(null);
  }, [openEntryId, entrySeed]);

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
        // The date is the door into the entry, the same way the employee name is on the approvals
        // table — one obvious, keyboard-reachable control per row rather than a separate "view"
        // column stealing width from the task text.
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => openEntry(row.original)}
            className="focus-ring rounded text-left"
            title="Open the full entry — task, notes, attachments"
          >
            <span className="whitespace-nowrap font-medium underline-offset-2 hover:underline">
              {String(row.original.workDate).slice(0, 10)}
            </span>
          </button>
        )
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
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            {/* Always present, on every status — this is the control that answers "what exactly
                did I log, and what did I attach", which used to have no answer at all once an
                entry was approved. */}
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-muted-foreground hover:text-foreground"
              aria-label={`View the entry for ${String(row.original.workDate).slice(0, 10)}`}
              onClick={() => openEntry(row.original)}
            >
              <Eye className="h-3.5 w-3.5" />
            </Button>
            {/* Only DRAFT and REJECTED can go — the API enforces the same rule for the same
                reason: a SUBMITTED entry is awaiting someone's decision, and an APPROVED one
                underpins the billing record. Hiding the control on the others means the button
                never lies about what it can do. */}
            {row.original.status === "DRAFT" || row.original.status === "REJECTED" ? (
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
            ) : null}
          </div>
        )
      }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openEntry closes over stable setters
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

      {/* The full entry — who logged it, the whole task text, the notes, and the attachments as
          downloadable links. Editing shows up inside it for whoever the API would allow. */}
      <TimesheetEntryDialog entryId={openEntryId} initialEntry={entrySeed} onClose={closeEntry} />

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
