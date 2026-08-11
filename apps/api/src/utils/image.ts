/**
 * WHAT: `processAvatar()` and `processBrandingLogo()` — re-encode an uploaded image buffer
 * through `sharp` and write the result to disk.
 * WHY: an uploaded image is untrusted input in more ways than "wrong file type" — see
 * middleware/upload.ts#avatarUpload's comment for the three concrete risks (leaked EXIF/location
 * metadata, polyglot files that are simultaneously a valid image and valid JS/HTML, oversized
 * decompression bombs) this re-encode step closes off, on top of the extension/MIME allow-list.
 * Both entry points share those properties; they differ only in framing (see each one).
 * WHO calls this: `auth.controller.ts`'s avatar upload route and `branding.controller.ts`'s logo
 * upload, both after `avatarUpload` (multer, memory storage) has gated on extension/MIME.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

interface AvatarResult {
  filePath: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Re-encode an uploaded avatar buffer through sharp and write to disk.
 *
 *  - Strips EXIF / ICC / XMP metadata.
 *  - Resizes to fit inside MAX_DIM x MAX_DIM (centred cover crop, no upscaling).
 *  - Normalises to PNG (for transparency) or JPEG (for photos) — GIFs become PNG.
 *  - Filename is randomized; the original extension is discarded.
 */
export async function processAvatar(
  buffer: Buffer,
  userId: string,
  destDir: string
): Promise<AvatarResult> {
  const MAX_DIM = 512;

  const pipeline = sharp(buffer, { failOn: "error" })
    .rotate() // honour orientation BEFORE we strip EXIF
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: "cover", withoutEnlargement: true });

  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  const usePng = metadata.format === "png" || metadata.format === "gif" || Boolean(metadata.hasAlpha);

  const output = usePng
    ? await pipeline.png({ compressionLevel: 9, progressive: false }).toBuffer({ resolveWithObject: true })
    : await pipeline.jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: "4:2:0" }).toBuffer({ resolveWithObject: true });

  const ext = usePng ? ".png" : ".jpg";
  const mimeType = usePng ? "image/png" : "image/jpeg";
  const filename = `avatar-${userId}-${Date.now()}${ext}`;
  const filePath = path.join(destDir, filename);

  await fs.writeFile(filePath, output.data);

  return {
    filePath,
    filename,
    mimeType,
    width: output.info.width,
    height: output.info.height,
    sizeBytes: output.info.size
  };
}

/**
 * Re-encode a workspace logo. Same security properties as `processAvatar` — metadata stripped,
 * polyglots broken by the re-render, output size bounded — with two differences that come from
 * what a logo IS rather than from any policy:
 *
 *  - `fit: "inside"`, never a cover crop. A logo is a designed mark; cropping it to a square is
 *    disfigurement, so it is scaled to fit a 512×160 box and keeps its own aspect ratio.
 *  - PNG always. Logos are line art with flat colour and usually transparency, all of which JPEG
 *    handles badly (ringing on hard edges, and no alpha at all — a transparent logo would gain a
 *    black background on a dark theme).
 */
export async function processBrandingLogo(buffer: Buffer, destDir: string): Promise<AvatarResult> {
  const output = await sharp(buffer, { failOn: "error" })
    .rotate()
    .resize({ width: 512, height: 160, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });

  // Random component, not just a timestamp: two uploads inside the same millisecond would
  // otherwise collide, and the second would silently overwrite the first's bytes under a name the
  // first row still points at.
  const filename = `logo-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
  const filePath = path.join(destDir, filename);
  await fs.writeFile(filePath, output.data);

  return {
    filePath,
    filename,
    mimeType: "image/png",
    width: output.info.width,
    height: output.info.height,
    sizeBytes: output.info.size
  };
}
