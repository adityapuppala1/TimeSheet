#!/usr/bin/env node
/**
 * Installs the `pre-push` hook that runs scripts/local-ci.mjs. Called from `npm install` (`prepare`).
 *
 * Writes .git/hooks/pre-push rather than switching `core.hooksPath`, because .git/hooks already holds
 * graphify's post-commit/post-checkout hooks and moving the hooks path would silently disable them.
 * Never fails an install: no .git (a Docker build layer, a tarball) simply means nothing to install.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MARK = "# timesphere-local-ci";
try {
  const hooks = path.resolve(execSync("git rev-parse --git-path hooks", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  const file = path.join(hooks, "pre-push");
  if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes(MARK)) {
    console.log(`[hooks] ${file} exists and is not ours — left alone. Add \`node scripts/local-ci.mjs\` to it yourself.`);
    process.exit(0);
  }
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(
    file,
    `#!/bin/sh\n${MARK}\n# Runs the CI gate locally before a push. Skip in an emergency: git push --no-verify\n` +
      `# Pushing only tags or deleting refs needs no check.\n` +
      `needs=0\nwhile read local_ref local_sha remote_ref remote_sha; do\n` +
      `  case "$local_ref" in refs/heads/*) [ "$local_sha" != "0000000000000000000000000000000000000000" ] && needs=1 ;; esac\n` +
      `done\n[ "$needs" = 1 ] || exit 0\nexec node scripts/local-ci.mjs\n`,
    { mode: 0o755 }
  );
  console.log("[hooks] pre-push → scripts/local-ci.mjs installed.");
} catch {
  // Not a git checkout: nothing to install.
}
