import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../src/utils/encryption.js";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { buildScimApp } from "../helpers/test-apps.js";

// scim.controller.ts's `withOrgTenant` resolves the org (control-plane lookup) and then
// constructs a REAL PrismaClient for whatever DSN it gets back — both need mocking for a
// "unit" test that never touches a real database. `prisma` (the tenant-context Proxy) is kept
// real via importOriginal, since only `getTenantClient`'s DSN-based construction is the problem.
const { mockResolveActiveOrgBySlug, mockGetTenantClient, mockGetEffectiveSeatLimit, mockSyncSubscriptionSeats, mockRememberWorkspaceMembership } = vi.hoisted(() => ({
  mockResolveActiveOrgBySlug: vi.fn(),
  mockGetTenantClient: vi.fn(),
  mockGetEffectiveSeatLimit: vi.fn(),
  mockSyncSubscriptionSeats: vi.fn(),
  mockRememberWorkspaceMembership: vi.fn()
}));

vi.mock("../../src/middleware/tenant.js", () => ({ resolveActiveOrgBySlug: mockResolveActiveOrgBySlug }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit: mockGetEffectiveSeatLimit }));
vi.mock("../../src/services/billing-sync.service.js", () => ({ syncSubscriptionSeats: mockSyncSubscriptionSeats }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({
  rememberWorkspaceMembership: mockRememberWorkspaceMembership,
  tenantBaseUrl: () => "https://test-org.timesphere.test"
}));
vi.mock("../../src/config/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTenantClient: mockGetTenantClient
}));

const SCIM_TOKEN = "scim-test-fixture-token";
const ORG_SLUG = "test-org";

function fakeOrg() {
  return {
    id: "org-1",
    slug: ORG_SLUG,
    status: "ACTIVE",
    database: { encryptedDsn: encryptSecret("mysql://unused-since-getTenantClient-is-mocked") }
  };
}

function scimAuthHeader(token = SCIM_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

let client: ReturnType<typeof createFakeTenantClient>;

beforeEach(() => {
  client = createFakeTenantClient();
  mockResolveActiveOrgBySlug.mockReset().mockResolvedValue(fakeOrg());
  mockGetTenantClient.mockReset().mockResolvedValue(client);
  mockGetEffectiveSeatLimit.mockReset().mockResolvedValue(10);
  mockSyncSubscriptionSeats.mockReset().mockResolvedValue(undefined);
  mockRememberWorkspaceMembership.mockReset().mockResolvedValue(undefined);
  vi.mocked(client.scimSettings.findUnique).mockResolvedValue({
    id: "global",
    isEnabled: true,
    encryptedToken: encryptSecret(SCIM_TOKEN)
  } as never);
});

describe("SCIM auth", () => {
  it("404s when SCIM has never been enabled for this workspace", async () => {
    vi.mocked(client.scimSettings.findUnique).mockResolvedValue(null);
    const res = await request(buildScimApp()).get(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader());
    expect(res.status).toBe(404);
  });

  it("401s on a missing bearer token", async () => {
    const res = await request(buildScimApp()).get(`/api/scim/${ORG_SLUG}/v2/Users`);
    expect(res.status).toBe(401);
  });

  it("401s on an incorrect bearer token", async () => {
    const res = await request(buildScimApp()).get(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader("wrong-token"));
    expect(res.status).toBe(401);
  });
});

describe("GET /:orgSlug/v2/Users", () => {
  it("lists users unfiltered when no filter query param is given", async () => {
    vi.mocked(client.user.findMany).mockResolvedValue([]);
    const res = await request(buildScimApp()).get(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader());

    expect(res.status).toBe(200);
    expect(client.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null } }));
  });

  it("parses a userName eq \"...\" filter into an email match", async () => {
    vi.mocked(client.user.findMany).mockResolvedValue([]);
    const res = await request(buildScimApp())
      .get(`/api/scim/${ORG_SLUG}/v2/Users`)
      .query({ filter: 'userName eq "person@example.com"' })
      .set(scimAuthHeader());

    expect(res.status).toBe(200);
    expect(client.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, email: "person@example.com" } })
    );
  });
});

