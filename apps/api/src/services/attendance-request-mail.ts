/**
 * The email leg of the three attendance requests that are not leave: comp-off, an attendance
 * correction and an overtime claim.
 *
 * They already raised in-app notices under the leave categories (`leave.requested` /
 * `leave.decided`); this gives those notices their email, through the SAME gates the leave module
 * uses — the category's `emailLeaveRequested` / `emailLeaveDecided` toggle, the per-role mutes and
 * the super-admin BCC rules all live in `dispatchNotification`, so reusing the category is what keeps
 * one switch (and one Email channels row) governing all of them. Only the template differs, because
 * a leave template reading "your leave request" would be wrong for a correction.
 *
 * No reason travels in the email (personal, and an email outlives the decision); the decider's note
 * to the requester does, exactly as it does for leave.
 */
import { prisma } from "../config/prisma.js";
import { templates } from "./mail-templates.js";

export type AttendanceRequestKind = "comp-off request" | "attendance correction" | "overtime claim";

/** "a comp-off request" / "an attendance correction" / "an overtime claim". */
const withArticle = (kind: AttendanceRequestKind) => (kind === "comp-off request" ? "a " : "an ") + kind;

export function requestedEmail(args: { approverName: string; employeeName: string; kind: AttendanceRequestKind; summary: string }) {
  const requestKind = withArticle(args.kind);
  const vars = { approverName: args.approverName, employeeName: args.employeeName, requestKind, summary: args.summary };
  return {
    templateKey: "attendance.requested",
    vars,
    fallback: {
      subject: `${args.employeeName} sent ${requestKind} for your decision`,
      html: templates.attendanceRequested(vars)
    }
  };
}

export function decidedEmail(args: {
  name: string;
  kind: AttendanceRequestKind;
  approve: boolean;
  decidedBy: string;
  summary: string;
  note: string | null;
}) {
  const decision = args.approve ? "approved" : "rejected";
  const vars = {
    name: args.name,
    requestKind: args.kind,
    decision,
    decidedBy: args.decidedBy,
    summary: args.summary,
    note: args.note?.trim() || "-"
  };
  return {
    templateKey: "attendance.decided",
    vars,
    fallback: { subject: `Your ${args.kind} was ${decision}`, html: templates.attendanceDecided(vars) }
  };
}

/** The names the decided email needs: the requester's, and the decider's (the actor's own name when
 *  the caller has it, else one lookup). Null when the requester is gone — nothing to email. */
export async function decisionNames(requesterId: string, actor: { id: string; name?: string | null }) {
  const [requester, decider] = await Promise.all([
    prisma.user.findUnique({ where: { id: requesterId }, select: { name: true } }),
    actor.name ? Promise.resolve({ name: actor.name }) : prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } })
  ]);
  if (!requester) return null;
  return { requesterName: requester.name, deciderName: decider?.name ?? "an approver" };
}

/** The decided email for a requester and an actor, or undefined when the requester no longer exists. */
export async function decisionEmail(
  requesterId: string,
  actor: { id: string; name?: string | null },
  args: { kind: AttendanceRequestKind; approve: boolean; summary: string; note: string | null }
) {
  const names = await decisionNames(requesterId, actor);
  return names ? decidedEmail({ ...args, name: names.requesterName, decidedBy: names.deciderName }) : undefined;
}
