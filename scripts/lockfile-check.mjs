#!/usr/bin/env node
/**
 * Fails when package-lock.json would be refused by `npm ci` on npm 10 (Node 22) — the check the
 * pre-push gate runs (scripts/local-ci.mjs).
 *
 * WHY. npm 11 (Node 24) accepts a lockfile that npm 10 rejects as "not in sync" (missing nested
 * entries it insists on). A lockfile written on npm 11 passed every local check and then failed
 * every CI job and the installer on 2026-10-05, because those ran Node 22. CI and the images are on
 * Node 24 now, but customers and manual installs on Node 22 still run `npm ci`. Works on a copy of the
 * manifests in a temp folder, so the developer's node_modules is never touched.
 *
 * Fix when it fails:  npx -y npm@10 install --package-lock-only --ignore-scripts
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "lockcheck-"));
try {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const workspaces = Object.keys(lock.packages).filter((k) => k && !k.includes("node_modules"));
  for (const rel of ["", ...workspaces]) {
    fs.mkdirSync(path.join(work, rel), { recursive: true });
    fs.copyFileSync(path.join(root, rel, "package.json"), path.join(work, rel, "package.json"));
  }
  fs.copyFileSync(path.join(root, "package-lock.json"), path.join(work, "package-lock.json"));
  // One command string through the shell: on Windows npx is a .cmd, which Node only runs via a shell,
  // and an args array alongside `shell` is deprecated (DEP0190). Nothing here is user input.
  const r = spawnSync("npx -y npm@10 ci --dry-run --ignore-scripts --no-audit --no-fund", { cwd: work, encoding: "utf8", shell: true });
  if (r.status !== 0) {
    const missing = (r.stderr || "").split("\n").filter((l) => /Missing|in sync|Invalid/.test(l)).slice(0, 6).join("\n");
    console.error(`[lockfile] npm 10 would refuse package-lock.json:\n${missing || r.stderr}\n` +
      "[lockfile] fix: npx -y npm@10 install --package-lock-only --ignore-scripts");
    process.exit(1);
  }
  console.log("[lockfile] accepted by npm 10 and the npm you are running.");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
