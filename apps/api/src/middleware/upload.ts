/**
 * WHAT: multer configuration for the two upload paths in this app — general ticket/timesheet
 * attachments (`upload`, disk storage) and profile avatars (`avatarUpload`, memory storage so
 * utils/image.ts can re-encode before writing to disk).
 * WHY: file uploads are one of the highest-risk inputs an app accepts — an extension/MIME
 * allow-list here is the first of several layers (see the inline comment on
 * `allowedAttachmentExtensions` for why `.html`/`.js`/`.svg` are excluded, and app.ts's
 * `/uploads` static handler for the `Content-Disposition: attachment` defense-in-depth layer).
 * HOW: exports two configured multer instances plus the shared `allowedAttachmentExtensions`
 * set (also reused by email-intake.service.ts and chat-intake.service.ts when saving
 * inbound attachments from external sources).
 * WHO calls this: any controller route accepting a file (ticket/timesheet attachments,
 * `auth.controller.ts`'s avatar upload), plus the email/chat intake pipelines for attachments.
 */
import crypto from "node:crypto";
import path from "node:path";
import multer from "multer";
import type { RequestHandler } from "express";
import { tenantContext } from "../config/tenant-context.js";
import { ensureStorageDirectories, stagingDir } from "../config/storage-paths.js";
import { AppError } from "./error.js";

/**
 * `.html`, `.js`, and `.svg` are deliberately excluded even though they're common source-code
 * extensions: all three can carry an executable `<script>` payload, and a ticket/timesheet
 * attachment has no legitimate need to be one of them. `/uploads` also serves everything with
 * `Content-Disposition: attachment` (see app.ts) as defense-in-depth on top of this allow-list.
 */
export const allowedAttachmentExtensions = new Set([
  // `.webp` is accepted because services/attachment-storage.service.ts converts every uploaded
  // image to it — without this, re-uploading a file the app itself produced would be rejected.
  ".webp",
  ".pdf", ".xls", ".xlsx", ".csv", ".jpg", ".jpeg", ".gif", ".png", ".zip", ".txt",
  ".py", ".css", ".jsx", ".ts", ".tsx", ".json", ".xml", ".yaml", ".yml",
  ".java", ".cs", ".cpp", ".c", ".h", ".php", ".rb", ".go", ".rs", ".sql", ".md", ".doc", ".docx"
]);

const allowedImageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif"]);
const allowedImageMimes = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif"]);

// Root + documents + avatars, wherever config/storage-paths.ts resolved them to. Non-throwing:
// a NAS mount that isn't up yet must not stop the API from booting — the write itself still
// fails loudly, and Workspace Settings → Storage & logs shows the directory in red.
for (const failure of ensureStorageDirectories()) {
  console.warn(`[storage] could not create ${failure} — uploads to it will fail until this is fixed.`);
}

/**
 * The raw bytes land in the STAGING tree, not the documents tree.
 *
 * Two reasons, and the first is a security fix: `/uploads` used to serve the documents directory
 * with no authentication, so a temp file written here was publicly readable for as long as it
 * existed. Staging is on the non-public list (config/storage-paths.ts#isInsideNonPublicSubtree),
 * so it can never be named through `/uploads` at all. The second is that the final location
 * depends on the uploader's org, and multer's `destination` callback runs on a stream event where
 * the tenant AsyncLocalStorage store is not reliably present (see `preserveTenantContext` below
 * for the same hazard in its worse form) — so the org-scoped write is
 * attachment-storage.service.ts's job, which always runs back inside the request's context.
 *
 * The name is a random UUID and NOT derived from the user's filename or the clock.
 * `${Date.now()}-${originalName}` was a guess away from readable: anyone who knew what someone
 * had attached could enumerate a second's worth of millisecond values and find it.
 */
const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, stagingDir()),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});

export const upload = multer({
  storage: attachmentStorage,
  limits: { fileSize: 25 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedAttachmentExtensions.has(ext)) return cb(new AppError(422, `Unsupported file type: ${ext}`));
    cb(null, true);
  }
});

/**
 * Avatars use memory storage so we can re-encode through `sharp` before persisting.
 *
 * Re-encoding gives us three security wins on top of the MIME/extension allow-list:
 *  1. EXIF + ICC profile + XMP metadata are stripped (location, device, owner identity).
 *  2. Polyglot images (a file that's both valid PNG and valid JS/HTML) are normalized
 *     to a clean PNG/JPEG re-render, breaking the secondary payload.
 *  3. Server-side size cap prevents an attacker uploading a 5 MB 50k×50k bomb.
 */
export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedImageExtensions.has(ext) || !allowedImageMimes.has(file.mimetype)) {
      return cb(new AppError(422, "Avatar must be a PNG, JPG, JPEG, or GIF image"));
    }
    cb(null, true);
  }
});

const allowedImportExtensions = new Set([".pdf", ".docx", ".txt", ".md"]);

