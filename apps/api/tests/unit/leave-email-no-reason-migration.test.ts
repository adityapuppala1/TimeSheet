/**
 * V17 privacy fix: the leave.requested email no longer carries the requester's reason. Fresh
 * installs get it from the seed; existing tenants from migration 20261125100000, which replaces the
 * body ONLY where it is still the untouched default (an admin-edited template is left alone).
 * This pins the three together: the seed, the migration's new body, and the hash it matches on.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEED_TEMPLATES } from "../../prisma/email-templates-seed.js";
import { templates } from "../../src/services/mail-templates.js";

const migrations = fileURLToPath(new URL("../../prisma/migrations/", import.meta.url));
const read = (name: string) => readFileSync(`${migrations}${name}/migration.sql`, "utf8");

/** The first '…'-quoted SQL literal after `marker`, unescaped. */
function literalAfter(sql: string, marker: string): string {
  const start = sql.indexOf("'<!doctype", sql.indexOf(marker)) + 1;
  let end = start;
  for (;;) {
    if (sql[end] === "'" && sql[end + 1] === "'") end += 2;
    else if (sql[end] === "'") break;
    else end += 1;
  }
  return sql.slice(start, end).replaceAll("''", "'");
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("leave.requested carries no reason", () => {
  it("the seed and the code fallback have no reason placeholder and point to the app", () => {
    const body = SEED_TEMPLATES["leave.requested"].bodyHtml;
    expect(body).not.toContain("{{reason}}");
    expect(body).toContain("Open TimeSphere to review");
    const html = templates.leaveRequested({ approverName: "Mira", employeeName: "Aanya", leaveType: "PL", dates: "d", days: "1" });
    expect(html).not.toMatch(/Reason:/);
  });

  it("the migration writes exactly the seed's body, and only over the original default", () => {
    const sql = read("20261125100000_leave_requested_email_no_reason");
    expect(literalAfter(sql, "SET")).toBe(SEED_TEMPLATES["leave.requested"].bodyHtml);
    const original = literalAfter(read("20261124100000_leave_management"), "'leave.requested'");
    expect(original).toContain("{{reason}}");
    expect(sql).toContain(`SHA2(\`bodyHtml\`, 256) = '${sha256(original)}'`);
    expect(sql).toMatch(/WHERE `key` = 'leave.requested'/);
  });
});
