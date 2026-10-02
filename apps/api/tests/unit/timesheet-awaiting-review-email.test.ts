/**
 * The email that asks an approver to decide a timesheet.
 *
 * THE DEFECT (audit 2026-10 R3, finding 3): the approver's copy reused the EMPLOYEE's receipt —
 * template `timesheet.submitted`, seeded enabled for every workspace and described as "Confirmation
 * to the employee" — with the names swapped. So the approver read "Your timesheet was submitted …
 * your entry is now in the approval queue with <the author>", with a "View status" button to their
 * OWN history. It shared the receipt's toggle and role mutes too, so muting receipts silenced the
 * one email that asks for a decision. A draft submitted later (POST /:id/submit) sent the same mail.
 *
 * THE FIX: its own template key, `timesheet.awaiting_review` — "{author} submitted … awaiting your
 * review", a button to /app/approvals, its own entry in the template registry (code default,
 * variables, description, sample), no seeded row, and the untrusted values pre-escaped for an
 * administrator's override, which substitutes them verbatim.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const AUTHOR = { id: "author-1", name: "Ava <b>Author</b> & Co", email: "ava@x.io", role: "ADMIN", permissions: ["timesheets:write"] };
const MANAGER = { id: "mgr-1", name: "Mo Manager", email: "mo@x.io" };

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...AUTHOR } as never;
      next();
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/face.service.js", () => ({
  isFaceVerificationRequired: vi.fn().mockResolvedValue(false),
  consumeVerification: vi.fn().mockResolvedValue(null),
  bindVerificationToRecord: vi.fn().mockResolvedValue(undefined),
  unbindTimesheetVerification: vi.fn().mockResolvedValue([]),
  getTimesheetVerificationBadges: vi.fn().mockResolvedValue(new Map())
}));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: vi.fn() }));

const { timesheetRouter } = await import("../../src/controllers/timesheet.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { dispatchNotification } = await import("../../src/services/notify.service.js");
const { TEMPLATE_KEYS, TEMPLATE_DEFAULTS, TEMPLATE_VARIABLES, sampleVariables, applyVars } = await import("../../src/services/template-store.service.js");
const { SEED_TEMPLATES } = await import("../../prisma/email-templates-seed.js");

const ID = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const MODULE = "33333333-3333-4333-8333-333333333333";

let client: PrismaClient;

function fakeClient(): PrismaClient {
  const row = {
    id: ID,
    userId: AUTHOR.id,
    status: "DRAFT",
    projectId: PROJECT,
    moduleId: MODULE,
    submoduleId: null,
    ticketId: null,
    activityType: "Development",
    taskDescription: "Built the importer",
    notes: "",
    workDate: new Date("2026-09-28T00:00:00.000Z"),
    startTime: "09:00",
    endTime: "12:00",
    totalHours: 3,
    billable: true,
    deletedAt: null
  };
  const withRelations = (data: Record<string, unknown>) => ({
    ...row,
    ...data,
    project: { id: PROJECT, name: "Apollo <script>", slaApprovalHours: 48 },
    module: { name: "Importer" },
    submodule: null,
    ticket: null,
    attachments: [],
    user: { id: AUTHOR.id, name: AUTHOR.name, email: AUTHOR.email, manager: MANAGER }
  });
  const c: any = {
    timesheet: {
      findFirst: vi.fn(async () => withRelations({})),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: any) => withRelations(data)),
      update: vi.fn(async ({ data }: any) => withRelations(data))
    },
    project: {
      findUniqueOrThrow: vi.fn(async () => ({ id: PROJECT, slaApprovalHours: 48 })),
      findUnique: vi.fn(async () => ({ id: PROJECT, slaApprovalHours: 48 }))
    },
    projectModule: { findFirst: vi.fn(async () => ({ id: MODULE, projectId: PROJECT })) },
    user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })), findMany: vi.fn(async () => []) }
  };
  c.$transaction = vi.fn(async (fn: any) => fn(c));
  return c as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/timesheets", timesheetRouter);
  app.use(errorHandler);
  return app;
}

const toManager = () => vi.mocked(dispatchNotification).mock.calls.map((c) => c[0]).find((n) => n.userId === MANAGER.id);
const toAuthor = () => vi.mocked(dispatchNotification).mock.calls.map((c) => c[0]).find((n) => n.userId === AUTHOR.id);

beforeEach(() => {
  client = fakeClient();
  vi.mocked(dispatchNotification).mockClear();
});

const routes = {
  "a fresh submit": () =>
    request(buildApp())
      .post("/api/timesheets/submit")
      .send({ projectId: PROJECT, moduleId: MODULE, activityType: "Development", taskDescription: "Built the importer", workDate: "2026-09-28", startTime: "09:00", endTime: "12:00" }),
  "a draft submitted later": () => request(buildApp()).post(`/api/timesheets/${ID}/submit`).send({})
};

for (const [label, send] of Object.entries(routes)) {
  describe(`the approver's email, on ${label}`, () => {
    it("is its own template, asking them to review somebody else's entry", async () => {
      const res = await send();
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      const note = toManager()!;
      expect(note.category).toBe("timesheet.awaiting_review");
      expect(note.email?.templateKey).toBe("timesheet.awaiting_review");
      const html = note.email!.fallback.html;
      expect(html).toContain("awaiting your review");
      expect(html).toContain("Ava &lt;b&gt;Author&lt;/b&gt; &amp; Co submitted");
      expect(html).toContain("/app/approvals");
      expect(html).not.toContain("Your timesheet was submitted");
      expect(html).not.toContain("/app/history");
      expect(note.link).toBe("/app/approvals");
    });

    it("pre-escapes the values an administrator's override substitutes verbatim", async () => {
      await send();
      const vars = toManager()!.email!.vars;
      expect(vars).toMatchObject({
        name: "Mo Manager",
        authorName: "Ava &lt;b&gt;Author&lt;/b&gt; &amp; Co",
        project: "Apollo &lt;script&gt;"
      });
    });

    it("leaves the employee's receipt as it was", async () => {
      await send();
      expect(toAuthor()?.email?.templateKey).toBe("timesheet.submitted");
    });
  });
}

describe("the registry entry", () => {
  const KEY = "timesheet.awaiting_review";

  it("is listed with a description, variables, a sample and a shipped default", () => {
    expect(TEMPLATE_KEYS).toContain(KEY);
    expect(TEMPLATE_VARIABLES[KEY]).toEqual(expect.arrayContaining(["name", "authorName", "hours", "date", "project"]));
    const rendered = applyVars(TEMPLATE_DEFAULTS[KEY].html, { ...sampleVariables(KEY), appUrl: "https://timesphere.local" });
    expect(rendered).toContain("Aanya Sharma submitted");
    expect(rendered).toContain("/app/approvals");
    expect(applyVars(TEMPLATE_DEFAULTS[KEY].subject, sampleVariables(KEY))).toContain("Aanya Sharma");
  });

  it("has no seeded row, so every workspace sends the shipped wording until an admin edits it", () => {
    expect(Object.keys(SEED_TEMPLATES)).not.toContain(KEY);
  });
});
