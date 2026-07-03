import { Router } from "express";
import PDFDocument from "pdfkit";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { htmlToText } from "../utils/sanitize.js";

export const reportRouter = Router();
reportRouter.use(requireAuth);

function todayUtcDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

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
 * Personal daily status: hours logged today + whether a reminder/escalation
 * has been raised against the calling user. Used by the dashboard hero card.
 */
reportRouter.get("/daily-status", async (req, res) => {
  const today = todayUtcDate();
  const sinceLocal = startOfLocalDay();
  const [aggregate, reminded, escalated] = await Promise.all([
    prisma.timesheet.aggregate({
      where: { userId: req.user!.id, workDate: today, deletedAt: null },
      _sum: { totalHours: true },
      _count: true
    }),
    prisma.notification.count({
      where: { userId: req.user!.id, category: "reminder.daily", createdAt: { gte: sinceLocal } }
    }),
    prisma.notification.count({
      where: { userId: req.user!.id, category: "reminder.escalation", createdAt: { gte: sinceLocal } }
    })
  ]);
  res.json({
    date: today.toISOString().slice(0, 10),
    entries: aggregate._count,
    hours: Number(aggregate._sum.totalHours ?? 0),
    reminderReceived: reminded > 0,
    escalated: escalated > 0
  });
});

reportRouter.get("/admin-summary", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const today = todayUtcDate();
  const sinceLocal = startOfLocalDay();

  const [
    users,
    activeWorkforce,
    projects,
    approved,
    pending,
    slaBreached,
    openEscalations,
    approvedThisWeek,
    loggedTodayDistinct,
    todayDailyRemindersSent,
    todayEscalationsSent,
    byProject,
    byStatus,
    byActivity
  ] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({
      where: { deletedAt: null, status: "ACTIVE", role: { name: { in: ["EMPLOYEE", "TEAM_LEAD"] } } }
    }),
    prisma.project.count({ where: { deletedAt: null } }),
    prisma.timesheet.aggregate({ where: { status: "APPROVED", deletedAt: null }, _sum: { totalHours: true } }),
    prisma.timesheet.count({ where: { status: "SUBMITTED", deletedAt: null } }),
    prisma.timesheet.count({ where: { slaBreachAt: { not: null }, deletedAt: null } }),
    prisma.escalation.count({ where: { resolvedAt: null } }),
    prisma.timesheet.count({ where: { status: "APPROVED", reviewedAt: { gte: weekAgo }, deletedAt: null } }),
    prisma.timesheet.findMany({
      where: { workDate: today, deletedAt: null },
      select: { userId: true },
      distinct: ["userId"]
    }),
    prisma.notification.count({
      where: { category: "reminder.daily", createdAt: { gte: sinceLocal } }
    }),
    prisma.notification.count({
      where: { category: "reminder.escalation", createdAt: { gte: sinceLocal } }
    }),
    prisma.timesheet.groupBy({ by: ["projectId"], where: { deletedAt: null }, _sum: { totalHours: true }, _count: true }),
    prisma.timesheet.groupBy({ by: ["status"], where: { deletedAt: null }, _sum: { totalHours: true }, _count: true }),
    prisma.timesheet.groupBy({ by: ["activityType"], where: { deletedAt: null }, _sum: { totalHours: true }, _count: true })
  ]);

  const projectNames = await prisma.project.findMany({
    where: { id: { in: byProject.map((row) => row.projectId) } },
    select: { id: true, name: true }
  });

  const loggedToday = loggedTodayDistinct.length;
  const notLoggedToday = Math.max(0, activeWorkforce - loggedToday);

  res.json({
    users,
    projects,
    approvedHours: approved._sum.totalHours ?? 0,
    pendingApprovals: pending,
    slaBreached,
    openEscalations,
    approvedThisWeek,
    activeWorkforce,
    loggedToday,
    notLoggedToday,
    todayDailyRemindersSent,
    todayEscalationsSent,
    byProject: byProject.map((row) => ({ ...row, project: projectNames.find((p) => p.id === row.projectId)?.name ?? "Unknown" })),
    byStatus,
    byActivity
  });
});

