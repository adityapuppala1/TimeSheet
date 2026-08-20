/**
 * WHAT: the tools the Ask AI page's answer loop may consult — tickets, changes, timesheets, metrics,
 * the agent roster and the workflow list.
 *
 * EVERY TOOL IS A READ, AND THAT IS THE DESIGN, NOT THE FIRST DRAFT. The chat answers questions; it
 * does not act. An action taken from a chat transcript has no review step, no proposal row and no
 * undo, which is everything this product's AI layer is built to avoid — so the loop can LOOK at
 * anything the asking person could open in the app, and change nothing. Where an answer naturally
 * leads to an action ("raise a change for this"), the model is told to point at the page where a
 * person does it. The guard test greps this file for prisma write verbs, so a write added here
 * fails a test rather than shipping quietly.
 *
 * EVERY TOOL RUNS AS THE ASKING USER. Ticket and change reads go through the same
 * `ticketProjectScope` the pages use; the timesheet report tool checks the same permission the
 * Reports page requires and says "not permitted" as DATA rather than throwing — the model should
 * tell the person that, not crash the answer.
 *
 * WHO CALLS THIS: `ai.service.ts#askWorkspaceChat`, one tool per loop step.
 */
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { ticketProjectScope } from "./ticket.service.js";

/** What the model sees per tool: the name it must use, and when to use it. */
export interface AiChatToolSpec {
  readonly name: string;
  readonly description: string;
  /** Argument hints, shown to the model verbatim. Loose on purpose — the executor validates. */
  readonly args: string;
}

/** The request-shaped context every executor needs — who is asking, with which permissions. */
export interface AiChatToolContext {
  req: { user: { id: string; role: string; permissions: string[] } };
}

/** One result cap for every tool. A tool that returns 40KB of tickets drowns the question. */
const RESULT_CHAR_CAP = 2400;

const clip = (text: string): string => (text.length > RESULT_CHAR_CAP ? `${text.slice(0, RESULT_CHAR_CAP)}\n…(truncated)` : text);

const CLOSED_TICKET = new Set(["RESOLVED", "CLOSED"]);

async function scopeWhere(ctx: AiChatToolContext) {
  const scope = await ticketProjectScope(ctx.req);
  return scope.unrestricted ? {} : { projectId: { in: scope.projectIds } };
}

