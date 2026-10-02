/**
 * Reporting & analytics endpoints. Two tiers: personal (`/employee-summary`, `/daily-status`,
 * no permission gate beyond auth — a user's own numbers) and workspace-wide (`/admin-summary`,
 * `/ticket-summary`, `/ticket-insights`, `/cost-insights`, `/leaderboard`, all gated
 * `REPORTS_VIEW`). `/cost-insights` and `/leaderboard` additionally 403 unless their own
 * GlobalTicketSettings toggle is on — they're opt-in because they touch compensation-adjacent
 * data (hourly rates) or individual rankings.
 *
 * WHY reopen rate is computed from AuditLog rather than Ticket.resolvedAt: reopening a ticket
 * clears resolvedAt back to null (see ticket.controller.ts's status-update handler), so the
 * audit trail (`action: "ticket.status_changed"`) is the only durable record of "was this ever
 * resolved, and was it later reopened."
 */
import { Router, type Request, type Response } from "express";
import PDFDocument from "pdfkit";
import {
  permissions,
  qualityDisciplineFindingTypes,
  resolvedSecurityFindingStatuses,
  securityDisciplineFindingTypes,
  unresolvedSecurityFindingStatuses
} from "@timesheet/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { parseDayWindow, windowDays } from "../utils/date-window.js";
import { controlPrisma } from "../config/control-prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { generateStatusReport } from "../services/ai.service.js";
import { computeTimesheetCost } from "../services/billing-rate.service.js";
import { buildTimesheetAnalytics } from "../services/timesheet-analytics.service.js";
import { buildAdminSummary } from "../services/admin-summary.service.js";
import { buildLeaderboard, buildTicketInsights, buildTicketSummary, istWeekStarts, weekIndexFor, weekLabel } from "../services/ticket-analytics.service.js";
import { median } from "../services/workspace-metrics.js";
import {
  GROUP_BY_KEYS,
  REPORT_INCLUDE,
  REPORT_ORDER_BY,
  REPORT_ROW_LIMIT,
  TIMESHEET_CSV_HEADER,
  buildTimesheetExportDocument,
  buildTimesheetReport,
  buildTimesheetWhere,
  resolveReportFilterNames,
  resolveReviewerNames,
  timesheetCsvValues,
  toCsvLine,
  type GroupByKey,
  type TimesheetReportFilters
} from "../services/timesheet-report.service.js";
import { buildTimesheetReportWorkbook } from "../services/timesheet-report-xlsx.service.js";
import { renderTimesheetReportPdf } from "../services/timesheet-report-pdf.service.js";
import { userClock } from "../services/user-clock.service.js";

export const reportRouter = Router();
reportRouter.use(requireAuth);

function startOfLocalDay(date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

reportRouter.get("/employee-summary", async (req, res) => {
  const rows = await prisma.timesheet.groupBy({
    by: ["status", "activityType"],
    where: { userId: req.user!.id, deletedAt: null },
    _sum: { totalHours: true },
    _count: true
  });
  res.json(rows);
});

/**
 * Personal status for a period: hours logged + whether a reminder/escalation has been raised
 * against the calling user. Used by the dashboard hero card.
 *
 * Takes `from`/`to`; with neither it answers for today exactly as it always did. The card's copy
 * follows the period rather than saying "today" over a month of data, which is why `days` is
 * returned — the caller cannot infer it from the numbers alone.
 */
reportRouter.get("/daily-status", async (req, res) => {
  // The caller's own day (User.timezone, else the workspace zone) — the same answer the Inbox brief
  // and the daily reminder give. The server's date made a New York evening "tomorrow".
  const { today, dayStart: sinceLocal } = await userClock(req.user!.id);
  const window = parseDayWindow(req.query);
  const from = window.from ?? today;
  const to = window.to ?? today;
  const days = windowDays(from, to);
  const [aggregate, reminded, escalated] = await Promise.all([
    // REJECTED left out: a refused entry is meant to be re-logged, so counting it beside its
    // replacement made a rejected-then-relogged day read double. History already excludes them.
    prisma.timesheet.aggregate({
      where: { userId: req.user!.id, workDate: { gte: from, lte: to }, deletedAt: null, status: { not: "REJECTED" } },
      _sum: { totalHours: true },
      _count: true
    }),
    // Reminders stay scoped to TODAY even over a longer range: "were you nudged" is a live fact
    // about right now, and answering "yes, at some point in the last 30 days" would turn a
    // prompt-to-act into background noise.
    prisma.notification.count({
      where: { userId: req.user!.id, category: "reminder.daily", createdAt: { gte: sinceLocal } }
    }),
    prisma.notification.count({
      where: { userId: req.user!.id, category: "reminder.escalation", createdAt: { gte: sinceLocal } }
    })
  ]);
  res.json({
    date: to.toISOString().slice(0, 10),
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    days,
    entries: aggregate._count,
    hours: Number(aggregate._sum.totalHours ?? 0),
    reminderReceived: reminded > 0,
    escalated: escalated > 0
  });
});

/**
 * The workspace summary behind the home page's admin cards and the Reports page's tiles. The
 * figures and their definitions live in services/admin-summary.service.ts — see its header for what
 * each one used to get wrong. With no `from`/`to` it answers for today.
 */
reportRouter.get("/admin-summary", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  res.json(await buildAdminSummary(req.query, new Date(), { viewerId: req.user!.id }));
});

/**
 * Ticket metrics for the Reports page — kept separate from /admin-summary (already a large batched
 * payload). Definitions and windows: services/ticket-analytics.service.ts.
 */
// Broadened to every authenticated member (was reports:view). Team leads and employees can now see workspace productivity — see docs note on the org-visibility change.
reportRouter.get("/ticket-summary", async (_req, res) => {
  res.json(await buildTicketSummary());
});

/**
 * Bundled ticket analytics for the Insights page — velocity, SLA compliance, cycle time, module
 * hotspots, reopen rate, first-response time, per-assignee workload and estimate-vs-actual, over the
 * last eight IST weeks. Definitions and windows: services/ticket-analytics.service.ts.
 */