describe("GET /:orgSlug/v2/Users/:id", () => {
  it("404s (SCIM-shaped error body) when the user doesn't exist", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(null);
    const res = await request(buildScimApp()).get(`/api/scim/${ORG_SLUG}/v2/Users/does-not-exist`).set(scimAuthHeader());
    expect(res.status).toBe(404);
    expect(res.body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
  });
});

describe("POST /:orgSlug/v2/Users", () => {
  const validBody = { userName: "new.person@example.com", name: { givenName: "New", familyName: "Person" } };

  it("400s on a body that doesn't match the SCIM User schema", async () => {
    const res = await request(buildScimApp()).post(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader()).send({ userName: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("409s when a user with that userName already exists", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue({ id: "existing-user" } as never);
    const res = await request(buildScimApp()).post(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader()).send(validBody);
    expect(res.status).toBe(409);
  });

  it("403s when the org's seat limit has been reached", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue(null);
    mockGetEffectiveSeatLimit.mockResolvedValue(2);
    vi.mocked(client.user.count).mockResolvedValue(2);
    const res = await request(buildScimApp()).post(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader()).send(validBody);
    expect(res.status).toBe(403);
  });

  it("reads a string active:\"False\" on create the way PATCH does, and refuses an unreadable one", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue(null);
    vi.mocked(client.user.count).mockResolvedValue(0);
    vi.mocked(client.role.findUniqueOrThrow).mockResolvedValue({ id: "role-employee", name: "EMPLOYEE" } as never);
    vi.mocked(client.user.create).mockResolvedValue({ id: "user-1", name: "N", email: "new.person@example.com", status: "INACTIVE", scimExternalId: null } as never);

    const ok = await request(buildScimApp()).post(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader()).send({ ...validBody, active: "False" });
    expect(ok.status).toBe(201);
    expect(client.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "INACTIVE" }) }));

    const bad = await request(buildScimApp()).post(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader()).send({ ...validBody, active: "maybe" });
    expect(bad.status).toBe(400);
  });

  it("creates an EMPLOYEE-role user on success", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue(null);
    vi.mocked(client.user.count).mockResolvedValue(0);
    vi.mocked(client.role.findUniqueOrThrow).mockResolvedValue({ id: "role-employee", name: "EMPLOYEE" } as never);
    vi.mocked(client.user.create).mockResolvedValue({
      id: "user-1",
      name: "New Person",
      email: "new.person@example.com",
      status: "ACTIVE",
      scimExternalId: null
    } as never);

    const res = await request(buildScimApp()).post(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader()).send(validBody);

    expect(res.status).toBe(201);
    expect(client.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "new.person@example.com", roleId: "role-employee", status: "ACTIVE" }) })
    );
  });

  it("writes the new account's UserRole row in the same create, so it holds the role it was given", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue(null);
    vi.mocked(client.user.count).mockResolvedValue(0);
    vi.mocked(client.role.findUniqueOrThrow).mockResolvedValue({ id: "role-employee", name: "EMPLOYEE" } as never);
    vi.mocked(client.user.create).mockResolvedValue({ id: "user-1", name: "N", email: "new.person@example.com", status: "ACTIVE", scimExternalId: null } as never);

    const res = await request(buildScimApp()).post(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader()).send(validBody);

    expect(res.status).toBe(201);
    expect(client.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userRoles: { create: { roleId: "role-employee" } } }) })
    );
  });

  it("a provisioned account brings the Stripe seat quantity along", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue(null);
    vi.mocked(client.user.count).mockResolvedValue(0);
    vi.mocked(client.role.findUniqueOrThrow).mockResolvedValue({ id: "role-employee", name: "EMPLOYEE" } as never);
    vi.mocked(client.user.create).mockResolvedValue({ id: "user-1", name: "N", email: "new.person@example.com", status: "ACTIVE", scimExternalId: null } as never);

    await request(buildScimApp()).post(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader()).send(validBody).expect(201);

    expect(mockSyncSubscriptionSeats).toHaveBeenCalledWith("org-1");
  });

  it("a provisioned ACTIVE account can find its workspace by email straight away; an inactive one is not listed", async () => {
    // The finder lists workspaces an address can sign in to. Until now it learned of a SCIM account
    // only at that account's first sign-in — after the person had already found the workspace.
    vi.mocked(client.user.findUnique).mockResolvedValue(null);
    vi.mocked(client.user.count).mockResolvedValue(0);
    vi.mocked(client.role.findUniqueOrThrow).mockResolvedValue({ id: "role-employee", name: "EMPLOYEE" } as never);
    vi.mocked(client.user.create)
      .mockResolvedValueOnce({ id: "user-1", name: "N", email: "new.person@example.com", status: "ACTIVE", scimExternalId: null } as never)
      .mockResolvedValueOnce({ id: "user-2", name: "M", email: "later@example.com", status: "INACTIVE", scimExternalId: null } as never);

    await request(buildScimApp()).post(`/api/scim/${ORG_SLUG}/v2/Users`).set(scimAuthHeader()).send(validBody).expect(201);
    await request(buildScimApp())
      .post(`/api/scim/${ORG_SLUG}/v2/Users`)
      .set(scimAuthHeader())
      .send({ userName: "later@example.com", active: false })
      .expect(201);

    expect(mockRememberWorkspaceMembership.mock.calls).toEqual([["org-1", "new.person@example.com"]]);
  });
});

