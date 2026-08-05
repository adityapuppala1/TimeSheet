/**
 * Verified Work Attestation endpoints — see services/attestation.service.ts for what the artifact
 * is and why it's the product's sharpest differentiator.
 *
 * ACCESS MODEL: `REPORTS_VIEW` plus per-project scoping (`assertTicketVisible`), NOT the coarse
 * `requireAdmin` the identity evidence pack uses. An attestation is scoped to one project, so a
 * manager who can see that project's reports should be able to issue one for it — while someone
 * with no visibility into that project must not be able to enumerate its work by guessing ids.
 * Voiding is deliberately stricter (SUPER_ADMIN): invalidating an artifact a client may already
 * be holding is a different class of action from producing one.
 *
 * EVERY route is additionally gated on `GlobalTicketSettings.enableAttestations`, which ships off
 * — same posture as every other capability in this app.
 */
import crypto from "node:crypto";
import { Router } from "express";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { buildWorkAttestation, hashPayload, type AttestationPayload } from "../services/attestation.service.js";
import { renderAttestationPdf } from "../services/attestation-pdf.service.js";
import { assertTicketVisible } from "../services/ticket.service.js";
import { getGlobalTicketSettings } from "../services/ticket.service.js";

export const attestationRouter = Router();
attestationRouter.use(requireAuth);

async function assertAttestationsEnabled(): Promise<void> {
  const settings = await getGlobalTicketSettings();
  if (!settings.enableAttestations) {
    throw new AppError(403, "Work attestations are disabled for this workspace — enable them in Workspace Settings → Ticketing.");
  }
}

/** Dates arrive as YYYY-MM-DD and are pinned to UTC midnight so a period never shifts by a day
 *  depending on the server's timezone (the same class of bug the dashboard timeline already had). */
function parseUtcDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const periodSchema = z.object({
  body: z.object({
    projectId: z.string().uuid(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD"),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodEnd must be YYYY-MM-DD")
  })
});

async function buildFromRequest(req: any) {
  const periodStart = parseUtcDate(req.body.periodStart);
  const periodEnd = parseUtcDate(req.body.periodEnd);
  if (periodEnd < periodStart) throw new AppError(422, "periodEnd cannot be before periodStart.");

  await assertTicketVisible(req, req.body.projectId);
  return buildWorkAttestation({
    projectId: req.body.projectId,
    periodStart,
    periodEnd,
    generatedByName: req.user?.name ?? req.user?.email ?? null
  });
}

/**
 * Build and return WITHOUT persisting — so an admin can check what a period actually contains
 * before committing an immutable, client-facing record. Without this every experiment would leave
 * a permanent attestation row behind.
 */
attestationRouter.post("/preview", requirePermission(permissions.REPORTS_VIEW), validate(periodSchema), async (req, res) => {
  await assertAttestationsEnabled();
  const built = await buildFromRequest(req);
  res.json({ payload: built.payload });
});

/** Issue (persist) an attestation. Immutable once written — see the model's doc comment. */
attestationRouter.post("/", requirePermission(permissions.REPORTS_VIEW), validate(periodSchema), async (req, res) => {
  await assertAttestationsEnabled();
  const built = await buildFromRequest(req);

  const created = await prisma.workAttestation.create({
    data: {
      reference: built.payload.attestation.reference,
      projectId: req.body.projectId,
      periodStart: parseUtcDate(req.body.periodStart),
      periodEnd: parseUtcDate(req.body.periodEnd),
      currency: built.totals.currency,
      totalHours: built.totals.totalHours,
      billableHours: built.totals.billableHours,
      unratedHours: built.totals.unratedHours,
      totalAmount: built.totals.totalAmount,
      entryCount: built.totals.entryCount,
      payload: built.payload as unknown as object,
      payloadHash: hashPayload(built.payload),
      generatedById: req.user!.id
    }
  });

  await audit(req.user!.id, "attestation.issued", "WorkAttestation", created.id, {
    reference: created.reference,
    projectId: req.body.projectId,
    periodStart: req.body.periodStart,
    periodEnd: req.body.periodEnd,
    entryCount: created.entryCount
  });

  res.status(201).json(serializeRow(created));
});

/** Project-scoped list. `projectId` is required precisely so this can't be used to enumerate
 *  attestations across projects the caller can't see. */
attestationRouter.get("/", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  await assertAttestationsEnabled();
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
  if (!projectId) throw new AppError(422, "Query param 'projectId' is required.");
  await assertTicketVisible(req, projectId);

  const rows = await prisma.workAttestation.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { generatedBy: { select: { id: true, name: true } } }
  });
  res.json(rows.map(serializeRow));
});

async function loadScoped(req: any) {
  const row = await prisma.workAttestation.findUnique({
    where: { id: String(req.params.id) },
    include: { project: { select: { id: true, code: true, name: true } }, generatedBy: { select: { id: true, name: true } } }
  });
  if (!row) throw new AppError(404, "Attestation not found");
  await assertTicketVisible(req, row.projectId);
  return row;
}

/**
 * PDF variant. Registered BEFORE the bare `/:id` route on purpose — Express matches in
 * registration order, so with `/:id` first a request for `<uuid>.pdf` binds `id` to the literal
 * string "<uuid>.pdf" and 404s. (The ticket security report doesn't hit this because its `.pdf`
 * lives on its own path segment.)
 */
