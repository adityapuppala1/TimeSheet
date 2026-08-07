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
import { accessToken, signIn } from "./helpers/sign-in";

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
      // Identifiable on disk without a database lookup: org, then person, entity, original name,
      // timestamp. The leading org segment is what a delete path joins onto the documents
      // directory — a key that resolved somewhere other than the URL did would leave orphans —
      // and it is also the tenancy the /uploads gate checks the signed grant against.
      expect(image.storageKey).toMatch(
        /^[0-9a-f-]{36}\/[a-z0-9-]+__ticket-[0-9a-f]{8}__probe-shot__\d{8}-\d{6}__[0-9a-f]{32}\.webp$/
      );

      const sheet = uploaded.find((row) => row.fileCategory === "SPREADSHEET")!;
      expect(sheet.compression).toBe("GZIP");
      expect(sheet.sizeBytes).toBeLessThan(sheet.originalSizeBytes);

      // /uploads is no longer public: the URL leaving the API must already carry its grant. A
      // route that emitted a bare path would 403 on download, so checking the SHAPE here says
      // which half broke when it does.
      for (const row of [image, sheet]) {
        expect(row.url, `${row.fileName} left the API without a signed grant`).toMatch(/\?o=[^&]+&e=\d+&s=[\w-]{22}$/);
      }

      // THE ASSERTION THAT MATTERS: the gzipped file comes back byte-identical. A regression here
      // is a corrupt download served with HTTP 200 and no error anywhere.
      const csvDownload = await ctx.get(sheet.url);
      expect(csvDownload.status(), await csvDownload.text()).toBe(200);
      expect((await csvDownload.body()).equals(csv), "the gzipped CSV must round-trip exactly").toBe(true);

      // The WebP is served straight from disk — its stored length is what should arrive.
      const imageDownload = await ctx.get(image.url);
      expect(imageDownload.status(), await imageDownload.text()).toBe(200);
      expect((await imageDownload.body()).length).toBe(image.sizeBytes);

      // And the grant is the whole control: strip it and the same path must be refused, or the
      // signing pass is decoration rather than access control.
      const unsigned = await ctx.get(image.url.split("?")[0]);
      expect(unsigned.status(), "an unsigned /uploads path must not be served").toBe(403);
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

/**
 * THE SAME LOCKDOWN, FROM A BROWSER — which is where it can break without any API test noticing.
 *
 * A signed URL only reaches the page because `res.json` is wrapped and every `/uploads/...` string
 * in the body is rewritten on the way out. Two things follow, and both are silent failures:
 *
 *  - anything that leaves the API in a NON-JSON shape is never signed, so it 403s the moment a
 *    browser asks for it;
 *  - anything the WEB app builds itself out of a stored path (rather than using the URL the API
 *    handed it) has no grant either.
 *
 * Neither shows up as an error in the app. An `<img>` whose request 403s renders as nothing, and a
 * download link that 403s produces a page of JSON with a .pdf name. So this asserts DECODED pixels
 * and a resolved link, not merely that an element exists.
 */
test.describe("signed file URLs survive the round trip to a real browser", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("avatars decode and a ticket attachment link resolves", async ({ page }) => {
    await signIn(page, "superadmin");

    // Avatars are optional demo data — a workspace where nobody uploaded one has nothing to prove
    // here, and inventing a fixture would exercise the upload path instead of the read path.
    const avatar = page.locator("img[src*='/uploads/avatars/']").first();
    let hasAvatar = true;
    try {
      await avatar.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      hasAvatar = false;
    }
    test.skip(!hasAvatar, "no avatar in the demo data to render");

    expect(await avatar.getAttribute("src"), "the avatar src reached the page without a grant").toMatch(
      /\?o=[^&]+&e=\d+&s=/
    );
    await expect
      .poll(
        () => avatar.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0),
        { message: "the avatar must decode — a 403 body would leave naturalWidth at 0", timeout: 15_000 }
      )
      .toBe(true);

    // And an attachment, through the ticket sheet the way a person reaches one. Created here
    // rather than hunting the demo data, so the assertion is about a file this run can account for.
    const headers = await accessToken(page);
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const ticket = await (
      await page.request.post("/api/tickets", {
        headers,
        data: { projectId: projects[0].id, title: `Signed attachment probe ${Date.now()}`, type: "BUG", priority: "LOW" }
      })
    ).json();

    try {
      const uploaded = await page.request.post(`/api/tickets/${ticket.id}/attachments`, {
        headers,
        multipart: {
          attachments: { name: "signed probe.csv", mimeType: "text/csv", buffer: Buffer.from("date,hours\n2026-08-07,8\n") }
        }
      });
      expect(uploaded.status(), await uploaded.text()).toBe(201);

      await page.goto(`/app/tickets?open=${ticket.id}`);
      await page.getByRole("tab", { name: /files/i }).click();
      const link = page.getByRole("link", { name: "signed probe.csv" });
      await expect(link).toBeVisible({ timeout: 15_000 });

      const href = await link.getAttribute("href");
      expect(href, "the attachment href reached the page without a grant").toMatch(/\?o=[^&]+&e=\d+&s=/);
      // Fetched through the PAGE's context, so this is the request the browser would actually make
      // when someone clicks it — cookies, origin and all.
      const fetched = await page.request.get(href!);
      expect(fetched.status(), `clicking the attachment link returned ${fetched.status()}`).toBe(200);
      expect((await fetched.body()).toString("utf8")).toContain("date,hours");
    } finally {
      await page.request.delete(`/api/tickets/${ticket.id}`, { headers });
    }
  });
});
