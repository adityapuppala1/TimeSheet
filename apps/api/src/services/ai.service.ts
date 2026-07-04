/**
 * AI service — the single choke point every AI-powered feature in this app calls through.
 *
 * WHAT: wraps the Anthropic Claude API and exposes one function per capability (ticket
 * triage, duplicate detection, writing assistant, comment summarization, workspace Q&A,
 * weekly digest). Also owns cost estimation, usage logging, and the monthly budget cap.
 *
 * WHY: AI calls cost real money and can behave unpredictably, so every capability must
 * obey the same admin-configured guardrails (master on/off switch, per-feature toggles,
 * model choice, budget cap) without each caller re-implementing that logic. Centralizing
 * it here means adding toggle #8 automatically protects every future AI feature too.
 *
 * HOW: `preflight(feature)` is the gate every capability function calls first — it checks
 * `GlobalAISettings.aiEnabled` + the specific feature's own toggle, then the monthly spend
 * against `GlobalAISettings.monthlyBudgetUsd`, and only then returns a live Anthropic client.
 * Every call also logs to `AIUsageLog` afterward so `getMonthlyAIUsageSummary()` can show
 * admins what a feature is actually costing.
 *
 * Structured JSON output (`classifyTicket`, `findDuplicateTickets`) is built as a raw
 * JSON-schema object rather than the SDK's `zodOutputFormat` helper — that helper targets
 * Zod v4 internals and this project pins Zod v3, so schemas are validated locally instead
 * (see `parseJsonResponse`). Any new structured-output capability should follow that same
 * pattern rather than reaching for `zodOutputFormat`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { TicketPriority } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { htmlToText } from "../utils/sanitize.js";

const GLOBAL_ID = "global";

/**
 * Per-model $/1M-token pricing, used only to produce a cost *estimate* for
 * AIUsageLog / the monthly budget cap — not billing-accurate, just enough to
 * let admins see roughly what a feature costs and cap spend.
 */
const MODEL_PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-4-8": { input: 5, output: 25 }
};
const DEFAULT_PRICING = { input: 3, output: 15 };

let client: Anthropic | null = null;

/** Lazily-constructed singleton client. Throws a clear error until ANTHROPIC_API_KEY is set. */
export function getAnthropicClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError(503, "AI features are not configured — set ANTHROPIC_API_KEY on the server.");
  }
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

/** Upsert-on-read singleton row (id="global") — first call ever made seeds the defaults (AI off). */
export async function getGlobalAISettings() {
  return prisma.globalAISettings.upsert({
    where: { id: GLOBAL_ID },
    update: {},
    create: { id: GLOBAL_ID }
  });
}

type AIFeatureToggle =
  | "autoTriageEnabled"
  | "duplicateDetectionEnabled"
  | "writingAssistantEnabled"
  | "commentSummaryEnabled"
  | "workspaceSearchEnabled"
  | "emailIngestionEnabled"
  | "weeklyDigestEnabled";

/** Throws a 403 unless AI is enabled workspace-wide AND the specific feature's toggle is on. */
export async function assertAIFeatureEnabled(feature: AIFeatureToggle): Promise<Awaited<ReturnType<typeof getGlobalAISettings>>> {
  const settings = await getGlobalAISettings();
  if (!settings.aiEnabled) throw new AppError(403, "AI features are disabled for this workspace.");
  if (!settings[feature]) throw new AppError(403, "This AI feature is disabled for this workspace.");
  return settings;
}

