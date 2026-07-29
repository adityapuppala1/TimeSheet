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
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { faceCaptureUpload, preserveTenantContext } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { dispatchNotification } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { summarizeFaceReviewAttempt } from "../services/ai.service.js";
import {
  analyzeFace,
  assertFaceEntitlement,
  CHALLENGE_PROMPTS,
  decodeEmbedding,
  DEFAULT_CONSENT_TEXT,
  encodeEmbedding,
  FACE_MODEL_VERSION,
  faceStorageDir,
  getFaceSettings,
  isFaceFeatureAllowedForOrg,
  isFaceVerificationRequired,
  issueChallenge,
  redeemChallenge,
  removeUserFaceDirectories,
  similarity,
  storeFaceImage,
  verifyChallengePose,
  type FaceAnalysis,
  type FaceContext,
  type FaceOutcome
} from "../services/face.service.js";

export const faceRouter = Router();
faceRouter.use(requireAuth);

const requireAdmin = requireRole(["SUPER_ADMIN", "ADMIN"]);

/** Camera products that present a virtual device. Matching one is a review SIGNAL, never a
 *  block — the label is client-reported and trivially spoofable in both directions, so blocking
 *  on it would only stop honest streamers while teaching attackers to blank the label. */
const VIRTUAL_CAMERA_PATTERN = /obs|virtual|manycam|snap\s*camera|xsplit|droidcam|iriun|epoccam|camtwist|splitcam/i;

function requireCapture(req: { file?: Express.Multer.File }): Buffer {
  if (!req.file?.buffer?.length) throw new AppError(422, "No face capture was received.");
  return req.file.buffer;
}

