/**
 * WHAT: the single place the API decides WHERE on disk a file goes. Resolves one configurable
 * storage ROOT into three segregated subtrees — documents (ticket/timesheet attachments and
 * email-intake attachments), avatars, and face (biometric) imagery — plus the containment and
 * writability primitives every consumer and the admin UI share.
 *
 * WHY IT EXISTS: `env.UPLOAD_DIR` defaults to the RELATIVE path "uploads", so on a normal
 * checkout every uploaded file lives INSIDE the repo working tree, where a `git checkout`,
 * `git clean` or a redeploy that replaces the directory destroys it. Moving storage onto its own
 * volume needs one resolved answer that six call sites agree on, not six `path.join(env.UPLOAD_DIR, …)`
 * expressions that can drift apart.
 *
 * ── BACKWARD COMPATIBILITY IS THE DESIGN CONSTRAINT ─────────────────────────────────────────
 *
 * Existing installs have files on disk AND rows in the database whose `url` column points at
 * them (`/uploads/<name>`, `/uploads/avatars/<name>`). So the defaults here reproduce today's
 * layout byte for byte:
 *
 *   root      = STORAGE_ROOT        or  UPLOAD_DIR          (default "uploads", relative — unchanged)
 *   documents = STORAGE_DOCUMENTS_DIR or  <root>            ← the tree, not the file location; see below
 *   avatars   = STORAGE_AVATARS_DIR   or  <root>/avatars
 *   face      = STORAGE_FACE_DIR      or  <root>/face
 *   staging   =                           <root>/incoming   ← multer's landing zone, never served
 *
 * ── WHY DOCUMENTS ARE NOW NESTED UNDER AN ORG ID ────────────────────────────────────────────
 *
 * NEW attachments are written to `<documents>/<orgId>/<name>`; everything already on disk stays
 * exactly where it is, flat in `<documents>`. A read accepts BOTH shapes (see
 * services/attachment-storage.service.ts#resolveStoredFile), so no file is moved, renamed or
 * deleted by this change and every `url`/`storageKey` row already in a tenant database keeps
 * resolving. The org segment is what makes "this file belongs to that tenant" a property of the
 * path rather than a property of the row that happened to reference it — app.ts cross-checks it
 * against the org the request's signed grant was minted for.
 *
 * A deployment that sets none of the new variables resolves to precisely the paths it already
 * uses. Setting only STORAGE_ROOT moves all three subtrees together, keeping their relative
 * shape — which is what "put uploads on D:\" actually means.
 *
 * Relocating NEVER orphans reads: `documentReadDirs()` returns the configured documents
 * directory FOLLOWED BY the legacy root whenever they differ, so files written before the move
 * still resolve. Nothing is ever moved or deleted on our behalf — copying the old tree across is
 * an operator decision with an operator's backup behind it.
 *
 * ── WHY `face` IS NOT JUST ANOTHER SUBTREE ──────────────────────────────────────────────────
 *
 * `/uploads` is served by an UNAUTHENTICATED express.static mount rooted at the documents
 * directory, and the documents directory defaults to the root — which contains `face/`. That
 * means biometric imagery has been reachable at `/uploads/face/<orgId>/<userId>/<file>` by
 * anyone who can guess a filename, despite face.service.ts documenting the opposite.
 * `isInsideNonPublicSubtree()` exists to close that: app.ts refuses any `/uploads` request whose
 * resolved target lands inside the face tree, wherever the face tree is configured to be. The
 * staging tree joined it for the same reason: a half-written multer temp file is not something
 * `/uploads` should ever be able to name, even for the instant it exists.
 *
 * WHO calls this: middleware/upload.ts, services/attachment-storage.service.ts,
 * services/email-intake.service.ts, services/face.service.ts, controllers/auth.controller.ts,
 * app.ts (static mounts), controllers/settings.controller.ts (the admin diagnostics surface).
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

export interface DirectoryProbe {
  /** Absolute, fully resolved — this is the path an admin should see, not the raw env value. */
  path: string;
  exists: boolean;
  writable: boolean;
  /** Populated only when something is wrong; `null` is the healthy case. */
  problem: string | null;
}

export interface StorageLayout {
  root: DirectoryProbe;
  documents: DirectoryProbe;
  avatars: DirectoryProbe;
  face: DirectoryProbe;
  /** Legacy documents locations still consulted on read (empty unless documents were relocated). */
  documentFallbacks: string[];
  /** Which of the four are pinned by an env var vs. derived from the root. Drives the UI's
   *  "env-managed" badges and the copy-ready .env snippet. */
  configuredBy: Record<"root" | "documents" | "avatars" | "face", string | null>;
}

