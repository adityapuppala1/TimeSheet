/**
 * WHAT: builds the aggregated "security & test status" view for a single ticket — every
 * ingested `SecurityFinding` (SAST/DAST/SSAT/SSCT — see prisma/schema.prisma's header comment
 * on that model) plus the latest `TestRun`, and sends the ticket-closed digest email built from
 * that same data.
 * WHY one shared builder instead of two separate queries: the PDF export
 * (ticket.controller.ts's `GET /:id/security-report.pdf`) and the ticket-closed digest email
 * must never drift on what "the report" contains — both call `buildTicketSecurityReport`.
 * WHY the digest is its own function here rather than inline in ticket.controller.ts: sending it
 * needs three separate tenant-scoped queries (closer's manager, this org's admins, the report
 * itself) plus real Cc support that `dispatchNotification` doesn't have (see notify.service.ts) —
 * enough moving parts to warrant its own file rather than bloating the status-change handler.
 * WHO calls this: ticket.controller.ts (the PDF route, and the `PATCH /:id/status` handler when
 * a ticket closes).
 */
import { ticketStatusTransitions, type SecurityFindingSeverity, type SecurityFindingType, type TicketPriority, type TicketStatus } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { classifyCiFailure } from "./ai.service.js";
import { audit } from "./audit.service.js";
import { fetchGitHubCodeowners, fetchGitHubLastCommitAuthor, parseCodeownersOwners } from "./git-provider.service.js";
import { dispatchNotification, dispatchTransactional, getGlobalNotificationSettings, templates } from "./notify.service.js";
import { computeTicketDueDate, getGlobalTicketSettings, issueTicketKey } from "./ticket.service.js";
import { decryptSecret } from "../utils/encryption.js";

/** Mirrors EMAIL_INTAKE_SYSTEM_EMAIL/CHAT_INTAKE_SYSTEM_EMAIL — a dedicated, unusable-password
 *  system account that satisfies Ticket.reporterId's required FK for findings-sourced tickets.
 *  Nobody is meant to log in as this account. See prisma/seed.ts for where it's created. */
export const SECURITY_INGESTION_SYSTEM_EMAIL = "security-ingestion@system.local";

const SEVERITY_TO_PRIORITY: Record<SecurityFindingSeverity, TicketPriority> = {
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW"
};

const SEVERITY_ORDER: SecurityFindingSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const TYPE_LABEL: Record<SecurityFindingType, string> = {
  SAST: "Static analysis (SAST)",
  DAST: "Dynamic analysis (DAST)",
  SSAT: "Secrets scanning (SSAT)",
  SSCT: "Supply-chain testing (SSCT)",
  VAPT: "Penetration test (VAPT)"
};

export interface TicketSecurityReport {
  ticket: { id: string; key: string; title: string };
  findings: Awaited<ReturnType<typeof prisma.securityFinding.findMany>>;
  findingsByType: Record<SecurityFindingType, Awaited<ReturnType<typeof prisma.securityFinding.findMany>>>;
  openCountBySeverity: Record<SecurityFindingSeverity, number>;
  latestTestRun: Awaited<ReturnType<typeof prisma.testRun.findFirst>> | null;
  /** One-line human summary — the first thing a reviewer reads, on both the PDF and the email. */
  riskVerdict: string;
  generatedAt: Date;
}

