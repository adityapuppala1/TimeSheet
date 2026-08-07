/**
 * Login must not disclose whether an email is registered. The body and status are already
 * identical for "no such account" and "wrong password" (both a 401 "Invalid email or password").
 * The remaining leak was TIMING: `login` only ran bcrypt when the account existed, so a missing
 * email returned in a few ms and a real account in ~200ms — a per-guess oracle over the identical
 * response. The fix compares an unknown account's password against a constant sentinel hash so
 * exactly one bcrypt round happens either way; this test pins that the round is not skipped.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } }
}));

// Wrap the real security module so bcrypt still runs for real, but every verifyPassword call is
// counted — the assertion is "the compare happened", not what it returned.
vi.mock("../../src/utils/security.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/utils/security.js")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const { login, __resetLoginLockoutsForTests } = await import("../../src/services/auth.service.js");
const { verifyPassword, DUMMY_PASSWORD_HASH } = await import("../../src/utils/security.js");

let client: ReturnType<typeof createFakeTenantClient>;

const attempt = (email: string, password: string) =>
  runInTenant(client, () => login(email, password), "org-a");

beforeEach(() => {
  __resetLoginLockoutsForTests();
  client = createFakeTenantClient();
  vi.mocked(verifyPassword).mockClear();
});

describe("login does not leak account existence through timing", () => {
  it("still runs one bcrypt round when the email does not exist", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue(null as never);

    await expect(attempt("ghost@example.com", "whatever-password")).rejects.toMatchObject({ statusCode: 401 });

    // The load-bearing assertion: the expensive compare ran even though there was no user. A
    // pre-fix `login` short-circuits and never calls it, leaving the fast path detectable.
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledWith("whatever-password", DUMMY_PASSWORD_HASH);
  });

  it("runs exactly one bcrypt round for a wrong password on a real account too", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue({
      id: "u1",
      email: "real@example.com",
      passwordHash: DUMMY_PASSWORD_HASH, // a hash the supplied password won't match
      status: "ACTIVE",
      deletedAt: null,
      role: { name: "EMPLOYEE", permissions: [] }
    } as never);

    await expect(attempt("real@example.com", "definitely-not-it")).rejects.toMatchObject({ statusCode: 401 });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });
});
