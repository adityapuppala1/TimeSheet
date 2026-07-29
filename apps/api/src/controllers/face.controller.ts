/**
 * WHAT: face (identity) verification endpoints — enrollment with consent, verification of a
 * live capture, self-service and admin deletion of biometric data, the review log, and
 * authenticated serving of stored face images.
 * WHY: see services/face.service.ts's header for the architectural reasoning (server-side
 * decisions, model loading, calibrated thresholds). This file is the HTTP surface over it.
 *
 * WHY images are served from an API route instead of the static mount: `app.ts` serves
 * `/uploads` and `/uploads/avatars` with NO authentication — anyone who knows a filename can
 * read them, across tenants. That is an acceptable trade for an avatar; it is not acceptable
 * for biometric captures. `GET /face/image/...` below therefore checks the session, the tenant,
 * and whether the caller is the subject or an admin, before streaming a byte.
 *
 * WHO calls this: apps/web's Profile (enrollment), the timesheet/ticket submit dialogs
 * (verification), Workspace Settings → Face verification (review log).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { faceCaptureUpload, preserveTenantContext } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import {
  analyzeFace,
  decodeEmbedding,
  DEFAULT_CONSENT_TEXT,
  encodeEmbedding,
  FACE_MODEL_VERSION,
  faceStorageDir,
  getFaceSettings,
  isFaceVerificationRequired,
  similarity,
  storeFaceImage,
  type FaceContext,
  type FaceOutcome
} from "../services/face.service.js";

export const faceRouter = Router();
faceRouter.use(requireAuth);

const requireAdmin = requireRole(["SUPER_ADMIN", "ADMIN"]);

function requireCapture(req: { file?: Express.Multer.File }): Buffer {
  if (!req.file?.buffer?.length) throw new AppError(422, "No face capture was received.");
  return req.file.buffer;
}

/**
 * GET /face/status — everything the UI needs to decide what to show: whether this user is
 * covered by the policy at all, whether they've enrolled, and the consent text/retention window
 * to display. Safe for any authenticated user; only ever describes the caller.
 */
faceRouter.get("/status", async (req, res) => {
  const settings = await getFaceSettings();
  const enrollment = await prisma.faceEnrollment.findUnique({
    where: { userId: req.user!.id },
    select: { id: true, createdAt: true, consentAt: true, modelVersion: true }
  });

  const [timesheetRequired, ticketRequired] = await Promise.all([
    isFaceVerificationRequired(req.user!.id, "TIMESHEET"),
    isFaceVerificationRequired(req.user!.id, "TICKET")
  ]);

  res.json({
    enabled: settings.enabled,
    requiredForTimesheet: timesheetRequired,
    requiredForTicket: ticketRequired,
    enrolled: Boolean(enrollment),
    // An embedding from an older model can't be compared against a new one, so the UI must
    // prompt for re-enrollment rather than letting every check mysteriously fail.
    needsReEnrollment: Boolean(enrollment && enrollment.modelVersion !== FACE_MODEL_VERSION),
    enrolledAt: enrollment?.createdAt ?? null,
    consentAt: enrollment?.consentAt ?? null,
    consentText: settings.consentText?.trim() || DEFAULT_CONSENT_TEXT,
    imageRetentionDays: settings.imageRetentionDays,
    maxAttempts: settings.maxAttempts
  });
});

const enrollSchema = z.object({ body: z.object({ consent: z.string() }) });

/**
 * POST /face/enroll — records consent and stores the reference template.
 *
 * Consent is a hard precondition, not a checkbox we log for tidiness: storing a face template
 * without informed consent is the specific thing GDPR Art.9 / Illinois BIPA / India's DPDP Act
 * penalise. The exact wording shown at the time is copied onto the row, because an admin can
 * edit the settings text later and the record must reflect what this person actually agreed to.
 */
