/**
 * WHAT: the agent roster's admin surface — the gallery of prebuilt teammates, the profiles a
 * workspace has instantiated, their resolved autonomy, their spend, and their run history.
 *
 * WHY SUPER_ADMIN ONLY: creating an agent mints a service identity that can be assigned work and
 * whose actions appear in the audit trail under its own name. That is the same class of decision as
 * enabling AI, biometrics, SSO or the MCP server — every one of which is one person's
 * responsibility in this product. Reading the roster needs `tickets:view`, because "what is that
 * teammate and what has it been doing" is a question anybody working alongside one may ask.
 *
 * WHY THE ENTITLEMENT IS `aiPmCopilotEnabled` AND NOT A NEW ONE: a roster is a bundle of the AI
 * capability family, and that family already has a tier gate. Adding `agentRosterEnabled` beside it
 * would create two switches for one commercial decision, and the second one to be forgotten becomes
 * a support ticket. Spend stays bounded by the org's monthly budget and the tier's hard ceiling
 * regardless.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import {
  AGENT_TEMPLATES,
  createProfile,
  listCapabilityCatalogue,
  listRoster,
  listTemplates,
  retireProfile,
  updateProfile
} from "../services/agent-profile.service.js";
import { audit } from "../services/audit.service.js";
import { isPlanningCapabilityAllowed } from "../services/plan-limits.service.js";

export const agentRouter = Router();
agentRouter.use(requireAuth);

/**
 * Fails CLOSED, and says which of the two things is missing — the same split every planning gate
 * uses, because "ask your admin" and "upgrade your plan" need different people to act.
 */
async function assertRosterAllowed() {
  const allowed = await isPlanningCapabilityAllowed(requireTenantContext().orgId, "aiPmCopilotEnabled");
  if (!allowed) {
    throw new AppError(403, "The agent roster is part of the AI copilot family, which is not included in this plan. Upgrade to Enterprise to use it.");
  }
}

agentRouter.get("/", requirePermission(permissions.TICKETS_VIEW), async (_req, res) => {
  await assertRosterAllowed();
  res.json(await listRoster());
});

/** The gallery and the capability catalogue in one call: the "add a teammate" dialog needs both,
 *  and two round trips for one dialog is two chances to render half of it. */
agentRouter.get("/catalogue", requirePermission(permissions.TICKETS_VIEW), async (_req, res) => {
  await assertRosterAllowed();
  res.json({ templates: await listTemplates(), capabilities: listCapabilityCatalogue() });
});

const createSchema = z.object({
  body: z
    .object({
      name: z.string().min(1).max(80),
      emoji: z.string().min(1).max(16).optional(),
      description: z.string().max(2000).nullish(),
      capabilities: z.array(z.string().max(60)).min(1).max(30),
      scopeProjectIds: z.array(z.string().uuid()).max(100).optional(),
      maxCostUsdPerDay: z.number().min(0).max(10_000).nullish()
    })
    .strict()
});

agentRouter.post("/", requireSuperAdmin, validate(createSchema), async (req, res) => {
  await assertRosterAllowed();
  const body = req.body as z.infer<typeof createSchema>["body"];
  const entry = await createProfile({ ...body, createdById: req.user!.id });
  await audit(req.user!.id, "agent.created", "AgentProfile", entry.id, {
    name: entry.name,
    capabilities: entry.capabilities.map((c) => c.id),
    identityEmail: entry.identity.email
  });
  res.status(201).json(entry);
});

/** Instantiating a gallery template. A separate route from the generic create because the template
 *  key must come from the catalogue rather than from the request body — otherwise "this is the stock
 *  triage teammate, unmodified" becomes a claim the client can assert about anything. */
const installSchema = z.object({ body: z.object({ templateKey: z.string().max(60) }).strict() });

agentRouter.post("/install", requireSuperAdmin, validate(installSchema), async (req, res) => {
  await assertRosterAllowed();
  const { templateKey } = req.body as z.infer<typeof installSchema>["body"];
  const template = AGENT_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) throw new AppError(404, "No such agent template.");

  const already = await prisma.agentProfile.findFirst({ where: { templateKey, deletedAt: null }, select: { id: true } });
  if (already) throw new AppError(409, `${template.name} is already on the roster.`);

  const entry = await createProfile({
    name: template.name,
    emoji: template.emoji,
    description: template.description,
    capabilities: template.capabilities,
    templateKey: template.key,
    createdById: req.user!.id
  });
  await audit(req.user!.id, "agent.installed", "AgentProfile", entry.id, { templateKey, identityEmail: entry.identity.email });
  res.status(201).json(entry);
});

const patchSchema = z.object({
  body: createSchema.shape.body.partial().extend({ enabled: z.boolean().optional() }).strict()
});

agentRouter.patch("/:id", requireSuperAdmin, validate(patchSchema), async (req, res) => {
  await assertRosterAllowed();
  const body = req.body as z.infer<typeof patchSchema>["body"];
  const entry = await updateProfile(String(req.params.id), body);
  // Enabling is the interesting event, so it is audited as its own action rather than as a field
  // list — "who switched this agent on, and when" is the question an incident review asks.
  const action = body.enabled === undefined ? "agent.updated" : body.enabled ? "agent.enabled" : "agent.disabled";
  await audit(req.user!.id, action, "AgentProfile", entry.id, { fields: Object.keys(body) });
  res.json(entry);
});

agentRouter.delete("/:id", requireSuperAdmin, async (req, res) => {
  await assertRosterAllowed();
  await retireProfile(String(req.params.id));
  await audit(req.user!.id, "agent.retired", "AgentProfile", String(req.params.id));
  res.status(204).end();
});
