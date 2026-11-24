/**
 * The approval card (V17 UI v2) — ONE component for every place a leave request waits on someone:
 * the Team rail, the Approvals tab on a phone, and the bulk list.
 *
 * What it shows an approver: who, which type, the dates, the working days, what their balance will be
 * afterwards, the reason the person wrote (if any) and whether a document is attached, and an
 * advisory line when others are off at the same time. The reason is for the APPROVER only (a lead
 * decision): the API returns it solely to whoever may decide the request, and it never appears on a
 * team view, a calendar or in an email.
 *
 * Reject is secondary and needs a comment: it opens an inline field in the card (no modal) and the
 * button stays disabled until there is one.
 */
import { AlertTriangle, Check, Paperclip, X } from "lucide-react";
import { useId, useState } from "react";
import { requestRangeText } from "../../lib/leave-ui";
import { cn } from "../../lib/utils";
import type { LeaveRequestRow } from "../../services/leave-api";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";
import { PersonAvatar } from "./attendance-ui";
import { leaveColour } from "./use-leave";

export interface ApprovalCardProps {
  request: LeaveRequestRow;
  /** "2 others off 24 Nov", advisory only. */
  overlap: string | null;
  busy?: boolean;
  onApprove: () => void;
  onReject: (note: string) => void;
  /** Bulk mode: a checkbox replaces nothing, it sits beside the person. */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  /** After a bulk attempt this request failed: say why, in the card. */
  error?: string | null;
}

/** The reason to show the approver, or null when there is none (or the API withheld it). */
export function approverReason(request: Pick<LeaveRequestRow, "reason">): string | null {
  const text = request.reason?.trim();
  return text || null;
}

export function ApprovalCard({ request, overlap, busy = false, onApprove, onReject, selectable = false, selected = false, onSelect, error }: Readonly<ApprovalCardProps>) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  const name = request.user?.name ?? "Someone";
  const balance = request.balanceAfter;
  const reason = approverReason(request);
  return (
    <li className={cn("grid min-w-0 gap-3 rounded-lg border bg-card p-3", selected ? "border-primary" : "border-border")}>
      <div className="flex min-w-0 items-start gap-3">
        {selectable && (
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelect?.(v === true)}
            aria-label={`Select ${name}'s request`}
            className="mt-2.5 h-5 w-5 shrink-0"
          />
        )}
        <PersonAvatar name={name} avatarUrl={request.user?.avatarUrl} className="h-9 w-9" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: leaveColour(request.leaveType.colour) }} aria-hidden="true" />
            <span className="truncate">{request.leaveType.name}</span>
          </p>
        </div>
      </div>

      <dl className="grid gap-1 text-sm">
        <div className="flex min-w-0 justify-between gap-3">
          <dt className="sr-only">Dates</dt>
          <dd className="font-medium">{requestRangeText(request)}</dd>
        </div>
        {typeof balance === "number" && (
          <div className="flex min-w-0 justify-between gap-3 text-xs text-muted-foreground">
            <dt>Balance after</dt>
            <dd className={cn("font-medium tabular-nums", balance < 0 && "text-foreground")}>{Math.round(balance * 100) / 100} days</dd>
          </div>
        )}
        {reason && (
          <div className="grid gap-0.5 text-xs">
            <dt className="text-muted-foreground">Reason</dt>
            <dd className="whitespace-pre-line break-words text-foreground">{reason}</dd>
          </div>
        )}
        {request.attachment && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Paperclip className="h-3 w-3" aria-hidden="true" />
            Supporting document attached
          </div>
        )}
      </dl>

      {overlap && (
        <p className="flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{overlap}. For your information only.</span>
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive-ink">
          {error}
        </p>
      )}

      {!selectable &&
        (rejecting ? (
          <div className="grid gap-2">
            <label htmlFor={noteId} className="text-xs font-medium">
              Why are you declining? {name.split(" ")[0]} will see this.
            </label>
            <Textarea id={noteId} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" className="min-h-[44px] flex-1" disabled={busy || !note.trim()} onClick={() => onReject(note.trim())}>
                Reject request
              </Button>
              <Button variant="ghost" className="min-h-[44px]" onClick={() => setRejecting(false)}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-[44px] flex-1" disabled={busy} onClick={onApprove}>
              <Check className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Approve
            </Button>
            <Button variant="outline" className="min-h-[44px] flex-1" disabled={busy} onClick={() => setRejecting(true)}>
              <X className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Reject…
            </Button>
          </div>
        ))}
    </li>
  );
}
