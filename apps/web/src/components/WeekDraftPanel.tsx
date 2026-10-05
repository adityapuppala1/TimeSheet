import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarRange, Check, MessageSquare, RefreshCw, Sparkles, Ticket } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { timesheetApi, type WeekDraftSuggestion } from "../services/api";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { EmptyState } from "./ui/empty-state";
import { Skeleton } from "./ui/skeleton";

/**
 * "Draft my week" — proposes DRAFT rows from the person's own ticket activity, for review.
 *
 * Asked for, never automatic: the panel does nothing until "Find this week's work" is pressed, so
 * somebody logging a single entry is not interrupted. Accepted rows go through the ordinary draft
 * route one by one — every existing rule (overlap, validation) still applies — and they land as
 * DRAFTS: the person edits and submits them themselves. A row the server refuses stays ticked with
 * its reason, so a partial success never silently drops anything.
 */

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function mondayOf(offsetWeeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - offsetWeeks * 7);
  return ymd(d);
}
const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
const rowKey = (s: WeekDraftSuggestion) => `${s.workDate}:${s.ticketId}`;
function sourceLabel(kind: "change" | "comment", count: number): string {
  if (kind === "change") return `${count} ${count === 1 ? "update" : "updates"}`;
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}
/** Promise-returning React Query calls the UI does not await; failures already show in the query state. */
const ignore = () => undefined;
const hoursLabel = (h: number) => `${h % 1 === 0 ? h : h.toFixed(2).replace(/0$/, "")}h`;

