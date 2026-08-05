/**
 * Tests for the upload pipeline.
 *
 * The property that matters most is the one that's easy to get wrong in the "helpful" direction:
 * a compression pipeline must never produce a LARGER file, and must never lose the ability to
 * hand back exactly what was uploaded for the formats it doesn't re-encode. Both are asserted
 * here against real bytes, not mocks — sharp and zlib are the things under test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import sharp from "sharp";

const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ts-uploads-"));
process.env.UPLOAD_DIR = tempDir;

const { categorize, processUpload, resolveStoredFile } = await import("../../src/services/attachment-storage.service.js");

/** Multer gives us either a buffer (memory storage) or a path (disk storage); the pipeline
 *  accepts both, so tests construct the buffer shape. */
function fileOf(name: string, buffer: Buffer, mimetype = "application/octet-stream"): Express.Multer.File {
  return { originalname: name, buffer, mimetype, size: buffer.length } as Express.Multer.File;
}

const owner = { userName: "Priya Raman", entityType: "ticket" as const, entityId: "abcdef1234567890" };

/**
 * A photo-like PNG.
 *
 * Uses REAL entropy, which matters more than it looks: the first version of this helper generated
 * a periodic pattern (`(i * 7 + (i % 13) * 29) % 256`), and PNG's filters plus deflate compress a
 * repeating pattern so well that lossy WebP came out LARGER — so the pipeline correctly kept the
 * original and the test read that as a bug in the code. The fixture was wrong, not the pipeline.
 * Random bytes are incompressible by PNG and are what a photograph actually resembles.
 */