faceRouter.post("/enroll", preserveTenantContext(faceCaptureUpload.single("capture")), validate(enrollSchema), async (req, res) => {
  const settings = await getFaceSettings();
  if (!settings.enabled) throw new AppError(403, "Face verification is not enabled for this workspace.");
  if (req.body.consent !== "true") {
    throw new AppError(422, "Enrollment requires explicit consent to process your face data.");
  }

  const buffer = requireCapture(req);
  const analysis = await analyzeFace(buffer);
  if (analysis.faceCount === 0) throw new AppError(422, "No face was detected — make sure your face is clearly visible and well lit.");
  if (analysis.faceCount > 1) throw new AppError(422, "More than one face was detected — please make sure you're alone in the frame.");
  if (analysis.antispoofReal < settings.antispoofThreshold || analysis.livenessScore < settings.livenessThreshold) {
    throw new AppError(422, "That didn't look like a live capture. Please look directly at the camera rather than holding up a photo or screen.");
  }

  const consentText = settings.consentText?.trim() || DEFAULT_CONSENT_TEXT;
  const referenceImagePath = settings.imageRetentionDays > 0 ? await storeFaceImage(req.user!.id, "reference", buffer) : null;

  await prisma.faceEnrollment.upsert({
    where: { userId: req.user!.id },
    update: {
      encryptedEmbedding: encodeEmbedding(analysis.embedding),
      modelVersion: FACE_MODEL_VERSION,
      referenceImagePath,
      consentAt: new Date(),
      consentText,
      consentIp: req.ip ?? null,
      enrolledById: req.user!.id
    },
    create: {
      userId: req.user!.id,
      encryptedEmbedding: encodeEmbedding(analysis.embedding),
      modelVersion: FACE_MODEL_VERSION,
      referenceImagePath,
      consentAt: new Date(),
      consentText,
      consentIp: req.ip ?? null,
      enrolledById: req.user!.id
    }
  });

  // Audit records the event and the scores, never the template or the image path.
  await audit(req.user!.id, "face.enrolled", "FaceEnrollment", req.user!.id, {
    modelVersion: FACE_MODEL_VERSION,
    antispoofReal: analysis.antispoofReal,
    livenessScore: analysis.livenessScore,
    imageRetained: Boolean(referenceImagePath)
  });

  res.status(201).json({ enrolled: true, consentAt: new Date().toISOString() });
});

const verifySchema = z.object({ body: z.object({ context: z.enum(["TIMESHEET", "TICKET"]) }) });

/**
 * POST /face/verify — the actual check. Returns a short-lived, single-use `verificationId` that
 * the subsequent timesheet/ticket submit must present (see
 * face.service.ts#consumeVerification).
 *
 * Every outcome is persisted, including failures: "this account failed identity check four
 * times in a row" is precisely the signal this feature exists to surface, so it must survive
 * even when the user simply gives up and closes the dialog.
 */
