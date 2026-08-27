/**
 * WHAT: stores the ORIGINAL uploaded PRD/BRD alongside its extracted text, and decides which
 * viewer the in-app preview should use for it.
 *
 * WHY THE RAW FILE IS KEPT NOW, WHEN IT DELIBERATELY WASN'T BEFORE: the first cut of the import
 * feature stored only extracted text, on a "don't hoard data you don't need" argument. That was
 * the right call while the only consumer was the AI. It stops being right the moment a person
 * wants to LOOK at what was uploaded — text alone loses the tables, headings and layout that are
 * often the whole reason a document reads as a specification. So the bytes are kept, org-scoped,
 * in the same non-public documents subtree every other uploaded file lives in, and are deleted
 * with the rest of the provenance when the link is removed.
 *
 * WHICH VIEWER, AND WHY IT VARIES BY TYPE:
 *   - PDF   → the browser's own viewer, over the raw bytes. Nothing renders a PDF better.
 *   - DOCX  → converted to HTML by `mammoth` (already a dependency for text extraction, this just
 *             uses its richer entry point). Headings, lists, bold and tables survive, which is the
 *             difference between "a wall of text" and "the document".
 *   - TXT/MD → the text itself, rendered as markdown.
 *   - Anything with no stored file (imported before this shipped) → the extracted text, so an
 *     older document still previews rather than showing an error.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import mammoth from "mammoth";
import { documentsDirForOrg } from "../config/storage-paths.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";

/** What the frontend should mount for this file. */
export type SourceViewerKind = "pdf" | "html" | "markdown" | "text";

export interface SourceViewerPayload {
  fileName: string | null;
  size: number | null;
  uploadedAt: Date | null;
  uploadedBy: { id: string; name: string } | null;
  kind: SourceViewerKind;
  /** Set for `html` (a converted .docx). Already sanitised — see the note on the conversion. */
  html?: string;
  /** Set for `markdown`/`text`, and for anything with no stored file. */
  text?: string;
  /** False when only the extracted text survives — the UI says so rather than implying otherwise. */
  hasOriginalFile: boolean;
}

/** Stored names are random, never derived from the upload's own filename: a name the uploader
 *  chooses is a name they can use to aim at somewhere else on disk. The real name lives in the
 *  database column, which is where it can't be a path. */
export function newSourceFileName(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().slice(0, 10);
  return `reqdoc-${crypto.randomUUID()}${/^\.[a-z0-9]+$/.test(ext) ? ext : ""}`;
}

function orgDir(): string {
  return documentsDirForOrg(requireTenantContext().orgId);
}

export async function writeSourceFile(fileName: string, bytes: Buffer): Promise<void> {
  const dir = orgDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), bytes);
}

/** Best-effort: a document whose provenance is being cleared should not fail because its file was
 *  already gone (a restored backup, a manual tidy-up). */
export async function deleteSourceFile(fileName: string | null | undefined): Promise<void> {
  if (!fileName) return;
  await fs.rm(path.join(orgDir(), fileName), { force: true }).catch(() => undefined);
}

export async function readSourceFile(fileName: string): Promise<Buffer> {
  // path.basename defends the read even though `newSourceFileName` is the only writer — the value
  // makes a round trip through the database, and a stored name is not a trusted name.
  const resolved = path.join(orgDir(), path.basename(fileName));
  try {
    return await fs.readFile(resolved);
  } catch {
    throw new AppError(404, "The uploaded file is no longer on disk.");
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/** Which viewer suits this filename — the whole point of the type-aware preview. */
export function viewerKindFor(fileName: string | null): SourceViewerKind {
  switch (path.extname(fileName ?? "").toLowerCase()) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "html";
    case ".md":
      return "markdown";
    default:
      return "text";
  }
}

/**
 * Builds the viewer payload for one document.
 *
 * The .docx → HTML conversion is the interesting case. `mammoth.convertToHtml` emits a small,
 * fixed tag vocabulary (headings, lists, tables, emphasis, links) — no scripts, no styles, no
 * event handlers — and the frontend still runs the result through the same `safeHtml` sanitizer
 * every other model/third-party HTML goes through. Two layers, because this content came out of a
 * file somebody else wrote.
 */
export async function buildSourceViewerPayload(doc: {
  sourceDocumentName: string | null;
  sourceDocumentSize: number | null;
  sourceDocumentUploadedAt: Date | null;
  sourceDocumentUploadedBy: { id: string; name: string } | null;
  sourceDocumentText: string | null;
  sourceDocumentPath: string | null;
}): Promise<SourceViewerPayload> {
  const base = {
    fileName: doc.sourceDocumentName,
    size: doc.sourceDocumentSize,
    uploadedAt: doc.sourceDocumentUploadedAt,
    uploadedBy: doc.sourceDocumentUploadedBy
  };

  // Imported before the original was kept: the extracted text is all there is, and the UI says so.
  if (!doc.sourceDocumentPath) {
    return { ...base, kind: "text", text: doc.sourceDocumentText ?? "", hasOriginalFile: false };
  }

  const kind = viewerKindFor(doc.sourceDocumentName);

  // A PDF is streamed to the browser's own viewer by the sibling route — nothing to inline here.
  if (kind === "pdf") return { ...base, kind, hasOriginalFile: true };

  if (kind === "html") {
    try {
      const buffer = await readSourceFile(doc.sourceDocumentPath);
      const { value } = await mammoth.convertToHtml({ buffer });
      return { ...base, kind, html: value, hasOriginalFile: true };
    } catch {
      // Conversion failed (a corrupt or password-protected file): the extracted text still reads,
      // so degrade to it rather than showing nothing.
      return { ...base, kind: "text", text: doc.sourceDocumentText ?? "", hasOriginalFile: true };
    }
  }

  // Plain text and markdown: the stored bytes ARE the content, so read them rather than the
  // possibly-truncated extraction (the AI's copy is capped; the file is not).
  try {
    const buffer = await readSourceFile(doc.sourceDocumentPath);
    return { ...base, kind, text: buffer.toString("utf8"), hasOriginalFile: true };
  } catch {
    return { ...base, kind, text: doc.sourceDocumentText ?? "", hasOriginalFile: true };
  }
}
