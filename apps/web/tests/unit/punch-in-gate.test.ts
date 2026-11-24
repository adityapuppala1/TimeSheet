/**
 * V17 A2 — the punch-in ordering and mode decision (lib/punch-in-gate.ts).
 *
 * The first-load order (onboarding → punch-in → face prompt / tour) and each mode's surface live in
 * one pure function precisely so this file can pin them without rendering the shell.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { decidePunchIn, dismissalKey, gateEscapeHatches, punchNotice, readDismissal, writeDismissal, type PunchInDecisionInput } from "../../src/lib/punch-in-gate";
import type { MyToday } from "../../src/services/attendance-api";

const today = (over: Partial<MyToday> = {}): MyToday => ({
  enabled: true,
  punchInMode: "OPTIONAL",
  locationMode: "OFF",
  faceRequired: false,
  isWorkingDay: true,
  status: "PENDING",
  record: null,
  steps: [],
  ...over
});

const input = (over: Partial<PunchInDecisionInput> = {}): PunchInDecisionInput => ({
  today: today(),
  onboardingBlocked: false,
  onboardingLoading: false,
  pathname: "/app/dashboard",
  dismissal: "none",
  ...over
});

describe("gate ordering", () => {
  it("onboarding outranks punch-in: nothing shown, nothing held", () => {
    expect(decidePunchIn(input({ onboardingBlocked: true, today: today({ punchInMode: "MANDATORY" }) }))).toEqual({ surface: "none", holdsOthers: false });
  });

  it("holds the tour and face prompt while the status is still loading", () => {
    expect(decidePunchIn(input({ today: undefined }))).toEqual({ surface: "none", holdsOthers: true });
    expect(decidePunchIn(input({ onboardingLoading: true }))).toEqual({ surface: "none", holdsOthers: true });
  });

  it("a failed status read releases everything (never locks anyone out)", () => {
    expect(decidePunchIn(input({ today: null }))).toEqual({ surface: "none", holdsOthers: false });
  });

  it("the dialog holds the others; the banner does not", () => {
    expect(decidePunchIn(input()).holdsOthers).toBe(true);
    expect(decidePunchIn(input({ dismissal: "dialog" })).holdsOthers).toBe(false);
  });
});

describe("modes", () => {
  it("attendance off or mode OFF shows nothing", () => {
    expect(decidePunchIn(input({ today: { enabled: false } })).surface).toBe("none");
    expect(decidePunchIn(input({ today: today({ punchInMode: "OFF" }) })).surface).toBe("none");
  });

  it("OPTIONAL: dialog → banner after dismissal → nothing after the banner is dismissed", () => {
    expect(decidePunchIn(input()).surface).toBe("dialog");
    expect(decidePunchIn(input({ dismissal: "dialog" })).surface).toBe("banner");
    expect(decidePunchIn(input({ dismissal: "banner" })).surface).toBe("none");
  });

  it("MANDATORY: the overlay, which cannot be dismissed away", () => {
    expect(decidePunchIn(input({ today: today({ punchInMode: "MANDATORY" }), dismissal: "banner" }))).toEqual({ surface: "gate", holdsOthers: true });
  });

  it("MANDATORY steps aside on the profile page but keeps holding", () => {
    expect(decidePunchIn(input({ today: today({ punchInMode: "MANDATORY" }), pathname: "/app/profile" }))).toEqual({ surface: "none", holdsOthers: true });
  });

  it("already punched in from any source: a notice, no dialog, in every mode", () => {
    const record = { id: "r", workDate: "2026-11-23", punchInAt: "2026-11-23T08:50:00Z", source: "WEBHOOK" as const, sourceLabel: "Biometric", flagged: false, faceVerified: false, hasLocation: false };
    for (const mode of ["OPTIONAL", "MANDATORY"] as const) {
      expect(decidePunchIn(input({ today: today({ punchInMode: mode, record }) }))).toEqual({ surface: "notice", holdsOthers: false });
    }
  });

  it("weekends and holidays ask nothing", () => {
    expect(decidePunchIn(input({ today: today({ isWorkingDay: false, status: "HOLIDAY", punchInMode: "MANDATORY" }) })).surface).toBe("none");
  });
});

describe("dismissal memory", () => {
  beforeEach(() => window.localStorage.clear());

  it("is per user and per local day", () => {
    writeDismissal("u1", "2026-11-23", "dialog");
    expect(readDismissal("u1", "2026-11-23")).toBe("dialog");
    expect(readDismissal("u2", "2026-11-23")).toBe("none");
    expect(readDismissal("u1", "2026-11-24")).toBe("none");
    expect(dismissalKey("u1", "2026-11-23")).toContain("u1");
  });

  it("ignores junk and survives storage that throws", () => {
    window.localStorage.setItem(dismissalKey("u1", "d"), "whatever");
    expect(readDismissal("u1", "d")).toBe("none");
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(readDismissal("u1", "d")).toBe("none");
      expect(() => writeDismissal("u1", "d", "banner")).not.toThrow();
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe("punchNotice", () => {
  it("names the time and the source", () => {
    expect(punchNotice({ punchInAt: "2026-11-23T08:50:00Z", sourceLabel: "Biometric" })).toMatch(/^Punched in .+ via Biometric$/);
  });
});

describe("mandatory mode never locks out an administrator", () => {
  const mandatory = today({ punchInMode: "MANDATORY" });
  it.each(["SUPER_ADMIN", "ADMIN"])("%s gets the dialog, then the banner — never the blocking gate", (role) => {
    expect(decidePunchIn(input({ today: mandatory, role })).surface).toBe("dialog");
    expect(decidePunchIn(input({ today: mandatory, role, dismissal: "dialog" })).surface).toBe("banner");
  });
  it("an employee still gets the gate", () => {
    expect(decidePunchIn(input({ today: mandatory, role: "EMPLOYEE" })).surface).toBe("gate");
  });
  it("the workspace settings page is an escape hatch for admins only", () => {
    expect(gateEscapeHatches("SUPER_ADMIN")).toContain("/app/settings");
    expect(gateEscapeHatches("EMPLOYEE")).not.toContain("/app/settings");
    expect(decidePunchIn(input({ today: mandatory, role: "EMPLOYEE", pathname: "/app/settings" })).surface).toBe("gate");
  });
});