/**
 * Resolved once at module load, deliberately.
 *
 * These paths are PROCESS-WIDE, not per-tenant — one Node process, one filesystem. Re-resolving
 * per request would invite the idea that a tenant can change them, which is exactly the thing
 * this design refuses (see the header of controllers/settings.controller.ts's `/storage` route).
 */
const resolvedRoot = path.resolve(env.STORAGE_ROOT || env.UPLOAD_DIR);
const resolvedDocuments = env.STORAGE_DOCUMENTS_DIR ? path.resolve(env.STORAGE_DOCUMENTS_DIR) : resolvedRoot;
const resolvedAvatars = env.STORAGE_AVATARS_DIR ? path.resolve(env.STORAGE_AVATARS_DIR) : path.join(resolvedRoot, "avatars");
const resolvedFace = env.STORAGE_FACE_DIR ? path.resolve(env.STORAGE_FACE_DIR) : path.join(resolvedRoot, "face");
/**
 * Workspace logos. Not configurable and not on the diagnostics card: one small file per tenant,
 * written by a super admin and streamed back by `GET /api/branding/logo`. It lives OUTSIDE the
 * documents tree deliberately — those are served under the signed-grant gate, and a logo has to
 * render on the login page where no grant can exist.
 */
const resolvedBranding = path.join(resolvedRoot, "branding");
/**
 * Where multer lands a raw upload before services/attachment-storage.service.ts re-encodes it and
 * writes the real file under the uploader's org. Not configurable and not in `StorageLayout`: it
 * holds nothing for longer than one request, so an operator has no reason to point it elsewhere
 * or to see it on the diagnostics card.
 */
const resolvedStaging = path.join(resolvedRoot, "incoming");

export const storageRoot = (): string => resolvedRoot;
export const documentsDir = (): string => resolvedDocuments;
export const avatarsDir = (): string => resolvedAvatars;
export const faceDir = (): string => resolvedFace;
export const stagingDir = (): string => resolvedStaging;
export const brandingDir = (): string => resolvedBranding;

/**
 * Organization ids are control-plane UUIDs. Matching that exact shape (rather than "any path
 * segment") is what lets a read path tell an org segment apart from a legacy flat filename, and
 * it excludes the reserved siblings — `avatars`, `face`, `incoming` — by construction.
 */
const ORG_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isOrgSegment = (value: string): boolean => ORG_SEGMENT_RE.test(value);

/** Where a NEW document for `orgId` is written. Reads must still accept the flat legacy location —
 *  see resolveStoredFile. */
export const documentsDirForOrg = (orgId: string): string => path.join(resolvedDocuments, orgId);

/**
 * Where to LOOK for a document, in order. The configured directory first, then the pre-move root
 * if documents were relocated — a read path that only knows the new location turns every
 * historical attachment into a 404 the moment an operator sets STORAGE_DOCUMENTS_DIR.
 */
export function documentReadDirs(): string[] {
  return resolvedDocuments === resolvedRoot ? [resolvedDocuments] : [resolvedDocuments, resolvedRoot];
}

/**
 * Joins `requested` onto `baseDir` and returns the result ONLY if it stays inside `baseDir`.
 * `null` means "this escapes, refuse it" — never a normalised best guess, because a caller that
 * gets a path back will use it.
 *
 * Catches, in one check rather than a list of banned substrings: `..` climbs at any depth,
 * absolute paths that ignore the base entirely, a different Windows drive letter (path.relative
 * returns an ABSOLUTE path across drives, which is why the `isAbsolute` test is here and not
 * redundant), URL-encoded segments already decoded by the caller, and NUL truncation.
 */
export function resolveWithin(baseDir: string, requested: string): string | null {
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) return null;
  const base = path.resolve(baseDir);
  const target = path.resolve(base, requested);
  const relative = path.relative(base, target);
  // "" means target === base: a directory, never a file we should serve.
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

/**
 * True when `absolutePath` lands inside a subtree that must never be served by the public
 * `/uploads` mounts — biometric imagery, and the staging area where a raw upload sits for the
 * moment between multer writing it and the pipeline re-encoding it under the uploader's org.
 */
