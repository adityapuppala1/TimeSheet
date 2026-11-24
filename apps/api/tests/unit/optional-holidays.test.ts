/**
 * 7.0.0 — optional holidays. Before this change loadHolidays/findHoliday counted an optional
 * holiday as a day off for EVERYONE; now it is a working day unless that person opted in, and the
 * opt-in respects the calendar's yearly cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type H = { id: string; calendarId: string; date: Date; name: string; isOptional: boolean };
let holidays: H[] = [];
let optIns: Array<{ userId: string; holidayId: string }> = [];
let cap: number | null = null;
let on = true;

const d = (k: string) => new Date(`${k}T00:00:00Z`);

vi.mock("../../src/config/prisma.js", () => {
  const holidayOptIn = {
    findMany: async ({ where }: { where: { holidayId: { in: string[] } } }) => optIns.filter((o) => where.holidayId.in.includes(o.holidayId)),
    findUnique: async ({ where }: { where: { userId_holidayId: { userId: string; holidayId: string } } }) =>
      optIns.find((o) => o.userId === where.userId_holidayId.userId && o.holidayId === where.userId_holidayId.holidayId) ?? null,
    count: async ({ where }: { where: { userId: string } }) => optIns.filter((o) => o.userId === where.userId).length,
    create: async ({ data }: { data: { userId: string; holidayId: string } }) => {
      optIns.push(data);
      return data;
    },
    deleteMany: async ({ where }: { where: { userId: string; holidayId: string } }) => {
      const before = optIns.length;
      optIns = optIns.filter((o) => !(o.userId === where.userId && o.holidayId === where.holidayId));
      return { count: before - optIns.length };
    }
  };
  const client = {
    holidayCalendar: { findMany: async () => [], findFirst: async () => ({ id: "cal" }) },
    holiday: {
      findMany: async () => holidays,
      findFirst: async ({ where }: { where: { id?: string; date?: Date } }) => {
        const h = holidays.find((x) => (where.id ? x.id === where.id : x.date.getTime() === where.date?.getTime()));
        return h ? { ...h, calendar: { id: "cal", maxOptionalPerYear: cap } } : null;
      }
    },
    holidayOptIn,
    user: { findUnique: async () => ({ id: "u1", timezone: "UTC", holidayCalendarId: null }) },
    $queryRaw: async () => [],
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client)
  };
  return { prisma: client };
});
vi.mock("../../src/services/leave-capacity.service.js", () => ({ attendanceOrLeaveOn: async () => on }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: async () => undefined }));

const { loadHolidays } = await import("../../src/services/attendance-team.service.js");
const { findHoliday } = await import("../../src/services/attendance-punch.service.js");
const svc = await import("../../src/services/holiday-opt-in.service.js");
const NOW = new Date("2026-11-24T08:00:00Z");

beforeEach(() => {
  holidays = [
    { id: "h-diwali", calendarId: "cal", date: d("2026-11-26"), name: "Diwali", isOptional: false },
    { id: "h-opt1", calendarId: "cal", date: d("2026-11-27"), name: "Guru Nanak", isOptional: true },
    { id: "h-opt2", calendarId: "cal", date: d("2026-12-24"), name: "Christmas Eve", isOptional: true }
  ];
  optIns = [];
  cap = 1;
  on = true;
});

describe("the resolver", () => {
  it("an optional holiday is a working day until that person opts in", async () => {
    optIns = [{ userId: "u1", holidayId: "h-opt1" }];
    const of = await loadHolidays([null], "2026-11-26", "2026-12-31");
    expect(of(null, "2026-11-26", "u2")).toEqual({ name: "Diwali" });
    expect(of(null, "2026-11-27", "u2")).toBeNull();
    expect(of(null, "2026-11-27")).toBeNull();
    expect(of(null, "2026-11-27", "u1")).toEqual({ name: "Guru Nanak" });
    expect(await findHoliday(null, "2026-11-27", "u2")).toBeNull();
    expect(await findHoliday(null, "2026-11-27", "u1")).toEqual({ name: "Guru Nanak" });
  });
});

describe("opting in", () => {
  it("respects the yearly cap, and is idempotent", async () => {
    expect((await svc.optInHoliday("u1", "h-opt1", NOW)).created).toBe(true);
    expect((await svc.optInHoliday("u1", "h-opt1", NOW)).created).toBe(false);
    await expect(svc.optInHoliday("u1", "h-opt2", NOW)).rejects.toMatchObject({ code: "OPTIONAL_HOLIDAY_LIMIT" });
    await svc.optOutHoliday("u1", "h-opt1", NOW);
    expect((await svc.optInHoliday("u1", "h-opt2", NOW)).created).toBe(true);
  });

  it("refuses a mandatory holiday, a past one, and with the module off", async () => {
    await expect(svc.optInHoliday("u1", "h-diwali", NOW)).rejects.toMatchObject({ code: "HOLIDAY_NOT_OPTIONAL" });
    await expect(svc.optInHoliday("u1", "h-opt1", new Date("2026-11-28T08:00:00Z"))).rejects.toMatchObject({ code: "HOLIDAY_PASSED" });
    on = false;
    await expect(svc.optInHoliday("u1", "h-opt1", NOW)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("no cap means no limit", () => {
    expect(svc.withinOptionalCap(null, 99)).toBe(true);
    expect(svc.withinOptionalCap(0, 0)).toBe(false);
  });
});
