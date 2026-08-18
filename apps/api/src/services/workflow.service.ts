/**
 * WHAT: admin-defined ticket workflows — the statuses a ticket can be in and the legal moves
 * between them — plus the one function every write path goes through to keep the new
 * `Ticket.workflowStatusId` and the original `Ticket.status` enum in agreement.
 *
 * WHY THIS EXISTS: `ticketStatuses` and `ticketStatusTransitions` in `@timesheet/shared` are a
 * hard-coded six-value enum and a hard-coded transition map. That is correct for a ticketing
 * tool and wrong for a project-management tool, where "In review" is called "Legal review" at
 * one customer and "Design QA" at the next, and where a team needs a "Blocked" column the
 * built-in list does not have.
 *
 * WHY IT DOESN'T BREAK ANYTHING: it does NOT replace the enum. `Ticket.status` stays exactly
 * where it was and every one of the ~40 existing readers of it — the SLA sweep, the escalation
 * worker, `report.controller.ts`'s aggregates, the CSV/PDF exports, the public API, webhook
 * payloads, `TicketKanban`'s columns, `ticketStatusTransitions` itself — is untouched. Each
 * custom status declares a `legacyStatus`, and `resolveStatusWrite()` below returns BOTH columns
 * so they are always written together. The cost of that choice is this one function; the benefit
 * is that no existing query had to be audited, rewritten, or re-tested on a live multi-tenant
 * product.
 *
 * WHO CALLS THIS: `controllers/planning.controller.ts` (admin CRUD) and, from Phase 2 on,
 * `controllers/ticket.controller.ts`'s status route.
 */
import { DEFAULT_STATUS_CATEGORY, workStatusCategories, type TicketStatus, type WorkStatusCategory } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { isPlanningCapabilityAllowed } from "./plan-limits.service.js";

/** The workflow the phase-1 migration and `prisma/seed.ts` both create, by a fixed id. */
export const SYSTEM_WORKFLOW_ID = "wf-default";

/** Whether this org's plan tier may define its own workflows at all. Fails closed. */
export async function assertCustomWorkflowsAllowed(): Promise<void> {
  const allowed = await isPlanningCapabilityAllowed(requireTenantContext().orgId, "customWorkflowsEnabled");
  if (!allowed) {
    throw new AppError(403, "Custom workflows are not included in this plan. Upgrade to Enterprise to define your own statuses.");
  }
}

/** Whether the workspace has switched custom workflows ON, independent of what the plan allows.
 *  Both must be true for a custom workflow to be used; either being false means the system
 *  workflow is in force, which is V5 behaviour exactly. */
export async function isCustomWorkflowsActive(): Promise<boolean> {
  const settings = await prisma.globalPlanningSettings.findUnique({ where: { id: "global" } });
  if (!settings?.enableCustomWorkflows) return false;
  return isPlanningCapabilityAllowed(requireTenantContext().orgId, "customWorkflowsEnabled");
}

export async function listWorkflows() {
  return prisma.workflow.findMany({
    include: {
      statuses: { orderBy: { order: "asc" } },
      transitions: true
    },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }]
  });
}

/**
 * The workflow that governs a given ticket type: its own, else the workspace default, else the
 * system one. Never returns null — there is always a workflow, which is what lets callers treat
 * "workflows are off" and "workflows are on" the same way.
 */
export async function resolveWorkflowForTicketType(ticketType: string) {
  if (!(await isCustomWorkflowsActive())) {
    return prisma.workflow.findUniqueOrThrow({
      where: { id: SYSTEM_WORKFLOW_ID },
      include: { statuses: { orderBy: { order: "asc" } }, transitions: true }
    });
  }
  const scoped = await prisma.workflow.findFirst({
    where: { appliesToTicketType: ticketType, isActive: true },
    include: { statuses: { orderBy: { order: "asc" } }, transitions: true }
  });
  if (scoped) return scoped;

  const fallback = await prisma.workflow.findFirst({
    where: { isDefault: true, isActive: true },
    include: { statuses: { orderBy: { order: "asc" } }, transitions: true }
  });
  return (
    fallback ??
    prisma.workflow.findUniqueOrThrow({
      where: { id: SYSTEM_WORKFLOW_ID },
      include: { statuses: { orderBy: { order: "asc" } }, transitions: true }
    })
  );
}

/**
 * THE COMPATIBILITY HINGE. Given the status a caller wants to move a ticket to, return the
 * `{ status, workflowStatusId }` pair to write — both, always, in one update.
 *
 * Callers pass either a `WorkflowStatus.id` (the new planning UI) or a bare `TicketStatus` enum
 * value (every existing caller, including the Kanban's drag handler and the public API). Both
 * resolve to the same pair, which is why the old callers did not have to change.
 *
 * Legality is checked against the WORKFLOW'S transition rows, which for the system workflow are
 * byte-identical to `ticketStatusTransitions` — so a workspace that never enables custom
 * workflows gets exactly the rules it had before, enforced through a different code path but
 * with the same outcome.
 */