faceRouter.post("/verify", preserveTenantContext(faceCaptureUpload.single("capture")), validate(verifySchema), async (req, res) => {
  const settings = await getFaceSettings();
  if (!settings.enabled) throw new AppError(403, "Face verification is not enabled for this workspace.");

  const context = req.body.context as FaceContext;
  const userId = req.user!.id;

  const enrollment = await prisma.faceEnrollment.findUnique({ where: { userId } });

  const record = async (
    outcome: FaceOutcome,
    scores: { similarity?: number; antispoofReal?: number; livenessScore?: number },
    buffer?: Buffer
  ) => {
    // A recent run of failures is what earns a review flag — one bad frame (someone blinked,
    // a cloud passed the window) is noise, not a signal worth escalating.
    const recentFailures =
      outcome === "PASSED"
        ? 0
        : await prisma.faceVerificationAttempt.count({
            where: {
              userId,
              outcome: { not: "PASSED" },
              createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) }
            }
          });

    const imagePath =
      buffer && settings.imageRetentionDays > 0 ? await storeFaceImage(userId, "attempt", buffer) : null;

    return prisma.faceVerificationAttempt.create({
      data: {
        userId,
        context,
        outcome,
        similarity: scores.similarity ?? null,
        antispoofReal: scores.antispoofReal ?? null,
        livenessScore: scores.livenessScore ?? null,
        imagePath,
        flaggedForReview: outcome !== "PASSED" && recentFailures + 1 >= settings.maxAttempts,
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null
      }
    });
  };

  if (!enrollment) {
    await record("NOT_ENROLLED", {});
    throw new AppError(428, "You haven't enrolled your face yet — set it up in your profile first.");
  }
  if (enrollment.modelVersion !== FACE_MODEL_VERSION) {
    await record("NOT_ENROLLED", {});
    throw new AppError(428, "Your face enrollment is out of date and needs to be redone in your profile.");
  }

  const buffer = requireCapture(req);
  const analysis = await analyzeFace(buffer);

  if (analysis.faceCount === 0) {
    const attempt = await record("NO_FACE", { antispoofReal: analysis.antispoofReal, livenessScore: analysis.livenessScore }, buffer);
    return res.status(422).json({
      outcome: "NO_FACE",
      attemptId: attempt.id,
      message: "No face was detected — make sure your face is clearly visible and well lit."
    });
  }
  if (analysis.faceCount > 1) {
    const attempt = await record("MULTIPLE_FACES", { antispoofReal: analysis.antispoofReal, livenessScore: analysis.livenessScore }, buffer);
    return res.status(422).json({
      outcome: "MULTIPLE_FACES",
      attemptId: attempt.id,
      message: "More than one face was detected — please make sure you're alone in the frame."
    });
  }

  // Anti-spoofing is checked BEFORE the match: a printed photo of the right person would
  // otherwise sail through on similarity alone, which is the exact attack this feature exists
  // to stop. Failing this is reported as its own outcome so it's visible in the review log.
  if (analysis.antispoofReal < settings.antispoofThreshold || analysis.livenessScore < settings.livenessThreshold) {
    const attempt = await record(
      "SPOOF_SUSPECTED",
      { antispoofReal: analysis.antispoofReal, livenessScore: analysis.livenessScore },
      buffer
    );
    return res.status(422).json({
      outcome: "SPOOF_SUSPECTED",
      attemptId: attempt.id,
      message: "That didn't look like a live capture. Please look directly at the camera rather than holding up a photo or screen."
    });
  }

  const score = await similarity(decodeEmbedding(enrollment.encryptedEmbedding), analysis.embedding);
  const scores = { similarity: score, antispoofReal: analysis.antispoofReal, livenessScore: analysis.livenessScore };

  if (score < settings.matchThreshold) {
    const attempt = await record("NO_MATCH", scores, buffer);
    return res.status(422).json({
      outcome: "NO_MATCH",
      attemptId: attempt.id,
      flagged: attempt.flaggedForReview,
      message: "We couldn't confirm it's you. Try again with better lighting and your face centred."
    });
  }

  const attempt = await record("PASSED", scores, buffer);
  res.json({
    outcome: "PASSED",
    verificationId: attempt.id,
    expiresInSeconds: settings.verificationTtlSeconds
  });
});

/** Deletes the caller's own biometric data — the "withdraw consent" path every biometric
 *  privacy regime requires to exist and to be self-service. */
faceRouter.delete("/enrollment", async (req, res) => {
  const enrollment = await prisma.faceEnrollment.findUnique({ where: { userId: req.user!.id } });
  if (!enrollment) throw new AppError(404, "You don't have a face enrollment to delete.");

  await deleteEnrollmentAndData(req.user!.id);
  await audit(req.user!.id, "face.enrollment_deleted", "FaceEnrollment", req.user!.id, { self: true });
  res.json({ deleted: true });
});

/** Admin-side deletion for someone else (offboarding, or an employee asking in writing). */
faceRouter.delete("/enrollment/:userId", requireAdmin, async (req, res) => {
  const targetId = String(req.params.userId);
  const enrollment = await prisma.faceEnrollment.findUnique({ where: { userId: targetId } });
  if (!enrollment) throw new AppError(404, "That user doesn't have a face enrollment.");

  await deleteEnrollmentAndData(targetId);
  await audit(req.user!.id, "face.enrollment_deleted", "FaceEnrollment", targetId, { self: false });
  res.json({ deleted: true });
});

/** Removes the DB row AND the images on disk. Deleting only the row would leave the actual
 *  biometric images sitting in the volume, which is not what "delete my face data" means. */
async function deleteEnrollmentAndData(userId: string): Promise<void> {
  await prisma.faceEnrollment.deleteMany({ where: { userId } });
  await prisma.faceVerificationAttempt.updateMany({
    where: { userId, imagePath: { not: null } },
    data: { imagePath: null, purgedAt: new Date() }
  });
  await fsp.rm(path.join(faceStorageDir(), userId), { recursive: true, force: true }).catch(() => {
    // Best-effort: a locked/missing directory must not fail the user's deletion request.
  });
}

const attemptsQuerySchema = z.object({
  query: z.object({
    userId: z.string().optional(),
    outcome: z.string().optional(),
    flaggedOnly: z.string().optional(),
    take: z.coerce.number().int().min(1).max(200).optional()
  })
});

