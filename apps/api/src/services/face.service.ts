/**
 * WHAT: the one place this app turns a captured webcam frame into an identity decision —
 * model loading, embedding extraction, anti-spoof/liveness scoring, and match comparison.
 * Every face check in the app (enrollment and verification) goes through here.
 *
 * WHY server-side: this is an anti-fraud control, and a control the client decides the outcome
 * of is not a control. If the browser computed the match and POSTed "verified: true", any
 * employee could send that from devtools and the feature would be theatre. So the browser is a
 * dumb camera — it uploads a JPEG, and every judgement happens here.
 *
 * WHY these specific loading gymnastics (all three were found the hard way, don't "simplify"):
 *  1. `@vladmandic/human`'s package.json exports map lists the "node" condition FIRST, so both
 *     `require("@vladmandic/human")` and `import` of the bare name resolve to dist/human.node.js
 *     — which hard-requires the NATIVE @tensorflow/tfjs-node. That's a compiled addon with no
 *     musl prebuilds, i.e. it does not install on this project's node:22-alpine image.
 *  2. dist/human.esm.js (the browser bundle, tfjs baked in) loads under Node but dies
 *     immediately on `util.TextEncoder is not a constructor` — it assumes browser globals.
 *  3. dist/human.node-wasm.js is the build that is both native-free AND Node-correct: it takes
 *     tfjs from the pure-JS @tensorflow/tfjs-core + tfjs-converter + tfjs-backend-wasm packages,
 *     none of which have a compile step. It's loaded by ABSOLUTE PATH to bypass the exports map.
 *  4. tfjs fetches model files through `fetch`, and Node's undici still rejects the `file:`
 *     scheme outright ("not implemented... yet"). The models ship inside the npm package, so
 *     `installFileFetchShim` teaches fetch to read file: URLs and delegates everything else.
 *
 * WHY the threshold defaults are what they are: measured against this exact model, not guessed.
 * Two DIFFERENT people score ~0.60-0.67 similarity; the same person across different captures
 * ~0.83; an identical image 1.00. 0.75 sits in that gap. Every attempt persists its own score
 * so an admin can review the real distribution for their workforce and re-tune.
 *
 * WHO calls this: controllers/face.controller.ts (enroll/verify), and the timesheet/ticket
 * controllers indirectly via `consumeVerification`.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";
import { isFaceVerificationAllowed } from "./plan-limits.service.js";
import { dispatchNotification } from "./notify.service.js";
import { templates } from "./mail-templates.js";

const require = createRequire(import.meta.url);

/** Identifies which model produced an embedding. Embeddings from different models are NOT
 *  comparable, so this is persisted per enrollment and a mismatch forces re-enrollment rather
 *  than silently comparing incompatible vectors (which would reject everybody). */
export const FACE_MODEL_VERSION = "human-3-faceres-1024";

export const FACE_GLOBAL_ID = "global";

export type FaceOutcome =
  | "PASSED"
  | "NO_FACE"
  | "MULTIPLE_FACES"
  | "NO_MATCH"
  | "SPOOF_SUSPECTED"
  | "CHALLENGE_FAILED"
  | "LOW_QUALITY"
  | "NOT_ENROLLED"
  | "ERROR";

export interface FaceAnalysis {
  embedding: number[];
  /** Human's antispoof score — higher means "looks like a real face, not a printout/screen". */
  antispoofReal: number;
  /** Human's liveness score — higher means "a live person was in front of the lens". */
  livenessScore: number;
  faceCount: number;
  /** Share of the frame the face box covers, and how far its centre sits from the frame centre
   *  (0 = dead centre, 1 = corner). Both feed scoreQuality. */
  faceAreaShare: number;
  centreOffset: number;
  /** Mean luminance 0..1 of the decoded frame — catches the too-dark/blown-out captures that
   *  otherwise surface as a bewildering NO_MATCH. */
  brightness: number;
  /** Head rotation in radians from Human's facemesh (0 when it couldn't be computed). Used by
   *  the challenge–response check, which compares the DELTA between two frames — so the
   *  absolute sign convention doesn't need to be trusted (see verifyChallengePose). */
  yaw: number;
  pitch: number;
}

// ---------------------------------------------------------------------------------------------
// Model loading (lazy, once per process)
// ---------------------------------------------------------------------------------------------

let humanPromise: Promise<any> | null = null;
let fetchShimInstalled = false;

/** Teaches global fetch the `file:` scheme so tfjs can load models off local disk. Scoped as
 *  narrowly as possible: anything that isn't a file: URL goes straight to the real fetch. */
function installFileFetchShim(): void {
  if (fetchShimInstalled) return;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : ((input as { url?: string })?.url ?? String(input));
    if (url.startsWith("file://")) {
      const buffer = await fs.readFile(fileURLToPath(url));
      const type = url.endsWith(".json") ? "application/json" : "application/octet-stream";
      return new Response(new Uint8Array(buffer), { status: 200, headers: { "content-type": type } });
    }
    return (nativeFetch as (i: unknown, x?: unknown) => Promise<Response>)(input, init);
  }) as typeof fetch;
  fetchShimInstalled = true;
}

function toFileUrl(target: string): string {
  return `file://${target.replaceAll("\\", "/")}`;
}

/**
 * Loads Human once and caches the instance. Deliberately lazy: the models are ~10MB and take a
 * few seconds to initialise, and the overwhelming majority of deployments never turn this
 * feature on — so nothing is paid at boot, only on the first real face request.
 */
