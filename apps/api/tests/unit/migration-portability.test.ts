/**
 * The migration corpus, checked for the three traps that have actually bitten this project.
 *
 * WHY A STATIC TEST AND NOT "just run the migrations": running them proves they work on THIS
 * machine's engine. Every trap below is a case where the SQL ran perfectly on one engine and
 * failed on another, so a green local replay is precisely the signal that misled us. These are
 * grep-shaped assertions on purpose — they catch the mistake in the pull request rather than on
 * the operator's laptop three weeks later, and they cost milliseconds.
 *
 * The history, so nobody deletes these as paranoia:
 *
 *  1. MySQL error 1093. `20260817100000_session_device_identity` reaped surplus rows with
 *     `UPDATE Session … JOIN (SELECT … FROM Session) AS d`. MariaDB materialises that derived
 *     table and it works; MySQL 8.0.14+ MERGES it, sees the target table in its own subquery, and
 *     refuses. Development ran MariaDB. Production ran MySQL 8.0.46.
 *
 *  2. MySQL error 1267, "illegal mix of collations". The fix for (1) used a scratch table with a
 *     declared `COLLATE utf8mb4_unicode_ci`, then joined it to `Session`.`id`. That works only if
 *     `Session` happens to carry the same collation — and the server DEFAULT is precisely what
 *     differs: MySQL 8.0 ships `utf8mb4_0900_ai_ci`, MySQL 5.7 and MariaDB ship
 *     `utf8mb4_general_ci`. Reproduced: CREATE fine, INSERT fine, JOIN dead two statements later.
 *
 *  3. Partial application. MySQL DDL is not transactional and Prisma does not roll a migration
 *     back, so a migration that fails after its DDL leaves the column and index in place while
 *     `_prisma_migrations` says FAILED. Recovery re-runs the file, so any migration whose DDL is
 *     followed by fallible DML has to survive meeting its own output.
 *
 * NOT a trap, despite looking like one: `CREATE TEMPORARY TABLE`. It was suspected during (2) and
 * is fine — `20260804013530_service_incident_single_open` uses two of them across five statements
 * and is applied on production MySQL 8.0.46. The migration engine does hold one connection.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { p3009Recovery } from "../../scripts/lib/migration-recovery.js";

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL("../../prisma/migrations", import.meta.url)));

interface Migration {
  name: string;
  sql: string;
  /** Lower-cased, with `--` comments stripped — the comments in this repo quote the very syntax
   *  these tests ban, so matching against raw text would fail on the explanation of the bug. */
  code: string;
}

function loadMigrations(): Migration[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(MIGRATIONS_DIR, entry.name, "migration.sql");
      const sql = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      return {
        name: entry.name,
        sql,
        code: sql
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .toLowerCase()
      };
    })
    .filter((migration) => migration.sql.length > 0);
}

const migrations = loadMigrations();

/**
 * Migrations that predate the guard rule and are deliberately left unguarded.
 *
 * BE HONEST ABOUT WHAT THIS TEST CURRENTLY BUYS: every existing instance of the pattern is listed
 * here, so today the rule protects exactly one migration — the one whose failure prompted it. It
 * is a forward-looking lint. That is still worth having: the next person to write `ADD COLUMN`
 * followed by a backfill gets told in review rather than by an operator whose deploy is wedged.
 *
 * WHY NOT JUST FIX THEM: editing an applied migration changes its checksum, and every database
 * that already ran it then needs a manual `_prisma_migrations` correction before it will accept
 * another deploy. Every entry below has run successfully on every installation, including the
 * production MySQL 8.0.46 one. Rewriting five files to make a test green would impose a manual
 * recovery step on real workspaces to fix a problem none of them have.
 *
 * The exposure is identical in each case and worth stating once: if the DML fails, the ALTER has
 * already landed, so `migrate resolve --rolled-back` + `deploy` dies on a duplicate column. The
 * fix at that point is to guard that file the way `20260817100000` is guarded.
 */
const UNGUARDED_BY_GRANDFATHER: Record<string, string> = {
  // ADD COLUMN onboardingCompletedAt, then backfill it from createdAt. One table, no join.
  "20260802171943_user_onboarding_completed_at": "single-table backfill",
  // Large V6 foundation migration: creates the planning tables, then seeds permissions, workflow
  // statuses and transitions.
  "20260803064315_v6_phase1_planning_foundation": "creates tables, then seeds permissions/workflow",
  // Merges duplicate open incidents, then adds the unique index that stops them recurring.
  "20260804013530_service_incident_single_open": "dedupes rows, then constrains them",
  // ADD COLUMN for the hashed form of a token, then hashes the existing plaintext ones.
  "20260807170000_hash_guest_and_public_tokens": "adds hash columns, then fills them",
  // ADD COLUMN on AuditLog, then backfills actor details from User.
  "20260808180000_audit_actor_provenance": "adds provenance columns, then backfills from User"
};

