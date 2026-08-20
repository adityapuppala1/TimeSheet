/**
 * WHAT: the operational half of the Ask AI tool set — spend, mail, security, health, audit,
 * integrations, goals, agents and workflows. What an administrator opens the settings pages for.
 *
 * WHY IT IS A SECOND FILE: the everyday tools in `ai-chat-tools.ts` are scoped by PROJECT — they
 * answer "my tickets, my hours" and never reach past what the asker could already open. These
 * answer "the workspace" — cross-project, cross-person, sometimes cross-cutting the whole install —
 * and every one carries an access gate naming the permission a page already requires for the same
 * data. Keeping the two sets apart makes that distinction structural instead of a comment: a tool
 * added to the wrong file is obvious in review.
 *
 * EVERY GATE MIRRORS A PAGE. `audit_log` needs `audit:view`, the same as the Audit log page.
 * `user_stats` needs `users:manage`, the same as Users. Spend, mail, security, health, API
 * telemetry and integration state are super-admin-only because that is who those settings pages are
 * for. Nothing here invents an access rule; where the chat cannot mirror a page's rule exactly, it
 * takes the stricter one.
 *
 * READ-ONLY, like its sibling. The guard test greps both files for Prisma write verbs.
 *
 * WHO CALLS THIS: `ai.service.ts#askWorkspaceChat`, through the merged registry in ai-chat-tools.ts.
 */
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import type { AiChatToolContext } from "./ai-chat-tools.js";
import type { ToolAccess } from "./ai-chat-guardrails.js";

const NL = String.fromCharCode(10);
const SUPER: ToolAccess = { superAdminOnly: true };

/** Default lookback for anything time-shaped, when the model does not name one. */
const DEFAULT_DAYS = 30;
const since = (args: Record<string, unknown>, fallback = DEFAULT_DAYS): Date => {
  const days = Number(args.days);
  const window = Number.isFinite(days) && days > 0 && days <= 365 ? days : fallback;
  return new Date(Date.now() - window * 86_400_000);
};

const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "n/a");

export interface AdminTool {
  readonly name: string;
  readonly description: string;
  readonly args: string;
  readonly group: string;
  readonly access?: ToolAccess;
  readonly run: (args: Record<string, unknown>, ctx: AiChatToolContext) => Promise<string>;
}

