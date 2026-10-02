/**
 * WHAT: create/list/approve/reject timesheet entries (draft or submitted, with or without file
 * attachments), including overlap validation, SLA approval-deadline computation, and
 * notification dispatch at each status transition.
 * WHY: this is the other half of the app's "own both the work and the time spent on it" thesis
 * — a submitted entry starts an SLA clock (`services/sla.service.ts`) the same way a ticket's
 * priority does, and can optionally link to a `Ticket` so time logged against bug-fixing shows
 * up on that ticket too.
 * HOW: `saveTimesheet()` wraps the overlap check + insert in a `Serializable` transaction —
 * without that, two concurrent submits for the same (user, day) could each see "no overlap" and
 * both insert, since the check-then-insert isn't otherwise atomic.
 * WHO calls this: `apps/web/src/pages/Timesheet.tsx` (create), `apps/web/src/pages/AdminPages.tsx`
 * (ApprovalsPage — approve/reject), `apps/web/src/pages/History.tsx` (list).
 */
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { calculateHours, permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { preserveTenantContext, upload } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { buildRateSnapshotPatch } from "../services/billing-rate.service.js";
import { dispatchNotification } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { computeApprovalDeadline, resolveEscalationsFor } from "../services/sla.service.js";
import { emitDomainEvent } from "../services/domain-events.js";
import { processUpload } from "../services/attachment-storage.service.js";
import { sanitizeRichText } from "../utils/sanitize.js";
import {
  bindVerificationToRecord,
  consumeVerification,
  getTimesheetVerificationBadges,
  isFaceVerificationRequired,
  unbindTimesheetVerification
} from "../services/face.service.js";
import { parseDayWindow, workDateFilter } from "../utils/date-window.js";
import { userClock } from "../services/user-clock.service.js";
import {
  approvalScopeWhere,
  assertMayDecide,
  awaitingReviewWhere,
  loadApprovalAuthority,
  type ApprovalAuthority
} from "../services/timesheet-approval-scope.service.js";

const inputSchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    moduleId: z.string().uuid(),
    submoduleId: z.string().uuid().optional().or(z.literal("")),
    activityType: z.string().min(2),
    taskDescription: z.string().min(10),
    workDate: z.string(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    notes: z.string().optional(),
    ticketId: z.string().uuid().optional().or(z.literal("")),
    /// Id of a PASSED, unconsumed face-verification attempt (POST /api/face/verify). Only
    /// required when the workspace's face-verification policy covers this user + action —
    /// services/face.service.ts#isFaceVerificationRequired decides, and the gate in
    /// saveTimesheet enforces it. Ignored entirely for drafts.
    faceVerificationId: z.string().uuid().optional().or(z.literal(""))
  })
});

/**
 * The words somebody wrote on an entry: the task, then the note when there is one.
 *
 * Shared by the submit and both decision emails so all three quote the same thing — three copies of
 * this join is how one of them ends up omitting the note nobody remembers is optional.
 */
function entryText(entry: { taskDescription?: string | null; notes?: string | null }): string {
  return [entry.taskDescription, entry.notes].filter((t) => t && t.trim().length > 0).join("\n\n");
}

export const timesheetRouter = Router();
timesheetRouter.use(requireAuth);

/**
 * Rows one page may return.
 *
 * WHY THE UNBOUNDED CAP IS 100 AND A BOUNDED RANGE GETS MORE — this is the reason the home page's
 * date filter could not be done in the browser. The default is newest-first and capped, so
 * filtering a range client-side silently under-reports any period that falls outside the newest
 * 100 entries: it looks right in development, where nobody has 100 entries, and is wrong in
 * production. Filtering server-side is the fix, and a range is self-limiting in a way "everything"
 * is not, so it can afford a higher ceiling.
 */
const PAGE_LIMIT = 100;
const RANGE_LIMIT = 2_000;

/**
 * Whose entries `?scope=team` returns, which is NOT the same question as `REPORTS_VIEW`.
 *
 * REPORTS_VIEW is granted to MANAGER and TEAM_LEAD as well as the admin roles, so the existing
 * "can view all" check hands a manager the whole workspace — which is why the home page's day
 * timeline showed a manager every person in the company rather than their own team.
 *
 * The reporting line is the right instrument and already exists: `User.managerId`, the same
 * relation team.controller.ts scopes by. Three tiers fall out of it with no role-name check and no
 * new schema:
 *   - `users:manage` (SUPER_ADMIN / ADMIN)  → everyone
 *   - anyone else                           → themselves plus their direct reports
 *   - an employee who manages nobody        → themselves, because that set is just them
 *
 * Returns `undefined` for "no restriction" so it drops straight into a Prisma `where`.
 */
export async function teamScopeUserIds(user: { id: string; permissions: string[] }): Promise<{ in: string[] } | undefined> {
  if (user.permissions.includes(permissions.USERS_MANAGE)) return undefined;
  const reports = await prisma.user.findMany({
    where: { managerId: user.id, deletedAt: null },
    select: { id: true }
  });
  // Their own entries are always in scope — a manager's timeline that omitted their own work would
  // be a strange thing to hand someone.
  return { in: [user.id, ...reports.map((r) => r.id)] };
}

timesheetRouter.get("/", async (req, res) => {
  const canViewAll = req.user!.permissions.includes(permissions.REPORTS_VIEW);
  const requestedUserId = typeof req.query.userId === "string" && req.query.userId ? req.query.userId : undefined;
  const status = typeof req.query.status === "string" && req.query.status ? (req.query.status as any) : undefined;
  const workDate = workDateFilter(parseDayWindow(req.query));

  // OPT-IN, and deliberately so. History, the Timesheet page and the approvals queue all call this
  // route with no scope and must keep the visibility they have — narrowing them here would change
  // who can approve what, which is a different decision from what one dashboard card displays.
  const scoped = req.query.scope === "team" ? await teamScopeUserIds(req.user!) : undefined;
  const userId = scoped ?? (canViewAll ? requestedUserId : req.user!.id);

  const timesheets = await prisma.timesheet.findMany({
    where: { userId, status, deletedAt: null, workDate },
    include: {
      project: true,
      module: true,
      submodule: true,
      ticket: { select: { id: true, key: true, title: true } },
      attachments: true,
      // `id` added alongside the name: the History table decides whether to show a "Logged by"
      // column by counting the DISTINCT authors in the page, and names are not unique.
      user: { select: { id: true, name: true, email: true, avatarUrl: true } }
    },
    orderBy: [{ workDate: "desc" }, { startTime: "desc" }],
    take: workDate ? RANGE_LIMIT : PAGE_LIMIT
  });

  // Verified-badge decoration: which rows carry a spent PASSED identity check, and whose
  // authors the policy covers — so a manager can tell "verified", "predates the policy", and
  // "not covered" apart at a glance instead of reading absence as ambiguity.
  const [badges, decorated] = await Promise.all([
    getTimesheetVerificationBadges(timesheets.map((t) => ({ id: t.id, userId: t.userId }))),
    // Reviewer and last-editor names, for the whole page, in one query — an entry that somebody
    // else corrected used to look exactly like one nobody had touched.
    decorateEditors(timesheets)
  ]);
  res.json(
    decorated.map((t) => ({
      ...t,
      identityVerified: badges.get(t.id)?.identityVerified ?? false,
      identityVerifiedAt: badges.get(t.id)?.identityVerifiedAt ?? null,
      identityVerificationApplies: badges.get(t.id)?.identityVerificationApplies ?? false
    }))
  );
});

