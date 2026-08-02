/**
 * WHAT: the running server's identity — version, git SHA, build date — resolved once at module
 * load and exported as a frozen constant.
 *
 * WHY A `VERSION` FILE AT THE REPO ROOT rather than package.json's version field: this is a
 * monorepo with three package.json files, and the api/web pair were both stuck at "1.0.0" since
 * the day they were created because nothing establishes which one is authoritative. One file, one
 * number, read by the API at boot, by the web build (vite.config.ts `define`), by the release
 * checklist, and by update.sh — they cannot disagree.
 *
 * RESOLUTION ORDER, and why each source exists:
 *  1. env vars (APP_VERSION / GIT_SHA / BUILD_DATE) — stamped into Docker images at build time by
 *     the Dockerfiles' ARG/ENV. In a container there is no .git and possibly no VERSION file at
 *     the expected relative path, so the image must carry its identity rather than derive it.
 *  2. the VERSION file — the dev/bare-metal path.
 *  3. "0.0.0-dev" — never crash over identity. A server that can't say its version is annoying;
 *     a server that won't BOOT because of a missing metadata file is broken.
 *
 * The git SHA is read from .git directly (HEAD → ref file) rather than by spawning `git`:
 * spawning at boot adds a dependency on git existing in the runtime image, which it deliberately
 * does not.
 */
import fs from "node:fs";
import path from "node:path";

function readVersionFile(): string | null {
  // Walk up from this file: dist layout is apps/api/dist/src/config → repo root is 5 up, and the
  // source layout (tsx) is 4 up. Checking a few levels covers both without caring which.
  let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (let i = 0; i < 7; i++) {
    const candidate = path.join(dir, "VERSION");
    try {
      const raw = fs.readFileSync(candidate, "utf8").trim();
      if (/^\d+\.\d+\.\d+/.test(raw)) return raw;
    } catch {
      /* keep walking */
    }
    dir = path.dirname(dir);
  }
  return null;
}

function readGitSha(): string | null {
  let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (let i = 0; i < 7; i++) {
    const gitDir = path.join(dir, ".git");
    try {
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      if (head.startsWith("ref: ")) {
        const sha = fs.readFileSync(path.join(gitDir, head.slice(5)), "utf8").trim();
        return sha.slice(0, 12);
      }
      return head.slice(0, 12); // detached HEAD is already a SHA
    } catch {
      /* keep walking */
    }
    dir = path.dirname(dir);
  }
  return null;
}

export const appVersion = Object.freeze({
  /** Semver, e.g. "1.1.0". */
  version: process.env.APP_VERSION?.trim() || readVersionFile() || "0.0.0-dev",
  /** Short git SHA, or null when neither env nor .git can supply one (e.g. a stripped image). */
  gitSha: process.env.GIT_SHA?.trim() || readGitSha(),
  /** ISO date the image was built, or process start for dev — "how stale is this?" either way. */
  builtAt: process.env.BUILD_DATE?.trim() || new Date().toISOString()
});
