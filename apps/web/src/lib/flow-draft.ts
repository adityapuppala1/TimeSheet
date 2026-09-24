import { z } from "zod";
import type { FlowCatalogue, FlowPayload } from "../services/api";

const draftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  steps: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("CAPABILITY"), capability: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("ACTION"), action: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("HUMAN_GATE") }).strict(),
    z.object({ kind: z.literal("BRANCH"), field: z.string().min(1), op: z.enum(["is", "is_not"]).optional(), value: z.string().trim().min(1).max(253).optional() }).strict()
  ])).min(1).max(19)
}).strict();

export function flowDraftPrompt(request: string, catalogue: FlowCatalogue): string {
  const fields = catalogue.branchFields.map((field) => field.values ? field.key + "=" + field.values.join("|") : field.key).join(",");
  const prompt = [
    "Design a workflow draft, not an execution. Do not call action tools. Return ONLY JSON, no explanation.",
    'Shape: {"name":"...","description":"...","steps":[...]}. 1-19 steps.',
    'Step shapes: {"kind":"CAPABILITY","capability":"id"}, {"kind":"ACTION","action":"key"}, {"kind":"HUMAN_GATE"}, {"kind":"BRANCH","field":"key"}. No other fields.',
    "BRANCH may include op (is or is_not) and value from the listed choices, or a senderDomain. Never supply project IDs. Omit all other settings. Trigger is manual; human approval first.",
    `Capabilities: ${catalogue.capabilities.filter((c) => c.agentRunnable).map((c) => c.id).join(",")}`,
    `Actions: ${catalogue.actions.map((a) => a.key).join(",")}`,
    `Branch fields: ${fields}`,
    `Requested outcome: ${request.trim()}`
  ].join("\n");
  if (prompt.length > 2000) throw new Error("Shorten the requested outcome to fit the AI request limit.");
  return prompt;
}

export function parseFlowDraft(answer: string, catalogue: FlowCatalogue): FlowPayload {
  if (answer.length > 16000) throw new Error("The AI draft is too large.");
  const lines = answer.trim().split("\n");
  const fenced = ["```", "```json"].includes(lines[0].trim().toLowerCase()) && lines.at(-1)?.trim() === "```";
  const source = (fenced ? lines.slice(1, -1) : lines).join("\n");
  const draft = draftSchema.parse(JSON.parse(source));
  const steps: FlowPayload["steps"] = draft.steps.map((step) => {
    if (step.kind === "CAPABILITY") {
      if (!catalogue.capabilities.some((c) => c.id === step.capability && c.agentRunnable)) throw new Error("Unsupported capability in AI draft.");
      return { kind: step.kind, capability: step.capability, config: {} };
    }
    if (step.kind === "ACTION") {
      if (!catalogue.actions.some((a) => a.key === step.action)) throw new Error("Unsupported action in AI draft.");
      return { kind: step.kind, config: { action: step.action } };
    }
    if (step.kind === "BRANCH") {
      return { kind: step.kind, config: draftCondition(step, catalogue) };
    }
    return { kind: step.kind, config: {} };
  });
  // A generated sequence never starts with write authority. The author must choose an approver.
  if (steps[0].kind !== "HUMAN_GATE") steps.unshift({ kind: "HUMAN_GATE", config: {} });
  return { name: draft.name, description: draft.description, trigger: "MANUAL", triggerConfig: {}, agentProfileId: null, steps };
}

function draftCondition(step: { field: string; op?: "is" | "is_not"; value?: string }, catalogue: FlowCatalogue): Record<string, unknown> {
  const field = catalogue.branchFields.find((item) => item.key === step.field);
  if (!field) throw new Error("Unsupported condition in AI draft.");
  if (step.value !== undefined) {
    const knownValue = field.values?.includes(step.value);
    const domain = step.field === "senderDomain" && z.string().url().safeParse(`https://${step.value}`).success
      && !/[\s/:?#@]/.test(step.value) && step.value.includes(".");
    if (!knownValue && !domain) throw new Error("Unsupported condition value in AI draft.");
  }
  return { field: step.field, op: step.op ?? "is", ...(step.value !== undefined ? { value: step.value } : {}) };
}
