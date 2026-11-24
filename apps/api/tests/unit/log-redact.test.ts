/**
 * What reaches the log on a 500: the request line must not carry a calendar feed token (the
 * token IS the credential for the .ics URL) or any query-string value (an OIDC code, a state, a
 * one-time link).
 */
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/middleware/error.js";
import { redactUrlForLog } from "../../src/utils/log-redact.js";

const TOKEN = "a".repeat(64);

afterEach(() => vi.restoreAllMocks());

describe("errorHandler logs a redacted URL", () => {
  it("never writes the feed token or query values", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    const app = express();
    app.get("/api/calendar/feed/:file", () => {
      throw new Error("boom");
    });
    app.use(errorHandler);
    const res = await request(app).get(`/api/calendar/feed/${TOKEN}.ics?code=secret-code&state=s1`);
    expect(res.status).toBe(500);
    expect(logged.join("\n")).toContain("/api/calendar/feed/[redacted]");
    expect(logged.join("\n")).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain("secret-code");
  });
});

describe("redactUrlForLog", () => {
  it("keeps the path and the query keys, drops the values and feed tokens", () => {
    expect(redactUrlForLog(`/api/calendar/feed/${TOKEN}-team.ics`)).toBe("/api/calendar/feed/[redacted]-team.ics");
    expect(redactUrlForLog("/api/auth/sso/callback?code=abc&state=xyz")).toBe("/api/auth/sso/callback?code=[redacted]&state=[redacted]");
    expect(redactUrlForLog("/api/projects")).toBe("/api/projects");
  });
});

describe("request telemetry's route pattern", () => {
  it("never keeps a feed token when Express had no route pattern", async () => {
    const { routePattern } = await import("../../src/middleware/request-telemetry.js");
    const pattern = routePattern({ originalUrl: `/api/calendar/feed/${TOKEN}.ics?x=1` } as never);
    expect(pattern).not.toContain(TOKEN);
  });
});
