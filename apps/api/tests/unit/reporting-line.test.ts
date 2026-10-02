/**
 * A reporting line has to be a tree, and its managers have to be people who are here.
 *
 * THE DEFECT THIS PINS (audit 2026-10, users/roles finding 7): PATCH refused only `managerId ===
 * id`, and the CSV import's second pass linked managers with no check at all. Setting A's manager
 * to B and B's manager to A was accepted, and then:
 *  - GET /team/org-chart recursed forever for A, B and everyone under them (500, "Maximum call
 *    stack size exceeded"), and silently left both out of an admin's whole-company chart;
 *  - A's timesheet SLA escalation went to A (sla.service.ts escalates to the manager's manager).
 * An INACTIVE manager was accepted too, and the picker offered them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { runInTenant } from "../helpers/tenant-context.js";
import { createUserDirectoryFake, fakeUser } from "../helpers/fake-user-directory.js";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: "11111111-1111-4111-8111-111111111111", role: "SUPER_ADMIN", name: "Boss", email: "boss@x.io", permissions: ["users:manage"] } as never;
      next();
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/face.service.js", () => ({
  findCoveredUnenrolledUserIds: vi.fn().mockResolvedValue([]),
  notifyEnrollmentRequired: vi.fn().mockResolvedValue(0)
}));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../src/services/maintenance.service.js", () => ({ getOnlineSeenByUser: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit: vi.fn().mockResolvedValue(100) }));
vi.mock("../../src/services/billing-sync.service.js", () => ({ syncSubscriptionSeats: vi.fn().mockResolvedValue(undefined) }));

const { userRouter } = await import("../../src/controllers/user.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { buildOrgChart } = await import("../../src/controllers/team.controller.js");

let fake: ReturnType<typeof createUserDirectoryFake>;

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => runInTenant(fake.client, async () => next(), "org-1").catch(next));
  server.use("/api/users", userRouter);
  server.use(errorHandler);
  return request(server);
}

/** UUIDs, because the routes validate `managerId` as one. */
const ID = {
  boss: "11111111-1111-4111-8111-111111111111",
  lead: "22222222-2222-4222-8222-222222222222",
  dev: "33333333-3333-4333-8333-333333333333",
  gone: "44444444-4444-4444-8444-444444444444",
  solo: "55555555-5555-4555-8555-555555555555"
};

/** boss ← lead ← dev; `gone` is a deactivated former manager; `solo` reports to nobody. */
beforeEach(() => {
  fake = createUserDirectoryFake([
    fakeUser({ id: ID.boss, roleName: "SUPER_ADMIN" }),
    fakeUser({ id: ID.lead, roleName: "MANAGER", managerId: ID.boss, email: "lead@x.io" }),
    fakeUser({ id: ID.dev, managerId: ID.lead, email: "dev@x.io" }),
    fakeUser({ id: ID.gone, roleName: "MANAGER", status: "INACTIVE", email: "gone@x.io" }),
    fakeUser({ id: ID.solo })
  ]);
});

describe("PATCH /users/:id — managerId", () => {
  it("refuses a direct loop: the lead may not report to their own report", async () => {
    const res = await app().patch(`/api/users/${ID.lead}`).send({ managerId: ID.dev });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/reporting loop/i);
    expect(fake.byId(ID.lead)!.managerId).toBe(ID.boss);
  });

  it("refuses an indirect loop: the boss may not report to someone two levels below them", async () => {
    const res = await app().patch(`/api/users/${ID.boss}`).send({ managerId: ID.dev });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/reporting loop/i);
  });

  it("refuses a manager who is not active", async () => {
    const res = await app().patch(`/api/users/${ID.solo}`).send({ managerId: ID.gone });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/not active/i);
  });

  it("still refuses being your own manager", async () => {
    const res = await app().patch(`/api/users/${ID.solo}`).send({ managerId: ID.solo });
    expect(res.status).toBe(422);
  });

  it("accepts an ordinary move", async () => {
    const res = await app().patch(`/api/users/${ID.solo}`).send({ managerId: ID.lead });
    expect(res.status).toBe(200);
    expect(fake.byId(ID.solo)!.managerId).toBe(ID.lead);
  });

  it("does not refuse an unrelated edit just because the person's EXISTING manager was since deactivated", async () => {
    // The edit dialog sends managerId back unchanged on every save. Refusing that would leave the
    // admin unable to fix a typo in someone's name until they first re-parented them.
    fake.byId(ID.solo)!.managerId = ID.gone;
    const res = await app().patch(`/api/users/${ID.solo}`).send({ name: "Solo Renamed", managerId: ID.gone });
    expect(res.status).toBe(200);
  });

  it("clearing a manager is always allowed", async () => {
    const res = await app().patch(`/api/users/${ID.dev}`).send({ managerId: null });
    expect(res.status).toBe(200);
    expect(fake.byId(ID.dev)!.managerId).toBeNull();
  });
});