/** The review log. Admin-only — it exposes when and how often individuals failed identity checks. */
faceRouter.get("/attempts", requireAdmin, validate(attemptsQuerySchema), async (req, res) => {
  const { userId, outcome, flaggedOnly, take } = req.query as Record<string, string | undefined>;
  const attempts = await prisma.faceVerificationAttempt.findMany({
    where: {
      ...(userId ? { userId } : {}),
      ...(outcome ? { outcome } : {}),
      ...(flaggedOnly === "true" ? { flaggedForReview: true } : {})
    },
    orderBy: { createdAt: "desc" },
    take: take ? Number(take) : 50,
    select: {
      id: true,
      userId: true,
      context: true,
      outcome: true,
      similarity: true,
      antispoofReal: true,
      livenessScore: true,
      imagePath: true,
      purgedAt: true,
      flaggedForReview: true,
      reviewedAt: true,
      reviewNote: true,
      createdAt: true,
      consumedAt: true,
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      reviewedBy: { select: { id: true, name: true } }
    }
  });

  // `imagePath` is a server filesystem path — never leak it. The UI gets a boolean and fetches
  // the bytes through the authenticated route below if it wants them.
  res.json(
    attempts.map(({ imagePath, ...rest }) => ({ ...rest, hasImage: Boolean(imagePath) }))
  );
});

const reviewSchema = z.object({ body: z.object({ note: z.string().max(2000).optional() }) });

faceRouter.patch("/attempts/:id/review", requireAdmin, validate(reviewSchema), async (req, res) => {
  const attempt = await prisma.faceVerificationAttempt.findUnique({ where: { id: String(req.params.id) } });
  if (!attempt) throw new AppError(404, "Verification attempt not found.");

  const updated = await prisma.faceVerificationAttempt.update({
    where: { id: attempt.id },
    data: {
      flaggedForReview: false,
      reviewedById: req.user!.id,
      reviewedAt: new Date(),
      reviewNote: req.body.note ?? null
    }
  });
  await audit(req.user!.id, "face.attempt_reviewed", "FaceVerificationAttempt", attempt.id, { note: req.body.note ?? null });
  res.json({ id: updated.id, reviewedAt: updated.reviewedAt });
});

/**
 * GET /face/image/attempt/:id — streams a stored capture. The whole reason this exists rather
 * than a static mount: authorisation. You may see an image only if it's your own face or you're
 * an admin, and the tenant is already resolved by the time we get here.
 */
faceRouter.get("/image/attempt/:id", async (req, res) => {
  const attempt = await prisma.faceVerificationAttempt.findUnique({
    where: { id: String(req.params.id) },
    select: { userId: true, imagePath: true, purgedAt: true }
  });
  if (!attempt?.imagePath) throw new AppError(404, attempt?.purgedAt ? "That image has been purged by the retention policy." : "Image not found.");

  const isOwner = attempt.userId === req.user!.id;
  const isAdmin = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
  if (!isOwner && !isAdmin) throw new AppError(403, "Forbidden");

  await streamFaceImage(res, attempt.imagePath);
});

faceRouter.get("/image/enrollment/:userId", async (req, res) => {
  const targetId = String(req.params.userId);
  const isOwner = targetId === req.user!.id;
  const isAdmin = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
  if (!isOwner && !isAdmin) throw new AppError(403, "Forbidden");

  const enrollment = await prisma.faceEnrollment.findUnique({
    where: { userId: targetId },
    select: { referenceImagePath: true }
  });
  if (!enrollment?.referenceImagePath) throw new AppError(404, "No enrollment image stored.");

  await streamFaceImage(res, enrollment.referenceImagePath);
});

async function streamFaceImage(res: import("express").Response, storedPath: string): Promise<void> {
  // Defence in depth: the path comes from our own DB, but confirm it still resolves inside the
  // face directory before opening it, so a corrupted/tampered row can't read arbitrary files.
  const root = path.resolve(faceStorageDir());
  const resolved = path.resolve(storedPath);
  if (!resolved.startsWith(root + path.sep)) throw new AppError(404, "Image not found.");
  if (!fs.existsSync(resolved)) throw new AppError(404, "Image not found.");

  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Biometric imagery must not sit in shared caches or be written to disk by intermediaries.
  res.setHeader("Cache-Control", "private, no-store");
  fs.createReadStream(resolved).pipe(res);
}