async function noisyPng(width = 900, height = 700): Promise<Buffer> {
  const pixels = crypto.randomBytes(width * height * 3);
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

beforeAll(() => {
  fs.mkdirSync(tempDir, { recursive: true });
});
afterAll(async () => {
  // Only the directory this test created, in the OS temp area — never UPLOAD_DIR from a real env.
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe("processUpload — images", () => {
  it("converts a PNG to WebP and records the dimensions", async () => {
    const png = await noisyPng();
    const result = await processUpload(fileOf("Screen Shot.png", png, "image/png"), owner);

    expect(result.compression).toBe("WEBP");
    expect(result.mimeType).toBe("image/webp");
    expect(result.fileName).toBe("Screen Shot.webp");
    expect(result.fileCategory).toBe("IMAGE");
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    // The point of the whole exercise.
    expect(result.sizeBytes).toBeLessThan(result.originalSizeBytes);
  });

  it("downscales an oversized image but never upscales a small one", async () => {
    const huge = await processUpload(fileOf("huge.png", await noisyPng(4000, 3000), "image/png"), owner);
    expect(huge.width).toBeLessThanOrEqual(2560);

    const small = await processUpload(fileOf("small.png", await noisyPng(120, 90), "image/png"), owner);
    // withoutEnlargement: a 120px logo must come back 120px, not stretched to the cap.
    expect(small.width).toBe(120);
  });

  it("never stores more bytes than it was given, whatever the input", async () => {
    // The invariant, asserted across shapes that compress very differently rather than by trying
    // to hand-pick one input where WebP loses. (An earlier version guessed a 1x1 PNG would be that
    // case; WebP actually wins there.) A compression pipeline producing a bigger file is a bug, so
    // this is the property worth pinning — not the specific branch that prevents it.
    const inputs: Array<[string, Buffer]> = [
      ["dot.png", await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).png().toBuffer()],
      ["flat.png", await sharp({ create: { width: 400, height: 400, channels: 3, background: "#0F9AA8" } }).png().toBuffer()],
      ["photo.png", await noisyPng(300, 200)],
      ["notes.txt", Buffer.from("a".repeat(5000))],
      ["already.pdf", Buffer.alloc(4096, 9)]
    ];

    for (const [name, body] of inputs) {
      const result = await processUpload(fileOf(name, body), owner);
      expect(result.sizeBytes, `${name} grew from ${result.originalSizeBytes} to ${result.sizeBytes}`).toBeLessThanOrEqual(
        result.originalSizeBytes
      );
    }
  });

  it("stores a corrupt image as-is rather than rejecting the upload", async () => {
    // It already passed the extension allow-list. Turning a storage optimisation into a new way
    // for a legitimate attachment to fail would be a worse outcome than storing it unchanged.
    const notReallyAnImage = Buffer.from("this is not a png, but it is named like one");
    const result = await processUpload(fileOf("broken.png", notReallyAnImage, "image/png"), owner);

    expect(result.compression).toBe("NONE");
    expect(result.sizeBytes).toBe(notReallyAnImage.length);
  });
});

describe("processUpload — compressible and pre-compressed files", () => {
  it("gzips text and restores it byte-for-byte", async () => {
    const csv = Buffer.from("date,hours,task\n".repeat(400));
    const result = await processUpload(fileOf("report.csv", csv, "text/csv"), owner);

    expect(result.compression).toBe("GZIP");
    expect(result.fileCategory).toBe("SPREADSHEET");
    expect(result.sizeBytes).toBeLessThan(result.originalSizeBytes);

    // LOSSLESS is the whole claim. Read it back the way the server does and compare bytes.
    const stored = await fsp.readFile(path.join(tempDir, result.storageKey));
    expect(zlib.gunzipSync(stored).equals(csv)).toBe(true);
  });

  it("leaves already-compressed formats alone", async () => {
    // PDF/zip/docx are DEFLATE containers already; gzipping them burns CPU for ~1-2%. Pinned so
    // nobody "improves" this later and slows every upload for nothing.
    for (const name of ["contract.pdf", "bundle.zip", "sheet.xlsx", "doc.docx"]) {
      const body = Buffer.alloc(4096, 7);
      const result = await processUpload(fileOf(name, body), owner);
      expect(result.compression, name).toBe("NONE");
      expect(result.sizeBytes, name).toBe(body.length);
    }
  });

  it("doesn't bother gzipping something tiny", async () => {
    const result = await processUpload(fileOf("note.txt", Buffer.from("hi")), owner);
    expect(result.compression).toBe("NONE");
  });
});

describe("processUpload — naming", () => {
  it("builds an identifiable, unique storage key", async () => {
    const result = await processUpload(fileOf("Q3 Report (final).csv", Buffer.from("a,b\n".repeat(500))), owner);

    // person __ entity-shortid __ original name __ timestamp __ random
    expect(result.storageKey).toMatch(/^priya-raman__ticket-abcdef12__q3-report-final__\d{8}-\d{6}__[0-9a-f]{6}\.csv\.gz$/);
    // The URL keeps the real extension so the download is named correctly; `.gz` is an on-disk
    // detail the browser never sees.
    expect(result.url).not.toContain(".gz");
  });

  it("never collides for the same file uploaded twice in the same second", async () => {
    const body = Buffer.from("x,y\n".repeat(500));
    const [a, b] = await Promise.all([
      processUpload(fileOf("same.csv", body), owner),
      processUpload(fileOf("same.csv", body), owner)
    ]);
    expect(a.storageKey).not.toBe(b.storageKey);
    // Same content, so the checksum SHOULD match — that's what makes dedup possible later.
    expect(a.checksumSha256).toBe(b.checksumSha256);
  });
});

describe("resolveStoredFile", () => {
  it("finds a gzipped file and flags that it needs decompressing", async () => {
    const result = await processUpload(fileOf("data.json", Buffer.from(JSON.stringify({ a: 1 }).repeat(200))), owner);
    const publicName = decodeURIComponent(result.url.replace("/uploads/", ""));

    const resolved = await resolveStoredFile(publicName);
    expect(resolved?.gunzip).toBe(true);
    resolved?.stream?.destroy();
  });

  it("finds an uncompressed file without flagging it", async () => {
    const result = await processUpload(fileOf("contract.pdf", Buffer.alloc(4096, 3)), owner);
    const resolved = await resolveStoredFile(result.url.replace("/uploads/", ""));
    expect(resolved?.gunzip).toBe(false);
    resolved?.stream?.destroy();
  });

  it("returns null for a name that doesn't exist, and can't escape the upload directory", async () => {
    expect(await resolveStoredFile("nope-does-not-exist.txt")).toBeNull();
    // Path traversal: basename() strips the climb, so this looks for "passwd" inside UPLOAD_DIR
    // rather than reading /etc/passwd.
    expect(await resolveStoredFile("../../../../etc/passwd")).toBeNull();
  });
});

describe("categorize", () => {
  it("buckets by extension", () => {
    expect(categorize(".webp")).toBe("IMAGE");
    expect(categorize(".pdf")).toBe("DOCUMENT");
    expect(categorize(".xlsx")).toBe("SPREADSHEET");
    expect(categorize(".zip")).toBe("ARCHIVE");
    expect(categorize(".ts")).toBe("CODE");
    expect(categorize(".md")).toBe("TEXT");
    expect(categorize(".bin")).toBe("OTHER");
  });
});
