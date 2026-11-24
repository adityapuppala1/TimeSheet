/**
 * 7.0.0 — private iCalendar feed (subscribe from Google / Outlook / Apple Calendar).
 *
 * THE TOKEN is the only credential, because calendar apps cannot send an auth header:
 *   - 32 random bytes (hex), shown to its owner once, in the URL; only its SHA-256 is stored, so a
 *     database read never yields a working feed URL;
 *   - one per person; rotating replaces the hash (the old URL stops at once), revoking deletes it;
 *   - looked up in the TENANT database the Host header resolved (the route sits after resolveTenant),
 *     so a token can never read another workspace — the other tenant's table simply has no such hash;
 *   - an unknown token, a deactivated owner, the module switched off: all the same 404;
 *   - the access log never sees it (app.ts redacts /calendar/feed/<token>), the route is per-IP
 *     rate-limited, and the response is `Cache-Control: private` with `Referrer-Policy: no-referrer`.
 *
 * WHAT IS IN IT:
 *   - "mine": my APPROVED leave (type name, halves) and my holidays (mandatory, plus the optional ones
 *     I opted into), from 60 days back to a year ahead;
 *   - "team" (managers, team leads and admins only — Team Activity's visibility rule via
 *     listTeamLeave): APPROVED leave of the people I may already see, as "Name: Leave type". Never a
 *     reason, a note or a document — listTeamLeave strips them, and this file never reads them.
 */
import { createHash, randomBytes } from "node:crypto";
import { foldIcsLine, icsEscape } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { todayKeyFor } from "./attendance-day-status.js";
import { loadHolidays, teamScopeFor } from "./attendance-team.service.js";
import { audit } from "./audit.service.js";
import { attendanceOrLeaveOn } from "./leave-capacity.service.js";
import { addDaysKey } from "./leave-calc.js";
import { isLeaveOn, listTeamLeave } from "./leave.service.js";

export const FEED_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const NOT_FOUND = "Calendar feed not found";

export const hashFeedToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** Pure: the feed file name in the URL → token and kind, or null when malformed. */
export function parseFeedFile(file: string): { token: string; kind: "mine" | "team" } | null {
  const m = /^([a-f0-9]{64})(-team)?\.ics$/.exec(file);
  if (!m) return null;
  return { token: m[1], kind: m[2] ? "team" : "mine" };
}

/** Pure: the access-log line with any feed token replaced. */
export function redactFeedTokens(url: string): string {
  return url.replaceAll(/(\/calendar\/feed\/)[a-f0-9]{8,}/gi, "$1[redacted]");
}

/* ------------------------------ token management ------------------------------ */

export async function getFeedStatus(userId: string) {
  const row = await prisma.calendarFeedToken.findUnique({ where: { userId }, select: { hint: true, createdAt: true, lastUsedAt: true } });
  return {
    enabled: Boolean(row),
    hint: row?.hint ?? null,
    createdAt: row?.createdAt?.toISOString() ?? null,
    lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
    teamFeedAvailable: false as boolean
  };
}

/** Creates, or rotates, the token. The plain token is returned ONCE. */
export async function rotateFeedToken(userId: string): Promise<{ token: string; hint: string }> {
  if (!(await attendanceOrLeaveOn())) throw new AppError(403, "Attendance & Leave is off for this workspace, so there is no calendar to share.");
  const token = randomBytes(32).toString("hex");
  const hint = token.slice(0, 6);
  const tokenHash = hashFeedToken(token);
  const existed = await prisma.calendarFeedToken.findUnique({ where: { userId }, select: { id: true } });
  await prisma.calendarFeedToken.upsert({ where: { userId }, update: { tokenHash, hint, lastUsedAt: null }, create: { userId, tokenHash, hint } });
  await audit(userId, existed ? "calendar_feed.rotated" : "calendar_feed.created", "CalendarFeedToken", userId, { hint });
  return { token, hint };
}

export async function revokeFeedToken(userId: string): Promise<void> {
  const deleted = await prisma.calendarFeedToken.deleteMany({ where: { userId } });
  if (deleted.count > 0) await audit(userId, "calendar_feed.revoked", "CalendarFeedToken", userId, {});
}

/* ------------------------------ the feed ------------------------------ */