// Broadened to every authenticated member (was reports:view). Team leads and employees can now see workspace productivity — see docs note on the org-visibility change.
reportRouter.get("/ticket-insights", async (_req, res) => {
  res.json(await buildTicketInsights());
});

const SECURITY_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
/** The by-type breakdown iterates a shared constant rather than a literal copy of one: a type this
 *  list did not know about was ingested, stored, counted in `totalOpen` — and then missing from the
 *  chart that is supposed to say where the risk is. It is the SECURITY slice of
 *  `securityFindingTypes`, because this chart sits under the security totals; the quality types get
 *  their own list in the `quality` block below. */
const SECURITY_TYPES = securityDisciplineFindingTypes;
/**
 * This page's definition of "still a problem" and "done with", read from the shared bucket map
 * (`securityFindingStatusBuckets`) rather than typed out here — see that map's comment for the
 * four hand-maintained copies this replaced and what a missing status did to them.
 *
 * THE DECISION THIS PAGE MAKES: `unresolved` = open + pending, so a finding somebody has marked
 * fixed but no scan has confirmed still counts on every number below — the open totals, the
 * severity breakdown, the per-repo table and the risk score. The alternative would let a
 * workspace's headline security figure be improved by closing tickets rather than by fixing code.
 * `resolved` stays strictly the confirmed-or-accepted set, which is what
 * `meanTimeToRemediateHours` should measure: time until a fix was PROVEN, not until it was
 * claimed.
 */
const OPEN_FINDING_STATUSES = unresolvedSecurityFindingStatuses;
const RESOLVED_FINDING_STATUSES = resolvedSecurityFindingStatuses;

/**
 * THE OTHER DECISION THIS PAGE MAKES, and the one SonarQube/ESLint ingestion forced: every headline
 * number on this page is SECURITY-discipline only.
 *
 * Quality findings (Sonar's bugs and code smells, lint results) arrive through the same webhook into
 * the same table, and a busy monorepo produces them by the thousand. Counted here they would climb
 * the risk score, fill the by-severity chart with MEDIUMs, dominate the per-repo and per-module
 * tables, and bury the one CRITICAL that actually matters. Nothing about that would be a bug — every
 * row is a real thing a real tool found — which is exactly why it is dangerous: the page would keep
 * working and quietly stop measuring security.
 *
 * They are NOT dropped. `quality` in the response below carries their own totals, severity mix and
 * type breakdown, so the page can show them in their own section — see SecurityInsights.tsx. One
 * table, two questions, answered separately.
 */
const SECURITY_DISCIPLINE = { type: { in: securityDisciplineFindingTypes } };
const QUALITY_DISCIPLINE = { type: { in: qualityDisciplineFindingTypes } };

/** Weighted, age-decayed org-wide risk score — see docs/ROADMAP.md's "Competitive parity"
 *  section (Phase 2). Deliberately simple (not trying to match Black Duck's CVSS-aware BDSA
 *  scoring): critical/high/medium/low weights roughly mirror how urgently each severity should
 *  be worked, and the age decay (halving influence every 30 days a finding stays open) means a
 *  score reflects "how much open risk right now," not a monotonically growing backlog count. */
function computeRiskScore(openFindings: Array<{ severity: (typeof SECURITY_SEVERITIES)[number]; createdAt: Date }>): number {
  const WEIGHT: Record<(typeof SECURITY_SEVERITIES)[number], number> = { CRITICAL: 10, HIGH: 5, MEDIUM: 2, LOW: 1 };
  const now = Date.now();
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
  return Math.round(
    openFindings.reduce((sum, f) => {
      const ageMs = Math.max(0, now - f.createdAt.getTime());
      const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
      return sum + WEIGHT[f.severity] * Math.max(decay, 0.25); // floor at 25% — an old CRITICAL is still worth flagging, not zeroed out
    }, 0)
  );
}

/**
 * Security & DevOps analytics — findings-over-time trend, open-by-severity/type breakdown,
 * mean-time-to-remediate, top repos by finding count, open findings per MODULE, and the org-wide
 * risk score. Powers the Security insights page (Phase 2 of the "Competitive parity" roadmap
 * section) the same way /ticket-insights powers the Insights page — one batched call, everything
 * the page needs.
 *
 * The per-module breakdown is the one figure here no scanner vendor can produce: it needs the work
 * breakdown (Project → ProjectModule) and the map from repository paths onto it, and a scanner owns
 * neither. It is only as complete as the routing rules an admin has written, which is why
 * `openWithoutModuleCount` is reported beside it rather than left for somebody to infer.
 *
 * WHAT "MEAN TIME TO REMEDIATE" NOW MEASURES, per finding, in this order:
 *
 *   1. `verifiedFixedAt - firstSeenAt` when a scan PROVED the fix — the real answer. That column is
 *      written only by the verification verdict (security-report.service.ts), never by any human
 *      action, so this half of the average measures remediation rather than measuring how willing
 *      somebody was to close a ticket.
 *   2. `updatedAt - createdAt` otherwise — the old approximation, kept deliberately so that findings
 *      resolved before verification existed, and findings an admin accepted as risk (which no scan
 *      will ever confirm), still report SOMETHING instead of vanishing from the figure the day this
 *      shipped.
 *
 * BE HONEST ABOUT (2). `updatedAt` moves on every re-sighting, so a FIXED finding a scanner keeps
 * reporting inflates its own remediation time — a flaw the deduplication work made worse, and the
 * reason (1) exists. The two are averaged together rather than reported separately because a
 * workspace's history is mostly (2) and would otherwise read as a step change on the day it turned
 * verification on. `verifiedFixedCount` beside it is what says how much of this figure is real:
 * when that number approaches the resolved count, the average is measurement rather than estimate.
 */