export async function getHuman(): Promise<any> {
  if (humanPromise) return humanPromise;

  humanPromise = (async () => {
    installFileFetchShim();

    // `require.resolve` only computes a path — it does NOT execute dist/human.node.js, so the
    // native tfjs-node dependency inside it is never touched.
    const humanRoot = path.resolve(require.resolve("@vladmandic/human"), "..", "..");
    const wasmRoot = path.resolve(require.resolve("@tensorflow/tfjs-backend-wasm"), "..", "..");

    const HumanCtor = require(path.join(humanRoot, "dist", "human.node-wasm.js")).default;

    const human = new HumanCtor({
      backend: "wasm",
      wasmPath: `${toFileUrl(path.join(wasmRoot, "dist"))}/`,
      modelBasePath: `${toFileUrl(path.join(humanRoot, "models"))}/`,
      // 0 = never reuse a previous frame's result. This is a security check on a single
      // uploaded still, so any caching between calls would be actively wrong.
      cacheSensitivity: 0,
      face: {
        enabled: true,
        detector: { enabled: true, maxDetected: 5, minConfidence: 0.3 },
        mesh: { enabled: true },
        description: { enabled: true }, // faceres -> the 1024-float embedding
        antispoof: { enabled: true },
        liveness: { enabled: true },
        iris: { enabled: false },
        emotion: { enabled: false }
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      gesture: { enabled: false },
      filter: { enabled: false },
      segmentation: { enabled: false }
    });

    await human.load();
    return human;
  })();

  try {
    return await humanPromise;
  } catch (error) {
    // Don't cache a failed load — a transient disk/permission problem shouldn't permanently
    // disable the feature for the lifetime of the process.
    humanPromise = null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

/** Hard ceiling on a decoded capture. Bounds both memory and inference time — a face fills the
 *  frame in a webcam selfie, so there's nothing useful above this. */
const MAX_DIMENSION = 1024;

/**
 * Decodes an uploaded image and runs detection. Re-encoding through sharp first is not just
 * resizing — it's the same defence `utils/image.ts#processAvatar` applies to avatars: it strips
 * EXIF/metadata and normalises a possibly-hostile upload into clean raw pixels before any of it
 * reaches the ML runtime.
 */
export async function analyzeFace(imageBuffer: Buffer): Promise<FaceAnalysis> {
  const human = await getHuman();

  const { data, info } = await sharp(imageBuffer, { failOn: "error" })
    .rotate()
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = human.tf.tensor(Array.from(data), [info.height, info.width, 3], "int32");
  const batched = human.tf.expandDims(tensor, 0);
  human.tf.dispose(tensor);

  try {
    const result = await human.detect(batched);
    const faces = (result.face ?? []).filter((f: { embedding?: number[] }) => f.embedding?.length);

    /**
     * Mean luminance over a rectangle of the already-decoded raw pixels (no second decode).
     *
     * Called with the FACE BOX, not the whole frame — measuring the frame was a real bug: a
     * well-lit person sitting in front of a dark room (or against a dark-UI background) has a
     * low frame mean and would be told "too dark to see you" while being perfectly visible. What
     * matters for matching is whether the FACE is exposed, so that's what gets measured.
     */
    const regionBrightness = (x0: number, y0: number, w: number, h: number): number => {
      const left = Math.max(0, Math.floor(x0));
      const top = Math.max(0, Math.floor(y0));
      const right = Math.min(info.width, Math.ceil(x0 + w));
      const bottom = Math.min(info.height, Math.ceil(y0 + h));
      if (right <= left || bottom <= top) return 0;

      // Cap the sample count so a 1024px frame costs the same as a small one.
      const step = Math.max(1, Math.floor(Math.sqrt(((right - left) * (bottom - top)) / 4096)));
      let sum = 0;
      let samples = 0;
      for (let y = top; y < bottom; y += step) {
        for (let x = left; x < right; x += step) {
          const i = (y * info.width + x) * 3;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          samples++;
        }
      }
      return samples > 0 ? sum / samples / 255 : 0;
    };

    if (faces.length === 0) {
      // No box to measure — whole-frame is the only available proxy, and the caller's message is
      // "no face detected" regardless.
      return {
        embedding: [], antispoofReal: 0, livenessScore: 0, faceCount: 0, yaw: 0, pitch: 0,
        faceAreaShare: 0, centreOffset: 1, brightness: regionBrightness(0, 0, info.width, info.height)
      };
    }

    // Largest face wins when several are present — the subject is the one closest to the lens.
    // `faceCount` is still reported so the caller can reject a multi-person frame outright
    // (someone standing behind the real employee is exactly the scenario worth refusing).
    const primary = faces.reduce((biggest: any, candidate: any) => {
      const area = (b: any) => (b.box?.[2] ?? 0) * (b.box?.[3] ?? 0);
      return area(candidate) > area(biggest) ? candidate : biggest;
    }, faces[0]);

    const angle = primary.rotation?.angle ?? {};
    const box = primary.box ?? [0, 0, 0, 0];
    const [bx, by, bw, bh] = box as number[];
    const faceAreaShare = (bw * bh) / (info.width * info.height);
    const cx = (bx + bw / 2) / info.width;
    const cy = (by + bh / 2) / info.height;
    // Normalised distance from frame centre, capped at 1.
    const centreOffset = Math.min(1, Math.hypot(cx - 0.5, cy - 0.5) / 0.7071);

    return {
      embedding: Array.from(primary.embedding as number[]),
      antispoofReal: typeof primary.real === "number" ? primary.real : 0,
      livenessScore: typeof primary.live === "number" ? primary.live : 0,
      faceCount: faces.length,
      yaw: Number.isFinite(angle.yaw) ? angle.yaw : 0,
      pitch: Number.isFinite(angle.pitch) ? angle.pitch : 0,
      faceAreaShare: Number.isFinite(faceAreaShare) ? faceAreaShare : 0,
      centreOffset: Number.isFinite(centreOffset) ? centreOffset : 1,
      brightness: regionBrightness(bx, by, bw, bh)
    };
  } finally {
    human.tf.dispose(batched);
  }
}

/** Similarity in 0..1 between two embeddings (1.0 = identical). Uses Human's own metric so the
 *  calibrated thresholds in GlobalFaceVerificationSettings stay meaningful. */
export async function similarity(a: number[], b: number[]): Promise<number> {
  const human = await getHuman();
  const value = human.match.similarity(a, b);
  return Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------------------------
// Capture quality
// ---------------------------------------------------------------------------------------------

/** Below this the frame is refused as unjudgeable rather than scored as a match failure. */
export const MIN_QUALITY = 0.45;

export interface QualityVerdict {
  score: number;
  /** Actionable, non-accusatory instruction — null when the frame is good enough. */
  hint: string | null;
}

/**
 * Turns the geometric/exposure facts of a capture into one 0..1 score plus the single most useful
 * thing to tell the person.
 *
 * WHY this exists: an unusable frame used to fall straight through to the matcher and come back
 * NO_MATCH — which says "we don't believe you're you" when the truth is "we couldn't see you".
 * That one mislabel is most of why the feature felt hostile. Judging judgeability first, and
 * naming the fix, converts a dead end into a two-second retake.
 *
 * The weights are deliberately blunt: face size dominates (a tiny face is the single most common
 * cause of a weak embedding), then exposure, then centring. Tuning these is a job for real
 * retake-rate data, which is exactly what /face/stats now reports.
 */
export function scoreQuality(analysis: FaceAnalysis): QualityVerdict {
  if (analysis.faceCount === 0) return { score: 0, hint: "No face detected — make sure your face is clearly visible and well lit." };

  // Face should fill a decent share of frame; ~9% is arm's length, below ~2% is unusable.
  const sizeScore = Math.max(0, Math.min(1, (analysis.faceAreaShare - 0.015) / (0.09 - 0.015)));
  // Comfortable exposure band; punishes both crushed shadows and blown highlights.
  const exposureScore = Math.max(0, Math.min(1, 1 - Math.abs(analysis.brightness - 0.5) / 0.42));
  const centreScore = Math.max(0, Math.min(1, 1 - analysis.centreOffset / 0.55));

  // The score is a RANKING measure (best-frame selection, telemetry). Judgeability is decided by
  // hard per-dimension floors below, NOT by this sum — the dimensions are AND conditions, and a
  // weighted sum lets two good dimensions outvote a fatal one. First cut of this function did
  // exactly that: a face filling 1.8% of the frame scored 0.51 and passed, because good exposure
  // and centring alone cleared the bar. Unit tests caught it; the floors are the fix.
  const score = 0.5 * sizeScore + 0.3 * exposureScore + 0.2 * centreScore;

  // Only the dimensions that actually degrade the EMBEDDING are disqualifying, and each one is
  // independently fatal (see the note above about why a weighted sum can't decide this).
  //
  // Face size and exposure qualify: too few pixels or crushed/blown tone genuinely produce a weak
  // vector. Centring deliberately does NOT — the model crops to the face box, so a face sitting
  // off to one side yields the same quality embedding as a centred one. Rejecting on position
  // would refuse a perfectly usable capture (and did: the real test corpus tripped it). Centring
  // stays as a gentle live nudge in the client's own hint and as a mild term in the ranking score,
  // which is where it belongs.
  let hint: string | null = null;
  if (analysis.brightness < 0.12) hint = "Too dark to see you clearly — move somewhere brighter or face a light.";
  else if (analysis.brightness > 0.93) hint = "The picture is washed out — move away from the bright light behind you.";
  else if (analysis.faceAreaShare < 0.02) hint = "Move a little closer to the camera.";
  else if (sizeScore < 0.12 || exposureScore < 0.2) {
    // Cleared the absolute floors but still marginal on a dimension that matters.
    hint = sizeScore <= exposureScore ? "Move a little closer to the camera." : "Try somewhere with more even lighting.";
  }
  return { score: Number(score.toFixed(3)), hint };
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

export interface MatchResult {
  /** Best similarity across every stored template for this user. */
  score: number;
  /** How many templates were compared — 1 for a legacy single-template enrollment. */
  templatesCompared: number;
}

/**
 * Compares a capture against EVERY stored template for the enrollment and keeps the best.
 * Multi-template matching only ever raises the score for a genuine user (more chances to look
 * like themselves) while leaving the bar an impostor must clear untouched — see
 * FaceEnrollmentTemplate's schema comment for why single-template enrollment was the accuracy
 * ceiling.
 */
export async function matchAgainstEnrollment(
  enrollment: { id: string; encryptedEmbedding: string },
  candidate: number[]
): Promise<MatchResult> {
  const extras = await prisma.faceEnrollmentTemplate.findMany({
    where: { enrollmentId: enrollment.id, modelVersion: FACE_MODEL_VERSION },
    select: { encryptedEmbedding: true }
  });

  const stored = [enrollment.encryptedEmbedding, ...extras.map((t) => t.encryptedEmbedding)];
  let best = 0;
  for (const ciphertext of stored) {
    const score = await similarity(decodeEmbedding(ciphertext), candidate);
    if (score > best) best = score;
  }
  return { score: best, templatesCompared: stored.length };
}

/**
 * The match threshold to judge THIS user by — never looser than the workspace setting.
 *
 * A single global threshold is wrong for almost everybody: people whose captures are very
 * consistent could safely be held to a stricter bar, and holding them to the loose global one is
 * unearned risk. So this tightens toward the low end of the user's OWN passing distribution and
 * clamps to the global value as a floor. The direction is the whole safety argument — an adaptive
 * threshold that could drop below the admin's setting would let a lookalike in precisely because
 * the real user has been sloppy, which is backwards.
 */
export async function effectiveMatchThreshold(userId: string, globalThreshold: number): Promise<number> {
  const recent = await prisma.faceVerificationAttempt.findMany({
    where: { userId, outcome: "PASSED", similarity: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { similarity: true }
  });

  const scores = recent.map((r) => r.similarity!).filter((s) => Number.isFinite(s));
  // Fewer than 8 passes is not a distribution, it's noise — stay on the global setting.
  if (scores.length < 8) return globalThreshold;

  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / scores.length);
  // 3 sd below this person's own mean: tight enough to matter, loose enough not to fail them on
  // an ordinary bad-hair day. Capped at 0.95 so it can never become unpassable.
  const personal = Math.min(0.95, mean - 3 * sd);
  return Math.max(globalThreshold, personal);
}

// ---------------------------------------------------------------------------------------------
// Settings + storage
// ---------------------------------------------------------------------------------------------

/** Upsert-on-read singleton, same pattern as every other global settings row in this app. */
export async function getFaceSettings() {
  return prisma.globalFaceVerificationSettings.upsert({
    where: { id: FACE_GLOBAL_ID },
    update: {},
    create: { id: FACE_GLOBAL_ID }
  });
}

export const DEFAULT_CONSENT_TEXT =
  "I consent to my employer capturing and processing an image of my face to verify my identity " +
  "when I perform protected actions in this workspace, such as submitting timesheets, creating " +
  "or progressing tickets, or approving timesheets. I understand a mathematical representation " +
  "(template) of my face will be stored securely for this purpose, that captured images are " +
  "retained only for the period shown above, and that I may withdraw this consent at any time " +
  "— which permanently deletes my stored face data.";

/** Face images NEVER go under the public `/uploads` static mount: app.ts serves that with no
 *  authentication at all, so anyone who guesses a filename could read them cross-tenant. They
 *  live in a separate tree served only by an authenticated API route. */
export function faceStorageDir(): string {
  return path.join(env.UPLOAD_DIR, "face");
}

/** Org-scoped: face/<orgId>/<userId>/. The orgId level exists so one organization's biometric
 *  imagery can be located (and purged) as a unit — when an org is deleted or its entitlement
 *  grace period ends, "remove this org's face data" must be a directory, not a DB join. */
function userFaceDir(userId: string): string {
  return path.join(faceStorageDir(), requireTenantContext().orgId, userId);
}

/** Removes a user's stored face imagery — both the current org-scoped location and the legacy
 *  pre-org-scoping one (face/<userId>/), so deletion honours data written by older versions. */
export async function removeUserFaceDirectories(userId: string): Promise<void> {
  const candidates = [userFaceDir(userId), path.join(faceStorageDir(), userId)];
  for (const dir of candidates) {
    // Best-effort: a locked/missing directory must not fail the user's deletion request.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function storeFaceImage(userId: string, kind: "reference" | "attempt", buffer: Buffer): Promise<string> {
  const dir = userFaceDir(userId);
  await fs.mkdir(dir, { recursive: true });
  // Re-encoded (not the raw upload): strips metadata and normalises the format on disk.
  const jpeg = await sharp(buffer, { failOn: "error" })
    .rotate()
    .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  const filename = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const full = path.join(dir, filename);
  await fs.writeFile(full, jpeg);
  return full;
}

export function encodeEmbedding(embedding: number[]): string {
  return encryptSecret(Buffer.from(new Float32Array(embedding).buffer).toString("base64"));
}

export function decodeEmbedding(encrypted: string): number[] {
  const raw = Buffer.from(decryptSecret(encrypted), "base64");
  return Array.from(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4));
}

// ---------------------------------------------------------------------------------------------
// Entitlement (plan tier)
// ---------------------------------------------------------------------------------------------

/** Whether the CURRENT org's plan tier includes face verification at all (Enterprise-only by
 *  seed default). See plan-limits.service.ts#isFaceVerificationAllowed for the fail-open vs
 *  fail-closed split that hangs off this. */
export async function isFaceFeatureAllowedForOrg(): Promise<boolean> {
  return isFaceVerificationAllowed(requireTenantContext().orgId);
}

/** The fail-CLOSED half: turning the feature on, enrolling, and verifying all require the
 *  entitlement. (Enforcement on submissions is the fail-OPEN half — see below.) */
export async function assertFaceEntitlement(): Promise<void> {
  if (!(await isFaceFeatureAllowedForOrg())) {
    throw new AppError(403, "Face verification isn't included in this workspace's current plan — it requires the Enterprise tier.");
  }
}

// ---------------------------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------------------------

export type FaceContext = "TIMESHEET" | "TICKET" | "APPROVAL";

/**
 * Whether THIS user must pass a face check for THIS action right now. Read live on every
 * relevant request (never cached) for the same reason plan-tier limits are: an admin turning the
 * requirement on or off should take effect on the very next submission, not next login.
 *
 * The entitlement check fails OPEN on purpose: if the org's tier stops including face
 * verification (downgrade, lapsed payment), this must stop DEMANDING checks immediately —
 * otherwise a billing event locks every covered employee out of logging their own time. The
 * settings checks run first so the common all-off case never touches the control plane.
 */
export async function isFaceVerificationRequired(userId: string, context: FaceContext): Promise<boolean> {
  const settings = await getFaceSettings();
  if (!settings.enabled) return false;
  if (context === "TIMESHEET" && !settings.requireForTimesheet) return false;
  if (context === "TICKET" && !settings.requireForTicket) return false;
  if (context === "APPROVAL" && !settings.requireForApproval) return false;
  if (!(await isFaceFeatureAllowedForOrg())) return false;
  if (settings.enforcementMode === "ALL") return true;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { faceVerificationRequired: true } });
  return Boolean(user?.faceVerificationRequired);
}

/**
 * Redeems a PASSED verification for a submission. Single-use and short-lived by construction:
 * the point is to prove who is at the keyboard for THIS action, so a capture can neither be
 * reused across two submissions nor taken hours earlier.
 *
 * Throws (rather than returning false) so every caller fails closed — a gate that can be
 * accidentally ignored by not checking a boolean is not a gate.
 *
 * Returns the consumed attempt's id. Callers that gate a CREATE (timesheet submit, ticket
 * create) must consume BEFORE the row exists — so they take the id and bind it afterwards via
 * bindVerificationToRecord(). Callers gating an action on an EXISTING row pass the id here
 * directly.
 */
export async function consumeVerification(params: {
  verificationId: string | undefined | null;
  userId: string;
  context: FaceContext;
  timesheetId?: string;
  ticketId?: string;
}): Promise<string> {
  const settings = await getFaceSettings();

  if (!params.verificationId) {
    throw new AppError(428, "Identity verification is required before this can be submitted.");
  }

  const attempt = await prisma.faceVerificationAttempt.findUnique({ where: { id: params.verificationId } });
  if (!attempt || attempt.userId !== params.userId || attempt.context !== params.context) {
    throw new AppError(428, "Identity verification is required before this can be submitted.");
  }
  if (attempt.outcome !== "PASSED") {
    throw new AppError(428, "That identity check did not pass — please verify again.");
  }
  if (attempt.consumedAt) {
    throw new AppError(428, "That identity check has already been used — please verify again.");
  }

  const ageSeconds = (Date.now() - attempt.createdAt.getTime()) / 1000;
  if (ageSeconds > settings.verificationTtlSeconds) {
    throw new AppError(428, "That identity check has expired — please verify again.");
  }

  // Conditional update doubles as the concurrency guard: if two submissions race for the same
  // verification, exactly one gets count 1 and the other is told to verify again.
  const claimed = await prisma.faceVerificationAttempt.updateMany({
    where: { id: attempt.id, consumedAt: null },
    data: { consumedAt: new Date(), timesheetId: params.timesheetId, ticketId: params.ticketId }
  });
  if (claimed.count === 0) {
    throw new AppError(428, "That identity check has already been used — please verify again.");
  }
  return attempt.id;
}

/** Binds a just-consumed verification to the record it protected, for gates that run BEFORE the
 *  record exists. Best-effort by design: the identity check already succeeded and the record is
 *  already committed — failing the user's submission over evidence bookkeeping would be
 *  backwards. Without this, the verified badge could never join attempt → row. */
export async function bindVerificationToRecord(attemptId: string, record: { timesheetId?: string; ticketId?: string }): Promise<void> {
  await prisma.faceVerificationAttempt
    .updateMany({ where: { id: attemptId }, data: record })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Challenge–response liveness (anti-injection)
// ---------------------------------------------------------------------------------------------
//
// THE ATTACK THIS EXISTS FOR: a virtual camera (OBS et al.) replaying a recorded video of the
// real employee. Every frame of that video is a genuine, live-looking face — antispoof and
// liveness pass honestly, because they judge the FRAME, not the moment. What a replay cannot do
// is perform a head movement the server only chose AFTER the recording existed. So: the server
// issues a random instruction with a 90-second, single-use lifetime; the client submits a
// neutral frame plus a frame performing it; and the server measures the actual head-pose change
// between the two.
//
// WHY the check is axis-based (|delta| on the demanded axis, and that axis must dominate)
// rather than sign-based ("left" vs "right"): Human's yaw sign convention interacts with
// mirrored preview UX and hasn't been calibrated against real cameras — a wrong guess about
// sign would fail every honest user, which bricks the feature. Axis + magnitude + dominance
// already defeats a static replay; the measured deltas are persisted on every attempt
// (challengeYawDelta/challengePitchDelta) precisely so sign enforcement can be turned on later
// from real evidence instead of an assumption.

export type ChallengeInstruction = "TURN_LEFT" | "TURN_RIGHT" | "LOOK_UP";

const CHALLENGE_INSTRUCTIONS: readonly ChallengeInstruction[] = ["TURN_LEFT", "TURN_RIGHT", "LOOK_UP"];

export const CHALLENGE_TTL_SECONDS = 90;

/** Minimum |rotation delta| in radians between the two frames. Yaw ≈20° — an unmistakable turn
 *  that's still comfortable; pitch's bar is lower (≈13°) because necks physically pitch less
 *  than they yaw. */
const CHALLENGE_YAW_MIN = 0.35;
const CHALLENGE_PITCH_MIN = 0.22;

export async function issueChallenge(userId: string, context: FaceContext): Promise<{ id: string; instruction: ChallengeInstruction; expiresInSeconds: number }> {
  // crypto.randomInt, not Math.random — this is a security nonce's unpredictability, small
  // option space or not.
  const instruction = CHALLENGE_INSTRUCTIONS[crypto.randomInt(CHALLENGE_INSTRUCTIONS.length)];
  const challenge = await prisma.faceChallenge.create({
    data: { userId, context, instruction, expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000) }
  });
  return { id: challenge.id, instruction, expiresInSeconds: CHALLENGE_TTL_SECONDS };
}

/**
 * Redeems a challenge — single-use, owner-bound, context-bound, unexpired. Returns the
 * instruction to enforce, or null when any of that fails (the caller records CHALLENGE_FAILED).
 * The conditional updateMany is the same race guard consumeVerification uses: two concurrent
 * verifies presenting the same challenge can't both redeem it.
 */
export async function redeemChallenge(params: {
  challengeId: string | null | undefined;
  userId: string;
  context: FaceContext;
}): Promise<ChallengeInstruction | null>;
export async function redeemChallenge(params: {
  challengeId: string | null | undefined;
  userId: string;
  context: FaceContext;
  withIssuedAt: true;
}): Promise<{ instruction: ChallengeInstruction; issuedAt: Date } | null>;
export async function redeemChallenge(params: {
  challengeId: string | null | undefined;
  userId: string;
  context: FaceContext;
  withIssuedAt?: boolean;
}): Promise<ChallengeInstruction | { instruction: ChallengeInstruction; issuedAt: Date } | null> {
  if (!params.challengeId) return null;
  const claimed = await prisma.faceChallenge.updateMany({
    where: {
      id: params.challengeId,
      userId: params.userId,
      context: params.context,
      usedAt: null,
      expiresAt: { gt: new Date() }
    },
    data: { usedAt: new Date() }
  });
  if (claimed.count === 0) return null;
  const row = await prisma.faceChallenge.findUnique({ where: { id: params.challengeId } });
  if (!row) return null;
  const instruction = row.instruction as ChallengeInstruction;
  // The issuedAt overload exists for provenance: "was this frame captured before the challenge
  // it claims to answer?" is only answerable against the challenge's own creation time.
  return params.withIssuedAt ? { instruction, issuedAt: row.createdAt } : instruction;
}

export interface ChallengePoseResult {
  ok: boolean;
  yawDelta: number;
  pitchDelta: number;
}

/** Pure function — measures whether the gesture frame actually performed the instruction
 *  relative to the neutral frame. See the section comment for why axis+dominance, not sign. */
export function verifyChallengePose(instruction: ChallengeInstruction, neutral: FaceAnalysis, gesture: FaceAnalysis): ChallengePoseResult {
  const yawDelta = Math.abs(gesture.yaw - neutral.yaw);
  const pitchDelta = Math.abs(gesture.pitch - neutral.pitch);
  const ok =
    instruction === "LOOK_UP"
      ? pitchDelta >= CHALLENGE_PITCH_MIN && pitchDelta >= yawDelta
      : yawDelta >= CHALLENGE_YAW_MIN && yawDelta >= pitchDelta;
  return { ok, yawDelta, pitchDelta };
}

// ---------------------------------------------------------------------------------------------
// Capture provenance (Phase C — injection-attack detection)
// ---------------------------------------------------------------------------------------------
//
// The challenge proves a movement was performed on demand. Provenance asks a different question:
// does the TIMING evidence agree that these frames were produced by a live camera answering THIS
// challenge? A replayed recording is, by definition, footage that existed before the challenge
// was issued — so a capture claiming to predate its own challenge, or frames spaced impossibly,
// is evidence of injection in a way no single frame can be.
//
// Every finding here is a REVIEW SIGNAL, never a rejection. Client clocks on real machines are
// genuinely wrong (VMs resuming from sleep, unsynced laptops, deliberately skewed dev boxes), and
// blocking on clock skew would lock out honest users to catch an attacker who can simply set their
// clock correctly. Recorded, surfaced, escalated — not enforced. The same posture as the
// virtual-camera heuristic, for the same reason.

export interface ProvenanceInput {
  /** Client clock (epoch ms) when the neutral frame was captured. */
  neutralCapturedAt?: number | null;
  /** Client clock (epoch ms) when the gesture frame was captured, when the challenge ran. */
  gestureCapturedAt?: number | null;
  /** When the server issued the challenge, if one was redeemed. */
  challengeIssuedAt?: Date | null;
  /** Server receipt time, to bound clock skew. */
  receivedAt: Date;
}

export interface ProvenanceVerdict {
  captureLagMs: number | null;
  frameIntervalMs: number | null;
  suspect: boolean;
  note: string | null;
}

/** Tolerance for ordinary client clock error before "captured before its challenge" is claimed. */
const CLOCK_SKEW_TOLERANCE_MS = 120_000;

export function assessProvenance(input: ProvenanceInput): ProvenanceVerdict {
  const { neutralCapturedAt, gestureCapturedAt, challengeIssuedAt, receivedAt } = input;

  const captureLagMs =
    neutralCapturedAt != null && challengeIssuedAt
      ? Math.round(neutralCapturedAt - challengeIssuedAt.getTime())
      : null;
  const frameIntervalMs =
    neutralCapturedAt != null && gestureCapturedAt != null ? Math.round(gestureCapturedAt - neutralCapturedAt) : null;

  const reasons: string[] = [];

  // Frames must be ordered. Reversed frames mean the "gesture" was recorded first, which no live
  // capture sequence can produce.
  if (frameIntervalMs != null && frameIntervalMs < 0) reasons.push("gesture frame timestamped before the neutral frame");

  // The challenge flow deliberately waits ~3s before grabbing the gesture frame, so an interval
  // far below that didn't come from the real UI.
  if (frameIntervalMs != null && frameIntervalMs >= 0 && frameIntervalMs < 500) {
    reasons.push(`frames only ${frameIntervalMs}ms apart — faster than the capture flow allows`);
  }

  // The one that actually catches replay: footage captured before the challenge existed.
  if (captureLagMs != null && captureLagMs < -CLOCK_SKEW_TOLERANCE_MS) {
    reasons.push(`capture timestamped ${Math.round(-captureLagMs / 1000)}s BEFORE its challenge was issued`);
  }

  // Gross clock disagreement — not proof of anything, but it means every other timing signal here
  // is untrustworthy, and saying so is more honest than silently trusting it.
  if (neutralCapturedAt != null) {
    const skew = Math.abs(neutralCapturedAt - receivedAt.getTime());
    if (skew > 10 * 60 * 1000) reasons.push(`client clock is ${Math.round(skew / 60000)} minutes out of step with the server`);
  }

  return {
    captureLagMs,
    frameIntervalMs,
    suspect: reasons.length > 0,
    note: reasons.length > 0 ? reasons.join("; ").slice(0, 200) : null
  };
}

/** Human-readable instruction text, shared by the API response so every client says exactly
 *  what the server will enforce. */
export const CHALLENGE_PROMPTS: Record<ChallengeInstruction, string> = {
  TURN_LEFT: "Slowly turn your head to one side",
  TURN_RIGHT: "Slowly turn your head to one side",
  LOOK_UP: "Slowly tilt your head up"
};

/**
 * Boot-time model warm-up — the server half of making verification feel Face-ID instant.
 * Model loading is deliberately lazy (most deployments never enable the feature, and the
 * models hold ~500MB per process), so WITHOUT this the first real verification after every
 * restart pays the multi-second cold load. This threads the needle: it checks each org's
 * settings at boot and loads the models exactly once IF any org actually has the feature on —
 * deployments that never use face still pay nothing. Called detached from server.ts.
 */
export async function warmFaceModelsIfEnabled(runForEveryOrg: (label: string, fn: () => Promise<void>) => Promise<void>): Promise<void> {
  let anyEnabled = false;
  await runForEveryOrg("face-warmup", async () => {
    if (anyEnabled) return;
    const settings = await prisma.globalFaceVerificationSettings.findUnique({ where: { id: FACE_GLOBAL_ID } });
    if (settings?.enabled) anyEnabled = true;
  });
  if (!anyEnabled) return;

  const startedAt = Date.now();
  await getHuman();
  console.log(`[face] models warmed at boot in ${Date.now() - startedAt} ms — first verification won't pay the cold load`);
}

// ---------------------------------------------------------------------------------------------
// Coverage + lifecycle notifications
// ---------------------------------------------------------------------------------------------

/** Users the current policy covers who have NOT enrolled — the population every enrollment
 *  notification targets. Empty when the feature is off, no action demands a check, or the plan
 *  entitlement is gone (no nagging about a feature the org can't use). */
export async function findCoveredUnenrolledUserIds(): Promise<string[]> {
  const settings = await getFaceSettings();
  if (!settings.enabled) return [];
  if (!settings.requireForTimesheet && !settings.requireForTicket && !settings.requireForApproval) return [];
  if (!(await isFaceFeatureAllowedForOrg())) return [];

  const users = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      faceEnrollment: null,
      ...(settings.enforcementMode === "ALL" ? {} : { faceVerificationRequired: true })
    },
    select: { id: true }
  });
  return users.map((u) => u.id);
}