describe("migration corpus", () => {
  it("finds the migrations to check", () => {
    // A path typo would make every assertion below vacuously pass over an empty array.
    expect(migrations.length).toBeGreaterThan(50);
  });

  it("never writes to a table it also reads in a derived table (MySQL error 1093)", () => {
    // The shape is `UPDATE|DELETE … ( SELECT … FROM x )` where x is also the statement's target.
    const offenders = migrations.filter((migration) =>
      /\b(update|delete)\b[\s\S]{0,4000}?\bjoin\s*\(\s*select\b/.test(migration.code)
    );
    expect(offenders.map((migration) => migration.name)).toEqual([]);
  });

  it("builds scratch tables with CREATE TABLE … AS SELECT so they inherit collation", () => {
    // The 1267 trap. A scratch table with a DECLARED column list carries either an explicit
    // collation (wrong on any engine that differs) or the server default (wrong on any engine
    // whose default differs from the real table's). CTAS copies the source column's collation
    // exactly, so the join can't mismatch — and it is the pattern the earlier incident migration
    // already uses. Scratch tables are the leading-underscore ones; Prisma's own tables are not.
    for (const migration of migrations) {
      const declared = [...migration.code.matchAll(/create\s+(temporary\s+)?table\s+`?(_[a-z0-9_]+)`?\s*\(/g)];
      expect(
        declared.map((match) => match[2]),
        `${migration.name} declares scratch table columns instead of CREATE TABLE … AS SELECT`
      ).toEqual([]);
    }
  });

  it("never uses MariaDB-only `ADD COLUMN IF NOT EXISTS`, which MySQL rejects outright", () => {
    // Tempting as a one-word fix for re-runnability, and it turns a MySQL deployment into a syntax
    // error. The portable form is the information_schema + PREPARE guard.
    const offenders = migrations.filter((migration) =>
      /\badd\s+(column\s+)?if\s+not\s+exists\b|\bdrop\s+(column\s+)?if\s+exists\b/.test(migration.code)
    );
    expect(offenders.map((migration) => migration.name)).toEqual([]);
  });

  it("guards the DDL of any migration that follows it with fallible DML", () => {
    // "Fallible DML" = an UPDATE/INSERT/DELETE against a REAL table after the schema change. Those
    // are the migrations that can die half-applied, so a re-run must not trip over its own column
    // or index. Two exclusions, both principled rather than convenient:
    //
    //   * DDL against a table the same migration CREATEs. `_init` adds columns and foreign keys to
    //     tables it just made; re-running it fails at the CREATE, long before the ALTER, so the
    //     ALTER can never meet its own output. Guarding it would be noise.
    //   * DML against a scratch table. Filling `_session_cleanup` is not a partial-state risk —
    //     the table is dropped either side of the work.
    const risky = migrations.filter((migration) => {
      const created = new Set([...migration.code.matchAll(/create\s+table\s+(if\s+not\s+exists\s+)?`?([a-z0-9_]+)`?/g)].map((m) => m[2]));
      const additive = [...migration.code.matchAll(/\b(?:alter\s+table|create\s+index\s+`?[a-z0-9_]+`?\s+on)\s+`?([a-z0-9_]+)`?/g)]
        .map((match) => match[1])
        .filter((table) => !created.has(table));
      if (additive.length === 0) return false;
      const firstDdl = migration.code.search(/\b(alter\s+table|create\s+index)\b/);
      // Anchored to a statement boundary, not `\b`: a foreign key's `ON UPDATE CASCADE` contains
      // the word "update" and is not DML. That false positive flagged an `_init` that is one line
      // long and adds a single constraint.
      return [
        ...migration.code.slice(firstDdl).matchAll(/(?:^|;)\s*(?:update|insert\s+into|delete\s+from)\s+`?([a-z0-9_]+)`?/g)
      ].some((match) => !match[1].startsWith("_"));
    });

    // The allowlist has to name migrations that EXIST and still qualify — otherwise a rename or a
    // later fix leaves a stale exemption quietly covering nothing, or worse, covering something new.
    for (const name of Object.keys(UNGUARDED_BY_GRANDFATHER)) {
      expect(
        risky.map((migration) => migration.name),
        `${name} is exempted but no longer needs to be — delete the entry`
      ).toContain(name);
    }

    for (const migration of risky.filter((entry) => !(entry.name in UNGUARDED_BY_GRANDFATHER))) {
      // The guard: ask information_schema, then PREPARE the real statement or a no-op.
      expect(migration.code, `${migration.name} mixes DDL with DML but does not guard the DDL`).toMatch(
        /information_schema/
      );
      expect(migration.code, `${migration.name} reads information_schema but never PREPAREs`).toMatch(
        /\bprepare\b[\s\S]*\bexecute\b[\s\S]*\bdeallocate\s+prepare\b/
      );
    }

    // The migration this rule was written for must be in the set — if a refactor moves its DML out
    // and nothing else qualifies, the loop above would pass over an empty list.
    expect(risky.map((migration) => migration.name)).toContain("20260817100000_session_device_identity");
  });

  it("leaves no scratch table behind", () => {
    // The 1093 fix uses an ordinary table as a scratchpad. Ordinary means persistent: forgetting
    // the DROP ships a stray `_session_cleanup` to every workspace, and worse, the NEXT run of a
    // retried migration would find it already populated.
    for (const migration of migrations) {
      const created = [...migration.code.matchAll(/create\s+table\s+`?(_[a-z0-9_]+)`?/g)].map((match) => match[1]);
      for (const table of created) {
        expect(migration.code, `${migration.name} creates scratch table ${table} without dropping it`).toMatch(
          new RegExp(`drop\\s+table\\s+(if\\s+exists\\s+)?\`?${table}\`?`)
        );
      }
    }
  });
});

describe("session_device_identity, specifically", () => {
  const migration = migrations.find((entry) => entry.name === "20260817100000_session_device_identity");

  it("exists", () => {
    expect(migration).toBeDefined();
  });

  it("guards both the column and the index", () => {
    // Backticks around the information_schema column names, hence the optional-backtick pattern.
    expect(migration!.code).toMatch(/`?table_name`?\s*=\s*'session'\s+and\s+`?column_name`?\s*=\s*'deviceid'/);
    expect(migration!.code).toMatch(/`?index_name`?\s*=\s*'session_userid_deviceid_revokedat_idx'/);
    // `DO 0` is the no-op branch. Without it the IF would have to yield something PREPARE accepts,
    // and an empty string is a syntax error.
    expect(migration!.code).toContain("do 0");
  });

  it("revokes surplus sessions rather than deleting them", () => {
    // The audit trail is the point: a revoked row still records that the sign-in happened. A
    // DELETE here would erase security history to tidy up a list.
    expect(migration!.code).toMatch(/update\s+`session`[\s\S]*set[\s\S]*`revokedat`\s*=\s*now/);
    expect(migration!.code).not.toMatch(/delete\s+from\s+`session`/);
  });
});

describe("p3009Recovery", () => {
  // Verbatim from `prisma migrate deploy` against a database holding a failed migration. If a
  // Prisma upgrade rewords this, this test fails and the doctor's advice gets fixed with it —
  // rather than silently degrading to a placeholder at the moment someone needs it most.
  const REAL_P3009 = [
    "Error: P3009",
    "",
    "migrate found failed migrations in the target database, new migrations will not be applied.",
    "Read more about how to resolve migration issues in a production database:",
    "https://pris.ly/d/migrate-resolve",
    "The `20260817100000_session_device_identity` migration started at 2026-08-17 12:34:44.907 UTC failed"
  ].join("\n");

  it("returns null for unrelated failures so the caller keeps its generic advice", () => {
    expect(p3009Recovery("Error: P1001 Can't reach database server", "prisma/schema.prisma")).toBeNull();
    expect(p3009Recovery("", "prisma/schema.prisma")).toBeNull();
  });

  it("names the failed migration in a runnable command", () => {
    const advice = p3009Recovery(REAL_P3009, "prisma/schema.prisma");
    expect(advice).toContain(
      "npx prisma migrate resolve --rolled-back 20260817100000_session_device_identity --schema=prisma/schema.prisma"
    );
    expect(advice).toContain("npx prisma migrate deploy --schema=prisma/schema.prisma");
  });

  it("says plainly that nothing is dropped, and warns off `migrate reset`", () => {
    const advice = p3009Recovery(REAL_P3009, "prisma/schema.prisma")!;
    expect(advice).toContain("no data is dropped");
    // The failure mode this whole function exists to prevent.
    expect(advice).toMatch(/do not run `prisma migrate reset`/i);
  });

  it("degrades to a placeholder rather than a wrong migration name", () => {
    // Prisma quotes other backticked things too; a name-shaped match is required, not any quote.
    const advice = p3009Recovery("Error: P3009\nsomething went wrong with `the database`", "s.prisma")!;
    expect(advice).toContain("<the migration named above>");
  });
});