describe("PATCH /:orgSlug/v2/Users/:id — deprovision/reactivate", () => {
  // What the route selects: the SCIM fields, plus the role rows the last-super-admin rule reads.
  const existingUser = { id: "user-1", name: "Existing Person", email: "existing@example.com", status: "ACTIVE", scimExternalId: null, deletedAt: null, role: { name: "EMPLOYEE" }, userRoles: [] };

  it("replace active:false deactivates the user", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(existingUser as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...existingUser, status: "INACTIVE" } as never);

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/user-1`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: false }] });

    expect(res.status).toBe(200);
    expect(client.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "INACTIVE" } }));
  });

  it("replace active:true reactivates the user", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue({ ...existingUser, status: "INACTIVE" } as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...existingUser, status: "ACTIVE" } as never);
    vi.mocked(client.user.count).mockResolvedValue(3); // seats in use, of 10

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/user-1`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: true }] });

    expect(res.status).toBe(200);
    expect(client.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "ACTIVE" } }));
  });

  /**
   * Entra ID's default deprovisioning body, byte for byte. Two things in it break a naive reader:
   * the value is the STRING "False" (capitalised), not a boolean, and the request is sent as
   * `application/scim+json` (RFC 7644's media type), which a parser registered for
   * `application/json` alone skips. Either one turns "this person left the company" into a 200
   * that changed nothing — or a 400 the IdP retries forever while the account stays live.
   */
  const ENTRA_DEPROVISION = '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"Replace","path":"active","value":"False"}]}';

  it("Entra's exact deprovision body (value \"False\", sent as application/scim+json) deactivates the user", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(existingUser as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...existingUser, status: "INACTIVE" } as never);

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/user-1`)
      .set(scimAuthHeader())
      .set("Content-Type", "application/scim+json")
      .send(ENTRA_DEPROVISION);

    expect(res.status).toBe(200);
    expect(client.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "INACTIVE" } }));
    expect(res.body.active).toBe(false);
  });

  it("the same body sent as application/json is read the same way", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(existingUser as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...existingUser, status: "INACTIVE" } as never);

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/user-1`)
      .set(scimAuthHeader())
      .set("Content-Type", "application/json")
      .send(ENTRA_DEPROVISION);

    expect(res.status).toBe(200);
    expect(client.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "INACTIVE" } }));
  });

  it.each([
    ["\"True\" with a path", { op: "Replace", path: "active", value: "True" }, "ACTIVE"],
    ["\"true\" with a path", { op: "replace", path: "active", value: "true" }, "ACTIVE"],
    ["\"FALSE\" with no path", { op: "Replace", value: { active: "FALSE" } }, "INACTIVE"],
    ["boolean false with no path", { op: "replace", value: { active: false } }, "INACTIVE"]
  ])("reads active as %s", async (_label, operation, expected) => {
    const startedAs = expected === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    vi.mocked(client.user.findFirst).mockResolvedValue({ ...existingUser, status: startedAs } as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...existingUser, status: expected } as never);
    vi.mocked(client.user.count).mockResolvedValue(0);

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/user-1`)
      .set(scimAuthHeader())
      .send({ Operations: [operation] });

    expect(res.status).toBe(200);
    expect(client.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: expected } }));
  });

  it("an active value that is neither a boolean nor true/false changes nothing", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(existingUser as never);

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/user-1`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "Replace", path: "active", value: "no" }] });

    expect(res.status).toBe(200);
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("reactivating on a full plan is refused like a create is, and changes nothing", async () => {
    // The seat limit used to be checked on create only, so an IdP could deprovision and reprovision
    // its way past it — or reactivate people an admin had deactivated to make room.
    vi.mocked(client.user.findFirst).mockResolvedValue({ ...existingUser, status: "INACTIVE" } as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...existingUser, status: "ACTIVE" } as never);
    mockGetEffectiveSeatLimit.mockResolvedValue(3);
    vi.mocked(client.user.count).mockResolvedValue(3);

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/user-1`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: true }] });

    expect(res.status).toBe(403);
    expect(res.body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    expect(res.body.detail).toMatch(/seat limit/i);
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("a deprovision or reactivation brings the Stripe seat quantity along", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(existingUser as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...existingUser, status: "INACTIVE" } as never);

    await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/user-1`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: false }] })
      .expect(200);

    expect(mockSyncSubscriptionSeats).toHaveBeenCalledWith("org-1");
  });

  it("a PATCH that leaves the status where it was does not call Stripe", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(existingUser as never);
    vi.mocked(client.user.update).mockResolvedValue(existingUser as never);

    await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/user-1`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: true }] })
      .expect(200);

    expect(mockSyncSubscriptionSeats).not.toHaveBeenCalled();
  });

  it("404s when the target user doesn't exist", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(null);
    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/missing`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: false }] });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /:orgSlug/v2/Users/:id — soft-deactivate", () => {
  it("sets status to INACTIVE and returns 204", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue({ id: "user-1", status: "ACTIVE", deletedAt: null, role: { name: "EMPLOYEE" }, userRoles: [] } as never);
    vi.mocked(client.user.update).mockResolvedValue({} as never);

    const res = await request(buildScimApp()).delete(`/api/scim/${ORG_SLUG}/v2/Users/user-1`).set(scimAuthHeader());

    expect(res.status).toBe(204);
    expect(client.user.update).toHaveBeenCalledWith({ where: { id: "user-1" }, data: { status: "INACTIVE" } });
    expect(mockSyncSubscriptionSeats).toHaveBeenCalledWith("org-1");
  });

  it("404s when the target user doesn't exist", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(null);
    const res = await request(buildScimApp()).delete(`/api/scim/${ORG_SLUG}/v2/Users/missing`).set(scimAuthHeader());
    expect(res.status).toBe(404);
  });
});

