/**
 * The failed-login lockout counter in services/auth.service.ts is module state living in ONE
 * Node process that serves EVERY tenant database. These tests pin the property that makes that
 * safe: the counter is keyed by (orgId, email), so exhausting the attempts for an address in
 * one org has no effect on the same address in another.
 *
 * Keyed on email alone — the shape this replaces — the map was a remote, unauthenticated
 * cross-tenant DoS: `recordFailedLogin` fires on "no such user" too, so five POSTs at any org's
 * login route locked the address out of every org for five minutes, repeatable forever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } }
}));
// establishSession's maintenance gate is a tenant-DB read of its own; the lockout is what's
// under test here, so the successful-login path shouldn't have to satisfy it.
vi.mock("../../src/services/maintenance.service.js", () => ({
  isMaintenanceActive: vi.fn().mockResolvedValue(false)
}));

const { login, __resetLoginLockoutsForTests } = await import("../../src/services/auth.service.js");
const { hashPassword } = await import("../../src/utils/security.js");

const PASSWORD = "correct-horse-battery-staple";
let passwordHash: string;
let client: ReturnType<typeof createFakeTenantClient>;

/** Every field `login`'s success path reads, plus the PROFILE_INCLUDE relations. */
function userRow() {
  return {
    id: "user-1",
    name: "Ada",
    email: "ada@example.com",
    passwordHash,
    status: "ACTIVE",
    deletedAt: null,
    mustChangePassword: false,
    avatarUrl: null,
    bio: null,
    phoneNumber: null,
    timezone: null,
    managerId: null,
    manager: null,
    role: { name: "EMPLOYEE", permissions: [] },
    userRoles: []
  };
}

const attempt = (orgId: string, email: string, password: string) =>
  runInTenant(client, () => login(email, password), orgId);

/** Drives `login` to the `recordFailedLogin` branch and returns the HTTP status it threw. */
async function failedAttemptStatus(orgId: string, email = "ada@example.com") {
  try {
    await attempt(orgId, email, "wrong-password");
    throw new Error("login unexpectedly succeeded");
  } catch (error) {
    return (error as { statusCode?: number }).statusCode;
  }
}

beforeEach(async () => {
  __resetLoginLockoutsForTests();
  client = createFakeTenantClient();
  // Default: the address does not exist in this tenant's database — the exact case the old
  // email-only key let an attacker weaponize.
  vi.mocked(client.user.findUnique).mockResolvedValue(null as never);
  passwordHash ??= await hashPassword(PASSWORD);
});

describe("failed-login lockout is per (org, email)", () => {
  it("locking an address out of org A leaves the SAME address usable in org B", async () => {
    for (let i = 0; i < 5; i += 1) expect(await failedAttemptStatus("org-a")).toBe(401);
    expect(await failedAttemptStatus("org-a")).toBe(429);

    // Same email, different tenant: untouched counter, so still a plain credential rejection.
    expect(await failedAttemptStatus("org-b")).toBe(401);
  });

  it("does not lock a real account in org B out of its own org", async () => {
    for (let i = 0; i < 6; i += 1) await failedAttemptStatus("org-a");

    vi.mocked(client.user.findUnique).mockResolvedValue(userRow() as never);
    vi.mocked(client.session.create).mockResolvedValue({ id: "sess-1" } as never);
    vi.mocked(client.user.update).mockResolvedValue(userRow() as never);

    const result = await attempt("org-b", "ada@example.com", PASSWORD);
    expect(result.user.id).toBe("user-1");
    expect(result.accessToken).toEqual(expect.any(String));
  });

  it("counts case-insensitively within one org, so casing can't buy extra attempts", async () => {
    for (let i = 0; i < 5; i += 1) await failedAttemptStatus("org-a", "ADA@example.com");
    expect(await failedAttemptStatus("org-a", "ada@EXAMPLE.com")).toBe(429);
  });
});

describe("the lockout still triggers and expires within one org", () => {
  it("allows exactly 5 attempts, then locks", async () => {
    for (let i = 0; i < 4; i += 1) expect(await failedAttemptStatus("org-a")).toBe(401);
    // The 5th attempt is still evaluated (and rejected on credentials) — it's what arms the lock.
    expect(await failedAttemptStatus("org-a")).toBe(401);
    expect(await failedAttemptStatus("org-a")).toBe(429);
    expect(await failedAttemptStatus("org-a")).toBe(429);
  });

  it("locks the credential check out entirely — a LOCKED account never reaches the password compare", async () => {
    for (let i = 0; i < 5; i += 1) await failedAttemptStatus("org-a");
    vi.mocked(client.user.findUnique).mockClear();
    expect(await failedAttemptStatus("org-a")).toBe(429);
    expect(client.user.findUnique).not.toHaveBeenCalled();
  });

  it("expires after the 5-minute window", async () => {
    for (let i = 0; i < 5; i += 1) await failedAttemptStatus("org-a");
    expect(await failedAttemptStatus("org-a")).toBe(429);

    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 5 * 60_000 + 1);
    expect(await failedAttemptStatus("org-a")).toBe(401);
    vi.mocked(Date.now).mockRestore();
  });

  it("a successful login clears that org's counter", async () => {
    for (let i = 0; i < 4; i += 1) await failedAttemptStatus("org-a");

    vi.mocked(client.user.findUnique).mockResolvedValue(userRow() as never);
    vi.mocked(client.session.create).mockResolvedValue({ id: "sess-1" } as never);
    vi.mocked(client.user.update).mockResolvedValue(userRow() as never);
    await attempt("org-a", "ada@example.com", PASSWORD);

    vi.mocked(client.user.findUnique).mockResolvedValue(null as never);
    // Without the clear, the 5th failure would arm the lock and the 6th would be a 429.
    for (let i = 0; i < 5; i += 1) expect(await failedAttemptStatus("org-a")).toBe(401);
  });
});