// Broadened to every authenticated member (was reports:view). NOTE: this deliberately exposes the workspace's security findings / SBOM to all staff — an internal-transparency decision, reversible by restoring requirePermission(REPORTS_VIEW).
reportRouter.get("/security-insights", async (_req, res) => {
  // IST weeks, the same buckets the Insights page uses (services/ticket-analytics.service.ts).
  const weeks = istWeekStarts(8, new Date());
  const rangeStart = weeks[0];
  const sinceLocal = startOfLocalDay();
  const yesterdayLocal = new Date(sinceLocal);
  yesterdayLocal.setDate(yesterdayLocal.getDate() - 1);

  const [
    openFindings,
    findingsInRange,
    resolvedFindings,
    byType,
    topRepos,
    openYesterday,
    awaitingVerificationCount,
    openByModuleRows,
    openWithoutModuleCount,
    openQualityFindings,
    qualityByType
  ] = await Promise.all([
    prisma.securityFinding.findMany({
      where: { status: { in: OPEN_FINDING_STATUSES }, ...SECURITY_DISCIPLINE },
      select: { severity: true, createdAt: true }
    }),
    prisma.securityFinding.findMany({
      where: { createdAt: { gte: rangeStart }, ...SECURITY_DISCIPLINE },
      select: { createdAt: true, severity: true }
    }),
    prisma.securityFinding.findMany({
      where: { status: { in: RESOLVED_FINDING_STATUSES }, updatedAt: { gte: rangeStart }, ...SECURITY_DISCIPLINE },
      // `firstSeenAt` is when this exact problem was FIRST reported, which is what "how long did it
      // take to remediate" should be measured from — `createdAt` is the row's birthday and only
      // happens to be the same thing for a finding that was never deduplicated.
      select: { createdAt: true, updatedAt: true, firstSeenAt: true, verifiedFixedAt: true }
    }),
    prisma.securityFinding.groupBy({ by: ["type"], where: { status: { in: OPEN_FINDING_STATUSES }, ...SECURITY_DISCIPLINE }, _count: true }),
    prisma.securityFinding.groupBy({
      by: ["repository"],
      where: { status: { in: OPEN_FINDING_STATUSES }, repository: { not: null }, ...SECURITY_DISCIPLINE },
      _count: true,
      orderBy: { _count: { repository: "desc" } },
      take: 10
    }),
    prisma.securityFinding.count({ where: { status: { in: OPEN_FINDING_STATUSES }, createdAt: { lt: sinceLocal }, ...SECURITY_DISCIPLINE } }),
    // Claimed fixed, waiting on a scan to agree. A LIVE count rather than a windowed one, because
    // unlike everything else on this page it is a queue somebody can act on right now — and it is
    // the number that says whether verification is actually running or just switched on.
    prisma.securityFinding.count({ where: { verificationState: "AWAITING_PROOF", ...SECURITY_DISCIPLINE } }),
    // WHICH PART OF THE PRODUCT CARRIES THE RISK — grouped on the module the ingest resolved from
    // the finding's repository and path (see services/finding-routing.service.ts). Uses the same
    // `OPEN_FINDING_STATUSES` as every other number on this page, so a module's count and the
    // headline total are answering the same question.
    prisma.securityFinding.groupBy({
      by: ["moduleId"],
      where: { status: { in: OPEN_FINDING_STATUSES }, moduleId: { not: null }, ...SECURITY_DISCIPLINE },
      _count: true,
      orderBy: { _count: { moduleId: "desc" } },
      take: 10
    }),
    // Reported beside the breakdown rather than hidden by it: a table of five modules means
    // something very different when four hundred findings are routed nowhere. This is also the
    // number that tells an admin their rule set has a hole in it.
    prisma.securityFinding.count({ where: { status: { in: OPEN_FINDING_STATUSES }, moduleId: null, ...SECURITY_DISCIPLINE } }),
    // --- The quality discipline, counted entirely separately ------------------------------------
    // Two queries, not nine: this section answers "how big is the code-quality backlog and what is
    // in it", which is all the page needs to render it beside the security numbers. Everything the
    // security half computes and this one does not — a risk score, a remediation average, a per-repo
    // table — is deliberately absent, because those figures are claims about EXPOSURE and a code
    // smell is not one.
    prisma.securityFinding.findMany({
      where: { status: { in: OPEN_FINDING_STATUSES }, ...QUALITY_DISCIPLINE },
      select: { severity: true }
    }),
    prisma.securityFinding.groupBy({ by: ["type"], where: { status: { in: OPEN_FINDING_STATUSES }, ...QUALITY_DISCIPLINE }, _count: true })
  ]);

  // Names are looked up after the aggregation rather than joined into it — `groupBy` cannot include
  // a relation, and this is one small query against at most ten ids. Skipped entirely when the
  // breakdown is empty, which is every workspace that has not written routing rules yet: there is
  // nothing to name, so there is no reason to ask.
  const breakdownModuleIds = openByModuleRows.map((row) => row.moduleId).filter((id): id is string => Boolean(id));
  const breakdownModules = breakdownModuleIds.length
    ? await prisma.projectModule.findMany({
        where: { id: { in: breakdownModuleIds } },
        select: { id: true, name: true, project: { select: { name: true, code: true } } }
      })
    : [];
  const moduleById = new Map(breakdownModules.map((module) => [module.id, module]));

  const countBySeverity = (rows: Array<{ severity: (typeof SECURITY_SEVERITIES)[number] }>) =>
    Object.fromEntries(SECURITY_SEVERITIES.map((s) => [s, rows.filter((f) => f.severity === s).length])) as Record<
      (typeof SECURITY_SEVERITIES)[number],
      number
    >;
  const openBySeverity = countBySeverity(openFindings);

  const findingsOverTime = weeks.map((weekStart, index) => ({
    weekStart: weekLabel(weekStart),
    count: findingsInRange.filter((f) => weekIndexFor(f.createdAt, weeks) === index).length
  }));

  // Proof where there is proof, the old approximation where there is not — see this route's header
  // for why the two are averaged together rather than reported as separate figures.
  const remediationHours = resolvedFindings.map((f) =>
    f.verifiedFixedAt
      ? (f.verifiedFixedAt.getTime() - f.firstSeenAt.getTime()) / (1000 * 60 * 60)
      : (f.updatedAt.getTime() - f.createdAt.getTime()) / (1000 * 60 * 60)
  );
  // The MEDIAN over the eight-week window, and null — not 0h — when nothing was remediated in it. A
  // mean let one finding that sat open for a year set the figure, and 0 claimed instant fixes.
  const medianTimeToRemediateHours = median(remediationHours);
  const verifiedFixedCount = resolvedFindings.filter((f) => f.verifiedFixedAt).length;

  const riskScore = computeRiskScore(openFindings);
  const riskScoreYesterday = computeRiskScore(openFindings.filter((f) => f.createdAt < sinceLocal));

  res.json({
    totalOpen: openFindings.length,
    totalOpenYesterday: openYesterday,
    openBySeverity,
    byType: SECURITY_TYPES.map((type) => ({ type, count: byType.find((row) => row.type === type)?._count ?? 0 })),
    findingsOverTime,
    meanTimeToRemediateHours: medianTimeToRemediateHours === null ? null : Number(medianTimeToRemediateHours.toFixed(1)),
    /** Same figure under its true name — the median — and the sample it covers. The old key stays
     *  for callers that read it; it now carries the median and is null when nothing was remediated. */
    medianTimeToRemediateHours: medianTimeToRemediateHours === null ? null : Number(medianTimeToRemediateHours.toFixed(1)),
    remediatedCount: remediationHours.length,
    /** How many of the findings behind that average were confirmed gone by a scan rather than
     *  estimated from `updatedAt`. Reported beside the average, never folded into it, so a reader can
     *  see how much of the number is measurement. */
    verifiedFixedCount,
    awaitingVerificationCount,
    topRepositories: topRepos.map((row) => ({ repository: row.repository ?? "Unknown", count: row._count })),
    /** Open findings per module of the work breakdown. A module whose row has vanished between the
     *  aggregation and the name lookup (deleted mid-request) is reported as "Unknown" rather than
     *  dropped — its findings are still open and still counted in `totalOpen`. */
    openByModule: openByModuleRows.map((row) => {
      const module = row.moduleId ? moduleById.get(row.moduleId) : undefined;
      return {
        moduleId: row.moduleId,
        moduleName: module?.name ?? "Unknown",
        projectName: module?.project.name ?? "Unknown",
        projectCode: module?.project.code ?? null,
        count: row._count
      };
    }),
    /** Open findings no path rule has claimed. Not an error — it is every finding in a workspace
     *  that has not written a rule yet, and it is what makes the breakdown above honest. */
    openWithoutModuleCount,
    riskScore,
    riskScoreYesterday,
    /**
     * THE CODE-QUALITY BACKLOG, in its own block so the page can render it in its own section.
     *
     * Every number above this line is security-only (see `SECURITY_DISCIPLINE`). These three are the
     * quality equivalent, and they are deliberately fewer: a count, a severity mix and a type
     * split — no risk score, no trend, no remediation average. Those figures are statements about
     * exposure, and giving code smells one would be exactly the conflation this split exists to
     * prevent. `totalOpen` here plus `totalOpen` above is the whole open backlog, which is a number
     * nothing on this page reports, on purpose: adding them together answers no question anyone has.
     */
    quality: {
      totalOpen: openQualityFindings.length,
      openBySeverity: countBySeverity(openQualityFindings),
      byType: qualityDisciplineFindingTypes.map((type) => ({
        type,
        count: qualityByType.find((row) => row.type === type)?._count ?? 0
      }))
    }
  });
});

