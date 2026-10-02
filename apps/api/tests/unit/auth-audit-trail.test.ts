/**
 * The sign-in audit trail and the "your password was changed" mail (security audit #16).
 *
 * THE DEFECT: no audit row for a password sign-in, a failed one, a sign-out, a self-service
 * password change, a reset request or a completed reset — so "who signed in as this person, from
 * where, and when did the password change?" had no answer — and nobody was told when their password
 * changed, which is how an owner finds out somebody else changed it.
 *
 * Pinned: each event writes its row (with the request's IP), a failed sign-in records the address
 * tried but NEVER the password, a change or a reset mails the account holder, and none of this can
 * fail a sign-in. (SSO sign-in rows are written inside completeSsoLogin, separately.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });
import type { PrismaClient } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));
const audit = vi.fn(async () => undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit }));
const dispatchTransactional = vi.fn(async () => ({ ok: true }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({
  rememberWorkspaceMembership: vi.fn(),
  tenantBaseUrl: () => "https://acme.timesphere.test"
}));

const { __resetLoginLockoutsForTests, changePassword, endSessions, login, requestPasswordReset, resetPassword } = await import(
  "../../src/services/auth.service.js"
);
const { hashPassword, signRefreshToken } = await import("../../src/utils/security.js");

const USER = "33333333-3333-4333-8333-333333333333";
const SID = "44444444-4444-4444-8444-444444444444";
const PASSWORD = "the-current-one";
const IP = "203.0.113.7";
let passwordHash: string;
let client: ReturnType<typeof createFakeTenantClient> & Record<string, any>;

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER, name: "Ada <Lovelace>", email: "ada@example.com", passwordHash, status: "ACTIVE", deletedAt: null, mustChangePassword: false,
    avatarUrl: null, bio: null, phoneNumber: null, timezone: null, managerId: null, manager: null, appearance: null, aiPreferences: null,
    role: { name: "EMPLOYEE", permissions: [] }, userRoles: [], firstLoginAt: new Date(), isAgent: false, ...overrides
  };
}
const inTenant = <T>(fn: () => Promise<T>) => runInTenant(client as PrismaClient, fn, "org-1");
const actions = () => audit.mock.calls.map((call) => (call as unknown[])[1]);
const callFor = (action: string) => audit.mock.calls.find((call) => (call as unknown[])[1] === action) as unknown[] | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  __resetLoginLockoutsForTests();
  passwordHash ??= await hashPassword(PASSWORD);
  client = createFakeTenantClient() as typeof client;
  vi.mocked(client.user.findUnique).mockResolvedValue(userRow() as never);
  vi.mocked(client.user.findUniqueOrThrow).mockResolvedValue(userRow() as never);
  vi.mocked(client.user.update).mockResolvedValue(userRow() as never);
  vi.mocked(client.session.findMany).mockResolvedValue([] as never);
  vi.mocked(client.session.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(client.session.create).mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({ id: SID, ...data })) as never);
  client.session.findFirst = vi.fn().mockResolvedValue(null);
  client.passwordResetToken = {
    create: vi.fn(async ({ data }: { data: unknown }) => data),
    count: vi.fn().mockResolvedValue(0),
    findUnique: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 })
  };
});

describe("sign-in", () => {
  it("a password sign-in writes auth.login_succeeded with the IP", async () => {
    await inTenant(() => login("ada@example.com", PASSWORD, false, "UA", IP));
    const call = callFor("auth.login_succeeded");
    expect(call).toBeDefined();
    expect(call![0]).toBe(USER);
    expect(call![5]).toMatchObject({ ipAddress: IP });
  });

  it("a failed sign-in writes auth.login_failed with the address tried — and never the password", async () => {
    await expect(inTenant(() => login("ada@example.com", "my-secret-guess-123", false, "UA", IP))).rejects.toMatchObject({ statusCode: 401 });
    const call = callFor("auth.login_failed");
    expect(call).toBeDefined();
    expect(JSON.stringify(call)).toContain("ada@example.com");
    expect(JSON.stringify(call)).not.toContain("my-secret-guess-123");
    expect(call![5]).toMatchObject({ ipAddress: IP });
  });

  it("an unknown address is recorded too, with no actor", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue(null as never);
    await expect(inTenant(() => login("nobody@example.com", "whatever-1234", false, "UA", IP))).rejects.toMatchObject({ statusCode: 401 });
    expect(callFor("auth.login_failed")![0]).toBeUndefined();
  });

  it("a broken audit table never fails a sign-in", async () => {
    audit.mockRejectedValueOnce(new Error("audit table locked"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(inTenant(() => login("ada@example.com", PASSWORD, false, "UA", IP))).resolves.toMatchObject({ accessToken: expect.any(String) });
  });
});

describe("sign-out", () => {
  it("writes auth.logout for the session it ended", async () => {
    await inTenant(() => endSessions({ refreshToken: `${signRefreshToken(USER, SID, 1, "org-1")}.x` }, IP));
    const call = callFor("auth.logout");
    expect(call).toBeDefined();
    expect(call![0]).toBe(USER);
  });
});

describe("password changes", () => {
  it("a self-service change writes auth.password_changed and mails the account holder", async () => {
    await inTenant(() => changePassword(USER, PASSWORD, "a-genuinely-new-one", SID, IP));
    expect(actions()).toContain("auth.password_changed");
    await vi.waitFor(() => expect(dispatchTransactional).toHaveBeenCalledTimes(1));
    const mail = (dispatchTransactional.mock.calls[0] as unknown[])[0] as { to: string; templateKey: string; vars: Record<string, string> };
    expect(mail.to).toBe("ada@example.com");
    expect(mail.templateKey).toBe("account.password_changed");
    // An admin-edited template inserts vars verbatim, so a name is escaped before it gets there.
    expect(mail.vars.name).toBe("Ada &lt;Lovelace&gt;");
  });

  it("a reset request writes auth.password_reset_requested", async () => {
    await inTenant(() => requestPasswordReset("ada@example.com", IP));
    expect(actions()).toContain("auth.password_reset_requested");
  });

  it("a completed reset writes auth.password_reset_completed and mails the account holder", async () => {
    const { createHash } = await import("node:crypto");
    client.passwordResetToken.findUnique.mockResolvedValue({
      id: "tok", userId: USER, selector: "s".repeat(16), tokenHash: createHash("sha256").update("v".repeat(48)).digest("hex"),
      usedAt: null, expiresAt: new Date(Date.now() + 60_000)
    });
    await inTenant(() => resetPassword(`${"s".repeat(16)}.${"v".repeat(48)}`, "a-genuinely-new-one", IP));
    expect(actions()).toContain("auth.password_reset_completed");
    await vi.waitFor(() => expect(dispatchTransactional).toHaveBeenCalledTimes(1));
  });
});
