/**
 * 7.0.0 work sites — the pure half: haversine distance (including its edge cases), nearest-site
 * matching with the boundary inclusive, the label, and the "Location label" analytics breakdown
 * staying k-anonymous.
 */
import { describe, expect, it } from "vitest";
import { haversineM, matchSite, OUTSIDE_SITES, siteBody, siteLabelFor } from "../../src/services/attendance-site.service.js";
import { sourceAndFace, NO_SITE_LABEL, type PersonFacts } from "../../src/services/attendance-analytics.service.js";

const EARTH_HALF_CIRCUMFERENCE = Math.PI * 6_371_008.8;

describe("haversineM", () => {
  it("is zero for the same point and symmetric", () => {
    expect(haversineM({ lat: 12.97, lng: 77.59 }, { lat: 12.97, lng: 77.59 })).toBe(0);
    const a = { lat: 51.5, lng: -0.12 };
    const b = { lat: 48.85, lng: 2.35 };
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6);
  });
  it("matches a known distance (London to Paris, about 343.5 km)", () => {
    expect(haversineM({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 }) / 1000).toBeCloseTo(343.5, 0);
  });
  it("one degree of latitude is about 111.2 km anywhere", () => {
    expect(Math.abs(haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111_195)).toBeLessThan(5);
    expect(Math.abs(haversineM({ lat: 60, lng: 10 }, { lat: 61, lng: 10 }) - 111_195)).toBeLessThan(5);
  });
  it("crosses the antimeridian the short way", () => {
    expect(haversineM({ lat: 0, lng: 179.9995 }, { lat: 0, lng: -179.9995 })).toBeCloseTo(111.2, 0);
  });
  it("handles the poles (every longitude is the same point)", () => {
    expect(haversineM({ lat: 90, lng: 0 }, { lat: 90, lng: 135 })).toBeCloseTo(0, 6);
  });
  it("returns half the circumference at the antipode, never NaN", () => {
    const d = haversineM({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    expect(Number.isNaN(d)).toBe(false);
    expect(d).toBeCloseTo(EARTH_HALF_CIRCUMFERENCE, 0);
    expect(haversineM({ lat: 45, lng: 30 }, { lat: -45, lng: -150 })).toBeCloseTo(EARTH_HALF_CIRCUMFERENCE, 0);
  });
});

describe("matchSite / siteLabelFor", () => {
  const office = { name: "Office", latitude: 0, longitude: 0, radiusM: 1000 };
  const annex = { name: "Annex", latitude: 0, longitude: 0.015, radiusM: 1000 };

  it("the boundary counts as inside; a couple of metres past it does not", () => {
    const edge = 1000 / 111_195; // degrees of latitude in 1000 m
    expect(matchSite({ lat: edge * 0.9999, lng: 0 }, [office])?.name).toBe("Office");
    expect(matchSite({ lat: edge * 1.002, lng: 0 }, [office])).toBeNull();
  });
  it("overlapping sites: the nearest centre wins", () => {
    expect(matchSite({ lat: 0, lng: 0.009 }, [office, annex])?.name).toBe("Annex");
    expect(matchSite({ lat: 0, lng: 0.006 }, [office, annex])?.name).toBe("Office");
  });
  it("labels At <site>, Outside work sites, or nothing", () => {
    expect(siteLabelFor({ lat: 0, lng: 0 }, [office])).toBe("At Office");
    expect(siteLabelFor({ lat: 1, lng: 1 }, [office])).toBe(OUTSIDE_SITES);
    expect(siteLabelFor({ lat: null, lng: null }, [office])).toBeNull();
    expect(siteLabelFor({ lat: 0, lng: 0 }, [])).toBeNull();
  });
  it("validates sites (numbers only, real ranges, whole metres)", () => {
    expect(siteBody.safeParse({ name: "X", latitude: 91, longitude: 0, radiusM: 100 }).success).toBe(false);
    expect(siteBody.safeParse({ name: "X", latitude: 0, longitude: -181, radiusM: 100 }).success).toBe(false);
    expect(siteBody.safeParse({ name: "X", latitude: 0, longitude: 0, radiusM: 10 }).success).toBe(false);
    expect(siteBody.safeParse({ name: "X", latitude: 0, longitude: 0, radiusM: 100.5 }).success).toBe(false);
    expect(siteBody.safeParse({ name: "X", latitude: "0", longitude: 0, radiusM: 100 }).success).toBe(false);
    expect(siteBody.safeParse({ name: "X", latitude: -90, longitude: 180, radiusM: 25 }).success).toBe(true);
  });
});

describe("Location label breakdown (org analytics)", () => {
  const person = (i: number, label: string | null): PersonFacts => ({
    userId: `u${i}`,
    name: `P${i}`,
    managerId: null,
    weeklyCapacityHours: 40,
    days: [
      { date: "2026-11-23", weekday: 1, status: "PRESENT", isWorkingDay: true, closed: true, punchMinute: 540, source: "WEB", face: "NONE", siteLabel: label, hoursLogged: 8, hasTimesheet: true, reasonCode: null }
    ]
  });

  it("groups punch-ins by label and suppresses groups under the minimum", () => {
    const people = [...[0, 1, 2].map((i) => person(i, "At Office")), person(3, "Outside work sites"), person(4, null)];
    const { bySite } = sourceAndFace(people, 3);
    expect(bySite.find((s) => s.label === "At Office")).toMatchObject({ people: 3, punches: 3, suppressed: false });
    expect(bySite.find((s) => s.label === "Outside work sites")).toMatchObject({ suppressed: true, punches: null });
    expect(bySite.find((s) => s.label === NO_SITE_LABEL)).toMatchObject({ suppressed: true });
  });
});