/**
 * SBOM dependency inventory — basic "what's in our supply chain, and is any of it known-
 * vulnerable" view, fed by ingested SPDX/CycloneDX documents (devops-webhook.controller.ts's
 * /sbom route). Deliberately not attempting Black Duck's full license-obligation-text depth —
 * see docs/ROADMAP.md's "Competitive parity" Phase 3.
 */
// Broadened to every authenticated member (was reports:view). NOTE: this deliberately exposes the workspace's security findings / SBOM to all staff — an internal-transparency decision, reversible by restoring requirePermission(REPORTS_VIEW).
reportRouter.get("/sbom-inventory", async (_req, res) => {
  const [totalComponents, vulnerableComponents, byEcosystem, byRepository] = await Promise.all([
    prisma.sbomComponent.count(),
    prisma.sbomComponent.findMany({
      where: { knownCve: { not: null } },
      select: { id: true, name: true, version: true, ecosystem: true, license: true, knownCve: true, repository: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 100
    }),
    prisma.sbomComponent.groupBy({ by: ["ecosystem"], _count: true, orderBy: { _count: { ecosystem: "desc" } }, take: 10 }),
    prisma.sbomComponent.groupBy({
      by: ["repository"],
      where: { repository: { not: null } },
      _count: true,
      orderBy: { _count: { repository: "desc" } },
      take: 10
    })
  ]);

  res.json({
    totalComponents,
    vulnerableCount: vulnerableComponents.length,
    vulnerableComponents,
    byEcosystem: byEcosystem.map((row) => ({ ecosystem: row.ecosystem ?? "Unknown", count: row._count })),
    byRepository: byRepository.map((row) => ({ repository: row.repository ?? "Unknown", count: row._count }))
  });
});

/**
 * Opt-in cost-per-ticket analytics — gated behind GlobalTicketSettings.enableCostAnalytics.
 *
 * WHAT CHANGED (and why totals in an existing workspace will DROP after this ships — that's the
 * correction, not a regression):
 * 1. Only APPROVED, billable hours count. This previously summed EVERY non-deleted timesheet,
 *    including DRAFT and REJECTED ones — i.e. it charged the business for work nobody had
 *    accepted, and for work explicitly turned down.
 * 2. It prefers the rate frozen at approval (`billedAmount`/`billedRate`, see
 *    billing-rate.service.ts) and only falls back to the person's CURRENT rate for rows approved
 *    before snapshotting existed. Previously every figure was recomputed live, so a raise
 *    retroactively rewrote history.
 * 3. Hours with no rate available are reported as `unratedHours` instead of silently contributing
 *    0 — "we don't know" and "it was free" are not the same statement.
 * 4. Totals are computed over ALL tickets; they were previously derived from the top-25 slice, so
 *    both headline numbers were wrong whenever more than 25 tickets had cost.
 * 5. PER CURRENCY. Each entry is priced in its project's billing currency (the frozen
 *    `billedCurrency`; for an entry approved before snapshots, the currency approval would have
 *    used). Those were added into one total that the page printed with a hardcoded "$". Totals are
 *    now one per currency — never summed across them, the same refusal attestations make — and each
 *    row carries its own currency.
 */
// Broadened to every authenticated member (was reports:view). NOTE: exposes workspace cost figures to all staff — reversible by restoring requirePermission(REPORTS_VIEW).
reportRouter.get("/cost-insights", async (_req, res) => {
  const settings = await prisma.globalTicketSettings.findUnique({ where: { id: "global" } });
  if (!settings?.enableCostAnalytics) throw new AppError(403, "Cost analytics is disabled for this workspace.");

  const [timesheets, excluded] = await Promise.all([
    prisma.timesheet.findMany({
      where: { deletedAt: null, ticketId: { not: null }, status: "APPROVED", billable: true },
      select: {
        ticketId: true,
        totalHours: true,
        billable: true,
        billedAmount: true,
        billedRate: true,
        billedCurrency: true,
        user: { select: { hourlyRate: true } },
        project: { select: { billingCurrency: true } }
      }
    }),
    // Reported so the UI can explain the drop rather than leaving it looking like data loss.
    prisma.timesheet.groupBy({
      by: ["status"],
      where: { deletedAt: null, ticketId: { not: null }, status: { in: ["DRAFT", "REJECTED"] } },
      _sum: { totalHours: true }
    })
  ]);

  /** Keyed `${ticketId}|${currency}`: a ticket's cost is only ever added up within one currency. */
  const costByTicket = new Map<string, number>();
  const hoursByTicket = new Map<string, number>();
  let unratedHours = 0;
  const fallbackCurrency = settings.defaultCurrency || "USD";

  for (const row of timesheets) {
    if (!row.ticketId) continue;
    // The snapshot's own currency; for a row approved before snapshots, the currency approval would
    // have used — the project's billing currency, then the workspace default (billing-rate.service.ts).
    const currency = row.billedCurrency || row.project.billingCurrency || fallbackCurrency;
    const key = `${row.ticketId}|${currency}`;
    const { amount, unratedHours: rowUnrated } = computeTimesheetCost([
      {
        totalHours: row.totalHours,
        billable: row.billable,
        billedAmount: row.billedAmount,
        billedRate: row.billedRate,
        liveFallbackRate: row.user.hourlyRate
      }
    ]);
    const hours = Number(row.totalHours);
    costByTicket.set(key, (costByTicket.get(key) ?? 0) + amount);
    hoursByTicket.set(key, (hoursByTicket.get(key) ?? 0) + hours);
    unratedHours += rowUnrated;
  }

  const ticketIds = [...new Set([...costByTicket.keys()].map((key) => key.split("|")[0]))];
  const tickets = await prisma.ticket.findMany({ where: { id: { in: ticketIds } }, select: { id: true, key: true, title: true } });
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  const allRows = [...costByTicket.keys()]
    .map((key) => {
      const [id, currency] = key.split("|");
      return {
        ticketKey: ticketById.get(id)?.key ?? "?",
        title: ticketById.get(id)?.title ?? "",
        hours: Number((hoursByTicket.get(key) ?? 0).toFixed(2)),
        cost: Number((costByTicket.get(key) ?? 0).toFixed(2)),
        currency
      };
    })
    .sort((a, b) => b.cost - a.cost);

  // Totals over EVERY ticket, one per currency; only the returned table is capped at 25.
  const byCurrency = new Map<string, { total: number; tickets: number }>();
  for (const row of allRows) {
    const t = byCurrency.get(row.currency) ?? { total: 0, tickets: 0 };
    t.total += row.cost;
    t.tickets += 1;
    byCurrency.set(row.currency, t);
  }
  const totalsByCurrency = [...byCurrency.entries()]
    .map(([currency, t]) => ({
      currency,
      total: Number(t.total.toFixed(2)),
      tickets: t.tickets,
      avgPerTicket: Number((t.total / t.tickets).toFixed(2))
    }))
    .sort((a, b) => b.total - a.total);
  const excludedHoursByStatus = Object.fromEntries(excluded.map((e) => [e.status, Number(e._sum.totalHours ?? 0)]));

  res.json({
    totalsByCurrency,
    rows: allRows.slice(0, 25),
    basis: "APPROVED_BILLABLE" as const,
    ticketCount: ticketIds.length,
    unratedHours: Number(unratedHours.toFixed(2)),
    excludedDraftHours: excludedHoursByStatus.DRAFT ?? 0,
    excludedRejectedHours: excludedHoursByStatus.REJECTED ?? 0
  });
});

/** Opt-in team leaderboard — gated behind GlobalTicketSettings.enableLeaderboard. Framed as
 *  recognition, not surveillance: the last LEADERBOARD_WINDOW_DAYS of resolutions, people only. */
// Broadened to every authenticated member (was reports:view). Team leads and employees can now see workspace productivity — see docs note on the org-visibility change.
reportRouter.get("/leaderboard", async (_req, res) => {
  const settings = await prisma.globalTicketSettings.findUnique({ where: { id: "global" } });
  if (!settings?.enableLeaderboard) throw new AppError(403, "The team leaderboard is disabled for this workspace.");
  res.json(await buildLeaderboard());
});

/**
 * On-demand "generate a stakeholder update", for ONE project or for every active project.
 *
 * Synchronous (no worker/cron involved) — the numbers are cheap to compute and the AI call is a
 * single completion, so this runs inline within the request like /export.pdf does. Gated by
 * GlobalAISettings.statusReportEnabled via ai.service.ts#generateStatusReport's own preflight.
 *
 * THE PORTFOLIO PATH USES GROUPED QUERIES, not a loop. Five aggregates per project across twenty
 * projects is a hundred round trips on a request someone is waiting on; `groupBy` makes it five
 * regardless of how many projects there are.
 */

/** How many projects one report may cover. When more exist the report SAYS so — a portfolio update
 *  that silently covers 12 of 30 projects is worse than one that admits its scope. */
const STATUS_REPORT_PROJECT_LIMIT = 12;

reportRouter.post("/status-report", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const projectId = String(req.body?.projectId ?? "");
  const periodDays = Math.min(Math.max(Number(req.body?.periodDays) || 7, 1), 90);

  const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const periodLabel =
    periodDays === 7 ? "the past week" : periodDays === 30 ? "the past month" : `the past ${periodDays} days`;
  const sinceLocal = startOfLocalDay();
  const hoursSince = new Date(Date.UTC(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate()));

  // An empty projectId is the ALL-PROJECTS request, not a validation failure — the picker offers
  // "All projects" as a first-class choice.
  const scopedProjects = projectId
    ? await prisma.project.findMany({ where: { id: projectId }, select: { id: true, name: true } })
    : await prisma.project.findMany({
        // `status` is a plain string column on Project, not an enum — ACTIVE is the default.
        where: { deletedAt: null, status: "ACTIVE" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: STATUS_REPORT_PROJECT_LIMIT + 1
      });

  if (scopedProjects.length === 0) {
    throw new AppError(projectId ? 404 : 422, projectId ? "Project not found" : "No active projects to report on.");
  }

  const truncated = !projectId && scopedProjects.length > STATUS_REPORT_PROJECT_LIMIT;
  const projects = truncated ? scopedProjects.slice(0, STATUS_REPORT_PROJECT_LIMIT) : scopedProjects;
  const ids = projects.map((p) => p.id);

  // Typed through Prisma's own input type rather than inferred: a bare object literal widens the
  // status array to string[], which the generated enum filter rejects.
  const openWhere: Prisma.TicketWhereInput = {
    projectId: { in: ids },
    deletedAt: null,
    status: { notIn: ["RESOLVED", "CLOSED"] }
  };

  const [createdRows, resolvedRows, openRows, overdueRows, hoursRows, resolvedNotable] = await Promise.all([
    prisma.ticket.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, createdAt: { gte: periodStart } }, _count: { _all: true } }),
    prisma.ticket.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, resolvedAt: { gte: periodStart } }, _count: { _all: true } }),
    prisma.ticket.groupBy({ by: ["projectId"], where: openWhere, _count: { _all: true } }),
    prisma.ticket.groupBy({ by: ["projectId"], where: { ...openWhere, slaBreachAt: { not: null, lt: sinceLocal } }, _count: { _all: true } }),
    prisma.timesheet.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, workDate: { gte: hoursSince } }, _sum: { totalHours: true } }),
    // Resolved-in-period first; a period that resolved nothing falls back to what is still open
    // below, so the model always has concrete tickets to name rather than only counts.
    prisma.ticket.findMany({
      where: { projectId: { in: ids }, deletedAt: null, resolvedAt: { gte: periodStart } },
      select: { key: true, title: true, status: true },
      take: projectId ? 5 : 12
    })
  ]);

  const countOf = (rows: Array<{ projectId: string; _count: { _all: number } }>, id: string) =>
    rows.find((r) => r.projectId === id)?._count._all ?? 0;

  const per = projects.map((p) => ({
    name: p.name,
    created: countOf(createdRows, p.id),
    resolved: countOf(resolvedRows, p.id),
    open: countOf(openRows, p.id),
    overdue: countOf(overdueRows, p.id),
    hours: Number(Number(hoursRows.find((r) => r.projectId === p.id)?._sum.totalHours ?? 0).toFixed(1))
  }));
  const sum = (pick: (row: (typeof per)[number]) => number) => per.reduce((total, row) => total + pick(row), 0);

  const notableTickets =
    resolvedNotable.length > 0
      ? resolvedNotable
      : await prisma.ticket.findMany({
          where: openWhere,
          select: { key: true, title: true, status: true },
          take: projectId ? 5 : 12
        });

  const scopeLabel = projectId
    ? `the project "${projects[0].name}"`
    : `all ${projects.length} active project${projects.length === 1 ? "" : "s"} in this workspace${
        truncated ? ` (these are the first ${STATUS_REPORT_PROJECT_LIMIT} of more than that — say so in the summary)` : ""
      }`;

  const { report } = await generateStatusReport({
    projectName: projects[0].name,
    scopeLabel,
    projectBreakdown: projectId
      ? undefined
      : per.map((r) => `- ${r.name} — ${r.created} created, ${r.resolved} resolved, ${r.open} open, ${r.overdue} overdue, ${r.hours} h`).join("\n"),
    periodLabel,
    ticketsCreated: sum((r) => r.created),
    ticketsResolved: sum((r) => r.resolved),
    openCount: sum((r) => r.open),
    overdueCount: sum((r) => r.overdue),
    hoursLogged: Number(sum((r) => r.hours).toFixed(1)),
    notableTickets,
    userId: req.user!.id
  });

  res.json({
    report,
    projectName: projectId ? projects[0].name : `All projects (${projects.length})`,
    periodLabel,
    // Surfaced rather than left to the prose: the UI states the cap plainly instead of relying on
    // the model to have mentioned it.
    truncated,
    projectCount: projects.length
  });
});


