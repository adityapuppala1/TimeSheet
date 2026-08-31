/**
 * Admin-only CRUD for the two rule sets that decide where a security finding belongs —
 * `RepositoryMap` (repository → project) and `ModulePathRule` (file path → module/submodule) —
 * plus the dry-run an admin uses to check a rule set without waiting for a scan.
 *
 * WHY ITS OWN CONTROLLER rather than more routes on settings.controller.ts: this is rule CRUD, and
 * the file that already does rule CRUD in this app is email-intake.controller.ts — same shape
 * (list / create / patch / delete, `requireSuperAdmin` throughout, every write audited), so it is
 * the file this one is modelled on. settings.controller.ts holds the ingestion SETTINGS these
 * rules sit beside; it does not hold anybody's rules.
 *
 * ── THE DRY-RUN IS NOT A CONVENIENCE ──────────────────────────────────────────────────────────
 *
 * These rules are first-match-wins and ordered, which means the answer depends on rules an admin
 * is not looking at while writing the one in front of them. Without a way to ask "what would this
 * path do?", the only feedback is a ticket that opened in the wrong project a week later, and the
 * failure is silent in between. `POST /test` runs the real resolver — the same function the ingest
 * calls, never a re-implementation of it — and reports WHICH rule won, so an overlapping rule with
 * a lower `order` is visible rather than mysterious.
 *
 * A pattern that cannot be compiled is refused at write time (422) rather than stored and silently
 * ignored. The ingest still tolerates one, because a rule stored before this check existed, or one
 * written straight into the database, must not be able to fail a scan — but there is no reason to
 * let a new one in through the front door.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { resolveFindingLocationLive } from "../services/finding-routing.service.js";
import { compilePathPattern, PATH_PATTERN_MAX_WILDCARDS } from "../utils/path-pattern.js";

export const findingRoutingRouter = Router();
findingRoutingRouter.use(requireAuth, requireSuperAdmin);

/** Refuses a pattern the matcher could never use, and says which of the three reasons it is —
 *  "invalid pattern" on its own leaves an admin guessing at a wildcard limit they cannot see. */
function assertUsablePattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (compilePathPattern(trimmed)) return trimmed;
  throw new AppError(
    422,
    `"${trimmed}" can't be used as a pattern. It must not be empty, must be at most 500 characters, and may contain at most ${PATH_PATTERN_MAX_WILDCARDS} wildcards.`
  );
}

/* ---------- Repository → project ---------- */

const REPOSITORY_MAP_INCLUDE = { project: { select: { id: true, name: true, code: true } } } as const;
/** `order` first, `createdAt` as the tie-break — the evaluation order, so the list an admin reads
 *  is the order the ingest applies. A list sorted any other way would be actively misleading for a
 *  first-match-wins rule set. */
const RULE_ORDER = [{ order: "asc" as const }, { createdAt: "asc" as const }];

findingRoutingRouter.get("/repository-maps", async (_req, res) => {
  res.json(await prisma.repositoryMap.findMany({ orderBy: RULE_ORDER, include: REPOSITORY_MAP_INCLUDE }));
});

const createRepositoryMapSchema = z.object({
  body: z.object({
    pattern: z.string().min(1).max(255),
    projectId: z.string().uuid(),
    order: z.coerce.number().int().min(0).max(9999).optional()
  })
});

findingRoutingRouter.post("/repository-maps", validate(createRepositoryMapSchema), async (req, res) => {
  const pattern = assertUsablePattern(String(req.body.pattern));
  const created = await prisma.repositoryMap.create({
    // `validate()` hands the handler the RAW body (see middleware/validate.ts), so the coercion in
    // the schema above is not applied to what lands here — the Number() is what makes the write
    // agree with the column rather than trusting the shape twice.
    data: { pattern, projectId: String(req.body.projectId), order: Number(req.body.order ?? 0) },
    include: REPOSITORY_MAP_INCLUDE
  });
  await audit(req.user!.id, "repository_map.created", "RepositoryMap", created.id, { pattern, projectId: created.projectId, order: created.order });
  res.status(201).json(created);
});

const patchRepositoryMapSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      pattern: z.string().min(1).max(255).optional(),
      projectId: z.string().uuid().optional(),
      order: z.coerce.number().int().min(0).max(9999).optional(),
      isActive: z.boolean().optional()
    })
    .strict()
});

findingRoutingRouter.patch("/repository-maps/:id", validate(patchRepositoryMapSchema), async (req, res) => {
  const data: Record<string, unknown> = {};
  if (typeof req.body.pattern === "string") data.pattern = assertUsablePattern(req.body.pattern);
  if (typeof req.body.projectId === "string") data.projectId = req.body.projectId;
  if (req.body.order !== undefined) data.order = Number(req.body.order);
  if (typeof req.body.isActive === "boolean") data.isActive = req.body.isActive;

  const updated = await prisma.repositoryMap.update({ where: { id: String(req.params.id) }, data, include: REPOSITORY_MAP_INCLUDE });
  await audit(req.user!.id, "repository_map.updated", "RepositoryMap", updated.id, data);
  res.json(updated);
});

findingRoutingRouter.delete("/repository-maps/:id", async (req, res) => {
  await prisma.repositoryMap.delete({ where: { id: String(req.params.id) } });
  await audit(req.user!.id, "repository_map.deleted", "RepositoryMap", String(req.params.id));
  res.status(204).send();
});

/* ---------- File path → module / submodule ---------- */

const MODULE_PATH_RULE_INCLUDE = {
  project: { select: { id: true, name: true, code: true } },
  module: { select: { id: true, name: true } },
  submodule: { select: { id: true, name: true } }
} as const;

/**
 * A rule pointing at a module in another project, or a submodule in another module, is not a rule —
 * it is a route that can never fire, and it would be invisible until somebody wondered why their
 * findings were unrouted. Cheap to check here, impossible to notice later.
 */
async function assertModuleBelongsTo(projectId: string, moduleId: string, submoduleId: string | null): Promise<void> {
  const module = await prisma.projectModule.findFirst({ where: { id: moduleId, projectId }, select: { id: true } });
  if (!module) throw new AppError(422, "That module doesn't belong to the selected project.");
  if (!submoduleId) return;
  const submodule = await prisma.projectSubmodule.findFirst({ where: { id: submoduleId, moduleId }, select: { id: true } });
  if (!submodule) throw new AppError(422, "That submodule doesn't belong to the selected module.");
}

findingRoutingRouter.get("/module-path-rules", async (_req, res) => {
  res.json(await prisma.modulePathRule.findMany({ orderBy: RULE_ORDER, include: MODULE_PATH_RULE_INCLUDE }));
});

const createModulePathRuleSchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    pattern: z.string().min(1).max(500),
    moduleId: z.string().uuid(),
    submoduleId: z.string().uuid().optional().nullable(),
    order: z.coerce.number().int().min(0).max(9999).optional()
  })
});

findingRoutingRouter.post("/module-path-rules", validate(createModulePathRuleSchema), async (req, res) => {
  const pattern = assertUsablePattern(String(req.body.pattern));
  const projectId = String(req.body.projectId);
  const moduleId = String(req.body.moduleId);
  const submoduleId = req.body.submoduleId ? String(req.body.submoduleId) : null;
  await assertModuleBelongsTo(projectId, moduleId, submoduleId);

  const created = await prisma.modulePathRule.create({
    data: { projectId, pattern, moduleId, submoduleId, order: Number(req.body.order ?? 0) },
    include: MODULE_PATH_RULE_INCLUDE
  });
  await audit(req.user!.id, "module_path_rule.created", "ModulePathRule", created.id, { pattern, projectId, moduleId, submoduleId, order: created.order });
  res.status(201).json(created);
});

const patchModulePathRuleSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({
      projectId: z.string().uuid().optional(),
      pattern: z.string().min(1).max(500).optional(),
      moduleId: z.string().uuid().optional(),
      submoduleId: z.string().uuid().optional().nullable(),
      order: z.coerce.number().int().min(0).max(9999).optional(),
      isActive: z.boolean().optional()
    })
    .strict()
});

findingRoutingRouter.patch("/module-path-rules/:id", validate(patchModulePathRuleSchema), async (req, res) => {
  const current = await prisma.modulePathRule.findUnique({ where: { id: String(req.params.id) } });
  if (!current) throw new AppError(404, "That path rule no longer exists.");

  const data: Record<string, unknown> = {};
  if (typeof req.body.pattern === "string") data.pattern = assertUsablePattern(req.body.pattern);
  if (typeof req.body.projectId === "string") data.projectId = req.body.projectId;
  if (typeof req.body.moduleId === "string") data.moduleId = req.body.moduleId;
  if ("submoduleId" in req.body) data.submoduleId = req.body.submoduleId || null;
  if (req.body.order !== undefined) data.order = Number(req.body.order);
  if (typeof req.body.isActive === "boolean") data.isActive = req.body.isActive;

  // Checked against the row as it WILL be, not as it was — a patch that moves the project without
  // moving the module is exactly the edit that produces an unfireable rule.
  await assertModuleBelongsTo(
    (data.projectId as string) ?? current.projectId,
    (data.moduleId as string) ?? current.moduleId,
    "submoduleId" in data ? (data.submoduleId as string | null) : current.submoduleId
  );

  const updated = await prisma.modulePathRule.update({ where: { id: current.id }, data, include: MODULE_PATH_RULE_INCLUDE });
  await audit(req.user!.id, "module_path_rule.updated", "ModulePathRule", updated.id, data);
  res.json(updated);
});

findingRoutingRouter.delete("/module-path-rules/:id", async (req, res) => {
  await prisma.modulePathRule.delete({ where: { id: String(req.params.id) } });
  await audit(req.user!.id, "module_path_rule.deleted", "ModulePathRule", String(req.params.id));
  res.status(204).send();
});

/* ---------- The dry-run ---------- */

const testRoutingSchema = z.object({
  body: z.object({ repository: z.string().max(255).optional(), filePath: z.string().max(500).optional() })
});

/**
 * "If a finding arrived from this repository, at this path, where would it go?" — answered by the
 * same `resolveFindingLocation` the ingest uses, so the dry-run cannot drift from the real thing.
 * Names are resolved afterwards purely so the answer is readable; the decision itself is made
 * entirely on ids.
 */
findingRoutingRouter.post("/test", validate(testRoutingSchema), async (req, res) => {
  const repository = typeof req.body.repository === "string" ? req.body.repository.trim() : "";
  const filePath = typeof req.body.filePath === "string" ? req.body.filePath.trim() : "";
  const location = await resolveFindingLocationLive({ repository: repository || null, filePath: filePath || null });

  const [project, module, submodule] = await Promise.all([
    location.projectId ? prisma.project.findUnique({ where: { id: location.projectId }, select: { id: true, name: true, code: true } }) : null,
    location.moduleId ? prisma.projectModule.findUnique({ where: { id: location.moduleId }, select: { id: true, name: true } }) : null,
    location.submoduleId ? prisma.projectSubmodule.findUnique({ where: { id: location.submoduleId }, select: { id: true, name: true } }) : null
  ]);

  res.json({
    project,
    module,
    submodule,
    matchedRepositoryMapId: location.matchedRepositoryMapId,
    matchedModulePathRuleId: location.matchedModulePathRuleId,
    /** True when no repository map matched and the ingestion fallback project was used — the case
     *  that is not a failure, just a rule set that says nothing about this repository yet. */
    usedFallbackProject: location.usedFallbackProject
  });
});
