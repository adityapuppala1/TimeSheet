/**
 * Turning Prisma's P3009 into instructions someone can follow at 2am.
 *
 * WHY THIS IS ITS OWN MODULE: it lives here rather than inline in `doctor.ts` because the one
 * thing worth testing about it is that its regex still matches Prisma's wording. `doctor.ts` calls
 * `main()` at import time — importing it from a test would run the doctor — so the helper is
 * extracted rather than the script restructured.
 *
 * WHAT P3009 MEANS: a previous run left a migration recorded as failed in `_prisma_migrations`.
 * Prisma then refuses to apply ANYTHING, including a corrected version of the very migration that
 * broke, until a human records a verdict on the failed one. Its own error text says as much, but
 * it says it via a docs link that leads with `migrate reset` — and an operator who is already
 * frustrated reads "reset" and drops the database. The whole point of this function is that the
 * safe command appears in the terminal, spelled out, at the moment of failure.
 */

/** The directory-name format Prisma quotes back: 14 digits, underscore, slug. */
const MIGRATION_NAME_RE = /`(\d{14}_[A-Za-z0-9_]+)`/;

/**
 * @param output  everything the failed `prisma migrate deploy` printed (stdout + stderr).
 * @param schema  the `--schema=` value to repeat in the suggested commands.
 * @returns the recovery block, or `null` when this was not a P3009 — the caller then falls back to
 *          its generic advice rather than guessing.
 */
export function p3009Recovery(output: string, schema: string): string | null {
  if (!output.includes("P3009")) return null;
  // Pull the migration out of Prisma's message so the operator pastes a command instead of
  // transcribing a 40-character directory name. The placeholder keeps the block useful if Prisma
  // ever changes how it names the migration.
  const target = MIGRATION_NAME_RE.exec(output)?.[1] ?? "<the migration named above>";
  return (
    `\n  HOW TO FIX THIS (no data is dropped):\n` +
    `    cd apps/api\n` +
    `    npx prisma migrate resolve --rolled-back ${target} --schema=${schema}\n` +
    `    npx prisma migrate deploy --schema=${schema}\n\n` +
    `  The first command clears the failed record so the migration is retried; the second re-runs\n` +
    `  it. Do NOT run \`prisma migrate reset\` — that DROPS the database. If \`deploy\` then fails\n` +
    `  with a duplicate column or index, that migration is not re-runnable over its own partial\n` +
    `  effects: stop and see docs/DATABASE.md rather than improvising.`
  );
}
