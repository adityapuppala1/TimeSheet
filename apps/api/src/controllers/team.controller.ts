/**
 * WHAT: a manager's "my team" view — direct reports with timesheet roll-up stats, escalations
 * targeted at them, and an SLA summary for the manager dashboard.
 * WHY: `User.managerId` already encodes the reporting chain; this router is the read-only
 * aggregation over it that `apps/web/src/pages/Team.tsx` renders, computed here rather than
 * client-side so the numbers stay consistent regardless of how much history a report has.
 * WHO calls this: `apps/web/src/pages/Team.tsx`.
 */
import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { requireAuth } from "../middleware/auth.js";

export const teamRouter = Router();
teamRouter.use(requireAuth);

/**
 * GET /api/team/reports
 * Direct reports of the current user, with timesheet roll-ups.
 */
teamRouter.get("/reports", async (req, res) => {
  const reports = await prisma.user.findMany({
    where: { managerId: req.user!.id, deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      avatarUrl: true,
      bio: true,
      role: { select: { name: true } },
      timesheets: {
        where: { deletedAt: null },
        select: { id: true, status: true, totalHours: true, workDate: true, approvalDeadline: true, slaBreachAt: true }
      }
    },
    orderBy: { name: "asc" }
  });

  const enriched = reports.map((person) => {
    const total = person.timesheets.length;
    const pending = person.timesheets.filter((t) => t.status === "SUBMITTED").length;
    const approved = person.timesheets.filter((t) => t.status === "APPROVED").length;
    const rejected = person.timesheets.filter((t) => t.status === "REJECTED").length;
    const slaBreached = person.timesheets.filter((t) => t.slaBreachAt).length;
    const approvedHours = person.timesheets
      .filter((t) => t.status === "APPROVED")
      .reduce((sum, t) => sum + Number(t.totalHours ?? 0), 0);
    const { timesheets, ...rest } = person;
    return {
      ...rest,
      role: rest.role.name,
      stats: { total, pending, approved, rejected, slaBreached, approvedHours }
    };
  });

  res.json(enriched);
});

/**
 * GET /api/team/escalations
 * Escalations currently targeted at the calling user.
 */
teamRouter.get("/escalations", async (req, res) => {
  const escalations = await prisma.escalation.findMany({
    where: { escalatedToId: req.user!.id, resolvedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      escalatedFromUser: { select: { id: true, name: true, email: true } },
      timesheet: {
        include: {
          user: { select: { id: true, name: true, email: true, avatarUrl: true } },
          project: { select: { name: true, code: true } }
        }
      }
    },
    take: 100
  });
  res.json(escalations);
});

/**
 * GET /api/team/sla-summary
 * High-level approval SLA snapshot for the manager dashboard.
 */
teamRouter.get("/sla-summary", async (req, res) => {
  const myReportIds = (
    await prisma.user.findMany({
      where: { managerId: req.user!.id, deletedAt: null },
      select: { id: true }
    })
  ).map((u) => u.id);

  if (myReportIds.length === 0) {
    return res.json({ submitted: 0, breached: 0, approvedThisWeek: 0, openEscalations: 0 });
  }

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [submitted, breached, approvedThisWeek, openEscalations] = await Promise.all([
    prisma.timesheet.count({ where: { userId: { in: myReportIds }, status: "SUBMITTED", deletedAt: null } }),
    prisma.timesheet.count({ where: { userId: { in: myReportIds }, slaBreachAt: { not: null }, deletedAt: null } }),
    prisma.timesheet.count({
      where: { userId: { in: myReportIds }, status: "APPROVED", reviewedAt: { gte: weekAgo }, deletedAt: null }
    }),
    prisma.escalation.count({ where: { escalatedToId: req.user!.id, resolvedAt: null } })
  ]);

  res.json({ submitted, breached, approvedThisWeek, openEscalations });
});
