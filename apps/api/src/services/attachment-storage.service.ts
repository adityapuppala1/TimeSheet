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
 * ── NAMING ──────────────────────────────────────────────────────────────────────────────────
 *
 *   <person>__<entity>-<shortId>__<original-name>__<timestamp>__<rand>.<ext>
 *
 * Readable enough to identify a stray file on disk without a database lookup, and unique enough
 * that two people uploading `screenshot.png` in the same second cannot collide.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import sharp from "sharp";
import { env } from "../config/env.js";

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
    crypto.randomBytes(3).toString("hex")
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
  const storageKey = `${namePrefix}${extension}${compression === "GZIP" ? ".gz" : ""}`;
  const targetPath = path.join(env.UPLOAD_DIR, storageKey);
  await fsp.writeFile(targetPath, outputBuffer);

  // Disk-storage uploads leave the raw multer file behind; removing it is what makes the saving
  // real rather than notional.
  if (file.path && path.resolve(file.path) !== path.resolve(targetPath)) {
    await fsp.rm(file.path, { force: true });
  }

  return {
    fileName: `${originalBase}${extension}`,
    mimeType,
    url: `/uploads/${encodeURIComponent(`${namePrefix}${extension}`)}`,
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
 * Resolves a public `/uploads/<name>` request to the bytes to send.
 *
 * Three cases, and legacy is the one that matters most: files uploaded before this pipeline sit on
 * disk under their original name with no database `compression` value, and must keep working
 * untouched — this is not a migration, and rewriting existing files would risk data for a storage
 * saving nobody asked for.
 */
export async function resolveStoredFile(
  requestedName: string
): Promise<{ stream: fs.ReadStream | null; gunzip: boolean; absolutePath: string } | null> {
  const safeName = path.basename(decodeURIComponent(requestedName));
  const direct = path.join(env.UPLOAD_DIR, safeName);
  const gzipped = `${direct}.gz`;

  // `.gz` is checked FIRST: a gzipped upload has no plain twin, and checking the other order would
  // mean a stat call that always misses.
  if (fs.existsSync(gzipped)) {
    return { stream: fs.createReadStream(gzipped), gunzip: true, absolutePath: gzipped };
  }
  if (fs.existsSync(direct)) {
    return { stream: fs.createReadStream(direct), gunzip: false, absolutePath: direct };
  }
  return null;
}
