#!/usr/bin/env node
/**
 * The CI gate, run on this machine before a push — `npm run ci:local`, and the `pre-push` hook.
 *
 * WHY. The repo is private, so every CI minute is billed against a 2,000-minute month, and CI used to
 * be the first place a broken push was discovered. This runs the same cheap-tier checks as
 * `.github/workflows/ci.yml` → "Build, typecheck, unit + integration": lint (both typechecks + the
 * Sonar/promise rules + the warning ratchet), the production-dependency audit gate, and both unit
 * suites. Integration (real MySQL), e2e and the installer jobs stay on CI's `main` run.
 *
 * A passing tree is remembered in .git/local-ci-passed, so pushing one commit to a branch and then to
 * `main` checks it once, and a later push whose only changes since a pass are docs is not re-checked.
 *
 * Escape hatch for an emergency: `git push --no-verify` (CI on `main` still runs everything).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Argument arrays, never a shell string: on Windows a shell is cmd.exe, where `^` in `HEAD^{tree}` is
// an escape character and the revision silently becomes something else.
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
process.chdir(root);
const record = path.join(git("rev-parse", "--git-common-dir"), "local-ci-passed");
const DOCS_ONLY = /^(docs\/|.*\.md$|\.env\.example$|LICENSE$|\.gitignore$)/;

const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
const tree = git("rev-parse", "HEAD^{tree}");
const passed = fs.existsSync(record) ? fs.readFileSync(record, "utf8").split("\n").filter(Boolean) : [];

if (!dirty && !process.argv.includes("--force")) {
  if (passed.includes(tree)) {
    console.log(`[local-ci] ${tree.slice(0, 8)} already passed here — skipping.`);
    process.exit(0);
  }
  const last = passed.at(-1);
  if (last) {
    const changed = spawnSync("git", ["diff", "--name-only", last, tree], { encoding: "utf8" });
    const files = changed.status === 0 ? changed.stdout.split("\n").filter(Boolean) : null;
    if (files && files.length > 0 && files.every((f) => DOCS_ONLY.test(f))) {
      console.log("[local-ci] only docs changed since the last pass — skipping.");
      fs.appendFileSync(record, `${tree}\n`);
      process.exit(0);
    }
  }
}
if (dirty) console.log("[local-ci] note: uncommitted changes are present; checking the working tree, and not recording the result.");

const steps = [
  ["Lint (typechecks + Sonar rules + ratchet)", "npm run lint"],
  ["Audit production dependencies", "node scripts/audit-gate.mjs"],
  ["API unit tests", "npm run test -w apps/api"],
  ["Web unit tests", "npm run test -w apps/web"]
];
const started = Date.now();
for (const [name, cmd] of steps) {
  const t = Date.now();
  console.log(`\n[local-ci] ▶ ${name}`);
  const r = spawnSync(cmd, { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\n[local-ci] ✗ ${name} failed — push stopped. Fix it, or \`git push --no-verify\` in an emergency.`);
    process.exit(1);
  }
  console.log(`[local-ci] ✓ ${name} (${Math.round((Date.now() - t) / 1000)}s)`);
}
if (!dirty) fs.appendFileSync(record, `${tree}\n`);
console.log(`\n[local-ci] all green in ${Math.round((Date.now() - started) / 1000)}s.`);
