/**
 * WHAT: blueprints — saving a reusable project structure, previewing what it would create, and
 * stamping it out against a chosen start date.
 *
 * WHY PREVIEW IS ITS OWN ENDPOINT: instantiating a 40-item blueprint is not something anyone
 * should discover the shape of by doing it. `POST /preview` runs the same pure expander the real
 * instantiation runs and writes nothing, so the confirmation screen shows exactly the dates that
 * will be created rather than an approximation of them.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { deriveBlueprint, expandBlueprint, validateBlueprint, type BlueprintPayload } from "../services/blueprint.service.js";
import { setCustomFieldValues } from "../services/custom-field.service.js";
import { getPlanningQuota } from "../services/plan-limits.service.js";
import { assertPlanningEnabled } from "../services/planning.service.js";
import { computeTicketDueDate, getGlobalTicketSettings, issueTicketKey } from "../services/ticket.service.js";
import { readWorkingDays, toDay } from "../services/plan-schedule.service.js";

export const blueprintRouter = Router();
blueprintRouter.use(requireAuth);

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const itemSchema: z.ZodType<any> = z.object({
  title: z.string().min(1).max(255),
  type: z.string().max(60).optional(),
  description: z.string().max(20_000).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  offsetStartDays: z.number().int().min(0).max(3650).optional(),
  durationDays: z.number().int().min(1).max(3650).optional(),
  isMilestone: z.boolean().optional(),
  estimatedHours: z.number().min(0).max(100_000).optional(),
  parentIndex: z.number().int().min(0).optional(),
  dependsOn: z.array(z.number().int().min(0)).max(50).optional(),
  customFields: z.record(z.unknown()).optional(),
  moduleName: z.string().max(120).optional()
});

const payloadSchema = z.object({
  modules: z.array(z.string().min(1).max(120)).max(50).optional(),
  items: z.array(itemSchema).min(1).max(300),
  approvalChain: z
    .array(z.object({ approverEmail: z.string().email().optional(), guestEmail: z.string().email().optional(), order: z.number().int().min(0) }))
    .max(20)
    .optional()
});

const bodySchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).nullish(),
  kind: z.enum(["PROJECT", "WORK_ITEM"]).optional(),
  isActive: z.boolean().optional(),
  payload: payloadSchema
});

blueprintRouter.get("/", requirePermission(permissions.TICKETS_VIEW), async (_req, res) => {
  const blueprints = await prisma.blueprint.findMany({
    include: { createdBy: { select: { id: true, name: true } } },
    orderBy: { name: "asc" }
  });
  res.json(
    blueprints.map((b) => ({
      ...b,
      // The list only needs a count; shipping every payload makes an admin list heavy for no gain.
      itemCount: Array.isArray((b.payload as any)?.items) ? (b.payload as any).items.length : 0
    }))
  );
});

blueprintRouter.get(
  "/:id",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    const blueprint = await prisma.blueprint.findUnique({ where: { id: String(req.params.id) } });
    if (!blueprint) throw new AppError(404, "Blueprint not found");
    res.json(blueprint);
  }
);

blueprintRouter.post(
  "/",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ body: bodySchema })),
  async (req, res) => {
    await assertPlanningEnabled();
    validateBlueprint(req.body.payload as BlueprintPayload);

    const quota = await getPlanningQuota(requireTenantContext().orgId, "maxBlueprints");
    const used = await prisma.blueprint.count({ where: { isActive: true } });
    if (used >= quota) {
      throw new AppError(
        403,
        quota === 0 ? "Blueprints are not included in this plan." : `This plan allows ${quota} blueprint(s) and ${used} exist.`
      );
    }

    const created = await prisma.blueprint.create({
      data: {
        name: req.body.name,
        description: req.body.description ?? null,
        kind: req.body.kind ?? "PROJECT",
        isActive: req.body.isActive ?? true,
        payload: req.body.payload,
        createdById: req.user!.id
      }
    });
    await audit(req.user!.id, "blueprint.created", "Blueprint", created.id, { name: created.name });
    res.status(201).json(created);
  }
);

blueprintRouter.put(
  "/:id",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: bodySchema })),
  async (req, res) => {
    await assertPlanningEnabled();
    validateBlueprint(req.body.payload as BlueprintPayload);
    const updated = await prisma.blueprint.update({
      where: { id: String(req.params.id) },
      data: {
        name: req.body.name,
        description: req.body.description ?? null,
        kind: req.body.kind ?? "PROJECT",
        isActive: req.body.isActive ?? true,
        payload: req.body.payload
      }
    });
    await audit(req.user!.id, "blueprint.updated", "Blueprint", updated.id);
    res.json(updated);
  }
);

blueprintRouter.delete(
  "/:id",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    // A blueprint attached to a live request form would silently stop working if deleted, so the
    // form is detached explicitly rather than left pointing at nothing.
    await prisma.$transaction([
      prisma.requestForm.updateMany({ where: { blueprintId: String(req.params.id) }, data: { blueprintId: null } }),
      prisma.blueprint.delete({ where: { id: String(req.params.id) } })
    ]);
    await audit(req.user!.id, "blueprint.deleted", "Blueprint", String(req.params.id));
    res.status(204).end();
  }
);

/** What instantiating would create, computed by the same expander, writing nothing. */
blueprintRouter.post(
  "/:id/preview",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ params: z.object({ id: z.string().uuid() }), body: z.object({ startDate: DATE }).strict() })),
  async (req, res) => {
    const blueprint = await prisma.blueprint.findUnique({ where: { id: String(req.params.id) } });
    if (!blueprint) throw new AppError(404, "Blueprint not found");
    const workingDays = await readWorkingDays();
    res.json(expandBlueprint(blueprint.payload as unknown as BlueprintPayload, req.body.startDate, workingDays));
  }
);

