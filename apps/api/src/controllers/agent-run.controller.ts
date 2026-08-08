/**
 * WHAT: the HTTP surface for agent runs — queue one, watch them, stop one.
 *
 * WHY IT EXISTS NOW: the envelope (`agent-run.service.ts`) and the worker shipped a phase before
 * any way to reach them from the product — the exact gap the plan-breakdown entry point once had
 * ("the entire proposal envelope had no way to be reached"). These routes close it.
 *
 * WHY `requireSuperAdmin` on every route: queueing a run makes a capability act as a person on a
 * schedule of someone's choosing, and reading a trace exposes tool results across the workspace.
 * Both are administration of the AI surface, which is already a SUPER_ADMIN concern everywhere
 * else (the autonomy ladder, the MCP settings). Delegating this downward is a later, deliberate
 * decision — not a default.
 *
 * WHO CALLS THIS: the AI tab's agent-runs panel, and nothing else.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { queueAgentRun, requestAbort } from "../services/agent-run.service.js";
import { AI_CAPABILITIES, findCapability } from "../services/ai-capability.registry.js";

export const agentRunRouter = Router();
agentRunRouter.use(requireAuth, requireSuperAdmin);

/** The capabilities a run can currently be queued for — the ones with a runner behind them. */
agentRunRouter.get("/capabilities", async (_req, res) => {
  res.json(
    AI_CAPABILITIES.filter((c) => c.id === "assignment_rebalance" || (c.tools.length > 0 && c.featureToggle)).map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      needsProject: c.id === "assignment_rebalance"
    }))
  );
});

agentRunRouter.get(
  "/",
  validate(z.object({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).passthrough() })),
  async (req, res) => {
    const runs = await prisma.agentRun.findMany({
      orderBy: { createdAt: "desc" },
      take: Number(req.query.limit) || 25,
      include: { onBehalfOf: { select: { id: true, name: true } } }
    });
    res.json(runs);
  }
);

/** One run with its full step trace — the audit answer to "what did it actually do". */
agentRunRouter.get(
  "/:id",
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    const run = await prisma.agentRun.findUnique({
      where: { id: String(req.params.id) },
      include: {
        onBehalfOf: { select: { id: true, name: true } },
        steps: { orderBy: { index: "asc" } }
      }
    });
    if (!run) return res.status(404).json({ message: "Run not found" });
    res.json(run);
  }
);

agentRunRouter.post(
  "/",
  validate(
    z.object({
      body: z
        .object({
          capability: z.string().min(1).max(60),
          goal: z.string().min(5).max(2000).optional(),
          projectId: z.string().uuid().optional()
        })
        .strict()
    })
  ),
  async (req, res) => {
    const spec = findCapability(String(req.body.capability));
    if (!spec) return res.status(404).json({ message: "Unknown capability." });

    // A manual queue is one logical occurrence per person per minute — the triggerKey collapses
    // double-clicks and impatient retries to one run, which is what the unique constraint is for.
    const minuteBucket = new Date().toISOString().slice(0, 16);
    const result = await queueAgentRun({
      capability: spec.id,
      trigger: "manual",
      triggerKey: `manual:${spec.id}:${req.user!.id}:${minuteBucket}`,
      onBehalfOfId: req.user!.id,
      scopeProjectId: req.body.projectId ?? null,
      goal: req.body.goal ?? null
    });
    res.status(result.created ? 201 : 200).json(result);
  }
);

agentRunRouter.post(
  "/:id/abort",
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req, res) => {
    await requestAbort(String(req.params.id), req.user!.id);
    res.json({ ok: true });
  }
);
