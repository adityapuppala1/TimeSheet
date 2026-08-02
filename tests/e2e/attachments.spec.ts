/**
 * The attachment storage pipeline, end to end through the real server.
 *
 * The unit tests (apps/api/tests/unit/attachment-storage.service.test.ts) cover the encoder
 * decisions against real bytes. What they CANNOT cover is the part most likely to break in a way
 * nobody notices: the read path. A gzipped file has a `.gz` on disk that its URL doesn't mention,
 * so if the decompressing middleware ever stops claiming those requests, downloads silently start
 * returning gzip bytes labelled `text/csv` — a corrupt file, HTTP 200, no error anywhere.
 *
 * Equally important, and equally invisible: files uploaded BEFORE this pipeline existed have no
 * `.gz` twin and no `compression` value. They must keep downloading unchanged forever. This is not
 * a migration; existing files are never rewritten.
 */
import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import { withAdminRequest } from "./helpers/admin-request";
import { suspendFaceGate, type FaceGateSnapshot } from "./helpers/face-gate";

let faceGate: FaceGateSnapshot;
test.beforeAll(async () => {
  faceGate = await suspendFaceGate();
});
test.afterAll(async () => {
  await faceGate?.restore();
});

/** Random pixels, so PNG can't compress them and WebP has a real win to demonstrate. A flat or
 *  periodic image compresses better as PNG and would make this prove the opposite. */
async function noisyPng(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

test("images become WebP and text is gzipped, both downloading correctly", async () => {
  await withAdminRequest(async (ctx, headers) => {
    const projects = await (await ctx.get("/api/projects", { headers })).json();
    const created = await ctx.post("/api/tickets", {
      headers,
      data: { projectId: projects[0].id, title: `Attachment pipeline probe ${Date.now()}`, type: "BUG", priority: "LOW" }
    });
    expect(created.status(), await created.text()).toBe(201);
    const ticket = await created.json();

    try {
      const png = await noisyPng(600, 400);
      const csv = Buffer.from("date,hours,task\n2026-08-02,8,work\n".repeat(500));

      const uploaded: Array<Record<string, any>> = [];
      for (const file of [
        { name: "probe shot.png", mimeType: "image/png", buffer: png },
        { name: "probe data.csv", mimeType: "text/csv", buffer: csv }
      ]) {
        // One request per file: Playwright's `multipart` takes a single payload per field, and
        // the endpoint's behaviour per file is what's under test, not its array handling.
        const res = await ctx.post(`/api/tickets/${ticket.id}/attachments`, {
          headers: { Authorization: headers.Authorization },
          multipart: { attachments: file }
        });
        expect(res.status(), await res.text()).toBe(201);
        uploaded.push(...(await res.json()));
      }

      const image = uploaded.find((row) => row.fileCategory === "IMAGE")!;
      expect(image.compression).toBe("WEBP");
      expect(image.fileName).toMatch(/\.webp$/);
      expect(image.mimeType).toBe("image/webp");
      expect(image.sizeBytes).toBeLessThan(image.originalSizeBytes);
      expect(image.width).toBeGreaterThan(0);
      // Identifiable on disk without a database lookup: person, entity, original name, timestamp.
      expect(image.storageKey).toMatch(/^[a-z0-9-]+__ticket-[0-9a-f]{8}__probe-shot__\d{8}-\d{6}__[0-9a-f]{6}\.webp$/);

      const sheet = uploaded.find((row) => row.fileCategory === "SPREADSHEET")!;
      expect(sheet.compression).toBe("GZIP");
      expect(sheet.sizeBytes).toBeLessThan(sheet.originalSizeBytes);

      // THE ASSERTION THAT MATTERS: the gzipped file comes back byte-identical. A regression here
      // is a corrupt download served with HTTP 200 and no error anywhere.
      const csvDownload = await ctx.get(sheet.url);
      expect(csvDownload.status()).toBe(200);
      expect((await csvDownload.body()).equals(csv), "the gzipped CSV must round-trip exactly").toBe(true);

      // The WebP is served straight from disk — its stored length is what should arrive.
      const imageDownload = await ctx.get(image.url);
      expect(imageDownload.status()).toBe(200);
      expect((await imageDownload.body()).length).toBe(image.sizeBytes);
    } finally {
      await ctx.delete(`/api/tickets/${ticket.id}`, { headers });
    }
  });
});

test("attachments uploaded before the pipeline still download unchanged", async () => {
  await withAdminRequest(async (ctx, headers) => {
    // Rows with no storageKey predate the pipeline. If the demo data has none, there is nothing
    // to prove here — skipping is honest, inventing a fixture would test the new path twice.
    const tickets = await (await ctx.get("/api/tickets?limit=100", { headers })).json();
    const list = Array.isArray(tickets) ? tickets : (tickets.rows ?? tickets.data ?? []);

    let legacyUrl: string | null = null;
    for (const summary of list.slice(0, 40)) {
      const detail = await (await ctx.get(`/api/tickets/${summary.id}`, { headers })).json();
      const legacy = (detail.attachments ?? []).find((a: any) => !a.storageKey);
      if (legacy) {
        legacyUrl = legacy.url;
        break;
      }
    }
    test.skip(!legacyUrl, "no pre-pipeline attachment in the demo data to check against");

    const res = await ctx.get(legacyUrl!);
    expect(res.status(), `${legacyUrl} must still be served`).toBe(200);
    expect((await res.body()).length).toBeGreaterThan(0);
  });
});