/**
 * Parses the filter query string shared by both exports and the grouped report.
 *
 * Unknown values are DROPPED rather than rejected. A report URL is something people bookmark,
 * hand-edit and paste to each other; refusing the whole request over one stale `status=CLOSED`
 * from an older build would be worse than quietly reporting on everything else. The response
 * echoes back the filters it actually applied, so nothing is guessed at silently.
 */
/** Rows a single PDF will render. Generous — and when it is exceeded the document SAYS so rather
 *  than quietly reporting a total that covers only part of what matched. A PDF is a paginated
 *  document somebody prints; an unbounded one is a denial-of-service on the person who opens it. */
const PDF_ROW_LIMIT = 2_000;

const TIMESHEET_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"] as const;

function parseReportFilters(query: Record<string, unknown>): TimesheetReportFilters {
  const str = (key: string): string | undefined => {
    const raw = query[key];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };
  const isoDate = (key: string): string | undefined => {
    const raw = str(key);
    return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  };
  const status = str("status");
  const billable = str("billable");

  return {
    from: isoDate("from"),
    to: isoDate("to"),
    projectId: str("projectId"),
    moduleId: str("moduleId"),
    userId: str("userId"),
    ticketId: str("ticketId"),
    status: (TIMESHEET_STATUSES as readonly string[]).includes(status ?? "")
      ? (status as TimesheetReportFilters["status"])
      : undefined,
    activityType: str("activityType"),
    billable: billable === "true" ? true : billable === "false" ? false : undefined
  };
}

