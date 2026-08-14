/**
 * WHAT: one timesheet entry, in full — who logged it, against what, for how long, what they wrote,
 * and the files they attached — with an edit mode for whoever is allowed to correct it.
 *
 * WHY IT IS ONE COMPONENT AND NOT THREE: three screens each showed a clipped slice of the same
 * row and none of them could open it.
 *   • Approvals had a read-only detail dialog that listed attachments as a COUNT — "2 file(s)" —
 *     with no way to open them, so an approver could see that evidence existed and not read it.
 *   • History had no detail view at all. Once an entry was approved it left the approvals queue,
 *     and the only remaining record of who logged what was a two-line clamp in a table cell.
 *   • The dashboard's day timeline linked every block to `/app/history`, which is a page, not the
 *     entry — you clicked a specific 3.5h block and arrived at a list of everything.
 * Building the answer once means the three can never drift into disagreeing about what an entry
 * says, which is the failure mode that produced the count-with-no-link in the first place.
 *
 * ATTACHMENTS DOWNLOAD BY PLAIN LINK, deliberately. `/uploads` needs a signed, expiring,
 * org-bound grant (app.ts), and the API mints one into every file URL it emits — so the `url` on
 * the row is already a capability. No blob dance, no bearer header, and a link that has gone
 * stale fails closed with a message that says to reopen the entry.
 *
 * WHO MAY EDIT is decided by the server (timesheet.controller.ts's PATCH) and mirrored here only
 * to decide whether to render the button: the author until the entry is APPROVED, or anyone
 * holding timesheets:approve, in any status. Mirroring a rule is a risk — the copy can drift — so
 * this one is written as a single predicate with the server's reasoning quoted next to it, and the
 * server refuses regardless of what this file believes.
 *
 * WHO RENDERS THIS: pages/AdminPages.tsx (ApprovalsPage), pages/History.tsx, pages/Dashboard.tsx.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  Check,
  Clock,
  Download,
  Layers,
  Loader2,
  Paperclip,
  Pencil,
  ShieldCheck,
  StickyNote,
  Trash2,
  User as UserIcon,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { activityTypeApi, fileUrl, projectApi, timesheetApi, type TimesheetEntryDetail } from "../services/api";
import { useAuthStore } from "../store/auth";
import { safeHtml } from "../lib/safe-html";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "./ui/dialog";
import { DatePicker, TimeField } from "./ui/date-picker";
import { FileDropzone } from "./ui/file-dropzone";
import { Label } from "./ui/label";
import { RichTextEditor } from "./ui/rich-text-editor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { toast } from "./ui/toaster";

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  APPROVED: "success",
  SUBMITTED: "warning",
  DRAFT: "muted",
  REJECTED: "destructive"
};

function serverMessage(err: any, fallback: string): string {
  return err?.response?.data?.message ?? fallback;
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Bytes as something a person reads. Attachment sizes here span a 2 KB log and a 20 MB PDF. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface TimesheetEntryDialogProps {
  /** The entry to show. `null` closes the dialog — the caller owns that state so a table row, a
   *  timeline block and a URL parameter can all be the thing that opens it. */
  entryId: string | null;
  onClose: () => void;
  /** Optimistic seed from the row the user clicked, so the dialog paints instantly instead of
   *  flashing a spinner for data the calling page already has. The fetch still runs and wins —
   *  the seed is a capped-list row and may be missing the reviewer and the attachments. */
  initialEntry?: any;
  /** Decision buttons, when the caller is a screen that decides (the approvals queue). Omitted
   *  everywhere else: a history page that offered Approve would be offering something the server
   *  refuses for anything but a SUBMITTED row. */
  onApprove?: (entry: TimesheetEntryDetail) => void;
  onReject?: (entry: TimesheetEntryDetail) => void;
  /** Extra footer actions the calling page already owns (CSV export, identity evidence pack). */
  footerExtras?: (entry: TimesheetEntryDetail) => React.ReactNode;
}

