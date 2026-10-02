/**
 * Where pre-deletion snapshots may live (H1).
 *
 * `PlatformRetentionSettings.snapshotDir` used to be any path an OPERATOR typed, and the snapshot
 * routes served whatever was in it — so pointing it at the uploads volume, or at the directory that
 * holds a non-container install's `.env`, turned `GET /backups/:id/download` into "read any file the
 * API can read". Every snapshot directory must now resolve inside SNAPSHOT_ROOT, an operator-of-the-
 * HOST decision made in the environment rather than one a console user can make from a browser.
 *
 * THE CHECK IS ON THE REAL PATH, NOT THE STRING. `..` is refused outright (the only reason to write
 * one is to climb out), and then the longest EXISTING prefix of both the candidate and the root is
 * put through realpath before the containment test — so a symlink, or a Windows junction, sitting
 * inside the root and pointing out of it is caught even though the string looks innocent. The part
 * that does not exist yet cannot be a link, because it does not exist.
 *
 * Re-checked on every READ as well as at save time (platform-backup.service.ts#resolveDirectory):
 * a value saved before this release, or a root that has since moved, must not keep serving files.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";

/** What the console has always suggested as the snapshot directory, so an install that followed
 *  the placeholder keeps working with SNAPSHOT_ROOT unset. */
export const DEFAULT_SNAPSHOT_ROOT = "/var/backups/timesphere-retention";

export function snapshotRoot(): string {
  return path.resolve(env.SNAPSHOT_ROOT || DEFAULT_SNAPSHOT_ROOT);
}

/** realpath of the longest prefix that exists, with the rest appended as written. */
async function realish(target: string): Promise<string> {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Validate a snapshot directory and return its absolute path. Relative input is taken relative to
 * the root, so "retention" means `<root>/retention`. Throws 422 naming the root when it escapes.
 */
export async function resolveSnapshotDir(input: string, root: string = snapshotRoot()): Promise<string> {
  const raw = input.trim();
  const refuse = () =>
    new AppError(422, `The snapshot directory must be inside ${root} (SNAPSHOT_ROOT on the API host). "${raw}" is not.`, { code: "SNAPSHOT_DIR_OUTSIDE_ROOT" });
  if (!raw || raw.includes("\0") || raw.split(/[\\/]+/).includes("..")) throw refuse();

  const candidate = path.resolve(root, raw);
  if (!isInside(root, candidate)) throw refuse();
  if (!isInside(await realish(root), await realish(candidate))) throw refuse();
  return candidate;
}

/** True when `full` is a regular file whose real location is inside `dir`'s real location. */
export async function isRegularFileInside(dir: string, full: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(full);
    if (!stat.isFile()) return false;
    return isInside(await fs.realpath(dir), await fs.realpath(full));
  } catch {
    return false;
  }
}