export const AI_CHAT_TOOLS: ReadonlyArray<AiChatToolSpec & { run: (args: Record<string, unknown>, ctx: AiChatToolContext) => Promise<string> }> = [
  {
    name: "search_tickets",
    description: "Find tickets by text, status or priority. Use before answering anything about specific tickets.",
    args: '{ "query"?: string, "status"?: string, "priority"?: string, "limit"?: number }',
    run: async (args, ctx) => {
      const where = {
        deletedAt: null,
        ...(await scopeWhere(ctx)),
        ...(typeof args.status === "string" && args.status ? { status: args.status as never } : {}),
        ...(typeof args.priority === "string" && args.priority ? { priority: args.priority as never } : {}),
        ...(typeof args.query === "string" && args.query
          ? { OR: [{ title: { contains: args.query } }, { key: { contains: args.query } }] }
          : {})
      };
      const rows = await prisma.ticket.findMany({
        where,
        select: { key: true, title: true, status: true, priority: true, assignee: { select: { name: true } }, project: { select: { code: true } } },
        orderBy: { updatedAt: "desc" },
        take: Math.min(Number(args.limit) || 20, 40)
      });
      if (rows.length === 0) return "No tickets matched.";
      return clip(rows.map((t) => `[${t.key}] (${t.status}, ${t.priority}, ${t.project.code}) ${t.title}${t.assignee ? ` — ${t.assignee.name}` : ""}`).join("\n"));
    }
  },
  {
    name: "get_ticket",
    description: "One ticket in detail, by its key.",
    args: '{ "key": string }',
    run: async (args, ctx) => {
      const ticket = await prisma.ticket.findFirst({
        where: { key: String(args.key ?? ""), deletedAt: null, ...(await scopeWhere(ctx)) },
        select: {
          key: true, title: true, status: true, priority: true, type: true, description: true, dueAt: true,
          assignee: { select: { name: true } }, reporter: { select: { name: true } }, project: { select: { name: true } },
          _count: { select: { comments: true, attachments: true } }
        }
      });
      if (!ticket) return "No such ticket in your accessible projects.";
      const text = (ticket.description ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
      return clip(
        `[${ticket.key}] ${ticket.title}\nProject: ${ticket.project.name} · ${ticket.type} · ${ticket.status} · ${ticket.priority}` +
          `\nReporter: ${ticket.reporter.name} · Assignee: ${ticket.assignee?.name ?? "unassigned"} · Due: ${ticket.dueAt?.toISOString().slice(0, 10) ?? "none"}` +
          `\nComments: ${ticket._count.comments} · Attachments: ${ticket._count.attachments}` +
          (text ? `\nDescription: ${text}` : "")
      );
    }
  },
  {
    name: "ticket_metrics",
    description: "Ticket counts by status and priority across the person's accessible projects.",
    args: "{}",
    run: async (_args, ctx) => {
      const where = { deletedAt: null, ...(await scopeWhere(ctx)) };
      const [byStatus, byPriority] = await Promise.all([
        prisma.ticket.groupBy({ by: ["status"], where, _count: true }),
        prisma.ticket.groupBy({ by: ["priority"], where, _count: true })
      ]);
      const open = byStatus.filter((r) => !CLOSED_TICKET.has(String(r.status))).reduce((sum, r) => sum + r._count, 0);
      return (
        `Open (not resolved/closed): ${open}\n` +
        `By status: ${byStatus.map((r) => `${r.status}=${r._count}`).join(", ")}\n` +
        `By priority: ${byPriority.map((r) => `${r.priority}=${r._count}`).join(", ")}`
      );
    }
  },
  {
    name: "list_changes",
    description: "Change requests, optionally by state or risk level. Use for anything about change management.",
    args: '{ "state"?: string, "riskLevel"?: string, "limit"?: number }',
    run: async (args, ctx) => {
      const scope = await ticketProjectScope(ctx.req);
      const rows = await prisma.changeRequest.findMany({
        where: {
          ...(scope.unrestricted ? {} : { ticket: { projectId: { in: scope.projectIds } } }),
          ...(typeof args.state === "string" && args.state ? { state: args.state as never } : {}),
          ...(typeof args.riskLevel === "string" && args.riskLevel ? { riskLevel: args.riskLevel as never } : {})
        },
        select: {
          changeKey: true, state: true, riskLevel: true, riskScore: true, changeKind: true, environment: true,
          plannedStart: true, outcome: true, ticket: { select: { title: true } }
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Number(args.limit) || 15, 30)
      });
      if (rows.length === 0) return "No changes matched.";
      return clip(
        rows
          .map(
            (c) =>
              `[${c.changeKey}] (${c.state}, ${c.riskLevel} ${c.riskScore}/100, ${c.changeKind}, ${c.environment}) ${c.ticket.title}` +
              (c.plannedStart ? ` — window ${c.plannedStart.toISOString().slice(0, 16).replace("T", " ")}` : "") +
              (c.outcome ? ` — outcome ${c.outcome}` : "")
          )
          .join("\n")
      );
    }
  },
  {
    name: "change_metrics",
    description: "Change counts by state and risk, plus how many are in flight.",
    args: "{}",
    run: async (_args, ctx) => {
      const scope = await ticketProjectScope(ctx.req);
      const where = scope.unrestricted ? {} : { ticket: { projectId: { in: scope.projectIds } } };
      const [byState, byRisk] = await Promise.all([
        prisma.changeRequest.groupBy({ by: ["state"], where, _count: true }),
        prisma.changeRequest.groupBy({ by: ["riskLevel"], where, _count: true })
      ]);
      const resting = new Set(["DRAFT", "CLOSED", "REJECTED", "CANCELLED"]);
      const inFlight = byState.filter((r) => !resting.has(String(r.state))).reduce((sum, r) => sum + r._count, 0);
      return (
        `In flight: ${inFlight}\n` +
        `By state: ${byState.map((r) => `${r.state}=${r._count}`).join(", ") || "none"}\n` +
        `By risk: ${byRisk.map((r) => `${r.riskLevel}=${r._count}`).join(", ") || "none"}`
      );
    }
  },
  {
    name: "my_timesheets",
    description: "The asking person's OWN recent timesheet entries. Dates are YYYY-MM-DD.",
    args: '{ "from"?: string, "to"?: string }',
    run: async (args, ctx) => {
      const from = typeof args.from === "string" && args.from ? new Date(args.from) : new Date(Date.now() - 14 * 86_400_000);
      const to = typeof args.to === "string" && args.to ? new Date(args.to) : new Date();
      const rows = await prisma.timesheet.findMany({
        where: { userId: ctx.req.user.id, deletedAt: null, workDate: { gte: from, lte: to } },
        select: { workDate: true, totalHours: true, status: true, activityType: true, project: { select: { code: true } } },
        orderBy: { workDate: "desc" },
        take: 60
      });
      if (rows.length === 0) return "No entries in that range.";
      const total = rows.reduce((sum, r) => sum + Number(r.totalHours ?? 0), 0);
      return clip(
        `${rows.length} entries, ${total.toFixed(1)}h total (${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}):\n` +
          rows.map((r) => `${r.workDate.toISOString().slice(0, 10)} ${r.project?.code ?? "—"} ${Number(r.totalHours).toFixed(1)}h ${r.activityType} (${r.status})`).join("\n")
      );
    }
  },
  {
    name: "timesheet_report",
    description: "Workspace-wide approved-hours totals by project over a range. Needs the reports permission.",
    args: '{ "from": string, "to": string }',
    run: async (args, ctx) => {
      // Answered as data, not thrown: "you cannot see this" is the correct ANSWER for somebody
      // without the permission, and the model should say it rather than the request failing.
      if (!ctx.req.user.permissions.includes(permissions.REPORTS_VIEW)) {
        return "Not permitted: the asking person does not hold the reports permission, so workspace-wide hours are not visible to them.";
      }
      const from = new Date(String(args.from ?? ""));
      const to = new Date(String(args.to ?? ""));
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "Invalid dates — use YYYY-MM-DD.";
      const rows = await prisma.timesheet.groupBy({
        by: ["projectId"],
        where: { deletedAt: null, status: "APPROVED", workDate: { gte: from, lte: to } },
        _sum: { totalHours: true }
      });
      if (rows.length === 0) return "No approved hours in that range.";
      const projects = await prisma.project.findMany({
        where: { id: { in: rows.map((r) => r.projectId).filter((id): id is string => Boolean(id)) } },
        select: { id: true, code: true, name: true }
      });
      const nameOf = new Map(projects.map((p) => [p.id, `${p.code} (${p.name})`]));
      return clip(
        rows
          .sort((a, b) => Number(b._sum.totalHours ?? 0) - Number(a._sum.totalHours ?? 0))
          .map((r) => `${nameOf.get(r.projectId ?? "") ?? "Unknown"}: ${Number(r._sum.totalHours ?? 0).toFixed(1)}h approved`)
          .join("\n")
      );
    }
  },
  {
    name: "list_agents",
    description: "The AI teammate roster — each agent's name and what it owns.",
    args: "{}",
    run: async () => {
      const rows = await prisma.agentProfile.findMany({
        where: { deletedAt: null },
        select: { name: true, emoji: true, enabled: true, capabilities: true },
        take: 30
      });
      if (rows.length === 0) return "No agents configured.";
      const lines = rows.map(
        (a) => `${a.emoji} ${a.name} (${a.enabled ? "on" : "off"}): ${Array.isArray(a.capabilities) ? (a.capabilities as string[]).join(", ") : "no capabilities"}`
      );
      return clip(lines.join("\n"));
    }
  },
  {
    name: "list_workflows",
    description: "Workflow Studio flows — name, trigger, and whether each is switched on.",
    args: "{}",
    run: async () => {
      const rows = await prisma.automationFlow.findMany({
        where: { deletedAt: null },
        select: { name: true, emoji: true, trigger: true, triggerConfig: true, enabled: true },
        take: 30
      });
      if (rows.length === 0) return "No workflows built yet.";
      return clip(
        rows
          .map((f) => {
            const config = f.triggerConfig as { event?: string; cron?: string };
            const trigger = f.trigger === "EVENT" ? `on ${config.event ?? "an event"}` : f.trigger === "SCHEDULE" ? `cron ${config.cron ?? ""}` : f.trigger.toLowerCase();
            return `${f.emoji} ${f.name} (${f.enabled ? "on" : "off"}) — ${trigger}`;
          })
          .join("\n")
      );
    }
  }
];

export function findAiChatTool(name: string) {
  return AI_CHAT_TOOLS.find((t) => t.name === name);
}
