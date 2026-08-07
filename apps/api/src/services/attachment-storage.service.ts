/**
 * WHAT: the single place an uploaded file is turned into bytes on disk plus the row that describes
 * them. Every ticket and timesheet attachment goes through `processUpload`.
 *
 * WHY IT EXISTS: uploads used to be written byte-for-byte under a `Date.now()-name` filename, with
 * only fileName/mimeType/url/size recorded. That cost storage no one was tracking, produced
 * filenames that told you nothing about who or what they belonged to, and left no data to answer
 * "what are people actually uploading?".
 *
 * ── WHAT GETS COMPRESSED, AND WHAT DELIBERATELY DOESN'T ─────────────────────────────────────
 *
 * The honest answer is that "compress everything" is the wrong instruction, so this does three
 * different things depending on what the bytes are:
 *
 *  IMAGES (png/jpg/jpeg/gif) → re-encoded to WebP. Typically 60-80% smaller at a quality setting
 *    that is visually indistinguishable, and it strips EXIF/GPS/ICC as a side effect — the same
 *    security win processAvatar already relies on. If the WebP somehow comes out LARGER (it can,
 *    for tiny flat-colour PNGs), the original is kept: a pipeline that makes files worse is a bug.
 *
 *  TEXT AND CODE (txt/csv/json/xml/yaml/md/source) → gzipped at rest, typically 60-85% smaller,
 *    and losslessly restored on read. These are the files where generic compression actually wins.
 *
 *  PDF, ZIP, DOCX, XLSX → stored untouched. This is the part people expect to be compressed and
 *    it is the part where compressing is pointless: all four are already DEFLATE containers
 *    internally. Re-compressing gains ~1-2% for real CPU, and genuine PDF optimisation (image
 *    downsampling, font subsetting) needs Ghostscript, which is not a dependency this project has
 *    and not one to add silently. Claiming compression here would be a lie told in bytes.
 *
 * Every branch records what it did in `compression`, so the read path never has to guess and the
 * numbers in analytics are honest about which files were actually reduced.
 *
 * ── NAMING AND LOCATION ─────────────────────────────────────────────────────────────────────
 *
 *   <documents>/<orgId>/<person>__<entity>-<shortId>__<original-name>__<timestamp>__<rand>.<ext>
 *
 * Readable enough to identify a stray file on disk without a database lookup, and unique enough
 * that two people uploading `screenshot.png` in the same second cannot collide.
 *
 * The `<rand>` component is 128 bits of `crypto.randomBytes`, not the 24 bits it started as. Every
 * other part of that name is derivable by someone who knows what a colleague attached — their
 * name, the ticket, the original filename, roughly when — so the random tail is the only part
 * carrying any secrecy, and `/uploads` links are handed to unauthenticated guest reviewers.
 *
 * The `<orgId>` directory is new; files written before it stay flat in `<documents>` and are read
 * from there forever (see `resolveStoredFile`). NOTHING is moved.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import sharp from "sharp";
import { documentReadDirs, documentsDirForOrg, isOrgSegment, resolveWithin } from "../config/storage-paths.js";
import { requireTenantContext } from "../config/tenant-context.js";

const gzip = promisify(zlib.gzip);

/** Coarse buckets for analytics, and later for deciding what is worth extracting text from. */
export type FileCategory = "IMAGE" | "DOCUMENT" | "SPREADSHEET" | "ARCHIVE" | "CODE" | "TEXT" | "OTHER";
export type Compression = "NONE" | "WEBP" | "GZIP";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);
/** Already DEFLATE containers — see the header note on why these are left alone. */
const PRECOMPRESSED_EXTENSIONS = new Set([".zip", ".pdf", ".docx", ".xlsx", ".doc", ".xls"]);
const TEXT_EXTENSIONS = new Set([".txt", ".csv", ".md", ".json", ".xml", ".yaml", ".yml"]);
const CODE_EXTENSIONS = new Set([
  ".py", ".css", ".jsx", ".ts", ".tsx", ".java", ".cs", ".cpp", ".c", ".h", ".php", ".rb", ".go", ".rs", ".sql"
]);

/** Below this, gzip's header plus the CPU is not worth the handful of bytes saved. */
const MIN_GZIP_BYTES = 1024;
/** Screenshots from a 5K display are common and pointless to store at full size; this is still
 *  well above anything anyone reads on screen. */
const MAX_IMAGE_DIMENSION = 2560;
/** Visually indistinguishable for screenshots and photos alike. `effort: 5` trades a little
 *  encode time for a meaningfully smaller file. */
const WEBP_QUALITY = 82;

