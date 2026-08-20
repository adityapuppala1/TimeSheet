/**
 * WHAT: the change-management routes — raise a change, fill in its sections, tag the tickets it
 * delivers and the people working on it, send it for approval, decide it, and move it through
 * implementation, validation, review and closure.
 *
 * WHY A CHANGE CREATES A TICKET: a change request IS a ticket plus a `ChangeRequest` extension row
 * (see that model's comment). Comments, attachments, watchers, links, the audit trail, project-scoped
 * visibility and search all hang off the ticket half and needed no work. What this module adds is the
 * governance the ticket cannot express.
 *
 * WHY EVERY STATE WRITE ALSO WRITES `Ticket.status`: `CHANGE_STATE_TO_TICKET_STATUS` is the same
 * compatibility hinge `WorkflowStatus.legacyStatus` provides for custom ticket statuses. The ~40
 * places already reading `Ticket.status` keep working precisely because the pair is never written
 * apart.
 *
 * WHO CAN SEE WHAT: `ticketProjectScope` — a change is a ticket, so it can never be more visible than
 * one. In practice that means everybody assigned to the project sees its changes, a manager also sees
 * their reports' projects, and admins see everything.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  changeBands,
  changeKinds,
  changeOutcomes,
  changeStates,
  permissions,
  type ChangeBand,
  type ChangeState
} from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { emitDomainEvent } from "../services/domain-events.js";
import { getPlanningEntitlements } from "../services/plan-limits.service.js";
import { issueChangeKey } from "../services/change-key.service.js";
import { sendChangeDecisionMail, sendChangeSubmittedMail } from "../services/change-mail.service.js";
import {
  assertChangeManagementEnabled,
  activeRiskParameterKeys,
  assertLegalChangeTransition,
  assertReadyFor,
  isNoOpTransition,
  canDecideChange,
  computeRiskScore,
  findScheduleConflicts,
  getChangeSettings,
  getSlaConfig,
  judgeChangeSlas,
  missingForTransition,
  resolveChangeApprovers,
  stateAfterDecision,
  ticketStatusFor
} from "../services/change.service.js";
import { assertTicketVisible, computeTicketDueDate, getGlobalTicketSettings, issueTicketKey, ticketProjectScope } from "../services/ticket.service.js";
import { CSV_EOL, UTF8_BOM, csvCell } from "../utils/csv.js";
import PDFDocument from "pdfkit";
import { buildChangeWorkbook, renderChangeRegisterPdf } from "../services/change-export.service.js";
import { buildChangeContext } from "../services/change-context.service.js";

export const changeRouter = Router();
changeRouter.use(requireAuth);

const USER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;

/** The ticket type every change is filed under, so the Tickets page's own type filter can isolate or
 *  exclude them without a second vocabulary. */
export const CHANGE_TICKET_TYPE = "CHANGE";

/** Ceiling on one CSV export. Stated in the response headers rather than silently applied. */
const EXPORT_ROW_CAP = 5000;

const CHANGE_INCLUDE = {
  category: { select: { id: true, name: true, color: true, requiresSecurityReview: true } },
  source: { select: { id: true, name: true } },
  application: { select: { id: true, name: true, code: true } },
  collaborators: { include: { user: { select: USER_SUMMARY } }, orderBy: { createdAt: "asc" } },
  linkedTickets: {
    include: { ticket: { select: { id: true, key: true, title: true, status: true, type: true } } },
    orderBy: { createdAt: "asc" }
  },
  approvals: { include: { approver: { select: USER_SUMMARY } }, orderBy: [{ round: "desc" }, { createdAt: "asc" }] },
  implementationSteps: { orderBy: { stepNumber: "asc" } },
  testCases: { orderBy: { createdAt: "asc" } },
  dependencies: { orderBy: { createdAt: "asc" } },
  ticket: {
    select: {
      id: true,
      key: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      dueAt: true,
      createdAt: true,
      project: { select: { id: true, code: true, name: true } },
      module: { select: { id: true, name: true } },
      reporter: { select: USER_SUMMARY },
      assignee: { select: USER_SUMMARY },
      _count: { select: { comments: true, attachments: true } }
    }
  }
} as const satisfies Prisma.ChangeRequestInclude;

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

/** Bounded by the SAME project scope tickets use. A change is a ticket, so it can never be more
 *  visible than one — which is what makes "everyone tagged to the project can see it" true without a
 *  second visibility rule to keep in step. */
async function scopedWhere(req: any): Promise<Prisma.ChangeRequestWhereInput> {
  const scope = await ticketProjectScope(req);
  return scope.unrestricted ? {} : { ticket: { projectId: { in: scope.projectIds } } };
}

changeRouter.get("/", async (req, res) => {
  await assertChangeManagementEnabled();
  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && scope.projectIds.length === 0) return res.json([]);

  const str = (k: string) => (typeof req.query[k] === "string" && req.query[k] ? String(req.query[k]) : undefined);
  const state = str("state");
  const kind = str("changeKind");
  const risk = str("riskLevel");
  const environment = str("environment");
  const projectId = str("projectId");
  const search = str("q");

  const ticketFilter: Prisma.TicketWhereInput = {
    ...(projectId ? { projectId } : {}),
    // "Mine" is raised-by OR implementing — the two ways somebody is on the hook for a change.
    ...(req.query.mine === "true" ? { OR: [{ reporterId: req.user!.id }, { assigneeId: req.user!.id }] } : {})
  };

  const changes = await prisma.changeRequest.findMany({
    where: {
      ...(await scopedWhere(req)),
      ...(state ? { state: state as ChangeState } : {}),
      ...(kind ? { changeKind: kind as never } : {}),
      ...(risk ? { riskLevel: risk as never } : {}),
      ...(environment ? { environment: environment as never } : {}),
      ...(Object.keys(ticketFilter).length > 0 ? { ticket: ticketFilter } : {}),
      ...(search ? { OR: [{ changeKey: { contains: search } }, { ticket: { title: { contains: search } } }] } : {})
    },
    include: CHANGE_INCLUDE,
    orderBy: [{ plannedStart: "asc" }, { createdAt: "desc" }],
    take: 200
  });
  res.json(changes);
});

/**
 * Counts for the dashboard tiles, over EVERYTHING in scope rather than the 200-row page the list
 * returns — the same rule the ticket metrics follow, and for the same reason: a tile that describes
 * one page as if it were the whole workspace is the one thing a metric must not do.
 */
