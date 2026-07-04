/**
 * The Tickets page — list view, Kanban board view (see TicketKanban.tsx), the create dialog,
 * and the ticket detail sheet (status/assignee/labels/links/checklist/comments/attachments/
 * time-logged/activity tabs).
 *
 * WHY the AI bits live inline here (AI-assist chip, "Improve with AI", AI summary) rather than
 * in a separate file: they're small, ticket-scoped affordances that read straight from
 * `aiApi` and only ever render one at a time — splitting them out would mean prop-drilling the
 * same ticket/project context back in for no real separation-of-concerns benefit.
 *
 * WHO can see/do what: gated at the route level (`RequirePermission` in App.tsx) for the page
 * itself; per-action gates (assign, reopen a closed ticket, etc.) are re-checked here against
 * `user.permissions`/`user.role` because the server is the real authority — these client-side
 * checks only hide buttons that would 403 anyway, they're not the security boundary.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  permissions,
  ticketPriorities,
  ticketStatusTransitions,
  ticketStatuses,
  type TicketPriority,
  type TicketStatus
} from "@timesheet/shared";
import {
  AlertTriangle,
  ArrowUpRight,
  Bug,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  LayoutGrid,
  Link2,
  ListChecks,
  Mail,
  MessageSquare,
  Paperclip,
  Plus,
  ScrollText,
  Sparkles,
  Tag,
  Ticket as TicketIcon,
  TimerReset,
  Trash2,
  X
} from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { TicketKanban } from "../components/TicketKanban";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge, type BadgeProps } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { FileDropzone } from "../components/ui/file-dropzone";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { RichTextEditor } from "../components/ui/rich-text-editor";
import { ScrollArea } from "../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { safeHtml } from "../lib/safe-html";
import {
  aiApi,
  fileUrl,
  labelApi,
  projectApi,
  ticketApi,
  ticketTypeApi,
  type AIDuplicateMatch,
  type AITriageSuggestion,
  type TicketAttachmentRow,
  type TicketChecklistItemRow,
  type TicketComment,
  type TicketDetail,
  type TicketLinkRow,
  type TicketLinkType,
  type TicketRow,
  type TicketTimesheetRow
} from "../services/api";
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

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** aiApi.improveText returns plain text — wrap it as paragraphs for the RichTextEditor's HTML value. */
function plainTextToHtml(text: string) {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function Tickets() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get("open");

  const [filters, setFilters] = useState({ projectId: "all", status: "all", priority: "all", labelId: "all", onlyMine: false });
  const [createOpen, setCreateOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "board">("list");

  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list });
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
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-border p-0.5">
            <Button variant={viewMode === "list" ? "default" : "ghost"} size="sm" onClick={() => setViewMode("list")}>
              <ListChecks className="h-3.5 w-3.5" />List
            </Button>
            <Button variant={viewMode === "board" ? "default" : "ghost"} size="sm" onClick={() => setViewMode("board")}>
              <LayoutGrid className="h-3.5 w-3.5" />Board
            </Button>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />New ticket
          </Button>
        </div>
      </div>

      <Card>
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

      {viewMode === "list" && (
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Labels</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.isLoading &&
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={`skel-${i}`}>
                    {Array.from({ length: 9 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))}
              {!tickets.isLoading &&
                (tickets.data ?? []).map((row: TicketRow) => {
                  const TypeIcon = iconForType(row.type);
                  const overdue = Boolean(row.slaBreachAt);
                  const avatarSrc = fileUrl(row.assignee?.avatarUrl);
                  return (
                    <TableRow key={row.id} className="cursor-pointer" onClick={() => openTicket(row.id)}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{row.key}</TableCell>
                      <TableCell className="max-w-[280px]">
                        <div className="flex items-center gap-1.5">
                          {row.source === "EMAIL" && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              </TooltipTrigger>
                              <TooltipContent>Created from an inbound email</TooltipContent>
                            </Tooltip>
                          )}
                          <span className="truncate font-medium">{row.title}</span>
                          {row.needsReview && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="warning" className="shrink-0 gap-1"><Sparkles className="h-3 w-3" />Review</Badge>
                              </TooltipTrigger>
                              <TooltipContent>AI classification confidence was below threshold</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{row.project.name}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          <TypeIcon className="h-3.5 w-3.5 text-muted-foreground" />{row.type}
                        </span>
                      </TableCell>
                      <TableCell><Badge variant={PRIORITY_VARIANT[row.priority]}>{row.priority}</Badge></TableCell>
                      <TableCell><Badge variant={STATUS_VARIANT[row.status]}>{row.status.replace("_", " ")}</Badge></TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {row.labels.map((tl) => (
                            <span
                              key={tl.id}
                              className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium"
                            >
                              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tl.label.color ?? "#94A3B8" }} />
                              {tl.label.name}
                            </span>
                          ))}
                          {row.labels.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.assignee ? (
                          <div className="flex items-center gap-2">
                            <Avatar className="h-6 w-6">
                              {avatarSrc ? <AvatarImage src={avatarSrc} alt={row.assignee.name} /> : null}
                              <AvatarFallback className="text-[10px]">{initialsFor(row.assignee.name)}</AvatarFallback>
                            </Avatar>
                            <span className="truncate text-sm">{row.assignee.name}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Unassigned</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {overdue ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex items-center gap-1 text-xs font-semibold text-destructive">
                                <AlertTriangle className="h-3.5 w-3.5" />Overdue
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>Due {formatDate(row.dueAt)}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-xs text-muted-foreground">{formatDate(row.dueAt)}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              {!tickets.isLoading && (tickets.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-12 text-center text-muted-foreground">
                    No tickets match these filters yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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

  const selectedProject = projects.find((p: any) => p.id === draft.projectId);
  const members = useQuery({
    queryKey: ["project-assignments", draft.projectId],
    queryFn: () => projectApi.assignments(draft.projectId),
    enabled: Boolean(draft.projectId)
  });
  const ticketTypesQuery = useQuery({ queryKey: ["ticket-types"], queryFn: () => ticketTypeApi.list() });

  function resetDraft() {
    setDraft({ projectId: "", moduleId: "", type: "BUG", title: "", description: "", priority: "MEDIUM", assigneeId: "" });
    setSuggestion(null);
    setDuplicates([]);
    setAiConfidence(null);
  }

  const create = useMutation({
    mutationFn: () =>
      ticketApi.create({
        projectId: draft.projectId,
        moduleId: draft.moduleId || undefined,
        type: draft.type,
        title: draft.title,
        description: draft.description || undefined,
        priority: draft.priority,
        assigneeId: draft.assigneeId || undefined,
        aiConfidence: aiConfidence ?? undefined
      }),
    onSuccess: (ticket) => {
      toast.success("Ticket created", { description: ticket.key });
      resetDraft();
      onOpenChange(false);
      onCreated(ticket);
    },
    onError: (err: any) => toast.error("Could not create ticket", { description: serverMessage(err, "Try again.") })
  });

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
      setSuggestion(result.triage);
      setDuplicates(result.matches);
      if (!result.triage && result.matches.length === 0 && result.error) {
        toast.error("AI assist unavailable", { description: serverMessage(result.error, "AI may be disabled for this workspace.") });
      }
    }
  });

  const improveDescription = useMutation({
    mutationFn: () => aiApi.improveText({ text: draft.description, context: "ticket_description" }),
    onSuccess: (res) => setDraft((d) => ({ ...d, description: plainTextToHtml(res.improved) })),
    onError: (err: any) => toast.error("Could not improve text", { description: serverMessage(err, "AI may be disabled for this workspace.") })
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
            <Label>Title</Label>
            <Input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} placeholder="Short, specific summary" />
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label>Description <span className="text-muted-foreground">(optional)</span></Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => improveDescription.mutate()}
                disabled={draft.description.replace(/<[^>]+>/g, "").trim().length === 0 || improveDescription.isPending}
              >
                <Sparkles className="h-3 w-3" />Improve with AI
              </Button>
            </div>
            <RichTextEditor
              value={draft.description}
              onChange={(html) => setDraft((d) => ({ ...d, description: html }))}
              placeholder="Steps to reproduce, expected vs actual, context..."
              minHeight="min-h-28"
              ariaLabel="Ticket description"
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
              <Sparkles className="h-3.5 w-3.5" />AI assist
            </Button>
          </div>

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
          <Button onClick={() => create.mutate()} disabled={!draft.projectId || draft.title.trim().length < 3 || create.isPending}>
            <Plus className="h-4 w-4" />Create ticket
          </Button>
        </DialogFooter>
      </DialogContent>
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
    mutationFn: (status: TicketStatus) => ticketApi.updateStatus(ticketId as string, status),
    onSuccess: () => {
      toast.success("Status updated");
      invalidate();
    },
    onError: (err: any) => toast.error("Could not update status", { description: serverMessage(err, "Try again.") })
  });

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
              <SheetTitle className="flex items-center gap-2 text-xl">
                <TypeIcon className="h-5 w-5 text-muted-foreground" />
                {ticket.title}
              </SheetTitle>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant={PRIORITY_VARIANT[ticket.priority]}>{ticket.priority}</Badge>
                <Badge variant={STATUS_VARIANT[ticket.status]}>{ticket.status.replace("_", " ")}</Badge>
                {ticket.slaBreachAt && (
                  <Badge variant="destructive"><AlertTriangle className="mr-1 h-3 w-3" />SLA breached</Badge>
                )}
              </div>
            </SheetHeader>

            <div className="grid gap-5 py-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label className="text-xs uppercase text-muted-foreground">Status</Label>
                  <Select
                    value={ticket.status}
                    onValueChange={(v) => statusMutation.mutate(v as TicketStatus)}
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
                    <Avatar key={w.userId} className="h-6 w-6 ring-2 ring-background">
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
                  <TabsTrigger value="links"><Link2 className="h-3.5 w-3.5" />Linked ({ticket.links.length})</TabsTrigger>
                  <TabsTrigger value="attachments"><Paperclip className="h-3.5 w-3.5" />Files ({ticket.attachments.length})</TabsTrigger>
                  <TabsTrigger value="time"><TimerReset className="h-3.5 w-3.5" />Time logged</TabsTrigger>
                  <TabsTrigger value="activity"><ScrollText className="h-3.5 w-3.5" />Activity</TabsTrigger>
                </TabsList>
                <TabsContent value="comments">
                  <CommentsPanel ticketId={ticket.id} comments={ticket.comments} onPosted={invalidate} />
                </TabsContent>
                <TabsContent value="checklist">
                  <ChecklistPanel ticketId={ticket.id} items={ticket.checklistItems} onChanged={invalidate} />
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
                <TabsContent value="activity">
                  <ActivityPanel ticketId={ticket.id} />
                </TabsContent>
              </Tabs>
            </div>
          </>
        )}
      </SheetContent>
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
  const improveComment = useMutation({
    mutationFn: () => aiApi.improveText({ text: body, context: "comment" }),
    onSuccess: (res) => setBody(plainTextToHtml(res.improved)),
    onError: (err: any) => toast.error("Could not improve comment", { description: serverMessage(err, "AI may be disabled for this workspace.") })
  });
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
            <span className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" />AI summary</span>
            <span>{showSummary ? "Hide" : "Show"}</span>
          </button>
          {showSummary && (
            <div className="border-t border-border p-3 text-sm">
              {summarize.isPending && <Skeleton className="h-4 w-full" />}
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => improveComment.mutate()}
          disabled={plainLength === 0 || improveComment.isPending}
        >
          <Sparkles className="h-3 w-3" />Improve with AI
        </Button>
      </div>
      <RichTextEditor value={body} onChange={setBody} placeholder="Add a comment..." minHeight="min-h-20" ariaLabel="New comment" />
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
              <Button variant="ghost" size="icon" className="h-6 w-6" disabled={index === 0} onClick={() => move(index, -1)}>
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" disabled={index === items.length - 1} onClick={() => move(index, 1)}>
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => remove.mutate(item.id)}>
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
            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => remove.mutate(link.id)}>
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
            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove.mutate(a.id)}>
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
