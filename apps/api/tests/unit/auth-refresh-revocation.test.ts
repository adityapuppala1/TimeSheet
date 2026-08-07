/**
 * A Session row can outlive the account it belongs to: SCIM's DELETE /Users/:id only flips
 * `status` to INACTIVE (scim.controller.ts), and the single-user DELETE /api/users/:id used to
 * soft-delete without revoking anything. `refresh()` looked only at the session, so a disabled
 * or deleted account kept rotating itself a fresh token pair for the session's whole lifetime
 * (up to 30 days on "remember me"). requireAuth refuses the resulting access token, but a
 * session that outlives its account should be dead, not merely useless.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } }
}));
vi.mock("../../src/services/maintenance.service.js", () => ({
  isMaintenanceActive: vi.fn().mockResolvedValue(false)
}));

const { refresh } = await import("../../src/services/auth.service.js");
const { signRefreshToken, hashToken, opaqueToken } = await import("../../src/utils/security.js");

const USER_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const ORG = "org-1";

let client: PrismaClient;
let secret: string;
let token: string;

async function seedSession() {
  secret = opaqueToken();
  token = `${signRefreshToken(USER_ID, SESSION_ID, 14, ORG)}.${secret}`;
  vi.mocked(client.session.findUnique).mockResolvedValue({
    id: SESSION_ID,
    userId: USER_ID,
    refreshHash: await hashToken(secret),
    previousRefreshHash: null,
    refreshRotatedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  } as never);
}

beforeEach(async () => {
  client = {
    session: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    user: { findUnique: vi.fn().mockResolvedValue({ status: "ACTIVE", deletedAt: null }) }
  } as unknown as PrismaClient;
  await seedSession();
});

describe("refresh() checks the account, not just the session", () => {
  it("rotates normally for an active account", async () => {
    const result = await runInTenant(client, () => refresh(token), ORG);
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toContain(".");
  });

  it("refuses a deactivated account and revokes the session outright", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue({ status: "INACTIVE", deletedAt: null } as never);
    await expect(runInTenant(client, () => refresh(token), ORG)).rejects.toMatchObject({ statusCode: 401 });
    expect(vi.mocked(client.session.update).mock.calls[0]![0]).toMatchObject({
      where: { id: SESSION_ID },
      data: { revokedAt: expect.any(Date) }
    });
  });

  it("refuses a soft-deleted account", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue({ status: "ACTIVE", deletedAt: new Date() } as never);
    await expect(runInTenant(client, () => refresh(token), ORG)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("refuses when the user row is gone entirely", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue(null as never);
    await expect(runInTenant(client, () => refresh(token), ORG)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("still refuses a token minted under a different org", async () => {
    await expect(runInTenant(client, () => refresh(token), "other-org")).rejects.toMatchObject({ statusCode: 401 });
    // Rejected on the org claim alone — it must never have reached the session lookup.
    expect(client.session.findUnique).not.toHaveBeenCalled();
  });
});
