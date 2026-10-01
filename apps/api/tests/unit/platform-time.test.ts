/**
 * The platform's own calendar — the day and hour in the deployment's configured zone (`TZ`,
 * Asia/Kolkata unless an operator chose another), never UTC's. Pinned with the instants where the
 * two disagree: IST is UTC+5:30, so from 18:30 UTC it is already tomorrow in India.
 */
import { describe, expect, it, vi } from "vitest";

const envMock: { TZ?: string } = { TZ: "Asia/Kolkata" };
vi.mock("../../src/config/env.js", () => ({ env: envMock }));

const { platformDayKey, platformHourKey } = await import("../../src/utils/platform-time.js");

describe("platform time", () => {
  it("names the day as India sees it — 19:00 UTC on the 1st is already the 2nd", () => {
    expect(platformDayKey(new Date("2026-10-01T19:00:00Z"))).toBe("2026-10-02");
    expect(platformDayKey(new Date("2026-10-01T18:29:59Z"))).toBe("2026-10-01");
  });

  it("names the hour as India sees it, half-hour offset included", () => {
    expect(platformHourKey(new Date("2026-10-01T19:00:00Z"))).toBe("2026-10-02T00");
    expect(platformHourKey(new Date("2026-10-02T08:15:00Z"))).toBe("2026-10-02T13");
  });

  it("follows an operator's own choice of zone", () => {
    envMock.TZ = "UTC";
    expect(platformDayKey(new Date("2026-10-01T19:00:00Z"))).toBe("2026-10-01");
    envMock.TZ = "Asia/Kolkata";
  });
});
