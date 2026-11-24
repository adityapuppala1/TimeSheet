/**
 * 7.0.0 — the Ask AI and MCP leave reads respect scope and never return a reason.
 *
 * leave.service.js is mocked so the rows deliberately CARRY a reason, a decision note and an
 * attachment: the tools must drop them, whoever asks. Scope is the real teamScopeFor: an employee
 * gets only their own leave (listTeamLeave is never called for them), a manager their team's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "SECRET-REASON-medical";
const row = (name: string, status = "APPROVED") => ({
  id: `r-${name}`,
  user: { id: `u-${name}`, name },
  leaveType: { code: "PL", name: "Privilege leave" },
  startDate: "2026-11-23",
  endDate: "2026-11-24",
  startHalf: "FULL",
  endHalf: "FULL",
  days: 2,
  status,
  reason: SECRET,
  decisionNote: SECRET,
  attachment: { name: `${SECRET}.pdf`, url: "/x" }
});

const mocks = vi.hoisted(() => ({
  isLeaveOn: vi.fn(async () => true),
  listTeamLeave: vi.fn(),
  listMyRequests: vi.fn(),
  getBalances: vi.fn()
}));

vi.mock("../../src/services/leave.service.js", () => ({
  isLeaveOn: mocks.isLeaveOn,
  listTeamLeave: mocks.listTeamLeave,
  listMyRequests: mocks.listMyRequests,
  getBalances: mocks.getBalances
}));

const { whoIsOff, toOffRow, weekOf } = await import("../../src/services/leave-who-is-off.service.js");
const { AI_CHAT_LEAVE_TOOLS, offRange } = await import("../../src/services/ai-chat-leave-tools.js");

const tool = (name: string) => AI_CHAT_LEAVE_TOOLS.find((t) => t.name === name)!;
const ctx = (role: string) => ({ req: { user: { id: "me", role, permissions: [] } } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isLeaveOn.mockResolvedValue(true);
  mocks.listTeamLeave.mockResolvedValue({ from: "2026-11-23", to: "2026-11-29", items: [row("Asha"), row("Ben", "PENDING")] });
  mocks.listMyRequests.mockResolvedValue([row("Me")]);
  mocks.getBalances.mockResolvedValue({ from: "2026-01-01", to: "2026-12-31", balances: [{ leaveType: { code: "PL", name: "Privilege leave" }, available: 10, pending: 1, expiringAtYearEnd: 0 }] });
});

describe("who is off — scope", () => {
  it("an employee sees only their own leave and never queries the team", async () => {
    const r = await whoIsOff({ id: "me", role: "EMPLOYEE" }, "2026-11-23", "2026-11-29");
    expect(mocks.listTeamLeave).not.toHaveBeenCalled();
    expect(r).toMatchObject({ enabled: true, scope: "self" });
    expect(mocks.listMyRequests).toHaveBeenCalledWith("me", { status: "APPROVED" });
  });

  it("a manager gets their team, approved only", async () => {
    const r = await whoIsOff({ id: "me", role: "MANAGER" }, "2026-11-23", "2026-11-29");
    expect(r.enabled && r.scope).toBe("team");
    expect(r.enabled && r.people.map((p) => p.name)).toEqual(["Asha"]);
  });

  it("an admin is workspace-wide", async () => {
    const r = await whoIsOff({ id: "me", role: "ADMIN" }, "2026-11-23", "2026-11-29");
    expect(r.enabled && r.scope).toBe("everyone");
  });

  it("answers enabled:false with leave off, touching nothing", async () => {
    mocks.isLeaveOn.mockResolvedValue(false);
    expect(await whoIsOff({ id: "me", role: "ADMIN" }, "2026-11-23", "2026-11-29")).toEqual({ enabled: false });
    expect(mocks.listTeamLeave).not.toHaveBeenCalled();
  });
});

describe("never a reason", () => {
  it("toOffRow keeps only name, type, dates, halves and days", () => {
    const out = toOffRow(row("Asha") as never, "x");
    expect(Object.keys(out).sort()).toEqual(["days", "endDate", "endHalf", "name", "startDate", "startHalf", "type"]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it.each(["who_is_off", "my_leave_balance", "my_leave_requests"])("Ask AI %s output carries no reason, note or document", async (name) => {
    for (const role of ["EMPLOYEE", "MANAGER", "SUPER_ADMIN"]) {
      const out = await tool(name).run({}, ctx(role));
      expect(String(typeof out === "string" ? out : out.content)).not.toContain(SECRET);
    }
  });

  it("Ask AI tools answer leave-off as data", async () => {
    mocks.isLeaveOn.mockResolvedValue(false);
    for (const t of AI_CHAT_LEAVE_TOOLS) expect(String(await t.run({}, ctx("EMPLOYEE")))).toMatch(/Leave is off/);
  });

  it("the leave tools are reads: none acts or publishes", () => {
    for (const t of AI_CHAT_LEAVE_TOOLS) {
      expect(t.acts).toBeFalsy();
      expect(t.publishes).toBeFalsy();
    }
  });
});

describe("ranges", () => {
  it("defaults to the Monday-to-Sunday week", () => {
    expect(weekOf("2026-11-24")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(offRange({}, "2026-11-24")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(offRange({ date: "2026-12-01" }, "2026-11-24")).toEqual({ from: "2026-12-01", to: "2026-12-01" });
    expect(offRange({ from: "2026-12-05", to: "2026-12-01" }, "2026-11-24")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
  });
});