/**
 * Tells users the policy now covers them BEFORE a blocked submission does. Without this, the
 * first a person hears of an admin flagging them is a refused timesheet at 6pm on a Friday —
 * which converts a security control into a support ticket, every single time.
 *
 * Deduped per-user via the Notification table (72h window across BOTH enrollment categories),
 * so the admin toggling settings back and forth, the user-management flag, and the daily
 * reminder worker can all call this without spamming anyone.
 */
export async function notifyEnrollmentRequired(
  userIds: string[],
  category: "face.enrollment_required" | "face.enrollment_reminder" = "face.enrollment_required"
): Promise<number> {
  if (userIds.length === 0) return 0;
  const dedupeSince = new Date(Date.now() - 72 * 60 * 60 * 1000);
  let sent = 0;

  for (const userId of userIds) {
    const recent = await prisma.notification.findFirst({
      where: {
        userId,
        category: { in: ["face.enrollment_required", "face.enrollment_reminder"] },
        createdAt: { gte: dedupeSince }
      },
      select: { id: true }
    });
    if (recent) continue;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    if (!user) continue;

    await dispatchNotification({
      userId,
      category,
      title: "Set up face verification",
      body:
        category === "face.enrollment_required"
          ? "Your workspace now requires an identity check for some of your actions. Enroll your face in your profile so your next submission isn't held up."
          : "Reminder: face verification is required for some of your actions and you haven't enrolled yet. It takes under a minute in your profile.",
      link: "/app/profile",
      email: {
        templateKey: "face.enrollment_required",
        vars: { name: user.name },
        fallback: {
          subject: "Action needed: set up face verification",
          html: templates.faceEnrollmentRequired({ name: user.name, reminder: category === "face.enrollment_reminder" })
        }
      }
    });
    sent++;
  }
  return sent;
}