/**
 * The workspace an export belongs to, for its header block. A report naming only the product is
 * unattributable once printed — three orgs' PDFs look identical on a desk.
 *
 * Falls back to the slug, then to the product name: the control-plane row is not worth failing a
 * download over, and the tenant context is always present on an authenticated request.
 */
async function resolveWorkspaceName(): Promise<string> {
  const ctx = tenantContext.getStore();
  if (!ctx) return "TimeSphere";
  const org = await controlPrisma.organization
    .findUnique({ where: { id: ctx.orgId }, select: { name: true } })
    .catch(() => null);
  return org?.name ?? ctx.orgSlug ?? "TimeSphere";
}

/**
 * The X-Report-* headers every timesheet export carries, and their exposure to a cross-origin page.
 *
 * The CSV used to set Rows-Included only, so the download toast read "N of 0". And with no
 * Access-Control-Expose-Headers a browser hides custom headers from a page on another origin — on a
 * split-origin deployment the truncation warning could never fire, which is the one thing it is for.
 * Truncated is derived, not passed: it is true exactly when fewer rows went out than matched.
 */
function setReportHeaders(res: Response, counts: { rowsIncluded: number; totalMatching: number }): void {
  res.setHeader("X-Report-Rows-Included", String(counts.rowsIncluded));
  res.setHeader("X-Report-Total-Matching", String(counts.totalMatching));
  if (counts.totalMatching > counts.rowsIncluded) res.setHeader("X-Report-Truncated", "true");
  res.setHeader("Access-Control-Expose-Headers", "X-Report-Rows-Included, X-Report-Total-Matching, X-Report-Truncated, Content-Disposition");
}

