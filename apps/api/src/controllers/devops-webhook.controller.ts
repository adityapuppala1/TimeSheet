/**
 * Ingest-only, tool-agnostic receiver for CI/security-tool output — see docs/ROADMAP.md's
 * "Security assessment suite" section. TimeSphere never runs a scanner itself; whatever an org
 * already runs in CI (Semgrep, OWASP ZAP, Gitleaks, Syft, a test runner, ...) POSTs its results
 * here. Mounted on `app` BEFORE the blanket `app.use("/api", resolveTenant)` in app.ts, same
 * reason as controllers/chat-webhook.controller.ts: an external CI job calling a fixed webhook
 * URL has no Host-header subdomain to resolve a tenant from, so the org is identified directly
 * from the URL path (`/:orgSlug`).
 *
 * Auth model: unlike Slack (HMAC)/Teams (JWT), there's no single signature scheme shared across
 * arbitrary SAST/DAST/CI vendors — so this follows the Google Chat receiver's simpler pattern
 * instead: one shared bearer token per org (IngestionSettings.encryptedToken, generated from
 * Workspace Settings), compared with `constantTimeEqual`. A 404 (not 401) when no token has
 * ever been generated — same "ingestion was never enabled" signal
 * chat-webhook.controller.ts gives for an unconfigured platform.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { securityFindingSeverities, securityFindingTypes, testRunStatuses, type SecurityFindingType } from "@timesheet/shared";
import { getTenantClient, prisma } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { resolveActiveOrgBySlug } from "../middleware/tenant.js";
import { AppError } from "../middleware/error.js";
import { loadFindingRoutingRules, NO_FINDING_ROUTING_RULES, resolveFindingLocation } from "../services/finding-routing.service.js";
import { maybeAutoCreateTicketForCiFailure, maybeAutoCreateTicketForFinding, maybePostCiFailureTriageComment, maybeReopenTicketOnRegression, maybeTriageFindingWithAI, verifyFindingsAgainstScanRun } from "../services/security-report.service.js";
import { decryptSecret } from "../utils/encryption.js";
import { deriveFindingFingerprint, toRepoRelativePath } from "../utils/finding-fingerprint.js";
import { constantTimeEqual } from "../utils/security.js";

export const devopsWebhookRouter = Router();

/** Same tenant-resolution-from-URL-path helper as chat-webhook.controller.ts's withOrgTenant —
 *  duplicated rather than imported since the two controllers are independent integration
 *  surfaces that happen to share a pattern, not a shared dependency. */
async function withOrgTenant<T>(orgSlug: string, fn: () => Promise<T>): Promise<T> {
  const org = await resolveActiveOrgBySlug(orgSlug);
  const dsn = decryptSecret(org.database!.encryptedDsn);
  const client = await getTenantClient(org.id, dsn);
  return tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, fn);
}

async function requireValidIngestionToken(req: Request): Promise<void> {
  const settings = await prisma.ingestionSettings.findUnique({ where: { id: "global" } });
  if (!settings?.encryptedToken) throw new AppError(404, "Security/CI ingestion isn't enabled for this workspace.");

  const authHeaderRaw = req.headers.authorization;
  const authHeader = (Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw) ?? "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!constantTimeEqual(bearerToken, decryptSecret(settings.encryptedToken))) {
    throw new AppError(401, "Invalid ingestion token.");
  }
}

/** Resolves a webhook-supplied ticket reference (key like "WEB-123", preferred, or a raw id) to
 *  a real ticket id in the now-active tenant — findings/test-runs are allowed to arrive with no
 *  ticket reference at all (e.g. a repo-wide nightly scan not tied to one ticket yet). */
async function resolveTicketId(ticketRef: string | undefined): Promise<string | null> {
  if (!ticketRef) return null;
  const ticket = await prisma.ticket.findFirst({
    where: { deletedAt: null, OR: [{ key: ticketRef.toUpperCase() }, { id: ticketRef }] },
    select: { id: true }
  });
  return ticket?.id ?? null;
}

/**
 * WHICH TYPES A CI TOKEN MAY POST — one decision per type, and the compiler makes somebody take it.
 *
 * This used to be the hardcoded literal `["SAST", "DAST", "SSAT", "SSCT"]`, which encoded the right
 * policy in the wrong shape: adding a type left it silently NOT ingestible, so a working webhook
 * would 422 with a message about an invalid enum and nobody would know a decision had been skipped.
 * As an exhaustive Record, a new type stops this file compiling until somebody says yes or no.
 *
 * VAPT IS THE ONLY NO, and it is a security boundary rather than a preference: a VAPT is a periodic
 * HUMAN-LED penetration test, uploaded by an admin through Workspace Settings (see
 * settings.controller.ts's POST /security-ingestion/vapt-report). Letting a CI job POST one would
 * let anything holding an ingest token manufacture the appearance of a pentest that never happened —
 * the highest-trust artefact in this product, claimable by a build script.
 *
 * QUALITY and LINT are YES, and that is the whole point of the SonarQube/ESLint work: they arrive
 * from CI exactly like SAST does, through the same token, into the same table. What keeps them from
 * distorting the security numbers is `securityFindingTypeDisciplines` in packages/shared, not this
 * list — the two guards answer different questions and neither substitutes for the other.
 */
const CI_INGESTIBLE_BY_TYPE: Record<SecurityFindingType, boolean> = {
  SAST: true,
  DAST: true,
  SSAT: true,
  SSCT: true,
  VAPT: false,
  QUALITY: true,
  LINT: true
};
const CI_INGESTIBLE_FINDING_TYPES = securityFindingTypes.filter((type) => CI_INGESTIBLE_BY_TYPE[type]);

/** `z.enum` over the shared constant, narrowed by a refine rather than by a second hand-written
 *  tuple — so the accepted set is derived from the Record above and cannot drift from it. The
 *  refusal message names the types on purpose: a CI job that gets this back should be able to fix
 *  its payload without reading our source. */
const ciIngestibleType = z
  .enum(securityFindingTypes)
  .refine((type) => CI_INGESTIBLE_BY_TYPE[type], {
    message: `type must be one of ${CI_INGESTIBLE_FINDING_TYPES.join(", ")} — VAPT reports are uploaded from Workspace Settings, not posted by CI`
  });

const findingSchema = z.object({
  type: ciIngestibleType,
  tool: z.string().min(1).max(80),
  severity: z.enum(securityFindingSeverities),
  title: z.string().min(1).max(255),
  description: z.string().max(20000).optional(),
  cwe: z.string().max(40).optional(),
  // The scanner's own name for the rule that fired (SARIF's `ruleId`). Accepted but NOT STORED:
  // it exists only as an input to `deriveFindingFingerprint`, which prefers a CWE and falls back
  // to this for the many tools that tag no CWE. There is no column for it because nothing reads
  // one — the fingerprint is the identity everything downstream keys on, and it is derived from
  // the payload on every ingest rather than recomputed from the row.
  ruleId: z.string().max(200).optional(),
  filePath: z.string().max(500).optional(),
  lineNumber: z.coerce.number().int().positive().optional(),
  repository: z.string().max(255).optional(),
  branch: z.string().max(255).optional(),
  prUrl: z.string().max(500).optional(),
  ticketKey: z.string().max(20).optional()
});

const findingsBatchSchema = z.object({
  body: z.object({
    findings: z.array(findingSchema).min(1).max(500),
    // Batch-level, because it describes the SCAN rather than any one finding: every result in one
    // scanner's output came off the same checkout. Optional — no scanner output carries it, so it
    // has to come from the CI job's own environment, and an ingest that worked yesterday must not
    // start failing because it does not send one.
    commitSha: z.string().max(64).optional()
  })
});

type FindingInput = z.infer<typeof findingSchema>;

