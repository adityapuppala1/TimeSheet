/**
 * WHAT: `/api/sprints` — a project's iterations: list, create, edit, start/complete, delete, and
 * the burndown.
 *
 * TWO GATES ON EVERY ROUTE, IN THIS ORDER. `assertSprintsEnabled` first: the whole surface is
 * behind a default-off workspace toggle that also needs the planning layer, and a 403 that names
 * the switch is the right answer when it is off. Then the project scope: a sprint is visible to
 * exactly the people who can see its project, through the same `ticketProjectScope` /
 * `assertTicketVisible` pair every ticket route uses. Writes need plan:write, as blueprints do.
 *
 * ONE ACTIVE SPRINT PER PROJECT. Starting a second one is a 409 that names the first, because a
 * burndown over two overlapping iterations is two charts drawn on one axis.
 *
 * DELETING UN-PLANS, NEVER DELETES: `Ticket.sprintId` is SET NULL by the foreign key.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { assertSprintsEnabled } from "../services/planning.service.js";
import { assertSprintTransition, burndown, sprintDays, SPRINT_STATUSES, type BurndownTicket } from "../services/sprint.service.js";
import { assertTicketVisible, ticketProjectScope } from "../services/ticket.service.js";

export const sprintRouter = Router();
sprintRouter.use(requireAuth);
sprintRouter.use(async (_req, _res, next) => {
  try {
    await assertSprintsEnabled();
    next();
  } catch (err) {
    next(err);
  }
});

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

function assertDateOrder(start: string, end: string) {
  if (end < start) throw new AppError(422, "A sprint cannot end before it starts.");
}

async function loadSprint(id: string) {
  const sprint = await prisma.sprint.findUnique({ where: { id } });
  if (!sprint) throw new AppError(404, "Sprint not found");
  return sprint;
}

const SPRINT_SELECT = {
  id: true,
  projectId: true,
  name: true,
  goal: true,
  startDate: true,
  endDate: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { tickets: true } }
} as const;

sprintRouter.get(
  "/",
  requirePermission(permissions.TICKETS_VIEW),
  validate(z.object({ query: z.object({ projectId: z.string().uuid() }).passthrough() })),
  async (req, res) => {
    const projectId = String(req.query.projectId);
    await assertTicketVisible(req, projectId);
    const sprints = await prisma.sprint.findMany({ where: { projectId }, select: SPRINT_SELECT, orderBy: { startDate: "desc" } });
    // Points per sprint in one grouped query rather than one per row.
    const points = await prisma.ticket.groupBy({
      by: ["sprintId"],
      where: { sprintId: { in: sprints.map((s) => s.id) }, deletedAt: null },
      _sum: { storyPoints: true }
    });
    const pointsBy = new Map(points.map((p) => [p.sprintId, Number(p._sum.storyPoints ?? 0)]));
    res.json(sprints.map((s) => ({ ...s, ticketCount: s._count.tickets, totalPoints: pointsBy.get(s.id) ?? 0, _count: undefined })));
  }
);

const createSchema = z.object({
  body: z
    .object({
      projectId: z.string().uuid(),
      name: z.string().min(1).max(120),
      goal: z.string().max(600).nullish(),
      startDate: DATE,
      endDate: DATE
    })
    .strict()
});

sprintRouter.post("/", requirePermission(permissions.PLAN_WRITE), validate(createSchema), async (req, res) => {
  const { projectId, name, goal, startDate, endDate } = req.body as z.infer<typeof createSchema>["body"];
  await assertTicketVisible(req, projectId);
  assertDateOrder(startDate, endDate);
  const sprint = await prisma.sprint.create({
    data: { projectId, name, goal: goal ?? null, startDate: new Date(startDate), endDate: new Date(endDate), createdById: req.user!.id }
  });
  await audit(req.user!.id, "sprint.created", "Sprint", sprint.id, { projectId, name });
  res.status(201).json(sprint);
});

const patchSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      name: z.string().min(1).max(120).optional(),
      goal: z.string().max(600).nullish(),
      startDate: DATE.optional(),
      endDate: DATE.optional(),
      status: z.enum(SPRINT_STATUSES).optional(),
      /// Where a COMPLETED sprint's unfinished tickets go: another planned/active sprint of the same
      /// project, or "backlog" (the default). Ignored for every other change.
      carryOverTo: z.union([z.literal("backlog"), z.string().uuid()]).optional()
    })
    .strict()
});

/**
 * Completing a sprint carries its unfinished tickets forward — to another planned/active sprint of the
 * same project, or to the backlog (null). Before this they stayed attached to a sprint that is history
 * and does not reopen: off every board, invisible to the next sprint. Validated before the sprint
 * changes, applied after.
 */