/** Everything the two exports need, gathered once. Both answer the same question in different
 *  formats, so they must not each decide for themselves what "the rows" are. */
async function loadExportDocument(req: Request, rowLimit: number) {
  const filters = parseReportFilters(req.query as Record<string, unknown>);
  const requested = String((req.query as Record<string, unknown>).groupBy ?? "user");
  const groupBy = (GROUP_BY_KEYS as string[]).includes(requested) ? (requested as GroupByKey) : "user";
  const where = buildTimesheetWhere(filters);

  // Counted separately so the document can compare what it is showing against what matched, and
  // say plainly when those differ.
  const [totalMatching, rows, workspace, filterNames] = await Promise.all([
    prisma.timesheet.count({ where }),
    prisma.timesheet.findMany({
      where,
      include: REPORT_INCLUDE,
      // Newest first so a capped export keeps the most recent work — the same order (and so the
      // same rows) as the screen; each section re-sorts its own rows forwards for reading.
      orderBy: REPORT_ORDER_BY,
      take: rowLimit
    }),
    resolveWorkspaceName(),
    resolveReportFilterNames(filters)
  ]);

  return buildTimesheetExportDocument({
    rows,
    totalMatching,
    filters,
    groupBy,
    workspace,
    generatedBy: `${req.user!.name} (${req.user!.email})`,
    reviewers: await resolveReviewerNames(rows),
    filterNames
  });
}

/**
 * GET /reports/timesheets — the grouped report.
 *
 * One endpoint, nine groupings. This is the thing that turns rows into an answer: "hours per
 * person per month", "which activity ate Project Apollo", "what does each ticket actually cost".
 * Before it, the only way to ask any of those was to export every row in the workspace and pivot
 * it in Excel.
 */
reportRouter.get("/timesheets", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const filters = parseReportFilters(req.query as Record<string, unknown>);
  const requested = String((req.query as Record<string, unknown>).groupBy ?? "user");
  const groupBy = (GROUP_BY_KEYS as string[]).includes(requested) ? (requested as GroupByKey) : "user";
  res.json({ ...(await buildTimesheetReport(filters, groupBy)), groupByOptions: GROUP_BY_KEYS });
});

/**
 * GET /reports/export.csv — every matching row, with the columns a report is actually asked for.
 *
 * WHAT CHANGED AND WHY IT MATTERED: this handler used to be `async (_req, res)` — the underscore
 * was honest, the request was ignored — with `where: { deletedAt: null }` and nothing else. Every
 * timesheet in the workspace, for all time, for everybody, on one button. It also omitted every
 * field that makes an export worth having: no billing, no SLA, no ticket, no reviewer. So it could
 * not answer "what did this cost", "who approved it", or "was it late", which is most of what
 * somebody exports a timesheet report to find out.
 */
/**
 * GET /reports/analytics — utilisation, approval latency and activity mix.
 *
 * A DATE RANGE IS REQUIRED here, unlike the grouped report, and that is not laziness. Utilisation
 * is hours divided by capacity, and capacity only exists relative to a period — "utilisation, all
 * time" is not a question with an answer. Defaulting silently to some window would produce a
 * confident percentage nobody asked for.
 */