/**
 * Stamp a blueprint onto a project.
 *
 * Everything happens in ONE transaction. A half-instantiated 40-item structure — parents without
 * children, dependencies pointing at rows that were never created — is far worse than a clean
 * failure, because there is no obvious way to tell what is missing or to safely retry.
 */
blueprintRouter.post(
  "/:id/instantiate",
  requirePermission(permissions.PLAN_WRITE),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ projectId: z.string().uuid(), startDate: DATE, titlePrefix: z.string().max(60).optional() }).strict()
    })
  ),
  async (req, res) => {
    await assertPlanningEnabled();
    const blueprint = await prisma.blueprint.findUnique({ where: { id: String(req.params.id) } });
    if (!blueprint) throw new AppError(404, "Blueprint not found");

    const project = await prisma.project.findFirst({ where: { id: req.body.projectId, deletedAt: null }, select: { id: true } });
    if (!project) throw new AppError(404, "Project not found");

    const workingDays = await readWorkingDays();
    const expanded = expandBlueprint(blueprint.payload as unknown as BlueprintPayload, req.body.startDate, workingDays);
    const settings = await getGlobalTicketSettings();
    const now = new Date();

    const created = await prisma.$transaction(async (tx) => {
      // Modules first — an item naming a module that doesn't exist yet would otherwise fail
      // partway through and take the whole structure with it.
      const moduleIds = new Map<string, string>();
      for (const name of expanded.modules) {
        const mod = await tx.projectModule.upsert({
          where: { projectId_name: { projectId: project.id, name } },
          update: {},
          create: { projectId: project.id, name }
        });
        moduleIds.set(name, mod.id);
      }

      const idByIndex = new Map<number, string>();
      const rows: Array<{ id: string; key: string; title: string }> = [];

      for (const item of expanded.items) {
        const key = await issueTicketKey(tx, project.id);
        const priority = item.priority ?? "MEDIUM";
        const ticket = await tx.ticket.create({
          data: {
            key,
            projectId: project.id,
            moduleId: item.moduleName ? moduleIds.get(item.moduleName) ?? null : null,
            type: item.type ?? "TASK",
            title: req.body.titlePrefix ? `${req.body.titlePrefix} ${item.title}`.slice(0, 255) : item.title,
            description: item.description ?? null,
            priority,
            reporterId: req.user!.id,
            dueAt: computeTicketDueDate(now, priority as any, settings),
            startDate: item.startDate ? toDay(item.startDate) : null,
            endDate: item.endDate ? toDay(item.endDate) : null,
            isMilestone: Boolean(item.isMilestone),
            estimatedHours: item.estimatedHours ?? null,
            sortOrder: item.index,
            parentId: item.parentIndex !== undefined ? idByIndex.get(item.parentIndex) ?? null : null
          }
        });
        idByIndex.set(item.index, ticket.id);
        rows.push({ id: ticket.id, key: ticket.key, title: ticket.title });
      }

      // Dependencies second, once every row has an id. Blueprint indexes only ever point
      // backwards (enforced by validateBlueprint), so every target already exists here.
      for (const item of expanded.items) {
        for (const dep of item.dependsOn ?? []) {
          const fromId = idByIndex.get(dep);
          const toId = idByIndex.get(item.index);
          if (!fromId || !toId) continue;
          await tx.ticketLink.create({ data: { sourceTicketId: fromId, targetTicketId: toId, type: "FINISH_TO_START", lagDays: 0 } });
        }
      }

      return rows;
    });

    // Custom fields after the transaction, for the same reason the public intake path does it: a
    // mapped field that no longer exists must not throw away 40 successfully-created work items.
    for (const item of expanded.items) {
      if (!item.customFields || Object.keys(item.customFields).length === 0) continue;
      const ticketId = created[item.index]?.id;
      if (!ticketId) continue;
      try {
        await setCustomFieldValues({ ticketId }, item.customFields, { ticketType: item.type ?? "TASK" });
      } catch {
        /* recoverable by a human; the structure itself is intact */
      }
    }

    await audit(req.user!.id, "blueprint.instantiated", "Blueprint", blueprint.id, {
      projectId: project.id,
      count: created.length,
      startDate: req.body.startDate
    });
    res.status(201).json({ count: created.length, items: created });
  }
);

