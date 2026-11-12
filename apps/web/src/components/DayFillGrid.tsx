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
import { PLANNED_HOURS_PER_WORKING_DAY } from "@timesheet/shared";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CalendarCheck2, ChevronDown, ChevronRight, Maximize2, Minus, Search } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { EmptyState } from "./ui/empty-state";
import { Input } from "./ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { SearchableSelect } from "./ui/searchable-select";
import { Skeleton } from "./ui/skeleton";
import type { TeamRosterPerson } from "../services/api";
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
  /** Working days already past with nothing logged. */
  gapDays: number;
  hours: number;
  managerId: string | null;
  managerName: string | null;
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

/** The 8h/day plan, shared with the Monday digest email so the card and the email agree. */
const PLANNED_HOURS_PER_DAY = PLANNED_HOURS_PER_WORKING_DAY;

/** Hours logged as a share of planned hours (working days so far × 8h). Can pass 100% — overtime
 *  or weekend work is shown, not capped. "—" when no working day has elapsed yet. */
function percentText(hours: number, expectedDays: number): string {
  const planned = expectedDays * PLANNED_HOURS_PER_DAY;
  return planned > 0 ? `${Math.round((hours / planned) * 100)}%` : "—";
}

/** One column per calendar day of the range (the newest MAX_DAYS of it), each knowing whether work was due. */
function makeCols(rangeFrom: string, rangeTo: string, todayKey: string, working: ReadonlySet<number>) {
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
}

/** Fills a person's totals from their days. A filled day off still counts toward filledDays, so the
 *  ratio can read 6/5 for someone who worked a Saturday — honest, and it never hides their work. The
 *  denominator is working days that have already happened. */
function tallyDays(p: PersonRow, cols: DayCol[]): void {
  for (const c of cols) {
    const entries = p.byDay.get(c.key);
    const filled = Boolean(entries?.length);
    if (filled) {
      p.filledDays += 1;
      p.hours += hoursOf(entries ?? []);
    }
    if (c.expected && !c.upcoming) {
      p.expectedDays += 1;
      if (!filled) p.gapDays += 1;
    }
  }
}