const compact = (k: string) => k.replaceAll("-", "");
const halfText = (h: string) => (h === "FIRST_HALF" ? " (first half)" : h === "SECOND_HALF" ? " (second half)" : "");

export interface FeedEvent {
  uid: string;
  start: string;
  /** Inclusive last day. */
  end: string;
  summary: string;
  busy: boolean;
}

/** Pure: an iCalendar document of all-day events. CRLF line ends and RFC 5545 folding. */
export function buildFeedIcs(name: string, events: readonly FeedEvent[], now: Date = new Date()): string {
  const stamp = `${now.toISOString().replaceAll(/[-:]/g, "").slice(0, 15)}Z`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TimeSphere//Leave and holidays//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsEscape(name)}`];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}@timesphere`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(e.start)}`,
      `DTEND;VALUE=DATE:${compact(addDaysKey(e.end, 1))}`,
      `SUMMARY:${icsEscape(e.summary)}`,
      `TRANSP:${e.busy ? "OPAQUE" : "TRANSPARENT"}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

/**
 * The feed for a token, or a 404 AppError. `now` is injectable for tests. Everything that is not a
 * valid, live token for an active person in this workspace with the module on is the same 404.
 */
export async function renderFeed(file: string, now: Date = new Date()): Promise<string> {
  const parsed = parseFeedFile(file);
  if (!parsed) throw new AppError(404, NOT_FOUND);
  if (!(await attendanceOrLeaveOn())) throw new AppError(404, NOT_FOUND);
  const row = await prisma.calendarFeedToken.findUnique({ where: { tokenHash: hashFeedToken(parsed.token) }, select: { id: true, userId: true } });
  if (!row) throw new AppError(404, NOT_FOUND);
  const person = await prisma.user.findFirst({
    where: { id: row.userId, status: "ACTIVE", deletedAt: null },
    select: { id: true, name: true, timezone: true, holidayCalendarId: true, role: { select: { name: true } } }
  });
  if (!person) throw new AppError(404, NOT_FOUND);
  const role = String(person.role?.name ?? "EMPLOYEE");
  const today = todayKeyFor(now, person.timezone, serverTimezone);
  const leaveOn = await isLeaveOn();
  const events: FeedEvent[] = [];

  if (parsed.kind === "team") {
    if (!teamScopeFor(role) || !leaveOn) throw new AppError(404, NOT_FOUND);
    // listTeamLeave enforces who may be seen, and strips reason / note / document.
    const team = await listTeamLeave({ id: person.id, role }, addDaysKey(today, -14), addDaysKey(today, 78));
    for (const r of team.items) {
      if (r.status !== "APPROVED" || r.user?.id === person.id) continue;
      events.push({ uid: `team-${r.id}`, start: r.startDate, end: r.endDate, summary: `${r.user?.name ?? "Someone"}: ${r.leaveType.name}`, busy: false });
    }
  } else {
    const from = addDaysKey(today, -60);
    const to = addDaysKey(today, 365);
    if (leaveOn) {
      const rows = await prisma.leaveRequest.findMany({
        where: { userId: person.id, status: "APPROVED", startDate: { lte: new Date(`${to}T00:00:00Z`) }, endDate: { gte: new Date(`${from}T00:00:00Z`) } },
        select: { id: true, startDate: true, endDate: true, startHalf: true, endHalf: true, leaveType: { select: { name: true } } },
        orderBy: { startDate: "asc" },
        take: 1000
      });
      for (const r of rows) {
        const s = r.startDate.toISOString().slice(0, 10);
        const e = r.endDate.toISOString().slice(0, 10);
        const half = s === e ? halfText(r.startHalf) : "";
        events.push({ uid: `leave-${r.id}`, start: s, end: e, summary: `${r.leaveType.name}${half}`, busy: true });
      }
    }
    const holidayOf = await loadHolidays([person.holidayCalendarId], from, to);
    for (let d = from; d <= to; d = addDaysKey(d, 1)) {
      const h = holidayOf(person.holidayCalendarId, d, person.id);
      if (h) events.push({ uid: `holiday-${compact(d)}`, start: d, end: d, summary: `Holiday: ${h.name}`, busy: false });
    }
  }
  await prisma.calendarFeedToken.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  return buildFeedIcs(parsed.kind === "team" ? `${person.name}'s team leave` : "My leave and holidays", events, now);
}
