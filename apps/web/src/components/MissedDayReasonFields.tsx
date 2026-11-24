/**
 * V17 A4 — "Why was this day missed?". Shown on the timesheet form when the first entry for a past
 * working day is being logged (the server decides; lib/missed-day-reason.ts). One select from the
 * workspace's enabled reasons, plus a note that becomes required for a reason marked so (OTHER).
 * No approval follows — it is recorded with the entry and never asked again for that day.
 */
import { CalendarX2 } from "lucide-react";
import { useId } from "react";
import type { MissedReasonOption } from "../lib/missed-day-reason";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

export function MissedDayReasonFields({
  date,
  options,
  code,
  note,
  onCodeChange,
  onNoteChange,
  error
}: {
  date: string;
  options: readonly MissedReasonOption[];
  code: string;
  note: string;
  onCodeChange: (code: string) => void;
  onNoteChange: (note: string) => void;
  error: { field: "missedReasonCode" | "missedReasonNote"; message: string } | null;
}) {
  const id = useId();
  const selected = options.find((o) => o.code === code);
  const noteRequired = Boolean(selected?.requiresNote);
  const codeError = error?.field === "missedReasonCode" ? error.message : null;
  const noteError = error?.field === "missedReasonNote" ? error.message : null;

  return (
    <section
      className="grid gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4"
      aria-labelledby={`${id}-title`}
      data-testid="missed-day-reason"
    >
      <div className="flex items-start gap-2">
        <CalendarX2 className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0">
          <p id={`${id}-title`} className="text-sm font-semibold">
            Why was this day missed?
          </p>
          <p className="text-xs text-muted-foreground">
            Nothing was logged for {date} yet. Pick a reason — it is recorded with this entry and you will not be asked again for this day.
          </p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${id}-code`}>Reason</Label>
          <Select value={code} onValueChange={onCodeChange}>
            <SelectTrigger id={`${id}-code`} aria-invalid={Boolean(codeError)} aria-describedby={codeError ? `${id}-code-err` : undefined}>
              <SelectValue placeholder="Choose a reason" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.code} value={o.code}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {codeError && (
            <p id={`${id}-code-err`} className="text-xs font-medium text-destructive">
              {codeError}
            </p>
          )}
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${id}-note`}>
            Note {noteRequired ? <span className="text-destructive">(required)</span> : <span className="text-muted-foreground">(optional)</span>}
          </Label>
          <Textarea
            id={`${id}-note`}
            value={note}
            maxLength={2000}
            onChange={(e) => onNoteChange(e.target.value)}
            className="min-h-[64px]"
            placeholder={noteRequired ? "A few words on what happened" : "Anything your manager should know"}
            aria-invalid={Boolean(noteError)}
            aria-describedby={noteError ? `${id}-note-err` : undefined}
          />
          {noteError && (
            <p id={`${id}-note-err`} className="text-xs font-medium text-destructive">
              {noteError}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