export async function resolveStatusWrite(params: {
  ticketType: string;
  from: TicketStatus;
  fromWorkflowStatusId: string | null;
  to: string;
}): Promise<{ status: TicketStatus; workflowStatusId: string }> {
  const workflow = await resolveWorkflowForTicketType(params.ticketType);

  const target =
    workflow.statuses.find((s) => s.id === params.to) ??
    // A bare enum value: pick the status on this workflow that maps to it. If a workflow has two
    // statuses sharing a legacyStatus (legal — "Done" and "Shipped" can both mean CLOSED), the
    // lowest-ordered one wins, so the mapping is deterministic rather than whichever row the
    // database happened to return first.
    workflow.statuses.filter((s) => s.legacyStatus === params.to).sort((a, b) => a.order - b.order)[0];

  if (!target) {
    throw new AppError(400, `"${params.to}" is not a status on the ${workflow.name} workflow.`);
  }

  const current =
    workflow.statuses.find((s) => s.id === params.fromWorkflowStatusId) ??
    workflow.statuses.filter((s) => s.legacyStatus === params.from).sort((a, b) => a.order - b.order)[0];

  // No current status resolvable on this workflow (e.g. the ticket's type was just re-pointed at
  // a different workflow) — allow the move rather than trapping the ticket. The alternative is a
  // ticket nobody can transition, which is worse than a slightly permissive first move.
  if (current && current.id !== target.id) {
    const legal = workflow.transitions.some((t) => t.fromStatusId === current.id && t.toStatusId === target.id);
    if (!legal) {
      throw new AppError(400, `Cannot move from "${current.name}" to "${target.name}" on the ${workflow.name} workflow.`);
    }
  }

  return { status: target.legacyStatus as TicketStatus, workflowStatusId: target.id };
}

/* ------------------------------------------------------------------ *
 * Admin CRUD
 * ------------------------------------------------------------------ */

export interface WorkflowStatusInput {
  id?: string;
  name: string;
  category: WorkStatusCategory;
  legacyStatus: TicketStatus;
  color?: string | null;
  isInitial?: boolean;
  isFinal?: boolean;
}

export interface WorkflowInput {
  name: string;
  description?: string | null;
  appliesToTicketType?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  statuses: WorkflowStatusInput[];
  /** Pairs of status NAMES (not ids — the statuses may not exist yet on create). */
  transitions: Array<{ from: string; to: string; requiresApproval?: boolean; requiredPermission?: string | null }>;
}

/**
 * Rejects a workflow that would be unusable. Every rule here exists because the alternative is a
 * workspace whose tickets get stuck somewhere with no legal move out — a state that is painful
 * to recover from once real tickets are in it, and trivial to prevent here.
 */
function validateWorkflowInput(input: WorkflowInput): void {
  if (input.statuses.length === 0) throw new AppError(400, "A workflow needs at least one status.");

  const names = input.statuses.map((s) => s.name.trim());
  if (names.some((n) => n.length === 0)) throw new AppError(400, "Every status needs a name.");
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    throw new AppError(400, "Two statuses on the same workflow cannot share a name.");
  }

  for (const s of input.statuses) {
    if (!workStatusCategories.includes(s.category)) {
      throw new AppError(400, `"${s.category}" is not a valid status category.`);
    }
    // The legacyStatus is what every pre-V6 reader of Ticket.status will see. An invalid one here
    // would write a value the enum column rejects, so this is the single most important check.
    if (!Object.keys(DEFAULT_STATUS_CATEGORY).includes(s.legacyStatus)) {
      throw new AppError(400, `"${s.legacyStatus}" is not a built-in ticket status.`);
    }
  }

  const initial = input.statuses.filter((s) => s.isInitial);
  if (initial.length !== 1) {
    throw new AppError(400, "Exactly one status must be the starting status.");
  }

  const nameSet = new Set(names);
  for (const t of input.transitions) {
    if (!nameSet.has(t.from) || !nameSet.has(t.to)) {
      throw new AppError(400, `Transition "${t.from}" → "${t.to}" refers to a status that isn't on this workflow.`);
    }
    if (t.from === t.to) throw new AppError(400, "A status cannot transition to itself.");
  }

  // Every non-final status must have somewhere to go, or work stops there permanently.
  for (const s of input.statuses) {
    if (s.isFinal) continue;
    if (!input.transitions.some((t) => t.from === s.name)) {
      throw new AppError(400, `"${s.name}" has no outgoing transitions — mark it as a final status or give it one.`);
    }
  }
}

