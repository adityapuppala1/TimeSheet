/**
 * WHAT: project/module/submodule CRUD, plus who-can-see-what and who-can-assign-whom for
 * project member assignments.
 * WHY: projects are the top-level scoping unit for both timesheets and tickets, and visibility
 * needs to follow the reporting chain (a manager sees their own + their direct reports'
 * projects) rather than being all-or-nothing — `visibilityScope`/`canModifyAssignment` are the
 * two functions that encode those rules once, reused by every route below instead of each
 * route re-deriving them.
 * WHO calls this: `apps/web/src/pages/AdminPages.tsx` (ProjectsPage), plus every other page's
 * project/module dropdowns via `projectApi.list()`.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";

const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

export const projectRouter = Router();
projectRouter.use(requireAuth);

/**
 * Return the user IDs whose project assignments determine visibility.
 *
 *  - SUPER_ADMIN / ADMIN: no filter (sees all projects)
 *  - MANAGER / TEAM_LEAD: own assignments + direct reports'
 *  - EMPLOYEE: own assignments only
 */
async function visibilityScope(req: any): Promise<{ unrestricted: boolean; userIds: string[] }> {
  const role = req.user.role;
  if (PRIVILEGED_ROLES.has(role)) return { unrestricted: true, userIds: [] };
  const ids = [req.user.id];
  if (role === "MANAGER" || role === "TEAM_LEAD") {
    const reports = await prisma.user.findMany({
      where: { managerId: req.user.id, deletedAt: null },
      select: { id: true }
    });
    ids.push(...reports.map((r) => r.id));
  }
  return { unrestricted: false, userIds: ids };
}

projectRouter.get("/", async (req, res) => {
  const scope = await visibilityScope(req);
  // Archived projects are DISABLED, not gone: excluded from every picker and filter by
  // default (nobody logs time against a switched-off project), included only where managing
  // them is the point — the admin page asks with ?includeArchived=1 and shows the badge.
  const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";
  const projects = await prisma.project.findMany({
    where: {
      deletedAt: null,
      ...(includeArchived ? {} : { status: "ACTIVE" }),
      ...(scope.unrestricted ? {} : { assignments: { some: { userId: { in: scope.userIds } } } })
    },
    include: {
      modules: { include: { submodules: true } },
      assignments: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true, role: { select: { name: true } } } } } }
    },
    orderBy: { name: "asc" }
  });
  res.json(projects);
});

projectRouter.post(
  "/",
  requirePermission(permissions.PROJECTS_MANAGE),
  validate(
    z.object({
      body: z.object({
        code: z.string().min(2).max(64),
        name: z.string().min(2).max(160),
        description: z.string().max(500).optional(),
        slaApprovalHours: z.coerce.number().int().min(1).max(720).optional(),
        submissionDeadlineDayOfMonth: z.coerce.number().int().min(1).max(28).optional().nullable()
      })
    })
  ),
  async (req, res) => {
    // Explicit duplicate check instead of letting the unique index throw — same reasoning as
    // user creation's: the constraint error can't say WHICH project holds the code or that an
    // archived one (invisible in most pickers) is the collision. This message can.
    const existing = await prisma.project.findUnique({
      where: { code: req.body.code },
      select: { name: true, status: true }
    });
    if (existing) {
      throw new AppError(
        409,
        `Project code "${req.body.code}" is already used by "${existing.name}"${
          existing.status === "ARCHIVED" ? " (archived — reactivate it instead, or pick a new code)" : ""
        }. Codes must be unique.`
      );
    }

    const project = await prisma.project.create({
      data: {
        code: req.body.code,
        name: req.body.name,
        description: req.body.description,
        slaApprovalHours: req.body.slaApprovalHours ?? undefined,
        submissionDeadlineDayOfMonth: req.body.submissionDeadlineDayOfMonth ?? undefined
      }
    });
    await audit(req.user!.id, "project.created", "Project", project.id);
    res.status(201).json(project);
  }
);

const patchProjectSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      code: z.string().min(2).max(64).optional(),
      name: z.string().min(2).max(160).optional(),
      description: z.string().max(500).optional().nullable(),
      status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
      slaApprovalHours: z.coerce.number().int().min(1).max(720).optional(),
      submissionDeadlineDayOfMonth: z.coerce.number().int().min(1).max(28).nullable().optional(),
      // Client billing — see services/billing-rate.service.ts. NOTE: this schema is `.strict()`,
      // so any new Project field MUST be listed here or the edit form 400s on save.
      clientName: z.string().max(160).nullable().optional(),
      defaultHourlyRate: z.coerce.number().min(0).max(100000).nullable().optional(),
      billingCurrency: z.string().length(3).nullable().optional(),
      // Planning layer (V6). Same `.strict()` warning as above applies to these too.
      portfolioId: z.string().uuid().nullable().optional(),
      budgetAmount: z.coerce.number().min(0).max(1_000_000_000).nullable().optional(),
      budgetCurrency: z.string().length(3).nullable().optional(),
      budgetAlertPct: z.coerce.number().int().min(1).max(100).nullable().optional(),
      plannedStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      plannedEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
    })
    .strict()
});