/**
 * How many findings in one ingest request may reach a model.
 *
 * A batch is up to 500 findings and the AI triage in it used to run inside the same `Promise.all`
 * as the row creation, one model call per CRITICAL/HIGH finding. Two problems, both reachable with
 * nothing but a CI ingestion token:
 *
 *  - COST. One HTTP request the per-IP limiter counts once could issue ~500 model calls. The
 *    monthly budget cap is the only thing standing between that and the whole month's spend.
 *  - THE BUDGET CAP ITSELF. `ai.service.ts#preflight` reads the month's spend so far and compares
 *    it to the ceiling; `logAIUsage` writes the row that moves that number. Fired concurrently,
 *    all 500 read the same total before any of them has written anything, so all 500 pass a cap
 *    that only one of them should have. The clamp was not skipped, it was raced.
 *
 * Sequential-and-capped fixes both: each call's usage row lands before the next one's preflight
 * reads it, so the cap does what it says, and the fan-out per request is bounded regardless.
 * Findings past the cap are still ingested and still auto-ticketed — they just do not get an AI
 * opinion, which is the part that costs money and the part a scanner can trivially produce more of.
 */
const MAX_AI_TRIAGED_FINDINGS_PER_BATCH = 20;

/** What one ingest request reports about the SCAN rather than about any single finding. */
interface ScanContext {
  commitSha?: string;
}

/** What an ingest did, per the response body. `ingested` is what the caller sent and is always
 *  `created + updated`; the split is what tells a CI job whether tonight's scan found anything new. */
export interface IngestOutcome {
  ingested: number;
  created: number;
  updated: number;
}

/**
 * A batch is grouped into scans by (tool, type, repository, branch) and each group gets one
 * ScanRun, rather than one run per HTTP request.
 *
 * WHY: nothing stops a CI job posting semgrep's and gitleaks' results in a single call — the docs'
 * own examples build one payload with `jq` — and "the most recent run of semgrep on main" has to
 * mean one tool's scan or it means nothing at all. Grouping is what makes a run comparable to the
 * run before it, which is the entire reason the model exists.
 */
function scanGroupKey(f: FindingInput): string {
  // JSON rather than a joined string for the same reason the fingerprint uses it: a repository or
  // branch name containing the delimiter cannot forge a different group.
  return JSON.stringify([f.tool, f.type, f.repository ?? null, f.branch ?? null]);
}

/**
 * Shared by both /findings (native JSON) and /findings/sarif (translated below) so the two
 * ingestion paths can never drift on how a finding is identified, deduplicated, or ticketed.
 *
 * ── WHY THIS IS NO LONGER AN UNCONDITIONAL `create` ───────────────────────────────────────────
 *
 * It used to be. A nightly scan reporting the same 200 issues inserted 200 rows every night, so a
 * workspace that fixed nothing and broke nothing watched its risk score climb, its insights trend
 * slope upwards, its weekly digest count one vulnerability seven times, and — worst of the four —
 * auto-ticket-creation open a fresh ticket for the same line of code every morning. Every
 * individual row was correct. There was simply nothing that could answer "have we seen this
 * before?".
 *
 * Now each finding is identified by `deriveFindingFingerprint` (see that file for the recipe) and
 * matched against existing rows on (fingerprint, repository, branch). A match bumps `lastSeenAt`
 * and `occurrences` and re-points `scanRunId` at tonight's run. It does NOT change the finding's
 * status: re-reporting something is not a reason to reopen it, and deciding what a still-present
 * finding means is the verification work's job, not the ingest's.
 *
 * WHY NOT `prisma.upsert` ON A UNIQUE CONSTRAINT, which is the obvious shape: MySQL treats NULLs
 * as distinct within a unique index, and `repository`/`branch` are both optional — so the
 * constraint would silently fail to apply to the large share of findings posted without a repo,
 * while the cases where it DID apply would turn a concurrent double-post into a P2002 that fails
 * the whole batch. The read-then-write below is therefore not atomic, and two scans racing on the
 * same finding can still produce two rows. That is worth being explicit about, and it is also
 * exactly what happens today on every single ingest, so the race's worst case is the old
 * behaviour rather than a new failure.
 *
 * A finding with NO derivable fingerprint (no file path, or neither a CWE nor a rule id) falls
 * back to create-always. Dropping it instead would mean losing a real vulnerability because we
 * could not name it, which is a far worse outcome than storing it twice.
 */