/**
 * GET /timesheets/approval-queue — the approvals page, filtered and paged ON THE SERVER.
 *
 * WHY IT IS NOT `GET /` WITH A STATUS: the page used to call `GET /` with nothing and filter for
 * SUBMITTED in the browser. That route answers a `reports:view` holder with the newest 100 rows of
 * every status in the workspace, so on a busy workspace an entry submitted on Monday had fallen off
 * the page by Thursday — while its SLA escalation mail linked here to find it. Filtering one capped
 * page client-side is the exact under-reporting PAGE_LIMIT's comment warns about.
 *
 * THE SCOPE is `approvalScopeWhere`: never your own entries and never your managers', in every
 * status, because this is the page of decisions you can make (or made). `awaitingReview` is the
 * same count the Inbox brief and the reports summary show, so the page's badge agrees with both.
 *
 * SEARCH matches the author's name and email and the task/notes text in SQL. The text columns hold
 * rich-text HTML, so a needle that is also a tag or attribute name ("span", "strong") can match
 * markup; names and words people actually type are unaffected, and the alternative — pulling every
 * candidate row into Node to strip HTML before paging — would bring back the cap this route removes.
 *
 * FACETS are computed over the scope and status, NOT over the page, so a filter option is never
 * missing because its rows happen to be on page 4. Per-day counts cover the last 120 days: they feed
 * the range picker's calendar dots, which open on the current month.
 */
const QUEUE_STATUSES = new Set<string>(["SUBMITTED", "APPROVED", "REJECTED", "DRAFT"]);
const QUEUE_MAX_PAGE_SIZE = 100;
const QUEUE_FACET_DAYS = 120;

/** `ALL` widens to every status; anything unrecognised falls back to the queue itself. */
function queueStatus(raw: unknown): "SUBMITTED" | "APPROVED" | "REJECTED" | "DRAFT" | undefined {
  if (raw === "ALL") return undefined;
  if (typeof raw === "string" && QUEUE_STATUSES.has(raw)) return raw as "SUBMITTED";
  return "SUBMITTED";
}

timesheetRouter.get("/approval-queue", requirePermission(permissions.TIMESHEETS_APPROVE), async (req, res) => {
  const authority = await loadApprovalAuthority(req.user!.id);
  const scope = approvalScopeWhere(authority);

  const status = queueStatus(req.query.status);
  const text = (key: string) => (typeof req.query[key] === "string" && req.query[key] ? String(req.query[key]) : undefined);
  const projectId = text("projectId");
  const activityType = text("activityType");
  const search = text("search")?.trim();
  const workDate = workDateFilter(parseDayWindow(req.query));

  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
  const pageSize = Math.min(QUEUE_MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(req.query.pageSize)) || 25));

  const statusWhere: Prisma.TimesheetWhereInput = { ...scope, ...(status ? { status } : {}) };
  const where: Prisma.TimesheetWhereInput = {
    ...statusWhere,
    ...(projectId ? { projectId } : {}),
    ...(activityType ? { activityType } : {}),
    ...(workDate ? { workDate } : {}),
    ...(search
      ? {
          OR: [
            { user: { name: { contains: search } } },
            { user: { email: { contains: search } } },
            { taskDescription: { contains: search } },
            { notes: { contains: search } }
          ]
        }
      : {})
  };

  const facetSince = new Date(Date.now() - QUEUE_FACET_DAYS * 86_400_000);
  const [items, total, awaitingReview, byProject, byActivity, byDay] = await Promise.all([
    prisma.timesheet.findMany({
      where,
      include: {
        project: true,
        module: true,
        submodule: true,
        ticket: { select: { id: true, key: true, title: true } },
        attachments: true,
        user: { select: { id: true, name: true, email: true, avatarUrl: true } }
      },
      orderBy: [{ workDate: "desc" }, { startTime: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize
    }),
    prisma.timesheet.count({ where }),
    prisma.timesheet.count({ where: awaitingReviewWhere(authority) }),
    prisma.timesheet.groupBy({ by: ["projectId"], where: statusWhere, _count: true }),
    prisma.timesheet.groupBy({ by: ["activityType"], where: statusWhere, _count: true }),
    prisma.timesheet.groupBy({ by: ["workDate", "status"], where: { ...scope, workDate: { gte: facetSince } }, _count: true })
  ]);

  const projectNames = byProject.length
    ? await prisma.project.findMany({ where: { id: { in: byProject.map((row) => row.projectId) } }, select: { id: true, name: true } })
    : [];
  const days: Record<string, Record<string, number>> = {};
  for (const row of byDay) {
    const key = row.workDate.toISOString().slice(0, 10);
    days[key] = { ...days[key], [row.status]: row._count };
  }

  const [badges, decorated] = await Promise.all([
    getTimesheetVerificationBadges(items.map((t) => ({ id: t.id, userId: t.userId }))),
    decorateEditors(items)
  ]);
  res.json({
    items: decorated.map((t) => ({
      ...t,
      identityVerified: badges.get(t.id)?.identityVerified ?? false,
      identityVerifiedAt: badges.get(t.id)?.identityVerifiedAt ?? null,
      identityVerificationApplies: badges.get(t.id)?.identityVerificationApplies ?? false
    })),
    total,
    page,
    pageSize,
    awaitingReview,
    facets: {
      projects: projectNames.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
      activities: byActivity.map((row) => row.activityType).filter(Boolean).sort((a, b) => a.localeCompare(b)),
      days
    }
  });
});

/**
 * The full detail of ONE entry — everything the approvals table, the history table and the
 * dashboard's day timeline each showed a clipped slice of, plus the two things none of them
 * showed at all: who reviewed it, and the attachments as downloadable links.
 *
 * WHY A ROUTE AND NOT A CLIENT-SIDE LOOKUP IN THE LIST: the list is capped at the 100 most recent
 * rows, so anything older simply is not in the cache a dialog could read. A screen that can open
 * "this entry" must be able to open one that fell off the end of that page.
 *
 * VISIBILITY is the same rule the list applies, stated once here: your own entries always;
 * anyone's with REPORTS_VIEW or TIMESHEETS_APPROVE (the two rights that already grant a
 * cross-user view of timesheets, on the reports screen and the approvals queue respectively).
 * A 404 rather than a 403 for everything else — "this entry exists but isn't yours" is itself
 * information about a colleague's work.
 */
/**
 * NOT `as const`. A readonly literal is accepted loosely by Prisma's `include` validation, which
 * is how an earlier version of this shipped a `reviewedBy: {...}` key that does not exist on this
 * model — it typechecked and threw at runtime on every call. Left mutable so the compiler checks
 * every field against the schema.
 *
 * `reviewedById` is deliberately absent from here: it is a bare scalar with NO relation on
 * `Timesheet` (unlike FaceVerification and AiProposal, which both declare one), so the reviewer's
 * name is resolved separately in `respondWithEntry` rather than by adding a migration for a
 * display string.
 */
const ENTRY_DETAIL_INCLUDE = {
  project: { select: { id: true, name: true, code: true } },
  module: { select: { id: true, name: true } },
  submodule: { select: { id: true, name: true } },
  ticket: { select: { id: true, key: true, title: true } },
  attachments: { include: { uploadedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
  user: { select: { id: true, name: true, email: true, avatarUrl: true, role: true } }
} satisfies Prisma.TimesheetInclude;

/** Loads one entry and enforces the visibility rule above. Returns null when the caller may not
 *  see it, so callers answer 404 uniformly rather than each deciding what to leak. */
async function loadVisibleEntry(req: any, id: string) {
  const entry = await prisma.timesheet.findFirst({ where: { id, deletedAt: null }, include: ENTRY_DETAIL_INCLUDE });
  if (!entry) return null;
  const isOwner = entry.userId === req.user.id;
  const canViewOthers =
    req.user.permissions.includes(permissions.REPORTS_VIEW) || req.user.permissions.includes(permissions.TIMESHEETS_APPROVE);
  return isOwner || canViewOthers ? entry : null;
}

/**
 * Resolves `reviewedById` and `lastEditedById` — both bare scalars, per the schema note on each —
 * into `{ id, name, email }` for a whole page of rows in ONE query.
 *
 * WHY BATCHED RATHER THAN A JOIN OR A LOOKUP PER ROW: the list route returns up to 100 entries, so
 * a per-row lookup is a 200-query page. The distinct set of people who reviewed or edited those
 * 100 rows is realistically a handful, and `IN (…)` over it costs one round trip.
 */
async function decorateEditors<T extends { reviewedById: string | null; lastEditedById: string | null }>(
  rows: T[]
): Promise<Array<T & { reviewedBy: PersonRef | null; lastEditedBy: PersonRef | null }>> {
  const ids = [...new Set(rows.flatMap((row) => [row.reviewedById, row.lastEditedById]).filter((id): id is string => Boolean(id)))];
  const people = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })
    : [];
  const byId = new Map(people.map((person) => [person.id, person]));
  return rows.map((row) => ({
    ...row,
    // `?? null` rather than `undefined` for a deleted user: the id is still on the row, and the
    // reader is better served by "edited by someone no longer here" than by the field vanishing.
    reviewedBy: (row.reviewedById && byId.get(row.reviewedById)) || null,
    lastEditedBy: (row.lastEditedById && byId.get(row.lastEditedById)) || null
  }));
}