/**
 * Requirements Studio's optional "import an existing PRD/BRD" upload (requirements-doc.controller.ts).
 * Memory storage so the buffer can be read in-process (requirements-doc-import.service.ts) and,
 * once the import is confirmed, written to this org's documents directory by
 * requirements-doc-viewer.service.ts — the original is kept now so the in-app preview can show the
 * real document rather than only the text extracted from it. Narrower extension set than
 * allowedAttachmentExtensions on purpose: no good pure-JS parser exists for legacy binary .doc.
 * `.md` is here because the preview renders markdown properly — a spec written in markdown is a
 * very natural thing to upload, and accepting it in the viewer but not the picker was incoherent.
 */
export const requirementsImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedImportExtensions.has(ext)) {
      return cb(new AppError(422, `Unsupported file type: ${ext}. Upload a PDF, Word (.docx), Markdown (.md) or plain text file.`));
    }
    cb(null, true);
  }
});

/**
 * Webcam captures for face (identity) verification — memory storage, because the buffer goes
 * straight into `face.service.ts#analyzeFace` and is only written to disk (re-encoded, in a
 * non-public directory) if the settings say to retain it.
 *
 * Tighter than `avatarUpload` on purpose: these frames are always produced by our own
 * `canvas.toBlob()` capture, never chosen from a file picker, so the accepted shape is narrow —
 * JPEG/PNG only (no GIF, which has no business being a camera still) and 4MB, which is
 * comfortably above a 640px JPEG while leaving no room for someone to POST a large payload at
 * an endpoint that runs ML inference on whatever it's given.
 */
const allowedCaptureExtensions = new Set([".png", ".jpg", ".jpeg"]);
const allowedCaptureMimes = new Set(["image/png", "image/jpeg", "image/jpg"]);

/**
 * Per-route frame ceilings, exported so the routes and the instance limit below cannot drift.
 *
 * WHY THEY LIVE HERE (a real, previously-shipping bug — do not inline these numbers again):
 * multer enforces `files` on the instance, while `.array(field, maxCount)` enforces its own count
 * per route, and the instance limit must be >= the largest route or the bigger flow dies with
 * LIMIT_FILE_COUNT — an unreadable 500 — instead of the route's own limit answering. Enrollment's
 * route allowed 8 while this instance allowed 5, so a 6-to-8-frame enrollment could only ever
 * fail. One source for both ends that.
 */
export const FACE_ENROLL_MAX_FRAMES = 8;
export const FACE_VERIFY_MAX_FRAMES = 2;

export const faceCaptureUpload = multer({
  storage: multer.memoryStorage(),
  // The guided wizard sends one frame per head position (four today) and the challenge–response
  // verify sends 2 ([neutral, gesture]); the enrollment ceiling leaves room for another pose
  // without a second mismatch. Each route still caps its own maxCount — this only has to clear
  // the largest of them.
  limits: { fileSize: 4 * 1024 * 1024, files: Math.max(FACE_ENROLL_MAX_FRAMES, FACE_VERIFY_MAX_FRAMES) },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // The browser's canvas.toBlob() gives us a real filename+mime; a missing extension is fine
    // as long as the MIME is right (some clients send "blob" with no extension).
    const extOk = ext === "" || allowedCaptureExtensions.has(ext);
    if (!extOk || !allowedCaptureMimes.has(file.mimetype)) {
      return cb(new AppError(422, "Face capture must be a PNG or JPEG image"));
    }
    cb(null, true);
  }
});

/**
 * Wraps a multer middleware so the tenant AsyncLocalStorage context survives it.
 *
 * WHY THIS IS NECESSARY (a real, previously-shipping bug — do not remove):
 * `middleware/tenant.ts` establishes the tenant via `tenantContext.run(ctx, () => next())`, and
 * everything downstream reads `prisma` through that store. Multer parses the body off the
 * request STREAM, and Node only propagates an AsyncLocalStorage store into callbacks scheduled
 * from inside the context — a stream event emitted from the socket's own I/O context is not
 * one. So multer's `done()` (and therefore every handler after it) can run with the store
 * MISSING, and the first `prisma.*` access throws "No tenant context is active".
 *
 * The failure is SIZE-DEPENDENT, which is what made it so easy to miss: a small upload is
 * already buffered when multer attaches, finishes in the current tick, and keeps the context;
 * a larger one needs additional socket reads and loses it. Measured on this codebase: a 31KB
 * avatar succeeded while an 876KB avatar returned HTTP 500 — i.e. every real photo from a
 * phone camera was failing, on a route whose own limit allows 5MB (and 25MB for ticket
 * attachments).
 *
 * The fix is to capture the store before multer runs and re-enter it for the rest of the
 * chain. Applied to every multer route, not just the face ones, because they all shared this.
 */
export function preserveTenantContext(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const store = tenantContext.getStore();
    handler(req, res, (err?: unknown) => {
      // No store to begin with (a route mounted before tenant resolution, e.g. the SCIM/webhook
      // surfaces) — nothing to restore, behave exactly as before.
      if (!store) return next(err as Error | undefined);
      tenantContext.run(store, () => next(err as Error | undefined));
    });
  };
}