describe("POST /users — managerId", () => {
  it("refuses a manager who is not active", async () => {
    const res = await app().post("/api/users").send({ name: "New Person", email: "new@x.io", role: "EMPLOYEE", managerId: ID.gone });
    expect(res.status).toBe(422);
    expect(fake.users.find((u) => u.email === "new@x.io")).toBeUndefined();
  });
});

describe("CSV import — the manager-linking pass", () => {
  it("links a manager and report uploaded together, but refuses the line that would close a loop", async () => {
    const res = await app()
      .post("/api/users/bulk")
      .send({
        rows: [
          { name: "Ann Example", email: "ann@x.io", role: "MANAGER", managerEmail: "bob@x.io" },
          { name: "Bob Example", email: "bob@x.io", role: "MANAGER", managerEmail: "ann@x.io" }
        ]
      });
    expect(res.status).toBe(201);
    const ann = fake.users.find((u) => u.email === "ann@x.io")!;
    const bob = fake.users.find((u) => u.email === "bob@x.io")!;
    expect(ann.managerId).toBe(bob.id);
    expect(bob.managerId).toBeNull();
    expect(res.body.results[1].error).toMatch(/manager link failed: .*reporting loop/i);
  });

  it("refuses a pre-existing manager who is not active", async () => {
    const res = await app()
      .post("/api/users/bulk")
      .send({ rows: [{ name: "Cat Example", email: "cat@x.io", role: "EMPLOYEE", managerEmail: "gone@x.io" }] });
    expect(res.status).toBe(201);
    expect(fake.users.find((u) => u.email === "cat@x.io")!.managerId).toBeNull();
    expect(res.body.results[0].error).toMatch(/not active/i);
  });

  it("still links to an existing active manager by email, whatever its case", async () => {
    const res = await app()
      .post("/api/users/bulk")
      .send({ rows: [{ name: "Dee Example", email: "dee@x.io", role: "EMPLOYEE", managerEmail: "LEAD@x.io" }] });
    expect(res.status).toBe(201);
    expect(fake.users.find((u) => u.email === "dee@x.io")!.managerId).toBe(ID.lead);
  });
});

describe("org chart — data that already loops", () => {
  const person = (id: string, managerId: string | null) => ({
    id,
    name: id,
    email: `${id}@x.io`,
    avatarUrl: null,
    designation: null,
    managerId,
    role: { name: "EMPLOYEE" }
  });

  it("renders a loop once instead of recursing until the stack runs out", () => {
    const a = person("a", "b");
    const b = person("b", "a");
    const c = person("c", "a"); // reports into the loop
    const tree = buildOrgChart([a, b, c], [b]) as Array<{ id: string; reports: Array<{ id: string; reports: Array<{ id: string }> }> }>;
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("b");
    expect(tree[0].reports.map((r) => r.id)).toEqual(["a"]);
    // a's reports are b (already drawn — dropped) and c.
    expect(tree[0].reports[0].reports.map((r) => r.id)).toEqual(["c"]);
  });

  it("draws an ordinary tree exactly as before", () => {
    const ceo = person("ceo", null);
    const mgr = person("mgr", "ceo");
    const dev = person("dev", "mgr");
    expect(buildOrgChart([ceo, mgr, dev], [ceo])).toEqual([
      expect.objectContaining({ id: "ceo", reports: [expect.objectContaining({ id: "mgr", reports: [expect.objectContaining({ id: "dev", reports: [] })] })] })
    ]);
  });
});
