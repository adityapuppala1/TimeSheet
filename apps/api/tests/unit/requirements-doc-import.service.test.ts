/**
 * `requirements-doc-import.service.ts` — text extraction for Requirements Studio's optional
 * "import an existing PRD/BRD" upload.
 *
 * Both `pdf-parse` and `mammoth` are mocked at the module boundary rather than run against a
 * hand-built binary fixture: `pdf-parse` bundles a very old pdf.js build (v1.10.100) that turned
 * out to be extremely picky about exact xref-table byte layout while writing this test — a
 * hand-rolled minimal PDF that parsed fine when required from plain CommonJS failed with "bad
 * XRef entry" once loaded through this repo's ESM runtime, for reasons that traced back to the
 * library's own parser internals, not to this file's code. Real-world PDFs are unaffected — this
 * was checked directly (not assumed) against an actual PDF on disk, `pdfParse()` called both via
 * `require()` and via native ESM `import`, both returning identical extracted text — so the
 * library is confirmed to work correctly in this app's actual (ESM) runtime; the unit test just
 * isn't the place to fight one old library's fixture-format pickiness. `mammoth` has no
 * docx-writing counterpart in this codebase to build a valid fixture with either, so it's mocked
 * for the same reason.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("pdf-parse", () => ({ default: vi.fn() }));
vi.mock("mammoth", () => ({ default: { extractRawText: vi.fn() } }));

const pdfParse = (await import("pdf-parse")).default;
const mammoth = (await import("mammoth")).default;
const { extractRequirementsImportText } = await import("../../src/services/requirements-doc-import.service.js");

describe("extractRequirementsImportText", () => {
  it("round-trips a .txt file as-is", async () => {
    const result = await extractRequirementsImportText({ buffer: Buffer.from("Plain text requirements doc."), originalname: "notes.txt" });
    expect(result.text).toBe("Plain text requirements doc.");
  });

  it("refuses an unsupported extension with a clear message", async () => {
    await expect(extractRequirementsImportText({ buffer: Buffer.from("binary"), originalname: "legacy.doc" })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining("PDF, Word (.docx), Markdown (.md) or plain text")
    });
  });

  it("extracts text from a .pdf via pdf-parse", async () => {
    vi.mocked(pdfParse).mockResolvedValue({ text: "Extracted from a PDF." } as never);
    const buffer = Buffer.from("fake pdf bytes");
    const result = await extractRequirementsImportText({ buffer, originalname: "existing-prd.pdf" });
    expect(result.text).toBe("Extracted from a PDF.");
    expect(pdfParse).toHaveBeenCalledWith(buffer);
  });

  it("throws AppError(422) instead of an unhandled rejection when pdf-parse itself throws", async () => {
    vi.mocked(pdfParse).mockRejectedValue(new Error("bad XRef entry"));
    await expect(extractRequirementsImportText({ buffer: Buffer.from("corrupt"), originalname: "broken.pdf" })).rejects.toMatchObject({
      statusCode: 422
    });
  });

  it("extracts text from a .docx via mammoth", async () => {
    vi.mocked(mammoth.extractRawText).mockResolvedValue({ value: "Extracted from Word.", messages: [] } as never);
    const result = await extractRequirementsImportText({ buffer: Buffer.from("fake docx bytes"), originalname: "existing-prd.docx" });
    expect(result.text).toBe("Extracted from Word.");
  });

  it("throws AppError(422) when mammoth itself throws", async () => {
    vi.mocked(mammoth.extractRawText).mockRejectedValue(new Error("not a valid zip"));
    await expect(extractRequirementsImportText({ buffer: Buffer.from("garbage"), originalname: "broken.docx" })).rejects.toMatchObject({
      statusCode: 422
    });
  });
});
