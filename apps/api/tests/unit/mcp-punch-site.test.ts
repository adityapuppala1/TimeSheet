/**
 * The MCP punch_in tool and the work-site rule. An assistant cannot supply a location, so under
 * requireSite BLOCK (with a site enabled) it must refuse, and under ALLOW_FLAGGED it must record
 * the punch flagged, exactly as a web punch-in without a location is treated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = { punchInMode: "SELF", locationMode: "OPTIONAL", punchInFaceRequired: false, requireSite: "OFF" as string };
let sites: Array<{ name: string; latitude: number; longitude: number; radiusM: number }> = [];
const ingestSpy = vi.fn().mockResolvedValue({ created: true, status: "ACCEPTED", recordId: null });

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: { findUnique: async () => ({ id: "u1", timezone: "UTC" }) },
    attendanceRecord: { findUnique: async () => null },
    attendanceSite: { findMany: async () => sites }
  }
}));
vi.mock("../../src/services/attendance-settings.service.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/attendance-settings.service.js")>()),
  getAttendanceSettings: async () => settings
}));
vi.mock("../../src/services/attendance-ingest.service.js", () => ({ assertIngestAllowed: async () => undefined, ingestPunch: ingestSpy }));
vi.mock("../../src/services/attendance-punch.service.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/attendance-punch.service.js")>()),
  isPunchInFaceRequired: async () => false,
  publicRecord: () => null
}));

const { MCP_TOOLS } = await import("../../src/services/mcp-tools.js");
const punchIn = MCP_TOOLS.find((t) => t.name === "punch_in")!;
const ctx = { user: { id: "u1" } } as never;
const HQ = { name: "HQ", latitude: 12.9, longitude: 77.6, radiusM: 200 };

beforeEach(() => {
  ingestSpy.mockClear();
  settings.requireSite = "OFF";
  sites = [];
});

describe("MCP punch_in and requireSite", () => {
  it("BLOCK with an enabled site refuses and records nothing", async () => {
    settings.requireSite = "BLOCK";
    sites = [HQ];
    await expect(punchIn.handler(ctx, {})).rejects.toMatchObject({ statusCode: 403 });
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("ALLOW_FLAGGED records the punch with siteFlagged true", async () => {
    settings.requireSite = "ALLOW_FLAGGED";
    sites = [HQ];
    await punchIn.handler(ctx, {});
    expect(ingestSpy.mock.calls[0][0].evidence).toMatchObject({ siteFlagged: true, siteLabel: "Outside work sites" });
  });

  it("no site enabled, or the rule OFF: unchanged", async () => {
    settings.requireSite = "BLOCK";
    await punchIn.handler(ctx, {});
    settings.requireSite = "OFF";
    sites = [HQ];
    await punchIn.handler(ctx, {});
    expect(ingestSpy).toHaveBeenCalledTimes(2);
    expect(ingestSpy.mock.calls[1][0].evidence?.siteFlagged ?? false).toBe(false);
  });
});