/** Throws a 402 if the current calendar month's estimated AI spend has hit the configured cap. */
export async function assertWithinBudget(monthlyBudgetUsd: unknown): Promise<void> {
  if (monthlyBudgetUsd === null || monthlyBudgetUsd === undefined) return;
  const budget = Number(monthlyBudgetUsd);
  if (budget <= 0) return;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const spend = await prisma.aIUsageLog.aggregate({
    where: { createdAt: { gte: monthStart } },
    _sum: { costUsdEstimate: true }
  });
  const spent = Number(spend._sum.costUsdEstimate ?? 0);
  if (spent >= budget) {
    throw new AppError(402, `Monthly AI budget of $${budget.toFixed(2)} has been reached ($${spent.toFixed(2)} spent).`);
  }
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING_PER_MILLION[model] ?? DEFAULT_PRICING;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

export async function logAIUsage(params: {
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ticketId?: string;
}): Promise<void> {
  const costUsdEstimate = estimateCostUsd(params.model, params.inputTokens, params.outputTokens);
  await prisma.aIUsageLog.create({
    data: {
      feature: params.feature,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      costUsdEstimate,
      ticketId: params.ticketId
    }
  });
}

export async function getMonthlyAIUsageSummary() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [total, byFeature] = await Promise.all([
    prisma.aIUsageLog.aggregate({
      where: { createdAt: { gte: monthStart } },
      _sum: { costUsdEstimate: true, inputTokens: true, outputTokens: true },
      _count: true
    }),
    prisma.aIUsageLog.groupBy({
      by: ["feature"],
      where: { createdAt: { gte: monthStart } },
      _sum: { costUsdEstimate: true },
      _count: true
    })
  ]);
  return {
    // Local calendar date, not toISOString().slice(0,10) — that round-trips through UTC
    // and would show the last day of the *previous* month for any TZ ahead of UTC.
    monthStart: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}-${String(monthStart.getDate()).padStart(2, "0")}`,
    totalCostUsd: Number(total._sum.costUsdEstimate ?? 0),
    totalCalls: total._count,
    byFeature: byFeature.map((row) => ({ feature: row.feature, costUsd: Number(row._sum.costUsdEstimate ?? 0), calls: row._count }))
  };
}

/**
 * Runs a preflight (feature toggle + budget) and returns the settings + client
 * every capability function below needs. Centralizing this means every AI
 * capability obeys the admin toggles and budget cap the same way.
 */
async function preflight(feature: AIFeatureToggle) {
  const settings = await assertAIFeatureEnabled(feature);
  await assertWithinBudget(settings.monthlyBudgetUsd);
  return { settings, client: getAnthropicClient() };
}

/**
 * Structured outputs (`output_config.format`) take a plain JSON-schema object over the wire —
 * built by hand here rather than via the SDK's `zodOutputFormat` helper, which targets Zod v4's
 * internals and doesn't accept this project's Zod v3 schemas. The Zod v3 schemas below are used
 * only to validate the parsed JSON locally, decoupled from the SDK's own (un-used) zod integration.
 */
function parseJsonResponse<T>(content: Anthropic.ContentBlock[], schema: z.ZodType<T>): T | null {
  const raw = firstTextBlock(content);
  if (!raw) return null;
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

const TriageResultSchema = z.object({
  type: z.string(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  moduleName: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string()
});

/**
 * Classify a ticket's type/priority/module from a closed set of the project's
 * actual rows — the model can only pick names that exist, never invent one.
 */
export async function classifyTicket(params: {
  title: string;
  description?: string | null;
  project: { id: string; name: string; modules: Array<{ id: string; name: string }> };
  typeNames: string[];
  /** Optional screenshots/attachments (e.g. from an inbound email) — Claude reads them directly alongside the text. */
  images?: Array<{ mediaType: string; base64: string }>;
}): Promise<{ type: string; priority: TicketPriority; moduleId: string | null; confidence: number; reasoning: string }> {
  const { settings, client } = await preflight("autoTriageEnabled");

  const moduleNames = params.project.modules.map((m) => m.name);

  const prompt = [
    `You are triaging a new ticket for the project "${params.project.name}".`,
    `Title: ${params.title}`,
    `Description: ${params.description ? htmlToText(params.description) : "(no description provided)"}`,
    "",
    `Valid ticket types: ${params.typeNames.join(", ") || "(none configured)"}`,
    `Valid modules: ${moduleNames.join(", ") || "(none configured)"} — use "NONE" if unclear.`,
    "",
    "Pick the single most appropriate type, priority, and module. Give a confidence score (0-1) reflecting how certain you are, and a one-sentence reasoning.",
    params.images?.length ? "One or more screenshots are attached — use them as evidence for what the issue actually is." : ""
  ]
    .filter(Boolean)
    .join("\n");

  const content: Anthropic.MessageParam["content"] = params.images?.length
    ? [
        ...params.images.map((image) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: image.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: image.base64 }
        })),
        { type: "text" as const, text: prompt }
      ]
    : prompt;

  const response = await client.messages.create({
    model: settings.model,
    max_tokens: 1024,
    messages: [{ role: "user", content }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            type: params.typeNames.length > 0 ? { type: "string", enum: params.typeNames } : { type: "string" },
            priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
            moduleName: { type: "string", enum: moduleNames.length > 0 ? [...moduleNames, "NONE"] : ["NONE"] },
            confidence: { type: "number" },
            reasoning: { type: "string" }
          },
          required: ["type", "priority", "moduleName", "confidence", "reasoning"],
          additionalProperties: false
        }
      }
    }
  });

  await logAIUsage({
    feature: "triage",
    model: settings.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens
  });

  const parsed = parseJsonResponse(response.content, TriageResultSchema);
  if (!parsed) throw new AppError(502, "AI classification did not return a usable result.");

  const moduleId = parsed.moduleName === "NONE" ? null : (params.project.modules.find((m) => m.name === parsed.moduleName)?.id ?? null);

  return { type: parsed.type, priority: parsed.priority, moduleId, confidence: parsed.confidence, reasoning: parsed.reasoning };
}

const DuplicateResultSchema = z.object({
  matches: z.array(
    z.object({
      ticketKey: z.string(),
      likelihood: z.number().min(0).max(1),
      reasoning: z.string()
    })
  )
});

/** Ranks existing tickets by likely-duplicate similarity to a new one being drafted. */
export async function findDuplicateTickets(params: {
  title: string;
  description?: string | null;
  candidates: Array<{ id: string; key: string; title: string; description: string | null }>;
}): Promise<Array<{ ticketId: string; key: string; likelihood: number; reasoning: string }>> {
  if (params.candidates.length === 0) return [];
  const { settings, client } = await preflight("duplicateDetectionEnabled");

  const keys = params.candidates.map((c) => c.key);
  const candidateList = params.candidates
    .map((c) => {
      const snippet = c.description ? htmlToText(c.description).slice(0, 300) : "";
      return `- [${c.key}] ${c.title}` + (snippet ? `: ${snippet}` : "");
    })
    .join("\n");

  const prompt = [
    "A new ticket is being created:",
    `Title: ${params.title}`,
    `Description: ${params.description ? htmlToText(params.description) : "(no description provided)"}`,
    "",
    "Existing open tickets in the same project:",
    candidateList,
    "",
    "Identify which (if any) existing tickets are likely duplicates of the new one. Only include genuinely similar matches — an empty list is a valid answer."
  ].join("\n");

  const response = await client.messages.create({
    model: settings.model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            matches: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ticketKey: { type: "string", enum: keys },
                  likelihood: { type: "number" },
                  reasoning: { type: "string" }
                },
                required: ["ticketKey", "likelihood", "reasoning"],
                additionalProperties: false
              }
            }
          },
          required: ["matches"],
          additionalProperties: false
        }
      }
    }
  });

  await logAIUsage({
    feature: "duplicate_detection",
    model: settings.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens
  });

  const parsed = parseJsonResponse(response.content, DuplicateResultSchema);
  if (!parsed) return [];

  return parsed.matches.map((m) => ({
    ticketId: params.candidates.find((c) => c.key === m.ticketKey)!.id,
    key: m.ticketKey,
    likelihood: m.likelihood,
    reasoning: m.reasoning
  }));
}

function firstTextBlock(content: Anthropic.ContentBlock[]): string {
  const block = content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return block?.text?.trim() ?? "";
}

/** Rewrites a terse bug report / comment into clearer prose. Returns the plain rewritten text (no HTML). */
export async function improveText(params: { text: string; context: "ticket_description" | "comment" }): Promise<{ improved: string }> {
  const { settings, client } = await preflight("writingAssistantEnabled");

  const plain = htmlToText(params.text);
  if (!plain) throw new AppError(422, "Nothing to improve — the text is empty.");

  const instruction =
    params.context === "ticket_description"
      ? "Rewrite this bug/task description to be clear and well-structured — use a \"Steps to reproduce / Expected / Actual\" layout if it reads like a bug report. Keep it factual; don't invent details the original doesn't imply."
      : "Improve the clarity and tone of this comment while preserving its meaning and intent. Keep it concise.";

  const response = await client.messages.create({
    model: settings.model,
    max_tokens: 1024,
    messages: [{ role: "user", content: `${instruction}\n\nOriginal text:\n${plain}\n\nRespond with ONLY the improved text — no preamble, no explanation.` }]
  });

  await logAIUsage({
    feature: "writing_assistant",
    model: settings.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens
  });

  return { improved: firstTextBlock(response.content) || plain };
}

/** Summarizes a ticket's comment thread into a short status recap. */
export async function summarizeComments(params: {
  ticketTitle: string;
  comments: Array<{ authorName: string; body: string; createdAt: Date }>;
}): Promise<{ summary: string }> {
  const { settings, client } = await preflight("commentSummaryEnabled");

  const thread = params.comments
    .map((c) => `${c.authorName} (${c.createdAt.toISOString().slice(0, 16).replace("T", " ")}): ${htmlToText(c.body)}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: settings.model,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `Summarize this comment thread on ticket "${params.ticketTitle}" in 2-4 sentences — focus on current status, decisions made, and any open questions.\n\n${thread}`
      }
    ]
  });

  await logAIUsage({
    feature: "comment_summary",
    model: settings.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens
  });

  return { summary: firstTextBlock(response.content) };
}

