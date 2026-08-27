/**
 * WHAT: turns an uploaded PDF/DOCX/TXT into plain text for Requirements Studio's optional
 * "import an existing PRD/BRD" flow (requirements-doc.service.ts's analyzeImportedDocument).
 *
 * WHY A SEPARATE FILE: this is a distinct concern from the AI orchestration around it — its own
 * dependencies (pdf-parse, mammoth), easy to unit-test in isolation, easy to extend later (e.g.
 * an OCR fallback for a scanned PDF) without touching the orchestration layer. Same split
 * requirements-doc.service.ts's own header draws between itself and ai.service.ts.
 *
 * This module only EXTRACTS. Keeping the original bytes is a separate, later decision made once
 * an import is confirmed (requirements-doc-viewer.service.ts) — extraction runs on every analyze,
 * including ones nobody accepts, and those should leave nothing behind.
 */
import path from "node:path";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { AppError } from "../middleware/error.js";

/**
 * Deliberately narrower than middleware/upload.ts's `allowedAttachmentExtensions` (which also
 * allows legacy binary `.doc`): there is no good pure-JS parser for old `.doc`, so it is rejected
 * clearly here rather than silently mangled.
 */
export const SUPPORTED_IMPORT_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md"]);

export async function extractRequirementsImportText(file: { buffer: Buffer; originalname: string }): Promise<{ text: string }> {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!SUPPORTED_IMPORT_EXTENSIONS.has(ext)) {
    throw new AppError(422, `Unsupported file type: ${ext || "(none)"}. Upload a PDF, Word (.docx), Markdown (.md) or plain text file.`);
  }

  try {
    if (ext === ".pdf") {
      const parsed = await pdfParse(file.buffer);
      return { text: parsed.text };
    }
    if (ext === ".docx") {
      const parsed = await mammoth.extractRawText({ buffer: file.buffer });
      return { text: parsed.value };
    }
    return { text: file.buffer.toString("utf8") };
  } catch {
    throw new AppError(422, "Could not read that file — it may be corrupted or password-protected.");
  }
}