attestationRouter.get("/:id.pdf", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  await assertAttestationsEnabled();
  const id = String((req.params as Record<string, string>)["id.pdf"] ?? req.params.id ?? "").replace(/\.pdf$/, "");
  const row = await prisma.workAttestation.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Attestation not found");
  await assertTicketVisible(req, row.projectId);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="attestation-${row.reference}.pdf"`);

  // `bufferPages: true` is required for the per-page footer: the renderer only knows the total
  // page count after all content is laid out, so it walks back over the buffered pages at the end.
  const doc = new PDFDocument({ size: "A4", margin: 36, bufferPages: true });
  doc.pipe(res);
  renderAttestationPdf(doc, row.payload as unknown as AttestationPayload, row.status, row.payloadHash);
  doc.end();
});

/** The frozen payload, as a download. Renders from `payload`, never a fresh rebuild — that's the
 *  whole point of persisting it. */
attestationRouter.get("/:id", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  await assertAttestationsEnabled();
  const row = await loadScoped(req);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="attestation-${row.reference}.json"`);
  res.json({
    ...serializeRow(row),
    payload: row.payload,
    // Lets a recipient re-verify the stored payload hasn't been altered since issue.
    payloadHash: row.payloadHash
  });
});

const voidSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().min(3).max(500) })
});

/**
 * Void — never delete. A client may already be holding a copy, so the record of it having existed
 * (and why it was withdrawn) is itself part of the audit trail. Correcting an attestation means
 * voiding this one and issuing a new one.
 */
attestationRouter.post("/:id/void", requireSuperAdmin, validate(voidSchema), async (req, res) => {
  await assertAttestationsEnabled();
  const row = await prisma.workAttestation.findUnique({ where: { id: String(req.params.id) } });
  if (!row) throw new AppError(404, "Attestation not found");
  if (row.status === "VOID") throw new AppError(422, "This attestation is already void.");

  const updated = await prisma.workAttestation.update({
    where: { id: row.id },
    data: { status: "VOID", voidedAt: new Date(), voidReason: req.body.reason }
  });
  await audit(req.user!.id, "attestation.voided", "WorkAttestation", row.id, { reference: row.reference, reason: req.body.reason });
  res.json(serializeRow(updated));
});

/* ---------- Public share links (off by default, super-admin only) ---------- */
// A client verifying an attestation WITHOUT a TimeSphere account is the difference between "we
// emailed you a PDF" and "independently verifiable" — but it means a public, unauthenticated
// endpoint, so it sits behind its own toggle (`enableAttestationSharing`, separate from
// `enableAttestations`) and its own stricter role gate. Token handling copies ApiKey exactly:
// 256-bit random, sha256 stored, plaintext shown once.

async function assertSharingEnabled(): Promise<void> {
  const settings = await getGlobalTicketSettings();
  if (!settings.enableAttestationSharing) {
    throw new AppError(403, "Public share links are disabled for this workspace — enable them in Workspace Settings → Ticketing.");
  }
}

const MAX_SHARE_DAYS = 90;
const DEFAULT_SHARE_DAYS = 30;

const shareSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    /** SUMMARY omits per-entry rows and every per-person figure. Default, and the narrower one. */
    scope: z.enum(["SUMMARY", "FULL"]).optional(),
    expiresInDays: z.coerce.number().int().min(1).max(MAX_SHARE_DAYS).optional()
  })
});

attestationRouter.post("/:id/share", requireSuperAdmin, validate(shareSchema), async (req, res) => {
  await assertAttestationsEnabled();
  await assertSharingEnabled();

  const row = await prisma.workAttestation.findUnique({ where: { id: String(req.params.id) } });
  if (!row) throw new AppError(404, "Attestation not found");
  // Sharing something already withdrawn would publish a document the org has disowned.
  if (row.status === "VOID") throw new AppError(422, "This attestation is void and cannot be shared.");

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (req.body.expiresInDays ?? DEFAULT_SHARE_DAYS) * 24 * 60 * 60 * 1000);

  const link = await prisma.attestationShareLink.create({
    data: {
      attestationId: row.id,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      tokenPrefix: token.slice(0, 12),
      scope: req.body.scope ?? "SUMMARY",
      expiresAt,
      createdById: req.user!.id
    }
  });
  await audit(req.user!.id, "attestation.share_link_created", "AttestationShareLink", link.id, {
    reference: row.reference,
    scope: link.scope,
    expiresAt
  });

  // Plaintext token returned exactly once — same write-once convention as API keys and the
  // ingestion token. It is not recoverable afterwards; losing it means minting a new link.
  res.status(201).json({ id: link.id, token, scope: link.scope, expiresAt: link.expiresAt, tokenPrefix: link.tokenPrefix });
});

attestationRouter.get("/:id/shares", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  await assertAttestationsEnabled();
  const row = await loadScoped(req);
  const links = await prisma.attestationShareLink.findMany({
    where: { attestationId: row.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, tokenPrefix: true, scope: true, expiresAt: true, revokedAt: true, viewCount: true, lastViewedAt: true, createdAt: true }
  });
  res.json(links);
});

attestationRouter.delete("/:id/share/:linkId", requireSuperAdmin, async (req, res) => {
  await assertAttestationsEnabled();
  const link = await prisma.attestationShareLink.findFirst({
    where: { id: String(req.params.linkId), attestationId: String(req.params.id) }
  });
  if (!link) throw new AppError(404, "Share link not found");

  // Revoke, never delete — the fact a link existed and was withdrawn is part of the audit trail.
  await prisma.attestationShareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
  await audit(req.user!.id, "attestation.share_link_revoked", "AttestationShareLink", link.id, {});
  res.status(204).send();
});

function serializeRow(row: any) {
  return {
    id: row.id,
    reference: row.reference,
    projectId: row.projectId,
    project: row.project ?? undefined,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    currency: row.currency,
    totalHours: Number(row.totalHours),
    billableHours: Number(row.billableHours),
    unratedHours: Number(row.unratedHours),
    totalAmount: Number(row.totalAmount),
    entryCount: row.entryCount,
    generatedBy: row.generatedBy ?? null,
    createdAt: row.createdAt,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason
  };
}