/** Everyone on the roster plus anyone who only appears in the rows, with their days tallied. */
function buildPeople(roster: TeamRosterPerson[] | undefined, rows: FillRow[], cols: DayCol[]): PersonRow[] {
  const byUser = new Map<string, PersonRow>();
  const ensure = (id: string, name: string, managerId: string | null, managerName: string | null) => {
    let p = byUser.get(id);
    if (!p) {
      p = { id, name, byDay: new Map(), filledDays: 0, expectedDays: 0, gapDays: 0, hours: 0, managerId, managerName };
      byUser.set(id, p);
    }
    return p;
  };
  for (const person of roster ?? []) ensure(person.id, person.name, person.managerId, person.managerName);
  const colKeys = new Set(cols.map((c) => c.key));
  for (const row of rows) {
    const key = String(row.workDate).slice(0, 10);
    if (!colKeys.has(key)) continue;
    const p = ensure(row.user?.id ?? row.userId ?? "me", row.user?.name ?? "My entries", null, null);
    const list = p.byDay.get(key) ?? [];
    list.push(row);
    p.byDay.set(key, list);
  }
  for (const p of byUser.values()) tallyDays(p, cols);
  return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
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

/* ------------------------------- grouping & layout ------------------------------- */

/** The bucket for people with no manager (and for a row whose author is not on the roster). */
const NO_MANAGER = "none";
const managerKeyOf = (p: PersonRow) => p.managerId ?? NO_MANAGER;
/** Teams open by default up to this many people on screen; beyond it they start collapsed to one roll-up row each. */
const OPEN_BELOW = 40;
const CARD_PAGE = 25;
const DIALOG_PAGE = 60;

interface GroupStat {
  key: string;
  name: string;
  people: PersonRow[];
  filledDays: number;
  expectedDays: number;
  hours: number;
  gapPeople: number;
  /** How many of the team logged something on each day — the roll-up row's cells. */
  perDay: Map<string, number>;
}

type GridItem = { kind: "group"; group: GroupStat } | { kind: "person"; person: PersonRow };

function buildGroups(people: PersonRow[], cols: DayCol[]): GroupStat[] {
  const map = new Map<string, GroupStat>();
  for (const p of people) {
    const key = managerKeyOf(p);
    let g = map.get(key);
    if (!g) {
      g = { key, name: p.managerName ?? "No manager", people: [], filledDays: 0, expectedDays: 0, hours: 0, gapPeople: 0, perDay: new Map() };
      map.set(key, g);
    }
    g.people.push(p);
    g.filledDays += p.filledDays;
    g.expectedDays += p.expectedDays;
    g.hours += p.hours;
    if (p.gapDays > 0) g.gapPeople += 1;
    for (const c of cols) {
      if (p.byDay.get(c.key)?.length) g.perDay.set(c.key, (g.perDay.get(c.key) ?? 0) + 1);
    }
  }
  return [...map.values()];
}

/** Teams: the unmanaged bucket always last; otherwise by name, or by who needs attention first. */
function orderGroups(groups: GroupStat[], sort: "name" | "missing"): GroupStat[] {
  return [...groups].sort((a, b) => {
    const aNone = a.key === NO_MANAGER;
    if (aNone !== (b.key === NO_MANAGER)) return aNone ? 1 : -1;
    if (sort === "missing" && a.gapPeople !== b.gapPeople) return b.gapPeople - a.gapPeople;
    return a.name.localeCompare(b.name);
  });
}

function orderPeople(people: PersonRow[], sort: "name" | "missing"): PersonRow[] {
  return [...people].sort((a, b) => {
    if (sort === "missing" && a.gapDays !== b.gapDays) return b.gapDays - a.gapDays;
    return a.name.localeCompare(b.name);
  });
}

function filterPeople(people: PersonRow[], f: { manager: string | null; query?: string; onlyMissing?: boolean }): PersonRow[] {
  const q = (f.query ?? "").trim().toLowerCase();
  return people.filter((p) => {
    if (f.manager && managerKeyOf(p) !== f.manager) return false;
    if (q && !p.name.toLowerCase().includes(q)) return false;
    return !f.onlyMissing || p.gapDays > 0;
  });
}

/** Flattens teams into the rows the grid draws, honouring collapsed teams and the page size. */
function buildItems(groups: GroupStat[], grouped: boolean, limit: number, isCollapsed: (key: string) => boolean) {
  const items: GridItem[] = [];
  let used = 0;
  let remaining = 0;
  for (const g of groups) {
    const collapsed = grouped && isCollapsed(g.key);
    const take = collapsed ? [] : g.people.slice(0, Math.max(limit - used, 0));
    if (grouped && (collapsed || take.length > 0)) items.push({ kind: "group", group: g });
    for (const person of take) items.push({ kind: "person", person });
    used += take.length;
    if (!collapsed) remaining += g.people.length - take.length;
  }
  return { items, remaining };
}

function flatGroup(people: PersonRow[]): GroupStat {
  return { key: "all", name: "", people, filledDays: 0, expectedDays: 0, hours: 0, gapPeople: 0, perDay: new Map() };
}

/* ----------------------------------- grid rows ----------------------------------- */

function TotalsCell({ filledDays, expectedDays, hours, strong }: { filledDays: number; expectedDays: number; hours: number; strong?: boolean }) {
  const planned = expectedDays * PLANNED_HOURS_PER_DAY;
  const done = expectedDays > 0 && filledDays >= expectedDays;
  const title = `${hours.toFixed(1)}h logged of ${planned.toFixed(0)}h planned (${PLANNED_HOURS_PER_DAY}h × ${expectedDays} working days so far)`;
  return (
    <div role="cell" className={cn("text-right", strong && "text-[11px]")} title={title}>
      <span className={cn("text-xs font-semibold tabular-nums", done ? "text-emerald-700 dark:text-emerald-300" : "text-foreground")}>
        {filledDays}
        <span className="font-normal text-muted-foreground">/{expectedDays}</span>
      </span>
      <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
        {hours.toFixed(1)}
        {expectedDays > 0 && `/${planned}`}h
      </span>
      <span className="ml-1.5 text-xs font-semibold tabular-nums text-primary">{percentText(hours, expectedDays)}</span>
    </div>
  );
}

function groupDayTone(filled: number, size: number, due: boolean): string {
  if (size > 0 && filled >= size) return "text-emerald-700 dark:text-emerald-300";
  if (filled > 0) return "text-amber-700 dark:text-amber-300";
  return due ? "text-red-700 dark:text-red-300" : "text-muted-foreground/50";
}

/** A team's roll-up row: how many of the team logged on each day, then the team's totals. */
function GroupRow({
  group,
  cols,
  template,
  collapsed,
  onToggle
}: {
  group: GroupStat;
  cols: DayCol[];
  template: CSSProperties;
  collapsed: boolean;
  onToggle: (key: string) => void;
}) {
  const size = group.people.length;
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div role="row" className="grid items-center gap-x-1 rounded-md bg-muted py-1" style={template} data-testid="team-row">
      <div className="sticky left-0 z-10 min-w-0 rounded-l-md bg-muted pl-1 pr-2" role="rowheader">
        <button
          type="button"
          onClick={() => onToggle(group.key)}
          aria-expanded={!collapsed}
          className="focus-ring flex w-full min-w-0 items-center gap-1 rounded text-left"
          title={collapsed ? "Show this team's people" : "Collapse this team"}
        >
          <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold">{group.name}</span>
            <span className="block text-[11px] text-muted-foreground">
              {size} {size === 1 ? "person" : "people"}
              {group.gapPeople > 0 && ` · ${group.gapPeople} with gaps`}
            </span>
          </span>
        </button>
      </div>
      {cols.map((c) => {
        const filled = group.perDay.get(c.key) ?? 0;
        const due = c.expected && !c.upcoming;
        const quiet = filled === 0 && !due;
        return (
          <div
            key={c.key}
            role="cell"
            className={cn("text-center text-[10px] font-semibold tabular-nums", groupDayTone(filled, size, due))}
            title={`${filled} of ${size} logged on ${c.longLabel}`}
          >
            {quiet ? "·" : `${filled}/${size}`}
          </div>
        );
      })}
      <TotalsCell filledDays={group.filledDays} expectedDays={group.expectedDays} hours={group.hours} strong />
    </div>
  );
}

