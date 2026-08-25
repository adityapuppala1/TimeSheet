/**
 * WHAT: runs `prisma generate` for one schema, and survives the one failure that is not a failure.
 * Used by the `prisma:generate` / `control:generate` scripts, so `npm run setup` and `npm run
 * db:generate` both get the same treatment.
 *
 * ── THE PROBLEM, WHICH IS WINDOWS-ONLY AND ENTIRELY REPRODUCIBLE ────────────────────────────────
 *
 * Prisma writes the generated client in two parts: the TypeScript types first, then the native
 * query engine (`query_engine-windows.dll.node`) copied into place via a temp file and a rename.
 * On Windows a file cannot be replaced while a process has it mapped — and the API dev server maps
 * exactly that DLL for as long as it runs. So:
 *
 *     EPERM: operation not permitted, rename '…query_engine-windows.dll.node.tmp52360' -> '…node'
 *
 * `npm run setup` then aborts at step three of six, before migrating or seeding, on a machine where
 * nothing is actually wrong. Anyone who runs setup while their dev server is up hits it, which is
 * most people most of the time, and the message names a temp file rather than the cause.
 *
 * ── WHY CONTINUING IS CORRECT AND NOT A FUDGE ──────────────────────────────────────────────────
 *
 * The types are already written when the rename fails — that step comes first and succeeded. The
 * engine that could not be replaced is the SAME BUILD as the one being written: it is pinned by the
 * installed `prisma`/`@prisma/client` version, so a schema edit does not change it. Copying it over
 * itself is what failed, and skipping that copy leaves the tree correct.
 *
 * What this must NOT do is hide a real problem, so the leniency is narrow:
 *   * Only an EPERM/EBUSY on a `query_engine*` path is tolerated. Any other failure — a schema
 *     error, a bad datasource, a missing generator — still exits non-zero and stops the chain.
 *   * A Prisma version CHANGE genuinely does need the new engine, so the warning says exactly what
 *     to do (stop the dev server and re-run) rather than implying nothing happened.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = process.argv[2];

if (!schema) {
  console.error("[prisma] usage: node scripts/prisma-generate.mjs <path-to-schema.prisma>");
  process.exit(1);
}

const result = spawnSync("npx", ["prisma", "generate", "--schema", resolve(API_ROOT, schema)], {
  cwd: API_ROOT,
  encoding: "utf8",
  shell: process.platform === "win32"
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

if (result.status === 0) process.exit(0);

/** The engine-is-locked signature, and nothing broader. */
const lockedEngine = /(EPERM|EBUSY)[^\n]*query_engine/i.test(output);

if (!lockedEngine) {
  // A real generation failure — schema error, bad generator, missing dependency. Fail loudly.
  process.exit(result.status ?? 1);
}

console.warn(
  [
    "",
    "[prisma] The generated TypeScript client is up to date, but the native query engine could not",
    "[prisma] be replaced because a running process has it open — almost always `npm run dev`.",
    "[prisma] This is safe to continue past: the engine is pinned to the installed Prisma version,",
    "[prisma] so a schema change does not change it, and the types were written before this step.",
    "[prisma] If you have just CHANGED the Prisma version, stop the dev server and re-run",
    "[prisma] `npm run db:generate` so the new engine can be copied into place.",
    ""
  ].join("\n")
);
process.exit(0);