changeRouter.get("/metrics", async (req, res) => {
  await assertChangeManagementEnabled();
  const scope = await ticketProjectScope(req);
  const empty = {
    total: 0,
    byState: {},
    byRisk: {},
    byKind: {},
    byEnvironment: {},
    byProject: [],
    awaitingMyDecision: 0,
    inFlight: 0,
    changeFailureRate: null,
    emergencyRate: null,
    avgApprovalHours: null,
    sla: { ON_TRACK: 0, WARNING: 0, BREACHED: 0 },
    trend: []
  };
  if (!scope.unrestricted && scope.projectIds.length === 0) return res.json(empty);

  const where = await scopedWhere(req);
  const now = new Date();
  // Twelve weeks: long enough that a trend is a trend rather than a wobble, short enough that the
  // week buckets stay readable on a card-sized chart.
  const trendFrom = new Date(now.getTime() - 12 * 7 * 24 * 3600 * 1000);

  const [byState, byRisk, byKind, byEnv, mine, closedRows, approvalRows, trendRows, projectRows] = await Promise.all([
    prisma.changeRequest.groupBy({ by: ["state"], where, _count: true }),
    prisma.changeRequest.groupBy({ by: ["riskLevel"], where, _count: true }),
    prisma.changeRequest.groupBy({ by: ["changeKind"], where, _count: true }),
    prisma.changeRequest.groupBy({ by: ["environment"], where, _count: true }),
    // The number that decides whether somebody opens the page today. A super admin sees every
    // pending decision, because they can act on any of them.
    prisma.changeApproval.count({
      where: {
        status: "PENDING",
        change: { state: "AWAITING_APPROVAL", ...where },
        ...(req.user!.role === "SUPER_ADMIN" ? {} : { approverId: req.user!.id })
      }
    }),
    // Outcomes, for the change failure rate. Only closed changes have one, which is exactly the
    // denominator the metric is defined on.
    prisma.changeRequest.findMany({ where: { ...where, closedAt: { not: null } }, select: { outcome: true } }),
    // The two timestamps the approval clock runs between, for everything that has been submitted.
    prisma.changeRequest.findMany({
      where: { ...where, submittedAt: { not: null } },
      select: { state: true, submittedAt: true, approvedAt: true, actualStart: true, actualEnd: true, closedAt: true }
    }),
    prisma.changeRequest.findMany({
      where: { ...where, createdAt: { gte: trendFrom } },
      select: { createdAt: true, closedAt: true, riskLevel: true }
    }),
    prisma.changeRequest.findMany({
      where,
      select: { state: true, riskLevel: true, ticket: { select: { project: { select: { id: true, code: true, name: true } } } } }
    })
  ]);

  const tally = <T extends { _count: number }>(rows: T[], key: keyof T) => {
    const out: Record<string, number> = {};
    for (const row of rows) out[String(row[key])] = row._count;
    return out;
  };
  const stateCounts = tally(byState, "state");
  const kindCounts = tally(byKind, "changeKind");
  const RESTING: ChangeState[] = ["DRAFT", "CLOSED", "REJECTED", "CANCELLED"];
  const inFlight = Object.entries(stateCounts)
    .filter(([s]) => !RESTING.includes(s as ChangeState))
    .reduce((sum, [, n]) => sum + n, 0);
  const total = byState.reduce((sum, r) => sum + r._count, 0);

  // NULL, NEVER 0, when there is nothing to divide by. "No change has closed yet" and "every change
  // succeeded" are different facts, and a 0% failure rate over an empty set is the kind of number
  // that ends up quoted in a review.
  const failed = closedRows.filter((c) => c.outcome === "FAILED" || c.outcome === "ROLLED_BACK").length;
  const changeFailureRate = closedRows.length === 0 ? null : Math.round((failed / closedRows.length) * 100);
  const emergencyRate = total === 0 ? null : Math.round(((kindCounts.EMERGENCY ?? 0) / total) * 100);

  const approved = approvalRows.filter((c) => c.submittedAt && c.approvedAt);
  const avgApprovalHours =
    approved.length === 0
      ? null
      : Math.round(
          (approved.reduce((sum, c) => sum + (c.approvedAt!.getTime() - c.submittedAt!.getTime()), 0) / approved.length / 3600 / 1000) * 10
        ) / 10;

  // The SLA rollup counts only clocks that are still RUNNING. A stage that finished late is already
  // recorded in the change's own history; what a dashboard tile is for is the work somebody can still
  // save.
  const slaConfig = await getSlaConfig();
  const sla = { ON_TRACK: 0, WARNING: 0, BREACHED: 0 };
  for (const row of approvalRows) {
    for (const verdict of Object.values(judgeChangeSlas(row, slaConfig, now))) {
      if (verdict.state === "ON_TRACK" || verdict.state === "WARNING" || verdict.state === "BREACHED") {
        if (!(row.closedAt && verdict.state !== "BREACHED")) sla[verdict.state] += 1;
      }
    }
  }

  // Weekly buckets, oldest first, keyed by the Monday of each week so the label is stable regardless
  // of which day the request lands on.
  const weekKey = (d: Date) => {
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };
  const buckets = new Map<string, { week: string; raised: number; closed: number; high: number }>();
  for (let i = 11; i >= 0; i--) {
    const key = weekKey(new Date(now.getTime() - i * 7 * 24 * 3600 * 1000));
    buckets.set(key, { week: key, raised: 0, closed: 0, high: 0 });
  }
  for (const row of trendRows) {
    const raisedBucket = buckets.get(weekKey(row.createdAt));
    if (raisedBucket) {
      raisedBucket.raised += 1;
      if (row.riskLevel === "HIGH") raisedBucket.high += 1;
    }
    if (row.closedAt) {
      const closedBucket = buckets.get(weekKey(row.closedAt));
      if (closedBucket) closedBucket.closed += 1;
    }
  }

  // Project rollup, busiest first and capped: a register with 60 projects would otherwise render a
  // chart nobody can read.
  const projects = new Map<string, { id: string; code: string; name: string; total: number; inFlight: number; high: number }>();
  for (const row of projectRows) {
    const p = row.ticket.project;
    const entry = projects.get(p.id) ?? { id: p.id, code: p.code, name: p.name, total: 0, inFlight: 0, high: 0 };
    entry.total += 1;
    if (!RESTING.includes(row.state as ChangeState)) entry.inFlight += 1;
    if (row.riskLevel === "HIGH") entry.high += 1;
    projects.set(p.id, entry);
  }

  res.json({
    total,
    byState: stateCounts,
    byRisk: tally(byRisk, "riskLevel"),
    byKind: kindCounts,
    byEnvironment: tally(byEnv, "environment"),
    byProject: [...projects.values()].sort((a, b) => b.total - a.total).slice(0, 8),
    awaitingMyDecision: mine,
    inFlight,
    changeFailureRate,
    emergencyRate,
    avgApprovalHours,
    sla,
    trend: [...buckets.values()]
  });
});

/** The change calendar (spec §31) — approved and scheduled work in a window, plus the blackout
 *  periods it has to dodge. One call, because a calendar that fetches its bars and its no-go zones
 *  separately renders them a frame apart. */
changeRouter.get("/calendar", async (req, res) => {
  await assertChangeManagementEnabled();
  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && scope.projectIds.length === 0) return res.json({ changes: [], blackouts: [] });

  const from = typeof req.query.from === "string" ? new Date(req.query.from) : new Date();
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : new Date(Date.now() + 30 * 24 * 3600 * 1000);

  const [changes, blackouts] = await Promise.all([
    prisma.changeRequest.findMany({
      where: {
        ...(await scopedWhere(req)),
        plannedStart: { lt: to },
        plannedEnd: { gt: from },
        state: { notIn: ["DRAFT", "CANCELLED", "REJECTED"] }
      },
      select: {
        id: true,
        changeKey: true,
        state: true,
        riskLevel: true,
        changeKind: true,
        environment: true,
        plannedStart: true,
        plannedEnd: true,
        ticket: { select: { title: true, project: { select: { code: true, name: true } } } }
      },
      orderBy: { plannedStart: "asc" },
      take: 500
    }),
    prisma.blackoutPeriod.findMany({
      where: { isActive: true, startsAt: { lt: to }, endsAt: { gt: from } },
      orderBy: { startsAt: "asc" }
    })
  ]);
  res.json({ changes, blackouts });
});

/**
 * The change register, in the three formats the three audiences want.
 *
 * ONE QUERY FEEDS ALL THREE. CSV, workbook and PDF are shaped from the same rows, so no two formats
 * can disagree about which changes matched — the rule the timesheet exports were built around.
 *
 * Registered BEFORE `/:id`: Express matches in declaration order, and `/:id` would otherwise swallow
 * "export.csv" as an id. That is not hypothetical — it shipped that way for an afternoon.
 */
async function loadExportRows(req: any) {
  const rows = await prisma.changeRequest.findMany({
    where: await scopedWhere(req),
    include: {
      category: { select: { name: true } },
      approvals: { include: { approver: { select: { name: true } } }, orderBy: [{ round: "desc" }, { createdAt: "asc" }] },
      ticket: {
        select: {
          title: true,
          project: { select: { name: true } },
          reporter: { select: { name: true } },
          assignee: { select: { name: true } }
        }
      }
    },
    orderBy: { createdAt: "desc" },
    take: EXPORT_ROW_CAP
  });

  return rows.map((c) => {
    const decided = c.approvals.find((a) => a.status === "APPROVED" || a.status === "REJECTED");
    return {
      changeKey: c.changeKey,
      project: c.ticket.project.name,
      title: c.ticket.title,
      changeKind: String(c.changeKind),
      category: c.category?.name ?? null,
      environment: String(c.environment),
      state: String(c.state),
      impact: String(c.impact),
      likelihood: String(c.likelihood),
      riskLevel: String(c.riskLevel),
      riskScore: c.riskScore,
      requestedBy: c.ticket.reporter.name,
      implementer: c.ticket.assignee?.name ?? null,
      decidedBy: decided?.approver?.name ?? null,
      decision: decided?.status ?? null,
      decisionComments: decided?.comments ?? null,
      plannedStart: c.plannedStart,
      plannedEnd: c.plannedEnd,
      actualStart: c.actualStart,
      actualEnd: c.actualEnd,
      outcome: c.outcome ? String(c.outcome) : null,
      submittedAt: c.submittedAt,
      approvedAt: c.approvedAt,
      closedAt: c.closedAt
    };
  });
}

/** Every export says how much it left out, in headers a script can read without parsing the file. */
function setExportHeaders(res: any, rows: unknown[], filename: string, contentType: string) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Export-Rows-Included", String(rows.length));
  res.setHeader("X-Export-Truncated", rows.length >= EXPORT_ROW_CAP ? "true" : "false");
  res.setHeader("Access-Control-Expose-Headers", "X-Export-Rows-Included, X-Export-Truncated, Content-Disposition");
}

const exportStamp = () => new Date().toISOString().slice(0, 10);

changeRouter.get("/export.csv", async (req, res) => {
  await assertChangeManagementEnabled();
  const scope = await ticketProjectScope(req);
  if (!scope.unrestricted && scope.projectIds.length === 0) {
    setExportHeaders(res, [], `changes-${exportStamp()}.csv`, "text/csv; charset=utf-8");
    return res.send("");
  }
  const rows = await loadExportRows(req);

  const HEADERS = [
    "Change", "Project", "Title", "Type", "Category", "Environment", "State",
    "Impact", "Likelihood", "Risk level", "Risk score",
    "Requested by", "Implementer", "Decided by", "Decision", "Decision comments",
    "Planned start", "Planned end", "Actual start", "Actual end",
    "Outcome", "Submitted at", "Approved at", "Closed at"
  ];
  const iso = (d: Date | null) => (d ? d.toISOString() : "");
  const lines = [HEADERS.join(",")];
  for (const c of rows) {
    lines.push(
      [
        c.changeKey, c.project, c.title, c.changeKind, c.category, c.environment, c.state,
        c.impact, c.likelihood, c.riskLevel, c.riskScore,
        c.requestedBy, c.implementer, c.decidedBy, c.decision, c.decisionComments,
        iso(c.plannedStart), iso(c.plannedEnd), iso(c.actualStart), iso(c.actualEnd),
        c.outcome, iso(c.submittedAt), iso(c.approvedAt), iso(c.closedAt)
      ]
        .map(csvCell)
        .join(",")
    );
  }

  setExportHeaders(res, rows, `changes-${exportStamp()}.csv`, "text/csv; charset=utf-8");
  // A BOM, so Excel opens UTF-8 rather than guessing a legacy code page and mangling accented names.
  res.send(UTF8_BOM + lines.join(CSV_EOL));
});

