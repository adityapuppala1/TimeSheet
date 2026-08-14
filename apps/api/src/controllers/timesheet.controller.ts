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
import { bindVerificationToRecord, consumeVerification, getTimesheetVerificationBadges, isFaceVerificationRequired } from "../services/face.service.js";

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

export const timesheetRouter = Router();
timesheetRouter.use(requireAuth);

timesheetRouter.get("/", async (req, res) => {
  const canViewAll = req.user!.permissions.includes(permissions.REPORTS_VIEW);
  const requestedUserId = typeof req.query.userId === "string" && req.query.userId ? req.query.userId : undefined;
  const status = typeof req.query.status === "string" && req.query.status ? (req.query.status as any) : undefined;
  const timesheets = await prisma.timesheet.findMany({
    where: { userId: canViewAll ? requestedUserId : req.user!.id, status, deletedAt: null },
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
    take: 100
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

/** Exported for services/mcp-tools.ts's `log_timesheet_entry`, which passes a synthetic
 *  `{ user, body, files }` rather than a real request. Every rule below — the Serializable
 *  overlap check, the project-assignment gate, the identity gate, the sanitisation — has to hold
 *  for an MCP client exactly as it does for the web app, and the only way to guarantee that is
 *  for there to be one copy of them. */
export async function saveTimesheet(req: any, status: "DRAFT" | "SUBMITTED") {
  const hours = calculateHours(req.body.startTime, req.body.endTime);
  const [year, month, day] = String(req.body.workDate).split("-").map(Number);
  const workDate = new Date(Date.UTC(year, month - 1, day));
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  if (workDate > todayUtc) throw new AppError(422, "Future dates are not allowed");
  if (hours <= 0) throw new AppError(422, "End time must be after start time");
  if (hours > 12) throw new AppError(422, "A single entry cannot exceed 12 hours");

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
  if (!["SUPER_ADMIN", "ADMIN"].includes(req.user.role)) {
    const assigned = await prisma.userProjectAssignment.findFirst({
      where: { userId: req.user.id, projectId: req.body.projectId }
    });
    if (!assigned) throw new AppError(403, "You are not assigned to this project");
  }

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
      const existing = await tx.timesheet.findMany({
        where: { userId: req.user.id, workDate, deletedAt: null }
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
        include: { attachments: true, project: true, module: true, submodule: true, user: { include: { manager: true } } }
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
    const dateLabel = workDate.toISOString().slice(0, 10);
    const managerName = timesheet.user.manager?.name ?? null;

    await dispatchNotification({
      userId: req.user.id,
      category: "timesheet.submitted",
      title: "Timesheet submitted",
      body: `${hours.toFixed(2)}h on ${timesheet.project.name} for ${dateLabel} sent for approval.`,
      link: "/app/history",
      email: {
        templateKey: "timesheet.submitted",
        vars: {
          name: req.user.name,
          hours: hours.toFixed(2),
          date: dateLabel,
          project: timesheet.project.name,
          managerName: managerName ?? ""
        },
        fallback: {
          subject: "Timesheet submitted",
          html: templates.timesheetSubmitted({ name: req.user.name, hours, date: dateLabel, project: timesheet.project.name, managerName })
        }
      }
    });

    if (timesheet.user.manager) {
      await dispatchNotification({
        userId: timesheet.user.manager.id,
        category: "timesheet.submitted",
        title: `${req.user.name} submitted a timesheet`,
        body: `${hours.toFixed(2)}h on ${timesheet.project.name} for ${dateLabel} is awaiting your review.`,
        link: "/app/approvals"
      });
    }
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
 */
async function approveCore(id: string, reviewerUser: { id: string; name?: string | null; email: string }) {
  const existing = await prisma.timesheet.findFirst({ where: { id, deletedAt: null } });
  if (!existing) throw new AppError(404, "Timesheet not found");
  if (existing.status !== "SUBMITTED") {
    throw new AppError(422, `Cannot approve a timesheet in ${existing.status} status — only SUBMITTED entries can be approved.`);
  }

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

  const item = await prisma.timesheet.update({
    where: { id: existing.id },
    data: { status: "APPROVED", reviewedAt: new Date(), reviewedById: reviewerUser.id, ...ratePatch },
    include: { project: true, user: true }
  });
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
        project: item.project.name
      },
      fallback: {
        subject: "Your timesheet was approved",
        html: templates.timesheetApproved({ name: item.user.name, hours, date: dateLabel, reviewer, project: item.project.name })
      }
    }
  });

  await audit(reviewerUser.id, "timesheet.approved", "Timesheet", item.id);
  return item;
}

async function rejectCore(id: string, reason: string, reviewerUser: { id: string; name?: string | null; email: string }) {
  const existing = await prisma.timesheet.findFirst({ where: { id, deletedAt: null } });
  if (!existing) throw new AppError(404, "Timesheet not found");
  if (existing.status !== "SUBMITTED") {
    throw new AppError(422, `Cannot reject a timesheet in ${existing.status} status — only SUBMITTED entries can be rejected.`);
  }

  const item = await prisma.timesheet.update({
    where: { id: existing.id },
    data: { status: "REJECTED", reviewedAt: new Date(), reviewedById: reviewerUser.id, rejectionReason: reason.trim() },
    include: { project: true, user: true }
  });
  await resolveEscalationsFor(item.id);
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
  res.json(await approveCore(String(req.params.id), req.user!));
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

  let done = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  for (const id of ids as string[]) {
    try {
      if (decision === "approve") await approveCore(id, req.user!);
      else await rejectCore(id, reason, req.user!);
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

  const item = await rejectCore(String(req.params.id), reason, req.user!);

  const dateLabel = item.workDate.toISOString().slice(0, 10);
  const reviewer = req.user!.name ?? req.user!.email;
  const cleanReason = reason.trim();
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
        reason: cleanReason
      },
      fallback: {
        subject: "Timesheet rejected — action required",
        html: templates.timesheetRejected({ name: item.user.name, date: dateLabel, project: item.project.name, reviewer, reason: cleanReason })
      }
    }
  });

  await audit(req.user!.id, "timesheet.rejected", "Timesheet", item.id, { reason: cleanReason });
  res.json(item);
});

