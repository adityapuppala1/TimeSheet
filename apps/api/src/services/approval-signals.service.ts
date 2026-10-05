/**
 * The approver brief: facts a reviewer would otherwise check by hand, attached to each entry in the
 * approval queue. INFORMATIONAL ONLY — nothing here approves, rejects or blocks; the decision stays
 * the reviewer's, exactly as the anomaly card on the Team page.
 *
 * Signals, each a fact rather than a verdict:
 *  - NO_TICKET     development / bug-fixing time with no ticket linked
 *  - LONG_DAY      the person's total for that day (excluding rejected entries) is over 10 hours
 *  - NO_ACTIVITY   ticket work logged, but the person touched no ticket that day (no update, no comment)
 *  - THIN_NOTE     the description is under 20 characters of text
 */
import { prisma } from "../config/prisma.js";
import { htmlToPlainText } from "../utils/sanitize.js";

export type ApprovalSignalCode = "NO_TICKET" | "LONG_DAY" | "NO_ACTIVITY" | "THIN_NOTE";
export interface ApprovalSignal {
  code: ApprovalSignalCode;
  label: string;
}

export interface SignalEntry {
  id: string;
  userId: string;
  workDate: Date;
  activityType: string;
  ticketId: string | null;
  taskDescription: string;
}

const TICKET_WORK = /development|bug|testing|deployment/i;
const LONG_DAY_HOURS = 10;
const THIN_NOTE_CHARS = 20;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const plain = (html: string) => htmlToPlainText(html).trim();

/** Pure: entries + per-(user, day) totals + per-(user, day) ticket activity → signals per entry. */
export function computeApprovalSignals(
  entries: SignalEntry[],
  dayTotals: Map<string, number>,
  activeDays: Set<string>
): Map<string, ApprovalSignal[]> {
  const out = new Map<string, ApprovalSignal[]>();
  for (const e of entries) {
    const key = `${e.userId}:${dayKey(e.workDate)}`;
    const signals: ApprovalSignal[] = [];
    const ticketWork = TICKET_WORK.test(e.activityType);
    if (ticketWork && !e.ticketId) signals.push({ code: "NO_TICKET", label: "No linked ticket" });
    const total = dayTotals.get(key) ?? 0;
    if (total > LONG_DAY_HOURS) signals.push({ code: "LONG_DAY", label: `${Math.round(total * 100) / 100}h logged that day` });
    if (ticketWork && !activeDays.has(key)) signals.push({ code: "NO_ACTIVITY", label: "No ticket activity that day" });
    if (plain(e.taskDescription).length < THIN_NOTE_CHARS) signals.push({ code: "THIN_NOTE", label: "Very short description" });
    out.set(e.id, signals);
  }
  return out;
}

/** Loads the two aggregates for one page of the queue (bounded by its users and dates) and computes. */
export async function loadApprovalSignals(entries: SignalEntry[]): Promise<Map<string, ApprovalSignal[]>> {
  if (entries.length === 0) return new Map();
  const userIds = [...new Set(entries.map((e) => e.userId))];
  const times = entries.map((e) => e.workDate.getTime());
  const from = new Date(Math.min(...times));
  const to = new Date(Math.max(...times) + 86_400_000);

  const [totals, audits, comments] = await Promise.all([
    prisma.timesheet.groupBy({
      by: ["userId", "workDate"],
      where: { userId: { in: userIds }, workDate: { gte: from, lt: to }, status: { not: "REJECTED" } },
      _sum: { totalHours: true }
    }),
    prisma.auditLog.findMany({
      where: { actorId: { in: userIds }, entity: "Ticket", createdAt: { gte: new Date(from.getTime() - 86_400_000), lt: new Date(to.getTime() + 86_400_000) } },
      select: { actorId: true, createdAt: true },
      take: 5000
    }),
    prisma.ticketComment.findMany({
      where: { authorId: { in: userIds }, createdAt: { gte: new Date(from.getTime() - 86_400_000), lt: new Date(to.getTime() + 86_400_000) } },
      select: { authorId: true, createdAt: true },
      take: 5000
    })
  ]);

  const dayTotals = new Map(totals.map((t) => [`${t.userId}:${dayKey(t.workDate)}`, Number(t._sum.totalHours ?? 0)]));
  // Activity is keyed by the LOCAL calendar day the server sees, matching how a workDate is chosen.
  const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const activeDays = new Set<string>([
    ...audits.filter((a) => a.actorId).map((a) => `${a.actorId}:${localDay(a.createdAt)}`),
    ...comments.map((c) => `${c.authorId}:${localDay(c.createdAt)}`)
  ]);
  return computeApprovalSignals(entries, dayTotals, activeDays);
}
