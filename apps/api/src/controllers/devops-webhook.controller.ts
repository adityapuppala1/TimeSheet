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
 * Workspace Settings), compared with `crypto.timingSafeEqual`. A 404 (not 401) when no token has
 * ever been generated — same "ingestion was never enabled" signal
 * chat-webhook.controller.ts gives for an unconfigured platform.
 */
import crypto from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { securityFindingSeverities, testRunStatuses } from "@timesheet/shared";
import { getTenantClient, prisma } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { resolveActiveOrgBySlug } from "../middleware/tenant.js";
import { AppError } from "../middleware/error.js";
import {
  maybeAutoCreateTicketForFinding,
  maybePostCiFailureTriageComment,
  maybeReopenTicketOnRegression
} from "../services/security-report.service.js";
import { decryptSecret } from "../utils/encryption.js";

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
  const expectedToken = decryptSecret(settings.encryptedToken);
  const authBuf = Buffer.from(bearerToken, "utf8");
  const expectedBuf = Buffer.from(expectedToken, "utf8");
  if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
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

devopsWebhookRouter.post("/:orgSlug/findings", async (req, res, next) => {
  try {
    await withOrgTenant(req.params.orgSlug, async () => {
      await requireValidIngestionToken(req);
      const parsed = findingsBatchSchema.safeParse({ body: req.body });
      if (!parsed.success) throw new AppError(422, `Invalid findings payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

      const created = await Promise.all(
        parsed.data.body.findings.map(async (f) => {
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
          // Only for findings that arrived with no ticket to attach to — see
          // security-report.service.ts#maybeAutoCreateTicketForFinding for the severity/
          // fallback-project gating. Never throws: a misconfigured fallback project shouldn't
          // fail the whole ingestion batch, it should just leave that finding ticket-less.
          if (!ticketId) {
            await maybeAutoCreateTicketForFinding(finding).catch((error) =>
              console.warn(`[devops-webhook] auto-ticket-creation failed for finding ${finding.id}: ${(error as Error).message}`)
            );
          }
          return finding;
        })
      );
      res.status(201).json({ created: created.length });
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
        await maybeReopenTicketOnRegression(ticketId, body.provider).catch((error) =>
          console.warn(`[devops-webhook] auto-reopen check failed for ticket ${ticketId}: ${(error as Error).message}`)
        );
        if (body.failureText) {
          await maybePostCiFailureTriageComment(ticketId, body.failureText, body.provider, body.ticketKey).catch((error) =>
            console.warn(`[devops-webhook] AI CI-failure triage failed for ticket ${ticketId}: ${(error as Error).message}`)
          );
        }
      }

      res.status(201).json(created);
    });
  } catch (error) {
    next(error);
  }
});

