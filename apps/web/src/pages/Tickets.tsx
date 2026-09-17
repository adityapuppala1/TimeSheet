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
  securityFindingTypes,
  securityFindingVerificationLabels,
  ticketBranchPrStatuses,
  ticketPriorities,
  ticketStatusTransitions,
  ticketStatuses,
  type SecurityFindingSeverity,
  type SecurityFindingVerificationState,
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
  UserRound,
  PanelRightClose,
  PanelRightOpen,
  GanttChartSquare,
  GitBranch,
  LayoutGrid,
  Link2,
  BookOpen,
  ListChecks,
  Loader2,
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
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { AiRefinePanel, AiRefineTrigger, useAiRefine } from "../components/AiRefine";
import { PlanCalendar, type CalendarPeriod } from "../components/PlanCalendar";
import { TicketApprovalsPanel } from "../components/TicketApprovalsPanel";
import { ProofingPanel } from "../components/ProofingPanel";
import { SavedViewsBar, type TicketFilters } from "../components/SavedViewsBar";
import { PageHeader } from "../components/PageHeader";
import { TicketCustomFields } from "../components/TicketCustomFields";
import { TicketSprintFields } from "../components/TicketSprintFields";
import { useMediaQuery } from "../lib/use-media-query";
import { SPLIT_MIN_SHEET_WIDTH, canSplit, readActivityHidden, ticketSheetLayout, writeActivityHidden } from "../lib/ticket-sheet-layout";
import { ProjectMark } from "../components/ProjectMark";
import { StatusPill } from "../components/StatusPill";
import { ViewsBar } from "../components/ViewsBar";
import { readProjectSelection, withoutProjectSelection } from "../lib/project-tree";
import { formatGroupLabel, groupRuns } from "../lib/group-rows";
import { applyOptimistic, replaceById, rollbackOptimistic, settleOptimistic } from "../lib/optimistic";
import { cn } from "../lib/utils";
import { draftFor, draftFromFilters, type TicketDraftInitial } from "../lib/ticket-draft";
import { IDENTITY_WASH_ALPHA, resolveIdentityColor } from "../lib/identity-colors";
import { currentTheme, subscribeTheme } from "../lib/theme";
import { useSyncExternalStore } from "react";
import { displayValue, fieldsForTicket } from "../lib/custom-fields";
import { isDefaultColumns, resolveVisibleColumns, type ColumnSpec } from "../lib/table-columns";
import { TicketMetricsPanel } from "../components/TicketMetricsPanel";
import { TicketPlanningPanel } from "../components/TicketPlanningPanel";
import { PlanTimeline, TimelineLegend, scheduledItemIds, type TimelineZoom } from "../components/PlanTimeline";
import { TicketKanban } from "../components/TicketKanban";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge, type BadgeProps } from "../components/ui/badge";
import { AiStrands } from "../components/ui/ai-strands";
import { BorderGlow } from "../components/ui/border-glow";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetMaximizeButton,
  SheetResizeHandle,
  type SheetResizeState,
  SheetTitle,
  useSheetResize
} from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { plainTextLength, safeHtml } from "../lib/safe-html";
import { aiApi, fileUrl, labelApi, planApi, projectApi, requirementsDocApi, settingsApi, ticketApi, type TicketDocumentLinkRow, type TicketLabelRow, ticketTypeApi, type AIDuplicateMatch, type AITriageSuggestion, type SecurityFindingRow, type TicketAttachmentRow, type TicketBranchRow, type TicketChecklistItemRow, type TicketComment, type TicketDetail, type TicketLineageEvent, type TicketLinkRow, type TicketLinkType, type TicketRow, type TicketTimesheetRow , planningApi, type CustomFieldRow, sprintApi } from "../services/api";
import { FaceVerificationDialog } from "../components/FaceVerificationDialog";
import { useFaceStatus } from "../lib/use-face-status";
import { usePlanningFeatures } from "../lib/use-planning";
import { GitHubMark } from "../components/ui/connector-marks";
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

/** Re-exported rather than defined here: the metric tiles above the table need the same palette,
 *  and they live in their own component, so the maps moved to lib/ticket-visuals.ts to avoid a
 *  circular import. TicketKanban.tsx still imports both from this module. */
import { PRIORITY_VARIANT, STATUS_VARIANT, TONE_ACCENT_CLASS, TONE_BORDER_CLASS } from "../lib/ticket-visuals";
export { PRIORITY_VARIANT, STATUS_VARIANT };

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
  {
    id: "serial",
    header: "S.No",
    enableSorting: false,
    enableHiding: false,
    /** Accesses the KEY even though the cell renders a position. Two reasons: the "Search these
     *  results" box filters on accessor values, so without this, replacing the Key column would
     *  have silently broken searching for "HICS-TS-3" — the way people actually look a ticket up;
     *  and the key stays one hover away on the cell below. */
    accessorFn: (row) => row.key,
    /** The row's position in the list as currently sorted and paginated — NOT a stored number.
     *  `row.index` is the index within the sorted model, so re-sorting renumbers rather than
     *  scrambling. The ticket key it replaced is still how the ticket is identified everywhere it
     *  matters (the title tooltip below, the detail sheet, emails, git branches), so nothing that
     *  needs a stable identifier is reading this. */
    cell: ({ row, table }) => {
      // TanStack's row pipeline is core → filtered → sorted → paginated, so the sorted model is
      // every row the search box left in, across ALL pages. The position within it therefore keeps
      // counting onto page 2 instead of restarting at 1, and re-sorting renumbers cleanly.
      const sorted = table.getSortedRowModel().rows.findIndex((r) => r.id === row.id);
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {(sorted === -1 ? row.index : sorted) + 1}
            </span>
          </TooltipTrigger>
          <TooltipContent>{row.original.key}</TooltipContent>
        </Tooltip>
      );
    }
  },
  {
    accessorKey: "title",
    header: "Title",
    enableHiding: false,
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
    cell: (info) => (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <ProjectMark id={info.row.original.project.id} name={info.row.original.project.name} color={info.row.original.project.color} size="xs" />
        {info.getValue()}
      </span>
    )
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
    // The pill is the row's status control (V12 look pass, slice 3). Opening the ticket from the
    // pill's menu goes through the same `?open=` the page reads, so a module-level column def
    // needs no page callback.
    cell: (info) => <StatusPill ticketId={info.row.original.id} status={info.getValue() as TicketStatus} onOpenTicket={openTicketByUrl} />
  },
  {
    id: "files",
    accessorFn: (row) => row._count.attachments,
    header: "Files",
    /** Replaced the Labels column. Sortable on the count so "which of these has evidence attached"
     *  is one click, which is the question the column exists to answer — a bug report with a
     *  screenshot is triaged differently from one without. The labels themselves are unchanged and
     *  still live on the ticket, its detail sheet, and the label filter above this table. */
    cell: ({ row }) => {
      const count = row.original._count.attachments;
      if (count === 0) return <span className="text-xs text-muted-foreground">—</span>;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Paperclip className="h-3.5 w-3.5" />
              {count}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {count} file{count === 1 ? "" : "s"} attached
          </TooltipContent>
        </Tooltip>
      );
    }
  },
  {
    id: "reporter",
    accessorFn: (row) => row.reporter?.name ?? "",
    header: "Raised by",
    cell: ({ row }) => {
      const reporter = row.original.reporter;
      // An email- or chat-sourced ticket's `reporter` is a seeded system account, so the real
      // sender is the external name the intake recorded — showing "Email Intake" for every one of
      // them would make the column useless on exactly the tickets people most want to trace.
      const external = row.original.externalReporterName || row.original.externalReporterEmail;
      const name = external || reporter?.name || "—";
      const avatarSrc = external ? null : fileUrl(reporter?.avatarUrl);
      return (
        <div className="flex items-center gap-2">
          <Avatar className="h-7 w-7">
            {avatarSrc ? <AvatarImage src={avatarSrc} alt={name} /> : null}
            <AvatarFallback className="text-[10px]">{initialsFor(name)}</AvatarFallback>
          </Avatar>
          <span className="truncate text-sm">{name}</span>
        </div>
      );
    }
  },
  {
    accessorKey: "createdAt",
    header: "Created",
    cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.createdAt)}</span>
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
    /* V12 3.17: the sprint as a column, hidden until chosen from Columns. It exists first so the
       table can GROUP by sprint — the group value is read from the column of the same id, and
       until this column existed "Group by Sprint" on desktop put every row under one heading
       (the phone cards, which key off the axis directly, were right all along). */
    id: "sprint",
    accessorFn: (row) => row.sprint?.name ?? "",
    header: "Sprint",
    cell: ({ row }) => (row.original.sprint ? <span className="text-sm">{row.original.sprint.name}</span> : <span className="text-xs text-muted-foreground">Not in a sprint</span>)
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

/** Every filter axis at rest. Also the shape an older saved view is merged over, so a view stored
 *  before an axis existed cannot leave that axis `undefined`. */
export const DEFAULT_TICKET_FILTERS: TicketFilters = {
  projectId: "all",
  moduleId: "all",
  status: "all",
  priority: "all",
  type: "all",
  reporterId: "all",
  onlyMine: false,
  groupBy: "none",
  sprintId: "all"
};

/** The List view's grouping axes, keyed by the DataTable column id they group on. */
export const TICKET_GROUPINGS: ReadonlyArray<{ id: string; label: string; keyOf: (row: TicketRow) => unknown }> = [
  { id: "status", label: "Status", keyOf: (r) => r.status },
  { id: "priority", label: "Priority", keyOf: (r) => r.priority },
  { id: "type", label: "Type", keyOf: (r) => r.type },
  { id: "project", label: "Project", keyOf: (r) => r.project.name },
  { id: "assignee", label: "Assignee", keyOf: (r) => r.assignee?.name ?? null },
  { id: "sprint", label: "Sprint", keyOf: (r) => r.sprint?.name ?? null }
];

