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
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";

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
  | "NOT_ENROLLED"
  | "ERROR";

export interface FaceAnalysis {
  embedding: number[];
  /** Human's antispoof score — higher means "looks like a real face, not a printout/screen". */
  antispoofReal: number;
  /** Human's liveness score — higher means "a live person was in front of the lens". */
  livenessScore: number;
  faceCount: number;
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

    if (faces.length === 0) return { embedding: [], antispoofReal: 0, livenessScore: 0, faceCount: 0 };

    // Largest face wins when several are present — the subject is the one closest to the lens.
    // `faceCount` is still reported so the caller can reject a multi-person frame outright
    // (someone standing behind the real employee is exactly the scenario worth refusing).
    const primary = faces.reduce((biggest: any, candidate: any) => {
      const area = (b: any) => (b.box?.[2] ?? 0) * (b.box?.[3] ?? 0);
      return area(candidate) > area(biggest) ? candidate : biggest;
    }, faces[0]);

    return {
      embedding: Array.from(primary.embedding as number[]),
      antispoofReal: typeof primary.real === "number" ? primary.real : 0,
      livenessScore: typeof primary.live === "number" ? primary.live : 0,
      faceCount: faces.length
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
  "when I submit timesheets or tickets. I understand a mathematical representation (template) of " +
  "my face will be stored securely for this purpose, that captured images are retained only for " +
  "the period shown above, and that I may withdraw this consent at any time — which permanently " +
  "deletes my stored face data.";

/** Face images NEVER go under the public `/uploads` static mount: app.ts serves that with no
 *  authentication at all, so anyone who guesses a filename could read them cross-tenant. They
 *  live in a separate tree served only by an authenticated API route. */
export function faceStorageDir(): string {
  return path.join(env.UPLOAD_DIR, "face");
}

export async function storeFaceImage(userId: string, kind: "reference" | "attempt", buffer: Buffer): Promise<string> {
  const dir = path.join(faceStorageDir(), userId);
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
// Enforcement
// ---------------------------------------------------------------------------------------------

export type FaceContext = "TIMESHEET" | "TICKET";

/**
 * Whether THIS user must pass a face check for THIS action right now. Read live on every
 * relevant request (never cached) for the same reason plan-tier limits are: an admin turning the
 * requirement on or off should take effect on the very next submission, not next login.
 */
export async function isFaceVerificationRequired(userId: string, context: FaceContext): Promise<boolean> {
  const settings = await getFaceSettings();
  if (!settings.enabled) return false;
  if (context === "TIMESHEET" && !settings.requireForTimesheet) return false;
  if (context === "TICKET" && !settings.requireForTicket) return false;
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
 */
export async function consumeVerification(params: {
  verificationId: string | undefined | null;
  userId: string;
  context: FaceContext;
  timesheetId?: string;
  ticketId?: string;
}): Promise<void> {
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
}
