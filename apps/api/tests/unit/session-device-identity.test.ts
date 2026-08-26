/**
 * ONE BROWSER, ONE SESSION ROW.
 *
 * `establishSession` INSERTed on every sign-in and nothing ever collapsed or reaped the result,
 * so a person signing in from one machine accumulated one "active device" per sign-in. Measured
 * on the development workspace before the fix: **7,486 live sessions for a single user**, 6,952
 * of them carrying the identical Chrome-on-Windows user-agent string. Both surfaces that read the
 * table — the Profile page's session list and the admin's who's-online panel — exist to answer
 * "is there a session here that shouldn't be?", and that question is unanswerable in a list of
 * seven thousand identical rows.
 *
 * Two mechanisms fix it, and both are pinned here because each is a security-adjacent decision:
 *
 *   1. `deviceId` — an opaque cookie that lets a repeat sign-in REPLACE its own row. It is NOT an
 *      authenticator, and the tests below pin the two properties that keep it from becoming one:
 *      the match requires the user agent to agree, and a mismatch degrades to the old behaviour
 *      (a new row) rather than to a shared one.
 *   2. `MAX_ACTIVE_SESSIONS_PER_USER` — the ceiling for everything a cookie cannot cover
 *      (cookie-less clients, rows predating the column). Evicts least-recently-used, so the
 *      session in the caller's hand is never the one dropped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } }
}));
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit: vi.fn().mockResolvedValue(100) }));

const { completeSsoLogin, MAX_ACTIVE_SESSIONS_PER_USER } = await import("../../src/services/auth.service.js");

const ORG = "org-1";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0";

let client: PrismaClient;
/** Whatever `findFirst` should hand back as the reusable row for the next call. */
let existingForDevice: { id: string } | null = null;
/** What `findMany` reports as the user's live sessions, for the cap sweep. */
let liveSessions: Array<{ id: string; lastSeenAt: Date | null; createdAt: Date }> = [];

beforeEach(() => {
  existingForDevice = null;
  liveSessions = [];
  client = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ firstLoginAt: new Date(), role: { name: "EMPLOYEE" } }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: USER_ID }),
      update: vi.fn().mockResolvedValue({ id: USER_ID }),
      count: vi.fn().mockResolvedValue(1)
    },
    session: {
      findFirst: vi.fn().mockImplementation(() => Promise.resolve(existingForDevice)),
      findMany: vi.fn().mockImplementation(() => Promise.resolve(liveSessions)),
      create: vi.fn().mockResolvedValue({ id: "new-session" }),
      update: vi.fn().mockResolvedValue({ id: "reused-session" }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 })
    },
    role: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "role-1" }) }
  } as unknown as PrismaClient;
});

/** `completeSsoLogin` is the shortest path to `establishSession` — it skips password
 *  verification while going through the exact same session-issuing tail every login uses. */
const signIn = (deviceId?: string, userAgent = CHROME) =>
  runInTenant(
    client,
    () => completeSsoLogin(ORG, { email: "someone@x.io", name: "Someone" }, userAgent, "203.0.113.9", deviceId),
    ORG
  );

/** The user row `completeSsoLogin` finds, so it takes the existing-user branch. */
function userExists() {
  (client.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation((args: any) =>
    args?.where?.email
      ? Promise.resolve({ id: USER_ID, email: "someone@x.io", status: "ACTIVE", deletedAt: null, role: { name: "EMPLOYEE", permissions: [] }, userRoles: [] })
      : Promise.resolve({ firstLoginAt: new Date(), role: { name: "EMPLOYEE" } })
  );
}

describe("a known device reuses its session row", () => {
  beforeEach(userExists);

  it("REPLACES the row when the same device signs in again", async () => {
    existingForDevice = { id: "existing-session" };
    await signIn("device-abc");

    expect(client.session.create, "a repeat sign-in from a known device must not INSERT").not.toHaveBeenCalled();
    expect(client.session.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "existing-session" } })
    );
  });

  it("clears the rotation grace window on reuse, so the old secret dies immediately", async () => {
    // Reuse is a fresh CREDENTIAL, not a rotation. Carrying `previousRefreshHash` forward would
    // leave the pre-login secret valid inside the grace window — a token that survives a
    // re-authentication is exactly what the reuse-detection in `refresh` exists to catch.
    existingForDevice = { id: "existing-session" };
    await signIn("device-abc");

    const data = vi.mocked(client.session.update).mock.calls[0][0].data as Record<string, unknown>;
    expect(data.previousRefreshHash).toBeNull();
    expect(data.refreshRotatedAt).toBeNull();
  });

  it("INSERTS for a device that has never signed in", async () => {
    existingForDevice = null;
    await signIn("device-new");
    expect(client.session.create).toHaveBeenCalled();
    expect(client.session.update).not.toHaveBeenCalled();
  });

  it("looks the row up by user AND device AND user agent — never by device alone", async () => {
    // The cookie is not an authenticator. Pairing it with the browser string is what stops a
    // copied or stale cookie from silently taking over a different browser's session; when they
    // disagree the query simply misses and the caller gets a new row, which is the safe direction.
    existingForDevice = { id: "existing-session" };
    await signIn("device-abc", FIREFOX);

    const where = vi.mocked(client.session.findFirst).mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.userId).toBe(USER_ID);
    expect(where.deviceId).toBe("device-abc");
    expect(where.userAgent).toBe(FIREFOX);
    expect(where.revokedAt).toBeNull();
  });

  it("does not even look when the client sent no device id", async () => {
    // curl, the MCP server, anything without a cookie jar. It falls back to the old behaviour and
    // is bounded by the cap instead — no lookup to waste, and nothing to match against.
    await signIn(undefined);
    expect(client.session.findFirst).not.toHaveBeenCalled();
    expect(client.session.create).toHaveBeenCalled();
  });
});

