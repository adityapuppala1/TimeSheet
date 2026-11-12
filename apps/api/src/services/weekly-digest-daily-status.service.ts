/**
 * WHAT: the "Daily logging status" section of the Monday digest — for last week, which days each
 * person logged something and which working days they did not, with days filled, hours against plan
 * and the percentage. The email twin of the Daily logging status card on the home page, built on the
 * same definitions so the two can never tell different stories about the same week.
 *
 * WHO SEES WHOM (the same rule the home page applies, decided here and never in a template):
 *   SELF — a person with no reports and no `users:manage`: just themselves.
 *   TEAM — somebody who manages people: their direct reports, plus themselves.
 *   ALL  — `users:manage` (SUPER_ADMIN / ADMIN): everyone active.
 * This is deliberately NOT the digest's own SELF/TEAM/WORKSPACE scope. That one is keyed on
 * `reports:view`, which MANAGER and TEAM_LEAD hold too, so a manager would be handed the whole
 * workspace here. `GET /timesheets/team-roster` and the dashboard use `users:manage`; so does this.
 *
 * DEFINITIONS (all shared with the card):
 *   filled  — at least one entry that day, in ANY status. One entry is enough.
 *   missing — a WORKING day (the workspace's own working week) with nothing logged.
 *   off     — a day that is not a working day and has nothing on it. Never red.
 *   plan    — PLANNED_HOURS_PER_WORKING_DAY (8h) for every working day in the week.
 *   hours   — everything logged, drafts and pending included, because the question here is "did
 *             they fill their time", not "was it approved". The rest of the digest counts APPROVED
 *             hours, so the footnote says so, or two different hours figures in one email would read
 *             as a bug.
 *
 * WHY A CAP ON ROWS: an administrator's email would otherwise carry a row for every person in the
 * workspace. The rows shown are the people with the MOST unfilled days, which are the ones worth
 * reading, and the by-team table above them still counts everyone.
 *
 * The model (`buildDailyStatus`) and the HTML (`renderDailyStatus`) are pure; only
 * `dailyStatusTables` touches the database.
 */