/** Multi-frame uploads arrive as `capture` array (challenge on: [neutral, gesture]; off: one). */
function requireFrames(req: { files?: unknown }): Buffer[] {
  const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
  const buffers = files.filter((f) => f?.buffer?.length).map((f) => f.buffer);
  if (buffers.length === 0) throw new AppError(422, "No face capture was received.");
  return buffers;
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

  const [timesheetRequired, ticketRequired, approvalRequired, allowedByPlan] = await Promise.all([
    isFaceVerificationRequired(req.user!.id, "TIMESHEET"),
    isFaceVerificationRequired(req.user!.id, "TICKET"),
    isFaceVerificationRequired(req.user!.id, "APPROVAL"),
    isFaceFeatureAllowedForOrg()
  ]);

  res.json({
    enabled: settings.enabled,
    allowedByPlan,
    requiredForTimesheet: timesheetRequired,
    requiredForTicket: ticketRequired,
    requiredForApproval: approvalRequired,
    challengeEnabled: settings.challengeEnabled,
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

const challengeSchema = z.object({ body: z.object({ context: z.enum(["TIMESHEET", "TICKET", "APPROVAL"]) }) });

/**
 * POST /face/challenge — issues the liveness challenge a verification must satisfy while
 * challenge–response is on (see face.service.ts's challenge section for the attack model).
 * Returns the instruction to display; the subsequent /verify redeems it, single-use.
 */
faceRouter.post("/challenge", validate(challengeSchema), async (req, res) => {
  const settings = await getFaceSettings();
  if (!settings.enabled) throw new AppError(403, "Face verification is not enabled for this workspace.");
  await assertFaceEntitlement();

  const challenge = await issueChallenge(req.user!.id, req.body.context as FaceContext);
  res.status(201).json({
    challengeId: challenge.id,
    instruction: challenge.instruction,
    prompt: CHALLENGE_PROMPTS[challenge.instruction],
    expiresInSeconds: challenge.expiresInSeconds
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
  // Fail CLOSED: no new biometric data may be collected without the plan entitlement.
  await assertFaceEntitlement();
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

const verifySchema = z.object({
  body: z.object({
    context: z.enum(["TIMESHEET", "TICKET", "APPROVAL"]),
    /// Required while GlobalFaceVerificationSettings.challengeEnabled — from POST /face/challenge.
    challengeId: z.string().uuid().optional().or(z.literal("")),
    /// The active camera's MediaDeviceInfo.label, self-reported by the browser. Recorded as a
    /// review signal (virtual-camera heuristic) — never trusted, never blocking.
    deviceLabel: z.string().max(255).optional()
  })
});

/**
 * POST /face/verify — the actual check. Returns a short-lived, single-use `verificationId` that
 * the subsequent timesheet/ticket submit (or timesheet approval) must present (see
 * face.service.ts#consumeVerification).
 *
 * While challenge–response is on, the upload is TWO frames — [neutral, gesture] — and a valid
 * unexpired challengeId; the pose delta between them is what defeats a virtual camera replaying
 * a recorded video (see the challenge section in face.service.ts).
 *
 * Every outcome is persisted, including failures: "this account failed identity check four
 * times in a row" is precisely the signal this feature exists to surface, so it must survive
 * even when the user simply gives up and closes the dialog.
 */
faceRouter.post("/verify", preserveTenantContext(faceCaptureUpload.array("capture", 2)), validate(verifySchema), async (req, res) => {
  const settings = await getFaceSettings();
  if (!settings.enabled) throw new AppError(403, "Face verification is not enabled for this workspace.");
  // Fail CLOSED here too: a verification that can never be consumed (the submit gates are
  // entitlement-fail-open) would only produce confusing dead passes.
  await assertFaceEntitlement();

  const context = req.body.context as FaceContext;
  const userId = req.user!.id;

  const deviceLabel = typeof req.body.deviceLabel === "string" && req.body.deviceLabel.trim() ? req.body.deviceLabel.trim() : null;
  const virtualCameraSuspected = Boolean(deviceLabel && VIRTUAL_CAMERA_PATTERN.test(deviceLabel));

  // Network-continuity signal: does this attempt's IP match ANY of the user's recent passes?
  // Only meaningful once a baseline exists (3+ prior passes), and only a signal even then —
  // people work from trains and cafés.
  const recentPasses = await prisma.faceVerificationAttempt.findMany({
    where: { userId, outcome: "PASSED", createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    select: { ipAddress: true },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  const knownIps = new Set(recentPasses.map((a) => a.ipAddress).filter(Boolean));
  const unfamiliarNetwork = recentPasses.length >= 3 && Boolean(req.ip) && !knownIps.has(req.ip!);

  const enrollment = await prisma.faceEnrollment.findUnique({ where: { userId } });

  let challengeMetrics: { instruction: string; yawDelta: number | null; pitchDelta: number | null; frameSimilarity: number | null } | null = null;

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

    const flaggedForReview =
      // Repeated failures escalate as before; a suspected virtual camera flags IMMEDIATELY even
      // on a pass — a pass through an injection tool is precisely the pass worth a human look.
      (outcome !== "PASSED" && recentFailures + 1 >= settings.maxAttempts) || virtualCameraSuspected;

    const attempt = await prisma.faceVerificationAttempt.create({
      data: {
        userId,
        context,
        outcome,
        similarity: scores.similarity ?? null,
        antispoofReal: scores.antispoofReal ?? null,
        livenessScore: scores.livenessScore ?? null,
        imagePath,
        flaggedForReview,
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        deviceLabel,
        virtualCameraSuspected,
        unfamiliarNetwork,
        challengeInstruction: challengeMetrics?.instruction ?? null,
        challengeYawDelta: challengeMetrics?.yawDelta ?? null,
        challengePitchDelta: challengeMetrics?.pitchDelta ?? null,
        frameSimilarity: challengeMetrics?.frameSimilarity ?? null
      }
    });

    if (flaggedForReview) {
      await notifyFlagged(userId, outcome, recentFailures + 1, context).catch(() => undefined);
    }
    return attempt;
  };

  if (!enrollment) {
    await record("NOT_ENROLLED", {});
    throw new AppError(428, "You haven't enrolled your face yet — set it up in your profile first.");
  }
  if (enrollment.modelVersion !== FACE_MODEL_VERSION) {
    await record("NOT_ENROLLED", {});
    throw new AppError(428, "Your face enrollment is out of date and needs to be redone in your profile.");
  }

  const frames = requireFrames(req);
  const buffer = frames[0];
  const analysis = await analyzeFace(buffer);
  let gestureAnalysis: FaceAnalysis | null = null;

  // ---- Challenge–response (anti-injection) ----
  if (settings.challengeEnabled) {
    const instruction = await redeemChallenge({ challengeId: req.body.challengeId || null, userId, context });
    if (!instruction || frames.length < 2) {
      const attempt = await record("CHALLENGE_FAILED", {}, buffer);
      return res.status(422).json({
        outcome: "CHALLENGE_FAILED",
        attemptId: attempt.id,
        message: "The liveness step didn't complete — please start the check again and follow the on-screen movement."
      });
    }

    gestureAnalysis = await analyzeFace(frames[1]);
    const pose = verifyChallengePose(instruction, analysis, gestureAnalysis);
    const frameSimilarity =
      analysis.embedding.length && gestureAnalysis.embedding.length
        ? await similarity(analysis.embedding, gestureAnalysis.embedding)
        : null;
    challengeMetrics = { instruction, yawDelta: pose.yawDelta, pitchDelta: pose.pitchDelta, frameSimilarity };

    // The gesture frame must also be a single live face — otherwise frame 2 could be anything.
    if (!pose.ok || gestureAnalysis.faceCount !== 1) {
      const attempt = await record("CHALLENGE_FAILED", { antispoofReal: analysis.antispoofReal, livenessScore: analysis.livenessScore }, buffer);
      return res.status(422).json({
        outcome: "CHALLENGE_FAILED",
        attemptId: attempt.id,
        flagged: attempt.flaggedForReview,
        message: "We couldn't see the requested head movement — face the camera, then make the movement clearly and try again."
      });
    }
  }

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
  // While the challenge ran, BOTH frames must clear the bar — a spoofed gesture frame is a
  // spoofed check.
  const spoofSuspected =
    analysis.antispoofReal < settings.antispoofThreshold ||
    analysis.livenessScore < settings.livenessThreshold ||
    (gestureAnalysis !== null &&
      (gestureAnalysis.antispoofReal < settings.antispoofThreshold || gestureAnalysis.livenessScore < settings.livenessThreshold));
  if (spoofSuspected) {
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

/**
 * Manager first, then this workspace's admins — the escalation audience for "someone repeatedly
 * failed to prove they're this person" (or passed through a suspected virtual camera). In-app
 * always; email per the workspace's notification toggles. Never includes scores or images.
 */
async function notifyFlagged(subjectUserId: string, outcome: FaceOutcome, failureCount: number, context: FaceContext): Promise<void> {
  const subject = await prisma.user.findUnique({
    where: { id: subjectUserId },
    select: { name: true, managerId: true }
  });
  if (!subject) return;

  const admins = await prisma.user.findMany({
    where: { role: { name: { in: ["SUPER_ADMIN", "ADMIN"] } }, status: "ACTIVE", deletedAt: null },
    select: { id: true, name: true }
  });
  const recipients = new Map<string, string>(admins.map((a) => [a.id, a.name]));
  if (subject.managerId && !recipients.has(subject.managerId)) {
    const manager = await prisma.user.findUnique({ where: { id: subject.managerId }, select: { id: true, name: true } });
    if (manager) recipients.set(manager.id, manager.name);
  }
  recipients.delete(subjectUserId);

  const reason =
    outcome === "PASSED"
      ? "passed an identity check through a suspected virtual camera"
      : `failed ${failureCount} identity ${failureCount === 1 ? "check" : "checks"} in a row`;

  for (const [recipientId, recipientName] of recipients) {
    await dispatchNotification({
      userId: recipientId,
      category: "face.verification_flagged",
      title: "Identity check flagged for review",
      body: `${subject.name} ${reason}. The attempt is in the face verification review log.`,
      link: "/app/settings",
      email: {
        templateKey: "face.verification_flagged",
        vars: { targetName: recipientName, employeeName: subject.name, failureCount, context },
        fallback: {
          subject: "Identity check flagged for review",
          html: templates.faceVerificationFlagged({ targetName: recipientName, employeeName: subject.name, failureCount, context })
        }
      }
    });
  }
}

/** Deletes the caller's own biometric data — the "withdraw consent" path every biometric
 *  privacy regime requires to exist and to be self-service. */
faceRouter.delete("/enrollment", async (req, res) => {
  const enrollment = await prisma.faceEnrollment.findUnique({ where: { userId: req.user!.id } });
  if (!enrollment) throw new AppError(404, "You don't have a face enrollment to delete.");

  await deleteEnrollmentAndData(req.user!.id, { byAdmin: false });
  await audit(req.user!.id, "face.enrollment_deleted", "FaceEnrollment", req.user!.id, { self: true });
  res.json({ deleted: true });
});

/** Admin-side deletion for someone else (offboarding, or an employee asking in writing). */
faceRouter.delete("/enrollment/:userId", requireAdmin, async (req, res) => {
  const targetId = String(req.params.userId);
  const enrollment = await prisma.faceEnrollment.findUnique({ where: { userId: targetId } });
  if (!enrollment) throw new AppError(404, "That user doesn't have a face enrollment.");

  await deleteEnrollmentAndData(targetId, { byAdmin: true });
  await audit(req.user!.id, "face.enrollment_deleted", "FaceEnrollment", targetId, { self: false });
  res.json({ deleted: true });
});

/** Removes the DB row AND the images on disk. Deleting only the row would leave the actual
 *  biometric images sitting in the volume, which is not what "delete my face data" means.
 *  The confirmation notification doubles as the deletion record every biometric-privacy regime
 *  wants to see exist. */
async function deleteEnrollmentAndData(userId: string, opts: { byAdmin: boolean }): Promise<void> {
  await prisma.faceEnrollment.deleteMany({ where: { userId } });
  await prisma.faceVerificationAttempt.updateMany({
    where: { userId, imagePath: { not: null } },
    data: { imagePath: null, purgedAt: new Date() }
  });
  await removeUserFaceDirectories(userId);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (user) {
    await dispatchNotification({
      userId,
      category: "face.data_deleted",
      title: "Your face data was deleted",
      body: `${opts.byAdmin ? "An administrator" : "You"} deleted your face verification data. The stored template and any retained captures are permanently gone.`,
      link: "/app/profile",
      email: {
        templateKey: "face.data_deleted",
        vars: { name: user.name },
        fallback: {
          subject: "Your face data was deleted",
          html: templates.faceDataDeleted({ name: user.name, byAdmin: opts.byAdmin })
        }
      }
    }).catch(() => undefined);
  }
}

/**
 * GET /face/export — the data-subject-access answer for this feature, self-service. Everything
 * the system holds ABOUT the caller's face verification, minus the biometrics themselves: the
 * template is never exported (it's the credential — exporting it would hand out the thing being
 * protected), and images are fetched individually through the authenticated image routes.
 */
faceRouter.get("/export", async (req, res) => {
  const userId = req.user!.id;
  const [enrollment, attempts] = await Promise.all([
    prisma.faceEnrollment.findUnique({
      where: { userId },
      select: { createdAt: true, updatedAt: true, consentAt: true, consentText: true, consentIp: true, modelVersion: true, referenceImagePath: true }
    }),
    prisma.faceVerificationAttempt.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, context: true, outcome: true, similarity: true, antispoofReal: true, livenessScore: true,
        deviceLabel: true, virtualCameraSuspected: true, unfamiliarNetwork: true,
        challengeInstruction: true, ipAddress: true, createdAt: true, consumedAt: true,
        timesheetId: true, ticketId: true, imagePath: true, purgedAt: true
      }
    })
  ]);

  res.setHeader("Content-Disposition", `attachment; filename="face-data-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    subject: { id: userId, email: req.user!.email },
    enrollment: enrollment
      ? {
          enrolledAt: enrollment.createdAt,
          updatedAt: enrollment.updatedAt,
          consentAt: enrollment.consentAt,
          consentText: enrollment.consentText,
          consentIp: enrollment.consentIp,
          modelVersion: enrollment.modelVersion,
          referenceImageStored: Boolean(enrollment.referenceImagePath)
        }
      : null,
    attempts: attempts.map(({ imagePath, ...rest }) => ({ ...rest, imageStored: Boolean(imagePath) }))
  });
});

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
      deviceLabel: true,
      virtualCameraSuspected: true,
      unfamiliarNetwork: true,
      challengeInstruction: true,
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
 * POST /face/attempts/:id/ai-summary — AI-drafted review brief for one flagged attempt. Gated
 * by GlobalAISettings.faceReviewSummaryEnabled and the org's AI budget (both enforced inside
 * ai.service.ts). Only attempt METADATA leaves the server — never an image or a template.
 */
faceRouter.post("/attempts/:id/ai-summary", requireAdmin, async (req, res) => {
  const summary = await summarizeFaceReviewAttempt({ attemptId: String(req.params.id) });
  if (!summary) throw new AppError(502, "The AI response could not be parsed — try again.");
  res.json(summary);
});

/**
 * GET /face/stats — the evidence an admin tunes thresholds against: the actual similarity
 * distribution of THIS workforce's attempts (bucketed, split by outcome), totals by outcome,
 * and the anti-injection signal counts. The histogram exists because "is 0.75 the right
 * threshold?" is answered by looking for the valley between the passed and rejected clusters —
 * a statistics question the review log's raw rows can't show at a glance.
 */
faceRouter.get("/stats", requireAdmin, async (_req, res) => {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const attempts = await prisma.faceVerificationAttempt.findMany({
    where: { createdAt: { gte: since } },
    select: { outcome: true, similarity: true, virtualCameraSuspected: true, unfamiliarNetwork: true, flaggedForReview: true },
    orderBy: { createdAt: "desc" },
    take: 5000
  });

  const outcomes: Record<string, number> = {};
  let virtualCamera = 0;
  let unfamiliar = 0;
  let flaggedPending = 0;

  // 0.40 → 1.00 in 0.05 steps — similarity below 0.4 is noise (no-face/error paths).
  const BUCKET_START = 0.4;
  const BUCKET_SIZE = 0.05;
  const bucketCount = Math.round((1.0 - BUCKET_START) / BUCKET_SIZE);
  const histogram = Array.from({ length: bucketCount }, (_, i) => ({
    from: Number((BUCKET_START + i * BUCKET_SIZE).toFixed(2)),
    to: Number((BUCKET_START + (i + 1) * BUCKET_SIZE).toFixed(2)),
    passed: 0,
    rejected: 0
  }));

  for (const attempt of attempts) {
    outcomes[attempt.outcome] = (outcomes[attempt.outcome] ?? 0) + 1;
    if (attempt.virtualCameraSuspected) virtualCamera++;
    if (attempt.unfamiliarNetwork) unfamiliar++;
    if (attempt.flaggedForReview) flaggedPending++;
    if (attempt.similarity != null && (attempt.outcome === "PASSED" || attempt.outcome === "NO_MATCH")) {
      const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((attempt.similarity - BUCKET_START) / BUCKET_SIZE)));
      if (attempt.outcome === "PASSED") histogram[index].passed++;
      else histogram[index].rejected++;
    }
  }

  res.json({
    since: since.toISOString(),
    total: attempts.length,
    outcomes,
    flaggedPending,
    virtualCameraSuspected: virtualCamera,
    unfamiliarNetwork: unfamiliar,
    histogram
  });
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
