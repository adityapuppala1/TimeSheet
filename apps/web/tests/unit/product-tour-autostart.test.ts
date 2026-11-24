import { beforeEach, describe, expect, it } from "vitest";
import { shouldAutoStartTour } from "../../src/components/ProductTour";

const NOW = Date.parse("2026-11-24T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("shouldAutoStartTour", () => {
  beforeEach(() => sessionStorage.clear());

  it("opens for an account that finished onboarding an hour ago", () => {
    expect(shouldAutoStartTour(ago(3_600_000), NOW)).toBe(true);
  });

  it("does not open for an established account", () => {
    expect(shouldAutoStartTour(ago(30 * 86_400_000), NOW)).toBe(false);
  });

  it("does not open while onboarding is incomplete", () => {
    expect(shouldAutoStartTour(null, NOW)).toBe(false);
  });

  it("does not open when the browser clock is months behind the server", () => {
    const browserNow = Date.parse("2026-10-01T10:00:00Z");
    expect(shouldAutoStartTour(ago(30 * 86_400_000), browserNow)).toBe(false);
  });

  it("tolerates a browser clock a minute behind for a brand-new account", () => {
    expect(shouldAutoStartTour(new Date(NOW + 60_000).toISOString(), NOW)).toBe(true);
  });
});