reportRouter.get("/export.csv", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const rows = await prisma.timesheet.findMany({
    where: { deletedAt: null },
    include: { user: true, project: true, module: true, submodule: true },
    orderBy: [{ workDate: "desc" }, { startTime: "asc" }]
  });
  const header = ["User", "Email", "Date", "Project", "Module", "Submodule", "Activity", "Start", "End", "Hours", "Status", "Task", "Notes"];
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [
    header.join(","),
    ...rows.map((row) =>
      [
        row.user.name, row.user.email, row.workDate.toISOString().slice(0, 10),
        row.project.name, row.module.name, row.submodule?.name,
        row.activityType, row.startTime, row.endTime,
        Number(row.totalHours).toFixed(2), row.status,
        htmlToText(row.taskDescription), htmlToText(row.notes ?? "")
      ]
        .map(escape)
        .join(",")
    )
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=timesheet-report.csv");
  res.send(lines.join("\n"));
});

reportRouter.get("/export.pdf", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const rows = await prisma.timesheet.findMany({
    where: { deletedAt: null },
    include: { user: { select: { name: true, email: true } }, project: { select: { name: true } } },
    orderBy: [{ workDate: "desc" }, { startTime: "asc" }],
    take: 500
  });

  const totalHours = rows.reduce((sum, row) => sum + Number(row.totalHours ?? 0), 0);
  const approvedHours = rows
    .filter((row) => row.status === "APPROVED")
    .reduce((sum, row) => sum + Number(row.totalHours ?? 0), 0);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="timesheet-report.pdf"');

  const doc = new PDFDocument({ size: "A4", margin: 36 });
  doc.pipe(res);

  doc.fontSize(20).fillColor("#0F9AA8").text("TimeSphere", { continued: false });
  doc.fontSize(10).fillColor("#64748B").text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(0.5);
  doc.fontSize(16).fillColor("#0F172A").text("Timesheet Report");
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#0F172A");
  doc.text(`Entries: ${rows.length}    Total hours: ${totalHours.toFixed(2)}    Approved hours: ${approvedHours.toFixed(2)}`);
  doc.moveDown(0.75);

  const colX = { date: 36, user: 100, project: 215, activity: 320, hours: 410, status: 460 };
  function drawTableHeader() {
    doc.fontSize(9).fillColor("#64748B");
    doc.text("Date", colX.date, doc.y, { continued: true });
    doc.text("  User", colX.user - colX.date - 24, undefined, { continued: true });
    doc.text("  Project", colX.project - colX.user - 50, undefined, { continued: true });
    doc.text("  Activity", colX.activity - colX.project - 50, undefined, { continued: true });
    doc.text("  Hours", colX.hours - colX.activity - 50, undefined, { continued: true });
    doc.text("  Status");
    doc.moveDown(0.3);
    doc.strokeColor("#E2E8F0").lineWidth(0.5).moveTo(36, doc.y).lineTo(560, doc.y).stroke();
    doc.moveDown(0.2);
  }
  drawTableHeader();
  doc.fontSize(9).fillColor("#0F172A");
  const truncate = (input: string, max: number) => (input.length > max ? `${input.slice(0, max - 1)}…` : input);

  for (const row of rows) {
    if (doc.y > 760) { doc.addPage(); drawTableHeader(); }
    const rowY = doc.y;
    doc.text(row.workDate.toISOString().slice(0, 10), colX.date, rowY);
    doc.text(truncate(row.user.name, 16), colX.user, rowY);
    doc.text(truncate(row.project.name, 18), colX.project, rowY);
    doc.text(truncate(row.activityType, 14), colX.activity, rowY);
    doc.text(Number(row.totalHours).toFixed(2), colX.hours, rowY);
    doc.fillColor(
      row.status === "APPROVED" ? "#16A34A" : row.status === "REJECTED" ? "#DC2626" : row.status === "SUBMITTED" ? "#D97706" : "#64748B"
    );
    doc.text(row.status, colX.status, rowY);
    doc.fillColor("#0F172A");
    const taskPreview = htmlToText(row.taskDescription).slice(0, 110);
    if (taskPreview) {
      doc.moveDown(0.2);
      doc.fontSize(8).fillColor("#64748B").text(taskPreview, colX.date, doc.y, { width: 524 });
      doc.fontSize(9).fillColor("#0F172A");
    }
    doc.moveDown(0.35);
    doc.strokeColor("#F1F5F9").lineWidth(0.4).moveTo(36, doc.y).lineTo(560, doc.y).stroke();
    doc.moveDown(0.15);
  }
  if (rows.length === 0) {
    doc.moveDown(2);
    doc.fontSize(11).fillColor("#64748B").text("No timesheet entries to export.", { align: "center" });
  }
  doc.moveDown(2);
  doc.fontSize(8).fillColor("#94A3B8").text("Confidential — for internal operational review.", { align: "center" });
  doc.end();
});
