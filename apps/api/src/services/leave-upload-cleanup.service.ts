/**
 * 7.0.0 — leave documents that never got attached to a request.
 *
 * POST /leave/me/requests stores the document BEFORE applyLeave validates the request (the file has
 * to be scanned and written to know its URL). When apply then fails — overlap, no balance, a bad
 * half — the file used to stay on disk with nothing pointing at it. Two layers:
 *   1. the route deletes the file it just wrote when apply throws (deleteStoredLeaveUpload);
 *   2. the daily leave worker sweeps any leave upload older than 24h that no LeaveRequest names
 *      (a crash between the write and the insert, or a delete that itself failed).
 *
 * Only files written by processUpload for entityType "leave" are considered: their names carry the
 * `__leave-` segment (attachment-storage.service.ts#namePrefix), so ticket and timesheet files are
 * never touched.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "../config/prisma.js";
import { documentsDirForOrg } from "../config/storage-paths.js";
import { requireTenantContext } from "../config/tenant-context.js";

export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const LEAVE_SEGMENT = "__leave-";

/** True for a disk name processUpload wrote for a leave document. Pure. */
export function isLeaveUploadName(name: string): boolean {
  return name.includes(LEAVE_SEGMENT) && path.basename(name) === name;
}

/** The public URL processUpload returned for a disk name (".gz" is on-disk only). Pure. */
export function publicUrlFor(orgId: string, diskName: string): string {
  return `/uploads/${orgId}/${encodeURIComponent(diskName.replace(/\.gz$/, ""))}`;
}

/** Deletes one just-written leave upload by its storage key ("<orgId>/<diskName>"). Never throws. */
export async function deleteStoredLeaveUpload(storageKey: string): Promise<void> {
  const [orgId, diskName, ...rest] = storageKey.split("/");
  if (!orgId || !diskName || rest.length > 0 || !isLeaveUploadName(diskName)) return;
  await fsp.rm(path.join(documentsDirForOrg(orgId), diskName), { force: true }).catch(() => undefined);
}

/** Deletes this org's leave uploads older than 24h that no request references. Returns the count. */
export async function sweepOrphanLeaveUploads(now: Date = new Date()): Promise<number> {
  const { orgId } = requireTenantContext();
  const dir = documentsDirForOrg(orgId);
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const old: string[] = [];
  for (const name of names) {
    if (!isLeaveUploadName(name)) continue;
    const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (stat?.isFile() && now.getTime() - stat.mtimeMs > ORPHAN_AGE_MS) old.push(name);
  }
  if (old.length === 0) return 0;
  const urls = old.map((n) => publicUrlFor(orgId, n));
  const used = await prisma.leaveRequest.findMany({ where: { attachmentUrl: { in: urls } }, select: { attachmentUrl: true } });
  const referenced = new Set(used.map((u) => u.attachmentUrl));
  let removed = 0;
  for (const name of old) {
    if (referenced.has(publicUrlFor(orgId, name))) continue;
    await fsp.rm(path.join(dir, name), { force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}
