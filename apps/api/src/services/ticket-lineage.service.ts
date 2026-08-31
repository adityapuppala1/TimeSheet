/**
 * WHAT: a single chronological timeline of everything bound to one ticket — branches/PRs
 * (`TicketBranch`), CI runs (`TestRun`), and security findings (`SecurityFinding`) — instead of
 * the three separate panels (Dev/Security tabs) a reviewer otherwise has to cross-reference by
 * hand. This is the most literal answer to "give me a map of what happened on this ticket."
 * WHY a shared builder rather than inlining the query in the controller: same reasoning as
 * `buildTicketSecurityReport` in security-report.service.ts — if a PDF/export variant of this
 * view is ever added, it must never drift from what the UI shows.
 * WHY this is pure aggregation, no new ingestion: every row it reads already exists and is
 * already linked to `ticketId` by the features that created Phases 2a/2b/pre-existing security
 * ingestion — this is a read-side view, not a new data source.
 */
import { securityFindingStatusBuckets } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";

export type TicketLineageEventType = "branch_linked" | "pr_status" | "test_run" | "security_finding";

export interface TicketLineageEvent {
  type: TicketLineageEventType;
  at: Date;
  summary: string;
  detail?: string;
  /** "success" | "failure" | "neutral" — lets the UI pick a consistent icon/tone without
   *  re-deriving it from `type`-specific fields. */
  tone: "success" | "failure" | "neutral";
}

export interface TicketLineage {
  ticket: { id: string; key: string; title: string };
  events: TicketLineageEvent[];
}

export async function buildTicketLineage(ticketId: string): Promise<TicketLineage> {
  const ticket = await prisma.ticket.findFirstOrThrow({
    where: { id: ticketId },
    select: { id: true, key: true, title: true }
  });

  const [branches, testRuns, findings] = await Promise.all([
    prisma.ticketBranch.findMany({ where: { ticketId }, orderBy: { createdAt: "asc" } }),
    prisma.testRun.findMany({ where: { ticketId }, orderBy: { createdAt: "asc" } }),
    prisma.securityFinding.findMany({ where: { ticketId }, orderBy: { createdAt: "asc" } })
  ]);

  const events: TicketLineageEvent[] = [];

  for (const branch of branches) {
    events.push({
      type: "branch_linked",
      at: branch.createdAt,
      summary: `Branch linked: ${branch.repository}/${branch.branch}`,
      tone: "neutral"
    });
    if (branch.prUrl) {
      events.push({
        type: "pr_status",
        // Branches don't carry a separate "PR opened at" timestamp — the link's own createdAt is
        // the closest available signal, same trade-off TicketBranch's schema already accepts.
        at: branch.createdAt,
        summary: `Pull request ${branch.prStatus === "NONE" ? "linked" : branch.prStatus.toLowerCase()}`,
        detail: branch.prUrl,
        tone: branch.prStatus === "MERGED" ? "success" : branch.prStatus === "CLOSED" ? "failure" : "neutral"
      });
    }
  }

  for (const run of testRuns) {
    events.push({
      type: "test_run",
      at: run.createdAt,
      summary: `${run.provider} run ${run.status.toLowerCase()}${run.branch ? ` on ${run.branch}` : ""}`,
      detail: [
        typeof run.passCount === "number" ? `${run.passCount} passed` : null,
        typeof run.failCount === "number" ? `${run.failCount} failed` : null
      ]
        .filter(Boolean)
        .join(", ") || undefined,
      tone: run.status === "PASSED" ? "success" : run.status === "FAILED" ? "failure" : "neutral"
    });
  }

  for (const finding of findings) {
    events.push({
      type: "security_finding",
      at: finding.createdAt,
      summary: `${finding.severity} ${finding.type} finding: ${finding.title}`,
      detail: finding.aiVerdict ? `AI triage: ${finding.aiVerdict.replace("_", " ").toLowerCase()}` : undefined,
      // A SIXTH copy of the resolved-status list. THE DECISION THIS TIMELINE MAKES: only the
      // `resolved` bucket earns the green tone. A pending (claimed fixed, unconfirmed) finding
      // keeps whatever tone its severity gives it, because a green dot on a timeline reads as
      // "this one is behind us" and an unproven fix has not earned that.
      tone:
        securityFindingStatusBuckets[finding.status] === "resolved"
          ? "success"
          : finding.severity === "CRITICAL" || finding.severity === "HIGH"
            ? "failure"
            : "neutral"
    });
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  return { ticket, events };
}