reportRouter.get("/analytics", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const filters = parseReportFilters(req.query as Record<string, unknown>);
  if (!filters.from || !filters.to) {
    throw new AppError(
      422,
      "Analytics needs a date range: utilisation is hours against capacity, and capacity only means something over a period."
    );
  }
  res.json(await buildTimesheetAnalytics({ ...filters, from: filters.from, to: filters.to }));
});

/**
 * GET /reports/export.xlsx — the same filtered set as a real spreadsheet.
 *
 * WHY THIS EXISTS ALONGSIDE CSV: CSV has no types. Every date arrives as text, every number as
 * text, and the first thing anyone does is re-type the columns by hand before they can pivot —
 * or worse, does not, and sorts "10.5" before "9.0" because it sorted alphabetically. A workbook
 * carries real number and date cells, and can hold the grouped summary on a second sheet next to
 * the raw rows, which is exactly the shape people were building by hand from the CSV.
 */
reportRouter.get("/export.xlsx", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const report = await loadExportDocument(req, REPORT_ROW_LIMIT);
  const wb = buildTimesheetReportWorkbook(report);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="timesheet-report-${stamp}.xlsx"`);
  setReportHeaders(res, report);
  await wb.xlsx.write(res);
  res.end();
});

reportRouter.get("/export.csv", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const filters = parseReportFilters(req.query as Record<string, unknown>);
  const where = buildTimesheetWhere(filters);
  const [rows, totalMatching] = await Promise.all([
    prisma.timesheet.findMany({ where, include: REPORT_INCLUDE, orderBy: REPORT_ORDER_BY, take: REPORT_ROW_LIMIT }),
    // Counted so the download can say "N of M" — the CSV is the one export that never did.
    prisma.timesheet.count({ where })
  ]);
  const reviewers = await resolveReviewerNames(rows);

  const lines = [
    toCsvLine(TIMESHEET_CSV_HEADER),
    ...rows.map((row) => toCsvLine(timesheetCsvValues(row, row.reviewedById ? (reviewers.get(row.reviewedById) ?? "") : "")))
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=timesheet-report-${stamp}.csv`);
  // A CSV cannot carry a caveat in its body without corrupting the data, so the headers are the
  // only honest channel. Hitting the cap at all means the filter was too broad to be a report.
  setReportHeaders(res, { rowsIncluded: rows.length, totalMatching });
  // A BOM, so Excel opens UTF-8 correctly instead of mangling every accented name. Costs three
  // bytes and removes the single most common "your export is broken" report.
  res.send("\uFEFF" + lines.join("\n"));
});

/**
 * GET /reports/timesheets/:id/export.csv — one entry, same columns as the bulk export.
 *
 * WHY A ROUTE AND NOT A FILTER: `parseReportFilters` deliberately has no `id` — every filter it
 * accepts describes a SET ("this project, this month"), and adding a single-row escape hatch to
 * it would blur what an export's scope line means. This is a different question ("give me the
 * record behind this decision") asked from the approvals queue, where an approver wants the row
 * they are about to sign off on as a file they can attach to why they signed it.
 *
 * Gated on REPORTS_VIEW like the rest of the export family rather than TIMESHEETS_APPROVE: this
 * returns somebody else's hours, rate and cost, and the approvals queue can only show another
 * person's rows to a REPORTS_VIEW holder in the first place (see timesheet.controller.ts's list).
 */
reportRouter.get("/timesheets/:id/export.csv", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const row = await prisma.timesheet.findFirst({
    // Soft-deleted rows stay unreachable here for the same reason every other export excludes
    // them: somebody retracted that work.
    where: { id: String(req.params.id), deletedAt: null },
    include: REPORT_INCLUDE
  });
  if (!row) throw new AppError(404, "Timesheet entry not found");

  const reviewers = await resolveReviewerNames([row]);
  const lines = [
    toCsvLine(TIMESHEET_CSV_HEADER),
    toCsvLine(timesheetCsvValues(row, row.reviewedById ? (reviewers.get(row.reviewedById) ?? "") : ""))
  ];

  const day = row.workDate.toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=timesheet-entry-${day}-${row.id.slice(0, 8)}.csv`);
  setReportHeaders(res, { rowsIncluded: 1, totalMatching: 1 });
  res.send("\uFEFF" + lines.join("\n"));
});

/**
 * GET /reports/export.pdf — the same filtered set, as a document.
 *
 * TWO THINGS THIS USED TO GET WRONG, and the second was the dangerous one.
 *
 * It took no filters (`async (_req, res)`), so it was always the whole workspace.
 *
 * And it capped at `take: 500` and then printed `Entries: N  Total hours: X` computed from those
 * 500 — with nothing anywhere on the page saying it had been cut. Past 500 live entries the
 * document stated a total that was simply wrong, in a file somebody might hand to a client or an
 * auditor. A silent truncation on a report is the same class of failure as colouring an unmonitored
 * day green: it is not missing information, it is confidently asserted wrong information.
 *
 * Now the cap is high, and when it is hit the document says so in the header, in red, before any
 * numbers are read.
 */
reportRouter.get("/export.pdf", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const report = await loadExportDocument(req, PDF_ROW_LIMIT);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="timesheet-report-${stamp}.pdf"`);
  // Machine-readable truncation, alongside the human-readable warning printed on the page. A
  // caller scripting this export cannot reasonably parse the PDF to discover the document is
  // partial, and "partial" is exactly the thing it must not miss.
  setReportHeaders(res, report);

  // bufferPages so the footer pass can stamp "Page X of Y" — Y does not exist until the last row
  // has been drawn.
  const doc = new PDFDocument({ size: "A4", margin: 36, bufferPages: true });
  doc.pipe(res);
  renderTimesheetReportPdf(doc, report);
  doc.end();
});