/**
 * Removes an entry the author no longer wants.
 *
 * WHY THIS EXISTS: it didn't, and that was a real gap — there was no way, through the API or the
 * UI, to get rid of a draft logged by mistake. A wrong entry could only be edited into something
 * else or left sitting in the list forever. It also silently broke the e2e suite's cleanup, which
 * had been calling a route that never existed and treating the 404 as success.
 *
 * ONLY DRAFT AND REJECTED, deliberately. A SUBMITTED entry is awaiting someone's decision, and an
 * APPROVED one is the basis of billing rates, cost reports and Verified Work Attestations — those
 * are records of something that happened, and deleting them would let history be rewritten after
 * a client had already been shown it. Approved hours are corrected by a new entry, not by erasure.
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

  if (existing.status !== "DRAFT" && existing.status !== "REJECTED") {
    throw new AppError(
      422,
      `Cannot delete a ${existing.status} entry — submitted hours are awaiting review, and approved hours are part of the billing record. Log a correcting entry instead.`
    );
  }

  await prisma.timesheet.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
  await audit(req.user!.id, "timesheet.deleted", "Timesheet", existing.id, {
    status: existing.status,
    workDate: existing.workDate.toISOString().slice(0, 10)
  });
  res.status(204).send();
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
 *   • the AUTHOR, until the entry is APPROVED. DRAFT, SUBMITTED and REJECTED are all still the
 *     author's to correct.
 *
 *     This is deliberately WIDER than the delete rule, which stops at REJECTED. Deleting a
 *     SUBMITTED entry erases a request somebody is being asked to decide on; fixing a typo in it
 *     does not. The old rule sent the author to their approver to change one word, and the
 *     approver's only tool was to reject the entry — so a spelling mistake cost a rejection, a
 *     notification, and a re-submission. Editing while SUBMITTED does notify the approver (below)
 *     precisely because they may have already read it.
 *
 *     APPROVED stops there for the author: those hours carry a frozen rate and feed cost reports
 *     and Verified Work Attestations. That is a record somebody may already have been shown, and
 *     changing it is a reviewer's call.
 *   • TIMESHEETS_APPROVE (manager / admin / super admin), in ANY status. They already decide
 *     whether these hours are payable; withholding "fix the module name" from someone trusted to
 *     approve the hours is a distinction without a difference, and the alternative in practice is
 *     a rejection round-trip for a typo.
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
  if (isOwner && !canEditOthers && existing.status === "APPROVED") {
    throw new AppError(
      422,
      "This entry has been approved — the hours are part of the billing record now. Ask your approver to make the correction, or log a correcting entry."
    );
  }

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
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  if (workDate > todayUtc) throw new AppError(422, "Future dates are not allowed");

  // The module has to belong to the project, and the ticket too — the create path gets this for
  // free from cascading pickers, but a PATCH can name any pair.
  const moduleRow = await prisma.projectModule.findFirst({ where: { id: next.moduleId } });
  if (!moduleRow || moduleRow.projectId !== next.projectId) {
    throw new AppError(422, "Selected module does not belong to this project");
  }
  if (next.submoduleId) {
    const submoduleRow = await prisma.projectSubmodule.findFirst({ where: { id: next.submoduleId } });
    if (!submoduleRow || submoduleRow.moduleId !== next.moduleId) {
      throw new AppError(422, "Selected submodule does not belong to this module");
    }
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
        where: { userId: existing.userId, workDate, deletedAt: null, id: { not: existing.id } }
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

  await audit(req.user!.id, "timesheet.updated", "Timesheet", updated.id, {
    status: updated.status,
    onBehalfOf: isOwner ? undefined : updated.userId,
    changes
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
  if (isOwner && !canEditOthers && entry.status === "APPROVED") {
    throw new AppError(422, "This entry has been approved — ask your approver to attach the file for you.");
  }
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