async function ingestFindingsBatch(findings: FindingInput[], context: ScanContext = {}): Promise<IngestOutcome> {
  // One run per (tool, type, repository, branch). `findingCount` is the size of the group as SENT,
  // set here rather than counted from the relation afterwards, because the most interesting run of
  // all is one that reported nothing and therefore has no findings to count.
  const groups = new Map<string, FindingInput[]>();
  for (const f of findings) {
    const key = scanGroupKey(f);
    const existing = groups.get(key);
    if (existing) existing.push(f);
    else groups.set(key, [f]);
  }

  // WHERE EACH FINDING BELONGS — repository → project, file path → module/submodule. Read ONCE for
  // the whole batch and then matched in memory per finding (see finding-routing.service.ts): a
  // batch is up to 500 findings, and per-finding queries on this route are exactly the shape
  // MAX_AI_TRIAGED_FINDINGS_PER_BATCH exists to stop. Rules are a handful of rows; matching them is
  // string work.
  //
  // Degrades to no rules rather than failing the ingest, same posture as every other optional step
  // here: a workspace that has configured nothing routes nothing, and that is the behaviour this
  // route had before routing existed.
  const routingRules = await loadFindingRoutingRules().catch((error) => {
    console.warn(`[devops-webhook] could not read finding-routing rules; findings will be stored unrouted: ${(error as Error).message}`);
    return NO_FINDING_ROUTING_RULES;
  });

  const scanRunIdByGroup = new Map<string, string>();
  for (const [key, groupFindings] of groups) {
    const first = groupFindings[0];
    const run = await prisma.scanRun.create({
      data: {
        tool: first.tool,
        type: first.type,
        repository: first.repository,
        branch: first.branch,
        commitSha: context.commitSha,
        findingCount: groupFindings.length
      }
    });
    scanRunIdByGroup.set(key, run.id);
  }

  const touched = await Promise.all(
    findings.map(async (f) => {
      const ticketId = await resolveTicketId(f.ticketKey);
      const scanRunId = scanRunIdByGroup.get(scanGroupKey(f));
      const fingerprint = deriveFindingFingerprint({
        tool: f.tool,
        ruleId: f.ruleId,
        cwe: f.cwe,
        filePath: f.filePath,
        lineNumber: f.lineNumber
      });

      const location = resolveFindingLocation(routingRules, f);

      const existing = fingerprint
        ? await prisma.securityFinding.findFirst({
            where: { fingerprint, repository: f.repository ?? null, branch: f.branch ?? null },
            orderBy: { createdAt: "asc" }
          })
        : null;

      if (existing) {
        const finding = await prisma.securityFinding.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: new Date(),
            occurrences: { increment: 1 },
            scanRunId,
            // Adopt a ticket link the first sighting did not have — a later scan naming a ticket
            // key is new information. Never STEALS one: a finding already attached to a ticket
            // stays there, because somebody may have moved it deliberately.
            ...(ticketId && !existing.ticketId ? { ticketId } : {}),
            // Same adopt-but-never-overwrite shape for the module: a finding first seen before any
            // routing rule existed picks one up as soon as a rule covers it, which is what makes
            // the per-module breakdown fill in for an existing backlog instead of only for new
            // findings. A finding that already has a module keeps it — re-deriving it every night
            // would let a rule edit silently rewrite history nobody asked it to.
            ...(location.moduleId && !existing.moduleId ? { moduleId: location.moduleId, submoduleId: location.submoduleId } : {})
          }
        });
        // Deliberately NOT overwritten on a re-sighting: title, description, severity. A human may
        // have triaged against exactly what the first report said, and a scanner rewording its
        // message or re-scoring its severity between versions must not silently rewrite the record
        // that triage was based on — nor move the risk score without anybody asking for it.
        //
        // KNOWN CONSEQUENCE, stated rather than discovered: `updatedAt` moves on every re-sighting,
        // and report.controller.ts derives `meanTimeToRemediateHours` from `updatedAt - createdAt`
        // for resolved findings (its own header already flags that as an approximation awaiting a
        // real `resolvedAt` column). So a FIXED finding a scanner keeps reporting inflates that one
        // average. The right answer to "the scanner still reports something we called fixed" is to
        // reopen it, which is the verification work's decision to make, not the ingest's.
        return { finding, isNew: false };
      }

      const finding = await prisma.securityFinding.create({
        data: {
          ticketId,
          type: f.type,
          tool: f.tool,
          severity: f.severity,
          title: f.title,
          description: f.description,
          cwe: f.cwe,
          filePath: f.filePath,
          lineNumber: f.lineNumber,
          repository: f.repository,
          branch: f.branch,
          prUrl: f.prUrl,
          fingerprint,
          scanRunId,
          // Null when nothing matched, which is the ordinary case for a workspace with no rules.
          moduleId: location.moduleId,
          submoduleId: location.submoduleId
        }
      });
      return { finding, isNew: true };
    })
  );

  // THE TICKETING SIDE EFFECTS FIRE ONLY FOR GENUINELY NEW FINDINGS, and that is the whole point
  // of the deduplication above — a nightly scan re-reporting the same issue must not open a ticket
  // for it every night, nor keep reopening the ticket somebody just closed.
  //
  // WHAT THAT COSTS, honestly: a re-sighting no longer RETRIES auto-ticket creation, so a finding
  // first seen before the fallback project was configured never gets a ticket from a later scan.
  // The first sighting is the one that decides. That is the correct trade against reopening a
  // closed ticket every morning, and a workspace in that position can attach the finding by hand.
  for (const { finding, isNew } of touched) {
    if (!isNew) continue;
    if (!finding.ticketId) {
      // No ticket to attach to — see security-report.service.ts#maybeAutoCreateTicketForFinding
      // for the severity/fallback-project gating. Never throws: a misconfigured fallback
      // project shouldn't fail the whole ingestion batch, it should just leave this finding
      // ticket-less.
      await maybeAutoCreateTicketForFinding(finding).catch((error) =>
        console.warn(`[devops-webhook] auto-ticket-creation failed for finding ${finding.id}: ${(error as Error).message}`)
      );
    } else {
      // A finding landed against an *existing* ticket — if that ticket is currently
      // RESOLVED/CLOSED, this is a regression (the issue came back, or a new one was found on
      // the same ticket's repo/branch) and should reopen it, same trigger as a failing TestRun
      // below. maybeReopenTicketOnRegression no-ops unless IngestionSettings.autoReopenEnabled
      // is on, so this is safe to call unconditionally.
      await maybeReopenTicketOnRegression(finding.ticketId, `A new ${finding.severity} ${finding.type} finding from ${finding.tool}`).catch((error) =>
        console.warn(`[devops-webhook] auto-reopen check failed for ticket ${finding.ticketId}: ${(error as Error).message}`)
      );
    }
  }

  // Opt-in AI exploitability triage (GlobalAISettings.findingTriageEnabled) — CRITICAL/HIGH only,
  // see security-report.service.ts#maybeTriageFindingWithAI. Deliberately AFTER the batch and one
  // at a time rather than inside the Promise.all above; see
  // MAX_AI_TRIAGED_FINDINGS_PER_BATCH for why concurrency here defeated the budget cap. Never
  // throws: a disabled toggle or an exhausted budget should skip triage, not fail ingestion.
  //
  // Candidates are findings that have never been triaged, new or not — a row that deduplicated
  // onto an existing finding still deserves an opinion if it never got one (it may have been past
  // the cap on the batch that created it). Already-triaged rows are skipped: re-asking a model
  // about a finding it has already judged spends money to learn nothing.
  const triageCandidates = touched.map((t) => t.finding).filter((finding) => !finding.aiTriagedAt);
  for (const finding of triageCandidates.slice(0, MAX_AI_TRIAGED_FINDINGS_PER_BATCH)) {
    await maybeTriageFindingWithAI(finding).catch((error) =>
      console.warn(`[devops-webhook] AI triage failed for finding ${finding.id}: ${(error as Error).message}`)
    );
  }

  // THE VERIFICATION VERDICT — see security-report.service.ts#verifyFindingsAgainstScanRun.
  //
  // Every run this batch recorded is compared against the findings awaiting proof on the same
  // repository and branch, and only findings reported by the SAME TOOL are eligible. This is where
  // "the scanner stopped reporting it" finally means something, which is the entire reason ScanRun
  // exists.
  //
  // WHY THE FINGERPRINT LIST IS PASSED IN rather than re-read from `scanRunId` on the findings: the
  // ingest already has it, and re-querying would race the next scan re-pointing a finding at a newer
  // run. That race's failure mode is a SHORTER list — i.e. wrongly concluding a finding is gone —
  // which is wrong in the dangerous direction. A run whose findings were all unidentifiable
  // contributes an EMPTY list rather than being skipped, because "this tool reported nothing we can
  // name" is still a run that happened.
  //
  // Awaited with a `.catch`, exactly like the ticketing side effects above: a verification failure
  // must never fail an ingest, and a CI job POSTing a scan has no deadline the way a user's click
  // does. The mail this can trigger is detached inside the service, not here.
  const fingerprintsByRun = new Map<string, string[]>();
  for (const runId of scanRunIdByGroup.values()) fingerprintsByRun.set(runId, []);
  findings.forEach((f, index) => {
    const runId = scanRunIdByGroup.get(scanGroupKey(f));
    const fingerprint = touched[index]?.finding.fingerprint;
    if (runId && fingerprint) fingerprintsByRun.get(runId)!.push(fingerprint);
  });
  for (const [runId, fingerprints] of fingerprintsByRun) {
    await verifyFindingsAgainstScanRun(runId, fingerprints).catch((error) =>
      console.warn(`[devops-webhook] verification verdict failed for scan run ${runId}: ${(error as Error).message}`)
    );
  }

  const created = touched.filter((t) => t.isNew).length;
  return { ingested: touched.length, created, updated: touched.length - created };
}

