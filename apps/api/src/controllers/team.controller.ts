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
import { CHAT_INTAKE_SYSTEM_EMAIL } from "../services/chat-intake.service.js";
import { EMAIL_INTAKE_SYSTEM_EMAIL } from "../services/email-intake.service.js";
import { SECURITY_INGESTION_SYSTEM_EMAIL } from "../services/security-report.service.js";

/** Unusable-password reporter-of-record accounts (see each constant's own file) — never real
 *  people, so they'd otherwise show up as noise root nodes in the org chart below. */
const SYSTEM_ACCOUNT_EMAILS = new Set([CHAT_INTAKE_SYSTEM_EMAIL, EMAIL_INTAKE_SYSTEM_EMAIL, SECURITY_INGESTION_SYSTEM_EMAIL]);

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
    return res.json({
      submitted: 0,
      submittedYesterday: 0,
      breached: 0,
      breachedYesterday: 0,
      approvedThisWeek: 0,
      approvedLastWeek: 0,
      openEscalations: 0,
      openEscalationsYesterday: 0
    });
  }

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [submitted, submittedYesterday, breached, breachedYesterday, approvedThisWeek, approvedLastWeek, openEscalations, openEscalationsYesterday] =
    await Promise.all([
      prisma.timesheet.count({ where: { userId: { in: myReportIds }, status: "SUBMITTED", deletedAt: null } }),
      prisma.timesheet.count({
        where: { userId: { in: myReportIds }, status: "SUBMITTED", deletedAt: null, createdAt: { lt: today } }
      }),
      prisma.timesheet.count({ where: { userId: { in: myReportIds }, slaBreachAt: { not: null }, deletedAt: null } }),
      prisma.timesheet.count({
        where: { userId: { in: myReportIds }, deletedAt: null, slaBreachAt: { not: null, lt: today } }
      }),
      prisma.timesheet.count({
        where: { userId: { in: myReportIds }, status: "APPROVED", reviewedAt: { gte: weekAgo }, deletedAt: null }
      }),
      prisma.timesheet.count({
        where: {
          userId: { in: myReportIds },
          status: "APPROVED",
          reviewedAt: { gte: twoWeeksAgo, lt: weekAgo },
          deletedAt: null
        }
      }),
      prisma.escalation.count({ where: { escalatedToId: req.user!.id, resolvedAt: null } }),
      prisma.escalation.count({ where: { escalatedToId: req.user!.id, resolvedAt: null, createdAt: { lt: today } } })
    ]);

  res.json({
    submitted,
    submittedYesterday,
    breached,
    breachedYesterday,
    approvedThisWeek,
    approvedLastWeek,
    openEscalations,
    openEscalationsYesterday
  });
});

/**
 * GET /api/team/org-chart
 * Reporting-line tree built from the existing User.managerId self-relation — no new schema,
 * just a new read over data that already exists (see docs/ROADMAP.md's "TL/Manager mapping —
 * new surfaces on existing data"). Privileged roles (SUPER_ADMIN/ADMIN) see the whole company
 * tree (every user with no manager, and their descendants); everyone else sees only their own
 * subtree (themselves + direct + indirect reports) — the same privileged-vs-scoped split
 * `ticketProjectScope` already uses elsewhere, just applied to the manager chain instead of
 * project assignments.
 */
interface OrgChartUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  designation: string | null;
  managerId: string | null;
  role: { name: string };
}

teamRouter.get("/org-chart", async (req, res) => {
  const allUsers: OrgChartUser[] = await prisma.user.findMany({
    where: { deletedAt: null, status: "ACTIVE" },
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      designation: true,
      managerId: true,
      role: { select: { name: true } }
    },
    orderBy: { name: "asc" }
  });
  const users = allUsers.filter((u) => !SYSTEM_ACCOUNT_EMAILS.has(u.email));

  const byManager = new Map<string | null, OrgChartUser[]>();
  for (const user of users) {
    const key = user.managerId;
    const bucket = byManager.get(key);
    if (bucket) bucket.push(user);
    else byManager.set(key, [user]);
  }

  function buildNode(user: OrgChartUser): unknown {
    const reports = (byManager.get(user.id) ?? []).map(buildNode);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      designation: user.designation,
      role: user.role.name,
      reports
    };
  }

  const privileged = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
  const roots = privileged ? byManager.get(null) ?? [] : users.filter((u) => u.id === req.user!.id);

  res.json(roots.map(buildNode));
});

