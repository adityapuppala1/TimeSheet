/**
 * WHAT: "Daily logging status" — one row per person, one column per calendar day in the page's
 * selected range, each cell light green (something was logged, even a single entry) or light red
 * (a working day that has passed with nothing logged). The number in a green cell is the entry count.
 * Hovering (or tapping / focusing) a cell lists that person's activities, durations, projects and the
 * day's total.
 *
 * WHY IT TAKES ROWS + A ROSTER, NOT JUST ROWS: entries can only ever say who DID log. "Not filled" is
 * the absence of rows, so the people expected to log come from the team roster; anyone in the rows
 * but not the roster (since deactivated) is still shown so their hours are never dropped.
 *
 * WHY WEEKENDS / FUTURE DAYS ARE NEUTRAL: red must mean "should have logged and did not". A day off
 * (per the workspace's working week) or a day that has not happened yet is grey, never red — unless
 * something WAS logged on it, in which case it is green like any other day.
 *
 * Colour is never the only channel: filled cells carry the count, missing cells carry a minus, and
 * the popover spells the state out in words.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarCheck2, Maximize2, Minus, Search } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { EmptyState } from "./ui/empty-state";
import { Input } from "./ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { addLocalDays, isoToLocalDate, localDateKey } from "../lib/local-day";
import { cn } from "../lib/utils";

export interface FillRow {
  id: string;
  workDate: string;
  startTime: string;
  endTime: string;
  totalHours: number | string;
  status: string;
  activityType?: string;
  project?: { name?: string; code?: string };
  user?: { id?: string; name?: string };
  userId?: string;
}

type CellState = "filled" | "missing" | "off" | "upcoming";

interface DayCol {
  key: string;
  weekday: string;
  day: string;
  longLabel: string;
  isToday: boolean;
  /** A day the workspace expects timesheets on. */
  expected: boolean;
  upcoming: boolean;
}

interface PersonRow {
  id: string;
  name: string;
  byDay: Map<string, FillRow[]>;
  filledDays: number;
  expectedDays: number;
  hours: number;
}

/** Keeps a very long range from rendering hundreds of columns; the newest days are the ones that matter. */
const MAX_DAYS = 62;
const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

const CELL_TONE: Record<CellState, string> = {
  filled: "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 hover:bg-emerald-500/25 dark:text-emerald-200",
  missing: "border-red-500/35 bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300",
  off: "border-dashed border-border bg-muted/30 text-muted-foreground/60 hover:bg-muted/50",
  upcoming: "border-dashed border-border bg-transparent text-muted-foreground/50 hover:bg-muted/30"
};

const STATE_WORDS: Record<CellState, string> = {
  filled: "Filled",
  missing: "Not filled",
  off: "Day off",
  upcoming: "Not yet"
};

/** The same 8h/day target the rest of the dashboard measures utilisation against. */
const PLANNED_HOURS_PER_DAY = 8;

/** Hours logged as a share of planned hours (working days so far × 8h). Can pass 100% — overtime
 *  or weekend work is shown, not capped. "—" when no working day has elapsed yet. */
function plannedPercent(p: PersonRow): string {
  const planned = p.expectedDays * PLANNED_HOURS_PER_DAY;
  return planned > 0 ? `${Math.round((p.hours / planned) * 100)}%` : "—";
}

const STATE_BADGE: Record<CellState, "success" | "destructive" | "muted"> = {
  filled: "success",
  missing: "destructive",
  off: "muted",
  upcoming: "muted"
};

const STATE_EMPTY_TEXT: Record<CellState, string> = {
  filled: "",
  missing: "Nothing was logged on this working day.",
  off: "Not a working day — nothing expected.",
  upcoming: "This day has not happened yet."
};

/** "2 entries, 5.00 hours" for the cell's accessible name; empty when nothing was logged. */
function entriesNote(rows: FillRow[]): string {
  if (rows.length === 0) return "";
  const noun = rows.length === 1 ? "entry" : "entries";
  return `, ${rows.length} ${noun}, ${hoursOf(rows).toFixed(2)} hours`;
}

/** What sits inside a cell: the entry count, a minus for a missed working day, nothing otherwise. */
function cellContent(state: CellState, rows: FillRow[]): React.ReactNode {
  if (state === "filled") return rows.length;
  if (state === "missing") return <Minus className="h-3.5 w-3.5" aria-hidden />;
  return null;
}

