/**
 * 7.0.0: the seeded digest.weekly template had no {{tablesHtml}}, so the counted tables the worker
 * renders never reached a tenant on the default template. Fresh installs get it from the seed;
 * existing tenants from migration 20261130400000, which replaces the body ONLY where it is still the
 * previous default (an admin-edited template is left alone). This pins the seed, the migration's new
 * body and the hash it matches on together.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEED_TEMPLATES } from "../../prisma/email-templates-seed.js";

const migrations = fileURLToPath(new URL("../../prisma/migrations/", import.meta.url));
const read = (name: string) => readFileSync(`${migrations}${name}/migration.sql`, "utf8");

/** The first '…'-quoted HTML literal in the SQL, unescaped. */
function bodyLiteral(sql: string): string {
  const start = sql.indexOf("'<!doctype") + 1;
  let end = start;
  for (;;) {
    if (sql[end] === "'" && sql[end + 1] === "'") end += 2;
    else if (sql[end] === "'") break;
    else end += 1;
  }
  return sql.slice(start, end).replaceAll("''", "'");
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("digest.weekly carries {{tablesHtml}}", () => {
  it("the seed places the tables after the expected-hours line and before the button", () => {
    const body = SEED_TEMPLATES["digest.weekly"].bodyHtml;
    const tables = body.indexOf("{{tablesHtml}}");
    expect(tables).toBeGreaterThan(body.indexOf("{{expectedHoursHtml}}"));
    expect(tables).toBeLessThan(body.indexOf("Open your dashboard"));
  });

  it("the migration writes exactly the seed's body, and only over the previous default", () => {
    const sql = read("20261130400000_weekly_digest_tables_html");
    expect(bodyLiteral(sql)).toBe(SEED_TEMPLATES["digest.weekly"].bodyHtml);
    const previous = bodyLiteral(read("20261125400000_weekly_digest_expected_hours"));
    expect(previous).not.toContain("{{tablesHtml}}");
    expect(sql).toContain(`SHA2(\`bodyHtml\`, 256) = '${sha256(previous)}'`);
    expect(sql).toMatch(/WHERE `key` = 'digest.weekly'/);
  });
});
