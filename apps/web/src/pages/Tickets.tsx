/**
 * The Tickets page — list view, Kanban board view (see TicketKanban.tsx), the create dialog,
 * and the ticket detail sheet (status/assignee/labels/links/checklist/comments/attachments/
 * time-logged/activity tabs).
 *
 * WHY the AI bits live inline here (AI-assist chip, AI summary) rather than in a separate file:
 * they're small, ticket-scoped affordances that read straight from `aiApi` and only ever render
 * one at a time — splitting them out would mean prop-drilling the same ticket/project context
 * back in for no real separation-of-concerns benefit. The exception is the per-field "Refine with
 * AI" affordance (components/AiRefine.tsx): it is shared with the timesheet form, and its
 * accept/reject/undo contract is the same wherever it appears.
 *
 * WHO can see/do what: gated at the route level (`RequirePermission` in App.tsx) for the page
 * itself; per-action gates (assign, reopen a closed ticket, etc.) are re-checked here against
 * `user.permissions`/`user.role` because the server is the real authority — these client-side
 * checks only hide buttons that would 403 anyway, they're not the security boundary.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  permissions,
  ticketBranchPrStatuses,
  ticketPriorities,
  ticketStatusTransitions,
  ticketStatuses,
  type SecurityFindingSeverity,
  type TicketBranchPrStatus,
  type TicketPriority,
  type TicketStatus
} from "@timesheet/shared";
import {
  AlertTriangle,
  ArrowUpRight,
  Bug,
  CalendarRange,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  GanttChartSquare,
  GitBranch,
  LayoutGrid,
  Link2,
  ListChecks,
  Download,
  Mail,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Plus,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tag,
  Ticket as TicketIcon,
  TimerReset,
  Trash2,
  Waypoints,
  X
} from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { AiRefinePanel, AiRefineTrigger, useAiRefine } from "../components/AiRefine";
import { PlanCalendar } from "../components/PlanCalendar";
import { TicketApprovalsPanel } from "../components/TicketApprovalsPanel";
import { ProofingPanel } from "../components/ProofingPanel";
import { SavedViewsBar } from "../components/SavedViewsBar";
import { TicketPlanningPanel } from "../components/TicketPlanningPanel";
import { PlanTimeline, TimelineLegend, scheduledItemIds, type TimelineZoom } from "../components/PlanTimeline";
import { TicketKanban } from "../components/TicketKanban";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge, type BadgeProps } from "../components/ui/badge";
import { AiStrands } from "../components/ui/ai-strands";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { DataTable } from "../components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { FileDropzone } from "../components/ui/file-dropzone";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { RichTextEditor } from "../components/ui/rich-text-editor";
import { ScrollArea } from "../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { safeHtml } from "../lib/safe-html";
import { aiApi, faceApi, fileUrl, labelApi, planApi, projectApi, settingsApi, ticketApi, ticketTypeApi, type AIDuplicateMatch, type AITriageSuggestion, type SecurityFindingRow, type TicketAttachmentRow, type TicketBranchRow, type TicketChecklistItemRow, type TicketComment, type TicketDetail, type TicketLineageEvent, type TicketLinkRow, type TicketLinkType, type TicketRow, type TicketTimesheetRow } from "../services/api";
import { FaceVerificationDialog } from "../components/FaceVerificationDialog";
import { useFaceStatus } from "../lib/use-face-status";
import { usePlanningFeatures } from "../lib/use-planning";
import { useAuthStore } from "../store/auth";

/** Icon for the 3 seeded defaults; any admin-added custom type falls back to a generic tag. */
const DEFAULT_TYPE_ICONS: Record<string, typeof Bug> = {
  BUG: Bug,
  TASK: ListChecks,
  IMPROVEMENT: Sparkles
};
export function iconForType(type: string) {
  return DEFAULT_TYPE_ICONS[type.toUpperCase()] ?? Tag;
}

export const STATUS_VARIANT: Record<TicketStatus, BadgeProps["variant"]> = {
  OPEN: "info",
  IN_PROGRESS: "warning",
  IN_REVIEW: "warning",
  RESOLVED: "success",
  CLOSED: "muted",
  REOPENED: "destructive"
};

export const PRIORITY_VARIANT: Record<TicketPriority, BadgeProps["variant"]> = {
  LOW: "muted",
  MEDIUM: "info",
  HIGH: "warning",
  CRITICAL: "destructive"
};

export function serverMessage(err: any, fallback: string) {
  return err?.response?.data?.message ?? fallback;
}

export function initialsFor(name?: string) {
  if (!name) return "?";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Column defs for the desktop list view's DataTable — module-level since these don't depend on
 *  component state, just the row shape and the module-level helpers/variant maps above. */
const ticketColumns: ColumnDef<TicketRow, any>[] = [
  { accessorKey: "key", header: "Key", cell: (info) => <span className="font-mono text-xs text-muted-foreground">{info.getValue()}</span> },
  {
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => (
      <div className="flex max-w-[280px] items-center gap-1.5">
        {row.original.source === "EMAIL" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent>Created from an inbound email</TooltipContent>
          </Tooltip>
        )}
        <span className="truncate font-medium">{row.original.title}</span>
        {row.original.needsReview && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="warning" className="shrink-0 gap-1"><Sparkles className="h-3 w-3" />Review</Badge>
            </TooltipTrigger>
            <TooltipContent>AI classification confidence was below threshold</TooltipContent>
          </Tooltip>
        )}
      </div>
    )
  },
  {
    id: "project",
    accessorFn: (row) => row.project.name,
    header: "Project",
    cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span>
  },
  {
    accessorKey: "type",
    header: "Type",
    cell: ({ row }) => {
      const TypeIcon = iconForType(row.original.type);
      return (
        <span className="inline-flex items-center gap-1.5 text-sm">
          <TypeIcon className="h-3.5 w-3.5 text-muted-foreground" />{row.original.type}
        </span>
      );
    }
  },
  {
    accessorKey: "priority",
    header: "Priority",
    cell: (info) => <Badge variant={PRIORITY_VARIANT[info.getValue() as TicketPriority]}>{info.getValue()}</Badge>
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: (info) => {
      const status = info.getValue() as TicketStatus;
      return <Badge variant={STATUS_VARIANT[status]}>{status.replace("_", " ")}</Badge>;
    }
  },
  {
    id: "labels",
    accessorFn: (row) => row.labels.map((tl) => tl.label.name).join(", "),
    header: "Labels",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {row.original.labels.map((tl) => (
          <span
            key={tl.id}
            className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium"
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tl.label.color ?? "#94A3B8" }} />
            {tl.label.name}
          </span>
        ))}
        {row.original.labels.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
      </div>
    )
  },
  {
    id: "assignee",
    accessorFn: (row) => row.assignee?.name ?? "",
    header: "Assignee",
    cell: ({ row }) => {
      const assignee = row.original.assignee;
      const avatarSrc = fileUrl(assignee?.avatarUrl);
      return assignee ? (
        <div className="flex items-center gap-2">
          <Avatar className="h-9 w-9">
            {avatarSrc ? <AvatarImage src={avatarSrc} alt={assignee.name} /> : null}
            <AvatarFallback className="text-[10px]">{initialsFor(assignee.name)}</AvatarFallback>
          </Avatar>
          <span className="truncate text-sm">{assignee.name}</span>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">Unassigned</span>
      );
    }
  },
  {
    accessorKey: "dueAt",
    header: "Due",
    cell: ({ row }) => {
      const overdue = Boolean(row.original.slaBreachAt);
      return overdue ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />Overdue
            </span>
          </TooltipTrigger>
          <TooltipContent>Due {formatDate(row.original.dueAt)}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-xs text-muted-foreground">{formatDate(row.original.dueAt)}</span>
      );
    }
  }
];