export function isInsideNonPublicSubtree(absolutePath: string): boolean {
  const target = path.resolve(absolutePath);
  // Branding joins the list not because logos are secret but because `/uploads` must not be a
  // second door to them: they have exactly one reader, `GET /api/branding/logo`, which is where
  // the tenant scoping lives. Two paths to one file is how the two drift.
  return [resolvedFace, resolvedStaging, resolvedBranding].some((dir) => {
    const relative = path.relative(path.resolve(dir), target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

/**
 * Validates a candidate directory the way the admin UI needs it validated: strictly, and with a
 * message that says what to fix.
 *
 * The writability check is a REAL write (create a probe file, delete it), not `fs.access(W_OK)`.
 * On Windows `access` consults the read-only attribute rather than the ACL and cheerfully
 * reports a directory writable that will throw EPERM on first use; on Linux it misses a
 * read-only mount. The whole point of validating before saving is that the path must not fail at
 * 3am, so the check has to be the same operation the app will actually perform.
 */
export function validateDirectory(candidate: unknown): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof candidate !== "string") return { ok: false, message: "Path must be text." };
  const value = candidate.trim();
  if (!value) return { ok: false, message: "Path is empty." };
  if (value.includes("\0")) return { ok: false, message: "Path contains a null byte." };
  if (!path.isAbsolute(value)) {
    return {
      ok: false,
      message: "Path must be absolute (e.g. C:\\TimeSphere_Uploads or /srv/timesphere/uploads). A relative path resolves against whatever directory the service happens to start in."
    };
  }
  if (value.split(/[\\/]+/).includes("..")) {
    return { ok: false, message: 'Path must not contain a ".." segment — write the destination out in full.' };
  }

  const resolved = path.resolve(value);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, message: `Directory does not exist: ${resolved}. Create it (and grant the service account write access) first.` };
  }
  if (!stat.isDirectory()) return { ok: false, message: `${resolved} exists but is not a directory.` };

  const probe = probeWritable(resolved);
  if (probe) return { ok: false, message: `Directory is not writable by the API process: ${resolved} (${probe}).` };
  return { ok: true, path: resolved };
}

/** Returns an error string if the directory can't be written to, or `null` if it can. */
function probeWritable(dir: string): string | null {
  const probeFile = path.join(dir, `.timesphere-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probeFile, "ok");
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? (error as Error).message;
  } finally {
    try {
      fs.rmSync(probeFile, { force: true });
    } catch {
      // A probe file we failed to remove is cosmetic; reporting it as a writability failure
      // would be worse than leaving a zero-byte file behind.
    }
  }
}

/** Non-throwing status for one directory — the shape the admin UI renders. */
export function probeDirectory(dir: string): DirectoryProbe {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    return { path: resolved, exists: false, writable: false, problem: "Directory does not exist yet — it is created on first write." };
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return { path: resolved, exists: true, writable: false, problem: "Exists but is not a directory." };
  }
  const failure = probeWritable(resolved);
  return { path: resolved, exists: true, writable: !failure, problem: failure ? `Not writable (${failure}).` : null };
}

/**
 * Creates the writable subtrees. Best-effort and non-throwing on purpose: a temporarily unavailable
 * NAS mount must not stop the API from booting and serving everything that isn't a file upload —
 * the individual write paths still fail loudly with their own errors, and the admin UI shows the
 * unwritable directory in red. Returns the failures so callers can surface them once at boot.
 */
export function ensureStorageDirectories(): string[] {
  const failures: string[] = [];
  for (const dir of [resolvedRoot, resolvedDocuments, resolvedAvatars, resolvedStaging, resolvedBranding]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      failures.push(`${dir}: ${(error as Error).message}`);
    }
  }
  // The face tree is created lazily by face.service.ts#storeFaceImage instead: the feature is off
  // by default, and pre-creating a directory named "face" on every install invites the question
  // of what biometric data is being collected when the answer is "none".
  return failures;
}

/** Everything the SUPER_ADMIN diagnostics card needs, probed live. */
export function describeStorageLayout(): StorageLayout {
  return {
    root: probeDirectory(resolvedRoot),
    documents: probeDirectory(resolvedDocuments),
    avatars: probeDirectory(resolvedAvatars),
    face: probeDirectory(resolvedFace),
    documentFallbacks: documentReadDirs().slice(1),
    configuredBy: {
      root: env.STORAGE_ROOT ? "STORAGE_ROOT" : env.UPLOAD_DIR ? "UPLOAD_DIR" : null,
      documents: env.STORAGE_DOCUMENTS_DIR ? "STORAGE_DOCUMENTS_DIR" : null,
      avatars: env.STORAGE_AVATARS_DIR ? "STORAGE_AVATARS_DIR" : null,
      face: env.STORAGE_FACE_DIR ? "STORAGE_FACE_DIR" : null
    }
  };
}