interface PersonRef {
  id: string;
  name: string;
  email: string;
}

/** Decorated with the identity badge the list route adds, so a dialog opened from the table and
 *  one opened by id can never disagree about whether the entry is verified — plus the reviewer and
 *  the last editor, which the bare id columns alone cannot supply. */
async function respondWithEntry(res: any, entry: NonNullable<Awaited<ReturnType<typeof loadVisibleEntry>>>) {
  const [badges, [decorated]] = await Promise.all([
    getTimesheetVerificationBadges([{ id: entry.id, userId: entry.userId }]),
    decorateEditors([entry])
  ]);
  res.json({
    ...decorated,
    identityVerified: badges.get(entry.id)?.identityVerified ?? false,
    identityVerifiedAt: badges.get(entry.id)?.identityVerifiedAt ?? null,
    identityVerificationApplies: badges.get(entry.id)?.identityVerificationApplies ?? false
  });
}

timesheetRouter.get("/:id", async (req, res) => {
  const entry = await loadVisibleEntry(req, String(req.params.id));
  if (!entry) throw new AppError(404, "Timesheet not found");
  await respondWithEntry(res, entry);
});

/**
 * The module has to belong to the project, and the submodule to the module. Checked on CREATE as
 * well as on PATCH: the create path used to trust the web form's cascading pickers, which an API,
 * MCP or Ask-AI caller never sees — so project A with a module of project B was accepted.
 */
async function assertModuleBelongs(projectId: string, moduleId: string, submoduleId: string | null | undefined): Promise<void> {
  const moduleRow = await prisma.projectModule.findFirst({ where: { id: moduleId } });
  if (!moduleRow || moduleRow.projectId !== projectId) {
    throw new AppError(422, "Selected module does not belong to this project");
  }
  if (submoduleId) {
    const submoduleRow = await prisma.projectSubmodule.findFirst({ where: { id: submoduleId } });
    if (!submoduleRow || submoduleRow.moduleId !== moduleId) {
      throw new AppError(422, "Selected submodule does not belong to this module");
    }
  }
}

/** The author — not whoever is editing — must be assigned to the project the hours are logged
 *  against, unless the author is an admin (the same exemption the create path has always had). */
async function assertAuthorAssigned(author: { id: string; role: string | null | undefined }, projectId: string): Promise<void> {
  if (["SUPER_ADMIN", "ADMIN"].includes(author.role ?? "")) return;
  const assigned = await prisma.userProjectAssignment.findFirst({ where: { userId: author.id, projectId } });
  if (!assigned) throw new AppError(403, "You are not assigned to this project");
}

/**
 * The two notifications a submission sends — the author's receipt and the approver's request —
 * shared by a fresh submit (saveTimesheet) and submitting an existing draft (POST /:id/submit),
 * because they are the same event. The draft path used to send the manager an in-app row only, so
 * a draft submitted later reached nobody's inbox while a fresh submit emailed the approver.
 *
 * WHAT THE APPROVER ACTUALLY NEEDS. This email used to carry the date, the project and the hours —
 * enough to know an entry exists, not enough to approve it — so every recipient had to open the app
 * to answer "what was done". The entry's module, submodule, activity, linked ticket and the
 * description the author wrote all travel with it now. Empty fields are dropped by the template
 * rather than printed as dashes.
 */
async function announceSubmission(
  entry: {
    userId: string;
    workDate: Date;
    totalHours: Prisma.Decimal | number | string;
    activityType: string | null;
    taskDescription: string | null;
    notes: string | null;
    project: { name: string } | null;
    module?: { name: string } | null;
    submodule?: { name: string } | null;
    ticket?: { key: string; title: string } | null;
  },
  author: { id: string; name: string },
  manager: { id: string; name: string } | null
): Promise<void> {
  const dateLabel = entry.workDate.toISOString().slice(0, 10);
  const hours = Number(entry.totalHours);
  const project = entry.project?.name ?? "";
  const entryDetail = {
    module: entry.module?.name ?? null,
    submodule: entry.submodule?.name ?? null,
    activity: entry.activityType ?? null,
    // The task is what was done; the note is why, or what got in the way. Both belong in a mail
    // whose whole purpose is letting somebody decide without opening the app.
    description: entryText(entry) || null,
    ticketRef: entry.ticket ? `${entry.ticket.key} — ${entry.ticket.title}` : null
  };
  const detailVars = {
    module: entryDetail.module ?? "",
    submodule: entryDetail.submodule ?? "",
    activity: entryDetail.activity ?? "",
    description: entryDetail.description ?? "",
    ticketRef: entryDetail.ticketRef ?? ""
  };

  await dispatchNotification({
    userId: entry.userId,
    category: "timesheet.submitted",
    title: "Timesheet submitted",
    body: `${hours.toFixed(2)}h on ${project} for ${dateLabel} sent for approval.`,
    link: "/app/history",
    email: {
      templateKey: "timesheet.submitted",
      vars: { name: author.name, hours: hours.toFixed(2), date: dateLabel, project, managerName: manager?.name ?? "", ...detailVars },
      fallback: {
        subject: `Timesheet submitted — ${dateLabel}`,
        html: templates.timesheetSubmitted({ name: author.name, hours, date: dateLabel, project, managerName: manager?.name ?? null, ...entryDetail })
      }
    }
  });

  if (manager) {
    // The approver gets the same detail, and by email as well — this is the message that asks
    // somebody to make a decision, and it was previously in-app only while the person who needed
    // no action at all got the email.
    await dispatchNotification({
      userId: manager.id,
      category: "timesheet.submitted",
      title: `${author.name} submitted a timesheet`,
      body: `${hours.toFixed(2)}h on ${project} for ${dateLabel} is awaiting your review.`,
      link: "/app/approvals",
      email: {
        templateKey: "timesheet.submitted",
        vars: { name: manager.name, hours: hours.toFixed(2), date: dateLabel, project, managerName: author.name, ...detailVars },
        fallback: {
          subject: `${author.name} submitted a timesheet — ${dateLabel}`,
          html: templates.timesheetSubmitted({ name: manager.name, hours, date: dateLabel, project, managerName: author.name, ...entryDetail })
        }
      }
    });
  }
}

/** Exported for services/mcp-tools.ts's `log_timesheet_entry`, which passes a synthetic
 *  `{ user, body, files }` rather than a real request. Every rule below — the Serializable
 *  overlap check, the project-assignment gate, the identity gate, the sanitisation — has to hold
 *  for an MCP client exactly as it does for the web app, and the only way to guarantee that is
 *  for there to be one copy of them. */
