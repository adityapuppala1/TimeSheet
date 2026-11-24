/**
 * 7.0.0 — the holiday calendar's maxOptionalPerYear: how many optional holidays one person may take
 * per calendar year. Empty = no limit, 0 = none. Optional holidays count as a day off only for the
 * people who opted in on their Holidays screen.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { toast } from "../../components/ui/toaster";
import { attendanceAdminApi } from "../../services/attendance-api";

/** Pure: "" → null (no limit); a whole number 0–366 → that number; anything else → undefined (invalid). */
export function parseOptionalCap(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^\d{1,3}$/.test(t)) return undefined;
  const n = Number(t);
  return n <= 366 ? n : undefined;
}

export function OptionalHolidayCapField({
  calendarId,
  value,
  readOnly,
  onSaved
}: Readonly<{ calendarId: string; value: number | null | undefined; readOnly: boolean; onSaved: () => void }>) {
  const initial = value == null ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  const parsed = parseOptionalCap(draft);
  const save = useMutation({
    mutationFn: (cap: number | null) => attendanceAdminApi.calendars.update(calendarId, { maxOptionalPerYear: cap }),
    onSuccess: () => {
      toast.success("Optional holiday limit saved");
      onSaved();
    },
    onError: () => toast.error("Could not save", { description: "Try again." })
  });
  const id = `opt-cap-${calendarId}`;
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <div className="grid min-w-0 gap-1.5">
        <Label htmlFor={id}>Optional holidays per person per year</Label>
        <Input
          id={id}
          inputMode="numeric"
          className="w-32"
          value={draft}
          placeholder="No limit"
          disabled={readOnly}
          aria-invalid={parsed === undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
      <Button size="sm" variant="outline" disabled={readOnly || parsed === undefined || draft === initial || save.isPending} onClick={() => parsed !== undefined && save.mutate(parsed)}>
        Save limit
      </Button>
      <p id={`${id}-hint`} className="basis-full text-xs text-muted-foreground">
        Leave empty for no limit. An optional holiday is a day off only for people who opt in on their Holidays screen.
      </p>
    </div>
  );
}
