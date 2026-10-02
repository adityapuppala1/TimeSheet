/**
 * The words an entry's author wrote, as the four timesheet emails quote them.
 *
 * THE DEFECT: the task description and the note are RICH TEXT (sanitised HTML from the editor), and
 * the receipt, awaiting-review, approved and rejected emails quoted them through `escape()` — so every
 * recipient read literal `<p>Built the importer</p>`. An administrator's override (which substitutes
 * the `{{description}}` var verbatim) got the raw HTML for three of the four.
 *
 * THE FIX: converted to plain text first (`htmlToPlainText` — paragraphs and list items become lines,
 * every other tag goes, entities are decoded), THEN escaped, with newlines as `<br />` — in the code
 * default and in the override var alike. Decoding before escaping is what keeps a typed `<script>`
 * text, not markup, in the override.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const AUTHOR = { id: "author-1", name: "Ava Author", email: "ava@x.io", role: "EMPLOYEE", permissions: ["timesheets:write"] };
const MANAGER = { id: "mgr-1", name: "Mo Manager", email: "mo@x.io" };
const ADMIN = { id: "admin-1", name: "Ada Admin", email: "ada@x.io", role: "ADMIN", permissions: ["timesheets:write", "timesheets:approve", "users:manage"] };

let actor: { id: string; name: string; email: string; role: string; permissions: string[] } = AUTHOR;

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor } as never;
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
vi.mock("../../src/services/sla.service.js", () => ({
  computeApprovalDeadline: vi.fn().mockReturnValue(null),
  resolveEscalationsFor: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../../src/services/billing-rate.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/billing-rate.service.js")>("../../src/services/billing-rate.service.js");
  return { ...actual, buildRateSnapshotPatch: vi.fn().mockResolvedValue({}) };
});
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: vi.fn() }));

const { timesheetRouter } = await import("../../src/controllers/timesheet.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { dispatchNotification } = await import("../../src/services/notify.service.js");

const ID = "11111111-1111-4111-8111-111111111111";

/** What the editor stores: a paragraph with inline markup, a list, an escaped `<` the author typed,
 *  and a note with an `&`. */
const TASK = "<p>Built the <strong>importer</strong></p><ul><li>parser</li><li>a &lt; b</li></ul>";
const NOTE = "<p>Blocked on staging &amp; DNS</p>";
/** Text the author TYPED that looks like markup — stored escaped, and it must stay text. */
const TYPED_MARKUP = "<p>Pasted &lt;script&gt;alert(1)&lt;/script&gt; from the log</p>";

let row: Record<string, unknown>;
let client: PrismaClient;

