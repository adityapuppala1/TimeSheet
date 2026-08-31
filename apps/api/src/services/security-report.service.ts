/**
 * WHAT: builds the aggregated "security & test status" view for a single ticket — every
 * ingested `SecurityFinding` (SAST/DAST/SSAT/SSCT — see prisma/schema.prisma's header comment
 * on that model) plus the latest `TestRun`, and sends the two security digest emails built from
 * that same data.
 * WHY one shared builder instead of two separate queries: the PDF export
 * (ticket.controller.ts's `GET /:id/security-report.pdf`) and the digest emails
 * must never drift on what "the report" contains — all of them call `buildTicketSecurityReport`.
 * WHY the digests are their own functions here rather than inline in ticket.controller.ts: sending
 * one needs several separate tenant-scoped queries (the closer's manager, this org's admins, the
 * report itself) plus real Cc support that `dispatchNotification` doesn't have (see
 * notify.service.ts) — enough moving parts to warrant its own file rather than bloating the
 * status-change handler.
 * WHO calls this: ticket.controller.ts (the PDF route, and the `PATCH /:id/status` handler when
 * a ticket resolves or closes), devops-webhook.controller.ts (the verdict, on every ingested scan),
 * and workers/verification-sweep.worker.ts (the grace window).
 *
 * ── VERIFIED REMEDIATION, in one place ────────────────────────────────────────────────────────
 *
 * Three functions, in the order a fix travels through them:
 *
 *   1. `markFindingsAwaitingVerification` — a ticket resolved or closed, so its still-open findings
 *      become a CLAIM (`PENDING_VERIFICATION` / `AWAITING_PROOF`) rather than a conclusion.
 *   2. `verifyFindingsAgainstScanRun` — the next scan by the SAME TOOL on the same repo+branch is
 *      the only thing that can settle that claim, either way.
 *   3. `sweepUnverifiedFindings` — the claim ran out of time without a qualifying scan. That is
 *      UNVERIFIED, and it is emphatically not a reopen.
 *
 * Everything here is gated on `IngestionSettings.verifyResolutionEnabled`, and the REOPEN inside
 * step 2 is gated a second time on `autoReopenEnabled` — the ladder, not one switch. See the schema
 * comment on `verifyResolutionEnabled` for why those are deliberately two decisions.
 */
import {
  securityFindingStatusBuckets,
  securityFindingTypeDisciplines,
  securityFindingTypes,
  securityFindingVerificationLabels,
  ticketStatusTransitions,
  unresolvedSecurityFindingStatuses,
  type SecurityFindingSeverity,
  type SecurityFindingType,
  type TicketPriority,
  type TicketStatus
} from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { classifyCiFailure, classifySecurityFinding } from "./ai.service.js";
import { audit } from "./audit.service.js";
import { repositoryFromPrUrl, resolveFindingLocationLive } from "./finding-routing.service.js";
import { fetchGitHubCodeowners, fetchGitHubLastCommitAuthor, parseCodeownersOwners } from "./git-provider.service.js";
import {
  dispatchNotification,
  dispatchTransactional,
  getGlobalNotificationSettings,
  templates,
  type NotificationCategory
} from "./notify.service.js";
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
  VAPT: "Penetration test (VAPT)",
  QUALITY: "Code quality",
  LINT: "Lint"
};

export interface TicketSecurityReport {
  ticket: { id: string; key: string; title: string };
  findings: Awaited<ReturnType<typeof prisma.securityFinding.findMany>>;
  findingsByType: Record<SecurityFindingType, Awaited<ReturnType<typeof prisma.securityFinding.findMany>>>;
  /** SECURITY-discipline findings only — see `securityFindingTypeDisciplines` in packages/shared.
   *  This Record is what `buildRiskVerdict` reads and what the PDF's severity strip prints, so a
   *  workspace that lints in CI must not be able to turn its ticket's headline verdict red with a
   *  hundred code smells. */
  openCountBySeverity: Record<SecurityFindingSeverity, number>;
  /** The other discipline, reported BESIDE the security counts rather than folded into them. The
   *  findings themselves are all in `findings`/`findingsByType` either way — this exists so a reader
   *  can see the quality backlog on this ticket without it moving the security verdict. */
  openQualityCountBySeverity: Record<SecurityFindingSeverity, number>;
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

  // ITERATED FROM THE SHARED CONSTANT, not from a literal list of the five types this file used to
  // know about. The `as Record<…>` below is unavoidable — `Object.fromEntries` types its result as
  // `{ [k: string]: V }` and cannot narrow the key back to a union — so the cast has to be made TRUE
  // by construction rather than trusted: mapping over `securityFindingTypes`, which IS the
  // definition of `SecurityFindingType`, is what guarantees every member has a bucket.
  //
  // WHY THAT MATTERS MORE THAN IT LOOKS. With a hand-written literal here, adding a type compiled
  // cleanly and produced a record with an `undefined` bucket for it — which `renderFindingsText` and
  // the ticket's Security panel then swallowed silently through `?? []`. The findings existed, were
  // stored, counted, and simply never appeared in the report anybody read.
  const findingsByType = Object.fromEntries(
    securityFindingTypes.map((type) => [type, findings.filter((f) => f.type === type)])
  ) as Record<SecurityFindingType, typeof findings>;

  // "Still a problem" comes from the shared bucket map, not from a hand-written status list — see
  // `securityFindingStatusBuckets` for what four copies of that list cost us.
  //
  // THE DECISION THIS FILE MAKES: anything not in the `resolved` bucket counts, so a PENDING
  // (claimed fixed, unconfirmed) finding still reaches `openCountBySeverity` and therefore still
  // reaches `buildRiskVerdict` — the one line a reviewer reads at the top of the ticket's security
  // PDF and the ticket-closed digest email. A verdict of "Clean" on the strength of somebody
  // ticking a box is exactly the reassurance this report must not give.
  const openFindings = findings.filter((f) => securityFindingStatusBuckets[f.status] !== "resolved");

  /**
   * THE SECOND DECISION THIS FILE MAKES, and it is the one QUALITY/LINT ingestion forced: the two
   * disciplines are counted SEPARATELY.
   *
   * `buildRiskVerdict` below reads `openCountBySeverity` and writes the single line a reviewer reads
   * at the top of the security PDF and the ticket-closed digest. Sonar and ESLint post through the
   * same webhook into the same table, and a busy repository produces code smells by the hundred. Let
   * those into this Record and "Needs attention — 40 open HIGH findings" stops meaning a ticket has
   * security exposure and starts meaning somebody enabled a linter. The sentence would still be
   * true, and it would no longer be worth reading — which is the more expensive failure, because it
   * is the one a reviewer stops trusting rather than the one they notice.
   *
   * The quality findings are NOT hidden: they are in `findings`, they have their own sections in
   * `findingsByType`, they are verified and reopened and routed exactly like everything else, and
   * their open count comes back beside the security one. They simply do not vote on the verdict.
   */
  const countBySeverity = (rows: typeof openFindings): Record<SecurityFindingSeverity, number> =>
    Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, rows.filter((f) => f.severity === severity).length])) as Record<
      SecurityFindingSeverity,
      number
    >;
  const openCountBySeverity = countBySeverity(openFindings.filter((f) => securityFindingTypeDisciplines[f.type] === "security"));
  const openQualityCountBySeverity = countBySeverity(openFindings.filter((f) => securityFindingTypeDisciplines[f.type] === "quality"));

  const riskVerdict = buildRiskVerdict(openCountBySeverity, latestTestRun?.status ?? null);

  return {
    ticket,
    findings,
    findingsByType,
    openCountBySeverity,
    openQualityCountBySeverity,
    latestTestRun,
    riskVerdict,
    generatedAt: new Date()
  };
}

