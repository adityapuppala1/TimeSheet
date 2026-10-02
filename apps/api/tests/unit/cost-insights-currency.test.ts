/**
 * `GET /reports/cost-insights` (H5). Cost is priced in each project's billing currency (the snapshot
 * frozen at approval), and the page printed every figure with a hardcoded "$" after ADDING them
 * together — rupees and dollars in one total under a dollar sign. Totals are now per currency and
 * every row carries its own.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const ROWS = [
  // Snapshotted in INR.
  { ticketId: "t1", totalHours: 8, billable: true, billedAmount: 8000, billedRate: 1000, billedCurrency: "INR", user: { hourlyRate: null }, project: { billingCurrency: "INR" } },
  { ticketId: "t1", totalHours: 2, billable: true, billedAmount: 2000, billedRate: 1000, billedCurrency: "INR", user: { hourlyRate: null }, project: { billingCurrency: "INR" } },
  // Snapshotted in USD, on a US-billed project.
  { ticketId: "t2", totalHours: 4, billable: true, billedAmount: 400, billedRate: 100, billedCurrency: "USD", user: { hourlyRate: null }, project: { billingCurrency: "USD" } },
  // Approved before snapshots existed: priced at the person's current rate, in the project's currency.
  { ticketId: "t3", totalHours: 1, billable: true, billedAmount: null, billedRate: null, billedCurrency: null, user: { hourlyRate: 50 }, project: { billingCurrency: null } }
];

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    globalTicketSettings: { findUnique: vi.fn(async () => ({ id: "global", enableCostAnalytics: true, defaultCurrency: "EUR" })) },
    timesheet: { findMany: vi.fn(async () => ROWS), groupBy: vi.fn(async () => []) },
    ticket: {
      findMany: vi.fn(async () => [
        { id: "t1", key: "HICS-1", title: "One" },
        { id: "t2", key: "HICS-2", title: "Two" },
        { id: "t3", key: "HICS-3", title: "Three" }
      ])
    }
  }
}));
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: "u1", permissions: ["reports:view"] };
    next();
  },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

let request: typeof import("supertest").default;
let app: import("express").Express;

beforeAll(async () => {
  const express = (await import("express")).default;
  const { reportRouter } = await import("../../src/controllers/report.controller.js");
  const { errorHandler } = await import("../../src/middleware/error.js");
  request = (await import("supertest")).default;
  app = express();
  app.use("/reports", reportRouter);
  app.use(errorHandler);
}, 60_000);

describe("GET /reports/cost-insights", () => {
  it("totals cost per currency and never adds two currencies together", async () => {
    const res = await request(app).get("/reports/cost-insights").expect(200);
    expect(res.body.totalsByCurrency).toEqual([
      { currency: "INR", total: 10000, tickets: 1, avgPerTicket: 10000 },
      { currency: "USD", total: 400, tickets: 1, avgPerTicket: 400 },
      // The un-snapshotted row falls back to the workspace default currency, as approval would.
      { currency: "EUR", total: 50, tickets: 1, avgPerTicket: 50 }
    ]);
  });

  it("puts each ticket's currency on its row", async () => {
    const res = await request(app).get("/reports/cost-insights").expect(200);
    expect(res.body.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ticketKey: "HICS-1", cost: 10000, currency: "INR", hours: 10 }),
        expect.objectContaining({ ticketKey: "HICS-2", cost: 400, currency: "USD" })
      ])
    );
  });
});
