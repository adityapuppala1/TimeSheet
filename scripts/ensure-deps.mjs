/**
 * WHAT: makes `node_modules` match `package-lock.json` before anything tries to import from it.
 * Runs automatically ahead of `npm run dev` and `npm run build` (the `predev` / `prebuild` hooks
 * in the root package.json), and is safe to run directly.
 *
 * WHY IT EXISTS: pulling a release that ADDS a dependency and then running `npm run dev` failed
 * with `Cannot find package '…'` — a stack trace deep inside Vite that names a package the reader
 * never heard of and does not say "run npm install". Every release that adds one reproduces it,
 * and `ogl` (the loader animation, 3.3.0) is the most recent. The fix people eventually find is a
 * command the tool could simply have run itself.
 *
 * HOW IT DECIDES, and why not just "is node_modules missing":
 *   * No `node_modules` at all -> install. The fresh-clone case.
 *   * `package-lock.json` NEWER than the install stamp -> install. This is the pull case, and it is
 *     the one a presence check misses entirely: `node_modules` exists, it is simply stale.
 *   * Otherwise -> do nothing, and say nothing. This runs before every `dev`, so a healthy tree
 *     must cost one `stat` and no output.
 *
 * The stamp is `node_modules/.timesphere-deps-stamp`, written after a successful install. It
 * records the lockfile's mtime at the moment we installed, which is exactly the question being
 * asked; npm's own `.package-lock.json` is not a reliable proxy because it is rewritten by
 * partial installs (`npm i <one-pkg>`) that leave the tree correct for a DIFFERENT lockfile.
 *
 * WHY `npm install` AND NOT `npm ci`: `ci` deletes `node_modules` and reinstalls from scratch —
 * correct for a build machine, needlessly slow for a developer who pulled one new package, and
 * destructive if they have a local link in there. CI calls `npm ci` itself, before this ever runs.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCKFILE = join(ROOT, "package-lock.json");
const MODULES = join(ROOT, "node_modules");
const STAMP = join(MODULES, ".timesphere-deps-stamp");

/** Why an install is needed, or null when it is not. */
function reasonToInstall() {
  if (!existsSync(MODULES)) return "node_modules is missing (fresh clone)";
  if (!existsSync(LOCKFILE)) return null; // Nothing to compare against; leave the tree alone.
  if (!existsSync(STAMP)) return "dependencies have never been verified against the lockfile";

  try {
    const stamped = Number(readFileSync(STAMP, "utf8").trim());
    const lockMtime = statSync(LOCKFILE).mtimeMs;
    // A millisecond of tolerance: some filesystems (and git checkouts) round mtimes, and a
    // reinstall on every `dev` because of sub-millisecond drift would be its own annoyance.
    if (!Number.isFinite(stamped) || lockMtime > stamped + 1) {
      return "package-lock.json changed since the last install (did you just pull?)";
    }
  } catch {
    return "the dependency stamp could not be read";
  }
  return null;
}

function stamp() {
  try {
    writeFileSync(STAMP, String(statSync(LOCKFILE).mtimeMs), "utf8");
  } catch {
    // A stamp we cannot write costs one redundant install next time — never a failure.
  }
}

const reason = reasonToInstall();
if (!reason) {
  // Silent on the happy path. This runs before every `npm run dev`; a line here would be noise
  // printed hundreds of times a week to say nothing happened.
  process.exit(0);
}

console.log(`[deps] ${reason}`);
console.log("[deps] running npm install — this is automatic, and only happens when it is needed.");

try {
  execSync("npm install --no-audit --no-fund", { cwd: ROOT, stdio: "inherit" });
  stamp();
  console.log("[deps] dependencies are up to date.");
} catch {
  // Do NOT fail the command. A developer offline, or behind a registry that is briefly down, still
  // has a working tree most of the time — let them find out from the real error if something is
  // genuinely missing, rather than being blocked by the healer.
  console.warn("[deps] npm install did not complete. Continuing anyway — run `npm install` by hand if the app fails to start.");
}