projectRouter.patch(
  "/:id",
  requirePermission(permissions.PROJECTS_MANAGE),
  validate(patchProjectSchema),
  async (req, res) => {
    const data: any = {};
    if (typeof req.body.code === "string") data.code = req.body.code;
    if (typeof req.body.name === "string") data.name = req.body.name;
    if ("description" in req.body) data.description = req.body.description;
    if (typeof req.body.status === "string") data.status = req.body.status;
    if (typeof req.body.slaApprovalHours === "number") data.slaApprovalHours = req.body.slaApprovalHours;
    if ("submissionDeadlineDayOfMonth" in req.body) data.submissionDeadlineDayOfMonth = req.body.submissionDeadlineDayOfMonth;
    if ("clientName" in req.body) data.clientName = req.body.clientName || null;
    if ("defaultHourlyRate" in req.body) data.defaultHourlyRate = req.body.defaultHourlyRate ?? null;
    // Normalised to uppercase so "usd" and "USD" don't read as two different currencies when the
    // attestation refuses to mix them.
    if ("billingCurrency" in req.body) data.billingCurrency = req.body.billingCurrency ? String(req.body.billingCurrency).toUpperCase() : null;

    // Planning layer. Dates are stored as UTC-midnight calendar days for the same reason every
    // other planning date is — a time-of-day makes the same value render as two different days
    // either side of a timezone boundary.
    if ("portfolioId" in req.body) data.portfolioId = req.body.portfolioId || null;
    if ("budgetAmount" in req.body) data.budgetAmount = req.body.budgetAmount ?? null;
    if ("budgetCurrency" in req.body) data.budgetCurrency = req.body.budgetCurrency ? String(req.body.budgetCurrency).toUpperCase() : null;
    if ("budgetAlertPct" in req.body) data.budgetAlertPct = req.body.budgetAlertPct ?? null;
    if ("plannedStartDate" in req.body) {
      data.plannedStartDate = req.body.plannedStartDate ? new Date(`${req.body.plannedStartDate}T00:00:00.000Z`) : null;
    }
    if ("plannedEndDate" in req.body) {
      data.plannedEndDate = req.body.plannedEndDate ? new Date(`${req.body.plannedEndDate}T00:00:00.000Z`) : null;
    }
    if (data.plannedStartDate && data.plannedEndDate && data.plannedEndDate < data.plannedStartDate) {
      throw new AppError(422, "The planned end date can't be before the planned start date.");
    }

    const project = await prisma.project.update({ where: { id: String(req.params.id) }, data });
    await audit(req.user!.id, "project.updated", "Project", project.id, data);
    res.json(project);
  }
);

projectRouter.delete("/:id", requirePermission(permissions.PROJECTS_MANAGE), async (req, res) => {
  await prisma.project.update({ where: { id: String(req.params.id) }, data: { deletedAt: new Date(), status: "ARCHIVED" } });
  await audit(req.user!.id, "project.archived", "Project", String(req.params.id));
  res.status(204).send();
});

projectRouter.post("/:id/modules", requirePermission(permissions.PROJECTS_MANAGE), async (req, res) => {
  const created = await prisma.projectModule.create({ data: { projectId: String(req.params.id), name: req.body.name } });
  await audit(req.user!.id, "project_module.created", "ProjectModule", created.id);
  res.status(201).json(created);
});

projectRouter.post("/modules/:id/submodules", requirePermission(permissions.PROJECTS_MANAGE), async (req, res) => {
  const created = await prisma.projectSubmodule.create({ data: { moduleId: String(req.params.id), name: req.body.name } });
  await audit(req.user!.id, "project_submodule.created", "ProjectSubmodule", created.id);
  res.status(201).json(created);
});

/**
 * Renames. Modules and submodules had create-only routes, so a typo made at creation was
 * permanent in every timesheet picker until someone edited the database by hand. Renaming is
 * safe by construction: timesheets reference modules by id, so history follows the new name
 * automatically instead of orphaning. Duplicate names within the same parent hit the unique
 * index and come back as the middleware's 409, already human.
 */
const renameSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ name: z.string().min(1).max(160) }).strict()
});

projectRouter.patch("/modules/:id", requirePermission(permissions.PROJECTS_MANAGE), validate(renameSchema), async (req, res) => {
  const updated = await prisma.projectModule.update({
    where: { id: String(req.params.id) },
    data: { name: req.body.name.trim() }
  });
  await audit(req.user!.id, "project_module.renamed", "ProjectModule", updated.id, { name: updated.name });
  res.json(updated);
});

projectRouter.patch("/submodules/:id", requirePermission(permissions.PROJECTS_MANAGE), validate(renameSchema), async (req, res) => {
  const updated = await prisma.projectSubmodule.update({
    where: { id: String(req.params.id) },
    data: { name: req.body.name.trim() }
  });
  await audit(req.user!.id, "project_submodule.renamed", "ProjectSubmodule", updated.id, { name: updated.name });
  res.json(updated);
});

