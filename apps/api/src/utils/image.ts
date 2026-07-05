/**
 * WHAT: `processAvatar()` — re-encodes an uploaded avatar image buffer through `sharp` and
 * writes the result to disk.
 * WHY: an uploaded image is untrusted input in more ways than "wrong file type" — see
 * middleware/upload.ts#avatarUpload's comment for the three concrete risks (leaked EXIF/location
 * metadata, polyglot files that are simultaneously a valid image and valid JS/HTML, oversized
 * decompression bombs) this re-encode step closes off, on top of the extension/MIME allow-list.
 * WHO calls this: `auth.controller.ts`'s avatar upload route, after `avatarUpload` (multer,
 * memory storage) has already gated on extension/MIME.
 */
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