export async function saveTimesheet(req: any, status: "DRAFT" | "SUBMITTED") {
  const hours = calculateHours(req.body.startTime, req.body.endTime);
  const [year, month, day] = String(req.body.workDate).split("-").map(Number);
  const workDate = new Date(Date.UTC(year, month - 1, day));
  // "Future" on the AUTHOR's calendar, not the server's — see services/user-clock.service.ts.
  if (workDate > (await userClock(req.user.id)).today) throw new AppError(422, "Future dates are not allowed");
  if (hours <= 0) throw new AppError(422, "End time must be after start time");
  if (hours > 12) throw new AppError(422, "A single entry cannot exceed 12 hours");
  // Before the identity gate, so a refused pairing does not spend somebody's face check.
  await assertModuleBelongs(req.body.projectId, req.body.moduleId, req.body.submoduleId || null);

  // Identity gate. Only on SUBMITTED: a draft is private working state, and demanding a webcam
  // capture every time someone saves a half-finished row would be hostile without adding any
  // assurance — what matters is who stands behind the entry when it enters the approval queue.
  // Deliberately BEFORE any write, so a failed check cannot leave a half-created timesheet.
  // The consumed attempt id is bound to the row AFTER creation (it can't exist earlier) so the
  // verified badge can join attempt → timesheet.
  let consumedVerificationId: string | null = null;
  if (status === "SUBMITTED" && (await isFaceVerificationRequired(req.user.id, "TIMESHEET"))) {
    consumedVerificationId = await consumeVerification({
      verificationId: req.body.faceVerificationId,
      userId: req.user.id,
      context: "TIMESHEET"
    });
  }

  // Enforce project-assignment scope for non-privileged users.
  await assertAuthorAssigned({ id: req.user.id, role: req.user.role }, req.body.projectId);

  const ticketId = req.body.ticketId || null;
  if (ticketId) {
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null } });
    if (!ticket || ticket.projectId !== req.body.projectId) {
      throw new AppError(422, "Selected ticket does not belong to this project");
    }
  }

  const [startH, startM] = req.body.startTime.split(":").map(Number);
  const [endH, endM] = req.body.endTime.split(":").map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;

  const project = await prisma.project.findUniqueOrThrow({ where: { id: req.body.projectId } });
  const submittedAt = new Date();
  const approvalDeadline = status === "SUBMITTED" ? computeApprovalDeadline(submittedAt, project.slaApprovalHours) : null;
  // Persisted, not just used to derive the deadline. Every SUBMITTED write goes through this
  // function, so this is the only place it has to happen — but it does have to happen here, since
  // reconstructing it later from `approvalDeadline - project.slaApprovalHours` is only correct
  // while that project's SLA setting has never changed.
  const submittedAtValue = status === "SUBMITTED" ? submittedAt : null;

  // SECURITY: rich-text content arrives as HTML — sanitize before persisting.
  const cleanTaskDescription = sanitizeRichText(req.body.taskDescription);
  const cleanNotes = req.body.notes ? sanitizeRichText(req.body.notes) : "";

  const uploadedFiles = (req.files ?? []) as Express.Multer.File[];

  // Re-encoding happens OUTSIDE the transaction on purpose: WebP encoding is CPU-bound and can
  // take a noticeable moment per image, and holding a Serializable transaction open across it
  // would widen the window in which two concurrent submits for the same day contend.
  //
  // The entity id isn't known yet (the row doesn't exist), so the filename is keyed by the user
  // and timestamp instead — the prefix exists to make a file identifiable on disk, and
  // `<user>__timesheet-pending__<name>__<time>` does that just as well as a row id would.
  const processedAttachments = await Promise.all(
    uploadedFiles.map((file) =>
      processUpload(file, { userName: req.user.name ?? req.user.email, entityType: "timesheet", entityId: "pending" })
    )
  );

  // Wrap the overlap check + create in a Serializable transaction so two
  // simultaneous submits for the same (user, day) can't both pass the check.
  // Without this, concurrent requests can each "see no overlap" and both insert.
  const timesheet = await prisma.$transaction(
    async (tx) => {
      // REJECTED entries are excluded, and that exclusion is load-bearing: a rejected entry can no
      // longer be edited or deleted by its author, so if it still held its time slot the correcting
      // entry they are told to log would be refused with an overlap — leaving them unable to
      // record hours they actually worked. A refusal is the reviewer saying "this should not
      // stand"; it does not reserve the clock.
      const existing = await tx.timesheet.findMany({
        where: { userId: req.user.id, workDate, deletedAt: null, status: { not: "REJECTED" } }
      });
      const overlaps = existing.some((entry) => {
        const [eh, em] = entry.startTime.split(":").map(Number);
        const [xh, xm] = entry.endTime.split(":").map(Number);
        return start < xh * 60 + xm && end > eh * 60 + em;
      });
      if (overlaps) throw new AppError(409, "This time range overlaps another entry");

      return tx.timesheet.create({
        data: {
          projectId: req.body.projectId,
          moduleId: req.body.moduleId,
          submoduleId: req.body.submoduleId || null,
          ticketId,
          activityType: req.body.activityType,
          taskDescription: cleanTaskDescription,
          notes: cleanNotes,
          workDate,
          startTime: req.body.startTime,
          endTime: req.body.endTime,
          userId: req.user.id,
          totalHours: hours,
          status,
          submittedAt: submittedAtValue,
          approvalDeadline,
          attachments: {
            // Processed BEFORE the transaction body builds this row — images become WebP, text is
            // gzipped, and the structured filename is minted. See attachment-storage.service.ts.
            create: processedAttachments.map((processed) => ({
              ...processed,
              uploadedById: req.user.id
            }))
          }
        },
        include: { attachments: true, project: true, module: true, submodule: true, ticket: { select: { key: true, title: true } }, user: { include: { manager: true } } }
      });
    },
    { isolationLevel: "Serializable", timeout: 8000 }
  );

  if (consumedVerificationId) {
    await bindVerificationToRecord(consumedVerificationId, { timesheetId: timesheet.id });
  }

  await audit(req.user.id, `timesheet.${status.toLowerCase()}`, "Timesheet", timesheet.id);

  if (status === "SUBMITTED") {
    emitDomainEvent("timesheet.submitted", { timesheet });
    await announceSubmission(timesheet, { id: req.user.id, name: req.user.name }, timesheet.user.manager ?? null);
  }

  return timesheet;
}

timesheetRouter.post("/draft", requirePermission(permissions.TIMESHEETS_WRITE), validate(inputSchema), async (req, res) => {
  res.status(201).json(await saveTimesheet(req, "DRAFT"));
});

timesheetRouter.post("/submit", requirePermission(permissions.TIMESHEETS_WRITE), validate(inputSchema), async (req, res) => {
  res.status(201).json(await saveTimesheet(req, "SUBMITTED"));
});

timesheetRouter.post("/draft-with-files", requirePermission(permissions.TIMESHEETS_WRITE), preserveTenantContext(upload.array("attachments")), async (req, res) => {
  inputSchema.parse({ body: req.body });
  res.status(201).json(await saveTimesheet(req, "DRAFT"));
});

timesheetRouter.post("/submit-with-files", requirePermission(permissions.TIMESHEETS_WRITE), preserveTenantContext(upload.array("attachments")), async (req, res) => {
  inputSchema.parse({ body: req.body });
  res.status(201).json(await saveTimesheet(req, "SUBMITTED"));
});

/**
 * The decision cores, shared VERBATIM by the single routes and the bulk route below — approval
 * freezes billing rates and rejection notifies with a reason, and two copies of either is how a
 * payroll-relevant path drifts. Each takes an id and re-checks status itself, so a bulk loop
 * gets the same per-row refusals ("already decided") the single routes give, as data rather than
 * as a failed batch.
 *
 * WHO MAY DECIDE is `assertMayDecide` (services/timesheet-approval-scope.service.ts): never your own
 * entry, never one by somebody above you in your reporting line. The authority is loaded once per
 * request and passed in, so a hundred-row bulk decision walks the reporting line once.
 *
 * A DECISION LANDS ONCE. The status read above each write is advice, not a lock: two reviewers (or
 * one double-click) can both read SUBMITTED. The write is therefore conditional on the row STILL
 * being SUBMITTED, and the loser gets a 409 before any email or audit is sent — otherwise the
 * author got two "approved" mails, and approve racing reject left a REJECTED row carrying a frozen
 * billing rate.
 */
type Reviewer = { id: string; name?: string | null; email: string };

const DECISION_INCLUDE = { project: true, user: true, module: true, submodule: true } satisfies Prisma.TimesheetInclude;

const ALREADY_DECIDED = "This entry was already decided a moment ago, by someone else or by an earlier click — refresh to see the outcome.";