describe("the per-user session cap", () => {
  beforeEach(userExists);

  /**
   * `n` PRE-EXISTING live sessions plus the one this sign-in creates — which is what the sweep
   * actually sees, since the row is written before it runs.
   *
   * Freshest first, matching `orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }]`. The new
   * row goes LAST because it has no `lastSeenAt` yet and MySQL sorts NULLs last on a DESC — which
   * is precisely the trap `keepId` exists to defuse.
   */
  /** Long enough ago to be evictable — past the 15-minute idle threshold. */
  const IDLE = 60 * 60_000;

  function liveCount(existing: number) {
    const base = Date.now() - IDLE;
    liveSessions = [
      ...Array.from({ length: existing }, (_, i) => ({
        id: `session-${i}`,
        lastSeenAt: new Date(base - i * 60_000),
        createdAt: new Date(base - i * 60_000)
      })),
      { id: "new-session", lastSeenAt: null, createdAt: new Date() }
    ];
  }

  it("leaves a user at or under the cap alone", async () => {
    // Nine existing + the new one = exactly the cap.
    liveCount(MAX_ACTIVE_SESSIONS_PER_USER - 1);
    await signIn("device-new");
    expect(client.session.updateMany).not.toHaveBeenCalled();
  });

  it("revokes the oldest beyond the cap, keeping exactly the cap alive", async () => {
    liveCount(MAX_ACTIVE_SESSIONS_PER_USER + 3); // 13 existing + 1 new = 14 live
    await signIn("device-new");

    const call = vi.mocked(client.session.updateMany).mock.calls[0][0];
    const doomed = (call.where as { id: { in: string[] } }).id.in;
    expect((call.data as { revokedAt: Date }).revokedAt).toBeInstanceOf(Date);
    // Four go, leaving nine of the old plus the new one — the cap, exactly.
    expect(doomed).toEqual(["session-9", "session-10", "session-11", "session-12"]);
    expect(liveSessions.length - doomed.length).toBe(MAX_ACTIVE_SESSIONS_PER_USER);
  });

  it("never evicts the session it just issued", async () => {
    // The new row has no `lastSeenAt`, so it sorts LAST under a least-recently-used ordering — a
    // naive sweep would sign the caller out at the exact moment they signed in.
    liveCount(MAX_ACTIVE_SESSIONS_PER_USER + 5);
    await signIn("device-new");

    const doomed = (vi.mocked(client.session.updateMany).mock.calls[0][0].where as { id: { in: string[] } }).id.in;
    expect(doomed).not.toContain("new-session");
  });

  it("evicts least-recently-used, not oldest-created", async () => {
    // An old session used five minutes ago must outlive a newer one abandoned last week —
    // "which device is still in someone's hand" is the question, not "which was created first".
    liveSessions = [
      { id: "used-recently", lastSeenAt: new Date(Date.now() - 5 * 60_000), createdAt: new Date(0) },
      ...Array.from({ length: MAX_ACTIVE_SESSIONS_PER_USER }, (_, i) => ({
        id: `stale-${i}`,
        lastSeenAt: new Date(Date.now() - (7 * 24 * 60 + i) * 60_000),
        createdAt: new Date()
      })),
      { id: "new-session", lastSeenAt: null, createdAt: new Date() }
    ];
    await signIn("device-new");

    const doomed = (vi.mocked(client.session.updateMany).mock.calls[0][0].where as { id: { in: string[] } }).id.in;
    expect(doomed).not.toContain("used-recently");
    expect(doomed).toContain(`stale-${MAX_ACTIVE_SESSIONS_PER_USER - 1}`);
  });

  /**
   * THE RULE THAT MATTERS MOST, and the one a plain cap gets wrong.
   *
   * The e2e suite found this: a workload signing in many times in a short window pushed working
   * sessions past the cap and revoked them, surfacing as a 401 on a token minted minutes earlier.
   * That is the same shape as a script or an integration polling `/auth/login` and quietly
   * signing a person out of the browser they are sitting in front of.
   */
  it("never evicts a session that is still in use, however far over the cap", async () => {
    const now = Date.now();
    liveSessions = [
      ...Array.from({ length: MAX_ACTIVE_SESSIONS_PER_USER * 3 }, (_, i) => ({
        id: `busy-${i}`,
        // All within the 15-minute activity window.
        lastSeenAt: new Date(now - i * 1_000),
        createdAt: new Date(now - i * 1_000)
      })),
      { id: "new-session", lastSeenAt: null, createdAt: new Date(now) }
    ];
    await signIn("device-new");

    expect(
      client.session.updateMany,
      "a cap willing to revoke an in-use session is worse than the problem it solves"
    ).not.toHaveBeenCalled();
  });

  it("sweeps the idle ones once they go quiet, even alongside active ones", async () => {
    const now = Date.now();
    liveSessions = [
      ...Array.from({ length: MAX_ACTIVE_SESSIONS_PER_USER }, (_, i) => ({
        id: `busy-${i}`,
        lastSeenAt: new Date(now - i * 1_000),
        createdAt: new Date(now - i * 1_000)
      })),
      { id: "abandoned", lastSeenAt: new Date(now - 3 * 60 * 60_000), createdAt: new Date(now - 3 * 60 * 60_000) },
      { id: "new-session", lastSeenAt: null, createdAt: new Date(now) }
    ];
    await signIn("device-new");

    const doomed = (vi.mocked(client.session.updateMany).mock.calls[0][0].where as { id: { in: string[] } }).id.in;
    expect(doomed).toEqual(["abandoned"]);
  });

  it("does not fail the sign-in when the sweep errors", async () => {
    // The session is already valid by this point. Turning a bookkeeping failure into a 500 would
    // lock someone out over housekeeping.
    liveCount(MAX_ACTIVE_SESSIONS_PER_USER + 2);
    vi.mocked(client.session.updateMany).mockRejectedValueOnce(new Error("deadlock"));
    await expect(signIn("device-new")).resolves.toBeTruthy();
  });
});

