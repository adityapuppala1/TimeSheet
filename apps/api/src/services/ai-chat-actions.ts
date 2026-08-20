/**
 * WHAT: the ACTIONS the Ask AI chat may take — currently one: logging a timesheet entry as a draft.
 *
 * WHY ACTIONS LIVE IN THEIR OWN FILE, apart from the read tools: `ai-chat-tools.ts` carries a guard
 * test that greps it for every Prisma write verb — that file must stay provably read-only. Actions
 * are a different contract with different guards, and mixing them would dissolve both. This file's
 * own test pins the action list and asserts the one rule that makes chat actions safe at all:
 *
 * EVERYTHING HERE PRODUCES A DRAFT, NEVER A SUBMISSION. The MCP server settled this exact question
 * first and for the same reason: submitting starts an approval SLA clock and, in workspaces that
 * require it, an identity check — an assistant must not trigger either from a sentence. A draft is
 * the assistant typing into the form on the person's behalf; the person still reviews and submits.
 *
 * EVERY VALIDATION IS THE FORM'S OWN. The executor resolves names to ids and then calls
 * `saveTimesheet` — the same function the timesheet page and the MCP tool call — so the
 * Serializable overlap check, the project-assignment gate, the future-date and >12h rules, the
 * HTML sanitisation and the audit entry all apply, from one implementation. A refusal comes back
 * to the model as data, phrased for relaying, not retrying around.
 *
 * WHO CALLS THIS: `ai.service.ts#askWorkspaceChat`, when the model asks for an action by name.
 */
import { prisma } from "../config/prisma.js";
import { saveTimesheet } from "../controllers/timesheet.controller.js";
import type { AiChatToolContext, AiChatToolSpec } from "./ai-chat-tools.js";

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const AI_CHAT_ACTIONS: ReadonlyArray<AiChatToolSpec & { run: (args: Record<string, unknown>, ctx: AiChatToolContext) => Promise<string> }> = [
  {
    name: "log_timesheet_draft",
    description:
      "Record time the asking person says they worked, as a DRAFT they will review and submit themselves. " +
      "Ask them for anything you are missing before calling — never invent hours, dates or descriptions. " +
      "A refusal (overlap, future date, unassigned project) is final: report it, do not adjust values to get around it.",
    args: '{ "projectCode": string, "moduleName"?: string, "workDate": "YYYY-MM-DD", "startTime": "HH:MM", "endTime": "HH:MM", "activityType": string, "taskDescription": string, "ticketKey"?: string }',
    run: async (args, ctx) => {
      const projectCode = String(args.projectCode ?? "").trim();
      const workDate = String(args.workDate ?? "").trim();
      const startTime = String(args.startTime ?? "").trim();
      const endTime = String(args.endTime ?? "").trim();
      const taskDescription = String(args.taskDescription ?? "").trim();
      const activityType = String(args.activityType ?? "").trim();

      // Shape checks here, semantic checks in saveTimesheet. The model gets a correctable message
      // for a malformed argument and the form's own refusal for a rule violation — two different
      // conversations.
      if (!projectCode) return "Missing projectCode — use list_projects to find it, or ask the person.";
      if (!ISO_DAY.test(workDate)) return "workDate must be YYYY-MM-DD.";
      if (!CLOCK.test(startTime) || !CLOCK.test(endTime)) return "startTime and endTime must be 24-hour HH:MM.";
      if (taskDescription.length < 10) return "taskDescription must say what was actually done — at least 10 characters. Ask the person if you do not know.";
      if (!activityType) return "Missing activityType — e.g. Development, Testing, Meeting.";

      const project = await prisma.project.findFirst({
        where: { code: projectCode, deletedAt: null },
        select: { id: true, code: true, name: true, modules: { select: { id: true, name: true } } }
      });
      if (!project) return `No project with code "${projectCode}". Use list_projects to see the codes.`;

      const moduleName = typeof args.moduleName === "string" ? args.moduleName.trim() : "";
      const module = moduleName
        ? project.modules.find((m) => m.name.toLowerCase() === moduleName.toLowerCase())
        : project.modules.length === 1
          ? project.modules[0]
          : undefined;
      if (!module) {
        return moduleName
          ? `"${moduleName}" is not a module of ${project.code}. Its modules: ${project.modules.map((m) => m.name).join(", ") || "none"}. Ask the person which.`
          : `Which module of ${project.code}? Its modules: ${project.modules.map((m) => m.name).join(", ") || "none"}. Ask the person.`;
      }

      let ticketId: string | undefined;
      if (typeof args.ticketKey === "string" && args.ticketKey.trim()) {
        const ticket = await prisma.ticket.findFirst({ where: { key: args.ticketKey.trim(), deletedAt: null }, select: { id: true } });
        if (!ticket) return `No ticket "${args.ticketKey}" — leave ticketKey out, or check the key with search_tickets.`;
        ticketId = ticket.id;
      }

      try {
        // The form's own save, with the form's own rules — including the assignment gate, the
        // Serializable overlap check, and the audit entry naming the asking person as the author.
        const entry = await saveTimesheet(
          {
            user: ctx.req.user,
            body: { projectId: project.id, moduleId: module.id, workDate, startTime, endTime, activityType, taskDescription, ticketId, notes: typeof args.notes === "string" ? args.notes : undefined },
            files: []
          },
          "DRAFT"
        );
        return (
          `DRAFT saved: ${Number(entry.totalHours ?? 0).toFixed(2)}h on ${project.code} / ${module.name}, ${workDate} ${startTime}-${endTime} (${activityType}).` +
          ` Tell the person it is a draft — they review and submit it from Log timesheet, and nothing reaches an approver until they do.`
        );
      } catch (error) {
        return `Refused: ${(error as Error).message.slice(0, 300)} — relay this to the person; do not adjust the values to work around it.`;
      }
    }
  }
];

export function findAiChatAction(name: string) {
  return AI_CHAT_ACTIONS.find((t) => t.name === name);
}