// ---------------------------------------------------------------------------------------------
// Policy copilot — threshold recommendation (Phase D)
// ---------------------------------------------------------------------------------------------

export interface ThresholdRecommendation {
  currentThreshold: number;
  recommendedThreshold: number | null;
  /** Non-match rate at the current threshold, and what it would become if adopted. */
  currentRejectRatePct: number | null;
  projectedRejectRatePct: number | null;
  /** Genuine-pass and rejected clusters, so an admin can see the separation for themselves. */
  passedMedian: number | null;
  rejectedMedian: number | null;
  /** How much clear air sits between the two clusters. Small or negative = overlapping, and no
   *  threshold choice can separate them; that's a model/enrollment problem, not a tuning one. */
  separation: number | null;
  sampleSize: number;
  /** Plain-language finding — deterministic, so this is useful with AI switched off entirely. */
  summary: string;
}

/**
 * Recommends a match threshold from THIS workspace's own similarity distribution.
 *
 * Deliberately ARITHMETIC, not an LLM judgement: picking a threshold is a statistics problem, and
 * a model's opinion about it would be less reliable, less reproducible, and less auditable than
 * the calculation. The optional AI layer (see ai.service.ts#explainThresholdRecommendation) only
 * narrates the number this function already computed.
 *
 * Method: find the widest gap between the top of the rejected cluster and the bottom of the
 * genuine-pass cluster, and aim just inside the passing side of it. Refuses to recommend when the
 * clusters overlap, because in that case no threshold separates them and moving the number just
 * trades false rejections for false accepts.
 */