devopsWebhookRouter.post("/:orgSlug/findings", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidIngestionToken(req);
      const parsed = findingsBatchSchema.safeParse({ body: req.body });
      if (!parsed.success) throw new AppError(422, `Invalid findings payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      // `created` keeps its old meaning — rows that did not exist before — so a CI job asserting
      // on it still reads what it always read. `ingested` and `updated` are the new part, and
      // `updated` is the number worth watching: a nightly scan whose `created` is 0 found nothing
      // new, which used to be indistinguishable from a scan that found 200 problems.
      const outcome = await ingestFindingsBatch(parsed.data.body.findings, { commitSha: parsed.data.body.commitSha });
      res.status(201).json(outcome);
    });
  } catch (error) {
    next(error);
  }
});

// --- SARIF 2.1.0 ingestion --------------------------------------------------------------------
// Accepts the standard output format GitHub Code Scanning / codeql-action, `semgrep --sarif`, and
// Azure DevOps' native scan tasks all already produce, so those tools need zero hand-written `jq`
// translation to plug into TimeSphere — unlike the /findings route above, which expects the
// findings already in TimeSphere's own shape. See docs/SECURITY_DEVOPS_INTEGRATIONS.md.

const SARIF_LEVEL_TO_SEVERITY: Record<string, (typeof securityFindingSeverities)[number]> = {
  error: "HIGH",
  warning: "MEDIUM",
  note: "LOW",
  none: "LOW"
};

/** GitHub's CodeQL/Advanced-Security convention: a numeric CVSS-like score in
 *  `result.properties["security-severity"]` (string or number, 0-10) — present far more often
 *  than a plain SARIF `level`, and a better severity signal when it is, so it's checked first. */
function severityFromSarifResult(result: Record<string, unknown>): (typeof securityFindingSeverities)[number] {
  const props = (result.properties ?? {}) as Record<string, unknown>;
  const rawScore = props["security-severity"] ?? props.securitySeverity;
  const numericScore = typeof rawScore === "string" ? Number(rawScore) : typeof rawScore === "number" ? rawScore : undefined;
  if (typeof numericScore === "number" && !Number.isNaN(numericScore)) {
    if (numericScore >= 9) return "CRITICAL";
    if (numericScore >= 7) return "HIGH";
    if (numericScore >= 4) return "MEDIUM";
    return "LOW";
  }
  const level = String((result as { level?: unknown }).level ?? "warning").toLowerCase();
  return SARIF_LEVEL_TO_SEVERITY[level] ?? "MEDIUM";
}

/** Best-effort CWE extraction from the SARIF rule's own tags (e.g. `"external/cwe/cwe-89"`,
 *  CodeQL/Semgrep's convention) — absent entirely for tools that don't tag rules this way, which
 *  is fine, `cwe` is an optional field on `SecurityFinding` either way. */
function cweFromSarifRule(run: Record<string, unknown>, ruleId: string | undefined): string | undefined {
  if (!ruleId) return undefined;
  const rules = ((run.tool as Record<string, unknown> | undefined)?.driver as Record<string, unknown> | undefined)?.rules as
    | Array<Record<string, unknown>>
    | undefined;
  const rule = rules?.find((r) => r.id === ruleId);
  const tags = ((rule?.properties as Record<string, unknown> | undefined)?.tags ?? []) as unknown[];
  for (const tag of tags) {
    const match = String(tag).match(/cwe-(\d+)/i);
    if (match) return `CWE-${match[1]}`;
  }
  return undefined;
}

/** The scanner's own name, per SARIF's `runs[].tool.driver.name`. Needed on its own for the
 *  zero-results case, where there is no finding to carry the tool name but a ScanRun still has to
 *  say WHICH scanner reported nothing — "nothing found" is meaningless without it. */
function sarifToolName(sarif: Record<string, unknown>): string {
  const runs = (sarif.runs ?? []) as Array<Record<string, unknown>>;
  const driver = (runs[0]?.tool as Record<string, unknown> | undefined)?.driver as Record<string, unknown> | undefined;
  return String(driver?.name ?? "sarif").slice(0, 80);
}

/** Flattens every run/result in a SARIF 2.1.0 log into TimeSphere's own finding shape. Contextual
 *  fields SARIF has no room for (repository/branch/prUrl/ticketKey, which tool ran, whether this
 *  is a SAST/DAST/SSAT/SSCT scan) come from `defaults` — the CI job supplies them once per
 *  request, not per-result, since they're the same for every result in one scan's output. */
function mapSarifToFindingInputs(
  sarif: Record<string, unknown>,
  defaults: { type: FindingInput["type"]; repository?: string; branch?: string; prUrl?: string; ticketKey?: string }
): FindingInput[] {
  const out: FindingInput[] = [];
  const runs = (sarif.runs ?? []) as Array<Record<string, unknown>>;
  for (const run of runs) {
    const toolName = String(((run.tool as Record<string, unknown> | undefined)?.driver as Record<string, unknown> | undefined)?.name ?? "sarif");
    const results = (run.results ?? []) as Array<Record<string, unknown>>;
    for (const result of results) {
      const ruleId = result.ruleId as string | undefined;
      const message = (result.message as Record<string, unknown> | undefined)?.text as string | undefined;
      const locations = (result.locations ?? []) as Array<Record<string, unknown>>;
      const physical = (locations[0]?.physicalLocation ?? {}) as Record<string, unknown>;
      const artifactUri = ((physical.artifactLocation as Record<string, unknown> | undefined)?.uri as string | undefined) ?? undefined;
      const startLine = (physical.region as Record<string, unknown> | undefined)?.startLine as number | undefined;

      out.push({
        type: defaults.type,
        tool: toolName.slice(0, 80),
        severity: severityFromSarifResult(result),
        title: (message ?? ruleId ?? "SARIF finding").slice(0, 255),
        description: message?.slice(0, 20000),
        cwe: cweFromSarifRule(run, ruleId),
        // Carried through purely to identify the finding — SARIF's `ruleId` is the stable name of
        // the rule that fired, where `title` is its MESSAGE and routinely interpolates the offending
        // variable ("Potential SQL injection in `userId`"). Hashing the message would make a
        // renamed variable look like a new vulnerability. Nothing stores this; see findingSchema.
        ruleId: ruleId?.slice(0, 200),
        filePath: artifactUri?.slice(0, 500),
        lineNumber: typeof startLine === "number" && startLine > 0 ? startLine : undefined,
        repository: defaults.repository,
        branch: defaults.branch,
        prUrl: defaults.prUrl,
        ticketKey: defaults.ticketKey
      });
    }
  }
  return out;
}

const sarifRequestSchema = z.object({
  body: z.object({
    // Accept either a wrapper (`{ sarif, type, repository, ... }`) or, if the whole POST body
    // *is* a raw SARIF log (a tool's `--sarif` flag piped straight into `curl -d @-`), fields
    // fall back to query params instead — see the handler below.
    sarif: z.record(z.string(), z.unknown()).optional(),
    version: z.string().optional(), // present at top level when the body IS the raw SARIF log
    runs: z.array(z.record(z.string(), z.unknown())).optional(), // ditto
    type: ciIngestibleType.optional(),
    repository: z.string().max(255).optional(),
    branch: z.string().max(255).optional(),
    prUrl: z.string().max(500).optional(),
    ticketKey: z.string().max(20).optional(),
    // Same batch-level scan context as the native route — see findingsBatchSchema. Also accepted
    // as a query param below, because a raw SARIF log posted as the whole body has no room for it.
    commitSha: z.string().max(64).optional()
  })
});

devopsWebhookRouter.post("/:orgSlug/findings/sarif", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidIngestionToken(req);
      const parsed = sarifRequestSchema.safeParse({ body: req.body });
      if (!parsed.success) throw new AppError(422, `Invalid SARIF payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      const body = parsed.data.body;

      // The body IS a raw SARIF log (has its own top-level `runs`) vs. a wrapper carrying
      // `{ sarif: {...}, ...context }` — support both since some CI setups pipe a scanner's
      // `--sarif` output directly with no way to inject sibling fields into the same JSON.
      const sarifDoc = body.sarif ?? (body.runs ? { runs: body.runs } : undefined);
      if (!sarifDoc) throw new AppError(422, "No SARIF document found — send either a raw SARIF log as the body, or { sarif: {...}, ... }.");

      const typeParam = (req.query.type as string | undefined)?.toUpperCase();
      const isValidTypeParam = typeParam !== undefined && (CI_INGESTIBLE_FINDING_TYPES as readonly string[]).includes(typeParam);
      const resolvedType: FindingInput["type"] = body.type ?? (isValidTypeParam ? (typeParam as FindingInput["type"]) : "SAST");

      const inputs = mapSarifToFindingInputs(sarifDoc, {
        type: resolvedType,
        repository: body.repository ?? (req.query.repository as string | undefined),
        branch: body.branch ?? (req.query.branch as string | undefined),
        prUrl: body.prUrl ?? (req.query.prUrl as string | undefined),
        ticketKey: body.ticketKey ?? (req.query.ticketKey as string | undefined)
      });
      if (inputs.length === 0) {
        // A scan that found NOTHING is the most informative run there is — it is the evidence that
        // everything previously reported on this repo+branch is gone. So the run is recorded even
        // though there is nothing to ingest, rather than the request being a no-op that leaves the
        // history looking like the scanner never ran.
        const emptyRun = await prisma.scanRun.create({
          data: {
            tool: sarifToolName(sarifDoc),
            type: resolvedType,
            repository: body.repository ?? (req.query.repository as string | undefined),
            branch: body.branch ?? (req.query.branch as string | undefined),
            commitSha: body.commitSha ?? (req.query.commitSha as string | undefined),
            findingCount: 0
          }
        });
        // And it is judged like any other run, with an empty set of reported fingerprints — which is
        // precisely what makes it the strongest evidence this system can receive. A clean scan is
        // the run that proves the whole backlog gone; skipping the verdict here because there was
        // "nothing to ingest" would throw away the one payload that most deserves it.
        await verifyFindingsAgainstScanRun(emptyRun.id, []).catch((error) =>
          console.warn(`[devops-webhook] verification verdict failed for empty scan run ${emptyRun.id}: ${(error as Error).message}`)
        );
        return res.status(201).json({ ingested: 0, created: 0, updated: 0, note: "SARIF log parsed but contained zero results." });
      }
      if (inputs.length > 500) throw new AppError(422, "SARIF log contains more than 500 results — split into multiple requests.");

      const outcome = await ingestFindingsBatch(inputs, { commitSha: body.commitSha ?? (req.query.commitSha as string | undefined) });
      res.status(201).json(outcome);
    });
  } catch (error) {
    next(error);
  }
});

// --- SonarQube ingestion ----------------------------------------------------------------------
// Two routes, because SonarQube emits two entirely different things and conflating them would make
// both useless:
//
//   * `/quality-gate` receives Sonar's WEBHOOK payload, which is a pass/fail verdict about a branch
//     and carries no issues at all. Stored as a `QualityGateRun`.
//   * `/findings/sonar` receives the response of Sonar's `/api/issues/search` API, which is the
//     issues themselves. Translated into findings and put through the ordinary ingest.
//
// A customer pastes the first URL into Sonar's Administration → Webhooks and adds a `curl` step to
// their pipeline for the second. Neither needs a line of `jq`: both accept the payloads those two
// systems already produce, verbatim.