const bulkProjectRowSchema = z.object({
  projectCode: z.string().min(1).max(64),
  projectName: z.string().min(1).max(160),
  moduleName: z.string().max(160).optional().or(z.literal("")),
  submoduleName: z.string().max(160).optional().or(z.literal(""))
});

const bulkProjectsSchema = z.object({
  body: z.object({ rows: z.array(bulkProjectRowSchema).min(1).max(1000) })
});

/**
 * Bulk project/module/submodule import — one CSV row per (project, module, submodule)
 * combination, same "repeat the parent columns on every child row" shape a spreadsheet-literate
 * admin already expects from Excel-style hierarchical data entry (see the sample sheet's own
 * instructions). Idempotent by design: `Project.code`/`(projectId,name)`/`(moduleId,name)` are
 * all unique constraints, so upserting means re-uploading the same file (or a superset of it,
 * e.g. "everything plus 3 new modules") never creates duplicates — safe to re-run.
 */
projectRouter.post("/bulk", requirePermission(permissions.PROJECTS_MANAGE), validate(bulkProjectsSchema), async (req, res) => {
  const rows = req.body.rows as Array<{ projectCode: string; projectName: string; moduleName?: string; submoduleName?: string }>;
  const results: Array<{ row: number; success: boolean; error?: string }> = [];
  const projectIdByCode = new Map<string, string>();
  const moduleIdByKey = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      let projectId = projectIdByCode.get(row.projectCode);
      if (!projectId) {
        const project = await prisma.project.upsert({
          where: { code: row.projectCode },
          update: {},
          create: { code: row.projectCode, name: row.projectName }
        });
        projectId = project.id;
        projectIdByCode.set(row.projectCode, projectId);
      }

      if (row.moduleName) {
        const moduleKey = `${projectId}::${row.moduleName}`;
        let moduleId = moduleIdByKey.get(moduleKey);
        if (!moduleId) {
          const projectModule = await prisma.projectModule.upsert({
            where: { projectId_name: { projectId, name: row.moduleName } },
            update: {},
            create: { projectId, name: row.moduleName }
          });
          moduleId = projectModule.id;
          moduleIdByKey.set(moduleKey, moduleId);
        }

        if (row.submoduleName) {
          await prisma.projectSubmodule.upsert({
            where: { moduleId_name: { moduleId, name: row.submoduleName } },
            update: {},
            create: { moduleId, name: row.submoduleName }
          });
        }
      }

      results.push({ row: i, success: true });
    } catch (error) {
      results.push({ row: i, success: false, error: (error as Error).message });
    }
  }

  await audit(req.user!.id, "project.bulk_imported", "Project", undefined, {
    total: rows.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length
  });

  res.status(201).json({ results });
});

/* ---------- Assignments ---------- */

/**
 * Authorisation for assignments:
 *  - SUPER_ADMIN / ADMIN: can assign anyone to any project
 *  - MANAGER / TEAM_LEAD: can assign themselves and their direct reports, only to projects they already belong to
 */
async function canModifyAssignment(req: any, projectId: string, targetUserId: string): Promise<boolean> {
  if (PRIVILEGED_ROLES.has(req.user.role)) return true;
  if (!["MANAGER", "TEAM_LEAD"].includes(req.user.role)) return false;

  const managerHasProject = await prisma.userProjectAssignment.findFirst({
    where: { projectId, userId: req.user.id }
  });
  if (!managerHasProject) return false;

  if (targetUserId === req.user.id) return true;
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { managerId: true } });
  return target?.managerId === req.user.id;
}

projectRouter.get("/:id/assignments", async (req, res) => {
  const projectId = String(req.params.id);
  const assignments = await prisma.userProjectAssignment.findMany({
    where: { projectId },
    include: {
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true, status: true, role: { select: { name: true } } }
      }
    },
    orderBy: { createdAt: "desc" }
  });
  res.json(assignments);
});

const assignSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ userId: z.string().uuid() })
});

projectRouter.post("/:id/assignments", validate(assignSchema), async (req, res) => {
  const projectId = String(req.params.id);
  const targetUserId = req.body.userId;
  if (!(await canModifyAssignment(req, projectId, targetUserId))) {
    throw new AppError(403, "You can only assign yourself or your direct reports to projects you belong to");
  }
  const created = await prisma.userProjectAssignment.upsert({
    where: { userId_projectId: { userId: targetUserId, projectId } },
    update: {},
    create: { userId: targetUserId, projectId }
  });
  await audit(req.user!.id, "project.user_assigned", "Project", projectId, { userId: targetUserId });
  res.status(201).json(created);
});

projectRouter.delete("/:id/assignments/:userId", async (req, res) => {
  const projectId = String(req.params.id);
  const targetUserId = String(req.params.userId);
  if (!(await canModifyAssignment(req, projectId, targetUserId))) {
    throw new AppError(403, "Not allowed to unassign this user");
  }
  await prisma.userProjectAssignment.deleteMany({ where: { projectId, userId: targetUserId } });
  await audit(req.user!.id, "project.user_unassigned", "Project", projectId, { userId: targetUserId });
  res.status(204).send();
});