/**
 * The one line a reviewer reads. `bySeverity` is ALWAYS the security-discipline counts — see the
 * comment on `openCountBySeverity` in `buildTicketSecurityReport` for why a quality finding must
 * never reach here.
 *
 * The `"Needs attention"` PREFIX is load-bearing beyond its words: mail-templates.ts picks the
 * accent colour of BOTH security digest emails from it, Tickets.tsx picks the Security panel's
 * border from it, and security-report-pdf.service.ts picks the verdict banner's colour from it.
 * Rewording it silently changes four colours.
 */
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
  // Same source as `findingsByType` above, so the sections a reader sees and the buckets that were
  // built can never be two different lists. The ORDER of `securityFindingTypes` is therefore also
  // the reading order of this list — which is why new types are appended there rather than slotted
  // in alphabetically.
  return securityFindingTypes
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
 * One person a security digest goes to. `id` is optional because the Cc side carries addresses we
 * never need to raise a bell for (this org's admins are Cc'd in bulk on the close digest), while
 * everyone on the `to` side is a real user who also gets the in-app notification.
 */
interface DigestRecipient {
  id?: string | null;
  email: string;
}

/** Somebody's manager, but only if they are still an active account. A digest addressed to a
 *  deactivated or soft-deleted manager is a bounce, and the address of a person who has left is not
 *  something to keep mailing security detail to. */
async function activeManagerOf(userId: string): Promise<{ id: string; name: string; email: string } | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { manager: { select: { id: true, name: true, email: true, status: true, deletedAt: true } } }
  });
  const manager = row?.manager;
  if (!manager || manager.status !== "ACTIVE" || manager.deletedAt) return null;
  return { id: manager.id, name: manager.name, email: manager.email };
}

/**
 * Every ADMIN/SUPER_ADMIN in *this ticket's own tenant*.
 *
 * Queried through the already tenant-scoped `prisma` import (see config/prisma.ts's Proxy) — there
 * is no cross-tenant admin table this query could reach even if it wanted to, which is what makes
 * "only this org's team" a structural guarantee here rather than a filter that could have a bug in
 * it.
 */
async function orgAdminEmails(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null, role: { name: { in: ["ADMIN", "SUPER_ADMIN"] } } },
    select: { email: true }
  });
  return admins.map((a) => a.email);
}

/**
 * The delivery half of BOTH security digests — one email with a real multi-address `to` and a real
 * Cc, plus an in-app bell for every primary recipient.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED. The close digest existed first and solved two problems
 * that are not specific to closing: `dispatchNotification` has no Cc at all (see
 * notify.service.ts), so anything with a "these people are informed, those people are accountable"
 * shape has to go through `dispatchTransactional`; and putting two people in `to` requires one send
 * with a comma-joined header rather than two sends, or each recipient sees a mail that looks
 * addressed only to them. The reopen digest has exactly the same shape with a wider audience, so
 * writing it as a second notification path would have meant re-deriving both answers and then
 * maintaining two of them.
 *
 * The BELL IS DELIBERATELY KEPT alongside the email: the email is the detail, the bell is the
 * signal, and a workspace that has muted the category still sees that something happened. Note that
 * `dispatchNotification` is called with no `email` payload, so it writes the in-app row and returns
 * before any settings gate — the gate that matters was already applied by the caller.
 */
async function deliverTicketSecurityDigest(args: {
  ticket: { id: string; key: string };
  to: DigestRecipient[];
  cc: string[];
  bell: { category: NotificationCategory; title: string; body: string };
  templateKey: string;
  vars: Record<string, string | number | undefined | null>;
  fallback: { subject: string; html: string };
}): Promise<void> {
  const toAddresses = Array.from(new Set(args.to.map((r) => r.email).filter(Boolean)));
  if (toAddresses.length === 0) return;

  // Cc never repeats a primary recipient. mail.service.ts dedupes too, but doing it here keeps the
  // header honest for anyone reading an EmailLog row.
  const lowerTo = new Set(toAddresses.map((address) => address.toLowerCase()));
  const ccAddresses = Array.from(new Set(args.cc.filter((address) => address && !lowerTo.has(address.toLowerCase()))));

  for (const recipientId of Array.from(new Set(args.to.map((r) => r.id).filter((id): id is string => Boolean(id))))) {
    await dispatchNotification({
      userId: recipientId,
      category: args.bell.category,
      title: args.bell.title,
      body: args.bell.body,
      link: `/app/tickets?open=${args.ticket.id}`
    });
  }

  await dispatchTransactional({
    to: toAddresses.join(", "),
    cc: ccAddresses,
    templateKey: args.templateKey,
    vars: args.vars,
    fallback: args.fallback
  });
}

/**
 * Fires from ticket.controller.ts when a ticket transitions to CLOSED. Sends exactly one email
 * — closer + their manager as primary recipients (a real multi-address `to`, not two separate
 * sends), every ADMIN/SUPER_ADMIN in this ticket's own tenant as Cc.
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
  const [manager, ccAddresses] = await Promise.all([activeManagerOf(closer.id), orgAdminEmails()]);

  await deliverTicketSecurityDigest({
    ticket,
    to: [{ id: closer.id, email: closer.email }, ...(manager ? [{ id: manager.id, email: manager.email }] : [])],
    cc: ccAddresses,
    bell: { category: "ticket.closed_digest", title: `Security digest: ${ticket.key}`, body: report.riskVerdict },
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

// --- Verified remediation ----------------------------------------------------------------------
// The gate, the verdict, the grace window, and the digest that goes out when a fix did not hold.
// See this file's header for the three-step shape and where each step is called from.

/**
 * A tool name, normalised the SAME WAY `utils/finding-fingerprint.ts` normalises it before hashing.
 *
 * This matters more than it looks. The finding's identity is derived from the lower-cased tool, so
 * a CI job that posts `Semgrep` one night and `semgrep` the next already produces two different
 * fingerprints. If the same-tool check were a SQL equality it would silently disagree with that:
 * MySQL's default collation is case-insensitive, so the query would treat the two spellings as one
 * tool while the fingerprints treat them as two — and a run by "Semgrep" would be allowed to prove
 * a "semgrep" finding gone, using an identity it can never match. Comparing here, with the same
 * normalisation the identity uses, is the only version of this check that is consistent with itself.
 */
function normaliseToolName(tool: string): string {
  return tool.trim().toLowerCase();
}

/** "23 days" / "4 hours" — how long a finding has been a problem, for a human reading a digest. */
function humanAge(from: Date, to: Date = new Date()): string {
  const hours = Math.max(0, Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60)));
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** One finding as a line in the reopen digest — severity, what it is, who found it, and the two
 *  facts a reader needs to judge how bad this is: how long it has been there and how many scans
 *  have now reported it. */
function verificationFindingLine(finding: {
  severity: string;
  title: string;
  tool: string;
  firstSeenAt: Date;
  occurrences: number;
}): string {
  return `  - [${finding.severity}] ${finding.title} (${finding.tool}) — open ${humanAge(finding.firstSeenAt)}, reported by ${finding.occurrences} scan${finding.occurrences === 1 ? "" : "s"}`;
}

/** Plain text either way, so the caller can decide whether to escape it. `renderFindingsText` vs
 *  `renderFindingsHtml` above is the same split and exists for the same reason — see that comment
 *  for why an unescaped scanner-supplied title must never reach the DB-override template path. */
function renderVerificationList(
  findings: Array<{ severity: string; title: string; tool: string; firstSeenAt: Date; occurrences: number }>,
  emptyMessage: string
): string {
  if (findings.length === 0) return emptyMessage;
  return findings.map(verificationFindingLine).join("\n");
}

