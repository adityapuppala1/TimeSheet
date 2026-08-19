/**
 * WHAT: the change calendar (spec §31) — what is scheduled, when, and what it collides with.
 *
 * WHY A TIMELINE AND NOT A MONTH GRID: a change occupies a WINDOW, usually a few hours inside one
 * night. A month grid renders that as a dot in a box and throws away the only thing anybody opens
 * the calendar to see — whether two windows overlap. Each day here is a 24-hour track with real bars,
 * so an overlap is visible as an overlap rather than as two dots on the same square.
 *
 * BLACKOUT PERIODS ARE DRAWN UNDER THE BARS, not filtered out of them: a change scheduled inside a
 * freeze is exactly what somebody needs to see, and hiding either one would hide the conflict.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { CHANGE_RISK_TONE, CHANGE_STATE_TONE, humanizeChange } from "../lib/change-visuals";
import { TONE_ACCENT_CLASS, type Tone } from "../lib/ticket-visuals";
import { cn } from "../lib/utils";
import { changeApi } from "../services/api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight of the day `offset` days from today. UTC everywhere, matching the windows themselves
 *  — a local-time grid would put a 23:00 UTC change on the wrong row for half the world. */
function utcDay(offset: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

const dayLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** Where a window sits on a 24-hour track, clipped to the day. Returns null when it misses entirely. */
function barGeometry(start: Date, end: Date, day: Date): { left: number; width: number } | null {
  const dayStart = day.getTime();
  const dayEnd = dayStart + DAY_MS;
  const from = Math.max(start.getTime(), dayStart);
  const to = Math.min(end.getTime(), dayEnd);
  if (to <= from) return null;
  // Floored at 1.5% so a fifteen-minute change is still clickable rather than a hairline.
  return { left: ((from - dayStart) / DAY_MS) * 100, width: Math.max(1.5, ((to - from) / DAY_MS) * 100) };
}

export function ChangeCalendarPage() {
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [days] = useState(14);

  const from = useMemo(() => utcDay(offset), [offset]);
  const to = useMemo(() => utcDay(offset + days), [offset, days]);

  const calendar = useQuery({
    queryKey: ["changes", "calendar", from.toISOString(), to.toISOString()],
    queryFn: () => changeApi.calendar(from.toISOString(), to.toISOString())
  });

  const rows = useMemo(() => Array.from({ length: days }, (_, i) => utcDay(offset + i)), [offset, days]);
  const changes = calendar.data?.changes ?? [];
  const blackouts = calendar.data?.blackouts ?? [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <CalendarDays className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight">Change calendar</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Scheduled windows and the freeze periods they have to dodge. All times UTC.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => setOffset((o) => o - days)} aria-label="Previous fortnight">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOffset(0)} disabled={offset === 0}>
            Today
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOffset((o) => o + days)} aria-label="Next fortnight">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4">
          {calendar.isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <div className="grid gap-1">
              {/* Hour ruler. Six labels rather than twenty-four: more would be unreadable at this
                  width and none of them would be read. */}
              <div className="hidden grid-cols-[128px_1fr] gap-2 sm:grid">
                <span />
                <div className="relative h-4 text-[10px] text-muted-foreground">
                  {[0, 4, 8, 12, 16, 20].map((h) => (
                    <span key={h} className="absolute -translate-x-1/2" style={{ left: `${(h / 24) * 100}%` }}>
                      {String(h).padStart(2, "0")}:00
                    </span>
                  ))}
                </div>
              </div>

              {rows.map((day) => {
                const isToday = day.getTime() === utcDay(0).getTime();
                const dayChanges = changes.filter((c) => c.plannedStart && c.plannedEnd && barGeometry(new Date(c.plannedStart), new Date(c.plannedEnd), day));
                const dayBlackouts = blackouts.filter((b) => barGeometry(new Date(b.startsAt), new Date(b.endsAt), day));
                return (
                  <div key={day.toISOString()} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[128px_1fr]">
                    <span className={cn("text-xs", isToday ? "font-semibold text-primary" : "text-muted-foreground")}>
                      {dayLabel(day)}
                    </span>
                    <div className={cn("relative h-9 rounded-md border border-border bg-muted/30", isToday && "ring-1 ring-primary/40")}>
                      {dayBlackouts.map((b) => {
                        const g = barGeometry(new Date(b.startsAt), new Date(b.endsAt), day)!;
                        return (
                          <Tooltip key={`${b.id}-${day.toISOString()}`}>
                            <TooltipTrigger asChild>
                              <div
                                className="absolute inset-y-0 bg-destructive/10 [background-image:repeating-linear-gradient(45deg,transparent,transparent_4px,hsl(var(--destructive)/0.18)_4px,hsl(var(--destructive)/0.18)_8px)]"
                                style={{ left: `${g.left}%`, width: `${g.width}%` }}
                              />
                            </TooltipTrigger>
                            <TooltipContent>Freeze: {b.name}</TooltipContent>
                          </Tooltip>
                        );
                      })}

                      {dayChanges.map((c) => {
                        const g = barGeometry(new Date(c.plannedStart!), new Date(c.plannedEnd!), day)!;
                        const tone = (CHANGE_RISK_TONE[c.riskLevel] ?? "muted") as Tone;
                        return (
                          <Tooltip key={`${c.id}-${day.toISOString()}`}>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => navigate(`/app/changes/${c.id}`)}
                                className={cn(
                                  "absolute inset-y-1 overflow-hidden rounded px-1.5 text-left text-[10px] font-medium text-white transition hover:brightness-110",
                                  TONE_ACCENT_CLASS[tone]
                                )}
                                style={{ left: `${g.left}%`, width: `${g.width}%` }}
                              >
                                <span className="block truncate">{c.changeKey}</span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <span className="block font-semibold">{c.ticket.title}</span>
                              <span className="block text-xs">
                                {c.changeKey} · {humanizeChange(c.state)} · {humanizeChange(c.riskLevel)} risk · {c.environment}
                              </span>
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!calendar.isLoading && changes.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">Nothing is scheduled in this window.</p>
          )}
        </CardContent>
      </Card>

      {blackouts.length > 0 && (
        <Card>
          <CardContent className="grid gap-2 p-3 sm:p-4">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" />
              Freeze periods in this window
            </p>
            {blackouts.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium">{b.name}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(b.startsAt).toISOString().slice(0, 16).replace("T", " ")} →{" "}
                  {new Date(b.endsAt).toISOString().slice(0, 16).replace("T", " ")} UTC
                  {b.environment ? ` · ${b.environment}` : " · all environments"}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("h-2.5 w-4 rounded", TONE_ACCENT_CLASS.destructive)} /> High risk
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("h-2.5 w-4 rounded", TONE_ACCENT_CLASS.warning)} /> Medium
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("h-2.5 w-4 rounded", TONE_ACCENT_CLASS.muted)} /> Low
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded bg-destructive/20" /> Freeze period
        </span>
        <Badge variant={CHANGE_STATE_TONE.SCHEDULED}>Only approved and scheduled work appears here</Badge>
      </div>
    </div>
  );
}
