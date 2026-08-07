/**
 * Per-role email suppression (Workspace settings → Email channels matrix).
 *
 * `isEmailRoleMuted` is the single predicate both the API's dispatch path
 * (services/notify.service.ts, services/mail.service.ts) and the settings UI's checkbox state
 * read, so the tick an admin sees and the mail that actually leaves can't disagree. These tests
 * pin the two properties that make it safe to layer under an existing, already-live gate:
 * absent config means "deliver to everyone", and unknown keys/roles never suppress.
 */
import { describe, expect, it } from "vitest";
import { isEmailRoleMuted, notificationPreferenceKeys, roles, type EmailRoleMutes } from "@timesheet/shared";

describe("isEmailRoleMuted", () => {
  it("treats absent config as 'nobody is muted' so an un-migrated workspace is unchanged", () => {
    for (const empty of [null, undefined, {} as EmailRoleMutes]) {
      for (const role of roles) {
        expect(isEmailRoleMuted(empty, "emailDailyReminder", role)).toBe(false);
      }
    }
  });

  it("mutes only the listed roles for the listed category", () => {
    const mutes: EmailRoleMutes = { emailDailyReminder: ["MANAGER", "SUPER_ADMIN"] };

    expect(isEmailRoleMuted(mutes, "emailDailyReminder", "MANAGER")).toBe(true);
    expect(isEmailRoleMuted(mutes, "emailDailyReminder", "SUPER_ADMIN")).toBe(true);
    // The roles that actually log time keep receiving it.
    expect(isEmailRoleMuted(mutes, "emailDailyReminder", "EMPLOYEE")).toBe(false);
    expect(isEmailRoleMuted(mutes, "emailDailyReminder", "TEAM_LEAD")).toBe(false);
    // Muting one category must not leak into its neighbours — a manager muted on the daily
    // nudge still gets told when a report missed a day.
    expect(isEmailRoleMuted(mutes, "emailDailyEscalation", "MANAGER")).toBe(false);
  });

  it("fails open on an empty list, a missing role, and an unrecognised key", () => {
    expect(isEmailRoleMuted({ emailDailyReminder: [] }, "emailDailyReminder", "MANAGER")).toBe(false);
    expect(isEmailRoleMuted({ emailDailyReminder: ["MANAGER"] }, "emailDailyReminder", null)).toBe(false);
    // A payload written by a client that predates a newly added category must not suppress it.
    expect(isEmailRoleMuted({ emailDailyReminder: ["MANAGER"] }, "emailMaintenanceScheduled", "MANAGER")).toBe(false);
    // Garbage in the JSON column (hand-edited row, bad restore) reads as "deliver", never as
    // "silently stop mailing" — a suppression bug is invisible in a way a delivery bug isn't.
    expect(isEmailRoleMuted({ emailDailyReminder: "MANAGER" } as unknown as EmailRoleMutes, "emailDailyReminder", "MANAGER")).toBe(false);
  });

  it("can express a mute for every shipped category, so the matrix has no dead rows", () => {
    const everything = Object.fromEntries(notificationPreferenceKeys.map((key) => [key, ["MANAGER"]])) as EmailRoleMutes;
    for (const key of notificationPreferenceKeys) {
      expect(isEmailRoleMuted(everything, key, "MANAGER")).toBe(true);
      expect(isEmailRoleMuted(everything, key, "EMPLOYEE")).toBe(false);
    }
  });
});