export async function buildTicketSecurityReport(ticketId: string): Promise<TicketSecurityReport> {
  const ticket = await prisma.ticket.findFirstOrThrow({
    where: { id: ticketId },
    select: { id: true, key: true, title: true }
  });

  const [findings, latestTestRun] = await Promise.all([
    prisma.securityFinding.findMany({ where: { ticketId }, orderBy: [{ severity: "asc" }, { createdAt: "desc" }] }),
    prisma.testRun.findFirst({ where: { ticketId }, orderBy: { createdAt: "desc" } })
  ]);

  const findingsByType = Object.fromEntries(
    (["SAST", "DAST", "SSAT", "SSCT", "VAPT"] as SecurityFindingType[]).map((type) => [type, findings.filter((f) => f.type === type)])
  ) as Record<SecurityFindingType, typeof findings>;

  const openFindings = findings.filter((f) => f.status === "OPEN" || f.status === "ACKNOWLEDGED");
  const openCountBySeverity = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [severity, openFindings.filter((f) => f.severity === severity).length])
  ) as Record<SecurityFindingSeverity, number>;

  const riskVerdict = buildRiskVerdict(openCountBySeverity, latestTestRun?.status ?? null);

  return {
    ticket,
    findings,
    findingsByType,
    openCountBySeverity,
    latestTestRun,
    riskVerdict,
    generatedAt: new Date()
  };
}

function buildRiskVerdict(bySeverity: Record<SecurityFindingSeverity, number>, testStatus: string | null): string {
  const parts: string[] = [];
  if (bySeverity.CRITICAL > 0) parts.push(`${bySeverity.CRITICAL} open CRITICAL finding${bySeverity.CRITICAL === 1 ? "" : "s"}`);
  if (bySeverity.HIGH > 0) parts.push(`${bySeverity.HIGH} open HIGH finding${bySeverity.HIGH === 1 ? "" : "s"}`);
  if (testStatus === "FAILED") parts.push("latest test run FAILED");

  if (parts.length > 0) return `Needs attention — ${parts.join(", ")}.`;
  if (bySeverity.MEDIUM > 0 || bySeverity.LOW > 0) return "No blocking findings — only MEDIUM/LOW items open.";
  return "Clean — no open findings, latest test run passed or none required.";
}

