import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});

/**
 * Compute the MySQL-friendly UTC offset for the Node process's effective timezone.
 *
 * MySQL's `SET time_zone` accepts either an IANA name (only if mysql_tzinfo_to_sql
 * has been imported, which is rare in dev setups) or an offset like '+05:30'.
 * We always send the offset form for max compatibility.
 */
function currentOffsetForMysql(): string {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const h = Math.floor(Math.abs(offsetMinutes) / 60).toString().padStart(2, "0");
  const m = (Math.abs(offsetMinutes) % 60).toString().padStart(2, "0");
  return `${sign}${h}:${m}`;
}

/**
 * Align MySQL's timezone with the Node process timezone so `@default(now())`
 * columns, `NOW()` calls in raw SQL, and TIMESTAMP-typed columns render in IST
 * (or whatever TZ the API is running in).
 *
 * Strategy:
 *  - `SET GLOBAL time_zone`: affects every connection in the pool. Requires
 *    SUPER / SYSTEM_VARIABLES_ADMIN privilege. Root has it; least-privileged
 *    deployment users may not — we tolerate the failure and continue.
 *  - `SET SESSION time_zone`: ensures the connection that ran SET GLOBAL also
 *    sees the new value immediately (GLOBAL only affects *new* connections).
 *
 * Logs the effective values so the operator can verify at boot.
 */
export interface DatabaseTimezoneSnapshot {
  offset: string;
  globalApplied: boolean;
  sessionApplied: boolean;
  sessionTimeZone: string | null;
  globalTimeZone: string | null;
  now: string | null;
  errors: string[];
}

export async function applyDatabaseTimezone(): Promise<DatabaseTimezoneSnapshot> {
  const offset = currentOffsetForMysql();
  const errors: string[] = [];
  let globalApplied = false;
  let sessionApplied = false;

  try {
    await prisma.$executeRawUnsafe(`SET GLOBAL time_zone = '${offset}'`);
    globalApplied = true;
  } catch (error) {
    errors.push(`SET GLOBAL failed: ${(error as Error).message}`);
  }

  try {
    await prisma.$executeRawUnsafe(`SET SESSION time_zone = '${offset}'`);
    sessionApplied = true;
  } catch (error) {
    errors.push(`SET SESSION failed: ${(error as Error).message}`);
  }

  let sessionTimeZone: string | null = null;
  let globalTimeZone: string | null = null;
  let now: string | null = null;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ session_tz: string; global_tz: string; now: Date }>>(
      "SELECT @@session.time_zone AS session_tz, @@global.time_zone AS global_tz, NOW(3) AS now"
    );
    if (rows[0]) {
      sessionTimeZone = rows[0].session_tz;
      globalTimeZone = rows[0].global_tz;
      // MySQL NOW(3) returned as a Date object — format in current TZ for display.
      now = rows[0].now instanceof Date ? rows[0].now.toString() : String(rows[0].now);
    }
  } catch (error) {
    errors.push(`Query timezone state failed: ${(error as Error).message}`);
  }

  return { offset, globalApplied, sessionApplied, sessionTimeZone, globalTimeZone, now, errors };
}