async function loadUndecided(id: string, verb: "approve" | "reject", authority: ApprovalAuthority) {
  const existing = await prisma.timesheet.findFirst({ where: { id, deletedAt: null } });
  if (!existing) throw new AppError(404, "Timesheet not found");
  if (existing.status !== "SUBMITTED") {
    throw new AppError(422, `Cannot ${verb} a timesheet in ${existing.status} status — only SUBMITTED entries can be ${verb}d.`);
  }
  assertMayDecide(authority, existing.userId);
  return existing;
}

/** The conditional write. Returns the decided row with its relations, or throws 409 when another
 *  decision got there first. */
async function writeDecision(id: string, data: Prisma.TimesheetUncheckedUpdateManyInput) {
  const claimed = await prisma.timesheet.updateMany({ where: { id, status: "SUBMITTED", deletedAt: null }, data });
  if (claimed.count === 0) throw new AppError(409, ALREADY_DECIDED);
  return prisma.timesheet.findUniqueOrThrow({ where: { id }, include: DECISION_INCLUDE });
}

async function approveCore(id: string, reviewerUser: Reviewer, authority: ApprovalAuthority) {
  const existing = await loadUndecided(id, "approve", authority);

  // Freeze the rate that applies to these hours, in the SAME write that approves them — see
  // services/billing-rate.service.ts for why approval is the correct moment and why this can
  // never block the approval itself. Best-effort: a billing-lookup failure must not stop a
  // manager approving real work, so the snapshot is skipped (leaving the row "unrated", which
  // downstream consumers already handle) rather than surfacing an error here.
  let ratePatch = {};
  try {
    ratePatch = await buildRateSnapshotPatch({
      userId: existing.userId,
      projectId: existing.projectId,
      totalHours: existing.totalHours,
      billable: existing.billable
    });
  } catch (error) {
    console.warn(`[timesheet] rate snapshot failed for ${existing.id}, approving unrated: ${(error as Error).message}`);
  }

  // Module, submodule and the task text travel into the decision emails (DECISION_INCLUDE):
  // somebody with four entries awaiting approval cannot tell from a date and a project which one
  // this is about.
  const item = await writeDecision(existing.id, { status: "APPROVED", reviewedAt: new Date(), reviewedById: reviewerUser.id, ...ratePatch });
  await resolveEscalationsFor(item.id);
  emitDomainEvent("timesheet.approved", { timesheet: item });

  const dateLabel = item.workDate.toISOString().slice(0, 10);
  const reviewer = reviewerUser.name ?? reviewerUser.email;
  const hours = Number(item.totalHours);
  await dispatchNotification({
    userId: item.userId,
    category: "timesheet.approved",
    title: "Timesheet approved",
    body: `Your ${hours.toFixed(2)}h entry for ${dateLabel} on ${item.project.name} was approved.`,
    link: "/app/history",
    email: {
      templateKey: "timesheet.approved",
      vars: {
        name: item.user.name,
        hours: hours.toFixed(2),
        date: dateLabel,
        reviewer,
        project: item.project.name,
        module: item.module?.name ?? "",
        submodule: item.submodule?.name ?? "",
        activity: item.activityType ?? "",
        description: entryText(item)
      },
      fallback: {
        subject: "Your timesheet was approved",
        html: templates.timesheetApproved({
          name: item.user.name,
          hours,
          date: dateLabel,
          reviewer,
          project: item.project.name,
          module: item.module?.name ?? null,
          submodule: item.submodule?.name ?? null,
          activity: item.activityType ?? null,
          description: entryText(item) || null
        })
      }
    }
  });

  await audit(reviewerUser.id, "timesheet.approved", "Timesheet", item.id);
  return item;
}

/**
 * The rejection, its notification and its per-row audit — all three, because the bulk route calls
 * this directly. The notification and audit used to live in the single `/:id/reject` route only, so
 * a bulk rejection refused every ticked entry and told none of their authors, who therefore never
 * re-logged the hours.
 */
async function rejectCore(id: string, reason: string, reviewerUser: Reviewer, authority: ApprovalAuthority) {
  const existing = await loadUndecided(id, "reject", authority);
  const cleanReason = reason.trim();

  const item = await writeDecision(existing.id, {
    status: "REJECTED",
    reviewedAt: new Date(),
    reviewedById: reviewerUser.id,
    rejectionReason: cleanReason
  });
  await resolveEscalationsFor(item.id);

  const dateLabel = item.workDate.toISOString().slice(0, 10);
  const reviewer = reviewerUser.name ?? reviewerUser.email;
  await dispatchNotification({
    userId: item.userId,
    category: "timesheet.rejected",
    title: "Timesheet rejected",
    body: `Your timesheet for ${dateLabel} was rejected: ${cleanReason}`,
    link: "/app/history",
    email: {
      templateKey: "timesheet.rejected",
      vars: {
        name: item.user.name,
        date: dateLabel,
        project: item.project.name,
        reviewer,
        reason: cleanReason,
        module: item.module?.name ?? "",
        submodule: item.submodule?.name ?? "",
        activity: item.activityType ?? "",
        description: entryText(item)
      },
      fallback: {
        subject: "Timesheet rejected — action required",
        html: templates.timesheetRejected({
          name: item.user.name,
          date: dateLabel,
          project: item.project.name,
          reviewer,
          reason: cleanReason,
          module: item.module?.name ?? null,
          submodule: item.submodule?.name ?? null,
          activity: item.activityType ?? null,
          // What they originally wrote, so fixing it is a correction rather than a retype.
          description: entryText(item) || null
        })
      }
    }
  });

  await audit(reviewerUser.id, "timesheet.rejected", "Timesheet", item.id, { reason: cleanReason });
  return item;
}

timesheetRouter.patch("/:id/approve", requirePermission(permissions.TIMESHEETS_APPROVE), async (req, res) => {
  // Identity gate on the APPROVER — approval is where the hours become payable, which makes it
  // at least as worth protecting as submission. Checked before the status write so a failed
  // check changes nothing. (Rejection is deliberately ungated: it moves no money, and demanding
  // a webcam capture to DECLINE something only discourages review.)
  if (await isFaceVerificationRequired(req.user!.id, "APPROVAL")) {
    await consumeVerification({
      verificationId: typeof req.body?.faceVerificationId === "string" ? req.body.faceVerificationId : undefined,
      userId: req.user!.id,
      context: "APPROVAL",
      timesheetId: String(req.params.id)
    });
  }
  res.json(await approveCore(String(req.params.id), req.user!, await loadApprovalAuthority(req.user!.id)));
});

/**
 * PATCH /timesheets/decide-bulk — one decision across an explicit selection (the approvals page
 * filters client-side over a capped list, so the client sends exactly the ids it showed; there is
 * no server-side filter mode to drift from).
 *
 * PER-ROW INDEPENDENCE, same rule as applyProposal: each entry runs the SAME core the single
 * routes run — rate snapshot, escalation resolution, notification, per-row audit — and one entry
 * refusing ("already decided while you were reading") is reported on its own row rather than
 * failing the eleven a manager explicitly ticked.
 *
 * THE IDENTITY CHECK IS CONSUMED ONCE for the batch, not once per row: it asserts the APPROVER's
 * presence at decision time, and demanding ten webcam captures to approve ten rows would push
 * managers toward not using the gate at all. The batch audit records it covered the whole set.
 */