export function Tickets() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get("open");

  const [filters, setFilters] = useState({ projectId: "all", status: "all", priority: "all", labelId: "all", onlyMine: false });
  const [createOpen, setCreateOpen] = useState(false);
  // Timeline and Calendar join List and Board here rather than becoming their own pages, so the
  // filters someone has already set carry across every way of looking at the same work. A
  // separate "planning" page would have meant two places to filter and two mental models.
  const [viewMode, setViewMode] = useState<"list" | "board" | "timeline" | "calendar">("list");
  const { features: planFeatures } = usePlanningFeatures();
  const canEditPlan = Boolean(user?.permissions.includes(permissions.PLAN_WRITE));
  const [timelineZoom, setTimelineZoom] = useState<TimelineZoom>("week");
  const [showBaseline, setShowBaseline] = useState(true);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [showUnscheduled, setShowUnscheduled] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() };
  });

  // Both planning views respect the project filter already on this page; neither fetches until
  // its tab is actually open, so an org that never uses them pays nothing for them being here.
  const planProjectIds = filters.projectId !== "all" ? [filters.projectId] : undefined;
  const timelineQuery = useQuery({
    queryKey: ["plan", "timeline", "tickets-tab", filters.projectId],
    queryFn: () => planApi.timeline({ projectIds: planProjectIds }),
    enabled: viewMode === "timeline" && planFeatures.timeline
  });
  const timelineDeps = useQuery({
    queryKey: ["plan", "dependencies", "tickets-tab", filters.projectId],
    queryFn: () => planApi.dependencies(planProjectIds),
    enabled: viewMode === "timeline" && planFeatures.timeline
  });
  const calendarQuery = useQuery({
    queryKey: ["plan", "calendar", filters.projectId, calendarMonth.year, calendarMonth.month],
    queryFn: () => {
      // A month grid always shows six weeks, so the window has to cover the leading and trailing
      // days from the neighbouring months or those cells render empty when they aren't.
      const from = new Date(Date.UTC(calendarMonth.year, calendarMonth.month, 1 - 7));
      const to = new Date(Date.UTC(calendarMonth.year, calendarMonth.month + 1, 14));
      return planApi.calendar({
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        projectIds: planProjectIds
      });
    },
    enabled: viewMode === "calendar" && planFeatures.planning
  });

  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const labels = useQuery({ queryKey: ["labels"], queryFn: labelApi.list });
  const tickets = useQuery({
    queryKey: ["tickets", filters],
    queryFn: () =>
      ticketApi.list({
        projectId: filters.projectId !== "all" ? filters.projectId : undefined,
        status: filters.status !== "all" ? filters.status : undefined,
        priority: filters.priority !== "all" ? filters.priority : undefined,
        labelId: filters.labelId !== "all" ? filters.labelId : undefined,
        assigneeId: filters.onlyMine ? user?.id : undefined
      })
  });

  function openTicket(id: string) {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.set("open", id);
      return next;
    });
  }
  function closeTicket() {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.delete("open");
      return next;
    });
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <TicketIcon className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight">Tickets</h1>
            <p className="mt-1 text-sm text-muted-foreground">Bugs, tasks, and improvements — assign, track, and resolve.</p>
          </div>
        </div>
        {/* `min-w-0` + `flex-wrap` are load-bearing at 390px, not tidying. Going from two view
            buttons to four pushed this row past the viewport, and because `body { overflow-x:
            clip }` hides the damage rather than scrolling it, the symptom was the page header
            silently dragged off-screen — the exact failure documented on the Workspace Settings
            grid track in index.css. The switcher below owns its own overflow so it can never
            export width to the page again. */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <div className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-border p-0.5">
            <Button className="shrink-0" variant={viewMode === "list" ? "default" : "ghost"} size="sm" onClick={() => setViewMode("list")}>
              <ListChecks className="h-3.5 w-3.5" />List
            </Button>
            <Button className="shrink-0" variant={viewMode === "board" ? "default" : "ghost"} size="sm" onClick={() => setViewMode("board")}>
              <LayoutGrid className="h-3.5 w-3.5" />Board
            </Button>
            {/* Only rendered once the workspace has the capability — an org that never turns on
                planning sees exactly the two-button toggle it always had. */}
            {planFeatures.timeline && (
              <Button className="shrink-0" variant={viewMode === "timeline" ? "default" : "ghost"} size="sm" onClick={() => setViewMode("timeline")}>
                <GanttChartSquare className="h-3.5 w-3.5" />Timeline
              </Button>
            )}
            {planFeatures.planning && (
              <Button className="shrink-0" variant={viewMode === "calendar" ? "default" : "ghost"} size="sm" onClick={() => setViewMode("calendar")}>
                <CalendarRange className="h-3.5 w-3.5" />Calendar
              </Button>
            )}
          </div>
          <Button className="shrink-0" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />New ticket
          </Button>
        </div>
      </div>

      <Card data-tour="tickets-workspace">
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <Select value={filters.projectId} onValueChange={(v) => setFilters((f) => ({ ...f, projectId: v }))}>
            <SelectTrigger className="w-full sm:w-[180px]"><SelectValue placeholder="All projects" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projects.data?.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.status} onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}>
            <SelectTrigger className="w-full sm:w-[160px]"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {ticketStatuses.map((s) => <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.priority} onValueChange={(v) => setFilters((f) => ({ ...f, priority: v }))}>
            <SelectTrigger className="w-full sm:w-[150px]"><SelectValue placeholder="All priorities" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All priorities</SelectItem>
              {ticketPriorities.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.labelId} onValueChange={(v) => setFilters((f) => ({ ...f, labelId: v }))}>
            <SelectTrigger className="w-full sm:w-[150px]"><SelectValue placeholder="All labels" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All labels</SelectItem>
              {(labels.data ?? []).map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color ?? "#94A3B8" }} />
                    {l.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={filters.onlyMine ? "default" : "outline"}
            size="sm"
            onClick={() => setFilters((f) => ({ ...f, onlyMine: !f.onlyMine }))}
          >
            Assigned to me
          </Button>
          {/* Sits with the filters it saves, not in the header — the thing being named is what is
              on this row. Renders nothing at all when planning is off. */}
          <SavedViewsBar viewMode={viewMode} filters={filters} onApply={setFilters} />
        </CardContent>
      </Card>

      {viewMode === "board" && (
        <Card>
          <CardContent className="p-3">
            {tickets.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <TicketKanban tickets={tickets.data ?? []} onOpenTicket={openTicket} />
            )}
          </CardContent>
        </Card>
      )}

      {viewMode === "timeline" && (
        <Card>
          <CardContent className="grid gap-3 p-3">
            <TimelineLegend
              zoom={timelineZoom}
              onZoom={setTimelineZoom}
              showBaseline={showBaseline}
              onToggleBaseline={() => setShowBaseline((v) => !v)}
              showCriticalOnly={criticalOnly}
              onToggleCritical={() => setCriticalOnly((v) => !v)}
              showUnscheduled={showUnscheduled}
              onToggleUnscheduled={() => setShowUnscheduled((v) => !v)}
              unscheduledCount={
                timelineQuery.data ? timelineQuery.data.items.length - scheduledItemIds(timelineQuery.data.items).size : 0
              }
              violationCount={timelineQuery.data?.violations.length ?? 0}
            />
            {timelineQuery.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : timelineQuery.data ? (
              <PlanTimeline
                data={timelineQuery.data}
                dependencies={timelineDeps.data ?? []}
                zoom={timelineZoom}
                canEdit={canEditPlan}
                showBaseline={showBaseline}
                showCriticalOnly={criticalOnly}
                showUnscheduled={showUnscheduled}
                onOpenItem={openTicket}
              />
            ) : null}
          </CardContent>
        </Card>
      )}

      {viewMode === "calendar" && (
        <Card>
          <CardContent className="p-3">
            {calendarQuery.isLoading ? (
              <Skeleton className="h-96 w-full" />
            ) : (
              <PlanCalendar
                items={calendarQuery.data ?? []}
                year={calendarMonth.year}
                month={calendarMonth.month}
                onMonthChange={(year, month) => setCalendarMonth({ year, month })}
                onOpenItem={openTicket}
              />
            )}
          </CardContent>
        </Card>
      )}

      {viewMode === "list" && (
      <Card>
        <CardContent className="p-0">
          {/* Mobile card list — a 9-column table has no readable layout below ~sm; a phone user
              scrolling it sideways sees 1-2 columns at a time with no context. This renders the
              exact same row data as self-contained cards instead, `sm:hidden` (the table below
              takes over at sm+ with `hidden sm:block`) — see docs/ROADMAP.md's backlog note on
              "wide-table -> mobile card-view fallback". */}
          <div className="grid gap-2 p-3 sm:hidden">
            {tickets.isLoading &&
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={`skel-card-${i}`} className="h-24 w-full" />)}
            {!tickets.isLoading &&
              (tickets.data ?? []).map((row: TicketRow) => {
                const TypeIcon = iconForType(row.type);
                const overdue = Boolean(row.slaBreachAt);
                const avatarSrc = fileUrl(row.assignee?.avatarUrl);
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => openTicket(row.id)}
                    className="grid gap-2 rounded-lg border border-border bg-card p-3 text-left text-sm shadow-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{row.key}</span>
                      <div className="flex items-center gap-1.5">
                        {row.source === "EMAIL" && <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        <Badge variant={PRIORITY_VARIANT[row.priority]}>{row.priority}</Badge>
                        <Badge variant={STATUS_VARIANT[row.status]}>{row.status.replace("_", " ")}</Badge>
                      </div>
                    </div>
                    <p className="truncate font-medium leading-snug">{row.title}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><TypeIcon className="h-3.5 w-3.5" />{row.type}</span>
                      <span className="truncate">{row.project.name}</span>
                      {overdue ? (
                        <span className="inline-flex items-center gap-1 font-semibold text-destructive">
                          <AlertTriangle className="h-3.5 w-3.5" />Overdue
                        </span>
                      ) : (
                        row.dueAt && <span>Due {formatDate(row.dueAt)}</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-wrap gap-1">
                        {row.labels.slice(0, 3).map((tl) => (
                          <span
                            key={tl.id}
                            className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium"
                          >
                            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tl.label.color ?? "#94A3B8" }} />
                            {tl.label.name}
                          </span>
                        ))}
                      </div>
                      {row.assignee ? (
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Avatar className="h-6 w-6">
                            {avatarSrc ? <AvatarImage src={avatarSrc} alt={row.assignee.name} /> : null}
                            <AvatarFallback className="text-[10px]">{initialsFor(row.assignee.name)}</AvatarFallback>
                          </Avatar>
                          <span className="truncate text-xs">{row.assignee.name}</span>
                        </div>
                      ) : (
                        <span className="shrink-0 text-xs text-muted-foreground">Unassigned</span>
                      )}
                    </div>
                  </button>
                );
              })}
            {!tickets.isLoading && (tickets.data ?? []).length === 0 && (
              <p className="py-12 text-center text-sm text-muted-foreground">No tickets match these filters yet.</p>
            )}
          </div>

          <div className="hidden p-3 sm:block">
            <DataTable
              columns={ticketColumns}
              data={tickets.data ?? []}
              isLoading={tickets.isLoading}
              onRowClick={(row) => openTicket(row.id)}
              searchPlaceholder="Search these results..."
              emptyMessage="No tickets match these filters yet."
              pageSize={20}
            />
          </div>
        </CardContent>
      </Card>
      )}

      <CreateTicketDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projects={projects.data ?? []}
        onCreated={(ticket) => {
          queryClient.invalidateQueries({ queryKey: ["tickets"] });
          openTicket(ticket.id);
        }}
      />

      <TicketDetailSheet ticketId={openId} onClose={closeTicket} onOpenTicket={openTicket} />
    </div>
  );
}