changeRouter.get("/export.xlsx", async (req, res) => {
  await assertChangeManagementEnabled();
  const rows = await loadExportRows(req);
  const buffer = await buildChangeWorkbook(rows, {
    generatedBy: req.user!.name,
    workspace: requireTenantContext().orgSlug,
    truncated: rows.length >= EXPORT_ROW_CAP,
    rowCap: EXPORT_ROW_CAP
  });
  setExportHeaders(res, rows, `changes-${exportStamp()}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
});

changeRouter.get("/export.pdf", async (req, res) => {
  await assertChangeManagementEnabled();
  const rows = await loadExportRows(req);
  setExportHeaders(res, rows, `changes-${exportStamp()}.pdf`, "application/pdf");

  // Landscape: ten columns of register do not fit portrait, and a register that wraps is one nobody
  // reads. `bufferPages` is what makes "Page N of M" possible.
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, bufferPages: true });
  doc.pipe(res);
  renderChangeRegisterPdf(doc, rows, {
    generatedBy: req.user!.name,
    workspace: requireTenantContext().orgSlug,
    truncated: rows.length >= EXPORT_ROW_CAP,
    rowCap: EXPORT_ROW_CAP
  });
  doc.end();
});

changeRouter.get("/:id", async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await prisma.changeRequest.findFirst({ where: { id: String(req.params.id) }, include: CHANGE_INCLUDE });
  if (!change) throw new AppError(404, "Change not found");
  await assertTicketVisible(req, change.ticket.project.id);

  const latestRound = change.approvals[0]?.round ?? 0;
  const pending = change.approvals.filter((a) => a.round === latestRound && a.status === "PENDING");

  res.json({
    ...change,
    // Computed server-side, like every other authority answer here: the browser cannot work out
    // whether a pending approval belongs to this viewer without the rows, and guessing would render
    // Approve and Reject buttons the API then refuses.
    canDecide: change.state === "AWAITING_APPROVAL" && canDecideChange(req, pending),
    canEdit: mayEditChange(req, change),
    /** What the change still owes before it could be submitted, so the form shows a checklist rather
     *  than letting somebody press Submit to discover it. */
    blockingForSubmit: missingForTransition(change, "AWAITING_APPROVAL", await activeRiskParameterKeys()),
    /** Every stage clock, judged server-side. The browser has the timestamps but not the configured
     *  budgets, and a second copy of the thresholds in the client is a second thing to get wrong. */
    sla: judgeChangeSlas(change, await getSlaConfig(), new Date()),
    /** Open predecessors, named. The Implement button is refused while any exist, so the detail page
     *  says which rather than letting somebody press it to find out. */
    blockingDependencies: change.dependencies
      .filter((d) => d.status === "OPEN" && (d.dependencyType === "PREDECESSOR" || d.dependencyType === "BLOCKS"))
      .map((d) => ({ id: d.id, description: d.description, dependencyType: d.dependencyType }))
  });
});

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

/**
 * Who may edit, and when the plan stops being editable.
 *
 * An approved change is a record of what somebody agreed to. Editing the plan afterwards without
 * re-approval is exactly the hole change control exists to close, so the detail fields freeze once
 * a decision is recorded. The OUTCOME fields stay writable throughout, because recording what
 * happened is not the same act as amending what was agreed.
 */
const OUTCOME_FIELDS = [
  "outcome", "pirNotes", "closureNotes", "actualResult", "issuesEncountered", "lessonsLearned",
  "recommendations", "followUpActions", "followUpOwnerId", "followUpTargetDate", "incidentCreated",
  "incidentReference", "actualDowntimeMinutes", "implementationSuccessful", "expectedResultAchieved",
  "implementationNotes", "implementationIssues", "validationResult", "validationIssues",
  "businessConfirmation", "technicalConfirmation", "validationOwnerId", "validationDate",
  "documentationUpdated", "monitoringCompleted", "closureStatus", "rollbackStatus",
  "rollbackStartedAt", "rollbackEndedAt", "rollbackReason", "rollbackResult"
];
const FROZEN_AFTER: ChangeState[] = ["APPROVED", "SCHEDULED", "IMPLEMENTING", "VALIDATION", "PIR", "CLOSED"];

function mayEditChange(req: any, change: { state: string; ticket: { reporter: { id: string }; assignee: { id: string } | null } }): boolean {
  const privileged = ["SUPER_ADMIN", "ADMIN"].includes(req.user.role) || req.user.permissions.includes(permissions.CHANGES_MANAGE);
  if (privileged) return true;
  const isParty = change.ticket.reporter.id === req.user.id || change.ticket.assignee?.id === req.user.id;
  return isParty && !FROZEN_AFTER.includes(change.state as ChangeState);
}

function assertMayEditChange(req: any, change: { state: string; ticket: { reporterId: string; assigneeId: string | null } }): void {
  const privileged = ["SUPER_ADMIN", "ADMIN"].includes(req.user.role) || req.user.permissions.includes(permissions.CHANGES_MANAGE);
  const isParty = change.ticket.reporterId === req.user.id || change.ticket.assigneeId === req.user.id;
  if (!privileged && !isParty) {
    throw new AppError(403, "Only this change's requester, its implementer, or a change manager can edit it.");
  }
  const editingPlan = Object.keys(req.body ?? {}).some((k) => !OUTCOME_FIELDS.includes(k) && k !== "to" && k !== "note");
  if (editingPlan && FROZEN_AFTER.includes(change.state as ChangeState) && !privileged) {
    throw new AppError(409, "This change has been approved. Its plan can no longer be edited — raise a new change, or ask a change manager.");
  }
}

/** Loads a change for a write, having checked both that the caller can see it and may edit it. */
async function loadEditableChange(req: any) {
  const change = await prisma.changeRequest.findFirst({
    where: { id: String(req.params.id) },
    include: { ticket: { select: { id: true, projectId: true, reporterId: true, assigneeId: true } } }
  });
  if (!change) throw new AppError(404, "Change not found");
  await assertTicketVisible(req, change.ticket.projectId);
  assertMayEditChange(req, change);
  return change;
}

/** Every field the form owns, in one place so create and patch cannot drift. */
const detailShape = {
  justification: z.string().max(20000).optional(),
  changeKind: z.enum(changeKinds).optional(),
  categoryId: z.string().uuid().nullish(),
  sourceId: z.string().uuid().nullish(),
  applicationId: z.string().uuid().nullish(),
  environment: z.enum(["DEVELOPMENT", "QA", "UAT", "STAGING", "PRODUCTION", "DR"]).optional(),
  businessUnit: z.string().max(120).nullish(),
  department: z.string().max(120).nullish(),
  serviceName: z.string().max(120).nullish(),
  productName: z.string().max(120).nullish(),
  businessOwnerId: z.string().uuid().nullish(),
  technicalOwnerId: z.string().uuid().nullish(),

  problemStatement: z.string().max(20000).nullish(),
  currentSituation: z.string().max(20000).nullish(),
  reasonForChange: z.string().max(20000).nullish(),
  expectedOutcome: z.string().max(20000).nullish(),
  businessBenefits: z.string().max(20000).nullish(),
  costOfNotImplementing: z.string().max(20000).nullish(),
  revenueImpact: z.string().max(4000).nullish(),
  customerImpactNotes: z.string().max(20000).nullish(),
  slaImpactNotes: z.string().max(20000).nullish(),
  regulatoryRequirement: z.boolean().optional(),
  complianceReference: z.string().max(200).nullish(),
  projectReference: z.string().max(200).nullish(),

  impact: z.enum(changeBands).optional(),
  likelihood: z.enum(changeBands).optional(),
  riskInputs: z.record(z.enum(changeBands)).optional(),
  affectedServices: z.array(z.string().max(160)).max(60).optional(),
  affectedApplications: z.array(z.string().max(160)).max(60).optional(),
  affectedCustomers: z.array(z.string().max(160)).max(60).optional(),
  affectedLocations: z.array(z.string().max(160)).max(60).optional(),
  affectedDepartments: z.array(z.string().max(160)).max(60).optional(),
  affectedInfrastructure: z.array(z.string().max(160)).max(60).optional(),
  affectedApis: z.array(z.string().max(160)).max(60).optional(),
  affectedDatabases: z.array(z.string().max(160)).max(60).optional(),
  affectedIntegrations: z.array(z.string().max(160)).max(60).optional(),
  affectedUserCount: z.number().int().min(0).max(10_000_000).nullish(),
  complianceTags: z.array(z.string().max(40)).max(20).optional(),

  productionAffected: z.boolean().optional(),
  customerAffected: z.boolean().optional(),
  serviceInterruption: z.boolean().optional(),
  dataModified: z.boolean().optional(),
  dataMigration: z.boolean().optional(),
  appRestartRequired: z.boolean().optional(),
  serverRestartRequired: z.boolean().optional(),
  dbRestartRequired: z.boolean().optional(),
  securityImpact: z.boolean().optional(),
  complianceImpact: z.boolean().optional(),
  slaImpact: z.boolean().optional(),
  externalIntegrationImpact: z.boolean().optional(),
  securityReviewRequired: z.boolean().optional(),
  requiresDowntime: z.boolean().optional(),
  downtimeMinutes: z.number().int().min(0).max(100_000).nullish(),
  downtimeStart: z.string().datetime().nullish(),
  downtimeEnd: z.string().datetime().nullish(),
  customerNotificationRequired: z.boolean().optional(),

  implementationSummary: z.string().max(20000).nullish(),
  implementationObjective: z.string().max(20000).nullish(),
  prerequisites: z.string().max(20000).nullish(),
  requiredAccess: z.string().max(20000).nullish(),
  requiredTools: z.string().max(20000).nullish(),
  requiredResources: z.string().max(20000).nullish(),
  primaryEngineerId: z.string().uuid().nullish(),
  backupEngineerId: z.string().uuid().nullish(),
  expectedDurationMinutes: z.number().int().min(0).max(100_000).nullish(),
  implementationPlan: z.string().max(60000).nullish(),

  testEnvironment: z.enum(["DEVELOPMENT", "QA", "UAT", "STAGING", "PRODUCTION", "DR"]).nullish(),
  testingTeam: z.string().max(200).nullish(),
  uatRequired: z.boolean().optional(),
  businessValidationRequired: z.boolean().optional(),
  testingStart: z.string().datetime().nullish(),
  testingEnd: z.string().datetime().nullish(),
  validationCriteria: z.string().max(20000).nullish(),
  testPlan: z.string().max(60000).nullish(),

  rollbackRequired: z.boolean().optional(),
  rollbackCriteria: z.string().max(20000).nullish(),
  rollbackProcedure: z.string().max(60000).nullish(),
  rollbackOwnerId: z.string().uuid().nullish(),
  estimatedRollbackMinutes: z.number().int().min(0).max(100_000).nullish(),
  backupRequired: z.boolean().optional(),
  backupLocation: z.string().max(400).nullish(),
  backupVerified: z.boolean().optional(),
  restoreProcedure: z.string().max(20000).nullish(),
  backoutPlan: z.string().max(60000).nullish(),

  releaseVersion: z.string().max(80).nullish(),
  buildNumber: z.string().max(80).nullish(),
  deploymentPackage: z.string().max(400).nullish(),
  repository: z.string().max(400).nullish(),
  branch: z.string().max(200).nullish(),
  cicdPipeline: z.string().max(400).nullish(),
  releaseTicket: z.string().max(120).nullish(),
  deploymentTool: z.string().max(120).nullish(),
  deploymentMethod: z.string().max(120).nullish(),
  configurationChanges: z.boolean().optional(),
  databaseChanges: z.boolean().optional(),
  apiChanges: z.boolean().optional(),
  infrastructureChanges: z.boolean().optional(),

  communicationPlan: z.string().max(60000).nullish(),
  internalCommRequired: z.boolean().optional(),
  stakeholderNotifyRequired: z.boolean().optional(),
  communicationChannel: z.string().max(80).nullish(),
  notificationAudience: z.string().max(4000).nullish(),
  communicationOwnerId: z.string().uuid().nullish(),
  notificationDate: z.string().datetime().nullish(),

  plannedStart: z.string().datetime().nullish(),
  plannedEnd: z.string().datetime().nullish(),
  conflictOverrideReason: z.string().max(4000).nullish(),

  outcome: z.enum(changeOutcomes).nullish(),
  pirNotes: z.string().max(60000).nullish(),
  closureNotes: z.string().max(20000).nullish(),
  actualResult: z.string().max(20000).nullish(),
  issuesEncountered: z.string().max(20000).nullish(),
  lessonsLearned: z.string().max(20000).nullish(),
  recommendations: z.string().max(20000).nullish(),
  followUpActions: z.string().max(20000).nullish(),
  followUpOwnerId: z.string().uuid().nullish(),
  followUpTargetDate: z.string().datetime().nullish(),
  incidentCreated: z.boolean().optional(),
  incidentReference: z.string().max(120).nullish(),
  actualDowntimeMinutes: z.number().int().min(0).max(1_000_000).nullish(),
  implementationSuccessful: z.boolean().nullish(),
  expectedResultAchieved: z.boolean().nullish(),
  implementationNotes: z.string().max(20000).nullish(),
  implementationIssues: z.string().max(20000).nullish(),
  validationResult: z.enum(["PENDING", "PASSED", "FAILED"]).nullish(),
  validationIssues: z.string().max(20000).nullish(),
  validationOwnerId: z.string().uuid().nullish(),
  validationDate: z.string().datetime().nullish(),
  businessConfirmation: z.boolean().optional(),
  technicalConfirmation: z.boolean().optional(),
  documentationUpdated: z.boolean().optional(),
  monitoringCompleted: z.boolean().optional(),
  closureStatus: z.string().max(30).nullish(),
  rollbackStatus: z.string().max(20).nullish(),
  rollbackStartedAt: z.string().datetime().nullish(),
  rollbackEndedAt: z.string().datetime().nullish(),
  rollbackReason: z.string().max(20000).nullish(),
  rollbackResult: z.string().max(20000).nullish()
};

/** Which of the above are dates, so one loop can convert them all. */
const DATE_FIELDS = [
  "plannedStart", "plannedEnd", "downtimeStart", "downtimeEnd", "testingStart", "testingEnd",
  "notificationDate", "followUpTargetDate", "validationDate", "rollbackStartedAt", "rollbackEndedAt"
];

const createSchema = z.object({
  body: z
    .object({
      title: z.string().min(1).max(255),
      description: z.string().max(60000).optional(),
      projectId: z.string().uuid(),
      moduleId: z.string().uuid().nullish(),
      implementerId: z.string().uuid().nullish(),
      priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
      ...detailShape,
      // Spread AFTER the shared shape, which makes it optional: a change with no stated reason is
      // the thing this module exists to stop, so it is required at creation.
      justification: z.string().min(1).max(20000)
    })
    .strict()
});

/** Re-derives the score from whatever the change now holds. Risk is DERIVED, never accepted. */
async function scoreFor(inputs: Record<string, ChangeBand | undefined>) {
  const parameters = await prisma.changeRiskParameter.findMany({
    where: { isActive: true },
    select: { key: true, weight: true }
  });
  return computeRiskScore(inputs, parameters);
}

changeRouter.post("/", requirePermission(permissions.CHANGES_WRITE), validate(createSchema), async (req, res) => {
  await assertChangeManagementEnabled();
  // Anyone may raise a change for a project they are on — and only for those, which is what this
  // check enforces.
  await assertTicketVisible(req, req.body.projectId);

  const slaSettings = await getGlobalTicketSettings();
  const priority = req.body.priority ?? "MEDIUM";
  const riskInputs = (req.body.riskInputs ?? {}) as Record<string, ChangeBand>;
  const scored = await scoreFor(riskInputs);

  const change = await prisma.$transaction(async (tx) => {
    await tx.ticketType.upsert({
      where: { name: CHANGE_TICKET_TYPE },
      update: {},
      create: { name: CHANGE_TICKET_TYPE, color: "#0B6B72" }
    });

    const ticketKey = await issueTicketKey(tx, req.body.projectId);
    const changeKey = await issueChangeKey(tx, req.body.projectId);
    const createdAt = new Date();
    const ticket = await tx.ticket.create({
      data: {
        key: ticketKey,
        projectId: req.body.projectId,
        moduleId: req.body.moduleId || null,
        type: CHANGE_TICKET_TYPE,
        title: req.body.title,
        description: req.body.description ?? null,
        priority,
        reporterId: req.user!.id,
        assigneeId: req.body.implementerId || null,
        dueAt: computeTicketDueDate(createdAt, priority, slaSettings)
      }
    });

    const data: Record<string, unknown> = { ticketId: ticket.id, changeKey, ...scored, riskInputs };
    for (const key of Object.keys(detailShape)) {
      if (key in req.body && !DATE_FIELDS.includes(key)) data[key] = (req.body as Record<string, unknown>)[key];
    }
    for (const key of DATE_FIELDS) {
      if (key in req.body) data[key] = req.body[key] ? new Date(req.body[key]) : null;
    }
    return tx.changeRequest.create({ data: data as never, include: CHANGE_INCLUDE });
  });

  await audit(req.user!.id, "change.created", "ChangeRequest", change.id, { changeKey: change.changeKey });
  res.status(201).json(change);
});

const patchSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      title: z.string().min(1).max(255).optional(),
      description: z.string().max(60000).nullish(),
      implementerId: z.string().uuid().nullish(),
      ...detailShape
    })
    .strict()
});

changeRouter.patch("/:id", requirePermission(permissions.CHANGES_WRITE), validate(patchSchema), async (req, res) => {
  await assertChangeManagementEnabled();
  const existing = await loadEditableChange(req);

  const data: Record<string, unknown> = {};
  for (const key of Object.keys(detailShape)) {
    if (key in req.body && !DATE_FIELDS.includes(key)) data[key] = (req.body as Record<string, unknown>)[key];
  }
  for (const key of DATE_FIELDS) {
    if (key in req.body) data[key] = req.body[key] ? new Date(req.body[key]) : null;
  }
  // Re-scored whenever the inputs move, so the stored level and the answers that produced it cannot
  // drift apart. A caller cannot set the score directly — it is not in the schema.
  if ("riskInputs" in req.body) {
    Object.assign(data, await scoreFor(req.body.riskInputs as Record<string, ChangeBand>));
  }
  if ("conflictOverrideReason" in req.body) {
    data.conflictOverridden = Boolean(req.body.conflictOverrideReason);
  }

  const ticketData: Record<string, unknown> = {};
  if (typeof req.body.title === "string") ticketData.title = req.body.title;
  if ("description" in req.body) ticketData.description = req.body.description ?? null;
  if ("implementerId" in req.body) ticketData.assigneeId = req.body.implementerId || null;

  const change = await prisma.$transaction(async (tx) => {
    if (Object.keys(ticketData).length > 0) await tx.ticket.update({ where: { id: existing.ticket.id }, data: ticketData });
    return tx.changeRequest.update({ where: { id: existing.id }, data: data as never, include: CHANGE_INCLUDE });
  });

  await audit(req.user!.id, "change.updated", "ChangeRequest", change.id, { fields: Object.keys(data) });
  res.json(change);
});

/* ------------------------------------------------------------------ *
 * Approval — submit, decide
 * ------------------------------------------------------------------ */

/**
 * Opens an approval round.
 *
 * A ROUND, not a chain: a change rejected and reworked opens round 2, leaving round 1's decision
 * standing. Overwriting it would erase the record of what was objected to, which is the one thing a
 * change history is for.
 */
async function openApprovalRound(
  tx: Prisma.TransactionClient,
  change: { id: string; ticket: { reporterId: string } },
  slaHours: number
): Promise<{ approverIds: string[]; round: number }> {
  const approvers = await resolveChangeApprovers(change.ticket.reporterId);
  if (approvers.length === 0) {
    throw new AppError(
      409,
      "There is nobody to approve this change — you have no manager set, and this workspace has no active super admin. Ask an administrator to set your manager."
    );
  }

  const previous = await tx.changeApproval.findFirst({
    where: { changeId: change.id },
    orderBy: { round: "desc" },
    select: { round: true }
  });
  const round = (previous?.round ?? 0) + 1;
  const dueAt = new Date(Date.now() + slaHours * 60 * 60 * 1000);

  await tx.changeApproval.createMany({
    data: approvers.map((a) => ({
      changeId: change.id,
      round,
      approverId: a.approverId,
      reason: a.reason,
      status: "PENDING",
      dueAt
    }))
  });

  return { approverIds: approvers.map((a) => a.approverId), round };
}

const decisionSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ decision: z.enum(["APPROVED", "REJECTED"]), comments: z.string().max(4000).optional() }).strict()
});

/**
 * Approve or reject, from the change's own page.
 *
 * WHY THIS IS NOT `POST /approvals/steps/:id/decide`: that route is gated on the PLANNING approvals
 * capability, a separate toggle and a separate entitlement. A workspace running change management
 * without the planning layer would have been able to raise a change and then find nobody able to
 * decide it. Two features gating each other is a support ticket waiting to happen.
 *
 * A super admin may decide any pending change. That is the requirement, and it doubles as the escape
 * hatch for a change whose named approver has left, gone on leave, or been deactivated since.
 */
changeRouter.post("/:id/decision", requirePermission(permissions.CHANGES_APPROVE), validate(decisionSchema), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await prisma.changeRequest.findFirst({
    where: { id: String(req.params.id) },
    include: { ticket: { select: { id: true, projectId: true, reporterId: true, assigneeId: true, title: true } } }
  });
  if (!change) throw new AppError(404, "Change not found");
  await assertTicketVisible(req, change.ticket.projectId);
  if (change.state !== "AWAITING_APPROVAL") throw new AppError(409, "This change is not waiting for a decision.");

  const round = await prisma.changeApproval.findFirst({ where: { changeId: change.id }, orderBy: { round: "desc" }, select: { round: true } });
  const pending = await prisma.changeApproval.findMany({ where: { changeId: change.id, round: round?.round ?? 1, status: "PENDING" } });
  if (!canDecideChange(req, pending)) {
    throw new AppError(403, "Only this change's approver or a super admin can decide it.");
  }

  // The row that belongs to this person, or — for a super admin acting outside the named list — the
  // first pending one, so the decision lands somewhere rather than being recorded nowhere.
  const mine = pending.find((a) => a.approverId === req.user!.id) ?? pending[0];
  const decision = req.body.decision as "APPROVED" | "REJECTED";
  const to = stateAfterDecision(decision);
  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    await tx.changeApproval.update({
      where: { id: mine.id },
      data: { status: decision, comments: req.body.comments ?? null, decidedAt: now, approverId: req.user!.id }
    });
    // Everybody else in the round is superseded, not decided. Nobody decided on their behalf, and
    // recording otherwise would misstate the history — the same rule the planning chains follow.
    await tx.changeApproval.updateMany({
      where: { changeId: change.id, round: mine.round, status: "PENDING", id: { not: mine.id } },
      data: { status: "CANCELLED", decidedAt: now }
    });
    await tx.ticket.update({ where: { id: change.ticket.id }, data: { status: ticketStatusFor(to) } });
    return tx.changeRequest.update({
      where: { id: change.id },
      data: { state: to, ...(to === "APPROVED" ? { approvedAt: now } : {}) },
      include: CHANGE_INCLUDE
    });
  });

  await audit(req.user!.id, `change.${to.toLowerCase()}`, "ChangeRequest", change.id, {
    changeKey: change.changeKey,
    comments: req.body.comments
  });
  emitDomainEvent(`change.${to.toLowerCase()}` as never, { change: updated } as never);
  await sendChangeDecisionMail(updated, req.user!, decision, req.body.comments ?? null).catch((error) =>
    console.warn(`[change] decision mail failed for ${change.changeKey}: ${(error as Error).message}`)
  );

  res.json(updated);
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

const transitionSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ to: z.enum(changeStates), note: z.string().max(2000).optional() }).strict()
});

/**
 * The one route that moves a change by hand.
 *
 * APPROVED and REJECTED are absent from `changeStateTransitions` on purpose, so this route cannot
 * reach them however it is called — only a recorded decision writes those two. That is the single
 * rule the module exists to enforce, and it is enforced by the shape of the table rather than by a
 * condition somebody could forget.
 */
/**
 * Implementation is refused while something this change waits on is still open.
 *
 * ONLY `PREDECESSOR` AND `BLOCKS` COUNT. A `SUCCESSOR` is work that follows this change and a
 * `RELATED` is context — blocking on either would make the field unusable for the thing it is for.
 * `WAIVED` is an explicit, recorded decision to proceed anyway, which is why it clears the gate the
 * same way `COMPLETED` does; the row keeps saying which it was.
 *
 * Checked here and not in `missingForTransition` because that function is pure and database-free by
 * design — the tests drive it without a connection.
 */
async function assertDependenciesClear(changeId: string, target: ChangeState): Promise<void> {
  if (target !== "IMPLEMENTING") return;
  const blocking = await prisma.changeDependency.findMany({
    where: { changeId, status: "OPEN", dependencyType: { in: ["PREDECESSOR", "BLOCKS"] } },
    select: { description: true }
  });
  if (blocking.length === 0) return;
  throw new AppError(
    409,
    `This change is still waiting on ${blocking.length} ${blocking.length === 1 ? "dependency" : "dependencies"}: ` +
      `${blocking.map((d) => d.description).join("; ")}. Complete or waive ${blocking.length === 1 ? "it" : "them"} before implementing.`
  );
}

changeRouter.post("/:id/transition", requirePermission(permissions.CHANGES_WRITE), validate(transitionSchema), async (req, res) => {
  await assertChangeManagementEnabled();
  const existing = await prisma.changeRequest.findFirst({
    where: { id: String(req.params.id) },
    include: { ticket: { select: { id: true, key: true, title: true, projectId: true, reporterId: true, assigneeId: true } } }
  });
  if (!existing) throw new AppError(404, "Change not found");
  await assertTicketVisible(req, existing.ticket.projectId);
  assertMayEditChange(req, existing);

  const from = existing.state as ChangeState;
  const to = req.body.to as ChangeState;
  // A no-op is answered, not performed. Without this, re-posting the same state opens another
  // approval round and mails the approver again — which a double-click alone was enough to do.
  if (isNoOpTransition(from, to)) {
    return res.json(await prisma.changeRequest.findFirst({ where: { id: existing.id }, include: CHANGE_INCLUDE }));
  }
  assertLegalChangeTransition(from, to);
  assertReadyFor(existing, to, await activeRiskParameterKeys());
  await assertDependenciesClear(existing.id, to);

  const settings = await getChangeSettings();
  const now = new Date();
  let approverIds: string[] = [];

  const updated = await prisma.$transaction(async (tx) => {
    if (to === "AWAITING_APPROVAL") {
      const opened = await openApprovalRound(tx, existing, settings.approvalSlaHours);
      approverIds = opened.approverIds;
    }
    await tx.ticket.update({ where: { id: existing.ticket.id }, data: { status: ticketStatusFor(to) } });
    return tx.changeRequest.update({
      where: { id: existing.id },
      data: {
        state: to,
        ...(to === "AWAITING_APPROVAL" ? { submittedAt: existing.submittedAt ?? now } : {}),
        ...(to === "IMPLEMENTING" ? { actualStart: existing.actualStart ?? now } : {}),
        ...(to === "VALIDATION" ? { actualEnd: existing.actualEnd ?? now } : {}),
        ...(to === "CLOSED" ? { closedAt: now, closedById: req.user!.id } : {})
      },
      include: CHANGE_INCLUDE
    });
  });

  await audit(req.user!.id, "change.transitioned", "ChangeRequest", updated.id, { from, to, note: req.body.note });
  emitDomainEvent(`change.${to.toLowerCase()}` as never, { change: updated } as never);

  // Submission is the moment the requirement cares about: it goes to the approver immediately, and
  // best-effort so a slow mail server cannot lose a transition that already happened.
  if (to === "AWAITING_APPROVAL") {
    await sendChangeSubmittedMail(updated, req.user!, approverIds).catch((error) =>
      console.warn(`[change] submission mail failed for ${updated.changeKey}: ${(error as Error).message}`)
    );
  }

  res.json(updated);
});

/* ------------------------------------------------------------------ *
 * Tagging: linked tickets and collaborators
 * ------------------------------------------------------------------ */

/**
 * Tickets this change delivers.
 *
 * ONLY CLOSED WORK is offered. A change is a record of shipping something finished, and letting
 * somebody attach an in-progress ticket would turn the list into a promise rather than a manifest.
 * "Closed" means the two done statuses the rest of the app already agrees on.
 */
changeRouter.get("/:id/linkable-tickets", async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await prisma.changeRequest.findFirst({
    where: { id: String(req.params.id) },
    select: { id: true, ticket: { select: { projectId: true } } }
  });
  if (!change) throw new AppError(404, "Change not found");
  await assertTicketVisible(req, change.ticket.projectId);

  const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const linked = await prisma.changeTicketLink.findMany({ where: { changeId: change.id }, select: { ticketId: true } });

  const tickets = await prisma.ticket.findMany({
    where: {
      deletedAt: null,
      projectId: change.ticket.projectId,
      status: { in: ["RESOLVED", "CLOSED"] },
      id: { notIn: linked.map((l) => l.ticketId) },
      ...(search ? { OR: [{ key: { contains: search } }, { title: { contains: search } }] } : {})
    },
    select: { id: true, key: true, title: true, status: true, type: true },
    orderBy: { key: "asc" },
    take: 50
  });
  res.json(tickets);
});

changeRouter.post("/:id/tickets", requirePermission(permissions.CHANGES_WRITE), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadEditableChange(req);
  const ticketIds: string[] = Array.isArray(req.body?.ticketIds) ? req.body.ticketIds.slice(0, 100) : [];
  if (ticketIds.length === 0) throw new AppError(422, "Pick at least one ticket.");

  // Vetted server-side, not trusted from the client: the picker only offers closed tickets in the
  // right project, and this is what makes that a rule rather than a convention.
  const allowed = await prisma.ticket.findMany({
    where: { id: { in: ticketIds }, deletedAt: null, projectId: change.ticket.projectId, status: { in: ["RESOLVED", "CLOSED"] } },
    select: { id: true }
  });
  if (allowed.length !== ticketIds.length) {
    throw new AppError(422, "Only closed tickets from this change's own project can be linked.");
  }

  await prisma.changeTicketLink.createMany({
    data: allowed.map((t) => ({ changeId: change.id, ticketId: t.id, addedById: req.user!.id })),
    skipDuplicates: true
  });
  await audit(req.user!.id, "change.tickets_linked", "ChangeRequest", change.id, { ticketIds });
  res.status(201).json(await prisma.changeRequest.findFirst({ where: { id: change.id }, include: CHANGE_INCLUDE }));
});

changeRouter.delete("/:id/tickets/:ticketId", requirePermission(permissions.CHANGES_WRITE), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadEditableChange(req);
  await prisma.changeTicketLink.deleteMany({ where: { changeId: change.id, ticketId: String(req.params.ticketId) } });
  await audit(req.user!.id, "change.ticket_unlinked", "ChangeRequest", change.id, { ticketId: req.params.ticketId });
  res.status(204).send();
});

/** The people working on this change. Individuals rather than a Team entity — TimeSphere has no
 *  team concept beyond the reporting line, and inventing one here would be a second org chart. */
changeRouter.post("/:id/collaborators", requirePermission(permissions.CHANGES_WRITE), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadEditableChange(req);
  const userIds: string[] = Array.isArray(req.body?.userIds) ? req.body.userIds.slice(0, 50) : [];
  const roleLabel = typeof req.body?.roleLabel === "string" ? req.body.roleLabel.slice(0, 80) : null;
  if (userIds.length === 0) throw new AppError(422, "Pick at least one person.");

  const users = await prisma.user.findMany({ where: { id: { in: userIds }, deletedAt: null }, select: { id: true } });
  await prisma.changeCollaborator.createMany({
    data: users.map((u) => ({ changeId: change.id, userId: u.id, roleLabel, addedById: req.user!.id })),
    skipDuplicates: true
  });
  await audit(req.user!.id, "change.collaborators_added", "ChangeRequest", change.id, { userIds });
  res.status(201).json(await prisma.changeRequest.findFirst({ where: { id: change.id }, include: CHANGE_INCLUDE }));
});

changeRouter.delete("/:id/collaborators/:userId", requirePermission(permissions.CHANGES_WRITE), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadEditableChange(req);
  await prisma.changeCollaborator.deleteMany({ where: { changeId: change.id, userId: String(req.params.userId) } });
  await audit(req.user!.id, "change.collaborator_removed", "ChangeRequest", change.id, { userId: req.params.userId });
  res.status(204).send();
});

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

/** What is wrong with a proposed window. A GET because it writes nothing and the form calls it on
 *  every date edit — safe to re-run, cacheable, and it never blocks anything on its own. */
/**
 * Everything about this change that can be DERIVED rather than typed — what it ships, whether CI is
 * green, who did the work, and how the last few changes to the same application went.
 *
 * Its own route rather than part of `GET /:id` because it reads across tickets, branches, CI runs,
 * findings and timesheets: worth paying for when somebody opens the Context tab, not on every load
 * of a form they came to edit one field on.
 */
changeRouter.get("/:id/context", async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await prisma.changeRequest.findFirst({
    where: { id: String(req.params.id) },
    select: { id: true, ticket: { select: { projectId: true } } }
  });
  if (!change) throw new AppError(404, "Change not found");
  // Scoped exactly like everything else here: a change is a ticket, so it can never be more visible
  // than one, and neither can anything derived from it.
  await assertTicketVisible(req, change.ticket.projectId);
  res.json(await buildChangeContext(change.id));
});

changeRouter.get("/:id/conflicts", async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await prisma.changeRequest.findFirst({
    where: { id: String(req.params.id) },
    select: { id: true, environment: true, plannedStart: true, plannedEnd: true, ticket: { select: { projectId: true } } }
  });
  if (!change) throw new AppError(404, "Change not found");
  await assertTicketVisible(req, change.ticket.projectId);
  if (!change.plannedStart || !change.plannedEnd) return res.json({ conflicts: [] });

  const conflicts = await findScheduleConflicts({
    changeId: change.id,
    environment: change.environment,
    plannedStart: change.plannedStart,
    plannedEnd: change.plannedEnd
  });
  res.json({ conflicts });
});

/* ------------------------------------------------------------------ *
 * Master data (read)
 * ------------------------------------------------------------------ */

changeRouter.get("/config/master-data", async (_req, res) => {
  await assertChangeManagementEnabled();
  const [categories, sources, applications, riskParameters] = await Promise.all([
    prisma.changeCategory.findMany({ where: { isActive: true }, orderBy: [{ order: "asc" }, { name: "asc" }] }),
    prisma.changeSource.findMany({ where: { isActive: true }, orderBy: [{ order: "asc" }, { name: "asc" }] }),
    prisma.changeApplication.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    prisma.changeRiskParameter.findMany({ where: { isActive: true }, orderBy: [{ order: "asc" }] })
  ]);
  res.json({ categories, sources, applications, riskParameters });
});

/** Readable by anyone signed in — the page has to know whether the module is on before it can say
 *  anything useful — and writable only by a super admin, like every other workspace switch. */
changeRouter.get("/config/settings", async (_req, res) => {
  const settings = await getChangeSettings();
  const entitlements = await getPlanningEntitlements(requireTenantContext().orgId);
  res.json({
    settings,
    entitlements: {
      changeManagementEnabled: entitlements.changeManagementEnabled,
      maxChangePolicies: entitlements.maxChangePolicies
    },
    // The AND, computed server-side so the client can never offer a page the API then refuses — the
    // rule the planning layer's `effective` object follows.
    effective: settings.enableChangeManagement && entitlements.changeManagementEnabled
  });
});

const settingsSchema = z.object({
  body: z
    .object({
      enableChangeManagement: z.boolean().optional(),
      approvalSlaHours: z.number().int().min(1).max(720).optional(),
      requireFaceOnApproval: z.boolean().optional()
    })
    .strict()
});

changeRouter.patch("/config/settings", requireSuperAdmin, validate(settingsSchema), async (req, res) => {
  const updated = await prisma.globalChangeSettings.upsert({
    where: { id: "global" },
    update: { ...req.body, updatedById: req.user!.id },
    create: { id: "global", remindHoursBefore: [24, 1], ...req.body, updatedById: req.user!.id }
  });
  await audit(req.user!.id, "change.settings_updated", "GlobalChangeSettings", "global", req.body);
  res.json(updated);
});

/* ------------------------------------------------------------------ *
 * Implementation steps, test cases, dependencies — the runbook
 * ------------------------------------------------------------------ *
 *
 * WHY THESE THREE SHARE A SECTION: they are the runbook. The plan says what will be done, the tests
 * say how anyone will know it worked, and the dependencies say what has to be true first. All three
 * are child rows of one change, all three are edited by the same people under the same rule, and all
 * three are already read straight off `CHANGE_INCLUDE` — so there is no GET here, only writes.
 *
 * WHY THE RUNBOOK STAYS EDITABLE AFTER APPROVAL: `assertMayEditChange` freezes a change's plan once it
 * is APPROVED, and that is right for scope, risk and schedule — those are what got approved. It is
 * wrong for the runbook: recording that step 4 failed, or that a regression test passed, is precisely
 * the work that happens after approval and during implementation. These routes therefore check
 * visibility and authorship but deliberately do NOT apply the freeze.
 */

const STEP_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "FAILED", "SKIPPED"] as const;
const TEST_STATUSES = ["NOT_STARTED", "PASSED", "FAILED", "BLOCKED"] as const;
const DEPENDENCY_TYPES = ["PREDECESSOR", "SUCCESSOR", "RELATED", "BLOCKS"] as const;
const DEPENDENCY_STATUSES = ["OPEN", "COMPLETED", "WAIVED"] as const;

/**
 * The same visibility and authorship rule as editing a change, minus the post-approval freeze.
 *
 * Its own helper rather than a flag on `loadEditableChange`, because the difference is a decision and
 * not a parameter: the runbook is meant to be filled in while the change is being executed.
 */
async function loadChangeForRunbook(req: any) {
  const change = await prisma.changeRequest.findFirst({
    where: { id: String(req.params.id) },
    include: { ticket: { select: { id: true, projectId: true, reporterId: true, assigneeId: true } } }
  });
  if (!change) throw new AppError(404, "Change not found");
  await assertTicketVisible(req, change.ticket.projectId);
  const privileged = ["SUPER_ADMIN", "ADMIN"].includes(req.user.role) || req.user.permissions.includes(permissions.CHANGES_MANAGE);
  const isParty = change.ticket.reporterId === req.user.id || change.ticket.assigneeId === req.user.id;
  if (!privileged && !isParty) {
    throw new AppError(403, "Only this change's requester, its implementer, or a change manager can edit its runbook.");
  }
  return change;
}

const stepSchema = z.object({
  body: z.object({
    description: z.string().trim().min(1).max(2000),
    ownerId: z.string().uuid().nullish(),
    plannedStart: z.string().datetime().nullish(),
    plannedEnd: z.string().datetime().nullish(),
    status: z.enum(STEP_STATUSES).optional(),
    comments: z.string().trim().max(2000).nullish()
  })
});

changeRouter.post("/:id/steps", requirePermission(permissions.CHANGES_WRITE), validate(stepSchema), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadChangeForRunbook(req);

  // Numbered from the current maximum rather than the row count, so deleting step 2 of 3 does not
  // make the next new step a second step 3.
  const last = await prisma.changeImplementationStep.findFirst({
    where: { changeId: change.id },
    orderBy: { stepNumber: "desc" },
    select: { stepNumber: true }
  });

  const step = await prisma.changeImplementationStep.create({
    data: {
      changeId: change.id,
      stepNumber: (last?.stepNumber ?? 0) + 1,
      description: req.body.description,
      ownerId: req.body.ownerId ?? null,
      plannedStart: req.body.plannedStart ? new Date(req.body.plannedStart) : null,
      plannedEnd: req.body.plannedEnd ? new Date(req.body.plannedEnd) : null,
      status: req.body.status ?? "NOT_STARTED",
      comments: req.body.comments ?? null
    }
  });
  await audit(req.user!.id, "change.step.create", "ChangeRequest", change.id, { stepNumber: step.stepNumber });
  res.status(201).json(step);
});

changeRouter.patch("/:id/steps/:stepId", requirePermission(permissions.CHANGES_WRITE), validate(z.object({ body: stepSchema.shape.body.partial() })), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadChangeForRunbook(req);
  const existing = await prisma.changeImplementationStep.findFirst({
    where: { id: String(req.params.stepId), changeId: change.id },
    select: { id: true }
  });
  if (!existing) throw new AppError(404, "Step not found on this change");

  const data: Prisma.ChangeImplementationStepUpdateInput = {};
  if (req.body.description !== undefined) data.description = req.body.description;
  if (req.body.ownerId !== undefined) data.owner = req.body.ownerId ? { connect: { id: req.body.ownerId } } : { disconnect: true };
  if (req.body.plannedStart !== undefined) data.plannedStart = req.body.plannedStart ? new Date(req.body.plannedStart) : null;
  if (req.body.plannedEnd !== undefined) data.plannedEnd = req.body.plannedEnd ? new Date(req.body.plannedEnd) : null;
  if (req.body.status !== undefined) data.status = req.body.status;
  if (req.body.comments !== undefined) data.comments = req.body.comments;

  const step = await prisma.changeImplementationStep.update({ where: { id: existing.id }, data });
  await audit(req.user!.id, "change.step.update", "ChangeRequest", change.id, { stepId: step.id, status: step.status });
  res.json(step);
});

changeRouter.delete("/:id/steps/:stepId", requirePermission(permissions.CHANGES_WRITE), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadChangeForRunbook(req);
  const deleted = await prisma.changeImplementationStep.deleteMany({
    where: { id: String(req.params.stepId), changeId: change.id }
  });
  if (deleted.count === 0) throw new AppError(404, "Step not found on this change");
  await audit(req.user!.id, "change.step.delete", "ChangeRequest", change.id, { stepId: String(req.params.stepId) });
  res.status(204).end();
});

const testSchema = z.object({
  body: z.object({
    reference: z.string().trim().max(40).optional(),
    description: z.string().trim().min(1).max(2000),
    expectedResult: z.string().trim().max(2000).nullish(),
    actualResult: z.string().trim().max(2000).nullish(),
    status: z.enum(TEST_STATUSES).optional(),
    testerId: z.string().uuid().nullish(),
    comments: z.string().trim().max(2000).nullish()
  })
});

changeRouter.post("/:id/tests", requirePermission(permissions.CHANGES_WRITE), validate(testSchema), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadChangeForRunbook(req);
  const count = await prisma.changeTestCase.count({ where: { changeId: change.id } });

  const test = await prisma.changeTestCase.create({
    data: {
      changeId: change.id,
      // A generated reference when none is given: the point of a test case is the assertion, and
      // making somebody invent an identifier first is how test sections end up empty.
      reference: req.body.reference?.trim() || "TC-" + String(count + 1).padStart(2, "0"),
      description: req.body.description,
      expectedResult: req.body.expectedResult ?? null,
      actualResult: req.body.actualResult ?? null,
      status: req.body.status ?? "NOT_STARTED",
      testerId: req.body.testerId ?? null,
      comments: req.body.comments ?? null
    }
  });
  await audit(req.user!.id, "change.test.create", "ChangeRequest", change.id, { reference: test.reference });
  res.status(201).json(test);
});

changeRouter.patch("/:id/tests/:testId", requirePermission(permissions.CHANGES_WRITE), validate(z.object({ body: testSchema.shape.body.partial() })), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadChangeForRunbook(req);
  const existing = await prisma.changeTestCase.findFirst({
    where: { id: String(req.params.testId), changeId: change.id },
    select: { id: true }
  });
  if (!existing) throw new AppError(404, "Test case not found on this change");

  const data: Prisma.ChangeTestCaseUpdateInput = {};
  if (req.body.reference !== undefined) data.reference = req.body.reference;
  if (req.body.description !== undefined) data.description = req.body.description;
  if (req.body.expectedResult !== undefined) data.expectedResult = req.body.expectedResult;
  if (req.body.actualResult !== undefined) data.actualResult = req.body.actualResult;
  if (req.body.status !== undefined) data.status = req.body.status;
  if (req.body.testerId !== undefined) data.tester = req.body.testerId ? { connect: { id: req.body.testerId } } : { disconnect: true };
  if (req.body.comments !== undefined) data.comments = req.body.comments;

  const test = await prisma.changeTestCase.update({ where: { id: existing.id }, data });
  await audit(req.user!.id, "change.test.update", "ChangeRequest", change.id, { testId: test.id, status: test.status });
  res.json(test);
});

changeRouter.delete("/:id/tests/:testId", requirePermission(permissions.CHANGES_WRITE), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadChangeForRunbook(req);
  const deleted = await prisma.changeTestCase.deleteMany({ where: { id: String(req.params.testId), changeId: change.id } });
  if (deleted.count === 0) throw new AppError(404, "Test case not found on this change");
  await audit(req.user!.id, "change.test.delete", "ChangeRequest", change.id, { testId: String(req.params.testId) });
  res.status(204).end();
});

const dependencySchema = z.object({
  body: z.object({
    dependencyType: z.enum(DEPENDENCY_TYPES).optional(),
    description: z.string().trim().min(1).max(2000),
    relatedChangeId: z.string().trim().max(64).nullish(),
    application: z.string().trim().max(120).nullish(),
    team: z.string().trim().max(120).nullish(),
    ownerId: z.string().uuid().nullish(),
    status: z.enum(DEPENDENCY_STATUSES).optional()
  })
});

changeRouter.post("/:id/dependencies", requirePermission(permissions.CHANGES_WRITE), validate(dependencySchema), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadChangeForRunbook(req);
  const dependency = await prisma.changeDependency.create({
    data: {
      changeId: change.id,
      dependencyType: req.body.dependencyType ?? "PREDECESSOR",
      description: req.body.description,
      relatedChangeId: req.body.relatedChangeId ?? null,
      application: req.body.application ?? null,
      team: req.body.team ?? null,
      ownerId: req.body.ownerId ?? null,
      status: req.body.status ?? "OPEN"
    }
  });
  await audit(req.user!.id, "change.dependency.create", "ChangeRequest", change.id, { dependencyType: dependency.dependencyType });
  res.status(201).json(dependency);
});

changeRouter.patch("/:id/dependencies/:dependencyId", requirePermission(permissions.CHANGES_WRITE), validate(z.object({ body: dependencySchema.shape.body.partial() })), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadChangeForRunbook(req);
  const existing = await prisma.changeDependency.findFirst({
    where: { id: String(req.params.dependencyId), changeId: change.id },
    select: { id: true }
  });
  if (!existing) throw new AppError(404, "Dependency not found on this change");

  const data: Prisma.ChangeDependencyUpdateInput = {};
  if (req.body.dependencyType !== undefined) data.dependencyType = req.body.dependencyType;
  if (req.body.description !== undefined) data.description = req.body.description;
  if (req.body.relatedChangeId !== undefined) data.relatedChangeId = req.body.relatedChangeId;
  if (req.body.application !== undefined) data.application = req.body.application;
  if (req.body.team !== undefined) data.team = req.body.team;
  if (req.body.ownerId !== undefined) data.owner = req.body.ownerId ? { connect: { id: req.body.ownerId } } : { disconnect: true };
  if (req.body.status !== undefined) data.status = req.body.status;

  const dependency = await prisma.changeDependency.update({ where: { id: existing.id }, data });
  await audit(req.user!.id, "change.dependency.update", "ChangeRequest", change.id, { dependencyId: dependency.id, status: dependency.status });
  res.json(dependency);
});

changeRouter.delete("/:id/dependencies/:dependencyId", requirePermission(permissions.CHANGES_WRITE), async (req, res) => {
  await assertChangeManagementEnabled();
  const change = await loadChangeForRunbook(req);
  const deleted = await prisma.changeDependency.deleteMany({
    where: { id: String(req.params.dependencyId), changeId: change.id }
  });
  if (deleted.count === 0) throw new AppError(404, "Dependency not found on this change");
  await audit(req.user!.id, "change.dependency.delete", "ChangeRequest", change.id, { dependencyId: String(req.params.dependencyId) });
  res.status(204).end();
});

/* ------------------------------------------------------------------ *
 * Master data — the dropdowns, editable
 * ------------------------------------------------------------------ *
 *
 * WHAT: list / create / rename / enable / disable / delete for every catalogue behind a change's
 * dropdowns — categories, sources, applications, risk parameters, SLA stages, maintenance windows
 * and blackout periods.
 *
 * WHY IT EXISTS: the tables were seeded and read, but nothing could edit them. A workspace whose
 * change categories are not ours had no way to say so short of a migration. Same gap
 * `activity-type.controller.ts` was written to close, and deliberately the same shape — one list
 * route readable by anyone who fills the form, writes behind the super admin.
 *
 * WHY DELETE IS REFUSED RATHER THAN CASCADED: a change is a record of something that happened, and
 * retiring a category a year later must not rewrite or orphan the changes filed under it. Every
 * delete that would strand history answers 409 with the count and points at disabling instead —
 * which removes it from the picker and leaves the record readable. Exactly the rule activity types
 * follow for timesheets.
 *
 * WHY ONE FACTORY FOR SEVEN CATALOGUES: they are the same interaction seven times. Writing them out
 * separately is how the sixth one ends up without an audit entry.
 */

/** Everything that differs between one catalogue and the next. */
interface CatalogueSpec {
  /** URL segment under `/changes/config`. */
  path: string;
  /** Singular, for error messages people read. */
  label: string;
  /** The Prisma delegate. Typed loosely on purpose — seven delegates share no common interface, and
   *  the alternative is seven copies of this file. */
  model: any;
  /** Zod shape for create; the PATCH schema is this, partial. */
  shape: z.ZodRawShape;
  orderBy: any;
  /** How many live records would be stranded by deleting this row. Omitted where nothing points at
   *  it, in which case delete is unconditional. */
  usage?: (id: string, row: any) => Promise<number>;
  /** What the stranded records ARE, for the refusal message. */
  usageNoun?: string;
}

const CATALOGUES: CatalogueSpec[] = [
  {
    path: "categories",
    label: "category",
    model: () => prisma.changeCategory,
    shape: {
      name: z.string().trim().min(1).max(80),
      color: z.string().trim().max(20).nullish(),
      requiresSecurityReview: z.boolean().optional(),
      isActive: z.boolean().optional(),
      order: z.number().int().min(0).max(9999).optional()
    },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    usage: (id) => prisma.changeRequest.count({ where: { categoryId: id } }),
    usageNoun: "change"
  },
  {
    path: "sources",
    label: "source",
    model: () => prisma.changeSource,
    shape: {
      name: z.string().trim().min(1).max(80),
      isActive: z.boolean().optional(),
      order: z.number().int().min(0).max(9999).optional()
    },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    usage: (id) => prisma.changeRequest.count({ where: { sourceId: id } }),
    usageNoun: "change"
  },
  {
    path: "applications",
    label: "application",
    model: () => prisma.changeApplication,
    shape: {
      name: z.string().trim().min(1).max(120),
      code: z.string().trim().max(40).nullish(),
      ownerId: z.string().uuid().nullish(),
      isActive: z.boolean().optional()
    },
    orderBy: [{ name: "asc" }],
    usage: (id) => prisma.changeRequest.count({ where: { applicationId: id } }),
    usageNoun: "change"
  },
  {
    path: "risk-parameters",
    label: "risk parameter",
    model: () => prisma.changeRiskParameter,
    shape: {
      key: z
        .string()
        .trim()
        .min(1)
        .max(60)
        // The scoring engine reads this key out of each change's stored `riskInputs`, so it has to be
        // a stable identifier rather than prose. Constrained at the edge, where the mistake is cheap.
        .regex(/^[a-zA-Z]\w*$/, "Use letters, digits and underscores, starting with a letter"),
      label: z.string().trim().min(1).max(120),
      weight: z.number().int().min(0).max(100).optional(),
      isActive: z.boolean().optional(),
      order: z.number().int().min(0).max(9999).optional()
    },
    orderBy: [{ order: "asc" }],
    usage: async (_id, row) => countChangesScoredOn(row.key),
    usageNoun: "assessed change"
  },
  {
    path: "sla",
    label: "SLA stage",
    model: () => prisma.changeSlaConfig,
    shape: {
      stage: z.string().trim().min(1).max(40),
      hours: z.number().int().min(1).max(8760).optional(),
      warnAtPct: z.number().int().min(1).max(99).optional(),
      isActive: z.boolean().optional()
    },
    orderBy: [{ stage: "asc" }]
  },
  {
    path: "maintenance-windows",
    label: "maintenance window",
    model: () => prisma.maintenanceWindow,
    shape: {
      name: z.string().trim().min(1).max(120),
      environment: z.enum(["DEVELOPMENT", "QA", "UAT", "STAGING", "PRODUCTION", "DR"]).optional(),
      dayOfWeek: z.number().int().min(0).max(6),
      startMinute: z.number().int().min(0).max(1439),
      endMinute: z.number().int().min(0).max(1439),
      isActive: z.boolean().optional()
    },
    orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }]
  },
  {
    path: "blackouts",
    label: "blackout period",
    model: () => prisma.blackoutPeriod,
    shape: {
      name: z.string().trim().min(1).max(120),
      reason: z.string().trim().max(2000).nullish(),
      environment: z.enum(["DEVELOPMENT", "QA", "UAT", "STAGING", "PRODUCTION", "DR"]).nullish(),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      isActive: z.boolean().optional()
    },
    orderBy: [{ startsAt: "desc" }]
  }
];

/**
 * How many changes were assessed against a risk parameter.
 *
 * WHY IT READS THE COLUMN RATHER THAN FILTERING IN SQL: `riskInputs` is a JSON map keyed by
 * parameter key, and JSON path filtering differs between MySQL and MariaDB — this app runs on both.
 * Selecting one column and counting in memory is portable, and this runs only when a super admin
 * tries to delete a parameter, which is rare.
 *
 * The stored `riskScore` is NOT affected by deleting a parameter — the score is a column, recorded
 * against whichever set was active when it was made. What deleting breaks is the ability to read
 * back WHY: the answers stay in `riskInputs` under a key nothing can name any more.
 */
async function countChangesScoredOn(key: string): Promise<number> {
  const rows = await prisma.changeRequest.findMany({ select: { riskInputs: true } });
  return rows.filter((r) => {
    const inputs = r.riskInputs as Record<string, unknown> | null;
    return Boolean(inputs && typeof inputs === "object" && inputs[key]);
  }).length;
}

/** Dates arrive as ISO strings and have to reach Prisma as Dates. */
function coerceDates(body: Record<string, any>): Record<string, any> {
  const out = { ...body };
  for (const field of ["startsAt", "endsAt"]) {
    if (typeof out[field] === "string") out[field] = new Date(out[field]);
  }
  return out;
}

for (const spec of CATALOGUES) {
  const base = `/config/${spec.path}`;

  /**
   * Readable by anyone signed in who can see change management at all, deliberately: everybody
   * raising a change needs these lists to fill the form. `?all=true` additionally returns disabled
   * rows and is gated — that view is for the settings screen, and offering a retired category in the
   * raise form is the thing disabling it was meant to stop.
   */
  changeRouter.get(base, async (req, res) => {
    await assertChangeManagementEnabled();
    const wantsAll = req.query.all === "true" && req.user!.role === "SUPER_ADMIN";
    const rows = await spec.model().findMany({
      where: wantsAll ? {} : { isActive: true },
      orderBy: spec.orderBy
    });
    res.json(rows);
  });

  changeRouter.post(base, requireSuperAdmin, validate(z.object({ body: z.object(spec.shape).strict() })), async (req, res) => {
    await assertChangeManagementEnabled();
    const row = await spec.model().create({ data: coerceDates(req.body) });
    await audit(req.user!.id, `change.${spec.path}.created`, "ChangeConfig", row.id, { path: spec.path, name: row.name ?? row.stage ?? row.key });
    res.status(201).json(row);
  });

  changeRouter.patch(
    `${base}/:id`,
    requireSuperAdmin,
    validate(z.object({ body: z.object(spec.shape).partial().strict() })),
    async (req, res) => {
      await assertChangeManagementEnabled();
      const existing = await spec.model().findUnique({ where: { id: String(req.params.id) } });
      if (!existing) throw new AppError(404, `That ${spec.label} no longer exists.`);
      const row = await spec.model().update({ where: { id: existing.id }, data: coerceDates(req.body) });
      await audit(req.user!.id, `change.${spec.path}.updated`, "ChangeConfig", row.id, { path: spec.path, fields: Object.keys(req.body) });
      res.json(row);
    }
  );

  changeRouter.delete(`${base}/:id`, requireSuperAdmin, async (req, res) => {
    await assertChangeManagementEnabled();
    const existing = await spec.model().findUnique({ where: { id: String(req.params.id) } });
    if (!existing) throw new AppError(404, `That ${spec.label} no longer exists.`);

    if (spec.usage) {
      const used = await spec.usage(existing.id, existing);
      if (used > 0) {
        const noun = spec.usageNoun ?? "record";
        throw new AppError(
          409,
          `${used} ${used === 1 ? noun : `${noun}s`} ${used === 1 ? "uses" : "use"} this ${spec.label}, so it cannot be deleted. ` +
            `Disable it instead — it disappears from the form and the existing records stay readable.`
        );
      }
    }

    await spec.model().delete({ where: { id: existing.id } });
    await audit(req.user!.id, `change.${spec.path}.deleted`, "ChangeConfig", existing.id, {
      path: spec.path,
      name: existing.name ?? existing.stage ?? existing.key
    });
    res.status(204).end();
  });
}
