/**
 * The intake settings say how much mail the loop guard has dropped.
 *
 * A drop used to leave nothing but a console line, so when the guard misfired — it dropped every
 * message relayed through a Google Group — an admin had nothing to see. GET /email-intake/settings
 * now carries the running count and the latest drop's reason next to the last-poll status.
 */
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: "sa-1", name: "Root", email: "r@x.io", role: "SUPER_ADMIN", permissions: [] } as never;
      next();
    },
    requireSuperAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});

const lastAt = new Date("2026-10-02T09:00:00Z");
vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    emailIntakeSettings: {
      upsert: vi.fn().mockResolvedValue({ id: "global", imapHost: "imap.acme.test", imapPassword: "secret", lastPolledAt: null, lastPollError: null }),
      findUnique: vi.fn().mockResolvedValue(null)
    },
    auditLog: {
      count: vi.fn().mockResolvedValue(4),
      findFirst: vi.fn().mockResolvedValue({ createdAt: lastAt, metadata: { reason: "a null return path", from: "bounce@mx.test" } })
    }
  }
}));

const { emailIntakeRouter } = await import("../../src/controllers/email-intake.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/email-intake", emailIntakeRouter);
  a.use(errorHandler);
  return a;
}

describe("GET /email-intake/settings", () => {
  it("reports how many automated messages were dropped, and why the latest one was", async () => {
    const res = await request(app()).get("/email-intake/settings").expect(200);
    expect(res.body.automatedDrops).toEqual({ count: 4, lastReason: "a null return path", lastFrom: "bounce@mx.test", lastAt: lastAt.toISOString() });
    // The mailbox password still never leaves the server.
    expect(res.body.imapPassword).toBeUndefined();
    expect(res.body.imapPasswordSet).toBe(true);
  });
});