export function WeekDraftPanel() {
  const queryClient = useQueryClient();
  const [week, setWeek] = useState<0 | 1>(0);
  const [requested, setRequested] = useState(false);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<number | null>(null);
  const weekStart = mondayOf(week);

  const draft = useQuery({
    queryKey: ["timesheets", "week-draft", weekStart],
    queryFn: () => timesheetApi.weekDraft(weekStart),
    enabled: requested,
    staleTime: 0
  });

  const suggestions = useMemo(() => draft.data?.suggestions ?? [], [draft.data]);
  const selected = suggestions.filter((s) => !unchecked.has(rowKey(s)));
  const selectedHours = selected.reduce((sum, s) => sum + s.hours, 0);
  const byDay = useMemo(() => {
    const map = new Map<string, WeekDraftSuggestion[]>();
    for (const s of suggestions) map.set(s.workDate, [...(map.get(s.workDate) ?? []), s]);
    return [...map.entries()];
  }, [suggestions]);

  const addDrafts = useMutation({
    mutationFn: async (rows: WeekDraftSuggestion[]) => {
      const failed: Record<string, string> = {};
      let ok = 0;
      for (const s of rows) {
        try {
          await timesheetApi.submit(
            {
              projectId: s.projectId,
              moduleId: s.moduleId,
              ticketId: s.ticketId,
              activityType: s.activityType,
              taskDescription: s.taskDescription,
              workDate: s.workDate,
              startTime: s.startTime,
              endTime: s.endTime
            },
            true
          );
          ok++;
        } catch (error) {
          const message = (error as { response?: { data?: { message?: string } } }).response?.data?.message;
          failed[rowKey(s)] = message ?? "This row could not be saved.";
        }
      }
      return { ok, failed };
    },
    onSuccess: ({ ok, failed }) => {
      setFailures(failed);
      setAdded(ok);
      // Re-ask the server: rows that saved are now logged and drop out; refused ones come back,
      // still ticked, with their reason beside them.
      setUnchecked(new Set());
      queryClient.invalidateQueries({ queryKey: ["timesheets"] }).catch(ignore);
    }
  });

  const switchWeek = (next: 0 | 1) => {
    setWeek(next);
    setUnchecked(new Set());
    setFailures({});
    setAdded(null);
  };
  const toggle = (key: string, on: boolean) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card data-testid="week-draft">
      <CardContent className="grid gap-4 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden />
              Draft my week
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Suggested entries from tickets you updated or commented on. Nothing is saved until you add them, and
              they're added as drafts for you to check and submit.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div role="group" aria-label="Week" className="inline-flex rounded-md border border-border p-0.5">
              {([0, 1] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={week === w}
                  onClick={() => switchWeek(w)}
                  className="focus-ring rounded px-2.5 py-1 text-xs font-medium text-muted-foreground aria-pressed:bg-secondary aria-pressed:text-foreground"
                >
                  {w === 0 ? "This week" : "Last week"}
                </button>
              ))}
            </div>
            <Button
              type="button"
              variant={requested ? "outline" : "default"}
              onClick={() => {
                setRequested(true);
                setAdded(null);
                setFailures({});
                if (requested) draft.refetch().catch(ignore);
              }}
              disabled={draft.isFetching}
            >
              {requested ? <RefreshCw className="h-4 w-4" aria-hidden /> : <CalendarRange className="h-4 w-4" aria-hidden />}
              {requested ? "Refresh" : "Find this week's work"}
            </Button>
          </div>
        </div>

        {requested && draft.isFetching && (
          <div className="grid gap-2" aria-busy="true" aria-label="Looking for this week's work">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}

        {requested && draft.isError && !draft.isFetching && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              Couldn't look up your activity. Your existing entries are untouched.
              <Button type="button" size="sm" variant="outline" onClick={() => draft.refetch().catch(ignore)}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {added !== null && added > 0 && (
          <Alert>
            <Check className="h-4 w-4" />
            <AlertDescription>
              Added {added} draft {added === 1 ? "entry" : "entries"}. Review and submit them in{" "}
              <Link to="/app/history" className="font-medium underline underline-offset-2">
                History
              </Link>
              .
            </AlertDescription>
          </Alert>
        )}

        {requested && draft.isSuccess && !draft.isFetching && suggestions.length === 0 && (
          <EmptyState
            compact
            icon={CalendarRange}
            title={week === 0 ? "Nothing to draft this week" : "Nothing to draft last week"}
            description="No ticket activity on days that still have time to log. Log an entry with the form below."
          />
        )}

        {requested && draft.isSuccess && !draft.isFetching && suggestions.length > 0 && (
          <div className="grid gap-4">
            {byDay.map(([day, rows]) => (
              <section key={day} aria-label={dayLabel(day)} className="grid gap-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{dayLabel(day)}</h3>
                <ul className="grid gap-1.5">
                  {rows.map((s) => (
                    <SuggestionRow
                      key={rowKey(s)}
                      suggestion={s}
                      checked={!unchecked.has(rowKey(s))}
                      failure={failures[rowKey(s)]}
                      onToggle={(on) => toggle(rowKey(s), on)}
                    />
                  ))}
                </ul>
              </section>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <span className="text-sm text-muted-foreground">
                {selected.length} of {suggestions.length} selected · {hoursLabel(selectedHours)}
              </span>
              <Button type="button" disabled={selected.length === 0 || addDrafts.isPending} onClick={() => addDrafts.mutate(selected)}>
                <Check className="h-4 w-4" aria-hidden />
                {addDrafts.isPending ? "Adding drafts…" : `Add ${selected.length} as drafts`}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SuggestionRow({
  suggestion: s,
  checked,
  failure,
  onToggle
}: Readonly<{ suggestion: WeekDraftSuggestion; checked: boolean; failure?: string; onToggle: (on: boolean) => void }>) {
  const id = `wd-${rowKey(s)}`;
  return (
    <li className="rounded-md border border-border px-3 py-2">
      <div className="flex items-start gap-3">
        <Checkbox id={id} className="mt-0.5" checked={checked} onCheckedChange={(v) => onToggle(v === true)} />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
          <span className="block truncate text-sm font-medium">{s.taskDescription}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>
              {s.projectName} · {s.moduleName}
            </span>
            {s.moduleGuessed && (
              <Badge variant="warning" title="The ticket has no module; this is the project's first one. Change it on the draft if it's wrong.">
                module guessed
              </Badge>
            )}
            <span>{s.activityType}</span>
            {s.sources.map((src) => (
              <span key={src.kind} className="inline-flex items-center gap-1">
                {src.kind === "change" ? <Ticket className="h-3 w-3" aria-hidden /> : <MessageSquare className="h-3 w-3" aria-hidden />}
                {sourceLabel(src.kind, src.count)}
              </span>
            ))}
          </span>
          {failure && <span className="mt-1 block text-xs text-destructive-ink">Not added: {failure}</span>}
        </label>
        <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          <span className="block text-sm font-medium text-foreground">{hoursLabel(s.hours)}</span>
          {s.startTime}–{s.endTime}
        </span>
      </div>
    </li>
  );
}