function fakeClient(): PrismaClient {
  const withRelations = (data: Record<string, unknown> = {}) => ({
    ...row,
    ...data,
    project: { id: "p-1", name: "Apollo", slaApprovalHours: 48 },
    module: { name: "Importer" },
    submodule: null,
    ticket: null,
    attachments: [],
    user: { id: AUTHOR.id, name: AUTHOR.name, email: AUTHOR.email, manager: MANAGER }
  });
  const people = [
    { id: ADMIN.id, email: ADMIN.email, managerId: null, status: "ACTIVE", deletedAt: null },
    { id: MANAGER.id, email: MANAGER.email, managerId: null, status: "ACTIVE", deletedAt: null },
    { id: AUTHOR.id, email: AUTHOR.email, managerId: MANAGER.id, status: "ACTIVE", deletedAt: null }
  ];
  const c: any = {
    timesheet: {
      findFirst: vi.fn(async () => withRelations()),
      findMany: vi.fn(async () => []),
      findUniqueOrThrow: vi.fn(async () => withRelations()),
      update: vi.fn(async ({ data }: any) => {
        row = { ...row, ...data };
        return withRelations();
      }),
      updateMany: vi.fn(async ({ data }: any) => {
        row = { ...row, ...data };
        return { count: 1 };
      })
    },
    project: { findUnique: vi.fn(async () => ({ slaApprovalHours: 48 })) },
    user: {
      findUnique: vi.fn(async () => ({ timezone: "UTC" })),
      findMany: vi.fn(async () => people.map((p) => ({ ...p, name: p.id, role: { name: "ADMIN" } })))
    }
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

const entry = (status: string, taskDescription = TASK, notes = NOTE) => ({
  id: ID,
  userId: AUTHOR.id,
  status,
  projectId: "p-1",
  moduleId: "m-1",
  submoduleId: null,
  ticketId: null,
  activityType: "Development",
  taskDescription,
  notes,
  workDate: new Date("2026-09-28T00:00:00.000Z"),
  startTime: "09:00",
  endTime: "12:00",
  totalHours: 3,
  billable: true,
  deletedAt: null
});

const sent = (category: string) => vi.mocked(dispatchNotification).mock.calls.map((c) => c[0]).find((n) => n.category === category)!;

/** The decisions an email makes about the description, in the code default and the override var. */
function expectPlainQuote(category: string) {
  const email = sent(category).email!;
  const html = email.fallback.html;
  const description = String(email.vars.description);
  for (const [where, text] of [
    ["fallback", html],
    ["override var", description]
  ] as const) {
    expect(text, where).not.toContain("&lt;p&gt;");
    expect(text, where).not.toContain("&lt;strong&gt;");
    expect(text, where).not.toContain("<p>");
    expect(text, where).toContain("Built the importer");
    expect(text, where).toContain("- parser");
    // Escaped exactly once: the `<` the author typed reads as `<`, never as `&lt;` on screen.
    expect(text, where).toContain("a &lt; b");
    expect(text, where).not.toContain("&amp;lt;");
    expect(text, where).toContain("Blocked on staging &amp; DNS");
  }
  // Lines survive as lines in the override too, as the code default has always shown them.
  expect(description).toContain("Built the importer<br />");
}

beforeEach(() => {
  vi.mocked(dispatchNotification).mockClear();
});

describe("on submit", () => {
  beforeEach(() => {
    actor = AUTHOR;
    row = entry("DRAFT");
    client = fakeClient();
  });

  it("the author's receipt quotes the description as text, not as tags", async () => {
    const res = await request(buildApp()).post(`/api/timesheets/${ID}/submit`).send({});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expectPlainQuote("timesheet.submitted");
  });

  it("the approver's email does too", async () => {
    await request(buildApp()).post(`/api/timesheets/${ID}/submit`).send({});
    expectPlainQuote("timesheet.awaiting_review");
  });

  it("keeps typed markup as text in an administrator's override, which substitutes the var verbatim", async () => {
    row = entry("DRAFT", TYPED_MARKUP, "");
    await request(buildApp()).post(`/api/timesheets/${ID}/submit`).send({});
    for (const category of ["timesheet.submitted", "timesheet.awaiting_review"]) {
      const description = String(sent(category).email!.vars.description);
      expect(description, category).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(description, category).not.toContain("<script>");
    }
  });
});

describe("on a decision", () => {
  beforeEach(() => {
    actor = ADMIN;
    row = entry("SUBMITTED");
    client = fakeClient();
  });

  it("the approval email quotes the description as text, not as tags", async () => {
    const res = await request(buildApp()).patch(`/api/timesheets/${ID}/approve`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectPlainQuote("timesheet.approved");
  });

  it("the rejection email does too", async () => {
    const res = await request(buildApp()).patch(`/api/timesheets/${ID}/reject`).send({ reason: "Wrong project" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectPlainQuote("timesheet.rejected");
  });

  it("escapes the reject reason and names in the override vars, which an admin's template substitutes verbatim", async () => {
    const res = await request(buildApp()).patch(`/api/timesheets/${ID}/reject`).send({ reason: "<img src=x onerror=alert(1)> wrong" });
    expect(res.status).toBe(200);
    const vars = sent("timesheet.rejected").email!.vars as Record<string, unknown>;
    expect(String(vars.reason)).not.toContain("<img");
    expect(String(vars.reason)).toContain("&lt;img");
  });

  it("keeps typed markup as text in the override var", async () => {
    row = entry("SUBMITTED", TYPED_MARKUP, "");
    await request(buildApp()).patch(`/api/timesheets/${ID}/approve`).send({});
    const description = String(sent("timesheet.approved").email!.vars.description);
    expect(description).toContain("&lt;script&gt;");
    expect(description).not.toContain("<script>");
  });
});
