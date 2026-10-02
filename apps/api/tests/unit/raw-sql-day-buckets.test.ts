/**
 * M3 — raw-SQL day buckets over DATETIME columns.
 *
 * Prisma writes and reads `DateTime` as UTC, and `createdAt` is a DATETIME(3): a zone-less column, so
 * MySQL's session time_zone (which config/prisma.ts pins) does NOT apply to it. `DATE(createdAt)`
 * is therefore UTC's day — the email-volume chart and the face-verification trend bucketed every row
 * written between 00:00 and 05:30 IST onto the day before, while the "today" cards beside them
 * (Prisma comparisons against IST midnight) counted it today. The buckets now convert from UTC to
 * the platform's offset in SQL, which agrees with how Prisma itself reads the column.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ raw: [] as Array<{ sql: string; values: unknown[] }>, rawRows: [] as any[] }));

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    emailLog: { groupBy: vi.fn(async () => []) },
    faceVerificationAttempt: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 0) },
    user: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    faceEnrollmentTemplate: { groupBy: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      state.raw.push({ sql: strings.join("?"), values });
      return state.rawRows;
    })
  }
}));
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: "admin", role: "SUPER_ADMIN", permissions: [] };
    next();
  },
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));
vi.mock("../../src/services/face.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/face.service.js")>()),
  getFaceSettings: vi.fn(async () => ({ enforcementMode: "ALL" }))
}));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 10:00 IST on Thursday 1 October 2026.
  vi.setSystemTime(new Date("2026-10-01T04:30:00.000Z"));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  state.raw = [];
  state.rawRows = [];
});

describe("the platform's UTC offset, for SQL", () => {
  it("is +05:30 for India", async () => {
    const { platformUtcOffset } = await import("../../src/utils/date-window.js");
    expect(platformUtcOffset(new Date())).toBe("+05:30");
  });
});

describe("email volume by day", () => {
  it("buckets by the IST day in SQL, not by DATE() of a UTC value", async () => {
    const { getEmailAnalytics } = await import("../../src/services/email-analytics.service.js");
    await getEmailAnalytics();
    const [call] = state.raw;
    expect(call.sql).toMatch(/CONVERT_TZ\(createdAt, '\+00:00', \?\)/);
    expect(call.values).toContain("+05:30");
  });
});

describe("face verification trend", () => {
  let request: typeof import("supertest").default;
  let app: import("express").Express;

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { faceRouter } = await import("../../src/controllers/face.controller.js");
    const { errorHandler } = await import("../../src/middleware/error.js");
    request = (await import("supertest")).default;
    app = express();
    app.use("/face", faceRouter);
    app.use(errorHandler);
  }, 60_000);

  it("buckets by the IST day and labels each bar with that day", async () => {
    state.rawRows = [{ day: "2026-10-01", outcome: "PASSED", n: 3 }];
    const res = await request(app).get("/face/analytics?days=7").expect(200);
    expect(state.raw[0].sql).toMatch(/CONVERT_TZ\(createdAt, '\+00:00', \?\)/);
    // The window starts at IST midnight six days ago; its label is that IST day, not the UTC day
    // before it (IST midnight is 18:30 UTC the previous evening).
    expect(res.body.trend[0].bucketStart).toBe("2026-09-25");
    expect(res.body.trend.at(-1)).toMatchObject({ bucketStart: "2026-10-01", total: 3 });
  });
});
