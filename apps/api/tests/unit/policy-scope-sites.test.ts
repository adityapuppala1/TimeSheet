/**
 * 7.0.0 policy scopes vs work sites (services/policy-scope-sites.service.ts): an unknown site id in
 * a leave type / calendar scope is refused with 422 on save, and deleting a site strips its id from
 * every scope (an emptied list becomes NULL = everyone).
 */
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; scopeSiteIds: unknown };
let sites: Array<{ id: string }> = [];
let types: Row[] = [];
let calendars: Row[] = [];
const table = (rows: () => Row[]) => ({
  findMany: async () => rows().map((r) => ({ ...r })),
  update: async ({ where, data }: { where: { id: string }; data: { scopeSiteIds: unknown } }) => {
    const r = rows().find((x) => x.id === where.id)!;
    r.scopeSiteIds = data.scopeSiteIds;
    return r;
  }
});
const client = {
  attendanceSite: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => sites.filter((s) => where.id.in.includes(s.id)) },
  leaveType: table(() => types),
  holidayCalendar: table(() => calendars)
};
vi.mock("../../src/config/prisma.js", () => ({ prisma: new Proxy({}, { get: (_t, key: string) => (client as Record<string, unknown>)[key] }) }));

const svc = await import("../../src/services/policy-scope-sites.service.js");

beforeEach(() => {
  sites = [{ id: "blr" }, { id: "nyc" }];
  types = [{ id: "PL", scopeSiteIds: ["blr", "nyc"] }, { id: "CL", scopeSiteIds: ["blr"] }, { id: "SL", scopeSiteIds: null }];
  calendars = [{ id: "cal-blr", scopeSiteIds: ["blr"] }, { id: "cal-nyc", scopeSiteIds: ["nyc"] }];
});

describe("assertKnownScopeSites", () => {
  it("passes known ids and an empty / missing list", async () => {
    await expect(svc.assertKnownScopeSites(["blr", "nyc", "blr"])).resolves.toBeUndefined();
    await expect(svc.assertKnownScopeSites(undefined)).resolves.toBeUndefined();
    await expect(svc.assertKnownScopeSites(null)).resolves.toBeUndefined();
    await expect(svc.assertKnownScopeSites([])).resolves.toBeUndefined();
  });

  it("refuses an unknown id with 422 and names it", async () => {
    await expect(svc.assertKnownScopeSites(["blr", "ghost"])).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("ghost") });
  });
});

describe("removeSiteFromScopes", () => {
  it("strips the id everywhere and turns an emptied list into NULL", async () => {
    expect(await svc.removeSiteFromScopes("blr")).toBe(3);
    expect(types.find((t) => t.id === "PL")!.scopeSiteIds).toEqual(["nyc"]);
    expect(types.find((t) => t.id === "CL")!.scopeSiteIds).toBe(Prisma.DbNull);
    expect(types.find((t) => t.id === "SL")!.scopeSiteIds).toBeNull();
    expect(calendars.find((c) => c.id === "cal-blr")!.scopeSiteIds).toBe(Prisma.DbNull);
    expect(calendars.find((c) => c.id === "cal-nyc")!.scopeSiteIds).toEqual(["nyc"]);
  });

  it("changes nothing for a site no scope names", async () => {
    expect(await svc.removeSiteFromScopes("tokyo")).toBe(0);
  });
});