function CreateTicketDialog({
  open,
  onOpenChange,
  projects,
  onCreated
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: any[];
  onCreated: (ticket: TicketDetail) => void;
}) {
  const [draft, setDraft] = useState({
    projectId: "",
    moduleId: "",
    type: "BUG",
    title: "",
    description: "",
    priority: "MEDIUM" as TicketPriority,
    assigneeId: ""
  });
  const [suggestion, setSuggestion] = useState<AITriageSuggestion | null>(null);
  const [duplicates, setDuplicates] = useState<AIDuplicateMatch[]>([]);
  const [aiConfidence, setAiConfidence] = useState<number | null>(null);
  const [autoApplied, setAutoApplied] = useState(false);
  // "Auto-apply triage suggestions" (Workspace Settings -> AI) -- when on, pre-fill the
  // suggestion directly instead of showing an accept/dismiss chip. Fields stay editable either
  // way; this only changes whether a click is required before they're filled in.
  // Reads the auth-safe `/settings/effective-flags` projection, NOT `/settings/ai` — this dialog
  // is used by every role including EMPLOYEE, and the full AI settings route is super-admin-only.
  const workspaceFlags = useQuery({
    queryKey: ["settings", "effective-flags"],
    queryFn: settingsApi.getEffectiveFlags,
    staleTime: 60_000
  });

  const selectedProject = projects.find((p: any) => p.id === draft.projectId);
  const members = useQuery({
    queryKey: ["project-assignments", draft.projectId],
    queryFn: () => projectApi.assignments(draft.projectId),
    enabled: Boolean(draft.projectId)
  });
  const ticketTypesQuery = useQuery({ queryKey: ["ticket-types"], queryFn: () => ticketTypeApi.list() });
  const assigneeSuggestions = useQuery({
    // Deliberately NOT keyed on draft.title — the ranking never depends on it, and refetching
    // (and re-spending an AI call) on every keystroke would be wasteful. The title is still
    // read at call time as best-effort context for the AI narration, just not a trigger to
    // re-fetch.
    queryKey: ["ticket-suggest-assignee", draft.projectId, draft.moduleId],
    queryFn: () => ticketApi.suggestAssignee(draft.projectId, draft.moduleId || undefined, draft.title || undefined),
    enabled: Boolean(draft.projectId) && !draft.assigneeId
  });

  function resetDraft() {
    setDraft({ projectId: "", moduleId: "", type: "BUG", title: "", description: "", priority: "MEDIUM", assigneeId: "" });
    setSuggestion(null);
    setDuplicates([]);
    setAiConfidence(null);
    setAutoApplied(false);
  }

  const create = useMutation({
    mutationFn: (faceVerificationId?: string) =>
      ticketApi.create({
        projectId: draft.projectId,
        moduleId: draft.moduleId || undefined,
        type: draft.type,
        title: draft.title,
        description: draft.description || undefined,
        priority: draft.priority,
        assigneeId: draft.assigneeId || undefined,
        aiConfidence: aiConfidence ?? undefined,
        // Single-use proof of a live identity check; only sent when the workspace policy
        // covers this user. The server independently decides whether it was required.
        ...(faceVerificationId ? { faceVerificationId } : {})
      }),
    onSuccess: (ticket) => {
      toast.success("Ticket created", { description: ticket.key });
      resetDraft();
      onOpenChange(false);
      onCreated(ticket);
    },
    onError: (err: any) => toast.error("Could not create ticket", { description: serverMessage(err, "Try again.") })
  });

  // Face (identity) verification, when the workspace requires it for ticket creation.
  const faceStatus = useFaceStatus();
  const [faceDialogOpen, setFaceDialogOpen] = useState(false);
  const requestCreate = () => {
    if (faceStatus.data?.requiredForTicket) {
      setFaceDialogOpen(true);
      return;
    }
    create.mutate(undefined);
  };

  const aiAssist = useMutation({
    mutationFn: async () => {
      const [triage, dup] = await Promise.allSettled([
        aiApi.suggestTriage({ projectId: draft.projectId, title: draft.title, description: draft.description || undefined }),
        aiApi.findDuplicates({ projectId: draft.projectId, title: draft.title, description: draft.description || undefined })
      ]);
      return {
        triage: triage.status === "fulfilled" ? triage.value : null,
        matches: dup.status === "fulfilled" ? dup.value.matches : [],
        error: triage.status === "rejected" ? triage.reason : dup.status === "rejected" ? dup.reason : null
      };
    },
    onSuccess: (result) => {
      setDuplicates(result.matches);
      if (result.triage && workspaceFlags.data?.autoTriageAutoApply) {
        setDraft((d) => ({ ...d, type: result.triage!.type, priority: result.triage!.priority, moduleId: result.triage!.moduleId ?? d.moduleId }));
        setAiConfidence(result.triage.confidence);
        setSuggestion(null);
        setAutoApplied(true);
      } else {
        setSuggestion(result.triage);
        setAutoApplied(false);
      }
      if (!result.triage && result.matches.length === 0 && result.error) {
        toast.error("AI assist unavailable", { description: serverMessage(result.error, "AI may be disabled for this workspace.") });
      }
    }
  });

  // Refinement is offered per field and never lands on its own — see components/AiRefine.tsx.
  const refineTitle = useAiRefine({
    field: "ticket_title",
    label: "title",
    value: draft.title,
    onChange: (next) => setDraft((d) => ({ ...d, title: next }))
  });
  const refineDescription = useAiRefine({
    field: "ticket_description",
    label: "description",
    value: draft.description,
    onChange: (next) => setDraft((d) => ({ ...d, description: next }))
  });

  function acceptSuggestion() {
    if (!suggestion) return;
    setDraft((d) => ({ ...d, type: suggestion.type, priority: suggestion.priority, moduleId: suggestion.moduleId ?? d.moduleId }));
    setAiConfidence(suggestion.confidence);
    setSuggestion(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(95vw,560px)] max-w-none">
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>Raise a bug, task, or improvement against a project.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Project</Label>
              <Select
                value={draft.projectId}
                onValueChange={(v) => setDraft((d) => ({ ...d, projectId: v, moduleId: "", assigneeId: "" }))}
              >
                <SelectTrigger><SelectValue placeholder="Select project" /></SelectTrigger>
                <SelectContent>
                  {projects.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Module <span className="text-muted-foreground">(optional)</span></Label>
              <Select value={draft.moduleId} onValueChange={(v) => setDraft((d) => ({ ...d, moduleId: v }))} disabled={!selectedProject}>
                <SelectTrigger><SelectValue placeholder={selectedProject ? "Optional" : "Pick a project first"} /></SelectTrigger>
                <SelectContent>
                  {selectedProject?.modules?.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Title</Label>
              <AiRefineTrigger state={refineTitle} />
            </div>
            <Input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} placeholder="Short, specific summary" />
            <AiRefinePanel state={refineTitle} />
          </div>
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Description <span className="text-muted-foreground">(optional)</span></Label>
              <AiRefineTrigger state={refineDescription} />
            </div>
            <RichTextEditor
              value={draft.description}
              onChange={(html) => setDraft((d) => ({ ...d, description: html }))}
              placeholder="Steps to reproduce, expected vs actual, context..."
              minHeight="min-h-28"
              ariaLabel="Ticket description"
            />
            <AiRefinePanel state={refineDescription} />
          </div>

          <div className="flex items-center justify-between rounded-md border border-dashed border-border px-3 py-2">
            <p className="text-xs text-muted-foreground">Let AI suggest type, priority, and module — and flag likely duplicates.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => aiAssist.mutate()}
              disabled={!draft.projectId || draft.title.trim().length < 3 || aiAssist.isPending}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {/* Gradient only while pressable — a transparent-fill label fights the disabled
                  dimming, the same call AiRefine's trigger makes. */}
              <span className={!draft.projectId || draft.title.trim().length < 3 || aiAssist.isPending ? undefined : "ai-gradient-text"}>
                AI assist
              </span>
            </Button>
          </div>

          {aiAssist.isPending && <AiStrands label="Reading the title and description…" />}

          {suggestion && (
            <div className="grid gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
              <div className="flex items-center gap-1.5 font-semibold text-primary"><Sparkles className="h-3.5 w-3.5" />AI suggestion</div>
              <p>
                Type <span className="font-semibold">{suggestion.type}</span>, priority{" "}
                <span className="font-semibold">{suggestion.priority}</span>
                {suggestion.moduleId &&
                  (() => {
                    const moduleName = selectedProject?.modules?.find((m: any) => m.id === suggestion.moduleId)?.name;
                    return moduleName ? (
                      <>
                        , module <span className="font-semibold">{moduleName}</span>
                      </>
                    ) : null;
                  })()}
                {" — "}
                {Math.round(suggestion.confidence * 100)}% confidence
              </p>
              <p className="text-xs text-muted-foreground">{suggestion.reasoning}</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={acceptSuggestion}>Accept</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setSuggestion(null)}>Dismiss</Button>
              </div>
            </div>
          )}

          {autoApplied && aiConfidence !== null && (
            <div className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              Type/priority auto-applied by AI ({Math.round(aiConfidence * 100)}% confidence) — edit the fields above if it got something wrong.
            </div>
          )}

          {duplicates.length > 0 && (
            <div className="grid gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <div className="flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />Possible duplicates
              </div>
              {duplicates.map((m) => (
                <p key={m.ticketId} className="text-xs text-muted-foreground">
                  <span className="font-mono text-foreground">{m.key}</span> — {Math.round(m.likelihood * 100)}% likely: {m.reasoning}
                </p>
              ))}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>Type</Label>
              <Select value={draft.type} onValueChange={(v) => setDraft((d) => ({ ...d, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(ticketTypesQuery.data ?? []).map((t) => <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Priority</Label>
              <Select value={draft.priority} onValueChange={(v) => setDraft((d) => ({ ...d, priority: v as TicketPriority }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ticketPriorities.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Assignee <span className="text-muted-foreground">(optional)</span></Label>
              <Select value={draft.assigneeId} onValueChange={(v) => setDraft((d) => ({ ...d, assigneeId: v }))} disabled={!selectedProject}>
                <SelectTrigger><SelectValue placeholder={selectedProject ? "Unassigned" : "Pick a project first"} /></SelectTrigger>
                <SelectContent>
                  {(members.data ?? []).map((a: any) => <SelectItem key={a.userId} value={a.userId}>{a.user.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {!draft.assigneeId && (assigneeSuggestions.data?.suggestions.length ?? 0) > 0 && (
            <div className="grid gap-1.5 rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 font-semibold text-primary"><Sparkles className="h-3 w-3" />Suggested:</span>
                {assigneeSuggestions.data!.suggestions.map((s) => (
                  <button
                    key={s.userId}
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, assigneeId: s.userId }))}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 font-medium transition hover:border-primary hover:text-primary"
                  >
                    {s.name}
                    <span className="text-muted-foreground">({s.openTicketCount} open, {s.resolvedHereCount} resolved here)</span>
                  </button>
                ))}
              </div>
              {/* AI narration of the ranking above (assigneeSuggestionAiEnabled) — explains, never
                  re-ranks. Absent when the toggle is off, budget's exhausted, or no title was
                  typed yet for context. */}
              {assigneeSuggestions.data!.narrative && (
                <p className="text-muted-foreground">{assigneeSuggestions.data!.narrative}</p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              resetDraft();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={requestCreate} disabled={!draft.projectId || draft.title.trim().length < 3 || create.isPending}>
            <Plus className="h-4 w-4" />Create ticket
          </Button>
        </DialogFooter>
      </DialogContent>

      <FaceVerificationDialog
        open={faceDialogOpen}
        onOpenChange={setFaceDialogOpen}
        context="TICKET"
        actionLabel="create this ticket"
        onVerified={(verificationId) => create.mutate(verificationId)}
      />
    </Dialog>
  );
}

function TicketDetailSheet({
  ticketId,
  onClose,
  onOpenTicket
}: {
  ticketId: string | null;
  onClose: () => void;
  onOpenTicket: (id: string) => void;
}) {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  // Cached by the shared hook, so asking again here costs nothing and keeps this sheet honest
  // about which tabs the workspace actually has.
  const { features: planFeatures } = usePlanningFeatures();
  const canAssign = Boolean(
    user?.permissions.includes(permissions.TICKETS_ASSIGN) || user?.permissions.includes(permissions.TICKETS_MANAGE)
  );
  const canReopen = canAssign || user?.role === "SUPER_ADMIN" || user?.role === "ADMIN";

  const detail = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => ticketApi.get(ticketId as string),
    enabled: Boolean(ticketId)
  });

  const members = useQuery({
    queryKey: ["project-assignments", detail.data?.project.id],
    queryFn: () => projectApi.assignments(detail.data!.project.id),
    enabled: Boolean(detail.data?.project.id)
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
    queryClient.invalidateQueries({ queryKey: ["tickets"] });
  }

  const statusMutation = useMutation({
    mutationFn: ({ status, faceVerificationId }: { status: TicketStatus; faceVerificationId?: string }) =>
      ticketApi.updateStatus(ticketId as string, status, faceVerificationId),
    onSuccess: () => {
      toast.success("Status updated");
      invalidate();
    },
    onError: (err: any) => toast.error("Could not update status", { description: serverMessage(err, "Try again.") })
  });

  // Face (identity) verification for status transitions — same requireForTicket policy that
  // covers creation. The chosen status is parked while the check runs, then submitted with the
  // verification id; also triggered reactively when the server answers 428 (policy changed
  // after this page loaded — the server is the authority, not the cached status query).
  const faceStatus = useFaceStatus();
  const [pendingStatus, setPendingStatus] = useState<TicketStatus | null>(null);
  const requestStatusChange = (status: TicketStatus) => {
    if (faceStatus.data?.requiredForTicket) {
      setPendingStatus(status);
      return;
    }
    statusMutation.mutate({ status });
  };

  const assignMutation = useMutation({
    mutationFn: (assigneeId: string | null) => ticketApi.assign(ticketId as string, assigneeId),
    onSuccess: () => {
      toast.success("Assignee updated");
      invalidate();
    },
    onError: (err: any) => toast.error("Could not assign", { description: serverMessage(err, "Try again.") })
  });

  const watchMutation = useMutation({
    mutationFn: (watching: boolean) =>
      watching ? ticketApi.watchers.remove(ticketId as string, user!.id) : ticketApi.watchers.add(ticketId as string),
    onSuccess: () => invalidate(),
    onError: (err: any) => toast.error("Could not update watch status", { description: serverMessage(err, "Try again.") })
  });

  const allLabels = useQuery({ queryKey: ["labels"], queryFn: labelApi.list });
  const addLabelMutation = useMutation({
    mutationFn: (labelId: string) => ticketApi.labels.add(ticketId as string, labelId),
    onSuccess: () => invalidate(),
    onError: (err: any) => toast.error("Could not add label", { description: serverMessage(err, "Try again.") })
  });
  const removeLabelMutation = useMutation({
    mutationFn: (labelId: string) => ticketApi.labels.remove(ticketId as string, labelId),
    onSuccess: () => invalidate(),
    onError: (err: any) => toast.error("Could not remove label", { description: serverMessage(err, "Try again.") })
  });

  if (!ticketId) return null;
  const ticket = detail.data;
  const TypeIcon = ticket ? iconForType(ticket.type) : TicketIcon;
  const isWatching = Boolean(ticket && user && ticket.watchers.some((w) => w.userId === user.id));
  const allowedNext = ticket
    ? ticketStatusTransitions[ticket.status].filter((s) => !(ticket.status === "CLOSED" && s === "REOPENED" && !canReopen))
    : [];

  return (
    <Sheet open={Boolean(ticketId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {/* Radix requires a title WHENEVER the sheet is open — including the loading phase
            before `ticket` exists, which is exactly when the visible SheetTitle below hasn't
            rendered yet (this was the source of the recurring DialogTitle console warning).
            Unmounts once the real title takes over, so there's never a duplicate. */}
        {!ticket && <SheetTitle className="sr-only">{detail.isLoading ? "Loading ticket" : "Ticket details"}</SheetTitle>}
        {/* Always mounted, unlike the title above: the visible header never carries a description,
            so without this Radix warns on every open and a screen-reader user hears the ticket key
            with no indication of what the panel actually offers. */}
        <SheetDescription className="sr-only">
          Full details for this ticket — description, comments, activity, linked work and attachments.
        </SheetDescription>
        {detail.isLoading && (
          <div className="grid gap-3 pt-6">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
        {ticket && (
          <>
            <SheetHeader>
              <div className="text-xs font-mono text-muted-foreground">{ticket.key}</div>
              <SheetTitle className="flex items-start gap-2 text-xl">
                <TypeIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 break-words">{ticket.title}</span>
              </SheetTitle>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant={PRIORITY_VARIANT[ticket.priority]}>{ticket.priority}</Badge>
                <Badge variant={STATUS_VARIANT[ticket.status]}>{ticket.status.replace("_", " ")}</Badge>
                {ticket.slaBreachAt && (
                  <Badge variant="destructive"><AlertTriangle className="mr-1 h-3 w-3" />SLA breached</Badge>
                )}
                {ticket.identityVerified && (
                  /* The trust mark this feature exists to produce: the last action on this
                     ticket that demanded a face check passed one. */
                  <Badge
                    variant="success"
                    title={ticket.identityVerifiedAt ? `Identity confirmed ${new Date(ticket.identityVerifiedAt).toLocaleString()}` : undefined}
                  >
                    <ShieldCheck className="mr-1 h-3 w-3" />Identity verified
                  </Badge>
                )}
              </div>
            </SheetHeader>

            <div className="grid gap-5 py-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label className="text-xs uppercase text-muted-foreground">Status</Label>
                  <Select
                    value={ticket.status}
                    onValueChange={(v) => requestStatusChange(v as TicketStatus)}
                    disabled={statusMutation.isPending}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ticket.status}>{ticket.status.replace("_", " ")} (current)</SelectItem>
                      {allowedNext.map((s) => <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs uppercase text-muted-foreground">Assignee</Label>
                  {canAssign ? (
                    <Select
                      value={ticket.assignee?.id ?? "unassigned"}
                      onValueChange={(v) => assignMutation.mutate(v === "unassigned" ? null : v)}
                      disabled={assignMutation.isPending}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unassigned">Unassigned</SelectItem>
                        {(members.data ?? []).map((a: any) => <SelectItem key={a.userId} value={a.userId}>{a.user.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm">{ticket.assignee?.name ?? "Unassigned"}</p>
                  )}
                </div>
              </div>

              <div className="grid gap-1 text-sm text-muted-foreground">
                <p>Project: <span className="font-medium text-foreground">{ticket.project.name}</span>{ticket.module ? ` / ${ticket.module.name}` : ""}</p>
                <p>Reporter: <span className="font-medium text-foreground">{ticket.reporter.name}</span></p>
                <p>Due: <span className={ticket.slaBreachAt ? "font-semibold text-destructive" : "font-medium text-foreground"}>{formatDate(ticket.dueAt)}</span></p>
              </div>

              <div className="grid gap-1.5">
                <Label className="text-xs uppercase text-muted-foreground">Labels</Label>
                <div className="flex flex-wrap items-center gap-2">
                  {ticket.labels.map((tl) => (
                    <span key={tl.id} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tl.label.color ?? "#94A3B8" }} />
                      {tl.label.name}
                      <button
                        type="button"
                        onClick={() => removeLabelMutation.mutate(tl.labelId)}
                        className="ml-0.5 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {(allLabels.data ?? []).filter((l) => !ticket.labels.some((tl) => tl.labelId === l.id)).length > 0 && (
                    <Select value="" onValueChange={(v) => addLabelMutation.mutate(v)}>
                      <SelectTrigger className="h-7 w-[140px] text-xs"><SelectValue placeholder="+ Add label" /></SelectTrigger>
                      <SelectContent>
                        {(allLabels.data ?? [])
                          .filter((l) => !ticket.labels.some((tl) => tl.labelId === l.id))
                          .map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                  {ticket.labels.length === 0 && (allLabels.data ?? []).length === 0 && (
                    <span className="text-xs text-muted-foreground">No labels created yet — add some in Workspace Settings.</span>
                  )}
                </div>
              </div>

              {ticket.description && (
                <div className="prose-sm rounded-md border border-border bg-muted/30 p-3" dangerouslySetInnerHTML={safeHtml(ticket.description)} />
              )}

              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div className="flex -space-x-2">
                  {ticket.watchers.slice(0, 6).map((w) => (
                    <Avatar key={w.userId} className="h-9 w-9 ring-2 ring-background">
                      <AvatarFallback className="text-[10px]">{initialsFor(w.user.name)}</AvatarFallback>
                    </Avatar>
                  ))}
                  {ticket.watchers.length === 0 && <span className="text-xs text-muted-foreground">No watchers yet</span>}
                </div>
                <Button size="sm" variant="outline" onClick={() => watchMutation.mutate(isWatching)} disabled={watchMutation.isPending}>
                  {isWatching ? (
                    <><EyeOff className="h-3.5 w-3.5" />Unwatch</>
                  ) : (
                    <><Eye className="h-3.5 w-3.5" />Watch</>
                  )}
                </Button>
              </div>

              <Tabs defaultValue="comments" className="grid gap-3">
                <TabsList>
                  <TabsTrigger value="comments"><MessageSquare className="h-3.5 w-3.5" />Comments ({ticket.comments.length})</TabsTrigger>
                  <TabsTrigger value="checklist"><CheckSquare className="h-3.5 w-3.5" />Checklist ({ticket.checklistItems.length})</TabsTrigger>
                  {/* Gated on the same flags the panels themselves check. The panels degrade to a
                      "this is off" explainer, which is right when planning is ON but a sub-feature
                      is not — it tells an admin where the switch lives. It is wrong here: a
                      workspace that never enabled any of this would grow two tabs on the most-used
                      screen in the product, advertising features it does not have, on every ticket. */}
                  {planFeatures.planning && (
                    <TabsTrigger value="plan"><CalendarRange className="h-3.5 w-3.5" />Plan</TabsTrigger>
                  )}
                  {planFeatures.approvals && (
                    <TabsTrigger value="approvals"><ShieldCheck className="h-3.5 w-3.5" />Approvals</TabsTrigger>
                  )}
                  {planFeatures.proofing && (
                    <TabsTrigger value="proofing"><MessageSquarePlus className="h-3.5 w-3.5" />Proofing</TabsTrigger>
                  )}
                  <TabsTrigger value="links"><Link2 className="h-3.5 w-3.5" />Linked ({ticket.links.length})</TabsTrigger>
                  <TabsTrigger value="attachments"><Paperclip className="h-3.5 w-3.5" />Files ({ticket.attachments.length})</TabsTrigger>
                  <TabsTrigger value="time"><TimerReset className="h-3.5 w-3.5" />Time logged</TabsTrigger>
                  <TabsTrigger value="dev"><GitBranch className="h-3.5 w-3.5" />Dev ({ticket.branches.length})</TabsTrigger>
                  <TabsTrigger value="security"><ShieldAlert className="h-3.5 w-3.5" />Security</TabsTrigger>
                  <TabsTrigger value="lineage"><Waypoints className="h-3.5 w-3.5" />Lineage</TabsTrigger>
                  <TabsTrigger value="activity"><ScrollText className="h-3.5 w-3.5" />Activity</TabsTrigger>
                </TabsList>
                <TabsContent value="comments">
                  <CommentsPanel ticketId={ticket.id} comments={ticket.comments} onPosted={invalidate} />
                </TabsContent>
                <TabsContent value="checklist">
                  <ChecklistPanel ticketId={ticket.id} items={ticket.checklistItems} onChanged={invalidate} />
                </TabsContent>
                <TabsContent value="plan">
                  <TicketPlanningPanel ticket={ticket} />
                </TabsContent>

                <TabsContent value="approvals">
                  <TicketApprovalsPanel ticketId={ticket.id} />
                </TabsContent>

                <TabsContent value="proofing">
                  <ProofingPanel attachments={ticket.attachments} />
                </TabsContent>

                <TabsContent value="links">
                  <LinksPanel ticketId={ticket.id} links={ticket.links} onChanged={invalidate} onOpenTicket={onOpenTicket} />
                </TabsContent>
                <TabsContent value="attachments">
                  <AttachmentsPanel ticketId={ticket.id} attachments={ticket.attachments} onChanged={invalidate} />
                </TabsContent>
                <TabsContent value="time">
                  <TimeLoggedPanel timesheets={ticket.timesheets} />
                </TabsContent>
                <TabsContent value="dev">
                  <BranchesPanel ticketId={ticket.id} branches={ticket.branches} onChanged={invalidate} />
                </TabsContent>
                <TabsContent value="security">
                  <SecurityPanel ticketId={ticket.id} />
                </TabsContent>
                <TabsContent value="lineage">
                  <LineagePanel ticketId={ticket.id} />
                </TabsContent>
                <TabsContent value="activity">
                  <ActivityPanel ticketId={ticket.id} />
                </TabsContent>
              </Tabs>
            </div>
          </>
        )}
      </SheetContent>

      <FaceVerificationDialog
        open={pendingStatus !== null}
        onOpenChange={(open) => !open && setPendingStatus(null)}
        context="TICKET"
        actionLabel="change this ticket's status"
        onVerified={(verificationId) => {
          const status = pendingStatus;
          setPendingStatus(null);
          if (status) statusMutation.mutate({ status, faceVerificationId: verificationId });
        }}
      />
    </Sheet>
  );
}

function CommentsPanel({
  ticketId,
  comments,
  onPosted
}: {
  ticketId: string;
  comments: TicketComment[];
  onPosted: () => void;
}) {
  const [body, setBody] = useState("");
  const [showSummary, setShowSummary] = useState(false);
  const post = useMutation({
    mutationFn: () => ticketApi.comments.add(ticketId, body),
    onSuccess: () => {
      setBody("");
      onPosted();
    },
    onError: (err: any) => toast.error("Could not post comment", { description: serverMessage(err, "Try again.") })
  });
  const summarize = useMutation({
    mutationFn: () => aiApi.summarizeTicket(ticketId),
    onError: (err: any) => toast.error("Could not summarize", { description: serverMessage(err, "AI may be disabled for this workspace.") })
  });
  const refineComment = useAiRefine({ field: "ticket_comment", label: "comment", value: body, onChange: setBody });
  const plainLength = body.replace(/<[^>]+>/g, "").trim().length;

  return (
    <div className="grid gap-3">
      {comments.length > 0 && (
        <div className="rounded-md border border-border">
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
            onClick={() => {
              const next = !showSummary;
              setShowSummary(next);
              if (next && !summarize.data && !summarize.isPending) summarize.mutate();
            }}
          >
            <span className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /><span className="ai-gradient-text">AI summary</span></span>
            <span>{showSummary ? "Hide" : "Show"}</span>
          </button>
          {showSummary && (
            <div className="border-t border-border p-3 text-sm">
              {summarize.isPending && <AiStrands label="Reading the thread…" />}
              {summarize.data && <p>{summarize.data.summary}</p>}
              {summarize.isError && (
                <p className="text-xs text-destructive">{serverMessage(summarize.error, "Could not generate a summary.")}</p>
              )}
            </div>
          )}
        </div>
      )}
      <ScrollArea className="max-h-72 rounded-md border border-border">
        <div className="grid gap-3 p-3">
          {comments.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No comments yet.</p>}
          {comments.map((c) => (
            <div key={c.id} className="grid gap-1 rounded-md bg-muted/30 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{c.author.name}</span>
                <span>{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <div className="prose-sm text-sm" dangerouslySetInnerHTML={safeHtml(c.body)} />
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="flex items-center justify-end">
        <AiRefineTrigger state={refineComment} />
      </div>
      <RichTextEditor value={body} onChange={setBody} placeholder="Add a comment..." minHeight="min-h-20" ariaLabel="New comment" />
      <AiRefinePanel state={refineComment} />
      <Button size="sm" className="justify-self-end" disabled={plainLength === 0 || post.isPending} onClick={() => post.mutate()}>
        Post comment
      </Button>
    </div>
  );
}

function ChecklistPanel({
  ticketId,
  items,
  onChanged
}: {
  ticketId: string;
  items: TicketChecklistItemRow[];
  onChanged: () => void;
}) {
  const [newLabel, setNewLabel] = useState("");
  const doneCount = items.filter((i) => i.done).length;

  const add = useMutation({
    mutationFn: () => ticketApi.checklist.add(ticketId, newLabel.trim()),
    onSuccess: () => {
      setNewLabel("");
      onChanged();
    },
    onError: (err: any) => toast.error("Could not add item", { description: serverMessage(err, "Try again.") })
  });
  const toggle = useMutation({
    mutationFn: ({ itemId, done }: { itemId: string; done: boolean }) => ticketApi.checklist.update(ticketId, itemId, { done }),
    onSuccess: () => onChanged(),
    onError: (err: any) => toast.error("Could not update item", { description: serverMessage(err, "Try again.") })
  });
  const remove = useMutation({
    mutationFn: (itemId: string) => ticketApi.checklist.remove(ticketId, itemId),
    onSuccess: () => onChanged(),
    onError: (err: any) => toast.error("Could not remove item", { description: serverMessage(err, "Try again.") })
  });
  const reorder = useMutation({
    mutationFn: (itemIds: string[]) => ticketApi.checklist.reorder(ticketId, itemIds),
    onSuccess: () => onChanged(),
    onError: (err: any) => toast.error("Could not reorder", { description: serverMessage(err, "Try again.") })
  });

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const ids = items.map((i) => i.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(ids);
  }

  return (
    <div className="grid gap-3">
      {items.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {doneCount}/{items.length} done
        </p>
      )}
      <div className="grid gap-1.5">
        {items.map((item, index) => (
          <div key={item.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
            <Checkbox checked={item.done} onCheckedChange={(v) => toggle.mutate({ itemId: item.id, done: Boolean(v) })} />
            <span className={`flex-1 text-sm ${item.done ? "text-muted-foreground line-through" : ""}`}>{item.label}</span>
            <div className="flex items-center">
              <Button variant="ghost" size="icon" className="h-9 w-9" disabled={index === 0} onClick={() => move(index, -1)}>
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-9 w-9" disabled={index === items.length - 1} onClick={() => move(index, 1)}>
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => remove.mutate(item.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
        {items.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No checklist items yet.</p>}
      </div>
      <div className="flex gap-2">
        <Input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Add a sub-task..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && newLabel.trim()) add.mutate();
          }}
        />
        <Button size="sm" disabled={!newLabel.trim() || add.isPending} onClick={() => add.mutate()}>
          <Plus className="h-4 w-4" />Add
        </Button>
      </div>
    </div>
  );
}

const LINK_TYPE_LABEL: Record<TicketLinkType, string> = { BLOCKS: "Blocks", DUPLICATE: "Duplicate of", RELATES: "Relates to" };

function LinksPanel({
  ticketId,
  links,
  onChanged,
  onOpenTicket
}: {
  ticketId: string;
  links: TicketLinkRow[];
  onChanged: () => void;
  onOpenTicket: (id: string) => void;
}) {
  const [draft, setDraft] = useState<{ targetKey: string; type: TicketLinkType }>({ targetKey: "", type: "RELATES" });

  const add = useMutation({
    mutationFn: () => ticketApi.links.add(ticketId, draft.targetKey.trim(), draft.type),
    onSuccess: () => {
      setDraft({ targetKey: "", type: "RELATES" });
      onChanged();
    },
    onError: (err: any) => toast.error("Could not link ticket", { description: serverMessage(err, "Check the ticket key and try again.") })
  });
  const remove = useMutation({
    mutationFn: (linkId: string) => ticketApi.links.remove(ticketId, linkId),
    onSuccess: () => onChanged(),
    onError: (err: any) => toast.error("Could not remove link", { description: serverMessage(err, "Try again.") })
  });

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        {links.map((link) => (
          <div key={link.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
            <Badge variant="muted">{link.label}</Badge>
            <button
              type="button"
              className="flex flex-1 items-center gap-1.5 truncate text-left hover:underline"
              onClick={() => onOpenTicket(link.ticket.id)}
            >
              <span className="font-mono text-xs text-muted-foreground">{link.ticket.key}</span>
              <span className="truncate">{link.ticket.title}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
            <Badge variant={STATUS_VARIANT[link.ticket.status]}>{link.ticket.status.replace("_", " ")}</Badge>
            <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => remove.mutate(link.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {links.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No linked tickets yet.</p>}
      </div>
      <div className="flex gap-2">
        <Select value={draft.type} onValueChange={(v) => setDraft((d) => ({ ...d, type: v as TicketLinkType }))}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(LINK_TYPE_LABEL) as TicketLinkType[]).map((t) => (
              <SelectItem key={t} value={t}>{LINK_TYPE_LABEL[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={draft.targetKey}
          onChange={(e) => setDraft((d) => ({ ...d, targetKey: e.target.value }))}
          placeholder="Ticket key (e.g. WEB-12)"
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.targetKey.trim()) add.mutate();
          }}
        />
        <Button size="sm" disabled={!draft.targetKey.trim() || add.isPending} onClick={() => add.mutate()}>
          <Link2 className="h-4 w-4" />Link
        </Button>
      </div>
    </div>
  );
}

const BRANCH_PR_STATUS_VARIANT: Record<TicketBranchPrStatus, BadgeProps["variant"]> = {
  NONE: "muted",
  OPEN: "info",
  MERGED: "success",
  CLOSED: "destructive"
};

/** Repo/branch/PR linking. Manual free-text entry is the baseline (same pattern
 *  SecurityFinding/TestRun already use for repository/branch); when this org has connected
 *  GitHub (Workspace Settings -> Security & DevOps -> Git provider), a "Pick from GitHub"
 *  section fetches live repos/branches/PRs instead, still writing into the same TicketBranch
 *  row — see docs/ROADMAP.md's "Live git-provider App integration" item. */
function BranchesPanel({
  ticketId,
  branches,
  onChanged
}: {
  ticketId: string;
  branches: TicketBranchRow[];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState({ repository: "", branch: "", prUrl: "" });
  const gitStatus = useQuery({ queryKey: ["settings", "git"], queryFn: settingsApi.getGitConnection });
  const [pickerRepo, setPickerRepo] = useState<string>("");
  const repos = useQuery({
    queryKey: ["git", "repos"],
    queryFn: settingsApi.listGitRepos,
    enabled: Boolean(gitStatus.data?.connected)
  });
  const pulls = useQuery({
    queryKey: ["git", "pulls", pickerRepo],
    queryFn: () => settingsApi.listGitPulls(pickerRepo),
    enabled: Boolean(pickerRepo)
  });

  const add = useMutation({
    mutationFn: () =>
      ticketApi.branches.add(ticketId, {
        repository: draft.repository.trim(),
        branch: draft.branch.trim(),
        prUrl: draft.prUrl.trim() || undefined
      }),
    onSuccess: () => {
      setDraft({ repository: "", branch: "", prUrl: "" });
      onChanged();
    },
    onError: (err: any) => toast.error("Could not link branch", { description: serverMessage(err, "Try again.") })
  });
  const update = useMutation({
    mutationFn: ({ branchId, prStatus }: { branchId: string; prStatus: TicketBranchPrStatus }) =>
      ticketApi.branches.update(ticketId, branchId, { prStatus }),
    onSuccess: () => onChanged(),
    onError: (err: any) => toast.error("Could not update status", { description: serverMessage(err, "Try again.") })
  });
  const remove = useMutation({
    mutationFn: (branchId: string) => ticketApi.branches.remove(ticketId, branchId),
    onSuccess: () => onChanged(),
    onError: (err: any) => toast.error("Could not remove branch", { description: serverMessage(err, "Try again.") })
  });
  // Ticket -> git direction: suggests (or, given a repo + a connected GitHub, actually creates)
  // a branch named to match what the push webhook already auto-links back from (see
  // ticket.controller.ts#slugBranchName). Degrades to name-only when no repo is picked yet or
  // GitHub isn't connected — never a hard error either way.
  const autoBranch = useMutation({
    mutationFn: () => ticketApi.branches.auto(ticketId, { repository: pickerRepo || undefined }),
    onSuccess: (result) => {
      if (result.created) {
        toast.success(`Created branch ${result.branch?.branch}`);
        onChanged();
      } else if (result.suggestedName) {
        setDraft((d) => ({ ...d, repository: pickerRepo || d.repository, branch: result.suggestedName! }));
        toast.info("Branch name suggested — pick a repository above to create it for real, or just Link this name.");
      }
    },
    onError: (err: any) => toast.error("Could not create branch", { description: serverMessage(err, "Try again.") })
  });

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        {branches.map((b) => (
          <div key={b.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-xs text-muted-foreground">{b.repository}</span>
            <span className="truncate font-medium">{b.branch}</span>
            {b.prUrl ? (
              <a href={b.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate text-primary hover:underline">
                PR<ArrowUpRight className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">No PR link</span>
            )}
            <Select value={b.prStatus} onValueChange={(v) => update.mutate({ branchId: b.id, prStatus: v as TicketBranchPrStatus })}>
              <SelectTrigger className="ml-auto h-8 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ticketBranchPrStatuses.map((s) => (
                  <SelectItem key={s} value={s}>
                    <Badge variant={BRANCH_PR_STATUS_VARIANT[s]}>{s}</Badge>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => remove.mutate(b.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {branches.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No branches or PRs linked yet.</p>}
      </div>
      {gitStatus.data?.connected && (
        <div className="grid gap-2 rounded-md border border-dashed border-border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pick from GitHub ({gitStatus.data.accountLogin})</p>
          <div className="flex gap-2">
            <Select value={pickerRepo} onValueChange={setPickerRepo}>
              <SelectTrigger className="flex-1"><SelectValue placeholder={repos.isLoading ? "Loading repos…" : "Choose a repository"} /></SelectTrigger>
              <SelectContent>
                {(repos.data ?? []).map((r) => (
                  <SelectItem key={r.fullName} value={r.fullName}>{r.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={!pickerRepo || autoBranch.isPending}
              title="Creates a real branch on GitHub, named to match this ticket, off the repo's default branch"
              onClick={() => autoBranch.mutate()}
            >
              <GitBranch className="h-4 w-4" />Create branch
            </Button>
          </div>
          {pickerRepo && (
            <div className="grid gap-1.5">
              {pulls.isLoading && <p className="text-xs text-muted-foreground">Loading pull requests…</p>}
              {(pulls.data ?? []).map((pr) => (
                <button
                  key={pr.number}
                  type="button"
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                  title="Fills the fields below — click Link to save"
                  onClick={() => setDraft({ repository: pickerRepo, branch: pr.branch, prUrl: pr.url })}
                >
                  <Badge variant={pr.status === "OPEN" ? "info" : pr.status === "MERGED" ? "success" : "muted"}>{pr.status}</Badge>
                  <span className="truncate">#{pr.number} {pr.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{pr.branch}</span>
                </button>
              ))}
              {!pulls.isLoading && (pulls.data ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">No pull requests found for this repository.</p>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={draft.repository}
          onChange={(e) => setDraft((d) => ({ ...d, repository: e.target.value }))}
          placeholder="Repository (e.g. org/repo)"
        />
        <Input
          value={draft.branch}
          onChange={(e) => setDraft((d) => ({ ...d, branch: e.target.value }))}
          placeholder="Branch"
        />
        <Input
          value={draft.prUrl}
          onChange={(e) => setDraft((d) => ({ ...d, prUrl: e.target.value }))}
          placeholder="PR URL (optional)"
        />
        <Button size="sm" disabled={!draft.repository.trim() || !draft.branch.trim() || add.isPending} onClick={() => add.mutate()}>
          <GitBranch className="h-4 w-4" />Link
        </Button>
      </div>
      {!gitStatus.data?.connected && (
        <Button
          size="sm"
          variant="ghost"
          className="justify-self-start text-muted-foreground"
          disabled={autoBranch.isPending}
          title="No GitHub connection — fills a conventional branch name below for you to create by hand"
          onClick={() => autoBranch.mutate()}
        >
          <GitBranch className="h-4 w-4" />Suggest a branch name
        </Button>
      )}
    </div>
  );
}

function AttachmentsPanel({
  ticketId,
  attachments,
  onChanged
}: {
  ticketId: string;
  attachments: TicketAttachmentRow[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<File[]>([]);
  const upload = useMutation({
    mutationFn: () => ticketApi.attachments.upload(ticketId, pending),
    onSuccess: () => {
      setPending([]);
      onChanged();
      toast.success("Uploaded");
    },
    onError: (err: any) => toast.error("Upload failed", { description: serverMessage(err, "Try again.") })
  });
  const remove = useMutation({
    mutationFn: (attachmentId: string) => ticketApi.attachments.remove(ticketId, attachmentId),
    onSuccess: () => onChanged(),
    onError: (err: any) => toast.error("Could not remove file", { description: serverMessage(err, "Try again.") })
  });

  return (
    <div className="grid gap-3">
      <FileDropzone files={pending} onChange={setPending} />
      {pending.length > 0 && (
        <Button size="sm" onClick={() => upload.mutate()} disabled={upload.isPending}>
          Upload {pending.length} file(s)
        </Button>
      )}
      <div className="grid gap-2">
        {attachments.length === 0 && <p className="text-sm text-muted-foreground">No attachments yet.</p>}
        {attachments.map((a) => (
          <div key={a.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
            <a href={fileUrl(a.url)} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">
              {a.fileName}
            </a>
            <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => remove.mutate(a.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TimeLoggedPanel({ timesheets }: { timesheets: TicketTimesheetRow[] }) {
  const total = timesheets.reduce((sum, t) => sum + Number(t.totalHours ?? 0), 0);
  return (
    <div className="grid gap-2">
      {timesheets.length === 0 && <p className="text-sm text-muted-foreground">No time logged against this ticket yet.</p>}
      {timesheets.map((t) => (
        <div key={t.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
          <span>{t.user.name}</span>
          <span className="text-muted-foreground">{String(t.workDate).slice(0, 10)}</span>
          <span className="font-semibold">{Number(t.totalHours).toFixed(2)}h</span>
        </div>
      ))}
      {timesheets.length > 0 && (
        <div className="flex items-center justify-between border-t border-border pt-2 text-sm font-semibold">
          <span>Total</span>
          <span>{total.toFixed(2)}h</span>
        </div>
      )}
    </div>
  );
}

const SEVERITY_VARIANT: Record<SecurityFindingSeverity, BadgeProps["variant"]> = {
  CRITICAL: "destructive",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "muted"
};

const FINDING_TYPE_LABEL: Record<SecurityFindingRow["type"], string> = {
  SAST: "Static analysis (SAST)",
  DAST: "Dynamic analysis (DAST)",
  SSAT: "Secrets scanning (SSAT)",
  SSCT: "Supply-chain testing (SSCT)",
  VAPT: "Penetration test (VAPT)"
};

/** Ingest-only — see docs/ROADMAP.md's "Security assessment suite". Every finding/test-run row
 *  here was POSTed by an external CI/security tool via /api/devops/:orgSlug/*, never generated
 *  by TimeSphere itself; this panel just renders services/security-report.service.ts's output. */
function SecurityPanel({ ticketId }: { ticketId: string }) {
  const report = useQuery({ queryKey: ["ticket", ticketId, "security-report"], queryFn: () => ticketApi.securityReport.get(ticketId) });
  const [downloading, setDownloading] = useState(false);

  async function downloadPdf() {
    setDownloading(true);
    try {
      const blob = await ticketApi.securityReport.downloadPdf(ticketId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${report.data?.ticket.key ?? "ticket"}-security-report.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error("Download failed", { description: serverMessage(err, "Try again.") });
    } finally {
      setDownloading(false);
    }
  }

  if (report.isLoading) return <Skeleton className="h-24 w-full" />;
  const data = report.data;
  if (!data) return <p className="text-sm text-muted-foreground">Could not load the security report.</p>;

  if (data.findings.length === 0 && !data.latestTestRun) {
    return (
      <p className="text-sm text-muted-foreground">
        No findings or test runs have been ingested for this ticket yet. Connect a CI/security tool from{" "}
        <strong>Workspace Settings → Security &amp; DevOps</strong> and reference this ticket's key ({data.ticket.key}) in what it POSTs.
      </p>
    );
  }

  const verdictNeedsAttention = data.riskVerdict.startsWith("Needs attention");

  return (
    <div className="grid gap-3">
      <div className={`flex items-center justify-between rounded-md border px-3 py-2 ${verdictNeedsAttention ? "border-destructive/30 bg-destructive/5" : "border-success/30 bg-success/5"}`}>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className={`h-4 w-4 ${verdictNeedsAttention ? "text-destructive" : "text-success"}`} />
          {data.riskVerdict}
        </div>
        <Button size="sm" variant="outline" onClick={downloadPdf} disabled={downloading}>
          <Download className="h-3.5 w-3.5" />PDF report
        </Button>
      </div>

      {data.latestTestRun && (
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
          <span className="text-muted-foreground">Latest test run ({data.latestTestRun.provider})</span>
          <Badge variant={data.latestTestRun.status === "PASSED" ? "success" : data.latestTestRun.status === "FAILED" ? "destructive" : "info"}>
            {data.latestTestRun.status}
          </Badge>
        </div>
      )}

      {(["SAST", "DAST", "SSAT", "SSCT", "VAPT"] as const).map((type) => {
        const items = data.findingsByType[type] ?? [];
        if (items.length === 0) return null;
        return (
          <div key={type} className="grid gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{FINDING_TYPE_LABEL[type]}</p>
            {items.map((finding) => (
              <div key={finding.id} className="grid gap-0.5 rounded-md border border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <Badge variant={SEVERITY_VARIANT[finding.severity]}>{finding.severity}</Badge>
                  <span className="text-sm font-medium">{finding.title}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{finding.tool}{finding.status !== "OPEN" ? ` · ${finding.status}` : ""}</span>
                </div>
                {finding.filePath && (
                  <p className="text-xs text-muted-foreground">{finding.filePath}{finding.lineNumber ? `:${finding.lineNumber}` : ""}</p>
                )}
                {finding.aiVerdict && (
                  <div className="mt-1 grid gap-0.5 rounded-md border border-dashed border-primary/30 bg-primary/5 px-2.5 py-2 text-xs">
                    <div className="flex items-center gap-1.5 font-semibold text-primary">
                      <Sparkles className="h-3 w-3" />
                      AI triage:{" "}
                      <Badge
                        variant={finding.aiVerdict === "TRUE_POSITIVE" ? "destructive" : finding.aiVerdict === "FALSE_POSITIVE" ? "success" : "warning"}
                        className="text-[10px]"
                      >
                        {finding.aiVerdict === "TRUE_POSITIVE" ? "True positive" : finding.aiVerdict === "FALSE_POSITIVE" ? "Likely false positive" : "Needs review"}
                      </Badge>
                    </div>
                    {finding.aiExploitability && <p className="text-muted-foreground">{finding.aiExploitability}</p>}
                    {finding.aiFixSuggestion && (
                      <p className="text-muted-foreground"><span className="font-medium text-foreground">Fix: </span>{finding.aiFixSuggestion}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const LINEAGE_EVENT_ICON: Record<TicketLineageEvent["type"], typeof GitBranch> = {
  branch_linked: GitBranch,
  pr_status: ArrowUpRight,
  test_run: ListChecks,
  security_finding: ShieldAlert
};
const LINEAGE_TONE_CLASS: Record<TicketLineageEvent["tone"], string> = {
  success: "border-success/30 bg-success/5 text-success",
  failure: "border-destructive/30 bg-destructive/5 text-destructive",
  neutral: "border-border bg-muted/30 text-muted-foreground"
};

/** One merged timeline across branches/PRs, CI runs, and security findings — the same data the
 *  Dev and Security tabs already show, cross-referenced by hand today. Read-only aggregation;
 *  see ticket-lineage.service.ts for why nothing here is a new data source. */
function LineagePanel({ ticketId }: { ticketId: string }) {
  const lineage = useQuery({ queryKey: ["ticket", ticketId, "lineage"], queryFn: () => ticketApi.lineage(ticketId) });

  if (lineage.isLoading) return <Skeleton className="h-32 w-full" />;
  const events = lineage.data?.events ?? [];
  if (events.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Nothing to show yet — link a branch/PR (Dev tab) or connect CI/security ingestion (Workspace Settings → Security &amp; DevOps)
        referencing this ticket's key to build a timeline here.
      </p>
    );
  }

  return (
    <div className="grid gap-1.5">
      {events.map((event, index) => {
        const Icon = LINEAGE_EVENT_ICON[event.type];
        return (
          <div key={index} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${LINEAGE_TONE_CLASS[event.tone]}`}>
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{event.summary}</p>
              {event.detail && <p className="truncate text-xs">{event.detail}</p>}
            </div>
            <span className="shrink-0 text-xs">{new Date(event.at).toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}

function ActivityPanel({ ticketId }: { ticketId: string }) {
  const activity = useQuery({ queryKey: ["ticket", ticketId, "activity"], queryFn: () => ticketApi.activity(ticketId) });
  return (
    <div className="grid gap-2">
      {activity.isLoading && <Skeleton className="h-20 w-full" />}
      {!activity.isLoading && (activity.data ?? []).length === 0 && (
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
      )}
      {(activity.data ?? []).map((entry) => (
        <div key={entry.id} className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground">{entry.actor?.name ?? "System"}</span> —{" "}
            {entry.action.replace("ticket.", "").replace(/_/g, " ")}
          </span>
          <span>{new Date(entry.createdAt).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