export const AI_CHAT_ADMIN_TOOLS: ReadonlyArray<AdminTool> = [
  /* ---------------- AI ---------------- */
  {
    name: "ai_spend",
    description: "AI spend and call volume by feature and model. The tool for 'what is AI costing us', 'which feature uses the most tokens'.",
    args: '{ "days"?: number }',
    group: "AI",
    access: SUPER,
    run: async (args) => {
      const from = since(args);
      const rows = await prisma.aIUsageLog.groupBy({
        by: ["feature"],
        where: { createdAt: { gte: from } },
        _count: true,
        _sum: { inputTokens: true, outputTokens: true, costUsdEstimate: true }
      });
      if (rows.length === 0) return "No AI calls in that window.";
      const total = rows.reduce((sum, r) => sum + Number(r._sum.costUsdEstimate ?? 0), 0);
      const lines = rows
        .sort((a, b) => Number(b._sum.costUsdEstimate ?? 0) - Number(a._sum.costUsdEstimate ?? 0))
        .map(
          (r) =>
            `${r.feature}: ${r._count} calls, ${Number(r._sum.inputTokens ?? 0).toLocaleString()} in / ${Number(
              r._sum.outputTokens ?? 0
            ).toLocaleString()} out, $${Number(r._sum.costUsdEstimate ?? 0).toFixed(4)}`
        );
      return `Since ${from.toISOString().slice(0, 10)} — total estimated $${total.toFixed(4)} across ${rows.reduce((s, r) => s + r._count, 0)} calls:${NL}${lines.join(NL)}`;
    }
  },
  {
    name: "ai_quality",
    description:
      "AI answer quality: how often responses parsed against their schema, and the thumbs up/down split by feature. The tool for 'is the AI actually working', 'which capability gets rated down'.",
    args: '{ "days"?: number }',
    group: "AI",
    access: SUPER,
    run: async (args) => {
      const from = since(args);
      const rows = await prisma.aIInteraction.findMany({
        where: { createdAt: { gte: from } },
        select: { feature: true, parseOk: true, feedback: true, latencyMs: true }
      });
      if (rows.length === 0) {
        return "No captured interactions in that window. Capture may be off — it is a privacy toggle in Workspace Settings → AI, and quality figures need it on.";
      }
      const byFeature = new Map<string, { n: number; parsed: number; parseable: number; up: number; down: number; latency: number[] }>();
      for (const r of rows) {
        const e = byFeature.get(r.feature) ?? { n: 0, parsed: 0, parseable: 0, up: 0, down: 0, latency: [] };
        e.n += 1;
        if (r.parseOk !== null) {
          e.parseable += 1;
          if (r.parseOk) e.parsed += 1;
        }
        if (r.feedback === "up") e.up += 1;
        if (r.feedback === "down") e.down += 1;
        if (r.latencyMs) e.latency.push(r.latencyMs);
        byFeature.set(r.feature, e);
      }
      const lines = [...byFeature.entries()].map(([feature, e]) => {
        const median = e.latency.length ? e.latency.sort((a, b) => a - b)[Math.floor(e.latency.length / 2)] : null;
        return (
          `${feature}: ${e.n} calls` +
          (e.parseable > 0 ? `, parsed ${pct(e.parsed, e.parseable)}` : ", no schema to parse") +
          `, ${e.up} up / ${e.down} down` +
          (median ? `, median ${median}ms` : "")
        );
      });
      return `Since ${from.toISOString().slice(0, 10)}:${NL}${lines.join(NL)}`;
    }
  },

  /* ---------------- Email ---------------- */
  {
    name: "email_analytics",
    description:
      "Outbound email: volume, delivery success and failure reasons by template. The tool for 'how many emails went out', 'what is bouncing', 'is mail working'.",
    args: '{ "days"?: number }',
    group: "Email",
    access: SUPER,
    run: async (args) => {
      const from = since(args);
      const rows = await prisma.emailLog.groupBy({
        by: ["template", "status"],
        where: { createdAt: { gte: from } },
        _count: true
      });
      if (rows.length === 0) return "No email sent in that window.";
      const byTemplate = new Map<string, Record<string, number>>();
      for (const r of rows) {
        const e = byTemplate.get(r.template) ?? {};
        e[String(r.status)] = r._count;
        byTemplate.set(r.template, e);
      }
      const totals = rows.reduce<Record<string, number>>((acc, r) => {
        acc[String(r.status)] = (acc[String(r.status)] ?? 0) + r._count;
        return acc;
      }, {});
      const lines = [...byTemplate.entries()]
        .map(([template, statuses]) => `${template}: ${Object.entries(statuses).map(([s, n]) => `${s}=${n}`).join(", ")}`)
        .slice(0, 25);
      // The failure REASONS, deduplicated — the actual question behind "what is bouncing".
      const failures = await prisma.emailLog.findMany({
        where: { createdAt: { gte: from }, status: "FAILED", errorMessage: { not: null } },
        select: { errorMessage: true },
        take: 60
      });
      const reasons = new Map<string, number>();
      for (const f of failures) {
        const key = (f.errorMessage ?? "").split(NL)[0].slice(0, 120);
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
      return (
        `Since ${from.toISOString().slice(0, 10)} — overall ${Object.entries(totals).map(([s, n]) => `${s}=${n}`).join(", ")}:${NL}` +
        lines.join(NL) +
        (reasons.size > 0 ? `${NL}${NL}Failure reasons:${NL}${[...reasons.entries()].map(([r, n]) => `${n}x ${r}`).join(NL)}` : "")
      );
    }
  },
  {
    name: "email_templates",
    description: "The editable outbound email templates: key, subject, and whether each is switched on.",
    args: "{}",
    group: "Email",
    access: SUPER,
    run: async () => {
      const rows = await prisma.emailTemplate.findMany({ select: { key: true, subject: true, enabled: true }, orderBy: { key: "asc" }, take: 60 });
      if (rows.length === 0) return "No templates configured — the seeded defaults apply.";
      return `${rows.length} templates:${NL}${rows.map((t) => `${t.key} (${t.enabled ? "on" : "off"}): ${t.subject}`).join(NL)}`;
    }
  },

  /* ---------------- Operations ---------------- */
  {
    name: "service_health",
    description: "Latest status and latency per monitored service, plus recent degradations. The tool for 'is everything up', 'was anything down'.",
    args: '{ "days"?: number }',
    group: "Operations",
    access: SUPER,
    run: async (args) => {
      const from = since(args, 7);
      const samples = await prisma.serviceHealthSample.findMany({
        where: { checkedAt: { gte: from } },
        select: { service: true, status: true, latencyMs: true, checkedAt: true, detail: true },
        orderBy: { checkedAt: "desc" },
        take: 800
      });
      if (samples.length === 0) return "No health samples recorded in that window.";
      const latest = new Map<string, (typeof samples)[number]>();
      const bad = new Map<string, number>();
      for (const s of samples) {
        if (!latest.has(s.service)) latest.set(s.service, s);
        if (s.status !== "OPERATIONAL") bad.set(s.service, (bad.get(s.service) ?? 0) + 1);
      }
      const lines = [...latest.values()].map(
        (s) => `${s.service}: ${s.status}${s.latencyMs ? ` (${s.latencyMs}ms)` : ""} as of ${s.checkedAt.toISOString().slice(0, 16).replace("T", " ")}` +
          (bad.get(s.service) ? ` — ${bad.get(s.service)} non-operational samples in the window` : "")
      );
      return `Since ${from.toISOString().slice(0, 10)}:${NL}${lines.join(NL)}`;
    }
  },
  {
    name: "api_performance",
    description:
      "Request latency percentiles and the slowest endpoints. The tool for 'what is slow', 'p95 latency', 'which endpoint is worst'. Collection is off by default in this product.",
    args: '{ "days"?: number }',
    group: "Operations",
    access: SUPER,
    run: async (args) => {
      const from = since(args, 7);
      const rows = await prisma.apiRequestSample.findMany({
        where: { apiRequestAt: { gte: from } },
        select: { apiName: true, apiResponseTime: true, statusCode: true },
        take: 5000
      });
      if (rows.length === 0) {
        return "No request samples in that window. API telemetry is off by default and is switched on in the environment, not the UI — an empty result here means 'not recording', not 'nothing served'.";
      }
      const all = rows.map((r) => r.apiResponseTime).sort((a, b) => a - b);
      const at = (p: number) => all[Math.min(all.length - 1, Math.floor(all.length * p))];
      const byEndpoint = new Map<string, number[]>();
      for (const r of rows) {
        const list = byEndpoint.get(r.apiName) ?? [];
        list.push(r.apiResponseTime);
        byEndpoint.set(r.apiName, list);
      }
      const slowest = [...byEndpoint.entries()]
        .map(([name, times]) => ({ name, n: times.length, p95: times.sort((a, b) => a - b)[Math.floor(times.length * 0.95)] ?? 0 }))
        .sort((a, b) => b.p95 - a.p95)
        .slice(0, 8);
      const errors = rows.filter((r) => r.statusCode >= 500).length;
      return (
        `Since ${from.toISOString().slice(0, 10)} — ${rows.length} samples. p50 ${at(0.5)}ms, p95 ${at(0.95)}ms, p99 ${at(0.99)}ms. ${errors} 5xx.${NL}` +
        `Slowest by p95:${NL}${slowest.map((s) => `${s.name}: p95 ${s.p95}ms (${s.n} calls)`).join(NL)}`
      );
    }
  },
  {
    name: "audit_log",
    description: "Recent administrative and approval actions from the tamper-evident audit log. The tool for 'who changed what', 'who approved this'.",
    args: '{ "days"?: number, "action"?: string, "entity"?: string }',
    group: "Operations",
    access: { permission: permissions.AUDIT_VIEW },
    run: async (args) => {
      const from = since(args, 7);
      const rows = await prisma.auditLog.findMany({
        where: {
          createdAt: { gte: from },
          ...(typeof args.action === "string" && args.action ? { action: { contains: args.action } } : {}),
          ...(typeof args.entity === "string" && args.entity ? { entity: { contains: args.entity } } : {})
        },
        select: { action: true, entity: true, createdAt: true, actorLabel: true, actor: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 40
      });
      if (rows.length === 0) return "Nothing in the audit log matched.";
      return rows
        .map((r) => `${r.createdAt.toISOString().slice(0, 16).replace("T", " ")} ${r.actor?.name ?? r.actorLabel ?? "system"} — ${r.action} on ${r.entity}`)
        .join(NL);
    }
  },

  /* ---------------- Security & DevOps ---------------- */
  {
    name: "security_findings",
    description: "Ingested security findings by severity, status and tool. The tool for 'open vulnerabilities', 'what did the scanners find'.",
    args: '{ "status"?: string }',
    group: "Security",
    access: SUPER,
    run: async (args) => {
      // Normalised and checked against the real enum before it reaches Prisma. MEASURED: the model
      // passed a status in its own casing and the raw cast surfaced as "I encountered an error"
      // where a correctable message belonged. A free string cast to `never` is a promise the caller
      // cannot keep — the model writes these arguments, and it writes them the way prose reads.
      const requested = typeof args.status === "string" && args.status.trim() ? args.status.trim().toUpperCase().replace(/[\s-]+/g, "_") : "OPEN";
      const known = ["OPEN", "ACKNOWLEDGED", "FIXED", "ACCEPTED_RISK"];
      if (!known.includes(requested)) return `"${args.status}" is not a finding status. Use one of: ${known.join(", ")}.`;
      const rows = await prisma.securityFinding.groupBy({
        by: ["severity", "type"],
        where: { status: requested as never },
        _count: true
      });
      if (rows.length === 0) return `No ${requested.toLowerCase()} findings.`;
      const total = rows.reduce((sum, r) => sum + r._count, 0);
      return `${total} ${requested.toLowerCase().replace("_", " ")} findings:${NL}${rows.map((r) => `${r.severity} / ${r.type}: ${r._count}`).join(NL)}`;
    }
  },
  {
    name: "ci_runs",
    description: "Recent ingested CI test runs — pass/fail counts by provider. The tool for 'is CI green', 'what is failing in the pipeline'.",
    args: '{ "days"?: number }',
    group: "Security",
    access: SUPER,
    run: async (args) => {
      const from = since(args, 14);
      const rows = await prisma.testRun.groupBy({ by: ["provider", "status"], where: { createdAt: { gte: from } }, _count: true });
      if (rows.length === 0) return "No CI runs ingested in that window. Nobody reporting is not the same as everything passing.";
      return rows.map((r) => `${r.provider} ${r.status}: ${r._count}`).join(NL);
    }
  },
  {
    name: "face_verification_stats",
    description:
      "Identity-check outcomes — passed, no match, no face, liveness and challenge failures. The tool for 'is face verification working', 'how many checks failed'. Metadata only; no images.",
    args: '{ "days"?: number }',
    group: "Security",
    access: SUPER,
    run: async (args) => {
      const from = since(args);
      const rows = await prisma.faceVerificationAttempt.groupBy({ by: ["outcome", "context"], where: { createdAt: { gte: from } }, _count: true });
      if (rows.length === 0) return "No identity checks in that window.";
      const total = rows.reduce((s, r) => s + r._count, 0);
      const passed = rows.filter((r) => r.outcome === "PASSED").reduce((s, r) => s + r._count, 0);
      return `${total} checks, ${pct(passed, total)} passed:${NL}${rows.map((r) => `${r.context} / ${r.outcome}: ${r._count}`).join(NL)}`;
    }
  },

  /* ---------------- Configuration ---------------- */
  {
    name: "workspace_configuration",
    description:
      "Which features are switched on for this workspace — AI capabilities, ticketing rules, planning, change management, notifications, intake, chat platforms, git. The tool for 'is X enabled', 'what is turned on'.",
    args: "{}",
    group: "Configuration",
    access: SUPER,
    run: async () => {
      const [ai, tickets, planning, change, intake, chat, git, face] = await Promise.all([
        prisma.globalAISettings.findFirst(),
        prisma.globalTicketSettings.findFirst(),
        prisma.globalPlanningSettings.findFirst(),
        prisma.globalChangeSettings.findFirst(),
        prisma.ingestionSettings.findFirst(),
        prisma.chatIntegration.findMany({ select: { platform: true, isEnabled: true } }),
        prisma.gitConnection.findMany({ select: { provider: true, connectedAt: true } }),
        prisma.globalFaceVerificationSettings.findFirst()
      ]);
      const onOff = (v: unknown) => (v ? "on" : "off");
      const lines: string[] = [];
      if (ai) {
        // The toggles, listed generically: hand-maintaining this list would guarantee it goes stale
        // the next time a capability ships.
        const flags = Object.entries(ai)
          .filter(([k, v]) => typeof v === "boolean" && k.endsWith("Enabled"))
          .map(([k, v]) => `${k.replace(/Enabled$/, "")}=${onOff(v)}`);
        lines.push(`AI: provider ${ai.provider}, model ${ai.model}, key ${ai.apiKey ? "set" : "not set"}`);
        lines.push(`AI capabilities: ${flags.join(", ")}`);
      }
      if (tickets) lines.push(`Ticketing: ${Object.entries(tickets).filter(([k, v]) => typeof v === "boolean").map(([k, v]) => `${k}=${onOff(v)}`).join(", ")}`);
      if (planning) lines.push(`Planning: ${Object.entries(planning).filter(([k, v]) => typeof v === "boolean").map(([k, v]) => `${k}=${onOff(v)}`).join(", ")}`);
      if (change) lines.push(`Change management: enabled=${onOff(change.enableChangeManagement)}, approval SLA ${change.approvalSlaHours}h`);
      if (intake)
        lines.push(
          `DevOps ingestion: auto-reopen=${onOff(intake.autoReopenEnabled)}, CODEOWNERS assign=${onOff(intake.codeownersAssignEnabled)}, auto-ticket on CI failure=${onOff(intake.autoCreateTicketOnCiFailureEnabled)}`
        );
      lines.push(`Chat platforms: ${chat.length ? chat.map((c) => `${c.platform}=${onOff(c.isEnabled)}`).join(", ") : "none configured"}`);
      lines.push(`Git: ${git.length ? git.map((g) => `${g.provider} connected ${g.connectedAt?.toISOString().slice(0, 10) ?? "?"}`).join(", ") : "not connected"}`);
      if (face) lines.push(`Face verification: enabled=${onOff(face.enabled)}`);
      return lines.join(NL);
    }
  },
  {
    name: "user_stats",
    description: "Headcount by role and status, and who has not signed in recently. The tool for 'how many users', 'who is inactive'.",
    args: "{}",
    group: "People",
    access: { permission: permissions.USERS_MANAGE },
    run: async () => {
      const rows = await prisma.user.groupBy({ by: ["status"], where: { deletedAt: null, isAgent: false }, _count: true });
      const byRole = await prisma.user.findMany({
        where: { deletedAt: null, isAgent: false },
        select: { role: { select: { name: true } } }
      });
      const roleCounts = new Map<string, number>();
      for (const u of byRole) roleCounts.set(u.role.name, (roleCounts.get(u.role.name) ?? 0) + 1);
      return (
        `By status: ${rows.map((r) => `${r.status}=${r._count}`).join(", ")}${NL}` +
        `By role: ${[...roleCounts.entries()].map(([r, n]) => `${r}=${n}`).join(", ")}`
      );
    }
  },

  /* ---------------- Delivery ---------------- */
  {
    name: "sla_and_escalations",
    description: "Timesheet escalations and ticket SLA breaches. The tool for 'what has breached', 'how many escalations'.",
    args: '{ "days"?: number }',
    group: "Delivery",
    access: { permission: permissions.REPORTS_VIEW },
    run: async (args) => {
      const from = since(args);
      const [escalations, unresolved, breached] = await Promise.all([
        prisma.escalation.count({ where: { createdAt: { gte: from } } }),
        prisma.escalation.count({ where: { createdAt: { gte: from }, resolvedAt: null } }),
        prisma.ticket.count({ where: { deletedAt: null, dueAt: { lt: new Date() }, status: { notIn: ["RESOLVED", "CLOSED"] } } })
      ]);
      return (
        `Since ${from.toISOString().slice(0, 10)}: ${escalations} timesheet escalations (${unresolved} still unresolved).${NL}` +
        `Tickets past their SLA due date and not yet resolved: ${breached}.`
      );
    }
  },
  {
    name: "automation_activity",
    description: "Recent agent runs and workflow firings, with their outcomes. The tool for 'what have the agents been doing', 'did my workflow run'.",
    args: '{ "days"?: number }',
    group: "Automation",
    access: SUPER,
    run: async (args) => {
      const from = since(args, 14);
      const [agentRuns, flowRuns] = await Promise.all([
        prisma.agentRun.groupBy({ by: ["status"], where: { createdAt: { gte: from } }, _count: true }),
        prisma.automationFlowRun.findMany({
          where: { startedAt: { gte: from } },
          select: { trigger: true, status: true, flow: { select: { name: true } } },
          orderBy: { startedAt: "desc" },
          take: 30
        })
      ]);
      const agentLine = agentRuns.length ? `Agent runs: ${agentRuns.map((r) => `${r.status}=${r._count}`).join(", ")}` : "No agent runs in that window.";
      if (flowRuns.length === 0) return `${agentLine}${NL}No workflow runs in that window.`;
      const byFlow = new Map<string, Record<string, number>>();
      for (const r of flowRuns) {
        const e = byFlow.get(r.flow.name) ?? {};
        e[String(r.status)] = (e[String(r.status)] ?? 0) + 1;
        byFlow.set(r.flow.name, e);
      }
      return (
        `${agentLine}${NL}Workflow runs:${NL}` +
        [...byFlow.entries()].map(([name, statuses]) => `${name}: ${Object.entries(statuses).map(([s, n]) => `${s}=${n}`).join(", ")}`).join(NL)
      );
    }
  }
];
