/**
 * A request form never files a CHANGE-typed ticket — including one saved before forms were refused
 * the type.
 *
 * Only a change request's own ticket may carry CHANGE. Saving a form with that type was refused, but
 * case-sensitively ("change" is CHANGE to the case-insensitive type column), and a form saved before
 * the refusal kept filing every public submission as a CHANGE ticket: a change nobody raised, from a
 * stranger on the internet.
 *
 * Pinned: saving (create or re-save) refuses any spelling of CHANGE; a public submission against a
 * form that still names it is filed under the form builder's default type and the fallback is logged.
 * (The data migration 20261002142000_request_form_change_type moves the stored forms.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: "admin-1", name: "Ada", email: "ada@acme.test", role: "ADMIN", permissions: [permissions.FORMS_CONFIGURE] } as never;
      next();
    }
  };
});
const auditSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));
vi.mock("../../src/services/planning.service.js", () => ({ assertPlanningCapability: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getPlanningQuota: vi.fn().mockResolvedValue(10) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/automation-dispatch.service.js", () => ({ dispatchFormSubmission: vi.fn().mockResolvedValue(undefined) }));

const { requestFormRouter } = await import("../../src/controllers/request-form.controller.js");
const { requestFormPublicRouter } = await import("../../src/controllers/request-form-public.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const FORM_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN = "t".repeat(43);
const SCHEMA = { fields: [{ key: "title", label: "Title", type: "TEXT", mapsTo: "title", required: true }] };

/** A form saved before the CHANGE refusal existed, still published. */
const OLD_FORM = {
  id: FORM_ID,
  slug: "support",
  name: "Support",
  projectId: "p-1",
  moduleId: null,
  ticketType: "CHANGE",
  defaultPriority: "MEDIUM",
  defaultAssigneeId: null,
  maxSubmissionsPerHour: 20,
  isPublic: true,
  isActive: true,
  schema: SCHEMA,
  project: { id: "p-1", name: "Ops" }
};

let client: Record<string, any>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runInTenant(client as unknown as PrismaClient, async () => next(), "org-1").catch(next));
  app.use("/api/request-forms", requestFormRouter);
  app.use("/api/request", requestFormPublicRouter);
  app.use(errorHandler);
  return app;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  client = {
    requestForm: {
      findFirst: vi.fn(async () => ({ ...OLD_FORM })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: FORM_ID, ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: FORM_ID, ...data })),
      count: vi.fn().mockResolvedValue(0)
    },
    requestFormSubmission: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sub-1", ...data }))
    },
    user: { findFirst: vi.fn().mockResolvedValue({ id: "intake-1" }) },
    globalTicketSettings: {
      upsert: vi.fn().mockResolvedValue({ id: "global", slaLowHours: 168, slaMediumHours: 72, slaHighHours: 24, slaCriticalHours: 4 }),
      findUnique: vi.fn().mockResolvedValue({ id: "global", slaLowHours: 168, slaMediumHours: 72, slaHighHours: 24, slaCriticalHours: 4 })
    },
    project: { update: vi.fn().mockResolvedValue({ code: "OPS", ticketSeq: 4 }) },
    ticket: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "t-new", ...data })) }
  };
  client.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(client));
});

afterEach(() => warn.mockRestore());

const formBody = (ticketType: string) => ({ name: "Support", slug: "support", projectId: "33333333-3333-4333-8333-333333333333", ticketType, schema: SCHEMA });

describe("saving a request form", () => {
  for (const spelling of ["CHANGE", "change", "Change"]) {
    it(`refuses ticketType "${spelling}" on create`, async () => {
      const res = await request(buildApp()).post("/api/request-forms").send(formBody(spelling));
      expect(res.status).toBe(422);
      expect(client.requestForm.create).not.toHaveBeenCalled();
    });
  }

  it("refuses re-saving an old form that still names CHANGE", async () => {
    const res = await request(buildApp()).put(`/api/request-forms/${FORM_ID}`).send(formBody("CHANGE"));
    expect(res.status).toBe(422);
    expect(client.requestForm.update).not.toHaveBeenCalled();
  });

  it("still saves an ordinary type", async () => {
    const res = await request(buildApp()).post("/api/request-forms").send(formBody("TASK"));
    expect(res.status).toBe(201);
  });
});

describe("a public submission to a form saved before the refusal", () => {
  it("is filed under the form builder's default type, not CHANGE, and the fallback is logged", async () => {
    const res = await request(buildApp()).post(`/api/request/${TOKEN}`).send({ answers: { title: "The printer is on fire" } });

    expect(res.status).toBe(201);
    expect(client.ticket.create.mock.calls[0][0].data.type).toBe("BUG");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CHANGE"));
    const submitted = auditSpy.mock.calls.find((c) => c[1] === "request_form.submitted");
    expect(submitted?.[4]).toMatchObject({ ticketTypeFallback: { from: "CHANGE", to: "BUG" } });
  });

  it("files in lower case too — 'change' is CHANGE to the type column", async () => {
    client.requestForm.findFirst.mockResolvedValue({ ...OLD_FORM, ticketType: "change" });
    await request(buildApp()).post(`/api/request/${TOKEN}`).send({ answers: { title: "The printer is on fire" } });
    expect(client.ticket.create.mock.calls[0][0].data.type).toBe("BUG");
  });

  it("leaves an ordinary form's type alone", async () => {
    client.requestForm.findFirst.mockResolvedValue({ ...OLD_FORM, ticketType: "TASK" });
    await request(buildApp()).post(`/api/request/${TOKEN}`).send({ answers: { title: "The printer is on fire" } });
    expect(client.ticket.create.mock.calls[0][0].data.type).toBe("TASK");
    expect(warn).not.toHaveBeenCalled();
  });
});
