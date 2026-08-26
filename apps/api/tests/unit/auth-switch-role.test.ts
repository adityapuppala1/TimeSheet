/**
 * `POST /api/auth/switch-role` — self-service switching among roles an account already holds.
 * Granting a NEW role is a completely separate, SUPER_ADMIN-only path (user.controller.ts,
 * see user-role-assignment.test.ts); this route can only ever narrow/widen what's currently
 * active among roles already granted, never touch the held-role set itself.
 */
import { describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { audit } = await import("../../src/services/audit.service.js");
const { switchActiveRole } = await import("../../src/services/auth.service.js");

const USER_ID = "user-1";

describe("switchActiveRole", () => {
  it("switches to a role the account holds, and returns the fresh profile", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.userRole.findFirst).mockResolvedValue({ roleId: "role-manager" } as never);
    vi.mocked(client.user.findUniqueOrThrow)
      .mockResolvedValueOnce({ role: { name: "SUPER_ADMIN" } } as never) // "before" lookup
      .mockResolvedValueOnce({
        // buildProfilePayload's own fetch, after the switch
        id: USER_ID,
        name: "Aditya",
        email: "aditya@x.io",
        role: { name: "MANAGER", permissions: [] },
        userRoles: [{ role: { name: "SUPER_ADMIN" } }, { role: { name: "MANAGER" } }],
        mustChangePassword: false,
        avatarUrl: null,
        bio: null,
        phoneNumber: null,
        timezone: null,
        managerId: null,
        manager: null
      } as never);
    vi.mocked(client.user.update).mockResolvedValue({} as never);

    const result = await runInTenant(client, () => switchActiveRole(USER_ID, "MANAGER"));

    expect(client.user.update).toHaveBeenCalledWith({ where: { id: USER_ID }, data: { roleId: "role-manager" } });
    expect(result.role).toBe("MANAGER");
    expect(result.heldRoles).toEqual(expect.arrayContaining(["SUPER_ADMIN", "MANAGER"]));
    expect(audit).toHaveBeenCalledWith(USER_ID, "user.role_switched", "User", USER_ID, { from: "SUPER_ADMIN", to: "MANAGER" });
  });

  it("refuses to switch to a role the account does not hold", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.userRole.findFirst).mockResolvedValue(null as never);

    await expect(runInTenant(client, () => switchActiveRole(USER_ID, "SUPER_ADMIN"))).rejects.toMatchObject({ statusCode: 403 });
    expect(client.user.update).not.toHaveBeenCalled();
  });
});
