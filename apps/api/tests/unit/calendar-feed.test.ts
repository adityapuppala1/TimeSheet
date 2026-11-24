/**
 * 7.0.0 private calendar feed (services/calendar-feed.service.ts).
 *
 * Token security: only the hash is stored; rotate kills the old URL; revoke kills it; malformed,
 * unknown, deactivated-owner and module-off are all the same 404; the access-log redaction.
 * Privacy: my feed holds my approved leave and holidays only; the team feed is for team roles only,
 * holds approved leave of people they may see, as name + type, and never a reason or note; an
 * employee's token cannot open a team feed. Tenant isolation: a token is looked up in the current
 * tenant's database only (a second world stands in for another tenant).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, credit, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
const entitlements: Record<string, boolean> = { leaveManagementEnabled: true, attendanceEnabled: true };
let client: Record<string, unknown> = fakePrisma(world);
vi.mock("../../src/config/prisma.js", () => ({ prisma: new Proxy({}, { get: (_t, key: string) => client[key] }) }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: async (_org: string, cap: string) => Boolean(entitlements[cap]),
  getPlanningEntitlements: async () => ({ ...entitlements })
}));
vi.mock("../../src/services/planning.service.js", () => ({
  getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 })
}));
vi.mock("../../src/services/audit.service.js", () => ({ audit: async () => undefined }));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: () => undefined }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: async () => undefined }));

const feed = await import("../../src/services/calendar-feed.service.js");

const NOW = new Date("2026-11-23T10:00:00Z");
const REASON = "Hospital appointment for my mother";

function seed(w: LeaveWorld) {
  addUser(w, { id: "mgr", role: "MANAGER", name: "Meera" });
  addUser(w, { id: "emp", role: "EMPLOYEE", managerId: "mgr", name: "Arun" });
  addUser(w, { id: "other", role: "EMPLOYEE", managerId: "someone-else", name: "Zed" });
  addType(w, { code: "PL", annualQuota: 12, name: "Privilege leave" });
  credit(w, "emp", "type-PL", 2026, 12);
  const req = (id: string, userId: string, status: string, s: string) =>
    w.leaveRequest.push({ id, userId, leaveTypeId: "type-PL", startDate: new Date(`${s}T00:00:00Z`), endDate: new Date(`${s}T00:00:00Z`), startHalf: "FULL", endHalf: "FULL", days: 1, leaveYear: 2026, reason: REASON, decisionNote: "ok, " + REASON, status, approverId: "mgr", source: "WEB", overriddenBySuperAdmin: false, createdAt: new Date() });
  req("r-approved", "emp", "APPROVED", "2026-12-01");
  req("r-pending", "emp", "PENDING", "2026-12-02");
  req("r-other", "other", "APPROVED", "2026-12-03");
  w.holidayCalendar.push({ id: "cal", isDefault: true });
  w.holiday.push({ id: "h1", calendarId: "cal", date: new Date("2026-12-25T00:00:00Z"), name: "Christmas, Day", isOptional: false });
  w.holiday.push({ id: "h2", calendarId: "cal", date: new Date("2026-12-26T00:00:00Z"), name: "Optional one", isOptional: true });
}

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  Object.assign(entitlements, { leaveManagementEnabled: true, attendanceEnabled: true });
  seed(world);
});

describe("token security", () => {
  it("stores only the hash; the token is 64 hex chars and is returned once", async () => {
    const { token, hint } = await feed.rotateFeedToken("emp");
    expect(token).toMatch(feed.FEED_TOKEN_PATTERN);
    expect(hint).toBe(token.slice(0, 6));
    const stored = world.calendarFeedToken[0];
    expect(stored.tokenHash).toBe(feed.hashFeedToken(token));
    expect(JSON.stringify(world.calendarFeedToken)).not.toContain(token);
    expect((await feed.getFeedStatus("emp"))).toMatchObject({ enabled: true, hint });
  });

  it("rotating kills the old URL; revoking kills the new one", async () => {
    const first = await feed.rotateFeedToken("emp");
    const second = await feed.rotateFeedToken("emp");
    expect(world.calendarFeedToken).toHaveLength(1);
    await expect(feed.renderFeed(`${first.token}.ics`, NOW)).rejects.toMatchObject({ statusCode: 404 });
    await expect(feed.renderFeed(`${second.token}.ics`, NOW)).resolves.toContain("BEGIN:VCALENDAR");
    await feed.revokeFeedToken("emp");
    await expect(feed.renderFeed(`${second.token}.ics`, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("malformed, unknown, deactivated owner and module off are all the same 404", async () => {
    const { token } = await feed.rotateFeedToken("emp");
    for (const file of ["nope.ics", `${token}.txt`, `${token.toUpperCase()}.ics`, `${"a".repeat(64)}.ics`, `../${token}.ics`]) {
      await expect(feed.renderFeed(file, NOW)).rejects.toMatchObject({ statusCode: 404, message: "Calendar feed not found" });
    }
    world.users.find((u) => u.id === "emp")!.status = "INACTIVE";
    await expect(feed.renderFeed(`${token}.ics`, NOW)).rejects.toMatchObject({ statusCode: 404 });
    world.users.find((u) => u.id === "emp")!.status = "ACTIVE";
    world.settings.leaveEnabled = false;
    world.settings.attendanceEnabled = false;
    await expect(feed.renderFeed(`${token}.ics`, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("creating a feed is refused while the module is off", async () => {
    world.settings.leaveEnabled = false;
    await expect(feed.rotateFeedToken("emp")).rejects.toMatchObject({ statusCode: 403 });
    expect(world.calendarFeedToken).toHaveLength(0);
  });

  it("another tenant's database never resolves this tenant's token", async () => {
    const { token } = await feed.rotateFeedToken("emp");
    const otherTenant = emptyWorld();
    seed(otherTenant);
    client = fakePrisma(otherTenant);
    await expect(feed.renderFeed(`${token}.ics`, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("the access log redacts the token", () => {
    const t = "ab".repeat(32);
    expect(feed.redactFeedTokens(`GET /api/calendar/feed/${t}.ics 200`)).toBe("GET /api/calendar/feed/[redacted].ics 200");
    expect(feed.redactFeedTokens(`/api/calendar/feed/${t}-team.ics`)).not.toContain(t);
  });
});

describe("what the feeds contain", () => {
  it("mine: approved leave and mandatory holidays only; no reason; optional holidays only once opted in", async () => {
    const { token } = await feed.rotateFeedToken("emp");
    const ics = await feed.renderFeed(`${token}.ics`, NOW);
    expect(ics).toContain("UID:leave-r-approved@timesphere");
    expect(ics).toContain("SUMMARY:Privilege leave");
    expect(ics).not.toContain("r-pending");
    expect(ics).not.toContain("r-other");
    expect(ics).toContain("SUMMARY:Holiday: Christmas\\, Day");
    expect(ics).not.toContain("Optional one");
    expect(ics).not.toContain("Hospital");
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });

  it("team: a manager sees approved leave of their reports as name + type, never a reason", async () => {
    const { token } = await feed.rotateFeedToken("mgr");
    const ics = await feed.renderFeed(`${token}-team.ics`, NOW);
    expect(ics).toContain("SUMMARY:Arun: Privilege leave");
    expect(ics).not.toContain("Zed");
    expect(ics).not.toContain("r-pending");
    expect(ics).not.toContain("Hospital");
    expect(ics).not.toContain("ok,");
  });

  it("an employee's token cannot open a team feed; and the team feed needs leave on", async () => {
    const { token } = await feed.rotateFeedToken("emp");
    await expect(feed.renderFeed(`${token}-team.ics`, NOW)).rejects.toMatchObject({ statusCode: 404 });
    const m = await feed.rotateFeedToken("mgr");
    world.settings.leaveEnabled = false;
    world.settings.attendanceEnabled = true;
    await expect(feed.renderFeed(`${m.token}-team.ics`, NOW)).rejects.toMatchObject({ statusCode: 404 });
    // Attendance alone still serves holidays in the personal feed.
    await expect(feed.renderFeed(`${m.token}.ics`, NOW)).resolves.toContain("Christmas");
  });
});