/** A system-authored ticket comment, or nothing at all when the seed has never run. Findings-sourced
 *  automation has always failed quiet rather than loud (see `maybeAutoCreateTicketForFinding`) —
 *  a missing system account must not turn a scan ingest into an error. */
async function postSystemComment(ticketId: string, html: string): Promise<void> {
  const systemUser = await prisma.user.findUnique({ where: { email: SECURITY_INGESTION_SYSTEM_EMAIL } });
  if (!systemUser) return;
  await prisma.ticketComment.create({ data: { ticketId, authorId: systemUser.id, body: html } });
}

/**
 * THE GATE. Fires from ticket.controller.ts's `PATCH /:id/status` when a ticket carrying security
 * findings moves to RESOLVED or CLOSED: every one of its findings that is still a problem becomes a
 * CLAIM awaiting proof rather than a settled matter.
 *
 * WHY THIS IS THE PRODUCT'S POINT. Before it, the only thing that could retire a security finding
 * was somebody deciding it was retired. Resolve the ticket, the finding stops counting, and nothing
 * ever asked the scanner whether the vulnerability was actually gone. `PENDING_VERIFICATION` buckets
 * as `pending`, which `unresolvedSecurityFindingStatuses` counts as unresolved — so a claimed fix
 * keeps counting against the workspace's risk score, its insights totals and its weekly digest
 * until a scan agrees. That is the difference between measuring exposure and measuring how willing
 * somebody was to close a ticket.
 *
 * ONLY STILL-UNRESOLVED FINDINGS ARE TOUCHED, which is also what makes RESOLVED-then-CLOSED
 * idempotent: the second transition finds nothing left in the open bucket and does nothing, so the
 * grace window is not quietly restarted by the act of closing something already resolved.
 *
 * AWAITED BY ITS CALLER, unlike the digest beside it. It sends no mail and renders no report — it
 * is a handful of indexed writes — and if it silently failed the entire feature would be off for
 * that ticket with nothing to show for it. The caller still wraps it, so a failure here logs and
 * lets the status change stand: refusing to close a ticket because a security bookkeeping write
 * failed would be a worse product than closing it unverified.
 */
export async function markFindingsAwaitingVerification(
  ticket: { id: string; key: string },
  actorId: string | undefined
): Promise<number> {
  const settings = await prisma.ingestionSettings.findUnique({ where: { id: "global" } });
  if (!settings?.verifyResolutionEnabled) return 0;

  const findings = await prisma.securityFinding.findMany({
    // The shared bucket map decides what "still a problem" means — never a hand-written status list
    // here. See `securityFindingStatusBuckets` for the four drifting copies that rule replaced.
    where: { ticketId: ticket.id, status: { in: unresolvedSecurityFindingStatuses.filter((s) => s !== "PENDING_VERIFICATION") } },
    select: { id: true, severity: true, title: true, tool: true, repository: true, branch: true, fingerprint: true }
  });
  if (findings.length === 0) return 0;

  const now = new Date();
  await prisma.securityFinding.updateMany({
    where: { id: { in: findings.map((f) => f.id) } },
    data: {
      status: "PENDING_VERIFICATION",
      verificationState: "AWAITING_PROOF",
      awaitingVerificationSince: now,
      // A fresh claim carries no evidence. Clearing these matters on the second trip through the
      // gate — a ticket that was verified, regressed, was fixed again — where stale evidence would
      // otherwise sit on the row asserting a proof that belongs to a previous cycle.
      verifiedFixedAt: null,
      verifiedByScanRunId: null,
      verifiedByCommitSha: null
    }
  });

  const windowDays = Math.max(1, settings.verificationWindowDays);
  const deadline = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  await audit(actorId, "security.verification_pending", "Ticket", ticket.id, {
    findingCount: findings.length,
    findingIds: findings.map((f) => f.id),
    windowDays
  });

  // The ticket says, on itself, what it is awaiting proof of. A comment rather than a column
  // because this is a narrative fact for whoever opens the ticket next — and because the scanner
  // that has to produce the proof is named here, which is the single most common reason a
  // verification never arrives (nobody wired that tool into CI for that branch).
  const scanners = Array.from(new Set(findings.map((f) => f.tool)));
  const scopes = Array.from(
    new Set(findings.map((f) => `${f.repository ?? "unspecified repository"}${f.branch ? ` (${f.branch})` : ""}`))
  );
  const unidentifiable = findings.filter((f) => !f.fingerprint).length;
  await postSystemComment(
    ticket.id,
    [
      `<p><strong>Awaiting proof of remediation</strong> — ${findings.length} finding${findings.length === 1 ? "" : "s"} on this ticket ${findings.length === 1 ? "is" : "are"} now marked <em>${escapeHtml(securityFindingVerificationLabels.AWAITING_PROOF)}</em>.</p>`,
      `<p>The next scan by <strong>${escapeHtml(scanners.join(", "))}</strong> on ${escapeHtml(scopes.join(", "))} decides. Only those tools count — a different scanner not reporting this finding proves nothing about it.</p>`,
      `<p>If no such scan arrives by <strong>${deadline.toDateString()}</strong>, ${findings.length === 1 ? "it is" : "they are"} marked ${escapeHtml(securityFindingVerificationLabels.UNVERIFIED)} and the assignee is notified. Nothing reopens on that basis — absence of proof is not proof of failure.</p>`,
      unidentifiable > 0
        ? `<p>${unidentifiable} of these ${unidentifiable === 1 ? "has" : "have"} no stable fingerprint (no file path, or neither a CWE nor a rule id), so no scan can ever confirm ${unidentifiable === 1 ? "it" : "them"} automatically — ${unidentifiable === 1 ? "it" : "they"} will need a human decision.</p>`
        : ""
    ].join("")
  );

  return findings.length;
}

/**
 * Everyone the reopen digest has to reach, and why each of them.
 *
 * The close digest goes to the person who ticked the box and their manager, which is right for
 * "here is what you just signed off". A FAILED fix is a different message with a different
 * audience: the people who can do something about it are the people who worked on it.
 *
 *   TO — whoever CLOSED it (recovered from the audit trail; the ticket itself does not remember),
 *        the CURRENT assignee (who owns it now, and may not be the closer), and everyone who LOGGED
 *        TIME against it (the people who actually did the work, who are invisible to every other
 *        recipient query in this file).
 *   CC — the closer's manager and the module owner, who need to know without being asked to act.
 *
 * The closer is recovered by walking `ticket.status_changed` audit rows newest-first and taking the
 * first whose `metadata.to` was RESOLVED or CLOSED. `metadata` is freeform JSON that every call site
 * shapes for itself, so it is filtered in JS rather than in SQL — exactly how report.controller.ts's
 * reopen-rate calculation already reads the same rows.
 */
