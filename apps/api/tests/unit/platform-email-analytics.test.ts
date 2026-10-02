/**
 * The platform email screen's "Deliveries per day" chart is India's calendar (the platform's zone,
 * utils/platform-time.ts) end to end: the window starts at India's midnight, every bar is an Indian
 * day, and TODAY is a bar. It was keyed by UTC's date while the window was bounded by local
 * midnights, so the zero-filled series ran from the day before `from` to yesterday — today's mail
 * never appeared — and mail sent before 05:30 IST landed on the previous day's bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { templateKey: string; status: string; isTest: boolean; createdAt: Date; errorMessage: string | null; to: string; organizationId: string | null; organization: null; dayMarker: null };
let rows: Row[] = [];

const control = {
  platformEmailLog: {
    findMany: vi.fn(async ({ where }: { where: { createdAt: { gte: Date; lt: Date } } }) =>
      rows.filter((row) => row.createdAt >= where.createdAt.gte && row.createdAt < where.createdAt.lt)
    )
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));
vi.mock("../../src/config/env.js", () => ({ env: { TZ: "Asia/Kolkata" } }));
vi.mock("../../src/services/platform-mail-templates.js", () => ({ PLATFORM_TEMPLATES: [{ key: "signup.verify", group: "Signup" }] }));

const { getPlatformEmailAnalytics } = await import("../../src/services/platform-email-analytics.service.js");

const sent = (iso: string): Row => ({ templateKey: "signup.verify", status: "SENT", isTest: false, createdAt: new Date(iso), errorMessage: null, to: "a@acme.com", organizationId: null, organization: null, dayMarker: null });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T20:00:00Z")); // 01:30 IST on 2 Oct
  rows = [];
  control.platformEmailLog.findMany.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("getPlatformEmailAnalytics — deliveries per day", () => {
  it("keys each bar by India's day and includes today", async () => {
    rows = [sent("2026-10-01T19:00:00Z"), sent("2026-10-01T10:00:00Z")]; // 00:30 IST 2 Oct; 15:30 IST 1 Oct
    const result = await getPlatformEmailAnalytics("2026-09-26", "2026-10-02");
    expect(result.perDay.map((d) => d.day)).toEqual(["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(result.perDay.at(-1)).toMatchObject({ day: "2026-10-02", sent: 1 });
    expect(result.perDay.find((d) => d.day === "2026-10-01")).toMatchObject({ sent: 1 });
    expect(result.windowDays).toBe(7);
  });

  it("bounds the window by India's midnights", async () => {
    await getPlatformEmailAnalytics("2026-09-26", "2026-10-02");
    const where = control.platformEmailLog.findMany.mock.calls[0][0].where;
    expect(where.createdAt.gte.toISOString()).toBe("2026-09-25T18:30:00.000Z");
    expect(where.createdAt.lt.toISOString()).toBe("2026-10-02T18:30:00.000Z");
  });

  it("defaults to the last 90 Indian days, ending today", async () => {
    rows = [sent("2026-10-01T19:00:00Z")];
    const result = await getPlatformEmailAnalytics();
    expect(result.perDay).toHaveLength(90);
    expect(result.perDay.at(-1)).toMatchObject({ day: "2026-10-02", sent: 1 });
  });
});
