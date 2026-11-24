/**
 * 7.0.0 — Ask AI's leave reads: who is off (scoped), the asking person's own balance and requests.
 *
 * READS ONLY, like every tool in ai-chat-tools.ts (applying for leave is an MCP action, apply_leave,
 * not a chat one). Each runs as the asking user:
 *   - who_is_off uses the Team view's scope (leave-who-is-off.service.ts): reports for a manager,
 *     everyone for an admin, only yourself otherwise;
 *   - my_leave_balance / my_leave_requests take no "who" argument at all.
 * NO REASON, NOTE OR DOCUMENT is ever put in a result — not even the person's own reason, which the
 * assistant has no need to repeat. Leave off answers as DATA ("Leave is off …"), never a throw.
 */
import { getBalances, isLeaveOn, listMyRequests } from "./leave.service.js";
import { weekOf, whoIsOff } from "./leave-who-is-off.service.js";
import type { AiChatTool } from "./ai-chat-tools.js";

const OFF = "Leave is off for this workspace, so there is no leave data. A super admin can switch it on in Workspace Settings → Attendance & Leave.";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);

const todayKey = () => new Date().toISOString().slice(0, 10);
const half = (start: string, end: string) => (start === "FULL" && end === "FULL" ? "" : ` (${[start !== "FULL" ? `starts ${start}` : "", end !== "FULL" ? `ends ${end}` : ""].filter(Boolean).join(", ")})`);

/** Pure: the range a who_is_off call covers. A single `date` wins; else from/to; else this week. */
export function offRange(args: Record<string, unknown>, today: string): { from: string; to: string } {
  const pick = (v: unknown) => (typeof v === "string" && ISO.test(v) ? v : null);
  const date = pick(args.date);
  if (date) return { from: date, to: date };
  const from = pick(args.from);
  const to = pick(args.to);
  if (from && to && from <= to) return { from, to };
  return weekOf(today);
}

export const AI_CHAT_LEAVE_TOOLS: ReadonlyArray<AiChatTool> = [
  {
    name: "who_is_off",
    group: "Leave",
    description:
      "Who is on approved leave this week or on a date. Scoped like the Team view: a manager sees their reports, an admin everyone, anyone else only themselves. Names, leave type and dates only — never a reason.",
    args: '{ "date"?: "YYYY-MM-DD", "from"?: "YYYY-MM-DD", "to"?: "YYYY-MM-DD" }',
    run: async (args, ctx) => {
      const { from, to } = offRange(args, todayKey());
      const result = await whoIsOff({ id: ctx.req.user.id, role: ctx.req.user.role }, from, to);
      if (!result.enabled) return OFF;
      const who = result.scope === "self" ? "you" : result.scope === "team" ? "your reports" : "the workspace";
      if (result.people.length === 0) return `Nobody among ${who} is on approved leave ${from === to ? `on ${from}` : `from ${from} to ${to}`}.`;
      return (
        `Approved leave among ${who}, ${from} to ${to}:\n` +
        result.people.map((p) => `${p.name}: ${p.type} ${p.startDate}${p.endDate !== p.startDate ? ` to ${p.endDate}` : ""}${half(p.startHalf, p.endHalf)}, ${p.days} day(s)`).join("\n")
      );
    }
  },
  {
    name: "my_leave_balance",
    group: "Leave",
    description: "The asking person's OWN leave balance per leave type: available now, pending, and what expires at year end.",
    args: "{}",
    run: async (_args, ctx) => {
      if (!(await isLeaveOn())) return OFF;
      const b = await getBalances(ctx.req.user.id);
      if (b.balances.length === 0) return "No leave types are set up yet.";
      return (
        `Leave year ${b.from} to ${b.to}:\n` +
        b.balances.map((x) => `${x.leaveType.code} (${x.leaveType.name}): ${x.available} available, ${x.pending} pending, ${x.expiringAtYearEnd} expiring at year end`).join("\n")
      );
    }
  },
  {
    name: "my_leave_requests",
    group: "Leave",
    description: "The asking person's OWN leave requests and their status (optionally filtered by PENDING, APPROVED, REJECTED or CANCELLED).",
    args: '{ "status"?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" }',
    run: async (args, ctx) => {
      if (!(await isLeaveOn())) return OFF;
      const status = typeof args.status === "string" && STATUSES.has(args.status) ? (args.status as "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED") : undefined;
      const rows = await listMyRequests(ctx.req.user.id, { status });
      if (rows.length === 0) return status ? `You have no ${status.toLowerCase()} leave requests.` : "You have no leave requests.";
      const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
      return rows
        .slice(0, 40)
        .map((r) => `${r.leaveType.code} ${day(r.startDate)}${day(r.endDate) !== day(r.startDate) ? ` to ${day(r.endDate)}` : ""}, ${Number(r.days)} day(s): ${r.status}`)
        .join("\n");
    }
  }
];