export function categorize(ext: string): FileCategory {
  if (IMAGE_EXTENSIONS.has(ext) || ext === ".webp") return "IMAGE";
  if (ext === ".pdf" || ext === ".doc" || ext === ".docx") return "DOCUMENT";
  if (ext === ".xls" || ext === ".xlsx" || ext === ".csv") return "SPREADSHEET";
  if (ext === ".zip") return "ARCHIVE";
  if (CODE_EXTENSIONS.has(ext)) return "CODE";
  if (TEXT_EXTENSIONS.has(ext)) return "TEXT";
  return "OTHER";
}

/** Filesystem-safe, readable, and short enough that the whole name stays under the 255-char
 *  column. Collapses runs of separators so a name like "My  Report (final).pdf" doesn't become
 *  a row of dashes. */
function slug(value: string, maxLength: number): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLength)
      .toLowerCase() || "file"
  );
}

/** `20260802-214530` — sorts correctly as text, which makes an `ls` of the upload directory
 *  chronological without any tooling. */
function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export interface ProcessedUpload {
  /** What the user sees and downloads as. Extension follows the STORED format, so a converted
   *  image downloads as `.webp` rather than lying about being a `.png`. */
  fileName: string;
  mimeType: string;
  url: string;
  storageKey: string;
  sizeBytes: number;
  originalSizeBytes: number;
  fileCategory: FileCategory;
  compression: Compression;
  checksumSha256: string;
  width: number | null;
  height: number | null;
}

export interface UploadOwner {
  /** Used only for the filename prefix — never for authorisation. */
  userName?: string | null;
  entityType: "ticket" | "timesheet";
  entityId: string;
}

/**
 * Processes one multer file (memory OR disk storage) and returns the row data to persist.
 *
 * Accepts both storage modes because the two existing call sites differ: ticket attachments use
 * disk storage, timesheet attachments use disk storage, and re-encoding needs the bytes either
 * way. When given a disk file, the original is removed after the processed version is written —
 * leaving both would double the storage this whole service exists to reduce.
 */
export async function processUpload(file: Express.Multer.File, owner: UploadOwner): Promise<ProcessedUpload> {
  // Throws rather than falling back to a flat write. "No tenant context" here would mean a file
  // landing in the shared directory with no owning org — the exact condition this change exists to
  // remove — so it must fail loudly at the one call site that got it wrong, not silently degrade.
  const { orgId } = requireTenantContext();
  const originalExt = path.extname(file.originalname).toLowerCase();
  const originalBase = path.basename(file.originalname, originalExt);
  const input = file.buffer ?? (await fsp.readFile(file.path));
  const originalSizeBytes = input.length;
  // Hashed BEFORE any re-encoding, so the checksum identifies what the user actually uploaded and
  // stays comparable across a future change to the encoder settings.
  const checksumSha256 = crypto.createHash("sha256").update(input).digest("hex");

  const namePrefix = [
    slug(owner.userName ?? "user", 24),
    `${owner.entityType}-${owner.entityId.slice(0, 8)}`,
    slug(originalBase, 40),
    stamp(new Date()),
    // 128 bits. See the header: every other segment of this name is guessable by someone who knows
    // what was attached, so this is the part that has to be a secret rather than a serial number.
    crypto.randomBytes(16).toString("hex")
  ].join("__");

  let outputBuffer = input;
  let extension = originalExt;
  let mimeType = file.mimetype || "application/octet-stream";
  let compression: Compression = "NONE";
  let width: number | null = null;
  let height: number | null = null;

  if (IMAGE_EXTENSIONS.has(originalExt)) {
    try {
      const pipeline = sharp(input, { animated: originalExt === ".gif" })
        // `withoutEnlargement` so a small logo isn't upscaled into a bigger file than it started.
        .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: "inside", withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY, effort: 5 });

      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

      // Only keep the conversion if it actually helped. Tiny flat PNGs and some GIFs encode LARGER
      // as WebP, and shipping a bigger file from a compression pipeline is a bug, not a trade-off.
      if (data.length < input.length) {
        outputBuffer = data;
        extension = ".webp";
        mimeType = "image/webp";
        compression = "WEBP";
        width = info.width;
        height = info.height;
      } else {
        const meta = await sharp(input).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      }
    } catch {
      // A corrupt or unsupported image is stored as-is rather than rejected: the upload already
      // passed the extension allow-list, and refusing it here would turn a storage optimisation
      // into a new way for a legitimate attachment to fail.
    }
  } else if (!PRECOMPRESSED_EXTENSIONS.has(originalExt) && originalSizeBytes >= MIN_GZIP_BYTES) {
    const gzipped = await gzip(input, { level: zlib.constants.Z_BEST_COMPRESSION });
    if (gzipped.length < input.length) {
      outputBuffer = gzipped;
      compression = "GZIP";
    }
  }

  // `.gz` is appended to the ON-DISK name only. The URL keeps the real extension so the download
  // is named correctly, and the read path uses `compression` to know it must decompress.
  //
  // `storageKey` carries the org segment because it is what a delete path joins onto the documents
  // directory; a key that resolved to a different place than the URL did would leave orphans.
  const diskName = `${namePrefix}${extension}${compression === "GZIP" ? ".gz" : ""}`;
  const publicName = `${namePrefix}${extension}`;
  const storageKey = `${orgId}/${diskName}`;
  const orgDir = documentsDirForOrg(orgId);
  await fsp.mkdir(orgDir, { recursive: true });
  const targetPath = path.join(orgDir, diskName);
  await fsp.writeFile(targetPath, outputBuffer);

  // Disk-storage uploads leave the raw multer file behind; removing it is what makes the saving
  // real rather than notional.
  if (file.path && path.resolve(file.path) !== path.resolve(targetPath)) {
    await fsp.rm(file.path, { force: true });
  }

  return {
    fileName: `${originalBase}${extension}`,
    mimeType,
    // The org segment is a real path segment, so it is NOT run through encodeURIComponent — that
    // would turn the separator into %2F, which serve-static refuses outright.
    url: `/uploads/${orgId}/${encodeURIComponent(publicName)}`,
    storageKey,
    sizeBytes: outputBuffer.length,
    originalSizeBytes,
    fileCategory: categorize(extension),
    compression,
    checksumSha256,
    width,
    height
  };
}

