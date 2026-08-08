/**
 * The ONE unauthenticated read surface in this application: a client opening a Verified Work
 * Attestation share link without a TimeSphere account. This is what turns the artifact from "we
 * emailed you a PDF" into "you can verify it yourself" — but it is also, by construction, the
 * most exposed endpoint here, so the rules below are deliberate rather than incidental.
 *
 * SECURITY POSTURE:
 * - The URL carries a 256-bit random token; only its SHA-256 is stored (same as ApiKey). A
 *   database leak yields no usable links.
 * - Attestation ids never appear in the URL, so nothing is enumerable by walking ids.
 * - Expired, revoked, and voided all return an identical generic **404**. Distinguishing them
 *   would let a probe learn that a given token was once real.
 * - `SUMMARY` scope (the default) exposes totals and per-ticket hours only — never emails, user
 *   ids, per-person rates, or any biometric detail. The payload it reads was already stripped of
 *   biometric internals when it was built (attestation.service.ts).
 * - `noindex` + `no-store` so a shared link can't end up in a search index or a shared cache.
 * - Every view is counted and audited with a null actor (AuditLog.actorId is nullable), so an
 *   admin can see that a link is being used and how often.
 *
 * MOUNTED AFTER `resolveTenant`, unlike the CI/chat webhook receivers: a share URL is handed out
 * on the org's own host, so the tenant resolves from the request the same way every other
 * in-app route does. That keeps a token scoped to the tenant it was minted in — a token cannot be
 * replayed against a different org's database.
 */
import crypto from "node:crypto";
import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { audit } from "../services/audit.service.js";
import { getGlobalTicketSettings } from "../services/ticket.service.js";
import type { AttestationPayload } from "../services/attestation.service.js";

export const attestationPublicRouter = Router();

/**
 * Reduces the frozen payload to what a given scope is allowed to expose.
 *
 * SUMMARY deliberately drops the per-entry rows (which name individuals, their hours, and their
 * rates) and keeps only per-ticket rollups. A client needs to know the work happened and was
 * verified; they don't need a per-person breakdown of the vendor's staff, and publishing one to
 * an unauthenticated URL would be a privacy problem the org can't take back.
 */
function projectForScope(payload: AttestationPayload, scope: string) {
  const base = {
    attestation: payload.attestation,
    summary: {
      totalHours: payload.summary.totalHours,
      billableHours: payload.summary.billableHours,
      unratedHours: payload.summary.unratedHours,
      totalAmount: payload.summary.totalAmount,
      entryCount: payload.summary.entryCount,
      contributorCount: payload.summary.contributorCount,
      identityVerifiedEntries: payload.summary.identityVerifiedEntries,
      approvedEntries: payload.summary.approvedEntries
    },
    caveats: payload.caveats
  };

  if (scope === "FULL") {
    return { ...base, scope, workItems: payload.workItems, approvals: payload.approvals };
  }

  return {
    ...base,
    scope: "SUMMARY",
    // Per-ticket rollups only — no `entries`, so no individual is named alongside their hours.
    workItems: payload.workItems.map((item) => ({
      ticketKey: item.ticketKey,
      ticketTitle: item.ticketTitle,
      hours: item.hours,
      amount: item.amount
    })),
    // Approver names are meaningful to a client ("who signed this off") and are already on the
    // PDF they were sent; entry counts and identity flags come along, nothing else.
    approvals: payload.approvals
  };
}

attestationPublicRouter.get("/:token", async (req, res) => {
  // Uniform 404 for every failure mode below — see this file's header.
  const notFound = () => new AppError(404, "This link is not valid.");

  const token = String(req.params.token ?? "");
  if (token.length < 20 || token.length > 200) throw notFound();

  const settings = await getGlobalTicketSettings();
  if (!settings.enableAttestations || !settings.enableAttestationSharing) throw notFound();

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const link = await prisma.attestationShareLink.findUnique({
    where: { tokenHash },
    include: { attestation: true }
  });

  if (!link) throw notFound();
  if (link.revokedAt) throw notFound();
  if (link.expiresAt.getTime() < Date.now()) throw notFound();
  if (!link.attestation || link.attestation.status === "VOID") throw notFound();

  // Best-effort telemetry — a counter failing must never stop a legitimate client reading the
  // document they were sent.
  await prisma.attestationShareLink
    .update({ where: { id: link.id }, data: { viewCount: { increment: 1 }, lastViewedAt: new Date() } })
    .catch(() => undefined);
  await audit(undefined, "attestation.share_viewed", "WorkAttestation", link.attestationId, {
    reference: link.attestation.reference,
    scope: link.scope
  }, {
    // Someone holding a valid share link and no session. `ipAddress` matters more here than almost
    // anywhere else in the app: this is an outsider reading somebody's verified work record, and
    // "who looked at it" is the whole question the share log exists to answer.
    actorType: "GUEST",
    actorLabel: "attestation-share-link",
    ipAddress: req.ip
  }).catch(() => undefined);

  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ...projectForScope(link.attestation.payload as unknown as AttestationPayload, link.scope),
    // Lets a recipient confirm the document they're reading matches the one they were sent.
    payloadHash: link.attestation.payloadHash,
    status: link.attestation.status
  });
});