/**
 * GET /api/team/timesheet-anomalies
 * Opt-in manager insight — flags unusual hour patterns among direct reports, not an automatic
 * block (same human-review posture low-confidence email/chat triage already uses elsewhere in
 * this app). Two deterministic checks, no AI/LLM call needed since this is threshold arithmetic
 * over data already logged, not a language-understanding task:
 *  - BURNOUT: a direct report logged 55+ hours in any of the last 4 ISO weeks (sustained
 *    overtime signal).
 *  - IMPLAUSIBLE: a direct report logged more than 16 hours on a single day (a plain physical
 *    upper bound — flags likely data-entry errors or padded entries, not an accusation).
 * Thresholds are fixed constants for this first pass, not admin-configurable yet — tune them
 * from real usage before exposing a settings UI for numbers nobody has validated.
 */
const BURNOUT_WEEKLY_HOURS_THRESHOLD = 55;
const IMPLAUSIBLE_DAILY_HOURS_THRESHOLD = 16;

function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - day); // Monday of that week
  return d.toISOString().slice(0, 10);
}

teamRouter.get("/timesheet-anomalies", async (req, res) => {
  const myReportIds = (
    await prisma.user.findMany({
      where: { managerId: req.user!.id, deletedAt: null },
      select: { id: true }
    })
  ).map((u) => u.id);

  if (myReportIds.length === 0) return res.json({ burnout: [], implausible: [] });

  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  const entries = await prisma.timesheet.findMany({
    where: { userId: { in: myReportIds }, deletedAt: null, workDate: { gte: fourWeeksAgo } },
    select: { userId: true, workDate: true, totalHours: true, user: { select: { name: true } } }
  });

  const weeklyByUser = new Map<string, Map<string, number>>();
  const dailyByUser = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    const hours = Number(entry.totalHours);
    const weekKey = isoWeekKey(entry.workDate);
    const dayKey = entry.workDate.toISOString().slice(0, 10);

    const weekMap = weeklyByUser.get(entry.userId) ?? new Map<string, number>();
    weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + hours);
    weeklyByUser.set(entry.userId, weekMap);

    const dayMap = dailyByUser.get(entry.userId) ?? new Map<string, number>();
    dayMap.set(dayKey, (dayMap.get(dayKey) ?? 0) + hours);
    dailyByUser.set(entry.userId, dayMap);
  }

  const namesById = new Map(entries.map((e) => [e.userId, e.user.name]));

  const burnout: Array<{ userId: string; name: string; weekStart: string; hours: number }> = [];
  for (const [userId, weekMap] of weeklyByUser) {
    for (const [weekStart, hours] of weekMap) {
      if (hours >= BURNOUT_WEEKLY_HOURS_THRESHOLD) {
        burnout.push({ userId, name: namesById.get(userId) ?? "Unknown", weekStart, hours: Number(hours.toFixed(1)) });
      }
    }
  }

  const implausible: Array<{ userId: string; name: string; date: string; hours: number }> = [];
  for (const [userId, dayMap] of dailyByUser) {
    for (const [date, hours] of dayMap) {
      if (hours > IMPLAUSIBLE_DAILY_HOURS_THRESHOLD) {
        implausible.push({ userId, name: namesById.get(userId) ?? "Unknown", date, hours: Number(hours.toFixed(1)) });
      }
    }
  }

  burnout.sort((a, b) => b.hours - a.hours);
  implausible.sort((a, b) => b.hours - a.hours);

  res.json({ burnout, implausible });
});