/** Plain-text findings list for the email body (the PDF export renders the same data with layout). */
function renderFindingsText(report: TicketSecurityReport): string {
  if (report.findings.length === 0) return "No findings have been ingested for this ticket.";
  return (["SAST", "DAST", "SSAT", "SSCT", "VAPT"] as SecurityFindingType[])
    .map((type) => {
      const items = report.findingsByType[type];
      if (items.length === 0) return null;
      const lines = items
        .slice(0, 10)
        .map((f) => `  - [${f.severity}] ${f.title} (${f.tool}${f.status !== "OPEN" ? `, ${f.status}` : ""})`)
        .join("\n");
      return `${TYPE_LABEL[type]}:\n${lines}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * HTML-safe rendering of the same data `renderFindingsText` returns as plain text — used only
 * for the `vars.findingsText` passed to `dispatchTransactional` (services/notify.service.ts),
 * because that path substitutes `{{findingsText}}` into a DB-stored template via `applyVars()`
 * (services/template-store.service.ts) with NO escaping of its own. Finding titles/tools
 * originate from an external CI/security tool via the ingest webhook (a Bearer-token-
 * authenticated but otherwise untrusted caller — see devops-webhook.controller.ts) — leaving
 * this unescaped would let a malicious or misconfigured scanner inject arbitrary HTML into
 * every recipient's digest email. `mail-templates.ts#ticketClosedDigest` (the compiled fallback
 * used when no DB override exists) already does its own escaping internally, so it calls
 * `renderFindingsText` directly, not this function.
 */
function renderFindingsHtml(report: TicketSecurityReport): string {
  return escapeHtml(renderFindingsText(report)).replace(/\n/g, "<br />");
}

/**
 * Fires from ticket.controller.ts when a ticket transitions to CLOSED. Sends exactly one email
 * — closer + their manager as primary recipients (a real multi-address `to`, not two separate
 * sends), every ADMIN/SUPER_ADMIN in *this ticket's own tenant* as Cc. That admin list is
 * queried through the already tenant-scoped `prisma` import (see config/prisma.ts's Proxy) —
 * there is no cross-tenant admin table this query could reach even if it wanted to, which is
 * what makes "only this org's team" a structural guarantee here rather than a filter that could
 * have a bug in it.
 */
export async function sendTicketClosedDigest(
  ticket: { id: string; key: string; title: string },
  closer: { id: string; name: string; email: string }
): Promise<void> {
  const settings = await getGlobalNotificationSettings();
  if (!settings.emailTicketClosedDigest) return;

  const report = await buildTicketSecurityReport(ticket.id);
  // No point emailing a digest with nothing to report — keeps this opt-in feature from adding
  // noise to orgs that haven't connected a scan source for this particular ticket/project yet.
  if (report.findings.length === 0 && !report.latestTestRun) return;

  const { orgSlug } = requireTenantContext();

  const [closerRow, admins] = await Promise.all([
    prisma.user.findUnique({
      where: { id: closer.id },
      select: { manager: { select: { id: true, name: true, email: true, status: true, deletedAt: true } } }
    }),
    prisma.user.findMany({
      where: { status: "ACTIVE", deletedAt: null, role: { name: { in: ["ADMIN", "SUPER_ADMIN"] } } },
      select: { id: true, email: true }
    })
  ]);

  const manager = closerRow?.manager && closerRow.manager.status === "ACTIVE" && !closerRow.manager.deletedAt ? closerRow.manager : null;

  const toAddresses = Array.from(new Set([closer.email, manager?.email].filter((e): e is string => Boolean(e))));
  const ccAddresses = admins.map((a) => a.email);

  // In-app bell notifications for the closer + manager — no email attached here, the combined
  // digest below is the actual delivery; this just keeps the notification center consistent
  // with every other ticket event.
  for (const recipientId of [closer.id, manager?.id].filter((id): id is string => Boolean(id))) {
    await dispatchNotification({
      userId: recipientId,
      category: "ticket.closed_digest",
      title: `Security digest: ${ticket.key}`,
      body: report.riskVerdict,
      link: `/app/tickets?open=${ticket.id}`
    });
  }

  await dispatchTransactional({
    to: toAddresses.join(", "),
    cc: ccAddresses,
    templateKey: "ticket.closed_digest",
    vars: {
      ticketKey: ticket.key,
      title: ticket.title,
      closedBy: closer.name,
      riskVerdict: report.riskVerdict,
      findingsText: renderFindingsHtml(report),
      testStatus: report.latestTestRun?.status ?? "No test runs recorded",
      orgSlug
    },
    fallback: {
      subject: `[${ticket.key}] Security digest — ${report.riskVerdict}`,
      html: templates.ticketClosedDigest({
        ticketKey: ticket.key,
        title: ticket.title,
        closedBy: closer.name,
        riskVerdict: report.riskVerdict,
        findingsText: renderFindingsText(report),
        testStatus: report.latestTestRun?.status ?? "No test runs recorded"
      })
    }
  });
}

/**
 * Fires from devops-webhook.controller.ts right after a finding is stored, only when it arrived
 * with no `ticketKey` (nothing to attach it to) and is CRITICAL/HIGH severity. High-confidence
 * by construction — the scanning tool already did the classification, so unlike email/chat
 * intake this skips the AI-triage `needsReview` gate entirely; a finding is not an ambiguous
 * natural-language message an AI had to guess at.
 *
 * Requires `IngestionSettings.fallbackProjectId` to be configured (Workspace Settings →
 * Security & DevOps) — with no fallback project, there's nowhere to put the ticket, so this is
 * a no-op and the finding is simply left ticket-less (still visible via its own record).
 */
export async function maybeAutoCreateTicketForFinding(finding: {
  id: string;
  type: SecurityFindingType;
  tool: string;
  severity: SecurityFindingSeverity;
  title: string;
  description: string | null;
  filePath: string | null;
  lineNumber: number | null;
  repository: string | null;
  branch: string | null;
  prUrl: string | null;
}): Promise<void> {
  if (finding.severity !== "CRITICAL" && finding.severity !== "HIGH") return;

  const ingestionSettings = await prisma.ingestionSettings.findUnique({ where: { id: "global" } });
  const projectId = ingestionSettings?.fallbackProjectId;
  if (!projectId) return;

  const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, include: { modules: true } });
  if (!project) return;

  const systemUser = await prisma.user.findUnique({ where: { email: SECURITY_INGESTION_SYSTEM_EMAIL } });
  if (!systemUser) return; // Seed hasn't run yet — fail quiet, not loud, same as the ticket-less fallback above.

  // "SECURITY" if an admin has added it as an active ticket type, else fall back to the
  // always-seeded "BUG" — ticket types are a free-text, admin-editable list (see
  // ticket.service.ts#assertValidTicketType), not a fixed enum, so nothing guarantees "SECURITY"
  // exists in a given workspace.
  const securityType = await prisma.ticketType.findFirst({ where: { name: "SECURITY", isActive: true } });
  const type = securityType?.name ?? "BUG";

  const priority = SEVERITY_TO_PRIORITY[finding.severity];
  const slaSettings = await getGlobalTicketSettings();
  const createdAt = new Date();

  const locationLine = finding.filePath ? `${finding.filePath}${finding.lineNumber ? `:${finding.lineNumber}` : ""}` : null;
  const description = [
    finding.description,
    locationLine ? `File: ${locationLine}` : null,
    finding.repository ? `Repository: ${finding.repository}${finding.branch ? ` (${finding.branch})` : ""}` : null,
    finding.prUrl ? `PR: ${finding.prUrl}` : null,
    `Detected by ${finding.tool} (${finding.type}).`
  ]
    .filter(Boolean)
    .join("\n\n");

  const ticket = await prisma.$transaction(async (tx) => {
    const key = await issueTicketKey(tx, project.id);
    return tx.ticket.create({
      data: {
        key,
        projectId: project.id,
        type,
        title: `[${finding.severity}] ${finding.title}`,
        description,
        priority,
        source: "API",
        reporterId: systemUser.id,
        aiConfidence: null,
        needsReview: false,
        dueAt: computeTicketDueDate(createdAt, priority, slaSettings)
      }
    });
  });

  await prisma.securityFinding.update({ where: { id: finding.id }, data: { ticketId: ticket.id } });

  async function notifyAutoAssigned(assignee: { id: string; name: string }, via: string): Promise<void> {
    await dispatchNotification({
      userId: assignee.id,
      category: "ticket.assigned",
      title: `Ticket assigned: ${ticket.key}`,
      body: `Auto-assigned (${via}) from an ingested ${finding.severity} ${finding.type} finding: "${ticket.title}".`,
      link: `/app/tickets?open=${ticket.id}`,
      email: {
        templateKey: "ticket.assigned",
        vars: { assigneeName: assignee.name, ticketKey: ticket.key, title: ticket.title, priority, assignedBy: "Security Ingestion" },
        fallback: {
          subject: `Ticket ${ticket.key} assigned to you`,
          html: templates.ticketAssigned({ assigneeName: assignee.name, ticketKey: ticket.key, title: ticket.title, priority, assignedBy: "Security Ingestion" })
        }
      }
    });
  }

  // Auto-assign the same way email intake does — via the fallback project's own
  // ModuleAssigneeRule, if one of its modules has a default assignee configured. No specific
  // module is implied by a finding, so this checks every module on the fallback project and
  // uses the first configured rule found, rather than requiring the finding to name one.
  const moduleWithRule = await prisma.moduleAssigneeRule.findFirst({
    where: { moduleId: { in: project.modules.map((m) => m.id) } }
  });
  if (moduleWithRule) {
    await prisma.ticket.update({ where: { id: ticket.id }, data: { assigneeId: moduleWithRule.defaultAssigneeId, moduleId: moduleWithRule.moduleId } });
    const assignee = await prisma.user.findUnique({ where: { id: moduleWithRule.defaultAssigneeId }, select: { id: true, name: true } });
    if (assignee) await notifyAutoAssigned(assignee, "module rule");
  } else {
    // No module-level rule configured — fall back to CODEOWNERS/last-committer resolution
    // (opt-in: only runs when IngestionSettings.codeownersAssignEnabled is on, since it makes a
    // live GitHub API call per unmatched finding and needs User.githubUsername populated to be
    // useful at all).
    const ingestionSettings = await prisma.ingestionSettings.findUnique({ where: { id: "global" } });
    if (ingestionSettings?.codeownersAssignEnabled) {
      const codeownerAssignee = await maybeAssignFindingViaCodeowners(finding).catch((error) => {
        console.warn(`[security-report] CODEOWNERS assignment lookup failed for finding ${finding.id}: ${(error as Error).message}`);
        return null;
      });
      if (codeownerAssignee) {
        await prisma.ticket.update({ where: { id: ticket.id }, data: { assigneeId: codeownerAssignee.id } });
        await notifyAutoAssigned(codeownerAssignee, "CODEOWNERS/last committer");
      }
    }
  }
}