function hoursOf(rows: FillRow[]): number {
  return rows.reduce((sum, r) => sum + Number(r.totalHours ?? 0), 0);
}

function stateOf(col: DayCol, rows: FillRow[] | undefined): CellState {
  if (rows && rows.length > 0) return "filled";
  if (col.upcoming) return "upcoming";
  return col.expected ? "missing" : "off";
}

/** Entry detail for one cell — the hover card's body, shared by card and dialog. */
function CellDetail({ person, col, rows, state }: { person: PersonRow; col: DayCol; rows: FillRow[]; state: CellState }) {
  const total = hoursOf(rows);
  const sorted = [...rows].sort((a, b) => a.startTime.localeCompare(b.startTime));
  return (
    <div className="grid gap-2 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{person.name}</p>
          <p className="text-xs text-muted-foreground">{col.longLabel}</p>
        </div>
        <Badge variant={STATE_BADGE[state]} className="shrink-0">
          {STATE_WORDS[state]}
        </Badge>
      </div>
      {sorted.length > 0 ? (
        <>
          <ul className="grid max-h-56 gap-1.5 overflow-y-auto pr-0.5">
            {sorted.map((r) => (
              <li key={r.id} className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-medium">{r.project?.name ?? "No project"}</span>
                  <span className="shrink-0 text-xs font-semibold tabular-nums">{Number(r.totalHours ?? 0).toFixed(2)}h</span>
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {r.activityType ?? "Activity"} · {r.startTime}–{r.endTime}
                </p>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-border pt-2 text-xs">
            <span className="text-muted-foreground">
              {sorted.length} {sorted.length === 1 ? "entry" : "entries"}
            </span>
            <span className="font-semibold tabular-nums">Total {total.toFixed(2)}h</span>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{STATE_EMPTY_TEXT[state]}</p>
      )}
    </div>
  );
}

/**
 * One cell. Open on hover (with a short close delay so the pointer can travel onto the card), on
 * keyboard focus, and on tap — a hover-only card would be unreachable on touch and by keyboard.
 */
function FillCell({ person, col, rows, size }: { person: PersonRow; col: DayCol; rows: FillRow[]; size: "sm" | "lg" }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const state = stateOf(col, rows);
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 120);
  };
  const label = `${person.name}, ${col.longLabel}: ${STATE_WORDS[state]}${entriesNote(rows)}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          type="button"
          data-testid="fill-cell"
          data-state-kind={state}
          aria-label={label}
          onMouseEnter={show}
          onMouseLeave={hide}
          onFocus={show}
          onBlur={hide}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "focus-ring relative flex items-center justify-center rounded-md border text-xs font-semibold tabular-nums transition-all duration-150 hover:z-10 motion-safe:hover:scale-110",
            col.isToday && "ring-2 ring-primary/60 ring-offset-1 ring-offset-background",
            size === "sm" ? "h-8 w-9" : "h-10 w-12",
            CELL_TONE[state]
          )}
        >
          {cellContent(state, rows)}
        </button>
      </PopoverAnchor>
      <PopoverContent className="w-80" side="top" onMouseEnter={show} onMouseLeave={hide} onOpenAutoFocus={(e) => e.preventDefault()}>
        <CellDetail person={person} col={col} rows={rows} state={state} />
      </PopoverContent>
    </Popover>
  );
}

function Grid({ people, cols, size }: { people: PersonRow[]; cols: DayCol[]; size: "sm" | "lg" }) {
  const cellW = size === "sm" ? "2.25rem" : "3rem";
  const template = { gridTemplateColumns: `minmax(7rem,10rem) repeat(${cols.length}, ${cellW}) 11.5rem` };
  return (
    <div className="overflow-x-auto pb-1">
      <div className="grid w-max min-w-full gap-y-1.5" role="table" aria-label="Daily logging status by person">
        <div className="grid items-end gap-x-1" style={template} role="row">
          <div className="sticky left-0 z-20 bg-card" role="columnheader" aria-label="Person" />
          {cols.map((c) => (
            <div
              key={c.key}
              role="columnheader"
              className={cn("text-center leading-tight", c.isToday ? "text-primary" : "text-muted-foreground")}
              title={c.longLabel}
            >
              <span className="block text-[10px] font-semibold uppercase tracking-wide">{c.weekday}</span>
              <span className="block text-[11px] tabular-nums">{c.day}</span>
            </div>
          ))}
          <div className="text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" role="columnheader">
            Days · Hours · Plan
          </div>
        </div>
        {people.map((p, i) => (
          <div
            key={p.id}
            role="row"
            className="grid items-center gap-x-1 motion-safe:animate-enter"
            style={{ ...template, animationDelay: `${Math.min(i, 12) * 0.03}s` }}
          >
            <div className="sticky left-0 z-10 min-w-0 bg-card pr-2" role="rowheader">
              <p className="truncate text-xs font-semibold" title={p.name}>
                {p.name}
              </p>
              <p className="text-[11px] tabular-nums text-muted-foreground">{p.hours.toFixed(1)}h</p>
            </div>
            {cols.map((c) => (
              <div key={c.key} role="cell" className="flex justify-center">
                <FillCell person={p} col={c} rows={p.byDay.get(c.key) ?? []} size={size} />
              </div>
            ))}
            <div role="cell" className="text-right" title={`${p.hours.toFixed(1)}h logged of ${(p.expectedDays * PLANNED_HOURS_PER_DAY).toFixed(0)}h planned (${PLANNED_HOURS_PER_DAY}h × ${p.expectedDays} working days so far)`}>
              <span
                className={cn(
                  "text-xs font-semibold tabular-nums",
                  p.expectedDays > 0 && p.filledDays >= p.expectedDays ? "text-emerald-700 dark:text-emerald-300" : "text-foreground"
                )}
              >
                {p.filledDays}
                <span className="font-normal text-muted-foreground">/{p.expectedDays}</span>
              </span>
              <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
                {p.hours.toFixed(1)}
                {p.expectedDays > 0 && `/${p.expectedDays * PLANNED_HOURS_PER_DAY}`}h
              </span>
              <span className="ml-1.5 text-xs font-semibold tabular-nums text-primary">{plannedPercent(p)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend() {
  const item = (tone: string, text: string, glyph?: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-flex h-4 w-5 items-center justify-center rounded border text-[10px] font-semibold", tone)} aria-hidden>
        {glyph}
      </span>
      {text}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {item(CELL_TONE.filled, "Filled — number is the entry count", "2")}
      {item(CELL_TONE.missing, "Not filled (working day)", "–")}
      {item(CELL_TONE.off, "Day off")}
      {item(CELL_TONE.upcoming, "Not yet")}
    </div>
  );
}

export function DayFillGrid({
  rows,
  roster,
  rangeFrom,
  rangeTo,
  todayKey,
  workingDays,
  loading,
  rangeControl
}: {
  /** The page's calendar filter, rendered again inside the expanded dialog (same state). */
  rangeControl?: React.ReactNode;
  rows: FillRow[];
  /** People expected to log. Undefined while loading or if the read failed — the grid then shows only people who appear in `rows`. */
  roster: Array<{ id: string; name: string }> | undefined;
  rangeFrom: string;
  rangeTo: string;
  todayKey: string;
  workingDays: readonly number[] | undefined;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"name" | "missing">("name");
  const [onlyMissing, setOnlyMissing] = useState(false);

  const working = useMemo(() => new Set(workingDays ?? DEFAULT_WORKING_DAYS), [workingDays]);

  const { cols, truncated } = useMemo(() => {
    const start = isoToLocalDate(rangeFrom);
    const end = isoToLocalDate(rangeTo);
    const out: DayCol[] = [];
    if (start && end) {
      for (let d = start; d <= end && out.length < 400; d = addLocalDays(d, 1)) {
        const key = localDateKey(d);
        out.push({
          key,
          weekday: d.toLocaleDateString(undefined, { weekday: "short" }),
          day: String(d.getDate()),
          longLabel: d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", year: "numeric" }),
          isToday: key === todayKey,
          expected: working.has(d.getDay()),
          upcoming: key > todayKey
        });
      }
    }
    const cut = out.length > MAX_DAYS;
    return { cols: cut ? out.slice(-MAX_DAYS) : out, truncated: cut };
  }, [rangeFrom, rangeTo, todayKey, working]);

  const people = useMemo<PersonRow[]>(() => {
    const byUser = new Map<string, PersonRow>();
    const ensure = (id: string, name: string) => {
      let p = byUser.get(id);
      if (!p) {
        p = { id, name, byDay: new Map(), filledDays: 0, expectedDays: 0, hours: 0 };
        byUser.set(id, p);
      }
      return p;
    };
    for (const person of roster ?? []) ensure(person.id, person.name);
    const colKeys = new Set(cols.map((c) => c.key));
    for (const row of rows) {
      const id = row.user?.id ?? row.userId ?? "me";
      const key = String(row.workDate).slice(0, 10);
      if (!colKeys.has(key)) continue;
      const p = ensure(id, row.user?.name ?? "My entries");
      const list = p.byDay.get(key) ?? [];
      list.push(row);
      p.byDay.set(key, list);
    }
    for (const p of byUser.values()) {
      for (const c of cols) {
        const entries = p.byDay.get(c.key);
        if (entries?.length) {
          p.filledDays += 1;
          p.hours += hoursOf(entries);
        }
        // Denominator: working days that have already happened. A filled day off still counts toward
        // filledDays, so the ratio can read 6/5 for someone who worked a Saturday — honest, and it
        // never hides their work.
        if (c.expected && !c.upcoming) p.expectedDays += 1;
      }
    }
    return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, roster, cols]);

  const missingOf = (p: PersonRow) => cols.filter((c) => c.expected && !c.upcoming && !p.byDay.get(c.key)?.length).length;

  const totalEntries = people.reduce((s, p) => s + [...p.byDay.values()].reduce((n, l) => n + l.length, 0), 0);
  const peopleWithGaps = people.filter((p) => missingOf(p) > 0).length;

  const q = search.trim().toLowerCase();
  const shown = people
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .filter((p) => !onlyMissing || missingOf(p) > 0)
    .sort((a, b) => (sort === "missing" ? missingOf(b) - missingOf(a) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)));

  let gapsNote = "";
  if (peopleWithGaps > 0) gapsNote = ` · ${peopleWithGaps} with unfilled working days`;
  else if (people.length > 0) gapsNote = " · everyone is up to date";

  let body: React.ReactNode;
  if (loading) {
    body = <Skeleton className="h-28 w-full" />;
  } else if (people.length === 0) {
    body = <EmptyState compact title="No one to show yet" />;
  } else {
    body = (
      <>
        <div className="max-h-64 overflow-y-auto pr-1" data-testid="day-fill-grid">
          <Grid people={people} cols={cols} size="sm" />
        </div>
        <Legend />
      </>
    );
  }

  const summary = (
    <>
      {people.length} {people.length === 1 ? "person" : "people"} · {totalEntries} {totalEntries === 1 ? "entry" : "entries"} across {cols.length}{" "}
      {cols.length === 1 ? "day" : "days"}
      {gapsNote}
    </>
  );

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 pb-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 lg:flex-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarCheck2 className="h-4 w-4 text-primary" />
            Daily logging status
          </CardTitle>
          <CardDescription>
            One row per person, one cell per day — green if anything was logged, red if a working day passed with nothing. Follows the date
            range at the top of the page. {!loading && <span className="font-medium text-foreground">{summary}</span>}
            {truncated && ` Showing the latest ${MAX_DAYS} days of the range.`}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8"
            onClick={() => setExpanded(true)}
            aria-label="Expand the daily logging status"
            title="Expand the daily logging status"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {body}
      </CardContent>

      <Dialog
        open={expanded}
        onOpenChange={(open) => {
          setExpanded(open);
          if (!open) {
            setSearch("");
            setOnlyMissing(false);
          }
        }}
      >
        <DialogContent className="w-[96vw] max-w-[min(96vw,1400px)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarCheck2 className="h-4 w-4 text-primary" />
              Daily logging status
            </DialogTitle>
            <DialogDescription>{summary}. Hover or tap a cell for that day's activities.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            {rangeControl}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter people…" className="h-8 w-56 pl-7" />
            </div>
            <Select value={sort} onValueChange={(v) => setSort(v as "name" | "missing")}>
              <SelectTrigger className="h-8 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name A–Z</SelectItem>
                <SelectItem value="missing">Most unfilled days</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant={onlyMissing ? "default" : "outline"} className="h-8" aria-pressed={onlyMissing} onClick={() => setOnlyMissing((v) => !v)}>
              Only people with gaps
            </Button>
          </div>
          <div className="max-h-[62vh] overflow-y-auto pr-1">
            {shown.length > 0 ? (
              <Grid people={shown} cols={cols} size="lg" />
            ) : (
              <div className="flex h-16 items-center justify-center rounded-lg border border-border bg-muted/20 text-sm text-muted-foreground">
                No one matches that filter.
              </div>
            )}
          </div>
          <Legend />
        </DialogContent>
      </Dialog>
    </Card>
  );
}