/**
 * The IdP is the source of truth for who works here — except for the one account the workspace
 * cannot run without. Deprovisioning the last ACTIVE super admin left nobody who could pay, reach SSO
 * settings or grant super admin, and nothing inside the product could undo it: an ADMIN may not touch
 * a super admin's account, and the platform rescue refuses an INACTIVE one. Slack's primary-owner
 * rule: the IdP is told to hand the role on first, with a SCIM error it shows its operator.
 */
describe("SCIM deprovisioning and the workspace's last super admin", () => {
  const founder = {
    id: "founder",
    name: "Founder",
    email: "founder@example.com",
    status: "ACTIVE",
    scimExternalId: "entra-1",
    isAgent: false,
    deletedAt: null,
    role: { name: "SUPER_ADMIN" },
    userRoles: [{ role: { name: "SUPER_ADMIN" } }]
  };

  /** `user.count` answers two questions here: how many OTHER active super admins there are (its
   *  where names the SUPER_ADMIN role), and how many seats are taken (the seat sync). */
  function otherSuperAdmins(count: number) {
    vi.mocked(client.role.findUniqueOrThrow).mockResolvedValue({ id: "role-sa", name: "SUPER_ADMIN" } as never);
    vi.mocked(client.user.count).mockImplementation((async (args: { where?: { OR?: unknown } } = {}) => (args.where?.OR ? count : 5)) as never);
  }

  it("PATCH active:false on the last super admin is refused with a SCIM 409 that says to assign another first", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(founder as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...founder, status: "INACTIVE" } as never);
    otherSuperAdmins(0);

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/founder`)
      .set(scimAuthHeader())
      .set("Content-Type", "application/scim+json")
      .send('{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"Replace","path":"active","value":"False"}]}');

    expect(res.status).toBe(409);
    expect(res.body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    expect(res.body.status).toBe("409");
    expect(res.body.detail).toMatch(/assign another super admin first/i);
    expect(client.user.update).not.toHaveBeenCalled();
    expect(mockSyncSubscriptionSeats).not.toHaveBeenCalled();
  });

  it("DELETE on the last super admin is refused the same way, and changes nothing", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(founder as never);
    otherSuperAdmins(0);

    const res = await request(buildScimApp()).delete(`/api/scim/${ORG_SLUG}/v2/Users/founder`).set(scimAuthHeader());

    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/assign another super admin first/i);
    expect(client.user.update).not.toHaveBeenCalled();
  });

  it("a super admin held only as an extra role counts too", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue({ ...founder, role: { name: "EMPLOYEE" }, userRoles: [{ role: { name: "EMPLOYEE" } }, { role: { name: "SUPER_ADMIN" } }] } as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...founder, status: "INACTIVE" } as never);
    otherSuperAdmins(0);

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/founder`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: false }] });

    expect(res.status).toBe(409);
  });

  it("deprovisions a super admin when another active one remains — PATCH and DELETE alike", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(founder as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...founder, status: "INACTIVE" } as never);
    otherSuperAdmins(1);

    const patched = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/founder`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: false }] });
    const deleted = await request(buildScimApp()).delete(`/api/scim/${ORG_SLUG}/v2/Users/founder`).set(scimAuthHeader());

    expect(patched.status).toBe(200);
    expect(deleted.status).toBe(204);
    expect(client.user.update).toHaveBeenCalledTimes(2);
  });

  it("an ordinary account is deprovisioned without counting anybody — the IdP stays the source of truth", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue({ ...founder, id: "member", role: { name: "EMPLOYEE" }, userRoles: [{ role: { name: "EMPLOYEE" } }] } as never);
    vi.mocked(client.user.update).mockResolvedValue({ ...founder, id: "member", status: "INACTIVE" } as never);

    const res = await request(buildScimApp()).delete(`/api/scim/${ORG_SLUG}/v2/Users/member`).set(scimAuthHeader());

    expect(res.status).toBe(204);
    expect(client.role.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("reactivating the last super admin is never refused by this rule", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue({ ...founder, status: "INACTIVE" } as never);
    vi.mocked(client.user.update).mockResolvedValue(founder as never);
    otherSuperAdmins(0);

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/founder`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: true }] });

    expect(res.status).toBe(200);
    expect(client.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "ACTIVE" } }));
  });
});