/**
 * Fallback assignee resolution for an auto-created security ticket when no `ModuleAssigneeRule`
 * matched — tries the finding's repo CODEOWNERS entry for its `filePath` first, then the last
 * GitHub committer on that file, mapping either's GitHub login to a TimeSphere user via
 * `User.githubUsername` (falling back to matching the last-committer's commit-author email
 * against `User.email`, since not every committer necessarily has a linked GitHub login set on
 * their TimeSphere account). Requires this org to have a live `GitConnection` (Workspace
 * Settings → Security & DevOps → Git provider) — a no-op, not an error, if one isn't connected,
 * consistent with every other "requires optional config" gate in this pipeline. Modeled on how
 * GitHub's own code-scanning alert assignment resolves an owner — see docs/ROADMAP.md's
 * "Competitive parity" section.
 */
export async function maybeAssignFindingViaCodeowners(finding: {
  repository: string | null;
  branch: string | null;
  filePath: string | null;
}): Promise<{ id: string; name: string } | null> {
  if (!finding.repository || !finding.filePath) return null;

  const connection = await prisma.gitConnection.findUnique({ where: { id: "global" } });
  if (!connection?.encryptedAccessToken) return null;
  const accessToken = decryptSecret(connection.encryptedAccessToken);

  const codeowners = await fetchGitHubCodeowners(accessToken, finding.repository, finding.branch ?? undefined).catch(() => null);
  if (codeowners) {
    const owners = parseCodeownersOwners(codeowners, finding.filePath);
    for (const owner of owners) {
      // Strips a leading "@" and, for team entries ("@org/team-slug"), keeps only the trailing
      // segment as a best-effort individual-handle match — this pass doesn't resolve team
      // membership, only direct @handle owners; a team-only CODEOWNERS line falls through to
      // the last-committer fallback below instead of silently matching the wrong person.
      const handle = owner.replace(/^@/, "").split("/").pop();
      if (!handle || owner.includes("/")) continue;
      const user = await prisma.user.findFirst({
        where: { githubUsername: handle, status: "ACTIVE", deletedAt: null },
        select: { id: true, name: true }
      });
      if (user) return user;
    }
  }

  const lastCommit = await fetchGitHubLastCommitAuthor(accessToken, finding.repository, finding.filePath, finding.branch ?? undefined).catch(
    () => null
  );
  if (lastCommit?.login) {
    const user = await prisma.user.findFirst({
      where: { githubUsername: lastCommit.login, status: "ACTIVE", deletedAt: null },
      select: { id: true, name: true }
    });
    if (user) return user;
  }
  if (lastCommit?.email) {
    const user = await prisma.user.findFirst({
      where: { email: lastCommit.email, status: "ACTIVE", deletedAt: null },
      select: { id: true, name: true }
    });
    if (user) return user;
  }

  return null;
}

