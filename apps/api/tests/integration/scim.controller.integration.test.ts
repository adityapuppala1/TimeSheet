import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlPrisma } from "../../src/config/control-prisma.js";
import { encryptSecret } from "../../src/utils/encryption.js";
import { buildScimApp } from "../helpers/test-apps.js";

/**
 * Full end-to-end SCIM test against a real throwaway MySQL database (see
 * tests/setup/global-setup.integration.ts) — no mocking of org resolution, tenant Prisma client
 * construction, or seat-limit lookup at all, unlike the unit tier's mocked equivalents. This is
 * where the seat-limit-enforcement/duplicate-email/status-transition behavior that only means
 * something against real Prisma/MySQL semantics (unique constraints, real counts) actually gets
 * exercised for real, rather than asserting a mock was called with the expected args.
 */

const ORG_SLUG = "scim-integration-test-org";
const SCIM_TOKEN = "scim-integration-test-token";

let tenant: PrismaClient;

function scimAuthHeader() {
  return { Authorization: `Bearer ${SCIM_TOKEN}` };
}

beforeAll(async () => {
  tenant = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  await tenant.scimSettings.upsert({
    where: { id: "global" },
    update: { isEnabled: true, encryptedToken: encryptSecret(SCIM_TOKEN) },
    create: { id: "global", isEnabled: true, encryptedToken: encryptSecret(SCIM_TOKEN) }
  });
});

afterAll(async () => {
  await tenant.$disconnect();
});

describe("SCIM provisioning — real database", () => {
  it("creates a real User row via POST, findable via GET immediately after", async () => {
    const app = buildScimApp();
    const createRes = await request(app)
      .post(`/api/scim/${ORG_SLUG}/v2/Users`)
      .set(scimAuthHeader())
      .send({ userName: "scim.created@example.com", name: { givenName: "Scim", familyName: "Created" } });

    expect(createRes.status).toBe(201);
    expect(createRes.body.userName).toBe("scim.created@example.com");

    const dbUser = await tenant.user.findUnique({ where: { email: "scim.created@example.com" } });
    expect(dbUser).not.toBeNull();
    expect(dbUser?.status).toBe("ACTIVE");

    const listRes = await request(app)
      .get(`/api/scim/${ORG_SLUG}/v2/Users`)
      .query({ filter: 'userName eq "scim.created@example.com"' })
      .set(scimAuthHeader());
    expect(listRes.body.Resources).toHaveLength(1);
  });

  it("409s on a real duplicate-email constraint", async () => {
    const app = buildScimApp();
    const res = await request(app)
      .post(`/api/scim/${ORG_SLUG}/v2/Users`)
      .set(scimAuthHeader())
      .send({ userName: "scim.created@example.com" });
    expect(res.status).toBe(409);
  });

  it("enforces the real seat limit against real active-user counts", async () => {
    const app = buildScimApp();
    // Pin an exact ceiling at the current real active-seat count (via the org's own override,
    // same field a platform admin edits from /platform-admin), so the next create is guaranteed
    // to cross it — deterministic regardless of how many baseline users seedTenant created.
    const activeSeats = await tenant.user.count({ where: { status: "ACTIVE", deletedAt: null } });
    await controlPrisma.organization.update({ where: { id: "org-scim-test" }, data: { seatLimitOverride: activeSeats } });

    try {
      const res = await request(app)
        .post(`/api/scim/${ORG_SLUG}/v2/Users`)
        .set(scimAuthHeader())
        .send({ userName: "one-too-many@example.com" });
      expect(res.status).toBe(403);

      const overLimitUser = await tenant.user.findUnique({ where: { email: "one-too-many@example.com" } });
      expect(overLimitUser).toBeNull();
    } finally {
      // Lift the override again so the PATCH/DELETE tests below aren't blocked from creating fixtures.
      await controlPrisma.organization.update({ where: { id: "org-scim-test" }, data: { seatLimitOverride: null } });
    }
  });

  it("PATCH active:false really persists an INACTIVE status", async () => {
    const app = buildScimApp();
    const user = await tenant.user.findUniqueOrThrow({ where: { email: "scim.created@example.com" } });

    const res = await request(app)
      .patch(`/api/scim/${ORG_SLUG}/v2/Users/${user.id}`)
      .set(scimAuthHeader())
      .send({ Operations: [{ op: "replace", path: "active", value: false }] });

    expect(res.status).toBe(200);
    const reloaded = await tenant.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reloaded.status).toBe("INACTIVE");
  });

  it("DELETE really persists a soft-deactivate", async () => {
    const app = buildScimApp();
    const createRes = await request(app)
      .post(`/api/scim/${ORG_SLUG}/v2/Users`)
      .set(scimAuthHeader())
      .send({ userName: "scim.to-delete@example.com" });
    expect(createRes.status).toBe(201);

    const res = await request(app).delete(`/api/scim/${ORG_SLUG}/v2/Users/${createRes.body.id}`).set(scimAuthHeader());
    expect(res.status).toBe(204);

    const reloaded = await tenant.user.findUniqueOrThrow({ where: { id: createRes.body.id } });
    expect(reloaded.status).toBe("INACTIVE");
  });
});
