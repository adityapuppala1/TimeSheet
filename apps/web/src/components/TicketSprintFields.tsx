/**
 * WHAT: a ticket's sprint and story points, edited in its detail sheet — two controls that save on
 * change through the same PATCH the sheet already uses for priority and module.
 *
 * WHY THE SPRINT LIST IS THE TICKET'S PROJECT'S: the API refuses a sprint from another project
 * (422), so offering one would be offering an error. Completed sprints are listed too, greyed —
 * a ticket can be placed into history for the record, and reading which sprint a closed ticket
 * shipped in is half the point.
 *
 * RENDERS NOTHING when the sprints feature is off, so the sheet is unchanged for every workspace
 * that never turned it on.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { SPRINT_STATUS_LABEL } from "../lib/sprints";
import { usePlanningFeatures } from "../lib/use-planning";
import { sprintApi, ticketApi } from "../services/api";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const NONE = "__none__";

export function TicketSprintFields({
  ticketId,
  projectId,
  sprintId,
  storyPoints,
  canEdit
}: Readonly<{ ticketId: string; projectId: string; sprintId: string | null | undefined; storyPoints: number | string | null | undefined; canEdit: boolean }>) {
  const { features } = usePlanningFeatures();
  const queryClient = useQueryClient();
  const sprints = useQuery({ queryKey: ["sprints", projectId], queryFn: () => sprintApi.list(projectId), enabled: features.sprints });
  const [points, setPoints] = useState(storyPoints === null || storyPoints === undefined ? "" : String(storyPoints));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) setPoints(storyPoints === null || storyPoints === undefined ? "" : String(storyPoints));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync on the stored value only
  }, [storyPoints]);

  const save = useMutation({
    mutationFn: (patch: { sprintId?: string | null; storyPoints?: number | null }) => ticketApi.update(ticketId, patch),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
      queryClient.invalidateQueries({ queryKey: ["sprints"] });
    },
    onError: (err: any) => setError(err?.response?.data?.message ?? "Could not save.")
  });

  if (!features.sprints) return null;
  const current = (sprints.data ?? []).find((s) => s.id === sprintId);

  const commitPoints = () => {
    const raw = points.trim();
    const stored = storyPoints === null || storyPoints === undefined ? "" : String(storyPoints);
    if (raw === stored) {
      setError(null);
      return;
    }
    if (raw === "") return save.mutate({ storyPoints: null });
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || Math.round(n * 2) !== n * 2) {
      setError("Points are whole or half numbers, 0 or more.");
      return;
    }
    save.mutate({ storyPoints: n });
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2" data-ticket-sprint>
      <div className="grid gap-1.5">
        <Label htmlFor={`sprint-${ticketId}`} className="flex items-center gap-1 text-xs uppercase text-muted-foreground">
          Sprint
          {save.isPending && <Loader2 className="h-3 w-3 animate-spin" aria-label="Saving" />}
          {save.isSuccess && !save.isPending && <Check className="h-3 w-3 text-success" aria-label="Saved" />}
        </Label>
        {canEdit ? (
          <Select value={sprintId ?? NONE} onValueChange={(v) => save.mutate({ sprintId: v === NONE ? null : v })} disabled={sprints.isLoading}>
            <SelectTrigger id={`sprint-${ticketId}`}><SelectValue placeholder="Not in a sprint" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not in a sprint</SelectItem>
              {(sprints.data ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} <span className="text-muted-foreground">· {SPRINT_STATUS_LABEL[s.status]}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p id={`sprint-${ticketId}`} className="text-sm">{current ? `${current.name} · ${SPRINT_STATUS_LABEL[current.status]}` : "Not in a sprint"}</p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`points-${ticketId}`} className="text-xs uppercase text-muted-foreground">Story points</Label>
        {canEdit ? (
          <Input
            id={`points-${ticketId}`}
            inputMode="decimal"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            onBlur={commitPoints}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            placeholder="—"
          />
        ) : (
          <p id={`points-${ticketId}`} className="text-sm">{storyPoints === null || storyPoints === undefined ? "—" : String(storyPoints)}</p>
        )}
        {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
      </div>
    </div>
  );
}