export async function recommendMatchThreshold(): Promise<ThresholdRecommendation> {
  const settings = await getFaceSettings();
  const attempts = await prisma.faceVerificationAttempt.findMany({
    where: { outcome: { in: ["PASSED", "NO_MATCH"] }, similarity: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 2000,
    select: { outcome: true, similarity: true }
  });

  const passed = attempts.filter((a) => a.outcome === "PASSED").map((a) => a.similarity!).sort((x, y) => x - y);
  const rejected = attempts.filter((a) => a.outcome === "NO_MATCH").map((a) => a.similarity!).sort((x, y) => x - y);
  const median = (xs: number[]) => (xs.length === 0 ? null : xs[Math.floor(xs.length / 2)]);
  const pct = (n: number, d: number) => (d === 0 ? null : Number(((n / d) * 100).toFixed(1)));

  const base: ThresholdRecommendation = {
    currentThreshold: settings.matchThreshold,
    recommendedThreshold: null,
    currentRejectRatePct: pct(rejected.length, attempts.length),
    projectedRejectRatePct: null,
    passedMedian: median(passed),
    rejectedMedian: median(rejected),
    separation: null,
    sampleSize: attempts.length,
    summary: ""
  };

  // 30 judged checks is the floor for saying anything; below that this is noise dressed as advice.
  if (attempts.length < 30 || passed.length < 10) {
    return { ...base, summary: `Only ${attempts.length} judged checks so far — not enough to recommend a change. Come back after about 30.` };
  }

  // 5th percentile of genuine passes: the weakest capture we currently accept.
  const p5Passed = passed[Math.floor(passed.length * 0.05)];
  // 95th percentile of rejections: the strongest near-miss we currently refuse.
  const p95Rejected = rejected.length > 0 ? rejected[Math.floor(rejected.length * 0.95)] : 0;
  const separation = Number((p5Passed - p95Rejected).toFixed(3));

  if (separation <= 0.01) {
    return {
      ...base,
      separation,
      summary:
        `The passing and rejected scores OVERLAP (weakest accepted ${p5Passed.toFixed(3)}, strongest rejected ` +
        `${p95Rejected.toFixed(3)}). No threshold separates them, so moving it only trades false rejections for ` +
        `false accepts. Look at enrollment quality instead — re-enrolling the people who fail most often is the fix.`
    };
  }

  // Aim just inside the passing side of the gap, and never below the current setting by accident:
  // a recommendation to LOOSEN is legitimate, but it must be stated as such, not slipped in.
  const midpoint = Number((p95Rejected + separation * 0.5).toFixed(2));
  const projectedRejects = passed.filter((s) => s < midpoint).length + rejected.length;
  const direction = midpoint > settings.matchThreshold ? "tighter" : midpoint < settings.matchThreshold ? "looser" : "unchanged";

  return {
    ...base,
    recommendedThreshold: midpoint,
    separation,
    projectedRejectRatePct: pct(projectedRejects, attempts.length),
    summary:
      direction === "unchanged"
        ? `${settings.matchThreshold} already sits in the gap between your rejected and passing clusters (${separation.toFixed(3)} wide). No change needed.`
        : `Your clusters are cleanly separated by ${separation.toFixed(3)}. ${midpoint} sits in the middle of that gap — ` +
          `${direction} than the current ${settings.matchThreshold}. Based on ${attempts.length} judged checks.`
  };
}

// ---------------------------------------------------------------------------------------------
// Auto-triage of honest failures (Phase D)
// ---------------------------------------------------------------------------------------------

/**
 * Clears review flags whose evidence says "honest failure" rather than "identity signal", so the
 * queue stays small enough that a human still reads it. A flag nobody reads is not a control.
 *
 * The safety rules are the whole design:
 *  - opt-in per workspace (autoTriageHonestFailures, default off);
 *  - NEVER touches an attempt carrying an injection signal (virtual camera, bad provenance) or a
 *    spoof suspicion — those are precisely the ones a person must see;
 *  - only closes quality/visibility failures, never NO_MATCH, which is the genuine
 *    "we couldn't confirm it's you" signal;
 *  - records autoResolvedReason so the audit trail never confuses this with a human review.
 */
export async function autoTriageHonestFailures(): Promise<{ resolved: number }> {
  const settings = await getFaceSettings();
  if (!settings.autoTriageHonestFailures) return { resolved: 0 };

  const candidates = await prisma.faceVerificationAttempt.findMany({
    where: {
      flaggedForReview: true,
      reviewedAt: null,
      virtualCameraSuspected: false,
      provenanceSuspect: false,
      // Only visibility problems. NO_MATCH and SPOOF_SUSPECTED are deliberately absent.
      outcome: { in: ["NO_FACE", "MULTIPLE_FACES", "LOW_QUALITY", "CHALLENGE_FAILED"] },
      createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) }
    },
    select: { id: true, userId: true, outcome: true, createdAt: true },
    take: 200
  });
  if (candidates.length === 0) return { resolved: 0 };

  let resolved = 0;
  for (const attempt of candidates) {
    // The deciding evidence: did this person go on to verify successfully soon afterwards? If so
    // the failure was a bad frame, not an impostor — an impostor doesn't then pass.
    const laterPass = await prisma.faceVerificationAttempt.findFirst({
      where: { userId: attempt.userId, outcome: "PASSED", createdAt: { gt: attempt.createdAt, lt: new Date(attempt.createdAt.getTime() + 60 * 60 * 1000) } },
      select: { id: true }
    });
    if (!laterPass) continue;

    await prisma.faceVerificationAttempt.update({
      where: { id: attempt.id },
      data: {
        flaggedForReview: false,
        autoResolvedReason: `Auto-resolved: ${attempt.outcome.replaceAll("_", " ").toLowerCase()}, and the same user verified successfully within the hour — a capture problem, not an identity one.`
      }
    });
    resolved++;
  }
  return { resolved };
}