/** The page's filter state as the query string both the list and the metrics endpoint take. */
function ticketQueryParams(filters: TicketFilters, userId: string | undefined) {
  // "all" is the UI's word for "no filter"; the API's is an absent parameter.
  const set = (value: string) => (value !== "all" ? value : undefined);
  return {
    projectId: set(filters.projectId),
    moduleId: set(filters.moduleId),
    sprintId: set(filters.sprintId),
    status: set(filters.status),
    priority: set(filters.priority),
    type: set(filters.type),
    reporterId: set(filters.reporterId),
    assigneeId: filters.onlyMine ? userId : undefined
  };
}

/** One table column per active TICKET custom field, reading the `customFields` map the list
 *  endpoint sends. Hidden by default — a table must not widen because an admin added a field —
 *  and switched on from the Columns control, where the choice is saved with the view. */
function customFieldColumns(defs: CustomFieldRow[] | undefined): ColumnDef<TicketRow, any>[] {
  return fieldsForTicket(defs, null).map((f) => ({
    id: `cf_${f.key}`,
    header: f.label,
    // The accessor yields the DISPLAY text, not the raw value. react-table lets a column join the
    // search box only if the FIRST row's value is a string or number; a sparse field is null on
    // row one and the column silently dropped out of searching — found live when "Acme" matched
    // nothing with the Client column on screen. Text also makes the sort read the way the cell does.
    accessorFn: (row: TicketRow) => displayValue(f, row.customFields?.[f.key] ?? null),
    cell: ({ getValue }: { getValue: () => unknown }) => <span className="text-sm">{String(getValue())}</span>,
    enableSorting: true
  }));
}

/** What the Columns control and a saved view reason about: every column, its label, and whether
 *  it starts hidden or cannot be hidden at all. */
function columnSpecs(all: ColumnDef<TicketRow, any>[]): ColumnSpec[] {
  return all.map((c) => {
    const id = c.id ?? String((c as { accessorKey?: string }).accessorKey);
    return { id, label: typeof c.header === "string" ? c.header : id, canHide: c.enableHiding !== false, defaultHidden: id.startsWith("cf_") || id === "sprint" };
  });
}

/** True when every filter axis is at rest — the empty state then means "there are none" rather
 *  than "your filters hid them", and offers no Clear filters button. */
function filtersAtRest(filters: TicketFilters): boolean {
  return (Object.keys(DEFAULT_TICKET_FILTERS) as Array<keyof TicketFilters>).every((k) => k === "groupBy" || filters[k] === DEFAULT_TICKET_FILTERS[k]);
}

/** The empty state's one honest action — rendered only while a filter is actually narrowing the
 *  list. Grouping is not a filter and survives the clear. */
function ClearFiltersButton({ filters, onClear }: Readonly<{ filters: TicketFilters; onClear: () => void }>) {
  if (filtersAtRest(filters)) return null;
  return (
    <Button variant="outline" size="sm" className="h-[44px]" onClick={onClear}>
      Clear filters
    </Button>
  );
}

/** What the empty list says. Two states, two truths: nothing exists, or the filters hid it. */
function emptyTicketsCopy(filters: TicketFilters): { title: string; description: string } {
  if (filtersAtRest(filters)) return { title: "No tickets yet", description: "Raise the first one from the button above." };
  return { title: "No tickets match these filters", description: "Widen a filter, or clear them all." };
}

/** The Sprint filter, with its own query so the page component carries neither. Renders nothing
 *  while the feature is off, without a project, or when the project has no sprints. */
