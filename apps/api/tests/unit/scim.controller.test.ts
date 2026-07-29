import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../src/utils/encryption.js";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { buildScimApp } from "../helpers/test-apps.js";

// scim.controller.ts's `withOrgTenant` resolves the org (control-plane lookup) and then
// constructs a REAL PrismaClient for whatever DSN it gets back — both need mocking for a
// "unit" test that never touches a real database. `prisma` (the tenant-context Proxy) is kept
// real via importOriginal, since only `getTenantClient`'s DSN-based construction is the problem.
const { mockResolveActiveOrgBySlug, mockGetTenantClient, mockGetEffectiveSeatLimit } = vi.hoisted(() => ({
  mockResolveActiveOrgBySlug: vi.fn(),
  mockGetTenantClient: vi.fn(),
  mockGetEffectiveSeatLimit: vi.fn()
}));

vi.mock("../../src/middleware/tenant.js", () => ({ resolveActiveOrgBySlug: mockResolveActiveOrgBySlug }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit: mockGetEffectiveSeatLimit }));
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
});

describe("PATCH /:orgSlug/v2/Users/:id — deprovision/reactivate", () => {
  const existingUser = { id: "user-1", name: "Existing Person", email: "existing@example.com", status: "ACTIVE", scimExternalId: null };

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

    const res = await request(buildScimApp())
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/user-1`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: true }] });

    expect(res.status).toBe(200);
    expect(client.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "ACTIVE" } }));
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
    vi.mocked(client.user.findFirst).mockResolvedValue({ id: "user-1" } as never);
    vi.mocked(client.user.update).mockResolvedValue({} as never);

    const res = await request(buildScimApp()).delete(`/api/scim/${ORG_SLUG}/v2/Users/user-1`).set(scimAuthHeader());

    expect(res.status).toBe(204);
    expect(client.user.update).toHaveBeenCalledWith({ where: { id: "user-1" }, data: { status: "INACTIVE" } });
  });

  it("404s when the target user doesn't exist", async () => {
    vi.mocked(client.user.findFirst).mockResolvedValue(null);
    const res = await request(buildScimApp()).delete(`/api/scim/${ORG_SLUG}/v2/Users/missing`).set(scimAuthHeader());
    expect(res.status).toBe(404);
  });
});