export function TimesheetEntryDialog({
  entryId,
  onClose,
  initialEntry,
  onApprove,
  onReject,
  footerExtras
}: TimesheetEntryDialogProps) {
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const [editing, setEditing] = useState(false);

  const query = useQuery({
    queryKey: ["timesheet", entryId],
    queryFn: () => timesheetApi.get(entryId!),
    enabled: Boolean(entryId),
    // The seed makes the first paint instant; `staleTime: 0` means the real row still lands.
    initialData: initialEntry && initialEntry.id === entryId ? (initialEntry as TimesheetEntryDetail) : undefined
  });

  const entry = query.data;

  // Editing is per-entry state, not per-dialog: leaving the form open across a switch from one
  // entry to another would show entry B under entry A's unsaved edits.
  useEffect(() => setEditing(false), [entryId]);

  /**
   * The same two rules the server enforces in PATCH /timesheets/:id. Quoted, not invented: the
   * author may correct their own entry until it is APPROVED, and anyone trusted to approve the
   * hours may correct them in any status.
   *
   * The author's window deliberately extends past SUBMITTED — an entry awaiting a decision is
   * still the author's account of their own work, and the old rule made a one-word typo cost a
   * rejection and a re-submission. APPROVED stops there: those hours carry a frozen rate and feed
   * cost reports and attestations, so changing them is a reviewer's call.
   */
  const canEdit = useMemo(() => {
    if (!entry || !currentUser) return false;
    if (currentUser.permissions.includes("timesheets:approve" as any)) return true;
    return entry.userId === currentUser.id && entry.status !== "APPROVED";
  }, [entry, currentUser]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["timesheet", entryId] });
    // Every surface that lists entries reads one of these two: the tables (approvals, history)
    // and the dashboard's timeline + weekly rollups.
    queryClient.invalidateQueries({ queryKey: ["timesheets"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  return (
    <Dialog open={Boolean(entryId)} onOpenChange={(open) => !open && onClose()}>
      {/* Header and footer are pinned and only the middle scrolls: on a phone this dialog is
          taller than the screen every time, and a footer that scrolls off is a Save button you
          have to hunt for. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(96vw,720px)] max-w-none flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex flex-wrap items-center gap-2 break-words">
            <UserIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            {entry?.user?.name ?? "Timesheet entry"}
            {entry && <Badge variant={STATUS_VARIANT[entry.status] ?? "muted"}>{entry.status}</Badge>}
          </DialogTitle>
          <DialogDescription className="break-words">
            {entry ? (
              <>
                {entry.user?.email}
                {entry.user?.email ? " · " : ""}
                {String(entry.workDate).slice(0, 10)} · {Number(entry.totalHours).toFixed(2)}h
              </>
            ) : (
              "Loading the full entry…"
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          {query.isLoading && !entry ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading entry…
            </div>
          ) : query.isError ? (
            <p className="py-8 text-sm text-destructive">
              {serverMessage(query.error, "This entry could not be loaded. It may have been deleted.")}
            </p>
          ) : entry && editing ? (
            <EntryEditForm entry={entry} onDone={() => setEditing(false)} onSaved={invalidate} />
          ) : entry ? (
            <EntryReadView entry={entry} canEdit={canEdit} onChanged={invalidate} />
          ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t border-border pt-3">
          {entry && !editing && canEdit && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" />Edit entry
            </Button>
          )}
          {entry && !editing && footerExtras?.(entry)}
          {entry && !editing && entry.status === "SUBMITTED" && onReject && (
            <Button variant="outline" onClick={() => onReject(entry)}>
              <X className="h-4 w-4" />Reject
            </Button>
          )}
          {entry && !editing && entry.status === "SUBMITTED" && onApprove && (
            <Button variant="success" onClick={() => onApprove(entry)}>
              <Check className="h-4 w-4" />Approve
            </Button>
          )}
          {(!entry || editing) && (
            <Button variant="ghost" onClick={editing ? () => setEditing(false) : onClose}>
              {editing ? "Cancel edit" : "Close"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ================================ Read view ================================ */

/** One labelled fact. Label above value on a phone, beside it once there is room — a fixed
 *  two-column grid at 360px leaves the value about ten characters wide. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b border-border/60 pb-2 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

function EntryReadView({
  entry,
  canEdit,
  onChanged
}: {
  entry: TimesheetEntryDetail;
  canEdit: boolean;
  onChanged: () => void;
}) {
  return (
    <div className="grid gap-2 text-sm">
      <Row label="Logged by">
        <p className="font-medium">{entry.user?.name}</p>
        <p className="text-xs text-muted-foreground">{entry.user?.email}</p>
      </Row>
      <Row label="Project">
        <p className="font-medium">{entry.project?.name}</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Layers className="h-3 w-3 shrink-0" />
          {entry.module?.name}
          {entry.submodule ? ` / ${entry.submodule.name}` : ""}
        </p>
        {entry.ticket && (
          <Badge variant="outline" className="mt-1 font-mono text-[10px]">
            {entry.ticket.key} — {entry.ticket.title}
          </Badge>
        )}
      </Row>
      <Row label="Activity">{entry.activityType}</Row>
      <Row label="When">
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="h-3 w-3 text-muted-foreground" />
            {String(entry.workDate).slice(0, 10)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3 text-muted-foreground" />
            {entry.startTime} → {entry.endTime}
          </span>
          <span className="font-semibold tabular-nums">{Number(entry.totalHours).toFixed(2)}h</span>
        </span>
      </Row>
      <Row label="Task">
        {/* `safeHtml` re-sanitizes on render even though the server sanitized on write — this is
            `dangerouslySetInnerHTML`, so it never rests on one check. */}
        <div className="prose-sm" dangerouslySetInnerHTML={safeHtml(entry.taskDescription)} />
      </Row>
      {entry.notes && entry.notes.replace(/<[^>]+>/g, "").trim() ? (
        <Row label="Notes">
          <div className="prose-sm flex items-start gap-1">
            <StickyNote className="mt-1 h-3 w-3 shrink-0 text-muted-foreground" />
            <div dangerouslySetInnerHTML={safeHtml(entry.notes)} />
          </div>
        </Row>
      ) : null}
      <Row label="Attachments">
        <AttachmentList entry={entry} canEdit={canEdit} onChanged={onChanged} />
      </Row>
      <Row label="Identity">
        {entry.identityVerified ? (
          <Badge variant="success" title={entry.identityVerifiedAt ? `Face check passed ${formatTimestamp(entry.identityVerifiedAt)}` : undefined}>
            <ShieldCheck className="mr-1 h-3 w-3" />Verified
          </Badge>
        ) : entry.identityVerificationApplies ? (
          <Badge variant="outline">Unverified</Badge>
        ) : (
          <span className="text-muted-foreground">Not covered by the face policy</span>
        )}
      </Row>
      <Row label="Submitted">{formatTimestamp(entry.submittedAt)}</Row>
      {entry.reviewedAt || entry.reviewedBy ? (
        <Row label="Reviewed">
          {formatTimestamp(entry.reviewedAt)}
          {entry.reviewedBy ? <span className="text-muted-foreground"> by {entry.reviewedBy.name}</span> : null}
        </Row>
      ) : null}
      <Row label="Last updated">
        {formatTimestamp(entry.lastEditedAt ?? entry.updatedAt)}
        {/* WHO, not just when. An entry a manager corrected used to look exactly like one nobody
            had touched, which is the part that matters to the person whose work it is. */}
        {entry.lastEditedBy ? (
          <span className="text-muted-foreground">
            {" "}by <span className="font-medium text-foreground">{entry.lastEditedBy.name}</span>
            {entry.lastEditedBy.id !== entry.userId ? " (not the author)" : ""}
          </span>
        ) : null}
      </Row>
      {entry.status === "REJECTED" && entry.rejectionReason ? (
        <Row label="Rejection reason">
          <span className="text-destructive">{entry.rejectionReason}</span>
        </Row>
      ) : null}
    </div>
  );
}

/**
 * The files, as links that actually download.
 *
 * This is the gap the approvals dialog had: it printed "2 file(s)" and stopped. The evidence an
 * approver is being asked to approve on the strength of was one number away from being readable.
 */
function AttachmentList({
  entry,
  canEdit,
  onChanged
}: {
  entry: TimesheetEntryDetail;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<File[]>([]);
  const [adding, setAdding] = useState(false);

  const upload = useMutation({
    mutationFn: () => timesheetApi.attachments.upload(entry.id, pending),
    onSuccess: () => {
      setPending([]);
      setAdding(false);
      onChanged();
      toast.success("Attached", { description: "The file is on this entry and downloadable by anyone who can read it." });
    },
    onError: (err: any) => toast.error("Upload failed", { description: serverMessage(err, "Try again.") })
  });

  const remove = useMutation({
    mutationFn: (attachmentId: string) => timesheetApi.attachments.remove(entry.id, attachmentId),
    onSuccess: () => {
      onChanged();
      toast.success("Attachment removed");
    },
    onError: (err: any) => toast.error("Could not remove that file", { description: serverMessage(err, "Try again.") })
  });

  return (
    <div className="grid gap-2">
      {entry.attachments.length === 0 && <span className="text-muted-foreground">No files attached.</span>}
      {entry.attachments.map((file) => (
        <div key={file.id} className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
          <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <a
            href={fileUrl(file.url)}
            // The API serves every attachment with `Content-Disposition: attachment`, so this
            // downloads rather than navigating — `target="_blank"` keeps the dialog open while it
            // does, and `rel` is required alongside it.
            target="_blank"
            rel="noreferrer"
            download={file.fileName}
            className="min-w-0 flex-1 truncate font-medium text-primary hover:underline"
            title={`Download ${file.fileName}`}
          >
            {file.fileName}
          </a>
          <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">{formatBytes(file.sizeBytes)}</span>
          <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          {canEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${file.fileName}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate(file.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ))}

      {canEdit && !adding && (
        <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setAdding(true)}>
          <Paperclip className="h-3.5 w-3.5" />Add a file
        </Button>
      )}
      {canEdit && adding && (
        <div className="grid gap-2">
          <FileDropzone files={pending} onChange={setPending} maxFiles={8} maxSizeMb={25} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending.length === 0 || upload.isPending} onClick={() => upload.mutate()}>
              {upload.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
              Upload {pending.length || ""}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPending([]);
                setAdding(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================ Edit form ================================ */

/**
 * Correcting an entry. Everything a person can get wrong when logging time is editable here;
 * status and billable deliberately are not — those are decisions with their own routes,
 * notifications and rate-freezing behaviour, not descriptions of what happened.
 *
 * The project/module/submodule pickers cascade the same way the logging form's do, because the
 * server validates the triangle: a module has to belong to the chosen project. Changing the
 * project therefore clears the two below it rather than leaving a stale pair the save would
 * bounce.
 */
function EntryEditForm({
  entry,
  onDone,
  onSaved
}: {
  entry: TimesheetEntryDetail;
  onDone: () => void;
  onSaved: () => void;
}) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const activityTypes = useQuery({ queryKey: ["activity-types"], queryFn: () => activityTypeApi.list() });

  const [form, setForm] = useState({
    projectId: entry.projectId,
    moduleId: entry.moduleId,
    submoduleId: entry.submoduleId ?? "",
    activityType: entry.activityType,
    workDate: String(entry.workDate).slice(0, 10),
    startTime: entry.startTime,
    endTime: entry.endTime,
    taskDescription: entry.taskDescription,
    notes: entry.notes ?? ""
  });

  const selectedProject = (projects.data ?? []).find((p: any) => p.id === form.projectId);
  const selectedModule = selectedProject?.modules?.find((m: any) => m.id === form.moduleId);

  const save = useMutation({
    mutationFn: () =>
      timesheetApi.update(entry.id, {
        projectId: form.projectId,
        moduleId: form.moduleId,
        submoduleId: form.submoduleId || null,
        activityType: form.activityType,
        workDate: form.workDate,
        startTime: form.startTime,
        endTime: form.endTime,
        taskDescription: form.taskDescription,
        notes: form.notes
      }),
    onSuccess: () => {
      onSaved();
      onDone();
      toast.success("Entry updated", {
        description: "The change is in the audit log, and the person who logged it has been told."
      });
    },
    onError: (err: any) => toast.error("Could not save the change", { description: serverMessage(err, "Try again.") })
  });

  const descriptionLength = form.taskDescription.replace(/<[^>]+>/g, "").trim().length;
  // Mirrors the server's own floors so the button never promises a save the API will refuse.
  const blocked = descriptionLength < 10 || !form.projectId || !form.moduleId || form.startTime >= form.endTime;

  return (
    <div className="grid gap-4 text-sm">
      {entry.status === "APPROVED" && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          These hours are already approved and may sit behind a billing record. The change is
          audited field by field and {entry.user?.name ?? "the submitter"} is notified.
        </p>
      )}
      {entry.status === "SUBMITTED" && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This entry is waiting for a decision. You can still correct it — your approver is told
          that it changed, so they re-read it rather than deciding on what they saw before.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label>Project</Label>
          <Select
            value={form.projectId}
            onValueChange={(v) => setForm((f) => ({ ...f, projectId: v, moduleId: "", submoduleId: "" }))}
          >
            <SelectTrigger><SelectValue placeholder="Select project" /></SelectTrigger>
            <SelectContent>
              {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Module</Label>
          <Select
            value={form.moduleId}
            onValueChange={(v) => setForm((f) => ({ ...f, moduleId: v, submoduleId: "" }))}
            disabled={!selectedProject}
          >
            <SelectTrigger><SelectValue placeholder={selectedProject ? "Select module" : "Pick a project first"} /></SelectTrigger>
            <SelectContent>
              {(selectedProject?.modules ?? []).map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Submodule <span className="text-muted-foreground">(optional)</span></Label>
          <Select
            value={form.submoduleId}
            onValueChange={(v) => setForm((f) => ({ ...f, submoduleId: v }))}
            disabled={!selectedModule || (selectedModule.submodules ?? []).length === 0}
          >
            <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
            <SelectContent>
              {(selectedModule?.submodules ?? []).map((s: any) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid gap-1.5">
          <Label>Activity</Label>
          <Select value={form.activityType} onValueChange={(v) => setForm((f) => ({ ...f, activityType: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {/* The entry's own activity is always offered even if it has since been retired —
                  otherwise editing the start time of an old entry would silently reassign its
                  activity to whatever happened to be first in the list. */}
              {[...new Set([...(activityTypes.data ?? []).map((a) => a.name), entry.activityType])].map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Date</Label>
          <DatePicker
            value={form.workDate}
            onChange={(v) => setForm((f) => ({ ...f, workDate: v }))}
            maxValue={new Date().toISOString().slice(0, 10)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Start</Label>
          <TimeField value={form.startTime} onChange={(v) => setForm((f) => ({ ...f, startTime: v }))} aria-label="Start time" />
        </div>
        <div className="grid gap-1.5">
          <Label>End</Label>
          <TimeField value={form.endTime} onChange={(v) => setForm((f) => ({ ...f, endTime: v }))} aria-label="End time" />
        </div>
      </div>

      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>Task description</Label>
          <span className={descriptionLength < 10 ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {descriptionLength} / min 10
          </span>
        </div>
        <RichTextEditor
          value={form.taskDescription}
          onChange={(html) => setForm((f) => ({ ...f, taskDescription: html }))}
          placeholder="What was built, fixed, documented or reviewed?"
          minHeight="min-h-24"
          maxHeight="max-h-56"
          ariaLabel="Task description"
        />
      </div>

      <div className="grid gap-1.5">
        <Label>Additional notes <span className="text-muted-foreground">(optional)</span></Label>
        <RichTextEditor
          value={form.notes}
          onChange={(html) => setForm((f) => ({ ...f, notes: html }))}
          placeholder="Blockers, dependencies, follow-ups…"
          minHeight="min-h-20"
          maxHeight="max-h-44"
          ariaLabel="Additional notes"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={blocked || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Save changes
        </Button>
        <Button variant="ghost" onClick={onDone}>Discard</Button>
        {form.startTime >= form.endTime && <span className="text-xs text-destructive">End time must be after start.</span>}
      </div>
    </div>
  );
}