async function resolveReopenDigestAudience(ticket: {
  id: string;
  assigneeId: string | null;
  moduleId: string | null;
}): Promise<{ to: Array<{ id: string; email: string }>; cc: string[]; closerName: string }> {
  const [statusAudits, timeLoggers, moduleRule] = await Promise.all([
    prisma.auditLog.findMany({
      where: { entity: "Ticket", entityId: ticket.id, action: "ticket.status_changed" },
      orderBy: { createdAt: "desc" },
      // Bounded: a ticket that has changed status fifty times has been closed within those fifty,
      // and an unbounded scan of one ticket's whole history to find one row is a scan we do not
      // need to pay for on every failed verification.
      take: 50,
      select: { actorId: true, metadata: true }
    }),
    prisma.timesheet.findMany({
      where: { ticketId: ticket.id },
      // DISTINCT users, not distinct timesheets — somebody who logged forty entries is one
      // recipient, and without this the `to` header would repeat them forty times.
      distinct: ["userId"],
      select: { userId: true }
    }),
    ticket.moduleId
      ? prisma.moduleAssigneeRule.findUnique({
          where: { moduleId: ticket.moduleId },
          select: { defaultAssigneeId: true }
        })
      : Promise.resolve(null)
  ]);

  const closerId =
    statusAudits.find((row) => {
      const to = (row.metadata as { to?: string } | null)?.to;
      return (to === "RESOLVED" || to === "CLOSED") && Boolean(row.actorId);
    })?.actorId ?? null;

  const primaryIds = Array.from(
    new Set([closerId, ticket.assigneeId, ...timeLoggers.map((t) => t.userId)].filter((id): id is string => Boolean(id)))
  );
  const ccIds = Array.from(new Set([moduleRule?.defaultAssigneeId].filter((id): id is string => Boolean(id))));

  // Deactivated and soft-deleted accounts are dropped here rather than by the mailer: an ex-employee
  // who logged time on this ticket two years ago is not somebody to send a security detail to, and
  // `dispatchTransactional` (unlike `dispatchNotification`) has no user row to check.
  const people = await prisma.user.findMany({
    where: { id: { in: [...primaryIds, ...ccIds] }, status: "ACTIVE", deletedAt: null },
    select: { id: true, name: true, email: true }
  });
  const byId = new Map(people.map((p) => [p.id, p]));

  const manager = closerId ? await activeManagerOf(closerId) : null;

  return {
    to: primaryIds.flatMap((id) => {
      const person = byId.get(id);
      return person ? [{ id: person.id, email: person.email }] : [];
    }),
    cc: [manager?.email, ...ccIds.map((id) => byId.get(id)?.email)].filter((email): email is string => Boolean(email)),
    closerName: (closerId ? byId.get(closerId)?.name : null) ?? "Somebody"
  };
}

/**
 * THE MESSAGE THIS WHOLE BLOCK EXISTS TO SEND. A scan proved a claimed fix did not hold.
 *
 * WHAT IT SAYS, structured rather than as a sentence: which scan, tool and commit triggered it;
 * which findings survived and which were genuinely fixed by the same run; how long each survivor
 * has been open and how many scans have now reported it; and where the ticket's SLA now stands.
 *
 * `didReopen` is passed in rather than assumed, because it is genuinely uncertain: the reopen is
 * gated on `autoReopenEnabled`, and with that off this email still goes out saying the fix failed
 * and the ticket was deliberately left where it is. Telling somebody their SLA clock restarted when
 * it did not is the fastest way to make them stop reading these.
 */
export async function sendTicketReopenedDigest(args: {
  ticket: { id: string; key: string; title: string; assigneeId: string | null; moduleId: string | null };
  scanRun: { id: string; tool: string; repository: string | null; branch: string | null; commitSha: string | null };
  survived: Array<{ severity: string; title: string; tool: string; firstSeenAt: Date; occurrences: number }>;
  verifiedFixed: Array<{ severity: string; title: string; tool: string; firstSeenAt: Date; occurrences: number }>;
  didReopen: boolean;
  slaDueAt: Date | null;
}): Promise<void> {
  const settings = await getGlobalNotificationSettings();
  if (!settings.emailTicketReopenedDigest) return;

  const [report, audience] = await Promise.all([
    buildTicketSecurityReport(args.ticket.id),
    resolveReopenDigestAudience(args.ticket)
  ]);

  const scope = `${args.scanRun.repository ?? "unspecified repository"}${args.scanRun.branch ? ` (${args.scanRun.branch})` : ""}`;
  const scanSummary = `${args.scanRun.tool} on ${scope}${args.scanRun.commitSha ? `, commit ${args.scanRun.commitSha.slice(0, 12)}` : ", commit not reported"}`;
  const survivedText = renderVerificationList(args.survived, "None — see the audit trail for what changed.");
  const fixedText = renderVerificationList(args.verifiedFixed, "None — this scan proved nothing fixed on this ticket.");
  // Three genuinely different statements, written as statements. A ticket that reopened onto a
  // restarted clock, one that reopened where no SLA window is configured for its priority, and one
  // that deliberately did not move at all are not variations of a sentence.
  let slaText =
    "NOT reopened — auto-reopen is off for this workspace, so the ticket is where you left it and its SLA is unchanged. Someone has to move it by hand.";
  if (args.didReopen && args.slaDueAt) slaText = `Reopened. The SLA clock has been restarted — due ${args.slaDueAt.toUTCString()}.`;
  else if (args.didReopen) slaText = "Reopened. No SLA window is configured for this priority, so no clock was started.";

  await deliverTicketSecurityDigest({
    ticket: args.ticket,
    to: audience.to,
    cc: audience.cc,
    bell: {
      category: "ticket.reopened_digest",
      title: `${args.ticket.key}: a fix did not hold`,
      body: `${args.scanRun.tool} still reports ${args.survived.length} finding${args.survived.length === 1 ? "" : "s"} that was marked fixed.`
    },
    templateKey: "ticket.reopened_digest",
    vars: {
      ticketKey: args.ticket.key,
      title: args.ticket.title,
      closedBy: audience.closerName,
      scanSummary,
      riskVerdict: report.riskVerdict,
      // Escaped for the DB-override path, which substitutes into an administrator-edited template
      // with no escaping of its own — scanner-supplied titles reach this. Exactly the split
      // `renderFindingsHtml`/`renderFindingsText` documents above; the compiled fallback below gets
      // the raw text because it escapes internally.
      survivedText: escapeHtml(survivedText).replace(/\n/g, "<br />"),
      fixedText: escapeHtml(fixedText).replace(/\n/g, "<br />"),
      slaText,
      ticketId: args.ticket.id
    },
    fallback: {
      subject: `[${args.ticket.key}] A fix did not hold — ${args.survived.length} finding${args.survived.length === 1 ? "" : "s"} still reported`,
      html: templates.ticketReopenedDigest({
        ticketKey: args.ticket.key,
        title: args.ticket.title,
        closedBy: audience.closerName,
        scanSummary,
        riskVerdict: report.riskVerdict,
        survivedText,
        fixedText,
        slaText,
        ticketId: args.ticket.id
      })
    }
  });
}

/**
 * THE VERDICT. Fires from devops-webhook.controller.ts once per `ScanRun` an ingest recorded,
 * including the runs that reported nothing at all — a scan that found nothing is the strongest
 * possible evidence and would be thrown away if only non-empty payloads were compared.
 *
 * ── THE ONE RULE THAT MAKES THIS TRUSTWORTHY ──────────────────────────────────────────────────
 *
 * Only a run by the SAME TOOL on the SAME repository and branch can prove a finding gone. gitleaks
 * not reporting a semgrep finding proves precisely nothing — it was never looking for it — and a
 * system that treated that as evidence would mark half a workspace's backlog "verified fixed" the
 * first night somebody added a second scanner to CI. That is the single easiest way to get this
 * feature catastrophically wrong, and it is why the tool comparison below is an explicit, visible
 * line rather than something implied by a query's shape.
 *
 * `reportedFingerprints` is passed IN rather than re-queried from the run's own findings. The
 * caller has the list in hand, and re-reading it would race the next ingest re-pointing a finding
 * at a newer run — a race whose failure mode is a shorter list, i.e. wrongly declaring something
 * fixed. Wrong in the dangerous direction is not a race worth leaving open for tidiness.
 *
 * Findings with a NULL fingerprint are never candidates. There is nothing to compare, so absence
 * from a payload cannot mean anything about them; they stay AWAITING_PROOF until the grace window
 * calls them UNVERIFIED, which is the honest outcome for a finding nothing can identify.
 */