timesheetRouter.patch("/decide-bulk", requirePermission(permissions.TIMESHEETS_APPROVE), async (req, res) => {
  const ids: unknown = req.body?.ids;
  const decision = req.body?.decision === "reject" ? "reject" : req.body?.decision === "approve" ? "approve" : null;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((v) => typeof v === "string")) {
    throw new AppError(422, "Send between 1 and 100 timesheet ids.");
  }
  if (!decision) throw new AppError(422, "decision must be approve or reject.");
  if (decision === "reject" && !reason) throw new AppError(422, "Rejection reason is required");

  if (decision === "approve" && (await isFaceVerificationRequired(req.user!.id, "APPROVAL"))) {
    await consumeVerification({
      verificationId: typeof req.body?.faceVerificationId === "string" ? req.body.faceVerificationId : undefined,
      userId: req.user!.id,
      context: "APPROVAL",
      timesheetId: ids[0] as string
    });
  }

  const authority = await loadApprovalAuthority(req.user!.id);
  let done = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  for (const id of ids as string[]) {
    try {
      if (decision === "approve") await approveCore(id, req.user!, authority);
      else await rejectCore(id, reason, req.user!, authority);
      done++;
    } catch (error) {
      failed.push({ id, reason: error instanceof AppError ? error.message : "Could not decide this entry." });
    }
  }

  await audit(req.user!.id, `timesheet.bulk_${decision}`, "Timesheet", "bulk", {
    requested: ids.length,
    done,
    failed: failed.length,
    ...(decision === "reject" ? { reason } : {})
  });
  res.json({ done, failed });
});

timesheetRouter.patch("/:id/reject", requirePermission(permissions.TIMESHEETS_APPROVE), async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
  if (!reason.trim()) throw new AppError(422, "Rejection reason is required");

  // Notification and audit happen inside the core — see rejectCore for why they moved there.
  res.json(await rejectCore(String(req.params.id), reason, req.user!, await loadApprovalAuthority(req.user!.id)));
});

/**
 * Removes an entry the author no longer wants.
 *
 * WHY THIS EXISTS: it didn't, and that was a real gap — there was no way, through the API or the
 * UI, to get rid of a draft logged by mistake. A wrong entry could only be edited into something
 * else or left sitting in the list forever. It also silently broke the e2e suite's cleanup, which
 * had been calling a route that never existed and treating the 404 as success.
 *
 * THE AUTHOR MAY DELETE A DRAFT, AND NOTHING ELSE. A SUBMITTED entry is awaiting someone's
 * decision. An APPROVED one is the basis of billing rates, cost reports and Verified Work
 * Attestations. A REJECTED one is the record of a decision with the reviewer's reason attached —
 * all three are accounts of something that happened, and letting the author erase them would let
 * history be rewritten after somebody had already acted on it.
 *
 * TIMESHEETS_APPROVE additionally reaches REJECTED, which is the tidy-up case: an admin clearing
 * up after someone who has left.
 *
 * THE REASON THIS IS SAFE for the author is one line in the overlap check: a REJECTED entry is
 * excluded from it, so the correcting entry they are told to log is not refused for overlapping
 * the refused one. Without that exclusion this rule would strand them — unable to edit it, delete
 * it, or re-log the hours they actually worked.
 *
 * Soft delete, matching every other deletion in this schema: the row stays for audit, and every
 * read path already filters `deletedAt: null` — including the overlap check, so the freed time
 * slot becomes immediately reusable.
 */
timesheetRouter.delete("/:id", requirePermission(permissions.TIMESHEETS_WRITE), async (req, res) => {
  const existing = await prisma.timesheet.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!existing) throw new AppError(404, "Timesheet not found");

  // Authors manage their own entries; TIMESHEETS_APPROVE (managers and up) can clear anyone's, so
  // an admin can tidy up after someone who has left.
  const isOwner = existing.userId === req.user!.id;
  const canManageOthers = req.user!.permissions.includes(permissions.TIMESHEETS_APPROVE);
  if (!isOwner && !canManageOthers) throw new AppError(403, "You can only delete your own entries.");

  // The AUTHOR's window is DRAFT alone. REJECTED used to be in it, and taking it out is the same
  // rule the edit path applies: a reviewer has recorded a decision, and the record of a refused
  // submission — with the reason attached — is not the author's to erase. An admin keeps it, which
  // is what the tidy-up case above is for.
  const deletable = canManageOthers ? ["DRAFT", "REJECTED"] : ["DRAFT"];
  if (!deletable.includes(existing.status)) {
    throw new AppError(
      422,
      existing.status === "REJECTED"
        ? "A rejected entry is the record of a decision, with the reviewer's reason attached — it stays. Log a fresh entry with the correction; the refused one no longer holds its time slot."
        : `Cannot delete a ${existing.status} entry — submitted hours are awaiting review, and approved hours are part of the billing record. Log a correcting entry instead.`
    );
  }

  await prisma.timesheet.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
  await audit(req.user!.id, "timesheet.deleted", "Timesheet", existing.id, {
    status: existing.status,
    workDate: existing.workDate.toISOString().slice(0, 10)
  });
  res.status(204).send();
});

/**
 * A DECIDED ENTRY IS IMMUTABLE — for everyone, including the reviewer who decided it.
 *
 * This started as a rule that bound the author and exempted `TIMESHEETS_APPROVE`, on the argument
 * that whoever decides whether hours are payable can also correct them. The exemption is gone
 * because it undoes the thing the decision is FOR: an APPROVED entry carries a frozen rate and
 * feeds cost reports and Verified Work Attestations, so an approver editing it after the fact
 * changes a figure a client may already have been shown — and does so with the same audit entry a
 * routine typo fix produces. A REJECTED entry carries the reviewer's stated reason; rewriting the
 * text that reason refers to leaves the reason attached to something it was never about.
 *
 * The window for BOTH roles is now the undecided one: DRAFT and SUBMITTED. Correcting an approved
 * entry means a new entry, which is the same answer the delete rule has always given, and which
 * leaves the original record intact rather than quietly replacing it.
 *
 * Called by PATCH and by both attachment routes, so there is exactly one definition of "decided"
 * and no route can grow its own.
 */
function assertUndecided(status: string): void {
  if (status !== "APPROVED" && status !== "REJECTED") return;
  throw new AppError(
    422,
    status === "APPROVED"
      ? "This entry has been approved — the hours carry a frozen rate and may already sit behind a client-facing record. Log a correcting entry rather than changing this one."
      : "This entry was rejected, and the reviewer's reason is recorded against it. Log a fresh entry with the correction — the refused one no longer holds its time slot."
  );
}

/* ==================== Submitting a draft that already exists ==================== */

/**
 * POST /timesheets/:id/submit — move a DRAFT into the approval queue.
 *
 * WHY THIS EXISTS: it did not, and its absence made "Save draft" a one-way door. `saveTimesheet`
 * only ever CREATES a row, so a draft could be edited forever and never actually submitted — the
 * only ways out were to delete it and re-type the whole entry into the logging form, or to leave
 * it sitting in History as permanently unsubmitted work. That is also what made the widened edit
 * window half a feature: correcting a draft is pointless if the corrected draft cannot then go
 * anywhere.
 *
 * Everything a fresh submit does, this does, because they are the same event and a second half-copy
 * of it is how one of them drifts:
 *   • the identity gate, if the workspace's face policy covers this user + TIMESHEET;
 *   • `submittedAt` and the SLA `approvalDeadline` computed from the project's own setting;
 *   • the submitter's confirmation and the manager's "awaiting your review" notification;
 *   • the `timesheet.submitted` domain event, which the SLA sweeps and digests read.
 *
 * DRAFT ONLY. A SUBMITTED entry is already in the queue; an APPROVED or REJECTED one has a decision
 * recorded against it, and re-submitting would quietly reopen something a reviewer already closed —
 * the path from a rejection is a fresh entry, which is why a rejected entry stays deletable.
 */
