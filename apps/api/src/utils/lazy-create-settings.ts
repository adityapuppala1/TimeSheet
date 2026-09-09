/**
 * WHAT: makes losing a lazy-create race harmless, for the settings rows this application creates on
 * first read.
 *
 * THE PROBLEM. Six workspace-settings rows are singletons created lazily, by an `upsert` on the read
 * path — `getGlobalAISettings`, `getChangeSettings`, `getGlobalEmailIntakeSettings`,
 * `getFaceSettings`, `getGlobalMcpSettings`, `getGlobalNotificationSettings`. An `upsert` is NOT
 * atomic against a concurrent `upsert` of the same missing row: both callers find nothing, both
 * attempt the INSERT, and the loser gets `P2002 — Unique constraint failed on the constraint:
 * PRIMARY`. Prisma surfaces it and does not retry.
 *
 * WHEN IT ACTUALLY BITES, which is why it survived this long: only on a workspace whose row does not
 * exist yet, and only when two reads overlap. That is not an exotic condition — it is precisely a
 * newly provisioned tenant, whose first page load fires a dozen requests at once, and any
 * `Promise.all` that happens to read the same settings twice. It was found by running the weekly
 * practice update against a freshly created org: two concurrent `isChangeManagementOn()` calls
 * raced, and the report logged a Prisma error before falling back to "change management is off" —
 * a wrong answer, quietly, on the report's first ever run.
 *
 * WHY NOT A LOCK, OR A TRANSACTION. Losing this race is harmless by construction: the row the winner
 * created is exactly the row this caller wanted, with the same defaults. Serialising every settings
 * read for the entire life of a workspace, to protect one moment at the very start of it, would be
 * a permanent cost for a transient problem. Catching the violation and re-reading is both correct
 * and free on the path that runs a million times.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *  - It does not retry anything other than P2002. A dropped connection or a missing table must
 *    surface; retrying hides a real fault behind a second query that fails the same way.
 *  - It retries exactly ONCE. A P2002 from the re-read path means something other than this race is
 *    wrong, and looping would turn a broken index into a hot loop against the database.
 *  - When the re-read finds nothing, it rethrows the ORIGINAL violation rather than inventing a
 *    "not found". A P2002 with no row behind it is a different unique index being violated, and
 *    reporting it as a missing row sends somebody hunting the wrong bug.
 *
 * The same shape `service-health.service.ts` already uses inline for incident creation, extracted
 * because six copies of it is how five of them end up subtly different.
 */

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNIQUE_VIOLATION;
}

/**
 * Run a lazy-creating `upsert`, and treat losing the race to a concurrent one as success.
 *
 * @param upsert the `prisma.<model>.upsert(...)` that creates the row if it is missing
 * @param reread the `prisma.<model>.findUnique(...)` for the same row, used only when the race is lost
 */
export async function lazyCreateSettings<T>(upsert: () => Promise<T>, reread: () => Promise<T | null>): Promise<T> {
  try {
    return await upsert();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // Somebody else created it between our read and our write. Their row is our row.
    const row = await reread();
    if (row) return row;
    throw error;
  }
}
