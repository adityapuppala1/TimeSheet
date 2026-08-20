/**
 * WHAT: the Ask AI page — ask a question, keep the history, rate the answers.
 *
 * WHY HISTORY IS A TABLE AND NOT CLIENT STATE: the page's memory is the point. A person comes back
 * tomorrow to the answer they got, what it cost, and which tools it consulted — and recent
 * exchanges are handed back to the model so follow-ups ("and how many of those are critical?")
 * work. Everything the meta strip shows is stored AT ANSWER TIME, because the workspace's model can
 * change tomorrow and the history must keep saying what each answer actually cost.
 *
 * WHY A FAILED ATTEMPT IS STORED TOO: "it failed at 14:02, and this is why" is part of the history.
 * A page that silently forgets failures reads as a page that never fails, which is how trust in the
 * meta figures dies.
 *
 * EVERY ROW IS THE ASKER'S OWN. History, feedback and clearing are all scoped `userId: req.user.id`
 * — there is no cross-user read, and no admin view of other people's questions. What somebody asks
 * an assistant is closer to a search history than to a work record.
 *
 * WHO MOUNTS THIS: `app.ts`, after the blanket `resolveTenant`.
 */
import { Router } from "express";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { askWorkspaceChat } from "../services/ai.service.js";
import { setInteractionFeedback } from "../services/ai-quality.service.js";

export const aiChatRouter = Router();
aiChatRouter.use(requireAuth);

/** More than a page of history goes stale as model context anyway; the page paginates its own view. */
const HISTORY_MAX = 100;

const askSchema = z.object({
  body: z.object({ prompt: z.string().trim().min(3).max(2000) }).strict()
});

aiChatRouter.post("/ask", requirePermission(permissions.TICKETS_VIEW), validate(askSchema), async (req, res) => {
  const prompt = String(req.body.prompt);

  // The model gets the recent exchanges so follow-up questions resolve — "and how many of those"
  // has to mean something.
  const recent = await prisma.aiAskExchange.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { prompt: true, answer: true }
  });

  const startedAt = Date.now();
  try {
    const result = await askWorkspaceChat({
      prompt,
      history: recent.reverse(),
      toolCtx: { req: req as never },
      userId: req.user!.id,
      asker: { name: req.user!.name, role: req.user!.role }
    });

    const row = await prisma.aiAskExchange.create({
      data: {
        userId: req.user!.id,
        prompt,
        answer: result.answer,
        toolCalls: result.toolCalls,
        model: result.model,
        provider: result.provider,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
        durationMs: Date.now() - startedAt,
        interactionId: result.interactionId
      }
    });
    res.status(201).json(row);
  } catch (error) {
    // Kept, not swallowed — the failure is part of the history, and the person sees WHY in place
    // rather than a spinner that gave up. Gate refusals (AI off, budget) pass through as their own
    // status so the page can render the real message.
    const message = (error as Error).message?.slice(0, 500) || "The request failed.";
    const row = await prisma.aiAskExchange.create({
      data: { userId: req.user!.id, prompt, error: message, toolCalls: [], durationMs: Date.now() - startedAt }
    });
    res.status(201).json(row);
  }
});

aiChatRouter.get("/history", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, HISTORY_MAX);
  const rows = await prisma.aiAskExchange.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: limit
  });
  // Oldest first — the page reads top-down like a conversation.
  res.json(rows.reverse());
});

const feedbackSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  // 0 clears — pressing the same thumb twice un-rates, and "unrated" must stay expressible.
  body: z.object({ feedback: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }).strict()
});

aiChatRouter.post("/:id/feedback", validate(feedbackSchema), async (req, res) => {
  const row = await prisma.aiAskExchange.findFirst({
    where: { id: String(req.params.id), userId: req.user!.id },
    select: { id: true, interactionId: true }
  });
  if (!row) throw new AppError(404, "That answer is not in your history.");
  const value = req.body.feedback === 0 ? null : (req.body.feedback as 1 | -1);
  await prisma.aiAskExchange.update({ where: { id: row.id }, data: { feedback: value } });

  // The thumb also reaches the AI quality loop. Rated interactions are what golden datasets are
  // promoted from (ai-dataset.service.ts), so a thumb here weighs exactly as much as one on the AI
  // activity log — when capture was on at answer time; without capture there is no interaction row
  // and the rating stays a page-local preference. Best-effort: the interaction may have been
  // pruned by retention, and a missing capture must not fail the thumb.
  if (row.interactionId) {
    await setInteractionFeedback({
      interactionId: row.interactionId,
      feedback: value === 1 ? "up" : value === -1 ? "down" : null,
      userId: req.user!.id
    }).catch(() => undefined);
  }
  res.json({ ok: true });
});

/** The whole history, gone. Own rows only — this is the "clear my search history" gesture. */
aiChatRouter.delete("/history", async (req, res) => {
  const deleted = await prisma.aiAskExchange.deleteMany({ where: { userId: req.user!.id } });
  res.json({ deleted: deleted.count });
});