timesheetRouter.post("/:id/submit", requirePermission(permissions.TIMESHEETS_WRITE), async (req, res) => {
  const existing = await prisma.timesheet.findFirst({
    where: { id: String(req.params.id), deletedAt: null },
    include: { project: true, user: { include: { manager: true } } }
  });
  if (!existing) throw new AppError(404, "Timesheet not found");

  const isOwner = existing.userId === req.user!.id;
  const canActForOthers = req.user!.permissions.includes(permissions.TIMESHEETS_APPROVE);
  if (!isOwner && !canActForOthers) throw new AppError(403, "You can only submit your own entries.");
  if (existing.status !== "DRAFT") {
    throw new AppError(
      422,
      existing.status === "SUBMITTED"
        ? "This entry is already awaiting a decision."
        : `This entry is ${existing.status} — a decision has been recorded against it. Log a fresh entry instead.`
    );
  }

  // The identity gate, on the SUBMITTER, exactly as the create path applies it — a draft is
  // private working state, and this is the moment it becomes something an approver signs off.
  // Checked before any write, so a failed check leaves the draft untouched.
  let consumedVerificationId: string | null = null;
  if (await isFaceVerificationRequired(existing.userId, "TIMESHEET")) {
    consumedVerificationId = await consumeVerification({
      verificationId: typeof req.body?.faceVerificationId === "string" ? req.body.faceVerificationId : undefined,
      userId: req.user!.id,
      context: "TIMESHEET"
    });
  }

  const submittedAt = new Date();
  const updated = await prisma.timesheet.update({
    where: { id: existing.id },
    data: {
      status: "SUBMITTED",
      submittedAt,
      approvalDeadline: computeApprovalDeadline(submittedAt, existing.project.slaApprovalHours)
    },
    include: ENTRY_DETAIL_INCLUDE
  });

  if (consumedVerificationId) await bindVerificationToRecord(consumedVerificationId, { timesheetId: updated.id });

  emitDomainEvent("timesheet.submitted", { timesheet: updated });
  await audit(req.user!.id, "timesheet.submitted", "Timesheet", updated.id, {
    from: "DRAFT",
    ...(isOwner ? {} : { onBehalfOf: updated.userId })
  });

  // The same receipt and approver email a fresh submit sends — see announceSubmission.
  await announceSubmission(updated, { id: existing.userId, name: existing.user.name }, existing.user.manager ?? null);

  await respondWithEntry(res, updated);
});

/* ==================== Editing an entry after it was logged ==================== */

const patchSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      projectId: z.string().uuid().optional(),
      moduleId: z.string().uuid().optional(),
      submoduleId: z.string().uuid().nullable().optional().or(z.literal("")),
      ticketId: z.string().uuid().nullable().optional().or(z.literal("")),
      activityType: z.string().min(2).max(60).optional(),
      taskDescription: z.string().min(10).optional(),
      workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      notes: z.string().optional()
    })
    .strict()
});

/**
 * PATCH /timesheets/:id — correct an entry in place.
 *
 * WHY THIS EXISTS: until now the only way to fix a logged entry was to delete it and re-type it,
 * and delete refuses everything past DRAFT/REJECTED. So a submitted entry with the wrong module,
 * or an approved one whose description said the wrong thing, was simply frozen wrong forever. The
 * approvals and history screens both offer "open this entry" now; being able to read it and not
 * fix it is half a feature.
 *
 * WHO MAY EDIT WHAT — two rules, matching who bears the consequence:
 * WHO MAY EDIT: the AUTHOR, or anyone holding TIMESHEETS_APPROVE — and BOTH only while the entry
 * is UNDECIDED (DRAFT or SUBMITTED). See `assertUndecided` for why the reviewer has no exemption.
 *
 * SUBMITTED is in, and that is the part worth explaining: deleting a submitted entry erases a
 * request somebody is being asked to decide on, but fixing a typo in it does not. Excluding it
 * sent the author to their approver to change one word, and an approver's only "send it back" tool
 * is a REJECTION — so a spelling mistake cost a rejection, a notification and a re-submission.
 * Editing while SUBMITTED notifies the other party (below) precisely because they may have already
 * read it.
 *
 * EVERY EDIT IS FULLY AUDITED with a field-by-field before/after — that is the part that makes
 * editing an APPROVED entry defensible rather than alarming. The record still says what happened;
 * it now also says who changed it and from what.
 *
 * Deliberately NOT editable here: `status` (that is approve/reject, which notify and freeze rates)
 * and `billable` (a billing decision, not a description of work). Both have their own routes.
 */