function PersonLine({
  person,
  cols,
  template,
  size,
  indent,
  index
}: {
  person: PersonRow;
  cols: DayCol[];
  template: CSSProperties;
  size: "sm" | "lg";
  indent: boolean;
  index: number;
}) {
  return (
    <div role="row" className="grid items-center gap-x-1 motion-safe:animate-enter" style={{ ...template, animationDelay: `${Math.min(index, 12) * 0.03}s` }}>
      <div className={cn("sticky left-0 z-10 min-w-0 bg-card pr-2", indent && "pl-5")} role="rowheader">
        <p className="truncate text-xs font-semibold" title={person.name}>
          {person.name}
        </p>
        <p className="text-[11px] tabular-nums text-muted-foreground">{person.hours.toFixed(1)}h</p>
      </div>
      {cols.map((c) => (
        <div key={c.key} role="cell" className="flex justify-center">
          <FillCell person={person} col={c} rows={person.byDay.get(c.key) ?? []} size={size} />
        </div>
      ))}
      <TotalsCell filledDays={person.filledDays} expectedDays={person.expectedDays} hours={person.hours} />
    </div>
  );
}

function Grid({
  items,
  cols,
  size,
  grouped,
  isCollapsed,
  onToggle
}: {
  items: GridItem[];
  cols: DayCol[];
  size: "sm" | "lg";
  grouped: boolean;
  isCollapsed: (key: string) => boolean;
  onToggle: (key: string) => void;
}) {
  const cellW = size === "sm" ? "2.25rem" : "3rem";
  const template = { gridTemplateColumns: `minmax(7rem,10rem) repeat(${cols.length}, ${cellW}) 11.5rem` };
  return (
    <div className="overflow-x-auto pb-1">
      <div className="grid w-max min-w-full gap-y-1.5" role="table" aria-label="Daily logging status by person">
        <div className="grid items-end gap-x-1" style={template} role="row">
          <div className="sticky left-0 z-20 bg-card" role="columnheader" aria-label="Person" />
          {cols.map((c) => (
            <div key={c.key} role="columnheader" className={cn("text-center leading-tight", c.isToday ? "text-primary" : "text-muted-foreground")} title={c.longLabel}>
              <span className="block text-[10px] font-semibold uppercase tracking-wide">{c.weekday}</span>
              <span className="block text-[11px] tabular-nums">{c.day}</span>
            </div>
          ))}
          <div className="text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" role="columnheader">
            Days · Hours · Plan
          </div>
        </div>
        {items.map((item, i) => {
          if (item.kind === "group") {
            return (
              <GroupRow key={`g-${item.group.key}`} group={item.group} cols={cols} template={template} collapsed={isCollapsed(item.group.key)} onToggle={onToggle} />
            );
          }
          return <PersonLine key={item.person.id} person={item.person} cols={cols} template={template} size={size} indent={grouped} index={i} />;
        })}
      </div>
    </div>
  );
}

