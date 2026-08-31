/**
 * Two module-level Maps on the authentication path grew for the lifetime of the process and were
 * never swept:
 *  - `failedLogins` (services/auth.service.ts), keyed by (org, ATTACKER-SUPPLIED EMAIL) and
 *    written on the UNAUTHENTICATED login route — an anonymous caller decided what went in it.
 *  - `lastSeenWrites` (middleware/auth.ts), keyed by session id, one entry per session the
 *    process ever authenticated.
 *
 * Neither leaked anything across tenants; both were unbounded, and the first was unbounded on
 * input a stranger chooses. These tests pin the sweep — and, for the lockout, that adding it did
 * not soften what the lockout is for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
/*
 * A BUDGET SIZED FOR BCRYPT, not for an assertion.
 *
 * Every login path under test hashes or verifies a password, `bcryptjs` is pure JavaScript, and its
 * cost factor is deliberately expensive — that is the control, not a slow test. This file spends
 * ~18 seconds of CPU on seven tests with nothing else running, so vitest's 10s default is already
 * close in isolation and is exceeded under a full parallel suite on a loaded machine.
 *
 * The failure that produced is the worst kind: red on one run, green on the next, on a file nobody
 * had touched. That teaches people to re-run the suite instead of reading it, which is how a real
 * regression gets waved through. Nothing here hangs — it is bcrypt doing its job — so the honest
 * fix is a budget that says so, kept local to the files that hash rather than raised globally,
 * where it would also hide a genuine deadlock somewhere else.
 */
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });
import type { Request, Response } from "express";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } }
}));
vi.mock("../../src/services/maintenance.service.js", () => ({
  isMaintenanceActive: vi.fn().mockResolvedValue(false)
}));
vi.mock("../../src/config/prisma.js", async () => {
  const { tenantContext } = await import("../../src/config/tenant-context.js");
  return {
    prisma: new Proxy({} as never, { get: (_t, prop) => (tenantContext.getStore()!.client as never)[prop] })
  };
});

const { login, __resetLoginLockoutsForTests, __loginLockoutEntryCountForTests } = await import("../../src/services/auth.service.js");
const { requireAuth, __resetLastSeenTrackerForTests, __lastSeenTrackerSizeForTests } = await import("../../src/middleware/auth.js");
const { signAccessToken } = await import("../../src/utils/security.js");

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

let client: ReturnType<typeof createFakeTenantClient>;

/** Moves the clock forward for every consumer of `Date.now`, the one thing both sweeps read. */
function advance(ms: number) {
  const base = Date.now() + ms;
  vi.spyOn(Date, "now").mockImplementation(() => base);
}

beforeEach(() => {
  __resetLoginLockoutsForTests();
  __resetLastSeenTrackerForTests();
  client = createFakeTenantClient();
});

/* ------------------------------------ failedLogins ------------------------------------ */

/** Drives `login` to its failure branch and returns the HTTP status it threw. */
async function failedAttempt(email: string, orgId = "org-1") {
  vi.mocked(client.user.findUnique).mockResolvedValue(null as never);
  try {
    await runInTenant(client, () => login(email, "wrong-password"), orgId);
    throw new Error("login unexpectedly succeeded");
  } catch (error) {
    return (error as { statusCode?: number }).statusCode;
  }
}

describe("the failed-login map is swept", () => {
  it("drops entries whose window has passed instead of keeping every address ever typed", async () => {
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) await failedAttempt(email);
    expect(__loginLockoutEntryCountForTests()).toBe(3);

    advance(FAILURE_WINDOW_MS + 1_000);
    await failedAttempt("d@example.com");

    // The three stale keys went with the write, not with a timer per entry.
    expect(__loginLockoutEntryCountForTests()).toBe(1);
  });

  it("lets the counter decay, so old failures can't combine with new ones into a lockout", async () => {
    for (let i = 0; i < 4; i += 1) expect(await failedAttempt("ada@example.com")).toBe(401);

    advance(FAILURE_WINDOW_MS + 1_000);
    // Cumulatively the 5th..8th failures. Without decay the 5th arms the lock and the rest are 429.
    for (let i = 0; i < 4; i += 1) expect(await failedAttempt("ada@example.com")).toBe(401);
  });

  it("still arms after 5 failures inside one window — the sweep is not an escape hatch", async () => {
    for (let i = 0; i < 5; i += 1) expect(await failedAttempt("ada@example.com")).toBe(401);
    expect(await failedAttempt("ada@example.com")).toBe(429);
  });

  it("never sweeps an ARMED lockout early — the entry window outlives the lock it holds", async () => {
    for (let i = 0; i < 5; i += 1) await failedAttempt("ada@example.com");

    advance(4 * 60 * 1000); // inside the 5-minute lock
    expect(await failedAttempt("ada@example.com")).toBe(429);

    advance(2 * 60 * 1000); // lock served out, entry window (15 minutes) has not
    expect(await failedAttempt("ada@example.com")).toBe(401);
    expect(__loginLockoutEntryCountForTests()).toBe(1);
  });

  it("keeps sweeping across tenants without confusing their keys", async () => {
    await failedAttempt("ada@example.com", "org-a");
    await failedAttempt("ada@example.com", "org-b");
    expect(__loginLockoutEntryCountForTests()).toBe(2);

    advance(FAILURE_WINDOW_MS + 1_000);
    await failedAttempt("ada@example.com", "org-a");
    expect(__loginLockoutEntryCountForTests()).toBe(1);
    expect(await failedAttempt("ada@example.com", "org-b")).toBe(401);
  });
});

/* ----------------------------------- lastSeenWrites ----------------------------------- */

const ORG_ID = "org-1";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function userRow() {
  return {
    id: USER_ID,
    name: "Ada",
    email: "ada@example.com",
    status: "ACTIVE",
    deletedAt: null,
    role: { name: "EMPLOYEE", permissions: [] }
  };
}

/** One authenticated request for `sessionId`, through the real middleware. */
async function authenticate(sessionId: string) {
  vi.mocked(client.session.findUnique).mockResolvedValue({ revokedAt: null } as never);
  vi.mocked(client.user.findUnique).mockResolvedValue(userRow() as never);
  vi.mocked(client.session.update).mockResolvedValue({} as never);

  const req = { headers: { authorization: `Bearer ${signAccessToken(USER_ID, sessionId, ORG_ID)}` } } as unknown as Request;
  await runInTenant(client, () => requireAuth(req, {} as Response, () => undefined), ORG_ID);
  return req;
}

describe("the last-seen throttle map is swept", () => {
  it("authenticating attaches the user and records one entry per session", async () => {
    const req = await authenticate("session-1");
    expect(req.user?.id).toBe(USER_ID);

    await authenticate("session-2");
    await authenticate("session-3");
    expect(__lastSeenTrackerSizeForTests()).toBe(3);
  });

  it("drops entries older than the throttle window rather than keeping every session forever", async () => {
    await authenticate("session-1");
    await authenticate("session-2");
    await authenticate("session-3");

    advance(LAST_SEEN_THROTTLE_MS + 1_000);
    await authenticate("session-4");

    expect(__lastSeenTrackerSizeForTests()).toBe(1);
  });

  it("still throttles: a second request on a live session writes neither the map nor the row", async () => {
    await authenticate("session-1");
    vi.mocked(client.session.update).mockClear();

    await authenticate("session-1");
    expect(client.session.update).not.toHaveBeenCalled();
    expect(__lastSeenTrackerSizeForTests()).toBe(1);
  });
});
