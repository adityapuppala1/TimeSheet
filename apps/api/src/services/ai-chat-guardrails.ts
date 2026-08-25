/**
 * WHAT: the rules that decide what the Ask AI assistant may see, may do, and may say back — in one
 * place, so there is exactly one thing to audit rather than a rule per tool.
 *
 * THE CENTRAL ONE, and the reason this file exists: A TOOL IS FILTERED TWICE. `visibleTools` decides
 * what goes into the prompt, and `assertToolAllowed` decides what may actually run. Filtering only
 * the prompt would be security by suggestion — a model that hallucinates a tool name it never saw,
 * or is talked into one by injected text, would reach a real query. Filtering only at execution
 * would be correct but wasteful and confusing: the model would keep proposing tools it is refused,
 * burn steps on them, and tell the person it "tried". Both, from one predicate, is the house style
 * — the same redundancy the AI budget and the MCP disabled-tool gate already use.
 *
 * WHY ACCESS IS EXPRESSED AS THE APP'S OWN PERMISSIONS: every gate here names a permission the
 * pages already enforce (`reports:view`, `audit:view`, `users:manage`) or the super-admin role.
 * Inventing a parallel vocabulary for the chat would mean two answers to "who can see spend", and
 * the day they disagree the chat is the one that over-shares. A tool that reads something no page
 * exposes below super admin is marked superAdminOnly and says so.
 *
 * WHAT IS DELIBERATELY NOT HERE: prompt-level scope enforcement ("is this question about the
 * workspace"). That is a judgement, not a predicate, and it lives in the prompt. This file handles
 * what is decidable: identity, permission, secrets, and volume.
 */
import { permissions } from "@timesheet/shared";
import { redactSecrets } from "./ai.service.js";

/** Who is asking. The shape both the registry and the loop already carry. */
export interface ChatActor {
  id: string;
  role: string;
  permissions: string[];
}

/**
 * What a tool needs before it may be offered or run.
 *
 * `null` access means any signed-in person who can reach the page at all — which is already gated
 * on `tickets:view` at the route. Everything else names a real permission or the super-admin role.
 */
export interface ToolAccess {
  /** A permission constant from @timesheet/shared. */
  permission?: string;
  /** Reserved for cross-workspace operational data — spend, health, security, other people's mail. */
  superAdminOnly?: boolean;
}

export interface AccessibleTool {
  readonly name: string;
  readonly description: string;
  readonly args: string;
  /** The area this belongs to, for the "what can it do" panel. */
  readonly group: string;
  readonly access?: ToolAccess;
  /** True for the registry that writes. Surfaced in the UI so the distinction is visible. */
  readonly acts?: boolean;
}

const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN"]);

/** The one predicate. Both the prompt filter and the execution gate call this and nothing else. */
export function canUseTool(tool: AccessibleTool, actor: ChatActor): boolean {
  const access = tool.access;
  if (!access) return true;
  if (access.superAdminOnly && !PRIVILEGED_ROLES.has(actor.role)) return false;
  if (access.permission && !actor.permissions.includes(access.permission)) return false;
  return true;
}

/** What this person's prompt is allowed to mention. */
export function visibleTools<T extends AccessibleTool>(tools: readonly T[], actor: ChatActor): T[] {
  return tools.filter((t) => canUseTool(t, actor));
}

/**
 * The execution gate. Throws rather than returning a message, because reaching here means the model
 * asked for something it was never shown — a hallucinated name, or one suggested by injected text —
 * and that is worth surfacing as a refusal in the run rather than a quiet empty result.
 */
export function assertToolAllowed(tool: AccessibleTool, actor: ChatActor): void {
  if (!canUseTool(tool, actor)) {
    throw new Error(
      `"${tool.name}" is not available to this person's role. Tell them this needs ${
        tool.access?.superAdminOnly ? "a super admin" : `the ${tool.access?.permission} permission`
      }, and answer what you can without it.`
    );
  }
}

/** The human-readable "why" for a refused tool, used by the capabilities panel. */
export function accessLabel(tool: AccessibleTool): string {
  if (!tool.access) return "Everyone";
  if (tool.access.superAdminOnly) return "Super admin";
  const named: Record<string, string> = {
    [permissions.REPORTS_VIEW]: "Reports access",
    [permissions.AUDIT_VIEW]: "Audit access",
    [permissions.USERS_MANAGE]: "User management",
    [permissions.TICKETS_MANAGE]: "Ticket management",
    [permissions.TIMESHEETS_APPROVE]: "Approver"
  };
  return named[tool.access.permission ?? ""] ?? tool.access.permission ?? "Everyone";
}

/* ------------------------------------------------------------------ *
 * Output handling
 * ------------------------------------------------------------------ */

/** Hard ceiling on one tool's contribution to the prompt. A tool that returns a wall of rows
 *  crowds out the question and every earlier result. */
const RESULT_CHAR_CAP = 2400;

/**
 * Everything a tool returns passes through here on its way into the prompt.
 *
 * TWO JOBS. First, secrets: tool output can carry a scanner finding whose title IS the leaked
 * credential, or a CI log line printing a token — `redactSecrets` is the same masking the AI capture
 * layer already applies for exactly that reason, and a chat prompt leaves the building the same way
 * a captured interaction does. Second, volume: one cap, applied once, rather than each tool
 * remembering to clip itself.
 */
export function sanitiseToolResult(raw: string): string {
  const redacted = redactSecrets(raw);
  return redacted.length > RESULT_CHAR_CAP ? `${redacted.slice(0, RESULT_CHAR_CAP)}\n…(truncated)` : redacted;
}
