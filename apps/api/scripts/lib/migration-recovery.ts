/**
 * Recovering a database that a failed migration left blocked — detection, the safety rule that
 * decides whether the doctor may fix it unattended, and the instructions for when it may not.
 *
 * WHY THIS IS ITS OWN MODULE: it lives here rather than inline in `doctor.ts` because the parts
 * worth testing are the ones that decide whether to touch a production database. `doctor.ts` calls
 * `main()` at import time — importing it from a test would run the doctor — so the logic is
 * extracted rather than the script restructured.
 *
 * WHAT P3009 MEANS: a previous run left a migration recorded as failed in `_prisma_migrations`.
 * Prisma then refuses to apply ANYTHING, including a corrected version of the very migration that
 * broke, until a human records a verdict on the failed one. Its own error text says as much, but
 * it says it via a docs link that leads with `migrate reset` — and an operator who is already
 * frustrated reads "reset" and drops the database.
 *
 * ── THE SAFETY RULE ──────────────────────────────────────────────────────────────────────────
 *
 * The recovery is `migrate resolve --rolled-back` (which clears the failed record) followed by
 * `migrate deploy` (which RE-RUNS the file over whatever the failed attempt already managed to
 * apply). That is safe only when re-running the file is safe, and that is a property only the
 * migration's author can vouch for. Consider `UPDATE Ledger SET total = total + 1`: re-running it
 * after a failure that happened LATER in the file silently doubles every row. No amount of
 * inspection by this script can tell that apart from an idempotent backfill.
 *
 * So the doctor never guesses. A migration is auto-recoverable only if it says so itself, with a
 * `@rerunnable` marker in a SQL comment. Everything else gets printed instructions and a human.
 *
 * The marker is a promise about two things:
 *   1. Re-running the whole file over its own partial effects completes — DDL is guarded against
 *      already existing (see `docs/DATABASE.md`, trap 3), and
 *   2. re-running its data changes is idempotent — running twice equals running once.
 */
import fs from "node:fs";
import path from "node:path";

/** The directory-name format Prisma quotes back: 14 digits, underscore, slug. */
const MIGRATION_NAME_RE = /`(\d{14}_[A-Za-z0-9_]+)`/;

/**
 * The author's declaration that this migration survives being re-run over a partial application.
 * Deliberately verbose and unusual — nothing types it by accident.
 */
export const RERUNNABLE_MARKER = "@rerunnable";

/** Whether this output is the "a previous migration is recorded as failed" error. */
export function isP3009(output: string): boolean {
  return output.includes("P3009");
}

/**
 * The migration Prisma named as failed, or `null` if this was a different error or Prisma changed
 * how it phrases this one. Returning null is what makes the caller fall back to instructions
 * rather than run `resolve` against a guessed name.
 */
export function failedMigrationName(output: string): string | null {
  if (!isP3009(output)) return null;
  return MIGRATION_NAME_RE.exec(output)?.[1] ?? null;
}

/**
 * Whether `<migrationsDir>/<name>/migration.sql` carries the author's re-runnable declaration.
 *
 * Requires the marker to sit in a `--` comment. That is not decoration: it means the marker is
 * part of the migration file Prisma checksums, so it cannot be added by anything other than an
 * edit to the migration itself.
 *
 * AND REQUIRES THE COMMENT TO BE THE DECLARATION AND NOTHING ELSE — `-- @rerunnable`, optionally
 * followed by `:` and a reason. This started as "any comment line mentioning the marker", which
 * quietly meant that a migration DISCUSSING the marker declared it. One arrived whose prose reads
 * "The file is NOT marked `@rerunnable`" and which this function therefore reported as marked:
 * a file that said the opposite of what the tool did with it, and an unattended auto-heal its
 * author had explicitly declined. A declaration has to be a statement, not a mention.
 */
export function isRerunnable(migrationsDir: string, name: string): boolean {
  // `name` comes from Prisma's own output, but it is about to be used to build a path — reject
  // anything that is not the exact directory shape rather than trusting the source.
  if (!/^\d{14}_[A-Za-z0-9_]+$/.test(name)) return false;
  const file = path.join(migrationsDir, name, "migration.sql");
  let sql: string;
  try {
    sql = fs.readFileSync(file, "utf8");
  } catch {
    // No file means this database ran a migration this checkout does not have — a downgrade, or a
    // different branch. Re-running something we cannot read is exactly the wrong move.
    return false;
  }
  return sql.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("--")) return false;
    // Strip the comment opener, then require what remains to BE the marker — not to contain it.
    const body = trimmed.slice(2).trim();
    if (body === RERUNNABLE_MARKER) return true;
    return body.startsWith(`${RERUNNABLE_MARKER}:`);
  });
}

/**
 * The manual recovery, for when the doctor may not act: a different error, an unreadable
 * migration, or one whose author has not vouched for re-running it.
 *
 * @param output  everything the failed `prisma migrate deploy` printed (stdout + stderr).
 * @param schema  the `--schema=` value to repeat in the suggested commands.
 * @returns the recovery block, or `null` when this was not a P3009 — the caller then falls back to
 *          its generic advice rather than guessing.
 */
export function p3009Recovery(output: string, schema: string): string | null {
  if (!isP3009(output)) return null;
  const target = failedMigrationName(output) ?? "<the migration named above>";
  return (
    `\n  HOW TO FIX THIS (no data is dropped):\n` +
    `    cd apps/api          <- this exact directory; the commands below need it\n` +
    `    npx prisma migrate resolve --rolled-back ${target} --schema=${schema}\n` +
    `    npx prisma migrate deploy --schema=${schema}\n\n` +
    `  The first command clears the failed record so the migration is retried; the second re-runs\n` +
    `  it. Do NOT run \`prisma migrate reset\` — that DROPS the database.\n\n` +
    `  The doctor did not do this for you because the migration does not declare itself safe to\n` +
    `  re-run (a \`${RERUNNABLE_MARKER}\` marker in its SQL comments). Re-running a migration whose\n` +
    `  data changes are not idempotent can double them, so it needs a human who knows the file.\n` +
    `  See docs/DATABASE.md.`
  );
}