export async function verifyFindingsAgainstScanRun(scanRunId: string, reportedFingerprints: string[]): Promise<void> {
  const settings = await prisma.ingestionSettings.findUnique({ where: { id: "global" } });
  if (!settings?.verifyResolutionEnabled) return;

  const run = await prisma.scanRun.findUnique({ where: { id: scanRunId } });
  if (!run) return;

  const candidates = await prisma.securityFinding.findMany({
    where: {
      verificationState: "AWAITING_PROOF",
      // `null` here means IS NULL, not "any" — a run that named no repository can only speak for
      // findings that named no repository either.
      repository: run.repository,
      branch: run.branch,
      // THE SAME-TYPE RESTRICTION, alongside the same-tool one below and for the identical reason.
      // A run is created per (tool, type, repository, branch) — see `scanGroupKey` — so ONE payload
      // carrying two types produces two runs, each holding only its own type's fingerprints. Without
      // this line, the SAST run's verdict would look at a QUALITY finding, not find its fingerprint
      // in the SAST list, and declare it verified fixed — while the very same request was reporting
      // it. That was latent when a payload rarely mixed types; SonarQube ingestion makes it the
      // normal case, because one Sonar analysis produces VULNERABILITY (→ SAST) and CODE_SMELL
      // (→ QUALITY) issues together.
      type: run.type,
      fingerprint: { not: null }
    }
  });

  // THE SAME-TOOL RESTRICTION. Deleting this line makes every scan able to "prove" every other
  // scanner's findings fixed. See this function's header, and finding-verification.test.ts's
  // "a scan by a different tool proves nothing".
  const qualifying = candidates.filter((f) => normaliseToolName(f.tool) === normaliseToolName(run.tool));
  if (qualifying.length === 0) return;

  const reported = new Set(reportedFingerprints);
  const proven = qualifying.filter((f) => !reported.has(f.fingerprint!));
  const refuted = qualifying.filter((f) => reported.has(f.fingerprint!));

  const now = new Date();
  if (proven.length > 0) {
    await prisma.securityFinding.updateMany({
      where: { id: { in: proven.map((f) => f.id) } },
      data: {
        status: "FIXED",
        verificationState: "VERIFIED_FIXED",
        verifiedFixedAt: now,
        verifiedByScanRunId: run.id,
        // Copied, not read back through the relation: `ScanRun` is a log and logs get pruned.
        verifiedByCommitSha: run.commitSha,
        awaitingVerificationSince: null
      }
    });
  }
  if (refuted.length > 0) {
    await prisma.securityFinding.updateMany({
      where: { id: { in: refuted.map((f) => f.id) } },
      data: {
        // Back to OPEN, not left PENDING: a scanner reporting it again is not an unsettled claim,
        // it is a settled one that came out the other way.
        status: "OPEN",
        verificationState: "REFUTED_BY_SCAN",
        awaitingVerificationSince: null
      }
    });
  }

  for (const finding of proven) {
    await audit(undefined, "security.finding_verified_fixed", "SecurityFinding", finding.id, {
      scanRunId: run.id,
      tool: run.tool,
      commitSha: run.commitSha,
      ticketId: finding.ticketId
    }, { actorType: "INTEGRATION", actorLabel: "security-verification", before: { status: finding.status } });
  }
  for (const finding of refuted) {
    await audit(undefined, "security.finding_verification_refuted", "SecurityFinding", finding.id, {
      scanRunId: run.id,
      tool: run.tool,
      commitSha: run.commitSha,
      ticketId: finding.ticketId
    }, { actorType: "INTEGRATION", actorLabel: "security-verification", before: { status: finding.status } });
  }

  // Grouped by ticket, because a person reads a ticket, not a finding. A ticket with both outcomes
  // gets ONE message carrying both lists — "two of the four you fixed came back" is the sentence
  // that makes the situation legible, and two separate emails saying half of it each do not.
  const ticketIds = Array.from(
    new Set([...proven, ...refuted].map((f) => f.ticketId).filter((id): id is string => Boolean(id)))
  );

  for (const ticketId of ticketIds) {
    const survived = refuted.filter((f) => f.ticketId === ticketId);
    const fixed = proven.filter((f) => f.ticketId === ticketId);
    await settleTicketVerification({ ticketId, run, survived, fixed }).catch((error) =>
      console.warn(`[security-verification] could not settle ticket ${ticketId}: ${(error as Error).message}`)
    );
  }
}

/** The per-ticket half of the verdict: the comment either way, and — only when something survived —
 *  the reopen and the digest. Split out so `verifyFindingsAgainstScanRun` reads as the decision it
 *  is, and so one ticket's failure cannot abandon the rest of the batch. */
async function settleTicketVerification(args: {
  ticketId: string;
  run: { id: string; tool: string; repository: string | null; branch: string | null; commitSha: string | null };
  survived: Array<{ severity: string; title: string; tool: string; firstSeenAt: Date; occurrences: number }>;
  fixed: Array<{ severity: string; title: string; tool: string; firstSeenAt: Date; occurrences: number }>;
}): Promise<void> {
  const ticket = await prisma.ticket.findFirst({
    where: { id: args.ticketId, deletedAt: null },
    select: { id: true, key: true, title: true, priority: true, assigneeId: true, moduleId: true, dueAt: true }
  });
  if (!ticket) return;

  const scope = `${args.run.repository ?? "unspecified repository"}${args.run.branch ? ` (${args.run.branch})` : ""}`;
  const scanLine = `${args.run.tool} on ${scope}${args.run.commitSha ? `, commit ${args.run.commitSha.slice(0, 12)}` : ""}`;

  if (args.survived.length === 0) {
    await postSystemComment(
      args.ticketId,
      [
        `<p><strong>Remediation verified.</strong> ${escapeHtml(scanLine)} ran and no longer reports ${args.fixed.length} finding${args.fixed.length === 1 ? "" : "s"} that was claimed fixed on this ticket.</p>`,
        `<p>${escapeHtml(renderVerificationList(args.fixed, "")).replace(/\n/g, "<br />")}</p>`
      ].join("")
    );
    return;
  }

  // THE SECOND RUNG. The mark-and-notify above happened because verification is on; whether the
  // TICKET moves is a separate decision an admin makes separately, and `maybeReopenTicketOnRegression`
  // is the one place in this app that owns it — it checks `autoReopenEnabled`, checks the transition
  // is legal against `ticketStatusTransitions`, and writes the audit row. Reimplementing any of that
  // here would be a second, quieter way for an automated process to move somebody's ticket.
  const reason = `A ${args.run.tool} scan still reporting ${args.survived.length} finding${args.survived.length === 1 ? "" : "s"} marked fixed`;
  const didReopen = await maybeReopenTicketOnRegression(args.ticketId, reason);

  // THE SLA CLOCK, restarted only when the ticket actually moved.
  //
  // WHY HERE AND NOT INSIDE `maybeReopenTicketOnRegression`: that function has two other callers
  // (a failed CI run, a new finding on a closed ticket) whose behaviour real workspaces already
  // depend on, and silently changing their due dates is not this block's decision to make. A
  // verification failure is the case where leaving the old date is clearly wrong — the ticket was
  // closed, its window elapsed, and reopening it onto a date three weeks in the past means the
  // escalation worker treats it as permanently breached from the first minute, which is noise
  // rather than urgency.
  let slaDueAt: Date | null = ticket.dueAt;
  if (didReopen) {
    const slaSettings = await getGlobalTicketSettings();
    slaDueAt = computeTicketDueDate(new Date(), ticket.priority as TicketPriority, slaSettings);
    await prisma.ticket.update({ where: { id: ticket.id }, data: { dueAt: slaDueAt } });
  }

  await postSystemComment(
    args.ticketId,
    [
      `<p><strong>A fix did not hold.</strong> ${escapeHtml(scanLine)} still reports ${args.survived.length} finding${args.survived.length === 1 ? "" : "s"} that ${args.survived.length === 1 ? "was" : "were"} marked fixed when this ticket was resolved.</p>`,
      `<p>${escapeHtml(renderVerificationList(args.survived, "")).replace(/\n/g, "<br />")}</p>`,
      args.fixed.length > 0
        ? `<p>The same scan did confirm ${args.fixed.length} other finding${args.fixed.length === 1 ? "" : "s"} as genuinely fixed.</p>`
        : "",
      didReopen
        ? `<p>Reopened automatically, SLA clock restarted.</p>`
        : `<p>Left as it is — auto-reopen is off for this workspace. Somebody has to move this ticket by hand.</p>`
    ].join("")
  );

  // Detached, and for the same reason the close digest is detached from the ticket controller: this
  // renders a report and hands real addresses to SMTP, and the CI job POSTing a scan has no reason
  // to wait on either. Everything the verdict is responsible for — the finding rows, the audit
  // trail, the ticket's own state — is already committed above.
  void sendTicketReopenedDigest({
    ticket: { id: ticket.id, key: ticket.key, title: ticket.title, assigneeId: ticket.assigneeId, moduleId: ticket.moduleId },
    scanRun: args.run,
    survived: args.survived,
    verifiedFixed: args.fixed,
    didReopen,
    slaDueAt
  }).catch((error) => console.error(`[security-verification] reopen digest failed for ${ticket.key}:`, (error as Error).message));
}