async function planCarryOver(existing: { id: string; projectId: string }, carryOverTo: string | undefined) {
  let target: string | null = null;
  if (carryOverTo && carryOverTo !== "backlog") {
    const row = await prisma.sprint.findFirst({ where: { id: carryOverTo, projectId: existing.projectId }, select: { id: true, status: true } });
    if (!row || row.id === existing.id || row.status === "COMPLETED") {
      throw new AppError(422, "Unfinished tickets can only move to a planned or active sprint of this project, or to the backlog.");
    }
    target = row.id;
  }
  const unfinished = await prisma.ticket.findMany({
    where: { sprintId: existing.id, deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } },
    select: { id: true }
  });
  return { target, ticketIds: unfinished.map((t) => t.id) };
}

async function applyCarryOver(fromSprintId: string, carry: { target: string | null; ticketIds: string[] }, actorId: string): Promise<void> {
  if (carry.ticketIds.length === 0) return;
  await prisma.ticket.updateMany({ where: { id: { in: carry.ticketIds } }, data: { sprintId: carry.target } });
  for (const id of carry.ticketIds) {
    await audit(actorId, "ticket.sprint_changed", "Ticket", id, { from: fromSprintId, to: carry.target, reason: "sprint_completed" });
  }
}

sprintRouter.patch("/:id", requirePermission(permissions.PLAN_WRITE), validate(patchSchema), async (req, res) => {
  const existing = await loadSprint(String(req.params.id));
  await assertTicketVisible(req, existing.projectId);
  const body = req.body as z.infer<typeof patchSchema>["body"];
  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if ("goal" in body) data.goal = body.goal ?? null;
  const start = body.startDate ?? existing.startDate.toISOString().slice(0, 10);
  const end = body.endDate ?? existing.endDate.toISOString().slice(0, 10);
  assertDateOrder(start, end);
  if (body.startDate) data.startDate = new Date(body.startDate);
  if (body.endDate) data.endDate = new Date(body.endDate);
  if (body.status && body.status !== existing.status) {
    assertSprintTransition(existing.status, body.status);
    if (body.status === "ACTIVE") {
      const active = await prisma.sprint.findFirst({ where: { projectId: existing.projectId, status: "ACTIVE", NOT: { id: existing.id } }, select: { name: true } });
      if (active) throw new AppError(409, `"${active.name}" is already active in this project. Complete it first.`);
    }
    data.status = body.status;
  }
  if (Object.keys(data).length === 0) throw new AppError(422, "Nothing to change.");

  const completing = data.status === "COMPLETED";
  const carry = completing ? await planCarryOver(existing, body.carryOverTo) : null;
  const sprint = await prisma.sprint.update({ where: { id: existing.id }, data });
  if (carry) await applyCarryOver(existing.id, carry, req.user!.id);
  await audit(req.user!.id, "sprint.updated", "Sprint", sprint.id, { keys: Object.keys(data), status: sprint.status, carriedOver: carry?.ticketIds.length ?? 0 });
  res.json({ ...sprint, carriedOver: carry?.ticketIds.length ?? 0, carriedOverTo: carry ? (carry.target ?? "backlog") : undefined });
});

