/**
 * Covers the two pieces of request telemetry whose correctness is not obvious from reading them,
 * and where being wrong is expensive rather than merely untidy:
 *
 *  - `routePattern` decides the GROUP BY key for every aggregate on the API performance panel. If
 *    an id ever leaks into it, the "slowest endpoints" table degenerates into thousands of
 *    single-request rows and the table's index stops helping. Its fallback path (redaction) is the
 *    one that runs on the error path, where Express has already unwound `req.baseUrl`.
 *  - `bucketSecondsFor` is what keeps every window's chart to a readable number of points.
 */
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { routePattern } from "../../src/middleware/request-telemetry.js";
import { bucketSecondsFor, clampHours } from "../../src/services/api-performance.service.js";

function fakeRequest(originalUrl: string, baseUrl = "", routePath?: string): Request {
  return { originalUrl, baseUrl, route: routePath ? { path: routePath } : undefined } as unknown as Request;
}

describe("routePattern", () => {
  it("prefers Express's own route pattern, joined to its mount path", () => {
    expect(routePattern(fakeRequest("/api/tickets/9f2c1e40-1111-2222-3333-444455556666", "/api/tickets", "/:id"))).toBe(
      "/api/tickets/:id"
    );
  });

  it("does not append a trailing slash for a router's root route", () => {
    expect(routePattern(fakeRequest("/api/projects", "/api/projects", "/"))).toBe("/api/projects");
  });

  it("strips the query string", () => {
    expect(routePattern(fakeRequest("/api/reports?from=2026-01-01", "/api/reports", "/"))).toBe("/api/reports");
  });

  it("falls back to redaction when baseUrl has been unwound, rather than trusting a bare ':id'", () => {
    // The error path: every router restored baseUrl to "", so "" + "/:id" is not a real endpoint
    // and must not become the group key for every parameterised route in the app.
    expect(routePattern(fakeRequest("/api/tickets/9f2c1e40-1111-2222-3333-444455556666", "", "/:id"))).toBe(
      "/api/tickets/:id"
    );
  });

  it("redacts uuids, numeric ids and long hex tokens when no pattern is available (404s)", () => {
    expect(routePattern(fakeRequest("/api/users/12345/sessions"))).toBe("/api/users/:id/sessions");
    expect(routePattern(fakeRequest("/api/share/0123456789abcdef0123"))).toBe("/api/share/:id");
    expect(routePattern(fakeRequest("/api/attestations/9f2c1e40-1111-2222-3333-444455556666"))).toBe(
      "/api/attestations/:id"
    );
  });

  it("leaves ordinary route vocabulary alone", () => {
    expect(routePattern(fakeRequest("/api/maintenance/status-page"))).toBe("/api/maintenance/status-page");
  });
});

describe("bucketSecondsFor / clampHours", () => {
  it("keeps every supported window to a readable number of points", () => {
    for (const hours of [1, 6, 24, 72, 168, 720]) {
      const points = (hours * 3600) / bucketSecondsFor(hours);
      expect(points).toBeGreaterThanOrEqual(12);
      expect(points).toBeLessThanOrEqual(200);
    }
  });

  it("clamps nonsense windows instead of scanning the whole table", () => {
    expect(clampHours(0)).toBe(24);
    expect(clampHours(-5)).toBe(1);
    expect(clampHours(9_999_999)).toBe(24 * 365);
  });
});