/**
 * Fires from devops-webhook.controller.ts's /test-runs route on a FAILED run, and its /findings
 * route on a new/reintroduced finding, whenever either references a ticket. If that ticket is
 * currently RESOLVED/CLOSED and `IngestionSettings.autoReopenEnabled` is on, transitions it back
 * to REOPENED — the one place in this app an automated process changes ticket state with no
 * human click, which is exactly why it's its own explicit opt-in (not folded into any other
 * toggle) and always stamps an audit-log entry + notifies the assignee, matching the "every
 * automated decision is auditable" principle the rest of the AI surface already follows.
 * Deterministic — matches on the CI-supplied ticketKey directly, no AI call involved (that's
 * classifyCiFailure below, a separate opt-in). `reason` is a short human-readable trigger
 * description (e.g. "A failed github-actions test run", "A new CRITICAL SAST finding from
 * semgrep") — shown verbatim in the audit log and the assignee's notification, so whoever's
 * looking at "why did this reopen" always sees the actual regression source, not a generic label.
 * Mirrors Black Duck's Jira-plugin auto-reopen-on-policy-violation behavior — see
 * docs/ROADMAP.md's "Competitive parity" section for the full comparison this was modeled on.
 */
export async function maybeReopenTicketOnRegression(ticketId: string, reason: string): Promise<void> {
  const settings = await prisma.ingestionSettings.findUnique({ where: { id: "global" } });
  if (!settings?.autoReopenEnabled) return;

  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null } });
  if (!ticket) return;
  if (ticket.status !== "RESOLVED" && ticket.status !== "CLOSED") return;

  const currentStatus = ticket.status as TicketStatus;
  const allowed = ticketStatusTransitions[currentStatus] ?? [];
  if (!allowed.includes("REOPENED")) return; // stays consistent with the one source of truth for legal transitions, even though both current states already allow it

  await prisma.ticket.update({ where: { id: ticket.id }, data: { status: "REOPENED", resolvedAt: null, closedAt: null } });
  await audit(undefined, "ticket.auto_reopened", "Ticket", ticket.id, { reason, from: currentStatus });

  if (ticket.assigneeId) {
    await dispatchNotification({
      userId: ticket.assigneeId,
      category: "ticket.status_changed",
      title: `${ticket.key} auto-reopened`,
      body: `${reason} reopened this ticket automatically.`,
      link: `/app/tickets?open=${ticket.id}`
    });
  }
}