/**
 * Sonar's five severities onto this app's four.
 *
 * BLOCKER and CRITICAL both land on CRITICAL, which is the only pair that collapses: Sonar's own
 * definitions ("must be fixed immediately" / "must be reviewed immediately") are the same urgency
 * with different blast radius, and inventing a fifth level here to keep them apart would break every
 * severity filter, chart and SLA in the product for one vendor's taxonomy. MAJOR → HIGH rather than
 * MEDIUM because MAJOR is Sonar's default for most real defects and the modal value in any real
 * project; mapping it to MEDIUM would make a repository's whole issue list disappear below the fold.
 */
const SONAR_SEVERITY_TO_SEVERITY: Record<string, (typeof securityFindingSeverities)[number]> = {
  BLOCKER: "CRITICAL",
  CRITICAL: "CRITICAL",
  MAJOR: "HIGH",
  MINOR: "MEDIUM",
  INFO: "LOW"
};

/**
 * SONAR'S OWN TAXONOMY ALREADY CARRIES THE DISTINCTION THIS PRODUCT NEEDS, so the mapping is a
 * lookup rather than a judgement.
 *
 * VULNERABILITY → SAST. It is static analysis that found a vulnerability, which is precisely what
 * SAST means here, and it belongs in the security numbers exactly like a Semgrep finding does. A
 * workspace that runs Sonar and nothing else should still see its injection risks in the risk score.
 *
 * BUG and CODE_SMELL → QUALITY. Both are maintainability. A null-dereference bug is a real defect
 * and worth a ticket, and it is still not an exposure — see `securityFindingTypeDisciplines` in
 * packages/shared for what happens to a security metric that counts them.
 *
 * ANYTHING ELSE → QUALITY, deliberately, as the safe default: a scanner introducing a new type must
 * not be able to inflate a security score by doing so. Sonar's SECURITY_HOTSPOT is the type a reader
 * will ask about — it does not arrive here, because Sonar moved hotspots out of
 * `/api/issues/search` and onto `/api/hotspots/search`; if a payload from an older server does carry
 * one, it lands on QUALITY, which is the conservative answer for "code that needs a human to look at
 * it" rather than a confirmed weakness.
 */
const SONAR_ISSUE_TYPE_TO_FINDING_TYPE: Record<string, SecurityFindingType> = {
  VULNERABILITY: "SAST",
  BUG: "QUALITY",
  CODE_SMELL: "QUALITY"
};

/**
 * `"com.acme:my-module:src/db/query.ts"` -> `"src/db/query.ts"`.
 *
 * SPLIT ON THE LAST COLON, NOT THE FIRST. A Sonar project key routinely contains colons — Maven
 * keys are `groupId:artifactId` by convention and multi-module analyses append the module — so
 * splitting on the first one yields `my-module:src/db/query.ts`, a path that matches no routing rule
 * and, worse, fingerprints differently from the same file reported by any other tool. Two rows for
 * one problem, no dedup, and a verification ladder that can never conclude anything.
 *
 * The residual case, stated rather than discovered: a file path that itself contains a colon (legal
 * on Linux, not on Windows) loses everything up to the last one. That is a worse failure than the
 * first-colon split for exactly one exotic file and a better one for every ordinary multi-module
 * project, which is the trade taken.
 */
function pathFromSonarComponent(component: string | undefined): string | undefined {
  if (!component) return undefined;
  const lastColon = component.lastIndexOf(":");
  const path = lastColon === -1 ? component : component.slice(lastColon + 1);
  return path.length > 0 ? path : undefined;
}

/** Flattens a Sonar `/api/issues/search` response into TimeSphere's own finding shape. Context Sonar
 *  has no room for (repository/branch/prUrl/ticketKey, the checkout root) comes from `defaults` —
 *  the CI job supplies it once per request, since it is the same for every issue in one analysis. */
function mapSonarIssuesToFindingInputs(
  issues: Array<Record<string, unknown>>,
  defaults: { tool: string; repository?: string; branch?: string; prUrl?: string; ticketKey?: string; rootPath?: string }
): FindingInput[] {
  return issues.map((issue) => {
    const rule = typeof issue.rule === "string" ? issue.rule : undefined;
    const message = typeof issue.message === "string" ? issue.message : undefined;
    const line = typeof issue.line === "number" ? issue.line : undefined;
    const severity = SONAR_SEVERITY_TO_SEVERITY[String(issue.severity ?? "").toUpperCase()] ?? "MEDIUM";
    const type = SONAR_ISSUE_TYPE_TO_FINDING_TYPE[String(issue.type ?? "").toUpperCase()] ?? "QUALITY";
    const rawPath = pathFromSonarComponent(typeof issue.component === "string" ? issue.component : undefined);
    // Repo-relative before it is stored, not just before it is hashed — see `toRepoRelativePath`.
    // The path is also what the module routing rules match on, so a project-key-prefixed path would
    // silently route nothing as well as fingerprinting wrong.
    const filePath = rawPath ? toRepoRelativePath(rawPath, defaults.rootPath) : "";
    // `effort` ("15min") and `tags` are Sonar's own annotations. Appended to the description rather
    // than given columns: nothing queries them, and the person reading the finding wants them.
    const effort = typeof issue.effort === "string" ? issue.effort : undefined;
    const tags = Array.isArray(issue.tags) ? issue.tags.filter((t): t is string => typeof t === "string") : [];
    const extras = [effort ? `Estimated effort: ${effort}` : null, tags.length > 0 ? `Tags: ${tags.join(", ")}` : null].filter(Boolean);

    return {
      type,
      tool: defaults.tool,
      severity,
      title: (message ?? rule ?? "SonarQube issue").slice(0, 255),
      description: [message, ...extras].filter(Boolean).join("\n\n").slice(0, 20000) || undefined,
      // Sonar reports no CWE on an ordinary issue, so the rule key IS the identity — see
      // `ruleIdentityOf` in utils/finding-fingerprint.ts. Deliberately NOT Sonar's `key`: that is
      // the identity of a row in SONAR's database, it changes when Sonar re-keys an issue, and
      // trusting it would hand a scanner control over what this app considers "the same problem".
      ruleId: rule?.slice(0, 200),
      filePath: filePath ? filePath.slice(0, 500) : undefined,
      lineNumber: typeof line === "number" && line > 0 ? line : undefined,
      repository: defaults.repository,
      branch: defaults.branch,
      prUrl: defaults.prUrl,
      ticketKey: defaults.ticketKey
    };
  });
}

const sonarIssuesRequestSchema = z.object({
  body: z.object({
    // A verbatim `/api/issues/search` response. `total`/`p`/`ps` come with it and are ignored — the
    // point of accepting the shape verbatim is that a CI job can pipe the response straight through.
    issues: z.array(z.record(z.string(), z.unknown())).optional(),
    // Context Sonar's response has no room for. Also accepted as query params below, for the job
    // that pipes the response body through untouched.
    tool: z.string().min(1).max(80).optional(),
    repository: z.string().max(255).optional(),
    branch: z.string().max(255).optional(),
    prUrl: z.string().max(500).optional(),
    ticketKey: z.string().max(20).optional(),
    commitSha: z.string().max(64).optional(),
    /** The CI workspace directory, when the caller knows it — stripped from every path so two
     *  runners with different checkout roots produce the same fingerprint. Sonar's own paths are
     *  already repo-relative, so this is normally unnecessary here and is accepted for symmetry with
     *  the ESLint route, where it matters. */
    rootPath: z.string().max(500).optional()
  })
});