/* --------------------------------- team summary strip --------------------------------- */

interface TeamChipProps {
  title: string;
  sub: string;
  gaps: number;
  pct: string;
  on: boolean;
  onClick: () => void;
}

function TeamChip({ title, sub, gaps, pct, on, onClick }: TeamChipProps) {
  return (
    <button
      type="button"
      data-testid="team-chip"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "focus-ring min-w-[8.5rem] max-w-[13rem] shrink-0 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
        on ? "border-primary bg-primary/10" : "border-border hover:bg-muted"
      )}
    >
      <span className="block truncate text-xs font-semibold" title={title}>
        {title}
      </span>
      <span className="block text-[11px] tabular-nums text-muted-foreground">{sub}</span>
      <span className="mt-0.5 flex items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className="font-semibold text-primary">{pct}</span>
        <Badge variant={gaps > 0 ? "destructive" : "success"} className="px-1.5 py-0 text-[10px]">
          {gaps > 0 ? `${gaps} with gaps` : "on track"}
        </Badge>
      </span>
    </button>
  );
}

/**
 * One chip per manager — people, hours against plan, and how many have gaps — so the card answers
 * "which team needs a nudge" before anyone scrolls. A chip is also the manager filter: pick one and
 * the grid narrows to that team; pick it again (or "All teams") to widen. Scrolls sideways in the card
 * and wraps in the expanded view, so a workspace with many managers never pushes the grid off screen.
 */
function TeamStrip({
  groups,
  overall,
  active,
  onPick,
  wrap
}: {
  groups: GroupStat[];
  overall: { people: number; gapPeople: number; hours: number; expectedDays: number };
  active: string | null;
  onPick: (key: string | null) => void;
  wrap?: boolean;
}) {
  return (
    <div className={cn("-mx-1 flex gap-1.5 px-1 pb-1", wrap ? "flex-wrap" : "overflow-x-auto")} data-testid="team-strip">
      <TeamChip
        title="All teams"
        sub={`${overall.people} people`}
        gaps={overall.gapPeople}
        pct={percentText(overall.hours, overall.expectedDays)}
        on={active === null}
        onClick={() => onPick(null)}
      />
      {groups.map((g) => (
        <TeamChip
          key={g.key}
          title={g.name}
          sub={`${g.people.length} ${g.people.length === 1 ? "person" : "people"}`}
          gaps={g.gapPeople}
          pct={percentText(g.hours, g.expectedDays)}
          on={active === g.key}
          onClick={() => onPick(active === g.key ? null : g.key)}
        />
      ))}
    </div>
  );
}

