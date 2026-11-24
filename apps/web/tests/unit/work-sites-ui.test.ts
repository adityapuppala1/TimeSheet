/** 7.0.0 work sites: the settings form's validation (numbers only, real ranges). */
import { describe, expect, it } from "vitest";
import { siteDraftProblem } from "../../src/components/attendance/WorkSites";

const ok = { name: "Head office", latitude: "12.9716", longitude: "77.5946", radiusM: "200" };

describe("siteDraftProblem", () => {
  it("accepts a complete site, including the extremes", () => {
    expect(siteDraftProblem(ok)).toBeNull();
    expect(siteDraftProblem({ ...ok, latitude: "-90", longitude: "180", radiusM: "25" })).toBeNull();
  });
  it("refuses a missing name, out-of-range or non-numeric coordinates, and a bad radius", () => {
    expect(siteDraftProblem({ ...ok, name: " " })).toMatch(/name/);
    expect(siteDraftProblem({ ...ok, latitude: "" })).toMatch(/Latitude/);
    expect(siteDraftProblem({ ...ok, latitude: "90.1" })).toMatch(/Latitude/);
    expect(siteDraftProblem({ ...ok, longitude: "east" })).toMatch(/Longitude/);
    expect(siteDraftProblem({ ...ok, radiusM: "10" })).toMatch(/Radius/);
    expect(siteDraftProblem({ ...ok, radiusM: "100.5" })).toMatch(/Radius/);
  });
});