// ---------------------------------------------------------------------------------------------
// Verified-badge decoration
// ---------------------------------------------------------------------------------------------

export interface VerificationBadge {
  /** A consumed, PASSED verification is bound to this row. */
  identityVerified: boolean;
  identityVerifiedAt: Date | null;
  /** Whether the policy WOULD demand a check from this row's author right now — lets the UI
   *  mark covered-but-unverified rows (submitted before the policy, or through a gap) instead
   *  of leaving the absence of a badge ambiguous. */
  identityVerificationApplies: boolean;
}

/**
 * Batch decoration for timesheet lists: which rows carry a spent PASSED verification, and whose
 * authors the policy currently covers. One settings read + two batched queries regardless of
 * page size — this runs on every history/approvals list, so per-row isFaceVerificationRequired
 * calls (each hitting the control plane) would be an N+1 against a different database.
 */
export async function getTimesheetVerificationBadges(
  rows: Array<{ id: string; userId: string }>
): Promise<Map<string, VerificationBadge>> {
  const result = new Map<string, VerificationBadge>();
  if (rows.length === 0) return result;

  const attempts = await prisma.faceVerificationAttempt.findMany({
    where: { timesheetId: { in: rows.map((r) => r.id) }, outcome: "PASSED", consumedAt: { not: null }, context: "TIMESHEET" },
    select: { timesheetId: true, createdAt: true },
    orderBy: { createdAt: "desc" }
  });
  const verifiedAt = new Map<string, Date>();
  for (const attempt of attempts) {
    if (attempt.timesheetId && !verifiedAt.has(attempt.timesheetId)) verifiedAt.set(attempt.timesheetId, attempt.createdAt);
  }

  const settings = await getFaceSettings();
  let coveredUsers: Set<string> | "all" | "none" = "none";
  if (settings.enabled && settings.requireForTimesheet && (await isFaceFeatureAllowedForOrg())) {
    if (settings.enforcementMode === "ALL") {
      coveredUsers = "all";
    } else {
      const flagged = await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.userId))] }, faceVerificationRequired: true },
        select: { id: true }
      });
      coveredUsers = new Set(flagged.map((u) => u.id));
    }
  }

  for (const row of rows) {
    const at = verifiedAt.get(row.id) ?? null;
    let applies = false;
    if (coveredUsers === "all") applies = true;
    else if (coveredUsers !== "none") applies = coveredUsers.has(row.userId);
    result.set(row.id, { identityVerified: at !== null, identityVerifiedAt: at, identityVerificationApplies: applies });
  }
  return result;
}
