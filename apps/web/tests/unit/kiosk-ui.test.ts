/** 7.0.0 kiosk / QR punch: the QR carries the punch page on the same host, with the code escaped. */
import { describe, expect, it } from "vitest";
import { kioskPunchUrl } from "../../src/components/attendance/Kiosk";
import { settingsSections } from "../../src/lib/attendance-settings-model";

describe("kioskPunchUrl", () => {
  it("points at the signed-in punch page on the kiosk's own host", () => {
    expect(kioskPunchUrl("https://acme.timesphere.app", "abc.def")).toBe("https://acme.timesphere.app/app/attendance/kiosk-punch?c=abc.def");
  });
  it("escapes the code", () => {
    expect(kioskPunchUrl("https://x", "a+b/c=")).toBe("https://x/app/attendance/kiosk-punch?c=a%2Bb%2Fc%3D");
  });
});

describe("settings navigation", () => {
  it("has a Kiosk section under Attendance", () => {
    expect(settingsSections(false)).toContainEqual({ id: "kiosk", label: "Kiosk / QR punch", group: "Attendance" });
  });
});