/**
 * Fires alongside maybeReopenTicketOnRegression when the CI job also supplied a raw failure-log
 * excerpt — posts a one-paragraph AI root-cause/severity summary as a ticket comment, authored
 * by the same system account findings-sourced tickets use. `classifyCiFailure` (ai.service.ts)
 * does its own enabled/budget preflight and throws if `ciFailureTriageEnabled` is off — the
 * caller in devops-webhook.controller.ts already wraps this in a `.catch()` that just logs, so
 * a disabled toggle here is a silent no-op, not an ingestion failure.
 */
export async function maybePostCiFailureTriageComment(
  ticketId: string,
  failureText: string,
  provider: string,
  ticketKey?: string
): Promise<void> {
  const systemUser = await prisma.user.findUnique({ where: { email: SECURITY_INGESTION_SYSTEM_EMAIL } });
  if (!systemUser) return;

  const result = await classifyCiFailure({ failureText, provider, ticketKey });
  const body = [
    `<p><strong>AI CI-failure triage</strong> (${escapeHtml(provider)}):</p>`,
    `<p>${escapeHtml(result.rootCause)}</p>`,
    `<p>Severity: <strong>${result.severity}</strong>${result.isLikelyFlaky ? " — this looks like it could be a flaky test rather than a real regression." : ""}</p>`
  ].join("");

  await prisma.ticketComment.create({ data: { ticketId, authorId: systemUser.id, body } });
}