/**
 * THE GRACE WINDOW. Fires daily from workers/verification-sweep.worker.ts.
 *
 * A claimed fix that has waited longer than `IngestionSettings.verificationWindowDays` without a
 * qualifying scan is marked UNVERIFIED and its assignee is nudged. IT DOES NOT REOPEN, and that is
 * the most important line in this function.
 *
 * WHY NOT. Absence of proof is not proof of failure. The overwhelmingly likely reason no scan
 * arrived is that nobody wired that scanner into CI for that branch — not that the developer lied.
 * A system that reopens somebody's ticket and tells their manager a fix failed, on the strength of
 * a pipeline nobody configured, is a system that is wrong in public. People switch those off, and
 * then the verification that WOULD have caught a real regression is off too. The cost of staying
 * quiet here is one uncertain row on a dashboard; the cost of accusing people wrongly is the whole
 * feature.
 *
 * The finding stays `PENDING_VERIFICATION`, so it keeps counting as unresolved everywhere. Nothing
 * about running out of time makes a vulnerability less real.
 */
export async function sweepUnverifiedFindings(): Promise<number> {
  const settings = await prisma.ingestionSettings.findUnique({ where: { id: "global" } });
  if (!settings?.verifyResolutionEnabled) return 0;

  const windowDays = Math.max(1, settings.verificationWindowDays);
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const expired = await prisma.securityFinding.findMany({
    where: { verificationState: "AWAITING_PROOF", awaitingVerificationSince: { lt: cutoff } },
    select: { id: true, ticketId: true, title: true, tool: true, severity: true }
  });
  if (expired.length === 0) return 0;

  await prisma.securityFinding.updateMany({
    where: { id: { in: expired.map((f) => f.id) } },
    // `status` deliberately untouched. It stays PENDING_VERIFICATION, which buckets as `pending` and
    // therefore still counts against the workspace. Running out of patience is not evidence.
    data: { verificationState: "UNVERIFIED", awaitingVerificationSince: null }
  });

  for (const finding of expired) {
    await audit(undefined, "security.verification_unverified", "SecurityFinding", finding.id, {
      windowDays,
      ticketId: finding.ticketId
    }, { actorType: "INTEGRATION", actorLabel: "security-verification" });
  }

  const byTicket = new Map<string, typeof expired>();
  for (const finding of expired) {
    if (!finding.ticketId) continue;
    const bucket = byTicket.get(finding.ticketId);
    if (bucket) bucket.push(finding);
    else byTicket.set(finding.ticketId, [finding]);
  }

  for (const [ticketId, findings] of byTicket) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      select: { id: true, key: true, assigneeId: true }
    });
    if (!ticket) continue;

    const scanners = Array.from(new Set(findings.map((f) => f.tool)));
    await postSystemComment(
      ticketId,
      [
        `<p><strong>Unverified after ${windowDays} days.</strong> ${findings.length} finding${findings.length === 1 ? "" : "s"} on this ticket ${findings.length === 1 ? "was" : "were"} marked fixed, and no ${escapeHtml(scanners.join(" / "))} scan has run on the relevant repository and branch since.</p>`,
        `<p><strong>This is not an accusation that the fix failed.</strong> Nobody has proven anything either way, and this ticket has deliberately NOT been reopened on that basis — absence of proof is not proof of failure. The likeliest explanation is that the scanner is not wired into CI for that branch.</p>`,
        `<p>Either run the scan, or mark the finding${findings.length === 1 ? "" : "s"} accepted-risk by hand if confirmation is not going to arrive.</p>`
      ].join("")
    );

    // The nudge is a BELL, not an email, and `security.verification_unverified` is registered in
    // notify.service.ts with a `null` settings field to say so. There is no new email template here
    // on purpose: "nothing has happened yet" is the weakest possible message, an inbox is where
    // weak messages go to teach people to ignore the strong ones, and the ticket comment above
    // already carries the full explanation for whoever opens it.
    if (ticket.assigneeId) {
      await dispatchNotification({
        userId: ticket.assigneeId,
        category: "security.verification_unverified",
        title: `${ticket.key}: a fix is still unverified`,
        body: `No ${scanners.join(" / ")} scan has confirmed ${findings.length} finding${findings.length === 1 ? "" : "s"} marked fixed ${windowDays} days ago. Not reopened — nothing has been proven either way.`,
        link: `/app/tickets?open=${ticket.id}`
      });
    }
  }

  return expired.length;
}