/** Learn a blueprint from a project that already ran. */
blueprintRouter.post(
  "/derive",
  requirePermission(permissions.PLAN_WRITE),
  validate(z.object({ body: z.object({ projectId: z.string().uuid(), name: z.string().min(1).max(160) }).strict() })),
  async (req, res) => {
    await assertPlanningEnabled();
    const tickets = await prisma.ticket.findMany({
      where: { projectId: req.body.projectId, deletedAt: null },
      select: {
        id: true, title: true, type: true, priority: true, parentId: true,
        startDate: true, endDate: true, isMilestone: true, estimatedHours: true,
        module: { select: { name: true } }
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      take: 300
    });
    if (tickets.length === 0) throw new AppError(400, "That project has no work items to learn from.");

    const ids = tickets.map((t) => t.id);
    const links = await prisma.ticketLink.findMany({
      where: { sourceTicketId: { in: ids }, targetTicketId: { in: ids }, type: { in: ["BLOCKS", "FINISH_TO_START"] } },
      select: { sourceTicketId: true, targetTicketId: true }
    });

    const workingDays = await readWorkingDays();
    const payload = deriveBlueprint(
      tickets.map((t) => ({
        id: t.id,
        title: t.title,
        type: t.type,
        priority: t.priority,
        parentId: t.parentId,
        startDate: t.startDate,
        endDate: t.endDate,
        isMilestone: t.isMilestone,
        estimatedHours: t.estimatedHours ? Number(t.estimatedHours) : null,
        moduleName: t.module?.name ?? null
      })),
      links.map((l) => ({ fromId: l.sourceTicketId, toId: l.targetTicketId })),
      workingDays
    );

    const created = await prisma.blueprint.create({
      data: { name: req.body.name, kind: "PROJECT", payload: payload as any, createdById: req.user!.id }
    });
    await audit(req.user!.id, "blueprint.derived", "Blueprint", created.id, { projectId: req.body.projectId, items: payload.items.length });
    res.status(201).json(created);
  }
);