function SprintFilter({ enabled, projectId, value, onChange }: Readonly<{ enabled: boolean; projectId: string; value: string; onChange: (v: string) => void }>) {
  const sprints = useQuery({ queryKey: ["sprints", projectId], queryFn: () => sprintApi.list(projectId), enabled: enabled && projectId !== "all" });
  if (!enabled || projectId === "all" || (sprints.data?.length ?? 0) === 0) return null;
  return (
    <div className="grid w-full gap-1.5 sm:w-auto">
      <Label htmlFor="ticket-filter-sprint">Sprint</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="ticket-filter-sprint" className="w-full sm:w-[180px]">
          <SelectValue placeholder="All sprints" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All sprints</SelectItem>
          {(sprints.data ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The row at the bottom of a group — the source's "Add task at the bottom of a group of tasks". */
function AddToGroupRow({ onClick }: Readonly<{ onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring flex h-[44px] w-full items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      Add ticket
    </button>
  );
}

/**
 * How a group's heading is drawn, by axis. Status and priority carry their tone as a dot — the
 * SAME tone the badge in every row uses (lib/ticket-visuals.ts), so a heading and its rows can
 * never disagree about what colour "In progress" is. Project groups carry the project's mark.
 * Everything else is the formatted label.
 */
function groupHeading(axis: string | undefined, projects: ReadonlyArray<{ id: string; name: string }>) {
  return (value: unknown): ReactNode => {
    const label = formatGroupLabel(value);
    if (axis === "status" && typeof value === "string" && value in STATUS_VARIANT) {
      return <span className="inline-flex items-center gap-2"><span aria-hidden className={cn("h-2.5 w-2.5 rounded-full", TONE_ACCENT_CLASS[STATUS_VARIANT[value as TicketStatus] ?? "muted"])} />{label}</span>;
    }
    if (axis === "priority" && typeof value === "string" && value in PRIORITY_VARIANT) {
      return <span className="inline-flex items-center gap-2"><span aria-hidden className={cn("h-2.5 w-2.5 rounded-full", TONE_ACCENT_CLASS[PRIORITY_VARIANT[value as TicketPriority] ?? "muted"])} />{label}</span>;
    }
    if (axis === "project" && typeof value === "string") {
      const project = projects.find((p) => p.name === value);
      return <span className="inline-flex items-center gap-2">{project && <ProjectMark id={project.id} name={project.name} color={(project as { color?: string | null }).color} size="xs" />}{label}</span>;
    }
    return label;
  };
}

/** Opens a ticket's sheet from a module-level column cell: the page reads `?open=` on every
 *  navigation, so writing the parameter is the same as the page's own `openTicket`. */
function openTicketByUrl(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("open", id);
  window.history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Grouping applies to the List view only — Board groups by status itself, Timeline and Calendar
 *  answer a scheduling question. */
function groupingFor(viewMode: string, groupBy: string) {
  if (viewMode !== "list") return undefined;
  return TICKET_GROUPINGS.find((g) => g.id === groupBy);
}

type TicketCardItem = { kind: "header"; key: string; label: string; count: number } | { kind: "row"; row: TicketRow } | { kind: "footer"; key: string; value: unknown };

/** The phone card list, optionally grouped: rows sorted by group label so each run is contiguous,
 *  then a header item before every run. Pure, and outside the component on purpose — the
 *  component is already the page's busiest function. */
function buildTicketCardItems(rows: readonly TicketRow[], grouping: (typeof TICKET_GROUPINGS)[number] | undefined): TicketCardItem[] {
  if (!grouping) return rows.map((row) => ({ kind: "row" as const, row }));
  const sorted = [...rows].sort((a, b) => formatGroupLabel(grouping.keyOf(a)).localeCompare(formatGroupLabel(grouping.keyOf(b))));
  return groupRuns(sorted, grouping.keyOf).flatMap((run) => [
    { kind: "header" as const, key: run.key, label: run.label, count: run.count },
    ...run.rows.map((row) => ({ kind: "row" as const, row })),
    { kind: "footer" as const, key: run.key, value: grouping.keyOf(run.rows[0]) }
  ]);
}

/** V12 3.19: the calendar's period, the day a shown week is anchored on, and the drop → PATCH.
 *  Returns the props `PlanCalendar` takes for all three, so the page just spreads them. */
function useCalendarView(canEditPlan: boolean, setCalendarMonth: (m: { year: number; month: number }) => void) {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<CalendarPeriod>("month");
  const [weekAnchor, setWeekAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const reschedule = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { startDate: string; endDate: string } }) => planApi.updateItem(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plan"] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      toast.success("Rescheduled");
    },
    onError: (error) => toast.error(serverMessage(error, "Could not reschedule"))
  });
  return {
    period,
    onPeriodChange: setPeriod,
    weekAnchor,
    onWeekAnchorChange: (day: string) => {
      // The month query window covers a week either side of the month, so keeping the month in
      // step with the anchor keeps the week's data loaded.
      setWeekAnchor(day);
      setCalendarMonth({ year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) - 1 });
    },
    onReschedule: canEditPlan ? (id: string, patch: { startDate: string; endDate: string }) => reschedule.mutate({ id, patch }) : undefined
  };
}

export function Tickets() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get("open");

  const [filters, setFilters] = useState<TicketFilters>({ ...DEFAULT_TICKET_FILTERS });
  const [createOpen, setCreateOpen] = useState(false);
  const [createInitial, setCreateInitial] = useState<TicketDraftInitial>({});
  // The sidebar's Project → Module tree deep-links here with `?project=` / `?module=` (lib/project-tree.ts
  // owns the two keys). Applied whenever the URL changes, so clicking a second module in the tree
  // while already on this page re-filters rather than being ignored.
  const linked = readProjectSelection(searchParams);
  useEffect(() => {
    if (!linked.projectId) return;
    setFilters((f) => ({ ...f, projectId: linked.projectId!, moduleId: linked.moduleId ?? "all" }));
  }, [linked.projectId, linked.moduleId]);
  // `?new=1` — the "c" shortcut and the palette's New ticket land here and want the dialog open on
  // arrival. Consumed immediately so a refresh or back-navigation does not reopen it.
  const wantsNew = searchParams.get("new") === "1";
  useEffect(() => {
    if (!wantsNew) return;
    // Seeded from the URL's own project/module (7.4: the Timeline's Add row lands here) — the
    // filters that mirror them are applied by another effect, so they are read directly.
    setCreateInitial(draftFromFilters({ ...filters, ...(linked.projectId ? { projectId: linked.projectId } : {}), ...(linked.moduleId ? { moduleId: linked.moduleId } : {}) }));
    setCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("new");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the flag appears
  }, [wantsNew]);
  /** A hand-made change to the project or module filter also drops the tree's parameters from the
   *  URL — otherwise the address bar would keep naming a project the page is no longer showing. */
  const chooseProject = (projectId: string, moduleId = "all") => {
    setFilters((f) => ({ ...f, projectId, moduleId, sprintId: "all" }));
    if (linked.projectId) setSearchParams(withoutProjectSelection(searchParams), { replace: true });
  };
  // Timeline and Calendar join List and Board here rather than becoming their own pages, so the
  // filters someone has already set carry across every way of looking at the same work. A
  // separate "planning" page would have meant two places to filter and two mental models.
  const [viewMode, setViewMode] = useState<"list" | "board" | "timeline" | "calendar">("list");
  const { features: planFeatures } = usePlanningFeatures();
  /* V12 3.17: the filtered project's sprints, so "Add ticket" under a sprint group can name the
     sprint by id. Same query key as the Sprint filter, so this is a cache read, not a request. */
  const projectSprints = useQuery({
    queryKey: ["sprints", filters.projectId],
    queryFn: () => sprintApi.list(filters.projectId),
    enabled: planFeatures.sprints && filters.projectId !== "all"
  });
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
  const calendarView = useCalendarView(canEditPlan, setCalendarMonth);
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
  // Types are admin-editable rows, not an enum, so the filter reads them rather than hard-coding
  // BUG/TASK/IMPROVEMENT. Shares its cache key with the create dialog's copy.
  const ticketTypes = useQuery({ queryKey: ["ticket-types"], queryFn: () => ticketTypeApi.list() });
  // Built once and handed to BOTH the list and the metric tiles. They must agree on what is being
  // filtered — a tile counting a different set than the table under it is worse than no tile — and
  // two hand-maintained copies of this mapping is exactly how they would drift.
  const queryParams = ticketQueryParams(filters, user?.id);
  /** The tallies belong to the two views that show a filtered set of tickets. Timeline and Calendar
   *  answer a scheduling question, where a status count is noise above the thing you came to read. */
  const showMetrics = viewMode === "list" || viewMode === "board";

  const tickets = useQuery({ queryKey: ["tickets", filters], queryFn: () => ticketApi.list(queryParams) });

  // Grouping for the List view. The desktop DataTable takes the column id and groups itself; the
  // phone card list below has no table to lean on, so it is grouped here with the same helper —
  // sorted by group label first so every run is contiguous, then headers interleaved.
  const grouping = groupingFor(viewMode, filters.groupBy);
  const cardItems = buildTicketCardItems(tickets.data ?? [], grouping);

  // The empty state's copy and its one honest action (null while every filter is at rest).
  const emptyCopy = emptyTicketsCopy(filters);
  const clearFiltersAction = <ClearFiltersButton filters={filters} onClear={() => setFilters((f) => ({ ...DEFAULT_TICKET_FILTERS, groupBy: f.groupBy }))} />;

  // Columns. Built-ins plus one per custom field; the VISIBLE set is page state (null = defaults)
  // so a saved view can carry it, and so views saved before columns existed (null) keep today's
  // look. `resolveVisibleColumns` ignores ids of fields since deleted.
  const fieldDefs = useQuery({ queryKey: ["custom-fields"], queryFn: () => planningApi.listCustomFields(), staleTime: 5 * 60_000 });
  const allColumns = useMemo(() => [...ticketColumns, ...customFieldColumns(fieldDefs.data)], [fieldDefs.data]);
  const specs = useMemo(() => columnSpecs(allColumns), [allColumns]);
  const [savedColumns, setSavedColumns] = useState<string[] | null>(null);
  const visibleColumns = useMemo(() => resolveVisibleColumns(specs, savedColumns), [specs, savedColumns]);

  /**
   * The tiles' counts. Keyed on the same `filters` object the list is keyed on, so the two refetch
   * together and a tile can never describe a different set of tickets than the table under it.
   * `assigneeId` is included because "Assigned to me" narrows the tiles too — a personal queue whose
   * headline number counted the whole workspace would be worse than no number.
   */
  const metrics = useQuery({
    queryKey: ["tickets", "metrics", filters, user?.id],
    queryFn: () => ticketApi.metrics(queryParams),
    // Keeps the previous tallies on screen while the next ones load, so clicking a tile does not
    // blank the whole strip it was clicked in.
    placeholderData: (prev) => prev
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
      {/* The switcher's `min-w-0` + `flex-wrap` containment is load-bearing at 390px (see the
          history in git for the header this replaced): four view buttons once dragged the header
          off-screen while `overflow-x: clip` hid it. PageHeader's `actions` slot carries the same
          classes, so the guarantee moved with the markup rather than being re-derived. */}
      <PageHeader
        title="Tickets"
        icon={TicketIcon}
        description="Bugs, tasks, and improvements — assign, track, and resolve."
        actions={
          <>
          {/* Seeded from the active filters (V12 3.17): a ticket created from a filtered list
              lands inside the filter — the same rule the "Add ticket" row under a group follows. */}
          <Button
            className="shrink-0"
            onClick={() => {
              setCreateInitial(draftFromFilters(filters));
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />New ticket
          </Button>
          </>
        }
      />

      {/* The Views Bar: same tickets, different lens — List, Board, Timeline, Calendar — as tabs
          directly under the header, with this page's saved views after them. Planning-gated views
          appear only once the workspace has the capability, exactly as the old button group did. */}
      <ViewsBar
        views={[
          { id: "list" as const, label: "List", icon: ListChecks },
          { id: "board" as const, label: "Board", icon: LayoutGrid },
          ...(planFeatures.timeline ? [{ id: "timeline" as const, label: "Timeline", icon: GanttChartSquare }] : []),
          ...(planFeatures.planning ? [{ id: "calendar" as const, label: "Calendar", icon: CalendarRange }] : [])
        ]}
        active={viewMode}
        onChange={setViewMode}
        trailing={
          <SavedViewsBar
            viewMode={viewMode}
            filters={filters}
            columns={savedColumns}
            onApply={(saved, columns) => {
              setFilters({ ...DEFAULT_TICKET_FILTERS, ...saved });
              setSavedColumns(columns);
            }}
          />
        }
      />

      {/* Above the filter row rather than below it: the tiles ARE filters, and a summary that sits
          under the controls it drives reads as a result rather than a starting point. Hidden on the
          two planning views, which answer a scheduling question that a status tally does not. */}
      {showMetrics && (
        <TicketMetricsPanel
          metrics={metrics.data}
          loading={metrics.isLoading}
          filters={{
            projectId: filters.projectId,
            status: filters.status,
            priority: filters.priority,
            type: filters.type,
            reporterId: filters.reporterId
          }}
          onFilterChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
        />
      )}

      <Card data-tour="tickets-workspace">
        {/* `items-end` rather than `items-center`: the selects now carry a label above them, so
            centring would float the "Assigned to me" button halfway up the row instead of sitting
            it on the same baseline as the controls it belongs with. */}
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          {/* Grouping is a List-view property, so it lives with the filters a saved view carries and
              is hidden in the views that already group in their own way (Board by status). */}
          {viewMode === "list" && (
            <div className="grid w-full gap-1.5 sm:w-auto">
              <Label htmlFor="ticket-group-by">Group by</Label>
              <Select value={filters.groupBy} onValueChange={(v) => setFilters((f) => ({ ...f, groupBy: v }))}>
                <SelectTrigger id="ticket-group-by" className="w-full sm:w-[150px]">
                  <SelectValue placeholder="No grouping" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No grouping</SelectItem>
                  {TICKET_GROUPINGS.map((g) => <SelectItem key={g.id} value={g.id}>{g.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid w-full gap-1.5 sm:w-auto">
            <Label htmlFor="ticket-filter-project">Project</Label>
            {/* Changing the project resets the module: a module belongs to exactly one project, so
                the old one could not be shown selected in the list that follows. */}
            <Select value={filters.projectId} onValueChange={(v) => chooseProject(v)}>
              <SelectTrigger id="ticket-filter-project" className="w-full sm:w-[180px]">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.data?.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {/* Sprint filter (V12): only with the feature on and a project chosen — sprints are per project. */}
          <SprintFilter enabled={planFeatures.sprints} projectId={filters.projectId} value={filters.sprintId} onChange={(v) => setFilters((f) => ({ ...f, sprintId: v }))} />
          {/* Second tier of the same hierarchy the sidebar tree navigates. Only offered once a project
              is chosen — a module list across every project would be a list of duplicate names. */}
          {filters.projectId !== "all" && (projects.data?.find((p: any) => p.id === filters.projectId)?.modules?.length ?? 0) > 0 && (
            <div className="grid w-full gap-1.5 sm:w-auto">
              <Label htmlFor="ticket-filter-module">Module</Label>
              <Select value={filters.moduleId} onValueChange={(v) => chooseProject(filters.projectId, v)}>
                <SelectTrigger id="ticket-filter-module" className="w-full sm:w-[180px]">
                  <SelectValue placeholder="All modules" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All modules</SelectItem>
                  {projects.data
                    ?.find((p: any) => p.id === filters.projectId)
                    ?.modules?.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid w-full gap-1.5 sm:w-auto">
            <Label htmlFor="ticket-filter-status">Status</Label>
            <Select value={filters.status} onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}>
              <SelectTrigger id="ticket-filter-status" className="w-full sm:w-[160px]">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {ticketStatuses.map((s) => <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid w-full gap-1.5 sm:w-auto">
            <Label htmlFor="ticket-filter-priority">Priority</Label>
            <Select value={filters.priority} onValueChange={(v) => setFilters((f) => ({ ...f, priority: v }))}>
              <SelectTrigger id="ticket-filter-priority" className="w-full sm:w-[150px]">
                <SelectValue placeholder="All priorities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All priorities</SelectItem>
                {ticketPriorities.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid w-full gap-1.5 sm:w-auto">
            <Label htmlFor="ticket-filter-type">Type</Label>
            {/* Reads the admin-editable TicketType rows rather than a hard-coded list, so a
                workspace that added "Spike" can filter by it the day it exists. */}
            <Select value={filters.type} onValueChange={(v) => setFilters((f) => ({ ...f, type: v }))}>
              <SelectTrigger id="ticket-filter-type" className="w-full sm:w-[150px]">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {(ticketTypes.data ?? []).map((t) => {
                  const TypeIcon = iconForType(t.name);
                  return (
                    <SelectItem key={t.id} value={t.name}>
                      <span className="inline-flex items-center gap-1.5">
                        <TypeIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        {t.name}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="grid w-full gap-1.5 sm:w-auto">
            <Label htmlFor="ticket-filter-reporter">Raised by</Label>
            {/* Options come from the metrics endpoint — the people who have actually raised a
                ticket in this scope, with their counts — not the user directory, most of whom have
                never filed one. */}
            <Select value={filters.reporterId} onValueChange={(v) => setFilters((f) => ({ ...f, reporterId: v }))}>
              <SelectTrigger id="ticket-filter-reporter" className="w-full sm:w-[170px]">
                <SelectValue placeholder="Anyone" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Anyone</SelectItem>
                {(metrics.data?.byReporter ?? []).map((r) => (
                  <SelectItem key={r.userId} value={r.userId}>
                    <span className="inline-flex items-center gap-1.5">
                      {r.name}
                      <span className="text-xs text-muted-foreground">({r.count})</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* No label of its own — it is a toggle, not a field, and the button's own text already
              names it. `h-10` matches SelectTrigger so the row keeps one baseline. */}
          <Button
            variant={filters.onlyMine ? "default" : "outline"}
            size="sm"
            className="h-10"
            onClick={() => setFilters((f) => ({ ...f, onlyMine: !f.onlyMine }))}
          >
            Assigned to me
          </Button>
        </CardContent>
      </Card>

      {viewMode === "board" && (
        <Card key="board" className="motion-safe:animate-fade-in">
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
        <Card key="timeline" className="motion-safe:animate-fade-in">
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
        <Card key="calendar" className="motion-safe:animate-fade-in">
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
                {...calendarView}
              />
            )}
          </CardContent>
        </Card>
      )}

      {viewMode === "list" && (
      <Card key="list" className="motion-safe:animate-fade-in">
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
              cardItems.map((item) => {
                if (item.kind === "footer") {
                  return (
                    <AddToGroupRow
                      key={`footer-${item.key}`}
                      onClick={() => {
                        setCreateInitial(draftFor(grouping?.id, item.value, filters, projects.data ?? [], projectSprints.data ?? []));
                        setCreateOpen(true);
                      }}
                    />
                  );
                }
                if (item.kind === "header") {
                  return (
                    <div key={`group-${item.key}`} className="mt-1 flex items-center gap-2 px-1 text-sm font-semibold">
                      <span className="truncate">{groupHeading(grouping?.id, projects.data ?? [])(item.key)}</span>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{item.count}</span>
                    </div>
                  );
                }
                const row = item.row;
                const TypeIcon = iconForType(row.type);
                const overdue = Boolean(row.slaBreachAt);
                const avatarSrc = fileUrl(row.assignee?.avatarUrl);
                return (
                  // A div with the button role, not a <button>: the card now contains its own
                  // control (the status pill), and a button inside a button is invalid HTML that
                  // the browser flags. Enter/Space open the ticket, as a button would.
                  <div
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openTicket(row.id)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openTicket(row.id);
                      }
                    }}
                    className={cn("focus-ring grid cursor-pointer gap-2 rounded-lg border border-border border-l-4 bg-card p-3 text-left text-sm shadow-sm", TONE_BORDER_CLASS[STATUS_VARIANT[row.status] ?? "muted"])}
                    data-ticket-card
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{row.key}</span>
                      <div className="flex items-center gap-1.5">
                        {row.source === "EMAIL" && <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        <Badge variant={PRIORITY_VARIANT[row.priority]}>{row.priority}</Badge>
                        <StatusPill ticketId={row.id} status={row.status} onOpenTicket={openTicket} />
                      </div>
                    </div>
                    <p className="truncate font-medium leading-snug">{row.title}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><TypeIcon className="h-3.5 w-3.5" />{row.type}</span>
                      <ProjectMark id={row.project.id} name={row.project.name} color={row.project.color} size="xs" />
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
                  </div>
                );
              })}
            {!tickets.isLoading && (tickets.data ?? []).length === 0 && (
              <EmptyState title={emptyCopy.title} description={emptyCopy.description} action={clearFiltersAction} />
            )}
          </div>

          <div className="hidden p-3 sm:block">
            <DataTable
              columns={allColumns}
              visibleColumns={visibleColumns}
              onVisibleColumnsChange={(ids) => setSavedColumns(isDefaultColumns(specs, ids) ? null : ids)}
              data={tickets.data ?? []}
              isLoading={tickets.isLoading}
              onRowClick={(row) => openTicket(row.id)}
              searchPlaceholder="Search these results..."
              emptyMessage={emptyCopy.title}
              emptyAction={clearFiltersAction}
              pageSize={20}
              groupBy={grouping?.id}
              groupLabel={groupHeading(grouping?.id, projects.data ?? [])}
              groupFooter={(value) => (
                <AddToGroupRow
                  onClick={() => {
                    setCreateInitial(draftFor(grouping?.id, value, filters, projects.data ?? [], projectSprints.data ?? []));
                    setCreateOpen(true);
                  }}
                />
              )}
            />
          </div>
        </CardContent>
      </Card>
      )}

      <CreateTicketDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setCreateInitial({});
        }}
        initial={createInitial}
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

/** What a grouped or filtered view pre-fills when a ticket is created from it. */
export type { TicketDraftInitial } from "../lib/ticket-draft";

function CreateTicketDialog({
  open,
  onOpenChange,
  projects,
  onCreated,
  initial
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: any[];
  onCreated: (ticket: TicketDetail) => void;
  /** Merged over the blank draft each time the dialog opens — from a group's "+ Add ticket" row,
   *  the fields of that group and of the active filters, so what you create lands where you are
   *  looking. Never applied while the dialog is already open. */
  initial?: TicketDraftInitial;
}) {
  const [draft, setDraft] = useState({
    projectId: "",
    moduleId: "",
    type: "BUG",
    title: "",
    description: "",
    priority: "MEDIUM" as TicketPriority,
    assigneeId: "",
    sprintId: ""
  });
  const [suggestion, setSuggestion] = useState<AITriageSuggestion | null>(null);
  const [duplicates, setDuplicates] = useState<AIDuplicateMatch[]>([]);
  const [aiConfidence, setAiConfidence] = useState<number | null>(null);
  const [autoApplied, setAutoApplied] = useState(false);
  useEffect(() => {
    if (open && initial && Object.keys(initial).length > 0) setDraft((d) => ({ ...d, ...initial }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply the seed on open only
  }, [open]);
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
  const { features: planFeatures } = usePlanningFeatures();
  const draftSprints = useQuery({
    queryKey: ["sprints", draft.projectId],
    queryFn: () => sprintApi.list(draft.projectId),
    enabled: planFeatures.sprints && Boolean(draft.projectId)
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

  /**
   * Files chosen BEFORE the ticket exists.
   *
   * WHY THIS IS ONLY POSSIBLE IN TWO STEPS: the upload route is `POST /tickets/:id/attachments`,
   * and there is no id until the ticket is created. So the screenshot someone has on their
   * clipboard at the moment they report a bug used to have no home — they filed the ticket, found
   * it again, opened the Files tab, and uploaded there. Most people simply didn't, and the
   * evidence never made it onto the ticket at all.
   */
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  function resetDraft() {
    setDraft({ projectId: "", moduleId: "", type: "BUG", title: "", description: "", priority: "MEDIUM", assigneeId: "", sprintId: "" });
    setSuggestion(null);
    setDuplicates([]);
    setAiConfidence(null);
    setAutoApplied(false);
    setPendingFiles([]);
  }

  const create = useMutation({
    mutationFn: async (faceVerificationId?: string) => {
      const ticket = await ticketApi.create({
        projectId: draft.projectId,
        moduleId: draft.moduleId || undefined,
        type: draft.type,
        title: draft.title,
        description: draft.description || undefined,
        priority: draft.priority,
        assigneeId: draft.assigneeId || undefined,
        sprintId: draft.sprintId || undefined,
        aiConfidence: aiConfidence ?? undefined,
        // Single-use proof of a live identity check; only sent when the workspace policy
        // covers this user. The server independently decides whether it was required.
        ...(faceVerificationId ? { faceVerificationId } : {})
      });

      // The upload is a SEPARATE, non-fatal step. A failed upload must not read as "the ticket
      // wasn't created" — it was, and it is the thing the user actually cares about; the files
      // can be added from the Files tab. Reporting it as a warning names what happened without
      // throwing away the created ticket.
      if (pendingFiles.length > 0) {
        try {
          await ticketApi.attachments.upload(ticket.id, pendingFiles);
        } catch (error: any) {
          toast.warning(`${ticket.key} created without its files`, {
            description: serverMessage(error, "Add them from the ticket's Files tab.")
          });
        }
      }
      return ticket;
    },
    onSuccess: (ticket) => {
      toast.success("Ticket created", {
        description: pendingFiles.length > 0 ? `${ticket.key} · ${pendingFiles.length} file(s) attached` : ticket.key
      });
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
      {/*
        Pinned header and footer, scrolling middle.

        THE BUG THIS FIXES: the dialog is centre-anchored and had no height cap, so it grew in
        BOTH directions as the description did. Around fifteen lines of typing, "New ticket" left
        the top of the screen and Cancel/Create left the bottom — with no scrollbar, because the
        dialog is `position: fixed` and the page behind it is scroll-locked. You could still type;
        you could no longer submit. Capping the height puts the overflow somewhere it can be
        scrolled, and the editor's own `maxHeight` stops it reaching for that space in the first
        place. `dvh`, not `vh`, because mobile browsers measure `vh` against the viewport with the
        URL bar hidden.
      */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(95vw,560px)] max-w-none flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>Raise a bug, task, or improvement against a project.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto overscroll-contain px-0.5 pb-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Project</Label>
              <Select
                value={draft.projectId}
                onValueChange={(v) => setDraft((d) => ({ ...d, projectId: v, moduleId: "", assigneeId: "", sprintId: "" }))}
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
          {/* V12 3.17: the sprint the ticket opens in. Only with the feature on, a project chosen
              and sprints to choose from — otherwise the dialog is exactly what it was. */}
          {planFeatures.sprints && draft.projectId && (draftSprints.data?.length ?? 0) > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="create-ticket-sprint">Sprint <span className="text-muted-foreground">(optional)</span></Label>
              <Select value={draft.sprintId || "none"} onValueChange={(v) => setDraft((d) => ({ ...d, sprintId: v === "none" ? "" : v }))}>
                <SelectTrigger id="create-ticket-sprint"><SelectValue placeholder="Not in a sprint" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not in a sprint</SelectItem>
                  {(draftSprints.data ?? []).map((sp) => <SelectItem key={sp.id} value={sp.id}>{sp.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
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
              placeholder="Steps to reproduce, expected vs actual, context... (paste a stack trace or snippet — it formats itself as code)"
              minHeight="min-h-28"
              // Roughly ten lines, then it scrolls inside its own box. Below the dialog's own cap
              // so the surrounding form — the AI assist row, the type/priority selects — stays
              // reachable while a long description is being written rather than being pushed down
              // out of the scroll viewport.
              maxHeight="max-h-64"
              ariaLabel="Ticket description"
            />
            <AiRefinePanel state={refineDescription} />
          </div>

          {/* Attach the evidence NOW, while it is on the clipboard and the reporter is still
              thinking about the bug. Uploaded immediately after the ticket is created — see the
              two-step note on the create mutation. */}
          <div className="grid gap-1.5">
            <Label>
              Attachments <span className="text-muted-foreground">(optional)</span>
            </Label>
            <FileDropzone
              files={pendingFiles}
              onChange={setPendingFiles}
              maxFiles={8}
              maxSizeMb={25}
              hint="Screenshots, logs, exports — attached to the ticket the moment it's created."
            />
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
            <BorderGlow animated>
            <div className="grid gap-2 p-3 text-sm">
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
            </BorderGlow>
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
        <DialogFooter className="shrink-0 border-t border-border pt-3">
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
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create ticket
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

/**
 * Why the message is chosen from the STATUS and not from the server's text: a 404 here is usually
 * not "this ticket was deleted" but "that id was never a ticket", and the two need different
 * advice. A 403 needs different advice again. The server's own wording is fine for a toast and too
 * terse to be the only thing in an otherwise empty panel.
 */
function ticketStatusOf(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

function ticketErrorTitle(error: unknown): string {
  const status = ticketStatusOf(error);
  if (status === 404) return "There is no ticket here";
  if (status === 403) return "You don't have access to this ticket";
  return "This ticket couldn't be loaded";
}

function ticketErrorHint(error: unknown): string {
  const status = ticketStatusOf(error);
  if (status === 404) {
    return "The link points at something that isn't a ticket, or at one that has since been deleted. If you followed it from somewhere else in the app, that link is wrong — worth reporting.";
  }
  if (status === 403) {
    return "It exists, but it belongs to a project you aren't assigned to. Ask its project lead to add you.";
  }
  return "Something went wrong fetching it. Close this and try again — if it keeps happening, the API may be down.";
}

/**
 * V12 3.16 — the two-column task panel. The tab strip (Comments … Activity) is the reference's
 * "right activity section": it moves beside the fields when the sheet is wide enough, and a
 * person may close it "to keep the task details and description in focus". The choice is
 * remembered per browser like the width is. Nothing changes below the threshold.
 */
/** The project's identity fill for the current theme, as an HSL triplet; grey when there is no ticket yet. */
function useProjectFill(project: { id: string; color?: string | null } | undefined): string {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => "light" as const);
  if (!project) return "0 0% 50%";
  const color = resolveIdentityColor(project.id, project.color);
  return theme === "dark" ? color.dark : color.light;
}

function useTicketSheetLayout(sheetSize: SheetResizeState) {
  const viewportWide = useMediaQuery(`(min-width: ${SPLIT_MIN_SHEET_WIDTH}px)`);
  const storage = typeof window === "undefined" ? undefined : window.localStorage;
  const [activityHidden, setActivityHidden] = useState(() => readActivityHidden(storage));
  const layoutInput = {
    resizable: sheetSize.resizable,
    width: sheetSize.width,
    maximized: sheetSize.maximized,
    viewportWidth: viewportWide ? SPLIT_MIN_SHEET_WIDTH : 0
  };
  const toggleActivity = () => {
    const next = !activityHidden;
    setActivityHidden(next);
    writeActivityHidden(storage, next);
  };
  return { layout: ticketSheetLayout({ ...layoutInput, activityHidden }), splitPossible: canSplit(layoutInput), activityHidden, toggleActivity };
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
  // Reopening is still a permission question, not a relationship one — unchanged from before.
  const canReopen =
    Boolean(user?.permissions.includes(permissions.TICKETS_ASSIGN) || user?.permissions.includes(permissions.TICKETS_MANAGE)) ||
    user?.role === "SUPER_ADMIN" ||
    user?.role === "ADMIN";

  const detail = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => ticketApi.get(ticketId as string),
    enabled: Boolean(ticketId)
  });

  /**
   * Whether this viewer may change who works on the ticket — taken from the SERVER's answer, not
   * re-derived from permissions here.
   *
   * It used to be `tickets:assign || tickets:manage`, which every manager and team lead holds
   * tenant-wide. The API now also requires the viewer to be the mapped manager of the reporter or
   * assignee, and that is a `managerId` lookup the browser cannot do — so guessing would render an
   * assignee dropdown that 403s on use. Defaults to false while the detail loads, which hides a
   * control for a moment rather than flashing one that then disappears.
   */
  const canAssign = Boolean(detail.data?.canReassign);
  /** Same source, same reason: whether this viewer may edit the ticket or move its status. */
  const canWork = Boolean(detail.data?.canWork);

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
    // V12 10.3 — the picker shows the new name straight away. The name comes from the SAME list the
    // picker rendered, so nothing is invented; anything the server changes beyond it arrives with
    // the settle below.
    onMutate: (assigneeId) =>
      applyOptimistic<TicketDetail>(queryClient, [
        {
          key: ["ticket", ticketId],
          update: (detail) => {
            if (!("assignee" in detail)) return undefined;
            if (!assigneeId) return { ...detail, assignee: null };
            const picked = (members.data ?? []).find((m: any) => m.userId === assigneeId);
            return picked ? { ...detail, assignee: picked.user } : undefined;
          }
        }
      ]),
    onSuccess: () => {
      toast.success("Assignee updated");
      invalidate();
    },
    onSettled: () => settleOptimistic(queryClient, [["ticket", ticketId], ["tickets"]]),
    onError: (err: any, _vars, context) => {
      rollbackOptimistic(queryClient, context);
      toast.error("Could not assign", { description: serverMessage(err, "Try again.") });
    }
  });

  const watchMutation = useMutation({
    mutationFn: (watching: boolean) =>
      watching ? ticketApi.watchers.remove(ticketId as string, user!.id) : ticketApi.watchers.add(ticketId as string),
    // V12 10.3 — Watch is a toggle, and a toggle that waits for the network reads as one that did
    // not register the click. The optimistic row carries a placeholder id; the real one arrives on
    // settle, and nothing keys off it in between.
    onMutate: (watching) =>
      applyOptimistic<TicketDetail>(queryClient, [
        {
          key: ["ticket", ticketId],
          update: (detail) => {
            if (!detail.watchers || !user) return undefined;
            const watchers = watching
              ? detail.watchers.filter((w) => w.userId !== user.id)
              : [...detail.watchers, { id: `optimistic-${user.id}`, userId: user.id, user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl ?? null } }];
            return { ...detail, watchers };
          }
        }
      ]),
    onSuccess: () => invalidate(),
    onSettled: () => settleOptimistic(queryClient, [["ticket", ticketId]]),
    onError: (err: any, _vars, context) => {
      rollbackOptimistic(queryClient, context);
      toast.error("Could not update watch status", { description: serverMessage(err, "Try again.") });
    }
  });

  const addCollaboratorMutation = useMutation({
    mutationFn: (userId: string) => ticketApi.collaborators.add(ticketId as string, userId),
    onSuccess: () => {
      toast.success("Collaborator added");
      invalidate();
    },
    onError: (err: any) => toast.error("Could not add collaborator", { description: serverMessage(err, "Try again.") })
  });
  const removeCollaboratorMutation = useMutation({
    mutationFn: (userId: string) => ticketApi.collaborators.remove(ticketId as string, userId),
    onSuccess: () => invalidate(),
    onError: (err: any) => toast.error("Could not remove collaborator", { description: serverMessage(err, "Try again.") })
  });

  const allLabels = useQuery({ queryKey: ["labels"], queryFn: labelApi.list });
  // V12 10.3 — a label appears when picked and disappears when removed. Both patch the same list,
  // so they share one updater rather than two that could disagree about the row's shape.
  const patchLabels = (change: (rows: TicketLabelRow[]) => TicketLabelRow[]) => ({
    key: ["ticket", ticketId] as const,
    update: (detail: TicketDetail) => (detail.labels ? { ...detail, labels: change(detail.labels) } : undefined)
  });
  const addLabelMutation = useMutation({
    mutationFn: (labelId: string) => ticketApi.labels.add(ticketId as string, labelId),
    onMutate: (labelId) => {
      const label = (allLabels.data ?? []).find((l) => l.id === labelId);
      if (!label) return Promise.resolve(undefined);
      return applyOptimistic<TicketDetail>(queryClient, [
        patchLabels((rows) => (rows.some((r) => r.labelId === labelId) ? rows : [...rows, { id: `optimistic-${labelId}`, labelId, label }]))
      ]);
    },
    onSuccess: () => invalidate(),
    onSettled: () => settleOptimistic(queryClient, [["ticket", ticketId]]),
    onError: (err: any, _vars, context) => {
      rollbackOptimistic(queryClient, context);
      toast.error("Could not add label", { description: serverMessage(err, "Try again.") });
    }
  });
  const removeLabelMutation = useMutation({
    mutationFn: (labelId: string) => ticketApi.labels.remove(ticketId as string, labelId),
    onMutate: (labelId) =>
      applyOptimistic<TicketDetail>(queryClient, [patchLabels((rows) => rows.filter((r) => r.labelId !== labelId))]),
    onSuccess: () => invalidate(),
    onSettled: () => settleOptimistic(queryClient, [["ticket", ticketId]]),
    onError: (err: any, _vars, context) => {
      rollbackOptimistic(queryClient, context);
      toast.error("Could not remove label", { description: serverMessage(err, "Try again.") });
    }
  });

  /** Panel width, remembered per browser. Declared above the early return so the hook order is
   *  identical whether or not a ticket is open. */
  const sheetSize = useSheetResize({ storageKey: "timesphere.ticket-sheet-width" });
  const { layout, splitPossible, activityHidden, toggleActivity } = useTicketSheetLayout(sheetSize);
  // 7.5: the header's wash in the project's identity colour — a hook, so it sits above the early return.
  const projectFill = useProjectFill(detail.data?.project);

  if (!ticketId) return null;
  const ticket = detail.data;
  const TypeIcon = ticket ? iconForType(ticket.type) : TicketIcon;
  const isWatching = Boolean(ticket && user && ticket.watchers.some((w) => w.userId === user.id));
  const allowedNext = ticket
    ? ticketStatusTransitions[ticket.status].filter((s) => !(ticket.status === "CLOSED" && s === "REOPENED" && !canReopen))
    : [];

  return (
    <Sheet open={Boolean(ticketId)} onOpenChange={(open) => !open && onClose()}>
      {/*
        Resizable and maximizable, because this panel is a working surface rather than a summary:
        a description, a comment thread, pasted code, a proofing image and a twelve-column
        activity log all have to be read AND edited in it. At the old fixed 576px a stack trace
        wrapped into unreadable ribbon and there was nothing the reader could do about it. The
        width is remembered per browser, so it is set once rather than re-dragged per ticket, and
        the whole mechanism is inert below `sm` where the sheet is already the entire screen.
      */}
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl" style={sheetSize.style}>
        <SheetResizeHandle state={sheetSize} label="Resize the ticket panel" />
        <SheetMaximizeButton state={sheetSize} />
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
        {/*
          THE THIRD STATE. Until this existed there were only two branches — loading, and a ticket —
          so a query that FAILED rendered an open sheet containing nothing but the screen-reader-only
          title above it: a blank white panel with a close button, and no way to tell a deleted
          ticket from a permission problem from a bug.

          It was reachable from more than a stale bookmark. `/app/tickets?open=<id>` takes whatever
          id it is handed, and the AI suggestions page was handing it change and project ids (see
          Proposals.tsx) — so most of the "open this" chevrons on that page landed here, blank.
          That routing is fixed, but the guarantee belongs HERE: this sheet opens on a URL parameter
          anybody can type, so it has to answer for an id that resolves to nothing no matter who
          sent it.
        */}
        {!detail.isLoading && detail.isError && (
          <div className="grid gap-3 pt-8">
            <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-5">
              <p className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
                {ticketErrorTitle(detail.error)}
              </p>
              <p className="text-sm leading-6 text-muted-foreground">{ticketErrorHint(detail.error)}</p>
              <Button variant="outline" size="sm" className="mt-1 w-fit" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        )}
        {ticket && (
          <>
            {/* `pr-16` clears the two absolutely-positioned controls in the top-right — close, and
                now maximize. Without it a long ticket title runs underneath them and the first
                thing you try to click is the title. Only the header needs it; the body below runs
                the full width. */}
            {/* 7.5: the header wears the project's colour as a soft wash — the same hue as its mark
                everywhere else, at an alpha every foreground was measured over. Radial, so it reads
                as a tint on the corner rather than a coloured bar. */}
            <SheetHeader className="-mx-6 -mt-6 px-6 pt-6 pb-3 pr-16" style={{ backgroundImage: `radial-gradient(120% 140% at 0% 0%, hsl(${projectFill} / ${IDENTITY_WASH_ALPHA}), transparent 70%)`, boxShadow: `inset 0 3px 0 hsl(${projectFill})` }} data-sheet-wash>
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
                {/* The source's "close one or both sections": ends the badge row rather than
                    taking a row of its own, so the header does not grow when it appears. */}
                {splitPossible && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-[44px]"
                    onClick={toggleActivity}
                    aria-pressed={activityHidden}
                    data-activity-toggle
                  >
                    {activityHidden ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
                    {activityHidden ? "Show activity" : "Hide activity"}
                  </Button>
                )}
              </div>
            </SheetHeader>

            <div
              data-sheet-layout={layout}
              key={layout}
              className={cn(
                "py-4 motion-safe:animate-fade-in",
                layout === "split" && "grid items-start gap-6 grid-cols-[minmax(0,1fr)_minmax(360px,440px)]",
                layout === "focus" && "mx-auto w-full max-w-3xl"
              )}
            >
            <div className="grid gap-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label className="text-xs uppercase text-muted-foreground">Status</Label>
                  {/* Disabled rather than hidden when the viewer may not work on this ticket: the
                      current status is information everybody who can open the sheet is entitled to,
                      and removing the control would leave a blank where a value belongs. The
                      explanation underneath is what stops it reading as a bug. */}
                  <Select
                    value={ticket.status}
                    onValueChange={(v) => requestStatusChange(v as TicketStatus)}
                    disabled={statusMutation.isPending || !canWork}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ticket.status}>{ticket.status.replace("_", " ")} (current)</SelectItem>
                      {allowedNext.map((s) => <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {!canWork && (
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      Only this ticket&apos;s reporter, its assignee, its collaborators, or their manager can move it.
                    </p>
                  )}
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

              {/* Sits directly under the assignee, because it extends it: a collaborator holds the
                  same working rights the assignee does. Rendered for everyone, not only people who
                  may edit it — knowing who else is on a ticket is not an admin question — but the
                  add/remove controls appear only when the server said this viewer may reassign. */}
              <div className="grid gap-1.5">
                <Label className="text-xs uppercase text-muted-foreground">
                  Collaborators
                  <span className="ml-1.5 normal-case tracking-normal text-muted-foreground">
                    (can work on this ticket)
                  </span>
                </Label>
                <div className="flex flex-wrap items-center gap-2">
                  {ticket.collaborators.map((c) => (
                    <span
                      key={c.id}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border py-1 pl-1 pr-2.5 text-xs font-medium"
                      title={c.addedBy ? `Added by ${c.addedBy.name}` : undefined}
                    >
                      <Avatar className="h-5 w-5">
                        <AvatarFallback className="text-[9px]">{initialsFor(c.user.name)}</AvatarFallback>
                      </Avatar>
                      {c.user.name}
                      {/* Anyone may stand themselves down; only a reassigner may remove someone
                          else — the API enforces exactly this split. */}
                      {(canAssign || c.userId === user?.id) && (
                        <button
                          type="button"
                          aria-label={`Remove ${c.user.name}`}
                          onClick={() => removeCollaboratorMutation.mutate(c.userId)}
                          disabled={removeCollaboratorMutation.isPending}
                          className="ml-0.5 text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                  {ticket.collaborators.length === 0 && !canAssign && (
                    <span className="text-xs text-muted-foreground">No collaborators</span>
                  )}
                  {canAssign && (
                    <Select value="" onValueChange={(v) => addCollaboratorMutation.mutate(v)}>
                      <SelectTrigger className="h-7 w-[170px] text-xs"><SelectValue placeholder="+ Add collaborator" /></SelectTrigger>
                      <SelectContent>
                        {(members.data ?? [])
                          // The assignee and reporter can already work on it, and the API rejects
                          // adding them, so offering them here would only produce a 422.
                          .filter(
                            (a: any) =>
                              a.userId !== ticket.assignee?.id &&
                              a.userId !== ticket.reporter.id &&
                              !ticket.collaborators.some((c) => c.userId === a.userId)
                          )
                          .map((a: any) => <SelectItem key={a.userId} value={a.userId}>{a.user.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
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

              {/* Sprint membership and points (V12). Renders nothing while the feature is off. */}
              <TicketSprintFields ticketId={ticket.id} projectId={ticket.project.id} sprintId={ticket.sprintId} storyPoints={ticket.storyPoints} canEdit={canWork} />

              {/* Admin-defined fields for this ticket type. Renders nothing when none apply. */}
              <TicketCustomFields ticketId={ticket.id} ticketType={ticket.type} canEdit={canWork} />
            </div>

            {/* The activity column. In the split layout it keeps its own scroll so a long thread
                does not carry the fields off-screen; stacked, it follows the fields as before. */}
            {layout !== "focus" && (
            <aside
              aria-label="Comments and activity"
              className={cn(layout === "split" ? "sticky top-0 max-h-[calc(100vh-2rem)] overflow-y-auto border-l border-border pl-6" : "mt-5")}
            >
              <Tabs defaultValue="comments" className="grid gap-3">
                <TabsList>
                  <TabsTrigger value="comments"><MessageSquare className="h-3.5 w-3.5" />Comments ({ticket.comments.length}){ticket.comments.some((c) => c.assignee && !c.resolvedAt) && <span className="ml-1 rounded-full bg-warning/15 px-1.5 text-[10px] font-semibold text-warning" title="Unresolved assigned comments">{ticket.comments.filter((c) => c.assignee && !c.resolvedAt).length}</span>}</TabsTrigger>
                  {/* Second, immediately after Comments. The two are read together — a comment
                      almost always refers to a file, and a file almost always needs a comment —
                      and Files used to sit eighth, past four conditional tabs, which is far
                      enough right to be off the end of the strip on a laptop. */}
                  <TabsTrigger value="attachments"><Paperclip className="h-3.5 w-3.5" />Files ({ticket.attachments.length})</TabsTrigger>
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
                  <TabsTrigger value="links"><Link2 className="h-3.5 w-3.5" />Linked ({ticket.links.length + ticket.documents.length})</TabsTrigger>
                  <TabsTrigger value="time"><TimerReset className="h-3.5 w-3.5" />Time logged</TabsTrigger>
                  <TabsTrigger value="dev"><GitBranch className="h-3.5 w-3.5" />Dev ({ticket.branches.length})</TabsTrigger>
                  <TabsTrigger value="security"><ShieldAlert className="h-3.5 w-3.5" />Security</TabsTrigger>
                  <TabsTrigger value="lineage"><Waypoints className="h-3.5 w-3.5" />Lineage</TabsTrigger>
                  <TabsTrigger value="activity"><ScrollText className="h-3.5 w-3.5" />Activity</TabsTrigger>
                </TabsList>
                <TabsContent value="comments">
                  <CommentsPanel ticketId={ticket.id} projectId={ticket.project.id} comments={ticket.comments} onPosted={invalidate} />
                </TabsContent>
                <TabsContent value="attachments">
                  <AttachmentsPanel ticketId={ticket.id} attachments={ticket.attachments} onChanged={invalidate} />
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
                  {/* V12 8.4: related documents live on the same tab — "Relate a doc with a task, right from the task". */}
                  <RelatedDocumentsPanel ticketId={ticket.id} documents={ticket.documents} onChanged={invalidate} />
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
            </aside>
            )}
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
  projectId,
  comments,
  onPosted
}: {
  ticketId: string;
  projectId: string;
  comments: TicketComment[];
  onPosted: () => void;
}) {
  const [body, setBody] = useState("");
  const [assignTo, setAssignTo] = useState<string>("");
  const queryClientForComments = useQueryClient();
  const patchComment = useMutation({
    mutationFn: (args: { commentId: string; payload: { assigneeId?: string | null; resolved?: boolean } }) => ticketApi.comments.patch(ticketId, args.commentId, args.payload),
    // V12 10.1 — Resolve is a checkbox, and a checkbox that waits for a PATCH before it moves reads
    // as broken. (8.3's own live probe caught this: Playwright's `check()` saw the old state.)
    onMutate: (args) =>
      applyOptimistic<TicketDetail>(queryClientForComments, [
        {
          key: ["ticket", ticketId],
          update: (detail) => {
            if (!detail.comments || args.payload.resolved === undefined) return undefined;
            const resolvedAt = args.payload.resolved ? new Date().toISOString() : null;
            return { ...detail, comments: replaceById(detail.comments, args.commentId, { resolvedAt }) };
          }
        }
      ]),
    onSuccess: () => {
      onPosted();
      queryClientForComments.invalidateQueries({ queryKey: ["plan", "my-work"] });
    },
    onSettled: () => settleOptimistic(queryClientForComments, [["ticket", ticketId]]),
    onError: (err: any, _vars, context) => {
      rollbackOptimistic(queryClientForComments, context);
      toast.error("Could not update the comment", { description: serverMessage(err, "Try again.") });
    }
  });
  // V12 8.1: who can be @mentioned — the project's members, the same list the assignee picker
  // shows, so the role model decides who is offered (cached under the same query key).
  const members = useQuery({ queryKey: ["project-assignments", projectId], queryFn: () => projectApi.assignments(projectId) });
  const mentionCandidates = useMemo(
    () => (members.data ?? []).map((a: any) => ({ id: a.userId as string, label: a.user.name as string })),
    [members.data]
  );
  const [showSummary, setShowSummary] = useState(false);
  const post = useMutation({
    mutationFn: () => ticketApi.comments.add(ticketId, body, assignTo || null),
    onSuccess: () => {
      setBody("");
      setAssignTo("");
      onPosted();
    },
    onError: (err: any) => toast.error("Could not post comment", { description: serverMessage(err, "Try again.") })
  });
  const summarize = useMutation({
    mutationFn: () => aiApi.summarizeTicket(ticketId),
    onError: (err: any) => toast.error("Could not summarize", { description: serverMessage(err, "AI may be disabled for this workspace.") })
  });
  const refineComment = useAiRefine({ field: "ticket_comment", label: "comment", value: body, onChange: setBody });
  const plainLength = plainTextLength(body);

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
            <div className="border-t border-border p-2 text-sm">
              {/* keyed so a freshly generated summary replays the sweep */}
              <BorderGlow key={summarize.data ? "summary" : "waiting"} animated={Boolean(summarize.data)}>
                <div className="p-3">
                  {summarize.isPending && <AiStrands label="Reading the thread…" />}
                  {summarize.data && <p>{summarize.data.summary}</p>}
                  {summarize.isError && (
                    <p className="text-xs text-destructive">{serverMessage(summarize.error, "Could not generate a summary.")}</p>
                  )}
                </div>
              </BorderGlow>
            </div>
          )}
        </div>
      )}
      <ScrollArea className="max-h-72 rounded-md border border-border">
        <div className="grid gap-3 p-3">
          {comments.length === 0 && <EmptyState compact title="No comments yet" description="Start the thread below." />}
          {comments.map((c) => (
            <div key={c.id} className="grid gap-1 rounded-md bg-muted/30 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{c.author.name}</span>
                <span>{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <div className="prose-sm text-sm" dangerouslySetInnerHTML={safeHtml(c.body)} />
              {/* V12 8.3: an assigned comment is an action item — who owns it, and a Resolve tick
                  anyone who can see the ticket may use; the resolver's name shows beside it. */}
              {c.assignee && (
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs" data-assigned-comment={c.id}>
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
                    Assigned to <span className="font-medium text-foreground">{c.assignee.name}</span>
                  </span>
                  <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[hsl(var(--primary))]"
                      checked={Boolean(c.resolvedAt)}
                      disabled={patchComment.isPending}
                      onChange={(e) => patchComment.mutate({ commentId: c.id, payload: { resolved: e.target.checked } })}
                      aria-label={c.resolvedAt ? "Reopen this comment" : "Resolve this comment"}
                    />
                    {c.resolvedAt ? (
                      <span className="text-success">Resolved{c.resolvedBy ? ` by ${c.resolvedBy.name}` : ""}</span>
                    ) : (
                      <span>Resolve</span>
                    )}
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="flex items-center justify-end">
        <AiRefineTrigger state={refineComment} />
      </div>
      {/* Capped low: this box lives at the BOTTOM of a scrolling thread panel, so every line it
          grows pushes the "Post comment" button further off the end of the sheet. */}
      <RichTextEditor
        value={body}
        onChange={setBody}
        placeholder="Add a comment... (@ to mention a project member; paste a log or snippet — it formats itself as code)"
        minHeight="min-h-20"
        maxHeight="max-h-48"
        ariaLabel="New comment"
        mentions={mentionCandidates}
      />
      <AiRefinePanel state={refineComment} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* V12 8.3: "Assign to" turns the comment into an action item for a project member. */}
        <Select value={assignTo || "none"} onValueChange={(v) => setAssignTo(v === "none" ? "" : v)}>
          <SelectTrigger className="h-[44px] w-[200px]" aria-label="Assign this comment to" data-comment-assign>
            <SelectValue placeholder="Assign to (optional)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Not assigned</SelectItem>
            {mentionCandidates.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" className="h-[44px]" disabled={plainLength === 0 || post.isPending} onClick={() => post.mutate()}>
          Post comment
        </Button>
      </div>
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
  const checklistQueryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ itemId, done }: { itemId: string; done: boolean }) => ticketApi.checklist.update(ticketId, itemId, { done }),
    // V12 10.1 — the tick flips under the pointer rather than after a round trip and a refetch of
    // the whole ticket.
    onMutate: ({ itemId, done }) =>
      applyOptimistic<TicketDetail>(checklistQueryClient, [
        {
          key: ["ticket", ticketId],
          update: (detail) =>
            detail.checklistItems
              ? { ...detail, checklistItems: replaceById(detail.checklistItems, itemId, { done }) }
              : undefined
        }
      ]),
    onSuccess: () => onChanged(),
    onSettled: () => settleOptimistic(checklistQueryClient, [["ticket", ticketId]]),
    onError: (err: any, _vars, context) => {
      rollbackOptimistic(checklistQueryClient, context);
      toast.error("Could not update item", { description: serverMessage(err, "Try again.") });
    }
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
        {items.length === 0 && <EmptyState compact title="No checklist items yet" />}
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
        {links.length === 0 && <EmptyState compact title="No linked tickets yet" />}
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

/** V12 8.4: the ticket's related requirements documents, with a picker over the Studio's list. */
function RelatedDocumentsPanel({ ticketId, documents, onChanged }: { ticketId: string; documents: TicketDocumentLinkRow[]; onChanged: () => void }) {
  const navigate = useNavigate();
  const [pick, setPick] = useState("");
  const all = useQuery({ queryKey: ["requirements-docs"], queryFn: () => requirementsDocApi.list() });
  const linked = new Set(documents.map((d) => d.document.id));
  const candidates = (all.data ?? []).filter((d) => d.status !== "ARCHIVED" && !linked.has(d.id));
  const add = useMutation({
    mutationFn: () => ticketApi.documents.add(ticketId, pick),
    onSuccess: () => {
      setPick("");
      onChanged();
    },
    onError: (err: any) => toast.error("Could not relate the document", { description: serverMessage(err, "Try again.") })
  });
  const remove = useMutation({
    mutationFn: (linkId: string) => ticketApi.documents.remove(ticketId, linkId),
    onSuccess: () => onChanged(),
    onError: (err: any) => toast.error("Could not remove the document", { description: serverMessage(err, "Try again.") })
  });
  return (
    <div className="mt-4 grid gap-2 border-t border-border pt-4" data-related-documents>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Related documents</p>
      <div className="grid gap-1.5">
        {documents.map((d) => (
          <div key={d.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm">
            <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <button type="button" className="flex flex-1 items-center gap-1.5 truncate text-left hover:underline" onClick={() => navigate(`/app/requirements/${d.document.id}`)}>
              <span className="truncate">{d.document.title}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
            <Badge variant="muted">{d.document.docType}</Badge>
            <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" aria-label={`Remove ${d.document.title}`} onClick={() => remove.mutate(d.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {documents.length === 0 && <EmptyState compact title="No related documents yet" />}
      </div>
      <div className="flex gap-2">
        <Select value={pick || "none"} onValueChange={(v) => setPick(v === "none" ? "" : v)}>
          <SelectTrigger className="h-[44px] flex-1" aria-label="Pick a document to relate" data-document-pick>
            <SelectValue placeholder="Pick a document" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Pick a document</SelectItem>
            {candidates.map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.title}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" className="h-[44px]" disabled={!pick || add.isPending} onClick={() => add.mutate()}>
          <Link2 className="h-4 w-4" />Relate
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
        {branches.length === 0 && <EmptyState compact title="No branches or PRs linked yet" />}
      </div>
      {gitStatus.data?.connected && (
        <div className="grid gap-2 rounded-md border border-dashed border-border p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <GitHubMark className="h-3.5 w-3.5 shrink-0" />
            Pick from GitHub ({gitStatus.data.accountLogin})
          </p>
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
  VAPT: "Penetration test (VAPT)",
  QUALITY: "Code quality",
  LINT: "Lint"
};

/**
 * The badge for where a claimed fix stands with the scanner. Exhaustive on purpose, like the two
 * Records above: a new verification state fails to compile here until somebody decides how a reader
 * should be told about it.
 *
 * `securityFindingVerificationLabels` supplies the words — shared with the digest email, so the
 * screen and the inbox cannot describe the same row differently.
 */
const VERIFICATION_VARIANT: Record<SecurityFindingVerificationState, BadgeProps["variant"]> = {
  AWAITING_PROOF: "info",
  VERIFIED_FIXED: "success",
  REFUTED_BY_SCAN: "destructive",
  // Not destructive, deliberately. Nobody proved this fix failed — a scan simply never ran. Colouring
  // it like a failure would make the screen say what the product carefully refuses to say.
  UNVERIFIED: "warning"
};

/**
 * What proved (or failed to prove) a claimed fix, in its own box under the finding.
 *
 * WHY IT SHOWS ITS WORKING rather than just the badge above it. "Verified fixed" is a claim this
 * product is making, and a security engineer's first and entirely correct reaction to a machine
 * telling them a vulnerability is gone is to ask who says so. Which tool, which commit, when — the
 * same three facts the reopen digest leads with, for the same reason.
 *
 * Modelled on the AI-triage box below it: a dashed sub-box, so evidence about a finding reads as
 * annotation rather than as another finding.
 *
 * A Record rather than a ternary chain, for the same reason `SEVERITY_VARIANT` and
 * `FINDING_TYPE_LABEL` above are: a fifth verification state fails to compile here until somebody
 * writes the sentence a reader should see for it, instead of quietly falling through to whichever
 * branch happened to be last.
 */
const VERIFICATION_EVIDENCE: Record<
  SecurityFindingVerificationState,
  { tone: string; detail: (finding: SecurityFindingRow) => string }
> = {
  AWAITING_PROOF: {
    tone: "border-info/30 bg-info/5 text-info",
    detail: (f) => {
      const since = f.awaitingVerificationSince ? ` on ${new Date(f.awaitingVerificationSince).toLocaleDateString()}` : "";
      return `Claimed fixed${since}. Waiting for the next ${f.tool} scan on this repository and branch to confirm it — only that tool counts.`;
    }
  },
  VERIFIED_FIXED: {
    tone: "border-success/30 bg-success/5 text-success",
    detail: (f) => {
      const commit = f.verifiedByCommitSha ? ` at commit ${f.verifiedByCommitSha.slice(0, 12)}` : "";
      const when = f.verifiedFixedAt ? `, on ${new Date(f.verifiedFixedAt).toLocaleString()}` : "";
      return `A ${f.tool} scan on this repository and branch no longer reports it${commit}${when}.`;
    }
  },
  REFUTED_BY_SCAN: {
    tone: "border-destructive/30 bg-destructive/5 text-destructive",
    detail: (f) => `A later ${f.tool} scan still reported this after it was marked fixed, so it was put back to OPEN.`
  },
  UNVERIFIED: {
    tone: "border-warning/30 bg-warning/5 text-warning",
    detail: (f) =>
      `No ${f.tool} scan has run on this repository and branch since the fix was claimed. Nothing has been proven either way — this is not a failed fix, and nothing was reopened because of it.`
  }
};

function VerificationEvidence({ finding }: { finding: SecurityFindingRow }) {
  const state = finding.verificationState;
  if (!state) return null;

  const { tone, detail } = VERIFICATION_EVIDENCE[state];

  return (
    <div className={`mt-1 grid gap-0.5 rounded-md border border-dashed px-2.5 py-2 text-xs ${tone}`}>
      <div className="flex flex-wrap items-center gap-1.5 font-semibold">
        <ShieldCheck className="h-3 w-3" />
        Verification: {securityFindingVerificationLabels[state]}
      </div>
      <p className="text-muted-foreground">{detail(finding)}</p>
      <p className="text-muted-foreground">
        First seen {new Date(finding.firstSeenAt).toLocaleDateString()} · reported by {finding.occurrences} scan
        {finding.occurrences === 1 ? "" : "s"}
        {finding.verifiedByScanRunId ? ` · run ${finding.verifiedByScanRunId.slice(0, 8)}` : ""}
      </p>
    </div>
  );
}

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
  // Optional-chained because this field crossed the wire: an API build older than this one does not
  // send it, and a panel that throws is worse than one that omits a line.
  const qualityOpenCount = (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).reduce(
    (sum, severity) => sum + (data.openQualityCountBySeverity?.[severity] ?? 0),
    0
  );

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

      {/* Said out loud so the verdict above cannot be misread. The verdict and the severity counts
          behind it are SECURITY findings only; the code-quality ones on this ticket are listed in
          their own sections below and are deliberately not part of it. Rendered only when there are
          some — "0 code-quality findings" on a ticket nobody lints is noise. */}
      {qualityOpenCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Plus {qualityOpenCount} open code-quality/lint finding{qualityOpenCount === 1 ? "" : "s"} — listed below, and not counted
          in the verdict above.
        </p>
      )}

      {data.latestTestRun && (
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
          <span className="text-muted-foreground">Latest test run ({data.latestTestRun.provider})</span>
          <Badge variant={data.latestTestRun.status === "PASSED" ? "success" : data.latestTestRun.status === "FAILED" ? "destructive" : "info"}>
            {data.latestTestRun.status}
          </Badge>
        </div>
      )}

      {/* Sections come from the shared constant, in its order — not from a literal list that
          compiled fine while quietly dropping a whole type's findings out of the panel. The
          `?? []` below stays because this data crossed the wire: an older API build genuinely may
          not have the key, and that is a different situation from this file forgetting it exists. */}
      {securityFindingTypes.map((type) => {
        const items = data.findingsByType[type] ?? [];
        if (items.length === 0) return null;
        return (
          <div key={type} className="grid gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{FINDING_TYPE_LABEL[type]}</p>
            {items.map((finding) => (
              <div key={finding.id} className="grid gap-0.5 rounded-md border border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={SEVERITY_VARIANT[finding.severity]}>{finding.severity}</Badge>
                  <span className="text-sm font-medium">{finding.title}</span>
                  {finding.verificationState && (
                    <Badge variant={VERIFICATION_VARIANT[finding.verificationState]} className="text-[10px]">
                      {securityFindingVerificationLabels[finding.verificationState]}
                    </Badge>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">{finding.tool}{finding.status !== "OPEN" ? ` · ${finding.status}` : ""}</span>
                </div>
                {finding.filePath && (
                  <p className="text-xs text-muted-foreground">{finding.filePath}{finding.lineNumber ? `:${finding.lineNumber}` : ""}</p>
                )}
                {finding.verificationState && (
                  <VerificationEvidence finding={finding} />
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
      <EmptyState
        compact
        title="Nothing to show yet"
        description={<>Link a branch or PR in the Dev tab, or connect CI/security ingestion (Workspace Settings → Security &amp; DevOps) referencing this ticket's key, and the timeline builds itself.</>}
      />
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