/**
 * Fires from devops-webhook.controller.ts right after a finding is stored, only when it arrived
 * with no `ticketKey` (nothing to attach it to) and is CRITICAL/HIGH severity. High-confidence
 * by construction — the scanning tool already did the classification, so unlike email/chat
 * intake this skips the AI-triage `needsReview` gate entirely; a finding is not an ambiguous
 * natural-language message an AI had to guess at.
 *
 * WHERE THE TICKET GOES is decided by services/finding-routing.service.ts, not by this function:
 * the finding's repository picks a project through `RepositoryMap`, and its file path picks a
 * module (and optionally a submodule) through `ModulePathRule`. Both steps are optional, and the
 * repository step's else-branch is `IngestionSettings.fallbackProjectId` — so a workspace that has
 * configured no rules resolves exactly the project this function has always used, and sees no
 * change at all. With no fallback project and no matching map there is nowhere to put the ticket,
 * so this is a no-op and the finding is simply left ticket-less (still visible via its own record).
 *
 * `issueTicketKey` is called with the RESOLVED project, which means a finding routed away from the
 * fallback project gets that project's own key prefix (`BILLING-41`, not `WEB-41`). That is the
 * point rather than a side effect: the key is how everybody refers to the ticket, and it should say
 * which product the work belongs to.
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

  // Repository → project, file path → module/submodule. Nothing matching is normal and lands on
  // the fallback project with a null module, which is the pre-routing behaviour exactly.
  const location = await resolveFindingLocationLive(finding);
  const projectId = location.projectId;
  if (!projectId) return;

  // A soft-deleted project means no ticket — the same answer this has always given when the
  // fallback project was deleted, now reachable for a mapped project too.
  const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } });
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
        // The module the path rules resolved, null when nothing matched. `Ticket` has no
        // `submoduleId` column — the submodule lives on the finding this ticket carries, which is
        // one join away and is what the per-module reporting reads anyway.
        moduleId: location.moduleId,
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

  // ASSIGNMENT, in the order a workspace configured it:
  //
  //   1. the `ModuleAssigneeRule` for THE MODULE THIS FINDING IS ACTUALLY IN. This used to be "the
  //      first module on the fallback project that happens to have an assignee rule", which is the
  //      whole bug: a finding in the billing code was assigned to whoever owned whichever module
  //      was created first. A module the path rules did not resolve now correctly produces no
  //      match here rather than an arbitrary one — the routing decides who owns the code, and this
  //      only looks up who that is.
  //   2. CODEOWNERS / last committer, opt-in and unchanged.
  //   3. unassigned.
  const moduleRule = location.moduleId ? await prisma.moduleAssigneeRule.findUnique({ where: { moduleId: location.moduleId } }) : null;
  if (moduleRule) {
    await prisma.ticket.update({ where: { id: ticket.id }, data: { assigneeId: moduleRule.defaultAssigneeId } });
    const assignee = await prisma.user.findUnique({ where: { id: moduleRule.defaultAssigneeId }, select: { id: true, name: true } });
    if (assignee) await notifyAutoAssigned(assignee, "module rule");
  } else if (ingestionSettings?.codeownersAssignEnabled) {
    // No module-level rule matched — fall back to CODEOWNERS/last-committer resolution (opt-in:
    // only runs when IngestionSettings.codeownersAssignEnabled is on, since it makes a live GitHub
    // API call per unmatched finding and needs User.githubUsername populated to be useful at all).
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
/**
 * Velocity-aware tie-break among several CODEOWNERS candidates — picks whoever has historically
 * resolved security-linked tickets fastest (mean hours from Ticket.createdAt to resolvedAt,
 * across their own RESOLVED/CLOSED tickets that carry at least one SecurityFinding). This is the
 * product's actual differentiator over Black Duck/Fortify (see docs/ROADMAP.md's "Competitive
 * parity" Phase 3): neither of those tools owns timesheet/ticket-resolution history, so neither
 * can factor real remediation speed into an assignment suggestion — TimeSphere already has the
 * data because it's the same system that tracks the work.
 * Falls back to the first candidate (preserves prior deterministic behavior) when nobody has
 * enough history to compare, so this never blocks assignment on a cold-start org.
 */
async function pickFastestAssignee(candidates: Array<{ id: string; name: string }>): Promise<{ id: string; name: string }> {
  if (candidates.length <= 1) return candidates[0];

  const stats = await Promise.all(
    candidates.map(async (user) => {
      const resolvedTickets = await prisma.ticket.findMany({
        where: { assigneeId: user.id, status: { in: ["RESOLVED", "CLOSED"] }, resolvedAt: { not: null }, securityFindings: { some: {} } },
        select: { createdAt: true, resolvedAt: true }
      });
      if (resolvedTickets.length === 0) return { user, avgResolutionHours: null as number | null };
      const avgResolutionHours =
        resolvedTickets.reduce((sum, t) => sum + (t.resolvedAt!.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60), 0) / resolvedTickets.length;
      return { user, avgResolutionHours };
    })
  );

  const withHistory = stats.filter((s): s is { user: { id: string; name: string }; avgResolutionHours: number } => s.avgResolutionHours !== null);
  if (withHistory.length === 0) return candidates[0];
  withHistory.sort((a, b) => a.avgResolutionHours - b.avgResolutionHours);
  return withHistory[0].user;
}

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
    // Resolve EVERY matching CODEOWNERS handle to a TimeSphere user (not just the first) — when
    // a line lists several owners (a common pattern: "src/auth/** @alice @bob @carol"), picking
    // whoever historically resolves security tickets fastest is a better default than picking
    // whoever happened to be listed first. See pickFastestAssignee below.
    const candidates: Array<{ id: string; name: string }> = [];
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
      if (user) candidates.push(user);
    }
    if (candidates.length > 0) return pickFastestAssignee(candidates);
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
 *
 * RETURNS WHETHER IT ACTUALLY MOVED THE TICKET. Its two original callers ignore that, and nothing
 * changes for them. The verification verdict cannot: it sends an email that states where the
 * ticket's SLA now stands, and with `autoReopenEnabled` off this function is a deliberate no-op —
 * so an email that assumed it had reopened would tell a manager a clock restarted that did not.
 * `false` covers every reason it declined: the toggle is off, the ticket is gone, it was never
 * resolved or closed, or the transition is illegal.
 */
export async function maybeReopenTicketOnRegression(ticketId: string, reason: string): Promise<boolean> {
  const settings = await prisma.ingestionSettings.findUnique({ where: { id: "global" } });
  if (!settings?.autoReopenEnabled) return false;

  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null } });
  if (!ticket) return false;
  if (ticket.status !== "RESOLVED" && ticket.status !== "CLOSED") return false;

  const currentStatus = ticket.status as TicketStatus;
  const allowed = ticketStatusTransitions[currentStatus] ?? [];
  if (!allowed.includes("REOPENED")) return false; // stays consistent with the one source of truth for legal transitions, even though both current states already allow it

  await prisma.ticket.update({ where: { id: ticket.id }, data: { status: "REOPENED", resolvedAt: null, closedAt: null } });
  await audit(undefined, "ticket.auto_reopened", "Ticket", ticket.id, { reason, from: currentStatus }, {
    actorType: "INTEGRATION",
    actorLabel: "security-ingestion",
    before: { status: currentStatus }
  });

  if (ticket.assigneeId) {
    await dispatchNotification({
      userId: ticket.assigneeId,
      category: "ticket.status_changed",
      title: `${ticket.key} auto-reopened`,
      body: `${reason} reopened this ticket automatically.`,
      link: `/app/tickets?open=${ticket.id}`
    });
  }

  return true;
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

/**
 * Fires from devops-webhook.controller.ts's /test-runs route on a FAILED run with NO ticket
 * reference at all — the gap `maybeReopenTicketOnRegression` doesn't cover (that one only acts on
 * an EXISTING ticket). Same system-user pattern as `maybeAutoCreateTicketForFinding`, but its own
 * opt-in (`IngestionSettings.autoCreateTicketOnCiFailureEnabled`, off by default) — unlike a
 * security finding, which already carries a scanner's own severity classification, a bare CI
 * failure has no confidence signal of its own until AI triage runs, and that's optional here.
 *
 * WHERE THE TICKET GOES, and who it does NOT go to (5.0.0). This used to open every ticket in
 * `IngestionSettings.fallbackProjectId` and then assign it via the first module on that project
 * that happened to own a `ModuleAssigneeRule`. Both halves are gone:
 *
 *   PROJECT. A `TestRun` has no repository column, but its `prUrl` names one for every provider
 *   this app supports, so `repositoryFromPrUrl` reads it back out and it goes through the same
 *   `RepositoryMap` step a finding takes. A failure on `acme/billing-api` opens in the billing
 *   project with the billing project's own key prefix. No PR URL, a URL naming a repository no rule
 *   matches, or a workspace that has configured no rules all land on the fallback project exactly
 *   as before — this only ever narrows an answer that was previously "the fallback, always".
 *
 *   ASSIGNEE. None, deliberately. See the comment where the assignment used to be.
 *
 * The MODULE stays null and that is not a gap: `ModulePathRule` matches a file path, and a CI
 * failure is a failed run rather than a line of code.
 *
 * Flaky-test guard, two layers so this can't spam a ticket per re-run of the same broken test:
 * 1. Deterministic (always applied, no AI needed): if a ticket was already auto-created for this
 *    exact provider+branch IN THE RESOLVED PROJECT in the last 24h, this is a REPEAT failure —
 *    append a comment to it instead of creating a duplicate, regardless of what AI triage says (a
 *    still-broken build is exactly the "still broken" signal worth appending, flaky or not). Two
 *    repositories failing on `main` now dedupe separately, which is the point of routing them
 *    apart in the first place.
 * 2. AI-assisted (only when `ciFailureTriageEnabled` AND a `failureText` excerpt was supplied):
 *    `classifyCiFailure`'s `isLikelyFlaky` skips creating a FIRST ticket at all — a test already
 *    known to be flaky doesn't deserve a fresh ticket the moment nobody's tracking it yet, since
 *    that trains whoever triages it to start ignoring "CI failed" tickets on sight.
 */