/** Answers a free-text question about the caller's accessible tickets, citing ticket keys. */
export async function answerWorkspaceQuestion(params: {
  question: string;
  tickets: Array<{ key: string; title: string; status: string; priority: string; description: string | null }>;
}): Promise<{ answer: string }> {
  const { settings, client } = await preflight("workspaceSearchEnabled");

  const context = params.tickets
    .map((t) => {
      const snippet = t.description ? htmlToText(t.description).slice(0, 200) : "";
      return `[${t.key}] (${t.status}, ${t.priority}) ${t.title}` + (snippet ? ` — ${snippet}` : "");
    })
    .join("\n");

  const response = await client.messages.create({
    model: settings.model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You're answering a question about a team's ticket backlog. Use only the tickets listed below — cite ticket keys like [WEB-12] when referencing them. If the answer isn't in the provided tickets, say so plainly.\n\nTickets:\n${context}\n\nQuestion: ${params.question}`
      }
    ]
  });

  await logAIUsage({
    feature: "ask_ai",
    model: settings.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens
  });

  return { answer: firstTextBlock(response.content) || "I couldn't generate an answer from the available tickets." };
}

/** Authors a short, plain-English weekly recap of one person's ticket + timesheet activity. */
export async function generateWeeklyDigest(params: {
  userName: string;
  weekLabel: string;
  ticketsCreated: number;
  ticketsResolved: number;
  openAssigned: number;
  hoursLogged: number;
  notableTickets: Array<{ key: string; title: string; status: string }>;
}): Promise<{ summary: string }> {
  const { settings, client } = await preflight("weeklyDigestEnabled");

  const ticketLines = params.notableTickets.map((t) => `- [${t.key}] ${t.title} (${t.status})`).join("\n") || "(none)";
  const prompt = [
    `Write a short, friendly Monday-morning recap (3-5 sentences, plain prose, no headings/bullets in the output) for ${params.userName} covering the week of ${params.weekLabel}.`,
    "",
    `Tickets created: ${params.ticketsCreated}`,
    `Tickets resolved: ${params.ticketsResolved}`,
    `Currently open & assigned to them: ${params.openAssigned}`,
    `Hours logged: ${params.hoursLogged}`,
    "Notable tickets:",
    ticketLines,
    "",
    "Keep it encouraging but factual — don't invent numbers beyond what's given. If everything is at zero, say the week was quiet rather than padding it out."
  ].join("\n");

  const response = await client.messages.create({
    model: settings.model,
    max_tokens: 400,
    messages: [{ role: "user", content: `${prompt}\n\nRespond with ONLY the recap paragraph — no preamble, no subject line.` }]
  });

  await logAIUsage({
    feature: "weekly_digest",
    model: settings.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens
  });

  return { summary: firstTextBlock(response.content) };
}
