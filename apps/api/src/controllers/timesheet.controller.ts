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
import { z } from "zod";
import { calculateHours, permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { preserveTenantContext, upload } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { dispatchNotification } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { computeApprovalDeadline, resolveEscalationsFor } from "../services/sla.service.js";
import { dispatchOutboundWebhooks } from "../services/webhook-dispatch.service.js";
import { sanitizeRichText } from "../utils/sanitize.js";
import { consumeVerification, isFaceVerificationRequired } from "../services/face.service.js";

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
      user: { select: { name: true, email: true, avatarUrl: true } }
    },
    orderBy: [{ workDate: "desc" }, { startTime: "desc" }],
    take: 100
  });
  res.json(timesheets);
});

async function saveTimesheet(req: any, status: "DRAFT" | "SUBMITTED") {
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
  if (status === "SUBMITTED" && (await isFaceVerificationRequired(req.user.id, "TIMESHEET"))) {
    await consumeVerification({
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

  // SECURITY: rich-text content arrives as HTML — sanitize before persisting.
  const cleanTaskDescription = sanitizeRichText(req.body.taskDescription);
  const cleanNotes = req.body.notes ? sanitizeRichText(req.body.notes) : "";

  const uploadedFiles = (req.files ?? []) as Express.Multer.File[];

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
          approvalDeadline,
          attachments: {
            create: uploadedFiles.map((file) => ({
              fileName: file.originalname,
              mimeType: file.mimetype || "application/octet-stream",
              url: `/uploads/${file.filename}`,
              sizeBytes: file.size
            }))
          }
        },
        include: { attachments: true, project: true, module: true, submodule: true, user: { include: { manager: true } } }
      });
    },
    { isolationLevel: "Serializable", timeout: 8000 }
  );

  await audit(req.user.id, `timesheet.${status.toLowerCase()}`, "Timesheet", timesheet.id);

  if (status === "SUBMITTED") {
    await dispatchOutboundWebhooks("timesheet.submitted", { timesheet });
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

timesheetRouter.patch("/:id/approve", requirePermission(permissions.TIMESHEETS_APPROVE), async (req, res) => {
  const existing = await prisma.timesheet.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!existing) throw new AppError(404, "Timesheet not found");
  if (existing.status !== "SUBMITTED") {
    throw new AppError(422, `Cannot approve a timesheet in ${existing.status} status — only SUBMITTED entries can be approved.`);
  }

  const item = await prisma.timesheet.update({
    where: { id: existing.id },
    data: { status: "APPROVED", reviewedAt: new Date(), reviewedById: req.user!.id },
    include: { project: true, user: true }
  });
  await resolveEscalationsFor(item.id);
  await dispatchOutboundWebhooks("timesheet.approved", { timesheet: item });

  const dateLabel = item.workDate.toISOString().slice(0, 10);
  const reviewer = req.user!.name ?? req.user!.email;
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

  await audit(req.user!.id, "timesheet.approved", "Timesheet", item.id);
  res.json(item);
});

timesheetRouter.patch("/:id/reject", requirePermission(permissions.TIMESHEETS_APPROVE), async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
  if (!reason.trim()) throw new AppError(422, "Rejection reason is required");

  const existing = await prisma.timesheet.findFirst({ where: { id: String(req.params.id), deletedAt: null } });
  if (!existing) throw new AppError(404, "Timesheet not found");
  if (existing.status !== "SUBMITTED") {
    throw new AppError(422, `Cannot reject a timesheet in ${existing.status} status — only SUBMITTED entries can be rejected.`);
  }

  const item = await prisma.timesheet.update({
    where: { id: existing.id },
    data: { status: "REJECTED", reviewedAt: new Date(), reviewedById: req.user!.id, rejectionReason: reason.trim() },
    include: { project: true, user: true }
  });
  await resolveEscalationsFor(item.id);

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