sprintRouter.delete("/:id", requirePermission(permissions.PLAN_WRITE), async (req, res) => {
  const existing = await loadSprint(String(req.params.id));
  await assertTicketVisible(req, existing.projectId);
  await prisma.sprint.delete({ where: { id: existing.id } });
  await audit(req.user!.id, "sprint.deleted", "Sprint", existing.id, { projectId: existing.projectId, name: existing.name });
  res.status(204).send();
});

sprintRouter.get("/:id/burndown", requirePermission(permissions.TICKETS_VIEW), async (req, res) => {
  const sprint = await loadSprint(String(req.params.id));
  await assertTicketVisible(req, sprint.projectId);
  // Scope again on the tickets: a sprint is project-scoped, but the caller's scope is what the
  // rest of the app enforces on rows, so the same filter is applied here rather than trusted.
  const scope = await ticketProjectScope(req);
  const scopeWhere = scope.unrestricted ? {} : { projectId: { in: scope.projectIds } };
  // V12 6.1: the candidates are the CURRENT members plus every ticket that ever joined or left
  // this sprint (its membership audit names the sprint on either side), so a ticket moved out
  // mid-sprint still contributes the days it was in.
  const membershipRows = await prisma.auditLog.findMany({
    where: {
      entity: "Ticket",
      action: "ticket.sprint_changed",
      OR: [{ metadata: { path: "$.to", equals: sprint.id } }, { metadata: { path: "$.from", equals: sprint.id } }]
    },
    select: { entityId: true, createdAt: true, metadata: true }
  });
  const everMember = new Set(membershipRows.map((r) => r.entityId).filter((id): id is string => Boolean(id)));
  const tickets = await prisma.ticket.findMany({
    where: { deletedAt: null, ...scopeWhere, OR: [{ sprintId: sprint.id }, ...(everMember.size ? [{ id: { in: [...everMember] } }] : [])] },
    select: { id: true, createdAt: true, status: true, storyPoints: true, sprintId: true }
  });
  const ids = tickets.map((t) => t.id);
  const rows = ids.length
    ? await prisma.auditLog.findMany({
        where: { entity: "Ticket", entityId: { in: ids }, action: "ticket.status_changed" },
        select: { entityId: true, createdAt: true, metadata: true }
      })
    : [];
  const byTicket = new Map<string, Array<{ at: Date; to: string }>>();
  for (const row of rows) {
    const to = (row.metadata as { to?: string } | null)?.to;
    if (!to || !row.entityId) continue;
    const list = byTicket.get(row.entityId) ?? [];
    list.push({ at: row.createdAt, to });
    byTicket.set(row.entityId, list);
  }
  const membershipByTicket = new Map<string, Array<{ at: Date; joined: boolean }>>();
  for (const row of membershipRows) {
    if (!row.entityId) continue;
    const meta = row.metadata as { from?: string | null; to?: string | null } | null;
    const list = membershipByTicket.get(row.entityId) ?? [];
    list.push({ at: row.createdAt, joined: meta?.to === sprint.id });
    membershipByTicket.set(row.entityId, list);
  }
  const input: BurndownTicket[] = tickets.map((t) => ({
    id: t.id,
    createdAt: t.createdAt,
    status: t.status,
    storyPoints: t.storyPoints === null ? null : Number(t.storyPoints),
    transitions: byTicket.get(t.id) ?? [],
    membership: membershipByTicket.get(t.id) ?? []
  }));
  const days = sprintDays(sprint.startDate, sprint.endDate);
  res.json({
    sprint: { id: sprint.id, name: sprint.name, status: sprint.status, startDate: sprint.startDate, endDate: sprint.endDate },
    totalPoints: input.filter((t) => tickets.find((x) => x.id === t.id)?.sprintId === sprint.id).reduce((sum, t) => sum + (t.storyPoints ?? 0), 0),
    ticketCount: tickets.filter((t) => t.sprintId === sprint.id).length,
    points: burndown(days, input)
  });
});
