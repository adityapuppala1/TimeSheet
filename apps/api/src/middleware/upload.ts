import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { env } from "../config/env.js";
import { AppError } from "./error.js";

export const allowedAttachmentExtensions = new Set([
  ".pdf", ".xls", ".xlsx", ".csv", ".jpg", ".jpeg", ".gif", ".png", ".svg", ".zip", ".txt",
  ".py", ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".json", ".xml", ".yaml", ".yml",
  ".java", ".cs", ".cpp", ".c", ".h", ".php", ".rb", ".go", ".rs", ".sql", ".md", ".doc", ".docx"
]);

const allowedImageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif"]);
const allowedImageMimes = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif"]);

fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.join(env.UPLOAD_DIR, "avatars"), { recursive: true });

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, env.UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeBase = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
    cb(null, `${Date.now()}-${safeBase}${ext}`);
  }
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