export async function maybeAutoCreateTicketForCiFailure(testRun: {
  provider: string;
  branch: string | null;
  prUrl: string | null;
  logUrl: string | null;
  failureText?: string;
}): Promise<void> {
  const ingestionSettings = await prisma.ingestionSettings.findUnique({ where: { id: "global" } });
  if (!ingestionSettings?.autoCreateTicketOnCiFailureEnabled) return;

  // Repository → project, through the same `RepositoryMap` step a finding takes. A CI failure has
  // no file path, so the module step of the resolution cannot match and the module stays null. No
  // `prUrl`, an unparseable one, or no rule matching it all resolve to
  // `IngestionSettings.fallbackProjectId`, which is exactly where this ticket has always opened.
  const location = await resolveFindingLocationLive({ repository: repositoryFromPrUrl(testRun.prUrl) });
  const projectId = location.projectId;
  if (!projectId) return;
  const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } });
  if (!project) return;

  const systemUser = await prisma.user.findUnique({ where: { email: SECURITY_INGESTION_SYSTEM_EMAIL } });
  if (!systemUser) return;

  const titlePrefix = `[CI] ${testRun.provider} failed on ${testRun.branch ?? "unknown branch"}`;

  let isLikelyFlaky = false;
  let rootCause: string | null = null;
  if (testRun.failureText) {
    const classification = await classifyCiFailure({ failureText: testRun.failureText, provider: testRun.provider }).catch(() => null);
    if (classification) {
      isLikelyFlaky = classification.isLikelyFlaky;
      rootCause = classification.rootCause;
    }
  }

  const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentTicket = await prisma.ticket.findFirst({
    where: { projectId: project.id, title: { startsWith: titlePrefix }, createdAt: { gte: recentCutoff }, deletedAt: null },
    orderBy: { createdAt: "desc" }
  });

  if (recentTicket) {
    const note = rootCause
      ? `Failed again (${testRun.provider}). AI triage: ${rootCause}${isLikelyFlaky ? " — looks flaky." : ""}`
      : `Failed again (${testRun.provider}).`;
    await prisma.ticketComment.create({ data: { ticketId: recentTicket.id, authorId: systemUser.id, body: `<p>${escapeHtml(note)}</p>` } });
    return;
  }

  if (isLikelyFlaky) return;

  const priority: TicketPriority = "MEDIUM";
  const slaSettings = await getGlobalTicketSettings();
  const createdAt = new Date();
  const description = [rootCause, testRun.logUrl ? `Log: ${testRun.logUrl}` : null, testRun.prUrl ? `PR: ${testRun.prUrl}` : null, `Reported by ${testRun.provider}.`]
    .filter(Boolean)
    .join("\n\n");

  const ticket = await prisma.$transaction(async (tx) => {
    const key = await issueTicketKey(tx, project.id);
    return tx.ticket.create({
      data: {
        key,
        projectId: project.id,
        type: "BUG",
        title: titlePrefix,
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

  // NOBODY IS AUTO-ASSIGNED. This used to hand the ticket to whoever owned the first module on the
  // fallback project that happened to have a `ModuleAssigneeRule` — the same arbitrary lookup
  // 5.0.0 removed from `maybeAutoCreateTicketForFinding`, and the argument against it is identical:
  // a ticket sitting in the queue of somebody who has no idea why it is there is worse than one in
  // a triage list, because the first LOOKS handled. There is no module-level answer to fall back to
  // either, since a CI failure names no file for `ModulePathRule` to match, and no CODEOWNERS
  // answer for the same reason. So it opens unassigned, in the right project, and waits for triage.

  await audit(undefined, "ticket.auto_created_from_ci_failure", "Ticket", ticket.id, { provider: testRun.provider, branch: testRun.branch }, {
    actorType: "INTEGRATION",
    actorLabel: "ci-ingestion"
  });
}

/**
 * Opt-in AI exploitability triage on a just-ingested finding — sibling of
 * maybePostCiFailureTriageComment, gated by GlobalAISettings.findingTriageEnabled instead of
 * ciFailureTriageEnabled. Only CRITICAL/HIGH findings are triaged (same severity bar
 * maybeAutoCreateTicketForFinding uses) to bound AI spend to what actually matters — a LOW
 * finding getting an AI opinion isn't worth the cost. Writes the verdict/explanation/fix
 * suggestion onto the SecurityFinding row itself (so it shows on the ticket Security tab and
 * counts toward analytics regardless of whether this finding has a ticket attached), and — only
 * when it does have a ticket — also posts it as a comment, same visibility model
 * maybePostCiFailureTriageComment already established for CI-failure triage.
 * `classifySecurityFinding` (ai.service.ts) does its own enabled/budget preflight and throws if
 * the toggle is off — the caller in devops-webhook.controller.ts wraps this in a `.catch()` that
 * just logs, so a disabled toggle is a silent no-op, not an ingestion failure.
 */
export async function maybeTriageFindingWithAI(finding: {
  id: string;
  ticketId: string | null;
  type: SecurityFindingType;
  tool: string;
  severity: SecurityFindingSeverity;
  title: string;
  description: string | null;
  filePath: string | null;
  cwe: string | null;
}): Promise<void> {
  if (finding.severity !== "CRITICAL" && finding.severity !== "HIGH") return;

  const result = await classifySecurityFinding({
    type: finding.type,
    tool: finding.tool,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    filePath: finding.filePath,
    cwe: finding.cwe
  });

  await prisma.securityFinding.update({
    where: { id: finding.id },
    data: {
      aiVerdict: result.verdict,
      aiExploitability: result.exploitability,
      aiFixSuggestion: result.fixSuggestion,
      aiTriagedAt: new Date()
    }
  });

  if (!finding.ticketId) return;
  const systemUser = await prisma.user.findUnique({ where: { email: SECURITY_INGESTION_SYSTEM_EMAIL } });
  if (!systemUser) return;

  const verdictLabel = result.verdict === "TRUE_POSITIVE" ? "True positive" : result.verdict === "FALSE_POSITIVE" ? "Likely false positive" : "Needs human review";
  const body = [
    `<p><strong>AI exploitability triage</strong> — "${escapeHtml(finding.title)}":</p>`,
    `<p>Verdict: <strong>${verdictLabel}</strong></p>`,
    `<p>${escapeHtml(result.exploitability)}</p>`,
    `<p><strong>Suggested fix:</strong> ${escapeHtml(result.fixSuggestion)}</p>`
  ].join("");

  await prisma.ticketComment.create({ data: { ticketId: finding.ticketId, authorId: systemUser.id, body } });
}
