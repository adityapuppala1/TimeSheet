/**
 * WHAT: the workspace's own logo and display name — read publicly (the login page needs it before
 * anyone signs in), written by a SUPER_ADMIN.
 *
 * WHY THE READ IS UNAUTHENTICATED, stated plainly because it is the one interesting decision here:
 * a company's logo on their own sign-in screen is public by construction — it is the first thing
 * shown to anyone who can reach the host at all. Everything else about the workspace stays behind
 * auth; this route exposes an image and a display name, nothing more, and it is scoped to the
 * tenant the request's host resolved to exactly like `/api/auth/sso-methods` above it.
 *
 * WHY NOT `/uploads`: every path under that prefix now requires a signed, expiring, org-bound
 * grant (app.ts), and no grant can be minted for a visitor who has not logged in. Rather than
 * carve an exception into that gate — the kind of exception that grows — the bytes live in their
 * own storage subtree that `/uploads` refuses outright, with this route as their only reader.
 *
 * WHO calls this: apps/web's Login page, AppLayout/Sidebar, and Workspace Settings → Branding.
 */
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { brandingDir } from "../config/storage-paths.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { avatarUpload, preserveTenantContext } from "../middleware/upload.js";
import { audit } from "../services/audit.service.js";
import { processBrandingLogo } from "../utils/image.js";

export const brandingRouter = Router();

const SINGLETON = "global";

async function readBranding() {
  return prisma.workspaceBranding.findUnique({ where: { id: SINGLETON } });
}

/** Public: what to render at the top of the login page and in the sidebar. */
brandingRouter.get("/", async (_req, res) => {
  const row = await readBranding();
  res.json({
    displayName: row?.displayName ?? null,
    // A cache-busting stamp rather than the filename: the client never needs to know what the
    // file is called, only that it changed.
    logoVersion: row?.logoFile ? row.updatedAt.getTime() : null,
    hasLogo: Boolean(row?.logoFile)
  });
});

/** Public: the image itself. 404 when unset — the client falls back to the product mark. */
brandingRouter.get("/logo", async (_req, res) => {
  const row = await readBranding();
  if (!row?.logoFile) throw new AppError(404, "No workspace logo is set.");

  // path.basename, not the stored value joined blindly: the column is written only by the upload
  // route below (a generated name), and this keeps that true even if a row is ever edited by hand.
  const file = path.join(brandingDir(), path.basename(row.logoFile));
  if (!fs.existsSync(file)) throw new AppError(404, "No workspace logo is set.");

  res.setHeader("Content-Type", row.logoMime ?? "image/png");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Immutable is safe because the filename changes on every upload and the client fetches with
  // ?v=<updatedAt> — a new logo is a new URL, never a stale cache.
  res.setHeader("Cache-Control", "public, max-age=86400");
  fs.createReadStream(file).pipe(res);
});

brandingRouter.post(
  "/logo",
  requireAuth,
  requireSuperAdmin,
  // Reuses the avatar uploader: same 5MB cap, same image-only allow-list, same re-encode through
  // sharp that strips EXIF and breaks polyglot files.
  preserveTenantContext(avatarUpload.single("logo")),
  async (req, res) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file?.buffer) throw new AppError(422, "No logo file provided");

    const dir = brandingDir();
    await fs.promises.mkdir(dir, { recursive: true });

    let processed;
    try {
      processed = await processBrandingLogo(file.buffer, dir);
    } catch {
      throw new AppError(422, "Could not decode image — corrupted or unsupported format");
    }

    const previous = await readBranding();
    const row = await prisma.workspaceBranding.upsert({
      where: { id: SINGLETON },
      update: { logoFile: processed.filename, logoMime: processed.mimeType, updatedById: req.user!.id },
      create: { id: SINGLETON, logoFile: processed.filename, logoMime: processed.mimeType, updatedById: req.user!.id }
    });
    await audit(req.user!.id, "workspace.logo_updated", "WorkspaceBranding", SINGLETON, {
      width: processed.width,
      height: processed.height,
      sizeBytes: processed.sizeBytes
    });

    // Best-effort: a leftover file costs a few KB, a failed unlink must not fail the upload.
    if (previous?.logoFile && previous.logoFile !== processed.filename) {
      fs.promises.unlink(path.join(dir, path.basename(previous.logoFile))).catch(() => undefined);
    }

    res.json({ displayName: row.displayName, hasLogo: true, logoVersion: row.updatedAt.getTime() });
  }
);

brandingRouter.delete("/logo", requireAuth, requireSuperAdmin, async (req, res) => {
  const previous = await readBranding();
  if (previous?.logoFile) {
    await prisma.workspaceBranding.update({
      where: { id: SINGLETON },
      data: { logoFile: null, logoMime: null, updatedById: req.user!.id }
    });
    fs.promises.unlink(path.join(brandingDir(), path.basename(previous.logoFile))).catch(() => undefined);
    await audit(req.user!.id, "workspace.logo_removed", "WorkspaceBranding", SINGLETON);
  }
  res.json({ displayName: previous?.displayName ?? null, hasLogo: false, logoVersion: null });
});

const nameSchema = z.object({
  body: z.object({ displayName: z.string().trim().max(60).nullable() })
});

brandingRouter.patch("/", requireAuth, requireSuperAdmin, validate(nameSchema), async (req, res) => {
  const displayName = req.body.displayName?.trim() || null;
  const row = await prisma.workspaceBranding.upsert({
    where: { id: SINGLETON },
    update: { displayName, updatedById: req.user!.id },
    create: { id: SINGLETON, displayName, updatedById: req.user!.id }
  });
  await audit(req.user!.id, "workspace.branding_updated", "WorkspaceBranding", SINGLETON, { displayName });
  res.json({
    displayName: row.displayName,
    hasLogo: Boolean(row.logoFile),
    logoVersion: row.logoFile ? row.updatedAt.getTime() : null
  });
});
