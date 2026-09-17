import { describe, expect, it } from "vitest";
import { hslTripletToHex, radiusFor, spiralPosition } from "../../src/components/PortfolioScene";

describe("hslTripletToHex", () => {
  it("converts the primaries and a grey exactly, and shrugs at garbage", () => {
    expect(hslTripletToHex("0 100% 50%")).toBe(0xff0000);
    expect(hslTripletToHex("120 100% 50%")).toBe(0x00ff00);
    expect(hslTripletToHex("240 100% 50%")).toBe(0x0000ff);
    expect(hslTripletToHex("0 0% 50%")).toBe(0x808080);
    expect(hslTripletToHex("not a colour")).toBe(0x888888);
  });
});

describe("radiusFor", () => {
  it("grows with the square root of open work and never vanishes", () => {
    expect(radiusFor(0)).toBeCloseTo(0.18);
    expect(radiusFor(1)).toBeCloseTo(0.24);
    expect(radiusFor(100)).toBeCloseTo(0.78);
    expect(radiusFor(-5)).toBeCloseTo(0.18);
  });
});

describe("spiralPosition", () => {
  it("keeps every project inside the field and spreads them apart", () => {
    const pts = Array.from({ length: 12 }, (_, i) => spiralPosition(i, 12));
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeLessThanOrEqual(2.7);
    const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
    expect(d).toBeGreaterThan(0.3);
  });
});
