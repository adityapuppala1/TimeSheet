/**
 * The boot-time check for a tenant left behind by a missed migration fan-out.
 *
 * This exists because the failure it catches is invisible: after the V8 phases, ten migrations had
 * been applied to the developer's own `DATABASE_URL` and never fanned out, so a second organization
 * threw `The table 'automationflow' does not exist` once a minute from the schedule sweep — with
 * nothing at boot to say so and an error naming a missing table rather than the thing to do about it.
 *
 * The comparison is the entire content of the function and it is easy to get backwards, which is why
 * it is pure and tested directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const LATEST = "20260818120000_v8_phase10_goal_and_workflow_email";

/* The console readout needs the control plane and the migration folder; the pure `findDrift` below
   needs neither, which is the point of it being pure. Both come from the one module, so the mocks
   sit here and the first half of the file is unaffected by them. */
let orgRows: Array<Record<string, unknown>> = [];
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { organization: { findMany: vi.fn(async () => orgRows) } }
}));
vi.mock("../../src/services/provisioning.service.js", () => ({ getLatestMigrationName: () => LATEST }));

const { findDrift, getFleetSchemaDrift, isBehind, TENANT_MIGRATE_COMMAND } = await import("../../src/services/tenant-schema-check.service.js");

describe("which tenants are behind", () => {
  it("says nothing when every organization is current", () => {
    const drift = findDrift(LATEST, [
      { slug: "default", databaseName: "timesheet_portal", schemaVersion: LATEST },
      { slug: "acme", databaseName: "acme_corp", schemaVersion: LATEST }
    ]);
    expect(drift.behind).toEqual([]);
  });

  it("names the organization that is behind, and only that one", () => {
    const drift = findDrift(LATEST, [
      { slug: "default", databaseName: "timesheet_portal", schemaVersion: LATEST },
      { slug: "acme", databaseName: "acme_corp", schemaVersion: "20260817100000_session_device_identity" }
    ]);
    expect(drift.behind).toHaveLength(1);
    expect(drift.behind[0]).toMatchObject({ slug: "acme", databaseName: "acme_corp" });
    // The version it IS on travels with it: "behind" without saying how far is a message that sends
    // somebody to the database to find out.
    expect(drift.behind[0].schemaVersion).toBe("20260817100000_session_device_identity");
  });

  it("treats a never-migrated organization as behind rather than giving it the benefit of the doubt", () => {
    // `schemaVersion` is null until the fan-out completes once. That is precisely the case this
    // exists to catch, so it must not read as "no information, assume fine".
    const drift = findDrift(LATEST, [{ slug: "new-org", databaseName: "new_org", schemaVersion: null }]);
    expect(drift.behind).toHaveLength(1);
  });

  it("reports the version this build expects, so the two can be compared without a second lookup", () => {
    expect(findDrift(LATEST, []).latest).toBe(LATEST);
  });
});

/**
 * The console's readout — the same question, shaped for a screen.
 *
 * WHY IT IS A SEPARATE FUNCTION AND A SEPARATE BLOCK. The boot warning is deliberately SILENT when
 * everything is current, because a message printed on every start is a message nobody reads by the
 * third one. A page cannot afford that silence: after running the fan-out, the operator's next
 * question is "did it work?", and a list showing only problems cannot answer it. So this one lists
 * the healthy workspaces too — and the two must still agree about what "behind" means, which is why
 * `isBehind` is one exported rule rather than a comparison written twice.
 */
describe("the fleet readout the console renders", () => {
  const orgWith = (over: Record<string, unknown> = {}) => ({
    id: "org-1",
    name: "Acme Corp",
    slug: "acme",
    status: "ACTIVE",
    database: { databaseName: "acme_corp", schemaVersion: LATEST, migratedAt: new Date("2026-08-30T00:00:00.000Z") },
    ...over
  });

  beforeEach(() => {
    orgRows = [];
  });

  it("reports NOTHING behind when the whole fleet is in step, and still lists the workspaces", async () => {
    orgRows = [orgWith(), orgWith({ id: "org-2", slug: "northwind", name: "Northwind" })];
    const drift = await getFleetSchemaDrift();
    expect(drift.behind).toBe(0);
    expect(drift.rows).toHaveLength(2);
    expect(drift.rows.every((row) => row.behind === false)).toBe(true);
  });

  it("flags the workspace that is behind, and only that one", async () => {
    orgRows = [orgWith(), orgWith({ id: "org-2", slug: "old", name: "Old Co", database: { databaseName: "old", schemaVersion: "20260101000000_ancient", migratedAt: null } })];
    const drift = await getFleetSchemaDrift();
    expect(drift.behind).toBe(1);
    expect(drift.rows.find((row) => row.behind)!.slug).toBe("old");
    // The version it IS on travels with it, so "behind" never means "go and look it up".
    expect(drift.rows.find((row) => row.behind)!.schemaVersion).toBe("20260101000000_ancient");
  });

  it("does not call a workspace with no database registered 'behind' — it counts it separately", async () => {
    // A PROVISIONING org has nothing to migrate. Calling it drift puts a permanent red row on the
    // page for a workspace that is fine, which is how a page teaches people to ignore it.
    orgRows = [orgWith({ database: null })];
    const drift = await getFleetSchemaDrift();
    expect(drift.behind).toBe(0);
    expect(drift.unregistered).toBe(1);
  });

  it("carries the exact command that fixes it, rather than leaving the operator to remember it", async () => {
    orgRows = [orgWith()];
    expect((await getFleetSchemaDrift()).command).toBe(TENANT_MIGRATE_COMMAND);
    expect(TENANT_MIGRATE_COMMAND).toContain("migrate:tenants");
  });

  it("shares ONE rule with the boot check, so the page and the log cannot disagree", () => {
    expect(isBehind(LATEST, LATEST)).toBe(false);
    expect(isBehind(LATEST, "20260101000000_ancient")).toBe(true);
    expect(isBehind(LATEST, null)).toBe(true);
    // The pure boot-side function is built on it, which is what makes that guarantee structural
    // rather than a promise in a comment.
    expect(findDrift(LATEST, [{ slug: "a", databaseName: "a", schemaVersion: null }]).behind).toHaveLength(1);
  });
});