devopsWebhookRouter.post("/:orgSlug/findings/sonar", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidIngestionToken(req);
      const parsed = sonarIssuesRequestSchema.safeParse({ body: req.body });
      if (!parsed.success) throw new AppError(422, `Invalid SonarQube payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      const body = parsed.data.body;
      const queryValue = (name: string) => req.query[name] as string | undefined;

      const issues = body.issues ?? [];
      const tool = (body.tool ?? queryValue("tool") ?? "sonarqube").slice(0, 80);
      const commitSha = body.commitSha ?? queryValue("commitSha");
      const repository = body.repository ?? queryValue("repository");
      const branch = body.branch ?? queryValue("branch");

      if (issues.length === 0) {
        // Same reasoning as the empty-SARIF branch above: an analysis that reported nothing is the
        // strongest evidence this system can receive, so it is recorded and judged rather than
        // treated as a no-op.
        //
        // ONE RUN PER TYPE THIS TOOL CAN PRODUCE, not one run. The verdict is restricted to the
        // run's own type (see verifyFindingsAgainstScanRun), and a clean Sonar analysis is evidence
        // about BOTH halves of what Sonar reports — its vulnerabilities and its code smells are
        // equally gone. A single SAST run would clear the security backlog and leave every QUALITY
        // finding on this repo and branch waiting forever for proof that had already arrived.
        const emptyTypes = Array.from(new Set(Object.values(SONAR_ISSUE_TYPE_TO_FINDING_TYPE)));
        for (const type of emptyTypes) {
          const emptyRun = await prisma.scanRun.create({
            data: { tool, type, repository, branch, commitSha, findingCount: 0 }
          });
          await verifyFindingsAgainstScanRun(emptyRun.id, []).catch((error) =>
            console.warn(`[devops-webhook] verification verdict failed for empty Sonar run ${emptyRun.id}: ${(error as Error).message}`)
          );
        }
        return res.status(201).json({ ingested: 0, created: 0, updated: 0, note: "SonarQube response parsed but contained zero issues." });
      }
      if (issues.length > 500) throw new AppError(422, "SonarQube response contains more than 500 issues — page it (`ps=500`) into multiple requests.");

      const inputs = mapSonarIssuesToFindingInputs(issues, {
        tool,
        repository,
        branch,
        prUrl: body.prUrl ?? queryValue("prUrl"),
        ticketKey: body.ticketKey ?? queryValue("ticketKey"),
        rootPath: body.rootPath ?? queryValue("rootPath")
      });

      // Straight into the SHARED ingest — deliberately not a second write path. Fingerprinting,
      // dedup, ScanRun grouping, module routing, auto-ticketing, AI triage and the verification
      // verdict all apply to a Sonar issue exactly as they do to a Semgrep one, and the only way to
      // keep that true is to have one implementation of it.
      const outcome = await ingestFindingsBatch(inputs, { commitSha });
      res.status(201).json(outcome);
    });
  } catch (error) {
    next(error);
  }
});

// --- ESLint ingestion -------------------------------------------------------------------------

/**
 * ESLint's two severities onto this app's four.
 *
 * `2` (error) → MEDIUM and `1` (warn) → LOW, and the ceiling is the point. A lint error is a real
 * defect and worth recording; it is not a HIGH. Three things key off CRITICAL/HIGH in this codebase
 * and all three would be wrong for a lint rule:
 *
 *   * `maybeAutoCreateTicketForFinding` opens a ticket for every CRITICAL/HIGH finding with no
 *     ticket key. One `eslint --format json` run on a legacy repository would open a thousand.
 *   * `maybeTriageFindingWithAI` sends CRITICAL/HIGH findings to a model. Same run, real money.
 *   * The Security Insights page's "Critical + high open" tile — although the discipline filter
 *     already keeps LINT out of that one, defending it twice costs nothing.
 *
 * Keeping the whole type below the HIGH bar means an org can turn lint ingestion on without any of
 * that firing, and still sort its lint backlog by severity, because error and warn stay distinct.
 */
const ESLINT_SEVERITY_TO_SEVERITY: Record<number, (typeof securityFindingSeverities)[number]> = {
  2: "MEDIUM",
  1: "LOW"
};

/** One entry of `eslint --format json`: a file, and the messages in it. */
const eslintResultSchema = z.object({
  filePath: z.string().min(1).max(4000),
  messages: z
    .array(
      z.object({
        ruleId: z.string().max(200).nullable().optional(),
        severity: z.coerce.number().int().optional(),
        message: z.string().max(20000).optional(),
        line: z.coerce.number().int().optional(),
        column: z.coerce.number().int().optional()
      })
    )
    .optional()
});

/**
 * `eslint --format json` is a BARE ARRAY at the top level, so this route accepts one — and also a
 * `{ results: [...] }` wrapper, because that is the only way a caller can attach the repository,
 * branch and ticket context the format itself has no room for. A bare array falls back to query
 * params for all of it, exactly like the SARIF route.
 */
const eslintRequestSchema = z.union([
  z.array(eslintResultSchema),
  z.object({
    results: z.array(eslintResultSchema),
    tool: z.string().min(1).max(80).optional(),
    repository: z.string().max(255).optional(),
    branch: z.string().max(255).optional(),
    prUrl: z.string().max(500).optional(),
    ticketKey: z.string().max(20).optional(),
    commitSha: z.string().max(64).optional(),
    /** The directory ESLint ran in. THE IMPORTANT FIELD ON THIS ROUTE: ESLint reports absolute
     *  paths, so without this every runner produces its own fingerprints for the same file and
     *  deduplication silently does nothing. See `toRepoRelativePath`. */
    rootPath: z.string().max(500).optional()
  })
]);

type EslintResult = z.infer<typeof eslintResultSchema>;

function mapEslintResultsToFindingInputs(
  results: EslintResult[],
  defaults: { tool: string; repository?: string; branch?: string; prUrl?: string; ticketKey?: string; rootPath?: string }
): FindingInput[] {
  const out: FindingInput[] = [];
  for (const result of results) {
    const filePath = toRepoRelativePath(result.filePath, defaults.rootPath);
    for (const message of result.messages ?? []) {
      out.push({
        type: "LINT",
        tool: defaults.tool,
        severity: ESLINT_SEVERITY_TO_SEVERITY[message.severity ?? 1] ?? "LOW",
        title: (message.message ?? message.ruleId ?? "Lint finding").slice(0, 255),
        description: message.message?.slice(0, 20000),
        // The RULE is the identity, never the message: ESLint messages interpolate the offending
        // identifier ("'userId' is assigned a value but never used"), so hashing the message would
        // make a renamed variable look like a brand-new problem every time. Same argument the SARIF
        // mapper makes about `ruleId` versus `title`.
        ruleId: message.ruleId?.slice(0, 200) ?? undefined,
        filePath: filePath ? filePath.slice(0, 500) : undefined,
        lineNumber: typeof message.line === "number" && message.line > 0 ? message.line : undefined,
        repository: defaults.repository,
        branch: defaults.branch,
        prUrl: defaults.prUrl,
        ticketKey: defaults.ticketKey
      });
    }
  }
  return out;
}

devopsWebhookRouter.post("/:orgSlug/findings/eslint", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidIngestionToken(req);
      const parsed = eslintRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(422, `Invalid ESLint payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

      // A bare array is ESLint's own output; the object form is the same output wrapped so the
      // caller can attach context. Narrowed once, here, so nothing below has to ask again.
      const payload = parsed.data;
      const wrapped = Array.isArray(payload) ? null : payload;
      const results: EslintResult[] = Array.isArray(payload) ? payload : payload.results;
      const queryValue = (name: string) => req.query[name] as string | undefined;

      const tool = (wrapped?.tool ?? queryValue("tool") ?? "eslint").slice(0, 80);
      const repository = wrapped?.repository ?? queryValue("repository");
      const branch = wrapped?.branch ?? queryValue("branch");
      const commitSha = wrapped?.commitSha ?? queryValue("commitSha");

      const inputs = mapEslintResultsToFindingInputs(results, {
        tool,
        repository,
        branch,
        prUrl: wrapped?.prUrl ?? queryValue("prUrl"),
        ticketKey: wrapped?.ticketKey ?? queryValue("ticketKey"),
        rootPath: wrapped?.rootPath ?? queryValue("rootPath")
      });

      if (inputs.length === 0) {
        // A clean lint run — every file reported, no messages in any of them. Recorded and judged
        // for the same reason an empty SARIF log is: it is the evidence that the lint backlog on
        // this repo and branch is gone.
        const emptyRun = await prisma.scanRun.create({
          data: { tool, type: "LINT", repository, branch, commitSha, findingCount: 0 }
        });
        await verifyFindingsAgainstScanRun(emptyRun.id, []).catch((error) =>
          console.warn(`[devops-webhook] verification verdict failed for empty lint run ${emptyRun.id}: ${(error as Error).message}`)
        );
        return res.status(201).json({ ingested: 0, created: 0, updated: 0, note: "ESLint output parsed but contained zero messages." });
      }
      if (inputs.length > 500) throw new AppError(422, "ESLint output contains more than 500 messages — split into multiple requests.");

      const outcome = await ingestFindingsBatch(inputs, { commitSha });
      res.status(201).json(outcome);
    });
  } catch (error) {
    next(error);
  }
});

