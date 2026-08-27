/**
 * The type-aware preview: which viewer suits which uploaded file, and what happens when the file
 * is missing, unconvertible, or predates the original ever being kept. The fallbacks matter more
 * than the happy paths — a preview that errors is worse than one that shows plain text.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("mammoth", () => ({ default: { convertToHtml: vi.fn(), extractRawText: vi.fn() } }));
vi.mock("node:fs/promises", () => ({
  default: { readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rm: vi.fn() }
}));
vi.mock("../../src/config/tenant-context.js", () => ({
  requireTenantContext: () => ({ orgId: "org-1", orgSlug: "test", client: {} })
}));

const mammoth = (await import("mammoth")).default;
const fs = (await import("node:fs/promises")).default;
const { buildSourceViewerPayload, contentTypeFor, newSourceFileName, viewerKindFor } = await import(
  "../../src/services/requirements-doc-viewer.service.js"
);

const BASE = {
  sourceDocumentName: "spec.pdf",
  sourceDocumentSize: 1234,
  sourceDocumentUploadedAt: new Date("2026-08-01T00:00:00Z"),
  sourceDocumentUploadedBy: { id: "u1", name: "Avery" },
  sourceDocumentText: "extracted text",
  sourceDocumentPath: "reqdoc-abc.pdf"
};

describe("viewerKindFor", () => {
  it("picks the viewer that suits each type", () => {
    expect(viewerKindFor("a.pdf")).toBe("pdf");
    expect(viewerKindFor("a.docx")).toBe("html");
    expect(viewerKindFor("a.md")).toBe("markdown");
    expect(viewerKindFor("a.txt")).toBe("text");
    expect(viewerKindFor(null)).toBe("text");
  });

  it("is case-insensitive, because uploads arrive named however the uploader named them", () => {
    expect(viewerKindFor("SPEC.PDF")).toBe("pdf");
    expect(viewerKindFor("Spec.DocX")).toBe("html");
  });
});

describe("contentTypeFor", () => {
  it("names the type it really is, and refuses to guess for anything else", () => {
    expect(contentTypeFor("a.pdf")).toBe("application/pdf");
    expect(contentTypeFor("a.txt")).toContain("text/plain");
    // Deliberately not guessed — paired with the route's `nosniff`, an unknown type must never be
    // handed to the browser as something it might execute.
    expect(contentTypeFor("a.weird")).toBe("application/octet-stream");
  });
});

describe("newSourceFileName", () => {
  it("keeps the extension but never the uploader's own name — a chosen name is a chosen path", () => {
    const name = newSourceFileName("../../etc/passwd.pdf");
    expect(name.endsWith(".pdf")).toBe(true);
    expect(name).not.toContain("passwd");
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
  });

  it("drops an extension that isn't a plain one", () => {
    expect(newSourceFileName("weird.name.with spaces")).toMatch(/^reqdoc-[0-9a-f-]+$/);
  });
});

describe("buildSourceViewerPayload", () => {
  it("PDF: reports the kind and leaves the bytes to the streaming route", async () => {
    const payload = await buildSourceViewerPayload(BASE);
    expect(payload.kind).toBe("pdf");
    expect(payload.hasOriginalFile).toBe(true);
    expect(payload.html).toBeUndefined();
    expect(payload.fileName).toBe("spec.pdf");
  });

  it("DOCX: converts to HTML so headings and tables survive", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("docx bytes") as never);
    vi.mocked(mammoth.convertToHtml).mockResolvedValue({ value: "<h1>Spec</h1>", messages: [] } as never);

    const payload = await buildSourceViewerPayload({ ...BASE, sourceDocumentName: "spec.docx", sourceDocumentPath: "reqdoc-a.docx" });

    expect(payload.kind).toBe("html");
    expect(payload.html).toBe("<h1>Spec</h1>");
  });

  it("DOCX that will not convert: degrades to the extracted text rather than erroring", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("corrupt") as never);
    vi.mocked(mammoth.convertToHtml).mockRejectedValue(new Error("not a zip"));

    const payload = await buildSourceViewerPayload({ ...BASE, sourceDocumentName: "spec.docx", sourceDocumentPath: "reqdoc-a.docx" });

    expect(payload.kind).toBe("text");
    expect(payload.text).toBe("extracted text");
  });

  it("text: prefers the STORED file over the extracted copy, which the AI cap may have truncated", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("the full untruncated file") as never);

    const payload = await buildSourceViewerPayload({ ...BASE, sourceDocumentName: "spec.txt", sourceDocumentPath: "reqdoc-a.txt" });

    expect(payload.kind).toBe("text");
    expect(payload.text).toBe("the full untruncated file");
  });

  it("text whose file has vanished: falls back to the extracted copy", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"));

    const payload = await buildSourceViewerPayload({ ...BASE, sourceDocumentName: "spec.txt", sourceDocumentPath: "reqdoc-gone.txt" });

    expect(payload.text).toBe("extracted text");
  });

  it("imported before the original was kept: says so, and still previews the text", async () => {
    const payload = await buildSourceViewerPayload({ ...BASE, sourceDocumentPath: null });

    expect(payload.hasOriginalFile).toBe(false);
    expect(payload.kind).toBe("text");
    expect(payload.text).toBe("extracted text");
  });
});