import { PLANNED_HOURS_PER_WORKING_DAY, permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { emailBlocks } from "./mail-templates.js";
import { getPlanningSettings } from "./planning.service.js";
import type { Period } from "./weekly-digest-data.service.js";

const { dataTable, periodStrip, share, escape } = emailBlocks;

export type FillScope = "SELF" | "TEAM" | "ALL";

/** Whose daily status a recipient's digest carries. Pure — resolved from what they hold and manage. */
export function fillScopeFor(perms: readonly string[], reportCount: number): FillScope {
  if (perms.includes(permissions.USERS_MANAGE)) return "ALL";
  return reportCount > 0 ? "TEAM" : "SELF";
}

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

export interface DayInfo {
  /** `YYYY-MM-DD` — the UTC day `workDate` is stored at. */
  key: string;
  weekday: string;
  day: string;
  /** A day the workspace expects timesheets on. */
  due: boolean;
}

export interface RosterPerson {
  id: string;
  name: string;
  managerId: string | null;
  managerName: string | null;
}

export interface DayFigure {
  entries: number;
  hours: number;
}

export type CellState = "filled" | "missing" | "off";

export interface PersonStatus extends RosterPerson {
  cells: Array<{ state: CellState; entries: number }>;
  /** Days with anything logged — a filled day off counts, so this can pass `dueDays`. */
  filledDays: number;
  /** Working days in the week. */
  dueDays: number;
  /** Working days with nothing logged. */
  gapDays: number;
  hours: number;
}

export interface TeamStatus {
  key: string;
  name: string;
  people: number;
  filledDays: number;
  dueDays: number;
  hours: number;
  gapPeople: number;
}

export interface DailyStatus {
  days: DayInfo[];
  /** Most unfilled days first, then by name. */
  people: PersonStatus[];
  /** Most people with gaps first; the unmanaged bucket last. */
  teams: TeamStatus[];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NO_MANAGER = "none";

/** The days of `[from, to)`, both UTC-midnight dates, marked with whether work was due. */
export function weekDays(from: Date, to: Date, workingDays: readonly number[]): DayInfo[] {
  const working = new Set(workingDays);
  const days: DayInfo[] = [];
  for (let d = new Date(from); d < to && days.length < 31; d = new Date(d.getTime() + 24 * 3_600_000)) {
    days.push({
      key: d.toISOString().slice(0, 10),
      weekday: WEEKDAYS[d.getUTCDay()],
      day: String(d.getUTCDate()),
      due: working.has(d.getUTCDay())
    });
  }
  return days;
}

function statusOf(person: RosterPerson, days: DayInfo[], figures: ReadonlyMap<string, DayFigure> | undefined): PersonStatus {
  const status: PersonStatus = { ...person, cells: [], filledDays: 0, dueDays: 0, gapDays: 0, hours: 0 };
  for (const day of days) {
    const figure = figures?.get(day.key);
    const filled = (figure?.entries ?? 0) > 0;
    if (filled) {
      status.filledDays += 1;
      status.hours += figure?.hours ?? 0;
    }
    if (day.due) {
      status.dueDays += 1;
      if (!filled) status.gapDays += 1;
    }
    let state: CellState = "off";
    if (filled) state = "filled";
    else if (day.due) state = "missing";
    status.cells.push({ state, entries: figure?.entries ?? 0 });
  }
  return status;
}

function teamsOf(people: PersonStatus[]): TeamStatus[] {
  const map = new Map<string, TeamStatus>();
  for (const p of people) {
    const key = p.managerId ?? NO_MANAGER;
    let team = map.get(key);
    if (!team) {
      team = { key, name: p.managerName ?? "No manager", people: 0, filledDays: 0, dueDays: 0, hours: 0, gapPeople: 0 };
      map.set(key, team);
    }
    team.people += 1;
    team.filledDays += p.filledDays;
    team.dueDays += p.dueDays;
    team.hours += p.hours;
    if (p.gapDays > 0) team.gapPeople += 1;
  }
  return [...map.values()].sort((a, b) => {
    const aNone = a.key === NO_MANAGER;
    if (aNone !== (b.key === NO_MANAGER)) return aNone ? 1 : -1;
    return b.gapPeople - a.gapPeople || a.name.localeCompare(b.name);
  });
}

/** Turns a roster and the week's per-day figures into the status the email renders. */
export function buildDailyStatus(params: {
  days: DayInfo[];
  roster: RosterPerson[];
  /** userId -> (day key -> figure). A person absent from the map simply logged nothing. */
  figures: ReadonlyMap<string, ReadonlyMap<string, DayFigure>>;
}): DailyStatus {
  const people = params.roster
    .map((person) => statusOf(person, params.days, params.figures.get(person.id)))
    .sort((a, b) => b.gapDays - a.gapDays || a.name.localeCompare(b.name));
  return { days: params.days, people, teams: teamsOf(people) };
}

/* ------------------------------------------------------------------ *
 * The HTML
 * ------------------------------------------------------------------ */

const hoursLabel = (n: number) => `${n.toFixed(1)}h`;
const plannedFor = (dueDays: number) => dueDays * PLANNED_HOURS_PER_WORKING_DAY;
/** Hours as a share of plan; an em dash when nothing was planned ("0%" of nothing is a claim). */
const planShare = (hours: number, dueDays: number) => share(hours, plannedFor(dueDays));

/** Light green / light red / grey, with the same meaning as the home page card. Inline styles only —
 *  mail clients drop <style> blocks and class names. */
const TONE: Record<CellState, { bg: string; fg: string }> = {
  filled: { bg: "#DCFCE7", fg: "#166534" },
  missing: { bg: "#FEE2E2", fg: "#991B1B" },
  off: { bg: "#F1F5F9", fg: "#94A3B8" }
};

const SECTION_HEADING = "margin:26px 0 4px;font-size:13px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:#0F172A;";
const HEAD_CELL = "padding:6px 4px;font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:.4px;font-weight:700;border-bottom:1px solid #E2E8F0;";
const BODY_CELL = "padding:5px 4px;font-size:12px;color:#0F172A;border-bottom:1px solid #EEF2F7;font-variant-numeric:tabular-nums;";

function dayCell(cell: { state: CellState; entries: number }): string {
  const tone = TONE[cell.state];
  let content = "·";
  if (cell.state === "filled") content = String(cell.entries);
  else if (cell.state === "missing") content = "–";
  return `<td align="center" style="padding:3px 2px;border-bottom:1px solid #EEF2F7;"><div style="background:${tone.bg};color:${tone.fg};border-radius:6px;min-width:26px;padding:5px 0;font-size:12px;font-weight:700;text-align:center;">${content}</div></td>`;
}

function personRow(p: PersonStatus, isRecipient: boolean): string {
  const you = isRecipient ? ' <span style="color:#64748B;">(you)</span>' : "";
  return `<tr>
    <td style="${BODY_CELL}font-weight:600;">${escape(p.name)}${you}</td>
    ${p.cells.map(dayCell).join("")}
    <td align="right" style="${BODY_CELL}">${p.filledDays}/${p.dueDays}</td>
    <td align="right" style="${BODY_CELL}">${hoursLabel(p.hours)}/${plannedFor(p.dueDays)}h</td>
    <td align="right" style="${BODY_CELL}font-weight:700;color:#0F766E;">${planShare(p.hours, p.dueDays)}</td>
  </tr>`;
}

function peopleTable(status: DailyStatus, recipientId: string, rows: PersonStatus[]): string {
  const head = status.days
    .map(
      (d) =>
        `<td align="center" style="${HEAD_CELL}">${escape(d.weekday)}<br /><span style="font-size:11px;font-weight:600;color:#0F172A;">${escape(d.day)}</span></td>`
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #E2E8F0;border-radius:10px;border-collapse:separate;border-spacing:0;margin:0 0 6px;">
    <tr style="background:#F8FAFC;">
      <td style="${HEAD_CELL}text-align:left;">Person</td>${head}
      <td align="right" style="${HEAD_CELL}">Days</td>
      <td align="right" style="${HEAD_CELL}">Hours / plan</td>
      <td align="right" style="${HEAD_CELL}">Plan</td>
    </tr>
    ${rows.map((p) => personRow(p, p.id === recipientId)).join("")}
  </table>`;
}

function teamTable(teams: TeamStatus[]): string {
  return dataTable({
    caption: "By team (manager)",
    head: ["Team", "People", "Days", "Hours / plan", "Plan", "With gaps"],
    rows: teams.map((t) => [
      escape(t.name),
      String(t.people),
      `${t.filledDays}/${t.dueDays}`,
      `${hoursLabel(t.hours)}/${plannedFor(t.dueDays)}h`,
      planShare(t.hours, t.dueDays),
      t.gapPeople > 0 ? `<span style="color:#B91C1C;font-weight:700;">${t.gapPeople}</span>` : "0"
    ])
  });
}

const HEADING: Record<FillScope, string> = {
  SELF: "Your daily logging",
  TEAM: "Your team's daily logging",
  ALL: "Daily logging across the workspace"
};

/** Rows shown in the people grid. The by-team table and the summary strip still count everyone. */
export const DAILY_STATUS_MAX_ROWS = 40;

/** The section as ready-to-send HTML, or "" when there is nobody to show. */
export function renderDailyStatus(
  status: DailyStatus,
  options: { scope: FillScope; weekLabel: string; recipientId: string; maxRows?: number }
): string {
  if (status.people.length === 0) return "";
  const maxRows = options.maxRows ?? DAILY_STATUS_MAX_ROWS;

  const total = status.people.reduce(
    (t, p) => ({
      filled: t.filled + p.filledDays,
      due: t.due + p.dueDays,
      hours: t.hours + p.hours,
      gapDays: t.gapDays + p.gapDays,
      gapPeople: t.gapPeople + (p.gapDays > 0 ? 1 : 0)
    }),
    { filled: 0, due: 0, hours: 0, gapDays: 0, gapPeople: 0 }
  );

  const third =
    options.scope === "SELF"
      ? { label: "Unfilled days", value: String(total.gapDays), sub: total.gapDays === 0 ? "all filled" : "working days" }
      : {
          label: "People with gaps",
          value: `${total.gapPeople}/${status.people.length}`,
          sub: total.gapPeople === 0 ? "everyone filed" : "missed a working day"
        };

  const shown = status.people.slice(0, maxRows);
  const hidden = status.people.length - shown.length;
  const workingDayCount = status.days.filter((d) => d.due).length;

  return (
    `<div style="${SECTION_HEADING}">${escape(HEADING[options.scope])} — ${escape(options.weekLabel)}</div>` +
    periodStrip([
      { label: "Days filled", value: `${total.filled}/${total.due}`, sub: `${workingDayCount} working days` },
      { label: "Hours vs plan", value: `${hoursLabel(total.hours)}/${plannedFor(total.due)}h`, sub: `${planShare(total.hours, total.due)} of plan` },
      third
    ]) +
    (options.scope === "ALL" && status.teams.length > 1 ? teamTable(status.teams) : "") +
    peopleTable(status, options.recipientId, shown) +
    (hidden > 0
      ? `<div style="font-size:11px;color:#64748B;margin:0 0 4px;">Showing the ${shown.length} people with the most unfilled days — ${hidden} more are on the Daily logging status card on your Home page.</div>`
      : "") +
    `<div style="font-size:11px;color:#64748B;margin:2px 0 4px;"><span style="background:${TONE.filled.bg};color:${TONE.filled.fg};padding:1px 6px;border-radius:4px;font-weight:700;">2</span> filled (the number is the entries) &nbsp; <span style="background:${TONE.missing.bg};color:${TONE.missing.fg};padding:1px 6px;border-radius:4px;font-weight:700;">–</span> a working day with nothing logged &nbsp; <span style="background:${TONE.off.bg};color:${TONE.off.fg};padding:1px 6px;border-radius:4px;font-weight:700;">·</span> day off. Plan is ${PLANNED_HOURS_PER_WORKING_DAY}h for each working day. Hours here include drafts and pending entries, so they can be higher than the approved hours above.</div>`
  );
}

/* ------------------------------------------------------------------ *
 * The queries
 * ------------------------------------------------------------------ */

const ROSTER_SELECT = { id: true, name: true, managerId: true, manager: { select: { name: true } } } as const;

async function loadRoster(userId: string, scope: FillScope): Promise<RosterPerson[]> {
  // Active people only; an agent identity has no timesheet to fill and a deactivated account is not
  // expected to log. The recipient is always active — the worker only iterates ACTIVE users.
  const base = { status: "ACTIVE" as const, deletedAt: null, isAgent: false };
  let where: object = { ...base, id: userId };
  if (scope === "ALL") where = base;
  else if (scope === "TEAM") where = { ...base, OR: [{ id: userId }, { managerId: userId }] };
  const users = await prisma.user.findMany({ where, select: ROSTER_SELECT, orderBy: { name: "asc" } });
  return users.map((u) => ({ id: u.id, name: u.name, managerId: u.managerId, managerName: u.manager?.name ?? null }));
}

/**
 * One recipient's daily-status section for `period` (the digest's week). Grouped in SQL by person
 * and day, so a workspace-wide read is at most people × 7 rows rather than every entry.
 */
export async function dailyStatusTables(params: { userId: string; period: Period; scope: FillScope }): Promise<string> {
  const [settings, roster] = await Promise.all([getPlanningSettings(), loadRoster(params.userId, params.scope)]);
  if (roster.length === 0) return "";

  const days = weekDays(params.period.from, params.period.to, settings.workingDays);
  const grouped = await prisma.timesheet.groupBy({
    by: ["userId", "workDate"],
    where: {
      deletedAt: null,
      workDate: { gte: params.period.from, lt: params.period.to },
      // Everyone needs no filter, and an IN list of every user would only be a slower way to say so.
      ...(params.scope === "ALL" ? {} : { userId: { in: roster.map((p) => p.id) } })
    },
    _sum: { totalHours: true },
    _count: { _all: true }
  });

  const figures = new Map<string, Map<string, DayFigure>>();
  for (const row of grouped) {
    const byDay = figures.get(row.userId) ?? new Map<string, DayFigure>();
    byDay.set(row.workDate.toISOString().slice(0, 10), { entries: row._count._all, hours: Number(row._sum.totalHours ?? 0) });
    figures.set(row.userId, byDay);
  }

  return renderDailyStatus(buildDailyStatus({ days, roster, figures }), {
    scope: params.scope,
    weekLabel: params.period.label,
    recipientId: params.userId
  });
}
