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
  const projects = await prisma.project.findMany({
    where: {
      deletedAt: null,
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
      submissionDeadlineDayOfMonth: z.coerce.number().int().min(1).max(28).nullable().optional()
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
