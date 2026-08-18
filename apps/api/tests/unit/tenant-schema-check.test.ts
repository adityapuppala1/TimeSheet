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
import { describe, expect, it } from "vitest";

const { findDrift } = await import("../../src/services/tenant-schema-check.service.js");

const LATEST = "20260818120000_v8_phase10_goal_and_workflow_email";

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