// --- SonarQube quality gate -------------------------------------------------------------------

/**
 * Sonar's webhook payload, accepted VERBATIM — a customer pastes this route's URL into Sonar's
 * Administration → Configuration → Webhooks and adds the bearer token as an HTTP header, and that
 * is the whole integration. No translation step, because a translation step is a thing that rots.
 *
 * EVERYTHING EXCEPT `project.key` IS OPTIONAL, and that is deliberate rather than lazy. Sonar has
 * shipped payloads without each of the others across its versions and configurations: an analysis
 * that FAILED carries no `qualityGate` at all, a non-branch (main-only) setup carries no `branch`,
 * older servers carry no `revision`. A receiver that 422s a real webhook because one field moved is
 * a receiver that gets switched off, and the operator's evidence is a red arrow in Sonar's admin UI
 * with no body to read. So: store what arrived, and let the resolve gate decide what it can use.
 */
const qualityGateSchema = z.object({
  body: z.object({
    serverUrl: z.string().max(500).optional(),
    taskId: z.string().max(120).optional(),
    /** Did the ANALYSIS run — not whether the gate passed. */
    status: z.string().max(20).optional(),
    analysedAt: z.string().max(64).optional(),
    revision: z.string().max(64).optional(),
    project: z.object({ key: z.string().min(1).max(255), name: z.string().max(255).optional(), url: z.string().max(500).optional() }),
    branch: z
      .object({ name: z.string().max(255).optional(), type: z.string().max(40).optional(), isMain: z.boolean().optional(), url: z.string().max(500).optional() })
      .optional(),
    qualityGate: z
      .object({
        name: z.string().max(255).optional(),
        status: z.string().max(20).optional(),
        conditions: z
          .array(
            z.object({
              metric: z.string().max(120).optional(),
              operator: z.string().max(40).optional(),
              value: z.string().max(120).optional(),
              status: z.string().max(20).optional(),
              errorThreshold: z.string().max(120).optional()
            })
          )
          .optional()
      })
      .optional(),
    // Sonar always sends it, nothing here reads it, and rejecting it would be absurd.
    properties: z.record(z.string(), z.unknown()).optional()
  })
});

/** Sonar's gate verdict onto the stored enum. An unrecognised or absent status is WARN rather than
 *  ERROR: the resolve gate blocks on ERROR, and blocking somebody's ticket because Sonar sent a word
 *  we did not expect would be a hard failure caused by a vocabulary change. */
function qualityGateStatusOf(raw: string | undefined): "OK" | "WARN" | "ERROR" {
  const value = String(raw ?? "").toUpperCase();
  if (value === "OK") return "OK";
  if (value === "ERROR") return "ERROR";
  return "WARN";
}

devopsWebhookRouter.post("/:orgSlug/quality-gate", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidIngestionToken(req);
      const parsed = qualityGateSchema.safeParse({ body: req.body });
      if (!parsed.success) throw new AppError(422, `Invalid quality-gate payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      const body = parsed.data.body;

      // Sonar's own clock when it sent one, ours when it did not or when it sent something
      // unparseable. A run with a nonsense timestamp would sort wrongly against its neighbours, and
      // "most recent gate on this branch" is the only question anything asks of this table.
      const analysedAtRaw = body.analysedAt ? new Date(body.analysedAt) : null;
      const analysedAt = analysedAtRaw && !Number.isNaN(analysedAtRaw.getTime()) ? analysedAtRaw : new Date();

      const run = await prisma.qualityGateRun.create({
        data: {
          provider: "sonarqube",
          serverUrl: body.serverUrl,
          taskId: body.taskId,
          projectKey: body.project.key,
          projectName: body.project.name,
          branch: body.branch?.name,
          commitSha: body.revision,
          analysisStatus: (body.status ?? "SUCCESS").toUpperCase().slice(0, 20),
          analysedAt,
          gateName: body.qualityGate?.name,
          status: qualityGateStatusOf(body.qualityGate?.status),
          // Stored whole. `?? []` rather than null for an analysis that reported no conditions, so a
          // reader never has to distinguish "no conditions" from "we did not store them".
          conditions: body.qualityGate?.conditions ?? []
        }
      });

      res.status(201).json({
        id: run.id,
        projectKey: run.projectKey,
        branch: run.branch,
        status: run.status,
        analysisStatus: run.analysisStatus,
        analysedAt: run.analysedAt
      });
    });
  } catch (error) {
    next(error);
  }
});

const testRunSchema = z.object({
  body: z.object({
    provider: z.string().min(1).max(80),
    branch: z.string().max(255).optional(),
    prUrl: z.string().max(500).optional(),
    status: z.enum(testRunStatuses),
    passCount: z.coerce.number().int().nonnegative().optional(),
    failCount: z.coerce.number().int().nonnegative().optional(),
    durationMs: z.coerce.number().int().nonnegative().optional(),
    logUrl: z.string().max(500).optional(),
    ticketKey: z.string().max(20).optional(),
    // Optional raw failure-log excerpt (not fetched from logUrl by this app — see this route's
    // handler comment on why fetching an arbitrary CI-supplied URL server-side is deliberately
    // avoided). Only used when status is FAILED and GlobalAISettings.ciFailureTriageEnabled.
    failureText: z.string().max(20000).optional()
  })
});

devopsWebhookRouter.post("/:orgSlug/test-runs", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidIngestionToken(req);
      const parsed = testRunSchema.safeParse({ body: req.body });
      if (!parsed.success) throw new AppError(422, `Invalid test-run payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      const body = parsed.data.body;

      const ticketId = await resolveTicketId(body.ticketKey);
      const created = await prisma.testRun.create({
        data: {
          ticketId,
          provider: body.provider,
          branch: body.branch,
          prUrl: body.prUrl,
          status: body.status,
          passCount: body.passCount,
          failCount: body.failCount,
          durationMs: body.durationMs,
          logUrl: body.logUrl
        }
      });

      if (body.status === "FAILED" && ticketId) {
        await maybeReopenTicketOnRegression(ticketId, `A failed ${body.provider} test run`).catch((error) =>
          console.warn(`[devops-webhook] auto-reopen check failed for ticket ${ticketId}: ${(error as Error).message}`)
        );
        if (body.failureText) {
          await maybePostCiFailureTriageComment(ticketId, body.failureText, body.provider, body.ticketKey).catch((error) =>
            console.warn(`[devops-webhook] AI CI-failure triage failed for ticket ${ticketId}: ${(error as Error).message}`)
          );
        }
      } else if (body.status === "FAILED" && !ticketId) {
        // No ticket reference at all — the gap the branch above doesn't cover (that one only
        // acts on an EXISTING ticket). Opt-in, see maybeAutoCreateTicketForCiFailure's own header
        // for the flaky-test dedup guard.
        await maybeAutoCreateTicketForCiFailure({
          provider: body.provider,
          branch: body.branch ?? null,
          prUrl: body.prUrl ?? null,
          logUrl: body.logUrl ?? null,
          failureText: body.failureText
        }).catch((error) => console.warn(`[devops-webhook] auto-create-ticket-for-CI-failure check failed: ${(error as Error).message}`));
      }

      res.status(201).json(created);
    });
  } catch (error) {
    next(error);
  }
});


// --- SBOM ingestion (SPDX / CycloneDX) --------------------------------------------------------
// Basic "dependency inventory + known-CVE cross-reference" — deliberately not attempting Black
// Duck's full license-obligation-text depth (see docs/ROADMAP.md's "Competitive parity" Phase 3).

interface SbomComponentInput {
  name: string;
  version: string;
  ecosystem: string | null;
  license: string | null;
  knownCve: string | null;
}

/** `pkg:npm/lodash@4.17.21` -> "npm". Purl's type segment is a reliable ecosystem signal both
 *  SPDX (via externalRefs) and CycloneDX (via each component's own `purl`) commonly carry. */
