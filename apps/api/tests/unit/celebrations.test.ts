/**
 * 7.0.0 birthday / work-anniversary strip (services/celebrations.service.ts): day and month only,
 * years of service only when >= 1, opt-outs left out, the team view's scope, OFF by default, and the
 * birth year returned only to the person and super admins.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn(async (_args: unknown) => [] as unknown[]);
const findUnique = vi.fn(async (_args: { select: Record<string, boolean> }) => ({ dateOfBirth: new Date("1990-03-14T00:00:00Z"), joinDate: new Date("2020-11-25T00:00:00Z"), celebrationsOptOut: false }) as Record<string, unknown>);
const update = vi.fn(async (_args: unknown) => ({ id: "me" }));
const auditFn = vi.fn(async (..._a: unknown[]) => undefined);
let on = { attendance: true, celebrations: true };

vi.mock("../../src/config/prisma.js", () => ({ prisma: { user: { findMany: (a: unknown) => findMany(a), findUnique: (a: { select: Record<string, boolean> }) => findUnique(a), update: (a: unknown) => update(a) } } }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => auditFn(...a) }));
vi.mock("../../src/services/leave-capacity.service.js", () => ({ attendanceOrLeaveOn: async () => on.attendance }));
vi.mock("../../src/services/attendance-settings.service.js", () => ({ getAttendanceSettings: async () => ({ celebrationsEnabled: on.celebrations }) }));

const svc = await import("../../src/services/celebrations.service.js");
const d = (k: string) => new Date(`${k}T00:00:00Z`);

beforeEach(() => {
  on = { attendance: true, celebrations: true };
  findMany.mockClear();
  findUnique.mockClear();
  update.mockClear();
  auditFn.mockClear();
});

describe("weekOf", () => {
  it("is Monday to Sunday", () => {
    expect(svc.weekOf("2026-11-24")).toEqual({ from: "2026-11-23", to: "2026-11-29" }); // a Tuesday
    expect(svc.weekOf("2026-11-29")).toEqual({ from: "2026-11-23", to: "2026-11-29" }); // the Sunday
  });
});

describe("celebrationsInRange", () => {
  const people = [
    { id: "a", name: "Asha", dateOfBirth: d("1990-11-25"), joinDate: d("2022-11-27") },
    { id: "b", name: "Ben", joinDate: d("2026-11-24") }, // joined this week: not an anniversary
    { id: "c", name: "Chen", dateOfBirth: d("1985-11-26"), celebrationsOptOut: true },
    { id: "e", name: "Eve", dateOfBirth: d("1992-12-01") } // next week
  ];

  it("shows day and month only, years of service only when >= 1, and drops opt-outs", () => {
    const items = svc.celebrationsInRange(people, "2026-11-23", "2026-11-29");
    expect(items).toEqual([
      { userId: "a", name: "Asha", avatarUrl: null, kind: "BIRTHDAY", monthDay: "11-25", date: "2026-11-25" },
      { userId: "a", name: "Asha", avatarUrl: null, kind: "ANNIVERSARY", monthDay: "11-27", date: "2026-11-27", years: 4 }
    ]);
    expect(JSON.stringify(items)).not.toContain("1990");
  });

  it("handles a week across New Year and a 29 February birthday", () => {
    const items = svc.celebrationsInRange([{ id: "x", name: "X", dateOfBirth: d("1996-01-01") }, { id: "y", name: "Y", dateOfBirth: d("2000-02-29") }], "2026-12-28", "2027-01-03");
    expect(items.map((i) => i.date)).toEqual(["2027-01-01"]);
    expect(svc.celebrationsInRange([{ id: "y", name: "Y", dateOfBirth: d("2000-02-29") }], "2027-02-22", "2027-02-28").map((i) => i.date)).toEqual(["2027-02-28"]);
  });
});

describe("listCelebrations", () => {
  const NOW = new Date("2026-11-24T06:00:00Z");

  it("is OFF by default: no query at all", async () => {
    on.celebrations = false;
    expect(await svc.listCelebrations({ id: "me", role: "EMPLOYEE" }, NOW)).toMatchObject({ enabled: false, items: [] });
    on = { attendance: false, celebrations: true };
    expect((await svc.listCelebrations({ id: "me", role: "EMPLOYEE" }, NOW)).enabled).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("uses the team view's scope: a manager sees their reports and themselves; an employee only themselves", async () => {
    await svc.listCelebrations({ id: "mgr", role: "MANAGER" }, NOW);
    const managerWhere = JSON.stringify((findMany.mock.calls[0][0] as { where: unknown }).where);
    expect(managerWhere).toContain('"managerId":"mgr"');
    expect(managerWhere).toContain('"id":"mgr"');
    expect(managerWhere).toContain('"celebrationsOptOut":false');
    await svc.listCelebrations({ id: "emp", role: "EMPLOYEE" }, NOW);
    const employeeWhere = JSON.stringify((findMany.mock.calls[1][0] as { where: unknown }).where);
    expect(employeeWhere).toContain('"id":"emp"');
    expect(employeeWhere).not.toContain("managerId");
  });
});

describe("the birth year", () => {
  it("the person gets their own full date; the update audits no date", async () => {
    expect(await svc.getMyCelebrationProfile("me")).toMatchObject({ dateOfBirth: "1990-03-14", joinDate: "2020-11-25" });
    await svc.updateMyCelebrationProfile("me", { dateOfBirth: "1991-04-02", celebrationsOptOut: true }, new Date("2026-11-24T06:00:00Z"));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { dateOfBirth: d("1991-04-02"), celebrationsOptOut: true } }));
    expect(JSON.stringify(auditFn.mock.calls)).not.toContain("1991");
  });

  it("refuses a future birthday and a non-date", async () => {
    await expect(svc.updateMyCelebrationProfile("me", { dateOfBirth: "2030-01-01" }, new Date("2026-11-24T06:00:00Z"))).rejects.toMatchObject({ statusCode: 422 });
    expect(svc.myCelebrationsBody.safeParse({ dateOfBirth: "1990-02-30" }).success).toBe(false);
  });

  it("admins get the join date; only a super admin gets the birthday", async () => {
    const admin = await svc.adminCelebrationFields("u", "ADMIN");
    expect(admin).toEqual({ joinDate: "2020-11-25", celebrationsOptOut: false });
    expect(findUnique.mock.calls.at(-1)![0].select).not.toHaveProperty("dateOfBirth");
    expect(await svc.adminCelebrationFields("u", "SUPER_ADMIN")).toMatchObject({ dateOfBirth: "1990-03-14" });
  });

  it("the tenant client omits dateOfBirth from every read unless asked for", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/config/prisma.ts", import.meta.url)), "utf8");
    expect(src).toContain("omit: { user: { dateOfBirth: true } }");
  });
});
