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
import { securityFindingSeverities, testRunStatuses } from "@timesheet/shared";
import { getTenantClient, prisma } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { resolveActiveOrgBySlug } from "../middleware/tenant.js";
import { AppError } from "../middleware/error.js";
import { maybeAutoCreateTicketForCiFailure, maybeAutoCreateTicketForFinding, maybePostCiFailureTriageComment, maybeReopenTicketOnRegression, maybeTriageFindingWithAI } from "../services/security-report.service.js";
import { decryptSecret } from "../utils/encryption.js";
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

// Deliberately NOT `z.enum(securityFindingTypes)` — that shared constant includes "VAPT" for
// display purposes (see its own doc comment), but VAPT never arrives through this webhook; it's
// a periodic human-led assessment uploaded via Workspace Settings instead (see
// settings.controller.ts's POST /security-ingestion/vapt-report). Hardcoded here so a CI job
// can never claim type: "VAPT" through the ingest-token auth path.
const CI_INGESTIBLE_FINDING_TYPES = ["SAST", "DAST", "SSAT", "SSCT"] as const;

const findingSchema = z.object({
  type: z.enum(CI_INGESTIBLE_FINDING_TYPES),
  tool: z.string().min(1).max(80),
  severity: z.enum(securityFindingSeverities),
  title: z.string().min(1).max(255),
  description: z.string().max(20000).optional(),
  cwe: z.string().max(40).optional(),
  filePath: z.string().max(500).optional(),
  lineNumber: z.coerce.number().int().positive().optional(),
  repository: z.string().max(255).optional(),
  branch: z.string().max(255).optional(),
  prUrl: z.string().max(500).optional(),
  ticketKey: z.string().max(20).optional()
});

const findingsBatchSchema = z.object({
  body: z.object({ findings: z.array(findingSchema).min(1).max(500) })
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

/** Shared by both /findings (native JSON) and /findings/sarif (translated below) so the two
 *  ingestion paths can never drift on create-then-maybe-auto-create-ticket behavior. */
async function ingestFindingsBatch(findings: FindingInput[]): Promise<number> {
  const created = await Promise.all(
    findings.map(async (f) => {
      const ticketId = await resolveTicketId(f.ticketKey);
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
          prUrl: f.prUrl
        }
      });
      if (!ticketId) {
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
        await maybeReopenTicketOnRegression(ticketId, `A new ${finding.severity} ${finding.type} finding from ${finding.tool}`).catch((error) =>
          console.warn(`[devops-webhook] auto-reopen check failed for ticket ${ticketId}: ${(error as Error).message}`)
        );
      }
      return finding;
    })
  );

  // Opt-in AI exploitability triage (GlobalAISettings.findingTriageEnabled) — CRITICAL/HIGH only,
  // see security-report.service.ts#maybeTriageFindingWithAI. Deliberately AFTER the batch and one
  // at a time rather than inside the Promise.all above; see
  // MAX_AI_TRIAGED_FINDINGS_PER_BATCH for why concurrency here defeated the budget cap. Never
  // throws: a disabled toggle or an exhausted budget should skip triage, not fail ingestion.
  for (const finding of created.slice(0, MAX_AI_TRIAGED_FINDINGS_PER_BATCH)) {
    await maybeTriageFindingWithAI(finding).catch((error) =>
      console.warn(`[devops-webhook] AI triage failed for finding ${finding.id}: ${(error as Error).message}`)
    );
  }

  return created.length;
}

devopsWebhookRouter.post("/:orgSlug/findings", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidIngestionToken(req);
      const parsed = findingsBatchSchema.safeParse({ body: req.body });
      if (!parsed.success) throw new AppError(422, `Invalid findings payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      const count = await ingestFindingsBatch(parsed.data.body.findings);
      res.status(201).json({ created: count });
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
    type: z.enum(CI_INGESTIBLE_FINDING_TYPES).optional(),
    repository: z.string().max(255).optional(),
    branch: z.string().max(255).optional(),
    prUrl: z.string().max(500).optional(),
    ticketKey: z.string().max(20).optional()
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
      if (inputs.length === 0) return res.status(201).json({ created: 0, note: "SARIF log parsed but contained zero results." });
      if (inputs.length > 500) throw new AppError(422, "SARIF log contains more than 500 results — split into multiple requests.");

      const count = await ingestFindingsBatch(inputs);
      res.status(201).json({ created: count });
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
