/**
 * The workspace logo is the first uploaded asset served OUTSIDE the signed-grant gate, so the two
 * properties that keep that safe are pinned here rather than left to a reviewer's memory:
 *
 *  1. `/uploads` must refuse the branding tree outright. Its reader is one route that resolves the
 *     tenant from the request host; a second, unauthenticated door to the same bytes through the
 *     static mounts would be a scoping bug waiting for someone to guess a filename.
 *  2. The re-encode must preserve aspect ratio. A cover crop is right for an avatar and wrong for
 *     a logo — a designed mark squared off is disfigured, and nobody would call that a feature.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { brandingDir, isInsideNonPublicSubtree } from "../../src/config/storage-paths.js";
import { processBrandingLogo } from "../../src/utils/image.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-branding-"));
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe("branding storage is off the public /uploads path", () => {
  it("refuses any /uploads request that resolves into the branding tree", () => {
    expect(isInsideNonPublicSubtree(path.join(brandingDir(), "logo-1.png"))).toBe(true);
    expect(isInsideNonPublicSubtree(brandingDir())).toBe(true);
  });

  it("still allows an ordinary document path", () => {
    // Guards the guard: a containment check that returns true for everything would pass the
    // assertion above while breaking every attachment in the product.
    expect(isInsideNonPublicSubtree(path.join(brandingDir(), "..", "some-attachment.pdf"))).toBe(false);
  });
});

describe("processBrandingLogo", () => {
  it("scales a wide logo to fit without cropping it square", async () => {
    const wide = await sharp({
      create: { width: 1200, height: 200, channels: 4, background: { r: 10, g: 80, b: 200, alpha: 1 } }
    })
      .png()
      .toBuffer();

    const result = await processBrandingLogo(wide, tempDir);

    // 1200x200 fits inside 512x160 by width: 512x85 (ratio preserved), NOT 512x160 or a square.
    expect(result.width).toBe(512);
    expect(result.height).toBe(85);
    expect(result.mimeType).toBe("image/png");
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it("never enlarges a small logo, and always writes PNG so transparency survives", async () => {
    const small = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .png()
      .toBuffer();

    const result = await processBrandingLogo(small, tempDir);
    expect(result.width).toBe(64);
    expect(result.height).toBe(64);
    // A JPEG re-encode would silently paint a transparent mark onto black, which is precisely the
    // failure this format choice exists to prevent.
    expect((await sharp(result.filePath).metadata()).format).toBe("png");
  });

  it("gives every upload a distinct filename", async () => {
    const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#fff" } }).png().toBuffer();
    const [a, b] = await Promise.all([processBrandingLogo(png, tempDir), processBrandingLogo(png, tempDir)]);
    // Same millisecond is entirely possible here — a timestamp alone would have collided and the
    // second write would have clobbered bytes the first row still names.
    expect(a.filename).not.toBe(b.filename);
  });
});