function Legend({ grouped }: { grouped: boolean }) {
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
      {grouped && <span>Team rows: how many of the team logged that day</span>}
    </div>
  );
}

function ShowMore({ remaining, page, onMore }: { remaining: number; page: number; onMore: () => void }) {
  return (
    <div className="flex justify-center pt-2">
      <Button size="sm" variant="outline" className="h-8" onClick={onMore}>
        Show {Math.min(page, remaining)} more · {remaining} not shown
      </Button>
    </div>
  );
}

/* ------------------------------------- the card ------------------------------------- */

export function DayFillGrid({
  rows,
  roster,
  rangeFrom,
  rangeTo,
  todayKey,
  workingDays,
  loading,
  rangeControl,
  groupable = false
}: {
  /** The page's calendar filter, rendered again inside the expanded dialog (same state). */
  rangeControl?: React.ReactNode;
  /** Show the by-manager teams, chips and filter. Only meaningful for someone who can see more than one team (users:manage). */
  groupable?: boolean;
  rows: FillRow[];
  /** People expected to log. Undefined while loading or if the read failed — the grid then shows only people who appear in `rows`. */
  roster: TeamRosterPerson[] | undefined;
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
  const [managerFilter, setManagerFilter] = useState<string | null>(null);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [cardLimit, setCardLimit] = useState(CARD_PAGE);
  const [dialogLimit, setDialogLimit] = useState(DIALOG_PAGE);

  const working = useMemo(() => new Set(workingDays ?? DEFAULT_WORKING_DAYS), [workingDays]);
  const { cols, truncated } = useMemo(() => makeCols(rangeFrom, rangeTo, todayKey, working), [rangeFrom, rangeTo, todayKey, working]);
  const people = useMemo(() => buildPeople(roster, rows, cols), [roster, rows, cols]);

  // Teams from EVERYONE in scope (not the filtered view) so the chips stay put while you filter.
  const allGroups = useMemo(() => buildGroups(people, cols), [people, cols]);
  const canGroup = groupable && allGroups.length > 1;
  const chipGroups = useMemo(() => orderGroups(allGroups, "missing"), [allGroups]);
  const activeFilter = canGroup ? managerFilter : null;

  const cardPeople = useMemo(() => orderPeople(filterPeople(people, { manager: activeFilter }), sort), [people, activeFilter, sort]);
  const dialogPeople = useMemo(
    () => orderPeople(filterPeople(people, { manager: activeFilter, query: search, onlyMissing }), sort),
    [people, activeFilter, search, onlyMissing, sort]
  );

  // One open/closed rule for both views, decided by the team-filtered headcount: a big workspace starts
  // as a column of team roll-ups, a filtered or small one starts open. `toggled` flips from that default.
  const defaultOpen = cardPeople.length <= OPEN_BELOW;
  const isCollapsed = (key: string) => defaultOpen === toggled.has(key);
  const toggleGroup = (key: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const setAllCollapsed = (collapse: boolean) => setToggled(defaultOpen === collapse ? new Set(allGroups.map((g) => g.key)) : new Set());
  const pickManager = (key: string | null) => {
    setManagerFilter(key);
    setCardLimit(CARD_PAGE);
    setDialogLimit(DIALOG_PAGE);
  };

  const layout = (list: PersonRow[], limit: number) => {
    const groups = canGroup ? orderGroups(buildGroups(list, cols), sort) : [flatGroup(list)];
    return buildItems(groups, canGroup, limit, isCollapsed);
  };
  const cardLayout = layout(cardPeople, cardLimit);
  const dialogLayout = layout(dialogPeople, dialogLimit);

  const totalEntries = people.reduce((s, p) => s + [...p.byDay.values()].reduce((n, l) => n + l.length, 0), 0);
  const peopleWithGaps = people.filter((p) => p.gapDays > 0).length;
  const overall = {
    people: people.length,
    gapPeople: peopleWithGaps,
    hours: people.reduce((s, p) => s + p.hours, 0),
    expectedDays: people.reduce((s, p) => s + p.expectedDays, 0)
  };

  let gapsNote = "";
  if (peopleWithGaps > 0) gapsNote = ` · ${peopleWithGaps} with unfilled working days`;
  else if (people.length > 0) gapsNote = " · everyone is up to date";
  const teamsNote = canGroup ? ` · ${allGroups.length} teams` : "";

  const summary = (
    <>
      {people.length} {people.length === 1 ? "person" : "people"}
      {teamsNote} · {totalEntries} {totalEntries === 1 ? "entry" : "entries"} across {cols.length} {cols.length === 1 ? "day" : "days"}
      {gapsNote}
    </>
  );

  let body: React.ReactNode;
  if (loading) {
    body = <Skeleton className="h-28 w-full" />;
  } else if (people.length === 0) {
    body = <EmptyState compact title="No one to show yet" />;
  } else {
    body = (
      <>
        {canGroup && <TeamStrip groups={chipGroups} overall={overall} active={activeFilter} onPick={pickManager} />}
        <div className="max-h-72 overflow-y-auto pr-1" data-testid="day-fill-grid">
          <Grid items={cardLayout.items} cols={cols} size="sm" grouped={canGroup} isCollapsed={isCollapsed} onToggle={toggleGroup} />
          {cardLayout.remaining > 0 && <ShowMore remaining={cardLayout.remaining} page={CARD_PAGE} onMore={() => setCardLimit((n) => n + CARD_PAGE)} />}
        </div>
        <Legend grouped={canGroup} />
      </>
    );
  }

  const managerOptions = allGroups.map((g) => ({ id: g.key, name: g.name }));

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
      <CardContent className="grid gap-3">{body}</CardContent>

      <Dialog
        open={expanded}
        onOpenChange={(open) => {
          setExpanded(open);
          if (!open) {
            setSearch("");
            setOnlyMissing(false);
            setDialogLimit(DIALOG_PAGE);
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
          {canGroup && <TeamStrip groups={chipGroups} overall={overall} active={activeFilter} onPick={pickManager} wrap />}
          <div className="flex flex-wrap items-center gap-2">
            {rangeControl}
            {canGroup && (
              <div className="w-56">
                <SearchableSelect
                  options={managerOptions}
                  value={activeFilter ?? ""}
                  onChange={(v) => pickManager(v || null)}
                  placeholder="All managers"
                  searchPlaceholder="Find a manager…"
                  clearable
                  clearLabel="All managers"
                />
              </div>
            )}
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
            {canGroup && (
              <>
                <Button size="sm" variant="outline" className="h-8" onClick={() => setAllCollapsed(false)}>
                  Expand all
                </Button>
                <Button size="sm" variant="outline" className="h-8" onClick={() => setAllCollapsed(true)}>
                  Collapse all
                </Button>
              </>
            )}
          </div>
          <div className="max-h-[56vh] overflow-y-auto pr-1">
            {dialogPeople.length > 0 ? (
              <>
                <Grid items={dialogLayout.items} cols={cols} size="lg" grouped={canGroup} isCollapsed={isCollapsed} onToggle={toggleGroup} />
                {dialogLayout.remaining > 0 && (
                  <ShowMore remaining={dialogLayout.remaining} page={DIALOG_PAGE} onMore={() => setDialogLimit((n) => n + DIALOG_PAGE)} />
                )}
              </>
            ) : (
              <div className="flex h-16 items-center justify-center rounded-lg border border-border bg-muted/20 text-sm text-muted-foreground">
                No one matches that filter.
              </div>
            )}
          </div>
          <Legend grouped={canGroup} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}
