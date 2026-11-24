import { describe, expect, it } from "vitest";
import {
  changesPayload,
  cleanDraft,
  diffLeaveSettings,
  diffSettings,
  impactReasons,
  matchPreset,
  settingsSections,
  settingsSummary,
  stagePreset
} from "../../src/lib/attendance-settings-model";
import { csvCell, toCsv } from "../../src/lib/csv-export";
import type { AttendanceSettings } from "../../src/services/attendance-api";

const base: AttendanceSettings = {
  attendanceEnabled: true,
  punchInMode: "OFF",
  locationMode: "OFF",
  punchInFaceRequired: false,
  faceFailureRule: "BLOCK",
  punchInReminderHour: 11,
  punchInReminderEnabled: false,
  missedDayReasonEnabled: false,
  aiInsightsSelf: false,
  aiInsightsManager: false,
  aiInsightsOrg: false,
  minGroupSize: 5,
  aiInsightsFrequency: "WEEKLY",
  latenessEnabled: false,
  expectedStartMinute: 570,
  locationConsentText: null,
  locationRetentionDays: 90,
  apiPriority: 100,
  webPriority: 50,
  mcpPriority: 40,
  csvPriority: 10
};

describe("presets", () => {
  it("stage only the values that differ and never the master switch", () => {
    const staged = stagePreset(base, "OFFICE");
    expect(staged).toMatchObject({ punchInMode: "MANDATORY", locationMode: "OPTIONAL", punchInReminderEnabled: true, punchInReminderHour: 10 });
    expect(staged).not.toHaveProperty("attendanceEnabled");
    // Already false, so not staged.
    expect(staged).not.toHaveProperty("punchInFaceRequired");
    expect(stagePreset(base, "CUSTOM")).toEqual({});
  });
  it("recognises the values a preset produces, else Custom", () => {
    expect(matchPreset({ ...base, ...stagePreset(base, "HYBRID") })).toBe("HYBRID");
    expect(matchPreset({ ...base, ...stagePreset(base, "REMOTE") })).toBe("REMOTE");
    expect(matchPreset({ ...base, punchInMode: "MANDATORY", locationMode: "REQUIRED" })).toBe("CUSTOM");
  });
});

describe("dirty diff", () => {
  it("lists only real changes, with readable from/to", () => {
    const changes = diffSettings(base, { punchInMode: "MANDATORY", punchInReminderHour: 11, locationMode: "OFF", punchInReminderEnabled: true });
    expect(changes.map((c) => c.key)).toEqual(["punchInMode", "punchInReminderEnabled"]);
    expect(changes[0]).toEqual({ key: "punchInMode", label: "Punch-in prompt", from: "off", to: "mandatory" });
  });
  it("drops a key edited back to the saved value", () => {
    expect(cleanDraft(base, { punchInMode: "OFF", locationMode: "REQUIRED" })).toEqual({ locationMode: "REQUIRED" });
    expect(changesPayload(base, { punchInMode: "OFF" })).toEqual({});
  });
  it("diffs leave settings separately", () => {
    const saved = { leaveEnabled: false, leaveYearStartMonth: 1, trustExternalApprovals: false, leaveApprovalFallback: "ADMINS" as const };
    const c = diffLeaveSettings(saved, { leaveYearStartMonth: 4, leaveEnabled: false, leaveApprovalFallback: "SUPER_ADMINS" });
    expect(c.map((x) => [x.label, x.from, x.to])).toEqual([
      ["Leave year starts", "January", "April"],
      ["When there is no manager", "any admin decides", "super admins decide"]
    ]);
  });
});

describe("impact", () => {
  it("names the org-wide consequences of risky changes", () => {
    expect(impactReasons(base, { punchInMode: "MANDATORY" })[0]).toMatch(/blocks the app/);
    expect(impactReasons({ ...base, attendanceEnabled: false }, { attendanceEnabled: true })[0]).toMatch(/starts the module/);
    expect(impactReasons(base, { locationMode: "REQUIRED", punchInFaceRequired: true })).toHaveLength(2);
  });
  it("is quiet for harmless changes and for loosening", () => {
    expect(impactReasons(base, { minGroupSize: 8, aiInsightsFrequency: "DAILY" })).toEqual([]);
    expect(impactReasons({ ...base, punchInMode: "MANDATORY" }, { punchInMode: "OPTIONAL" })).toEqual([]);
  });
});

describe("plain-language summary", () => {
  it("describes the values in a sentence", () => {
    const s = { ...base, punchInMode: "MANDATORY" as const, locationMode: "REQUIRED" as const, punchInReminderEnabled: true };
    expect(settingsSummary(s)).toBe(
      "Employees must punch in when they open TimeSphere and must confirm their work location. Face check is off. Reminder at 11:00."
    );
  });
  it("covers off, optional-without-location, lateness and reasons", () => {
    expect(settingsSummary({ ...base, attendanceEnabled: false })).toMatch(/Attendance is off/);
    expect(settingsSummary({ ...base, punchInMode: "OPTIONAL" })).toBe("Employees are asked to punch in when they open TimeSphere. Face check is off. No reminder email.");
    expect(settingsSummary({ ...base, punchInMode: "OPTIONAL", latenessEnabled: true, missedDayReasonEnabled: true, punchInFaceRequired: true })).toMatch(
      /A face check is part of punching in\. No reminder email\. Punch-ins after 09:30 count as late\. Past days with no time ask for a reason\./
    );
    expect(settingsSummary({ ...base, punchInMode: "OFF" })).toMatch(/web punch-in is off/);
  });
});

describe("sections", () => {
  it("adds the leave sections only when the plan includes leave", () => {
    expect(settingsSections(false).some((s) => s.group === "Leave")).toBe(false);
    expect(settingsSections(true).filter((s) => s.group === "Leave").map((s) => s.id)).toEqual(["leave-types", "leave-settings", "leave-balances"]);
  });
});

describe("csv export", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(
      toCsv(
        ["Name", "n"],
        [
          ["Ann", 3],
          ["Bo", null]
        ]
      )
    ).toBe("Name,n\r\nAnn,3\r\nBo,\r\n");
  });
  it("defuses spreadsheet formulas but leaves negative numbers alone", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell(-3)).toBe("-3");
  });
});
