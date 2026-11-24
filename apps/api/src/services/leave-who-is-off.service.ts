/**
 * 7.0.0 — "who's off this week / on a date", for Ask AI (ai-chat-leave-tools.ts) and MCP (who_is_off).
 *
 * SCOPE is the Team view's, not a new rule: a manager / team lead sees their direct reports, an
 * admin or super admin everyone (attendance-team.service.ts#teamScopeFor via listTeamLeave). Anyone
 * else sees only their own leave. Only APPROVED leave counts as "off".
 *
 * NEVER A REASON. Each row is name, leave-type code, dates and halves, built field by field here so a
 * column added to the request later cannot ride along. Managers never see leave reasons.
 */
import { teamScopeFor } from "./attendance-team.service.js";
import { isLeaveOn, listMyRequests, listTeamLeave } from "./leave.service.js";

export interface OffRow {
  name: string;
  type: string;
  startDate: string;
  endDate: string;
  startHalf: string;
  endHalf: string;
  days: number;
}

export type WhoIsOff = { enabled: false } | { enabled: true; from: string; to: string; scope: "team" | "everyone" | "self"; people: OffRow[] };

const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/** Pure: the one place a row's fields are chosen. Exported for the reason-leak test. */
export function toOffRow(r: { user?: { name?: string | null } | null; leaveType: { code: string }; startDate: unknown; endDate: unknown; startHalf: unknown; endHalf: unknown; days: unknown }, fallbackName: string): OffRow {
  return {
    name: r.user?.name ?? fallbackName,
    type: r.leaveType.code,
    startDate: day(r.startDate),
    endDate: day(r.endDate),
    startHalf: String(r.startHalf),
    endHalf: String(r.endHalf),
    days: Number(r.days)
  };
}

export async function whoIsOff(actor: { id: string; role: string; name?: string }, from: string, to: string): Promise<WhoIsOff> {
  if (!(await isLeaveOn())) return { enabled: false };
  const scope = teamScopeFor(actor.role);
  if (!scope) {
    const mine = await listMyRequests(actor.id, { status: "APPROVED" });
    const people = mine.filter((r) => day(r.startDate) <= to && day(r.endDate) >= from).map((r) => toOffRow(r, actor.name ?? "You"));
    return { enabled: true, from, to, scope: "self", people };
  }
  const team = await listTeamLeave(actor, from, to);
  const people = team.items.filter((r) => r.status === "APPROVED").map((r) => toOffRow(r, "Someone"));
  return { enabled: true, from, to, scope: scope.unrestricted ? "everyone" : "team", people };
}

/** Monday..Sunday of the week containing `key` (UTC day keys). Pure. */
export function weekOf(key: string): { from: string; to: string } {
  const d = new Date(`${key}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  const mon = new Date(d.getTime() - back * 86_400_000);
  const sun = new Date(mon.getTime() + 6 * 86_400_000);
  return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
}