function ecosystemFromPurl(purl: string | undefined): string | null {
  const match = purl?.match(/^pkg:([a-zA-Z0-9.+-]+)\//);
  return match ? match[1] : null;
}

function parseCycloneDx(doc: Record<string, unknown>): SbomComponentInput[] {
  const components = (doc.components ?? []) as Array<Record<string, unknown>>;
  const vulnerabilities = (doc.vulnerabilities ?? []) as Array<Record<string, unknown>>;

  // Best-effort CVE cross-reference: CycloneDX's `vulnerabilities[].affects[].ref` points at a
  // component's `bom-ref`; map ref -> first vulnerability id found for it.
  const cveByRef = new Map<string, string>();
  for (const vuln of vulnerabilities) {
    const id = vuln.id as string | undefined;
    const affects = (vuln.affects ?? []) as Array<Record<string, unknown>>;
    for (const affected of affects) {
      const ref = affected.ref as string | undefined;
      if (ref && id && !cveByRef.has(ref)) cveByRef.set(ref, id);
    }
  }

  return components
    .filter((c) => typeof c.name === "string" && typeof c.version === "string")
    .map((c) => {
      const purl = c.purl as string | undefined;
      const licenses = (c.licenses ?? []) as Array<Record<string, unknown>>;
      const licenseEntry = licenses[0]?.license as Record<string, unknown> | undefined;
      const license = (licenseEntry?.id as string | undefined) ?? (licenseEntry?.name as string | undefined) ?? null;
      const bomRef = c["bom-ref"] as string | undefined;
      return {
        name: String(c.name).slice(0, 255),
        version: String(c.version).slice(0, 80),
        ecosystem: ecosystemFromPurl(purl),
        license: license?.slice(0, 120) ?? null,
        knownCve: (bomRef && cveByRef.get(bomRef)) ?? null
      };
    });
}

function parseSpdx(doc: Record<string, unknown>): SbomComponentInput[] {
  const packages = (doc.packages ?? []) as Array<Record<string, unknown>>;
  return packages
    .filter((p) => typeof p.name === "string")
    .map((p) => {
      const externalRefs = (p.externalRefs ?? []) as Array<Record<string, unknown>>;
      const purlRef = externalRefs.find((r) => r.referenceType === "purl")?.referenceLocator as string | undefined;
      const license = p.licenseConcluded as string | undefined;
      return {
        name: String(p.name).slice(0, 255),
        version: String(p.versionInfo ?? "unknown").slice(0, 80),
        ecosystem: ecosystemFromPurl(purlRef),
        license: license && license !== "NOASSERTION" ? license.slice(0, 120) : null,
        knownCve: null
      };
    });
}

const sbomRequestSchema = z.object({
  body: z.object({
    sbom: z.record(z.string(), z.unknown()).optional(),
    // Fields present at top level when the body IS the raw SBOM doc rather than a wrapper.
    spdxVersion: z.string().optional(),
    bomFormat: z.string().optional(),
    packages: z.array(z.record(z.string(), z.unknown())).optional(),
    components: z.array(z.record(z.string(), z.unknown())).optional(),
    repository: z.string().max(255).optional()
  })
});

devopsWebhookRouter.post("/:orgSlug/sbom", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidIngestionToken(req);
      const parsed = sbomRequestSchema.safeParse({ body: req.body });
      if (!parsed.success) throw new AppError(422, `Invalid SBOM payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      const body = parsed.data.body;

      const doc = body.sbom ?? (body.packages || body.components ? (req.body as Record<string, unknown>) : undefined);
      if (!doc) throw new AppError(422, "No SBOM document found — send either a raw SPDX/CycloneDX log as the body, or { sbom: {...}, ... }.");

      const isSpdx = typeof doc.spdxVersion === "string" || Array.isArray(doc.packages);
      const isCycloneDx = doc.bomFormat === "CycloneDX" || Array.isArray(doc.components);
      if (!isSpdx && !isCycloneDx) throw new AppError(422, "Could not detect SBOM format — expected SPDX (spdxVersion/packages) or CycloneDX (bomFormat/components).");

      const parsedComponents = isSpdx ? parseSpdx(doc) : parseCycloneDx(doc);
      if (parsedComponents.length === 0) return res.status(201).json({ created: 0, note: "SBOM parsed but contained zero components." });
      if (parsedComponents.length > 2000) throw new AppError(422, "SBOM contains more than 2000 components — split into multiple requests.");

      const format = isSpdx ? "SPDX" : "CycloneDX";
      const repository = body.repository;
      await prisma.sbomComponent.createMany({
        data: parsedComponents.map((c) => ({ ...c, format, repository }))
      });

      res.status(201).json({ created: parsedComponents.length, format });
    });
  } catch (error) {
    next(error);
  }
});

// --- Error-tracking ingestion (Sentry / Rollbar / raw) + fingerprint-based auto-reopen --------
// The last piece of the "AI auto bug/issue detection + auto-reopen" roadmap item: an error event
// with no explicit ticketKey can still auto-reopen a RESOLVED/CLOSED ticket if its `fingerprint`
// matches the fingerprint stored on that ticket from an earlier event — "the same crash came
// back" is detectable without a human re-linking it by hand.

const errorEventSchema = z.object({
  body: z.object({
    source: z.enum(["SENTRY", "ROLLBAR", "RAW"]).default("RAW"),
    // Sentry/Rollbar both supply a stable grouping key (Sentry: issue fingerprint/culprit hash;
    // Rollbar: item "fingerprint") — for a raw/manual CI-log post with no such key, the caller
    // can hash whatever it considers the identity of "this same failure" itself and send that.
    fingerprint: z.string().min(1).max(128),
    message: z.string().min(1).max(500),
    stackTrace: z.string().max(20000).optional(),
    level: z.string().max(20).optional(),
    ticketKey: z.string().max(20).optional()
  })
});

devopsWebhookRouter.post("/:orgSlug/error-events", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidIngestionToken(req);
      const parsed = errorEventSchema.safeParse({ body: req.body });
      if (!parsed.success) throw new AppError(422, `Invalid error-event payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      const body = parsed.data.body;

      let ticketId = await resolveTicketId(body.ticketKey);
      let matchedBy: "ticketKey" | "fingerprint" | null = ticketId ? "ticketKey" : null;

      if (!ticketId) {
        // No explicit key — fall back to fingerprint match against whatever ticket this exact
        // crash signature was last linked to, most-recently-updated first (a fingerprint can in
        // principle get reused if reset by a data import, so "most recent" is the sane tie-break).
        const matched = await prisma.ticket.findFirst({
          where: { errorFingerprint: body.fingerprint, deletedAt: null },
          orderBy: { updatedAt: "desc" },
          select: { id: true }
        });
        if (matched) {
          ticketId = matched.id;
          matchedBy = "fingerprint";
        }
      }

      let reopened = false;
      if (ticketId) {
        // Remember this fingerprint on the ticket (first-write-wins — a ticket keeps the
        // fingerprint of whichever crash it was first linked to) so a LATER event with no
        // ticketKey can still find its way back here via the fingerprint branch above.
        await prisma.ticket.updateMany({ where: { id: ticketId, errorFingerprint: null }, data: { errorFingerprint: body.fingerprint } });

        const ticketBefore = await prisma.ticket.findFirst({ where: { id: ticketId, deletedAt: null }, select: { status: true } });
        if (ticketBefore && (ticketBefore.status === "RESOLVED" || ticketBefore.status === "CLOSED")) {
          await maybeReopenTicketOnRegression(
            ticketId,
            `A new ${body.source === "RAW" ? "" : `${body.source} `}error event matching this ticket's known crash fingerprint`
          ).catch((error) => console.warn(`[devops-webhook] auto-reopen check failed for ticket ${ticketId}: ${(error as Error).message}`));
          reopened = true;
        }

        if (body.stackTrace) {
          await maybePostCiFailureTriageComment(ticketId, `${body.message}\n\n${body.stackTrace}`, body.source, body.ticketKey).catch((error) =>
            console.warn(`[devops-webhook] AI error-event triage failed for ticket ${ticketId}: ${(error as Error).message}`)
          );
        }
      }

      res.status(201).json({ matched: Boolean(ticketId), matchedBy, ticketId, reopened });
    });
  } catch (error) {
    next(error);
  }
});