/**
 * Reduces a requested `/uploads/...` path to the only two shapes a document can legitimately
 * have, or `null`.
 *
 *   "<name>"           legacy — everything written before documents were org-segmented
 *   "<orgId>/<name>"   current
 *
 * `path.basename` on the final segment is the containment control and must stay: it collapses
 * every traversal attempt ("../../../etc/passwd", an absolute path, a Windows drive letter) to a
 * lookup for a file that does not exist. The org segment is admitted only when it matches the
 * control-plane UUID shape exactly, which is what stops "any two-segment path" from being a way
 * to reach `avatars/`, `face/` or `incoming/` through the documents reader — and, because the
 * value is echoed back to the caller, lets app.ts check it against the org the request's signed
 * grant was minted for.
 */
export function normalizeDocumentKey(requested: string): { relative: string; orgId: string | null } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0")) return null;

  const segments = decoded.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.length > 2) return null;

  const safeName = path.basename(segments[segments.length - 1]);
  if (!safeName || safeName === "." || safeName === "..") return null;

  if (segments.length === 1) return { relative: safeName, orgId: null };
  const orgId = segments[0];
  if (!isOrgSegment(orgId)) return null;
  return { relative: `${orgId}/${safeName}`, orgId };
}

/**
 * Resolves a public `/uploads/<name>` request to the bytes to send.
 *
 * Three cases, and legacy is the one that matters most: files uploaded before this pipeline sit on
 * disk under their original name with no database `compression` value, and must keep working
 * untouched — this is not a migration, and rewriting existing files would risk data for a storage
 * saving nobody asked for. Org-segmented and flat names are both accepted for exactly that
 * reason: the two layouts coexist on disk permanently.
 *
 * The directory LIST (rather than a single directory) is what makes STORAGE_DOCUMENTS_DIR safe to
 * change: after a relocation, reads still fall back to the pre-move root, so historical
 * attachments keep resolving instead of turning into 404s the moment the variable is set.
 */
export async function resolveStoredFile(
  requestedName: string
): Promise<{ stream: fs.ReadStream | null; gunzip: boolean; absolutePath: string } | null> {
  const key = normalizeDocumentKey(requestedName);
  if (!key) return null;

  for (const dir of documentReadDirs()) {
    // Belt and braces over normalizeDocumentKey: the join is only used if it provably stays inside
    // the directory it was joined onto.
    const direct = resolveWithin(dir, key.relative);
    if (!direct) continue;
    const gzipped = `${direct}.gz`;

    // `.gz` is checked FIRST: a gzipped upload has no plain twin, and checking the other order
    // would mean a stat call that always misses.
    if (fs.existsSync(gzipped)) {
      return { stream: fs.createReadStream(gzipped), gunzip: true, absolutePath: gzipped };
    }
    if (fs.existsSync(direct)) {
      return { stream: fs.createReadStream(direct), gunzip: false, absolutePath: direct };
    }
  }
  return null;
}