export async function createWorkflow(input: WorkflowInput) {
  await assertCustomWorkflowsAllowed();
  validateWorkflowInput(input);

  return prisma.$transaction(async (tx) => {
    // Only one workflow can be the default. Demoting the previous one here (rather than relying
    // on a unique index MySQL can't express partially) keeps that invariant true at all times.
    if (input.isDefault) {
      await tx.workflow.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }

    const workflow = await tx.workflow.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        appliesToTicketType: input.appliesToTicketType ?? null,
        isDefault: input.isDefault ?? false,
        isActive: input.isActive ?? true,
        isSystem: false
      }
    });

    const byName = new Map<string, string>();
    for (const [index, s] of input.statuses.entries()) {
      const created = await tx.workflowStatus.create({
        data: {
          workflowId: workflow.id,
          name: s.name.trim(),
          category: s.category,
          legacyStatus: s.legacyStatus,
          color: s.color ?? null,
          order: index,
          isInitial: Boolean(s.isInitial),
          isFinal: Boolean(s.isFinal)
        }
      });
      byName.set(created.name, created.id);
    }

    for (const t of input.transitions) {
      await tx.workflowTransition.create({
        data: {
          workflowId: workflow.id,
          fromStatusId: byName.get(t.from)!,
          toStatusId: byName.get(t.to)!,
          requiresApproval: Boolean(t.requiresApproval),
          requiredPermission: t.requiredPermission ?? null
        }
      });
    }

    return tx.workflow.findUniqueOrThrow({
      where: { id: workflow.id },
      include: { statuses: { orderBy: { order: "asc" } }, transitions: true }
    });
  });
}

/**
 * Replaces a workflow's statuses and transitions wholesale.
 *
 * Statuses that survive (matched by name) KEEP THEIR ROW ID, which matters more than it looks:
 * `Ticket.workflowStatusId` points at those rows, so recreating them would orphan every ticket
 * on the workflow. Statuses that disappear are only removable if no ticket is sitting in them.
 */
export async function updateWorkflow(id: string, input: WorkflowInput) {
  await assertCustomWorkflowsAllowed();
  validateWorkflowInput(input);

  const existing = await prisma.workflow.findUniqueOrThrow({ where: { id }, include: { statuses: true } });
  if (existing.isSystem) {
    throw new AppError(400, "The Default workflow is the compatibility baseline and can't be edited. Duplicate it instead.");
  }

  const keptNames = new Set(input.statuses.map((s) => s.name.trim()));
  const removed = existing.statuses.filter((s) => !keptNames.has(s.name));
  if (removed.length > 0) {
    const stuck = await prisma.ticket.count({ where: { workflowStatusId: { in: removed.map((s) => s.id) } } });
    if (stuck > 0) {
      throw new AppError(
        400,
        `${stuck} ticket(s) are currently in ${removed.map((s) => `"${s.name}"`).join(", ")}. Move them first, then remove the status.`
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.workflow.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
    }

    await tx.workflow.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description ?? null,
        appliesToTicketType: input.appliesToTicketType ?? null,
        isDefault: input.isDefault ?? false,
        isActive: input.isActive ?? true
      }
    });

    // Transitions are always rebuilt — they carry no external references, unlike statuses.
    await tx.workflowTransition.deleteMany({ where: { workflowId: id } });
    await tx.workflowStatus.deleteMany({ where: { id: { in: removed.map((s) => s.id) } } });

    const byName = new Map<string, string>();
    for (const [index, s] of input.statuses.entries()) {
      const name = s.name.trim();
      const prior = existing.statuses.find((e) => e.name === name);
      const row = prior
        ? await tx.workflowStatus.update({
            where: { id: prior.id },
            data: {
              category: s.category,
              legacyStatus: s.legacyStatus,
              color: s.color ?? null,
              order: index,
              isInitial: Boolean(s.isInitial),
              isFinal: Boolean(s.isFinal)
            }
          })
        : await tx.workflowStatus.create({
            data: {
              workflowId: id,
              name,
              category: s.category,
              legacyStatus: s.legacyStatus,
              color: s.color ?? null,
              order: index,
              isInitial: Boolean(s.isInitial),
              isFinal: Boolean(s.isFinal)
            }
          });
      byName.set(row.name, row.id);
    }

    for (const t of input.transitions) {
      await tx.workflowTransition.create({
        data: {
          workflowId: id,
          fromStatusId: byName.get(t.from)!,
          toStatusId: byName.get(t.to)!,
          requiresApproval: Boolean(t.requiresApproval),
          requiredPermission: t.requiredPermission ?? null
        }
      });
    }

    // A status whose legacyStatus was just re-pointed means the tickets sitting in it now
    // disagree with their own Ticket.status. Re-align them in the same transaction — leaving
    // them inconsistent is precisely the failure this whole design exists to prevent.
    for (const s of input.statuses) {
      const statusId = byName.get(s.name.trim())!;
      await tx.ticket.updateMany({
        where: { workflowStatusId: statusId, status: { not: s.legacyStatus } },
        data: { status: s.legacyStatus }
      });
    }

    return tx.workflow.findUniqueOrThrow({
      where: { id },
      include: { statuses: { orderBy: { order: "asc" } }, transitions: true }
    });
  });
}

export async function deleteWorkflow(id: string) {
  const existing = await prisma.workflow.findUniqueOrThrow({ where: { id }, include: { statuses: true } });
  if (existing.isSystem) throw new AppError(400, "The Default workflow can't be deleted.");

  const inUse = await prisma.ticket.count({ where: { workflowStatusId: { in: existing.statuses.map((s) => s.id) } } });
  if (inUse > 0) {
    throw new AppError(400, `${inUse} ticket(s) are on this workflow. Move them to another workflow first.`);
  }
  await prisma.workflow.delete({ where: { id } });
}