timesheetRouter.patch("/:id", requirePermission(permissions.TIMESHEETS_WRITE), validate(patchSchema), async (req, res) => {
  const existing = await prisma.timesheet.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!existing) throw new AppError(404, "Timesheet not found");

  const isOwner = existing.userId === req.user!.id;
  const canEditOthers = req.user!.permissions.includes(permissions.TIMESHEETS_APPROVE);
  if (!isOwner && !canEditOthers) throw new AppError(403, "You can only edit your own entries.");
  assertUndecided(existing.status);

  // Merge first, validate the MERGED entry second: times, dates and the project/module/ticket
  // triangle are only consistent as a set, and validating just the supplied fields would let
  // "change the project" quietly leave a module belonging to the old one.
  const next = {
    projectId: req.body.projectId ?? existing.projectId,
    moduleId: req.body.moduleId ?? existing.moduleId,
    submoduleId: "submoduleId" in req.body ? req.body.submoduleId || null : existing.submoduleId,
    ticketId: "ticketId" in req.body ? req.body.ticketId || null : existing.ticketId,
    activityType: req.body.activityType ?? existing.activityType,
    workDate: req.body.workDate ?? existing.workDate.toISOString().slice(0, 10),
    startTime: req.body.startTime ?? existing.startTime,
    endTime: req.body.endTime ?? existing.endTime
  };

  const hours = calculateHours(next.startTime, next.endTime);
  if (hours <= 0) throw new AppError(422, "End time must be after start time");
  if (hours > 12) throw new AppError(422, "A single entry cannot exceed 12 hours");

  const [year, month, day] = next.workDate.split("-").map(Number);
  const workDate = new Date(Date.UTC(year, month - 1, day));
  // The entry's AUTHOR's calendar decides what "future" means, whoever is editing it.
  if (workDate > (await userClock(existing.userId)).today) throw new AppError(422, "Future dates are not allowed");

  // The module has to belong to the project, and the ticket too — the same pairing check the
  // create path runs (see assertModuleBelongs).
  await assertModuleBelongs(next.projectId, next.moduleId, next.submoduleId);
  // Moving the hours to another project is logging them there, so the AUTHOR must be assigned to it
  // — the create path's rule. PATCH never checked, so an edit could put hours on any project.
  if (next.projectId !== existing.projectId) {
    const author = await prisma.user.findUnique({ where: { id: existing.userId }, select: { role: { select: { name: true } } } });
    await assertAuthorAssigned({ id: existing.userId, role: author?.role?.name }, next.projectId);
  }
  if (next.ticketId) {
    const ticket = await prisma.ticket.findFirst({ where: { id: next.ticketId, deletedAt: null } });
    if (!ticket || ticket.projectId !== next.projectId) {
      throw new AppError(422, "Selected ticket does not belong to this project");
    }
  }

  const [startH, startM] = next.startTime.split(":").map(Number);
  const [endH, endM] = next.endTime.split(":").map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;

  const data: Record<string, unknown> = {
    projectId: next.projectId,
    moduleId: next.moduleId,
    submoduleId: next.submoduleId,
    ticketId: next.ticketId,
    activityType: next.activityType,
    workDate,
    startTime: next.startTime,
    endTime: next.endTime,
    totalHours: hours,
    // Stamped on EVERY edit, including the author's own — "I changed this myself on Tuesday" is
    // as useful to the person reading their own history as knowing a manager did.
    lastEditedById: req.user!.id,
    lastEditedAt: new Date()
  };
  // SECURITY: same rule as the create path — rich text arrives as HTML and is sanitized before it
  // is stored, never on the way out.
  if (typeof req.body.taskDescription === "string") data.taskDescription = sanitizeRichText(req.body.taskDescription);
  if (typeof req.body.notes === "string") data.notes = req.body.notes ? sanitizeRichText(req.body.notes) : "";

  /**
   * A MATERIAL change — when, how long, or against which project/module — makes this a different
   * claim from the one that was submitted, even though it keeps its id and its SUBMITTED status (an
   * author fixing a typo must not have to re-submit, so status is deliberately left alone). Two
   * things follow, and a wording fix triggers neither:
   *  - the reviewer is deciding something new, so the approval clock restarts from now;
   *  - the submit-time identity check vouched for the old claim, so its "verified" binding is
   *    dropped below, after the write succeeds.
   */
  const materialChange =
    next.projectId !== existing.projectId ||
    next.moduleId !== existing.moduleId ||
    workDate.getTime() !== existing.workDate.getTime() ||
    next.startTime !== existing.startTime ||
    next.endTime !== existing.endTime;
  if (materialChange && existing.status === "SUBMITTED") {
    const project = await prisma.project.findUnique({ where: { id: next.projectId }, select: { slaApprovalHours: true } });
    data.approvalDeadline = computeApprovalDeadline(new Date(), project?.slaApprovalHours);
  }

  // An APPROVED entry carries a frozen rate. If the hours moved, the frozen AMOUNT has to move
  // with them or the attestation would assert a total its own hours don't support. The RATE
  // itself is untouched — re-resolving it would silently apply today's rate to last quarter's
  // work, which is exactly what the snapshot exists to prevent.
  if (existing.status === "APPROVED" && existing.billedRate && Number(existing.totalHours) !== hours) {
    data.billedAmount = existing.billable ? new Prisma.Decimal(existing.billedRate).mul(new Prisma.Decimal(hours)) : new Prisma.Decimal(0);
  }

  const updated = await prisma.$transaction(
    async (tx) => {
      // Overlap is checked against the ENTRY'S OWN author, not the editor — a manager fixing
      // someone else's row must not be allowed to push it on top of another of that person's
      // entries. `id: { not: … }` so an edit that leaves the times alone doesn't collide with
      // itself.
      const sameDay = await tx.timesheet.findMany({
        where: { userId: existing.userId, workDate, deletedAt: null, id: { not: existing.id }, status: { not: "REJECTED" } }
      });
      const overlaps = sameDay.some((entry) => {
        const [eh, em] = entry.startTime.split(":").map(Number);
        const [xh, xm] = entry.endTime.split(":").map(Number);
        return start < xh * 60 + xm && end > eh * 60 + em;
      });
      if (overlaps) throw new AppError(409, "This time range overlaps another entry on that day");

      return tx.timesheet.update({ where: { id: existing.id }, data, include: ENTRY_DETAIL_INCLUDE });
    },
    { isolationLevel: "Serializable", timeout: 8000 }
  );

  // Only what actually moved, old and new — an audit entry listing nine unchanged fields is one
  // nobody reads, and the question this row answers is "what did they change?".
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const compare: Array<[string, unknown, unknown]> = [
    ["projectId", existing.projectId, updated.projectId],
    ["moduleId", existing.moduleId, updated.moduleId],
    ["submoduleId", existing.submoduleId, updated.submoduleId],
    ["ticketId", existing.ticketId, updated.ticketId],
    ["activityType", existing.activityType, updated.activityType],
    ["workDate", existing.workDate.toISOString().slice(0, 10), updated.workDate.toISOString().slice(0, 10)],
    ["startTime", existing.startTime, updated.startTime],
    ["endTime", existing.endTime, updated.endTime],
    ["totalHours", Number(existing.totalHours), Number(updated.totalHours)],
    ["taskDescription", existing.taskDescription, updated.taskDescription],
    ["notes", existing.notes ?? "", updated.notes ?? ""]
  ];
  for (const [field, from, to] of compare) if (from !== to) changes[field] = { from, to };

  const identityVerificationDropped = materialChange ? await unbindTimesheetVerification(updated.id) : [];

  await audit(req.user!.id, "timesheet.updated", "Timesheet", updated.id, {
    status: updated.status,
    onBehalfOf: isOwner ? undefined : updated.userId,
    changes,
    // Which identity check(s) stopped vouching for this entry, so the badge's disappearance has a
    // recorded cause rather than looking like data loss.
    ...(identityVerificationDropped.length > 0 ? { identityVerificationDropped } : {})
  });

  // Nobody learns about a change to their work from a diff they had to go looking for. Two
  // directions, and both matter:
  const dateLabel = updated.workDate.toISOString().slice(0, 10);
  const editor = req.user!.name ?? req.user!.email;
  if (Object.keys(changes).length > 0) {
    if (!isOwner) {
      // A reviewer rewrote somebody's record of work. Silent edits are how an approval queue
      // loses the submitter's trust.
      await dispatchNotification({
        userId: updated.userId,
        category: "timesheet.updated",
        title: "Your timesheet entry was edited",
        body: `${editor} edited your ${Number(updated.totalHours).toFixed(2)}h entry for ${dateLabel} on ${updated.project.name}.`,
        link: `/app/history?entry=${updated.id}`
      });
    } else if (updated.status === "SUBMITTED") {
      // The author changed something ALREADY IN the approval queue. This is the counterpart of
      // widening their edit window past submission: the approver may have read this entry
      // already, so the thing they are being asked to decide on must not change behind them.
      const author = await prisma.user.findUnique({ where: { id: updated.userId }, select: { managerId: true } });
      if (author?.managerId) {
        await dispatchNotification({
          userId: author.managerId,
          category: "timesheet.updated",
          title: `${editor} edited a timesheet awaiting your review`,
          body: `The ${Number(updated.totalHours).toFixed(2)}h entry for ${dateLabel} on ${updated.project.name} changed after it was submitted.`,
          link: "/app/approvals"
        });
      }
    }
  }

  await respondWithEntry(res, updated);
});

/* ==================== Attachments on an existing entry ==================== */

/** Who may attach to / detach from an entry: its author while it is still theirs to shape, or
 *  anyone who can approve it. Same two-rule model as PATCH above, kept in one place so the file
 *  cannot grow a third opinion about it. */
async function assertCanAttach(req: any, entry: { userId: string; status: string }) {
  const isOwner = entry.userId === req.user.id;
  const canEditOthers = req.user.permissions.includes(permissions.TIMESHEETS_APPROVE);
  if (!isOwner && !canEditOthers) throw new AppError(403, "You can only change your own entries.");
  // The same immutability rule the text fields get — evidence attached to a decided entry is part
  // of what was decided on.
  assertUndecided(entry.status);
}

timesheetRouter.post(
  "/:id/attachments",
  requirePermission(permissions.TIMESHEETS_WRITE),
  preserveTenantContext(upload.array("attachments")),
  async (req, res) => {
    const entry = await prisma.timesheet.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
    if (!entry) throw new AppError(404, "Timesheet not found");
    await assertCanAttach(req, entry);

    const files = (req.files ?? []) as Express.Multer.File[];
    if (files.length === 0) throw new AppError(422, "No files were uploaded");

    // Same pipeline the create path uses — images to WebP, text gzipped, structured filename —
    // so a file added later is indistinguishable on disk from one attached at submit time.
    const processed = await Promise.all(
      files.map((file) =>
        processUpload(file, { userName: req.user!.name ?? req.user!.email, entityType: "timesheet", entityId: entry.id })
      )
    );
    await prisma.attachment.createMany({
      data: processed.map((p) => ({ ...p, timesheetId: entry.id, uploadedById: req.user!.id }))
    });
    await audit(req.user!.id, "timesheet.attachment_added", "Timesheet", entry.id, { count: processed.length });

    const refreshed = await loadVisibleEntry(req, entry.id);
    if (!refreshed) throw new AppError(404, "Timesheet not found");
    await respondWithEntry(res, refreshed);
  }
);

timesheetRouter.delete("/:id/attachments/:attachmentId", requirePermission(permissions.TIMESHEETS_WRITE), async (req, res) => {
  const entry = await prisma.timesheet.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!entry) throw new AppError(404, "Timesheet not found");
  await assertCanAttach(req, entry);

  const attachment = await prisma.attachment.findFirst({
    where: { id: String(req.params.attachmentId), timesheetId: entry.id }
  });
  if (!attachment) throw new AppError(404, "Attachment not found");

  await prisma.attachment.delete({ where: { id: attachment.id } });
  await audit(req.user!.id, "timesheet.attachment_removed", "Timesheet", entry.id, {
    attachmentId: attachment.id,
    fileName: attachment.fileName
  });
  res.status(204).send();
});