/**
 * The cookie itself. It is client-supplied input whose only job is to match an opaque string the
 * server generated, so the parsing rules are the whole security surface: anything that does not
 * look like one of ours is discarded rather than trusted, truncated, or coerced.
 */
describe("resolveDeviceId", () => {
  const asRequest = (deviceId?: string) => ({ cookies: deviceId === undefined ? {} : { deviceId } }) as never;

  it("keeps a well-formed id", async () => {
    const { resolveDeviceId } = await import("../../src/utils/device-cookie.js");
    const result = resolveDeviceId(asRequest("abc123_XYZ-456"));
    expect(result).toEqual({ deviceId: "abc123_XYZ-456", isNew: false });
  });

  it("mints a fresh one when the cookie is absent", async () => {
    const { resolveDeviceId } = await import("../../src/utils/device-cookie.js");
    const result = resolveDeviceId(asRequest(undefined));
    expect(result.isNew).toBe(true);
    expect(result.deviceId.length).toBeGreaterThan(16);
  });

  it("DISCARDS an oversized value rather than truncating it", async () => {
    // Truncating would silently merge two devices whose ids share a 64-character prefix — and a
    // value longer than the column is one that could never have come from us anyway.
    const { resolveDeviceId } = await import("../../src/utils/device-cookie.js");
    const result = resolveDeviceId(asRequest("a".repeat(200)));
    expect(result.isNew).toBe(true);
    expect(result.deviceId).not.toContain("aaaaaaaaaa");
  });

  it("discards anything outside the opaque-token alphabet", async () => {
    const { resolveDeviceId } = await import("../../src/utils/device-cookie.js");
    for (const hostile of ["../../etc/passwd", "a b", "<script>", "'; DROP TABLE Session; --", ""]) {
      expect(resolveDeviceId(asRequest(hostile)).isNew, hostile).toBe(true);
    }
  });

  it("never mints an id longer than the column can hold", async () => {
    // A value the column truncates on write can never match on read, which would look like
    // "device reuse silently stopped working" and be very hard to trace back to here.
    const { resolveDeviceId } = await import("../../src/utils/device-cookie.js");
    for (let i = 0; i < 20; i++) expect(resolveDeviceId(asRequest(undefined)).deviceId.length).toBeLessThanOrEqual(64);
  });
});
