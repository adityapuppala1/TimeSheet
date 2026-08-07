/**
 * Tenant resolution runs BEFORE authentication on every request — it has to, since authenticating
 * needs the tenant's own database, which needs this lookup. So whatever it says about a slug, it
 * says to strangers.
 *
 * It used to say three different things: 404 for a slug nobody registered, 403 for a suspended
 * workspace, 503 for one still provisioning. A wordlist plus a forged `Host:` header (or the
 * `/:orgSlug` path param every webhook receiver takes) then read back not just which customers
 * exist but which are suspended — a company in billing trouble — and which are brand new.
 *
 * These tests pin the collapse: one answer for everyone who cannot prove they already belong to
 * the workspace, and the real reason preserved for those who can.
 */
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";

const { mockOrgFindUnique } = vi.hoisted(() => ({ mockOrgFindUnique: vi.fn() }));
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { organization: { findUnique: mockOrgFindUnique } }
}));

const { resolveActiveOrgBySlug } = await import("../../src/middleware/tenant.js");
const { signAccessToken } = await import("../../src/utils/security.js");
const { buildScimApp } = await import("../helpers/test-apps.js");

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";

const org = (status: string) => ({ id: ORG_ID, slug: "acme", status, database: { encryptedDsn: "cipher" } });

/** A request carrying a real, unexpired access token minted for `orgId`. */
const reqWithSessionFor = (orgId: string) =>
  ({ headers: { authorization: `Bearer ${signAccessToken("11111111-1111-4111-8111-111111111111", "session-1", orgId)}` } }) as unknown as Request;

/** The thrown AppError, as `{ statusCode, message }` — the two things a prober can observe. */
async function resolveOutcome(status: string | null, req?: Request) {
  mockOrgFindUnique.mockResolvedValue(status === null ? null : org(status));
  try {
    await resolveActiveOrgBySlug("acme", req);
    return { statusCode: 200, message: "resolved" };
  } catch (error) {
    const e = error as { statusCode: number; message: string };
    return { statusCode: e.statusCode, message: e.message };
  }
}

beforeEach(() => {
  mockOrgFindUnique.mockReset();
});

describe("an anonymous caller cannot tell the lifecycle states apart", () => {
  it("answers a suspended workspace exactly as it answers one that was never registered", async () => {
    expect(await resolveOutcome("SUSPENDED")).toEqual(await resolveOutcome(null));
  });

  it("answers a provisioning workspace the same way too", async () => {
    expect(await resolveOutcome("PROVISIONING")).toEqual(await resolveOutcome(null));
  });

  it("is a plain 404 in every one of those cases", async () => {
    for (const status of [null, "SUSPENDED", "PROVISIONING", "PENDING"]) {
      expect(await resolveOutcome(status)).toEqual({ statusCode: 404, message: "Unknown workspace." });
    }
  });

  it("is not fooled by a token minted for a DIFFERENT workspace", async () => {
    expect(await resolveOutcome("SUSPENDED", reqWithSessionFor(OTHER_ORG_ID))).toEqual({
      statusCode: 404,
      message: "Unknown workspace."
    });
  });

  it("is not fooled by a forged bearer token", async () => {
    const forged = { headers: { authorization: "Bearer not.a.real.token" } } as unknown as Request;
    expect(await resolveOutcome("SUSPENDED", forged)).toEqual({ statusCode: 404, message: "Unknown workspace." });
  });
});

describe("a caller who already belongs to the workspace still gets the real reason", () => {
  it("tells a suspended workspace's own user that it is suspended", async () => {
    const outcome = await resolveOutcome("SUSPENDED", reqWithSessionFor(ORG_ID));
    expect(outcome.statusCode).toBe(403);
    expect(outcome.message).toMatch(/suspended/i);
  });

  it("tells them when it is provisioning rather than gone", async () => {
    const outcome = await resolveOutcome("PROVISIONING", reqWithSessionFor(ORG_ID));
    expect(outcome.statusCode).toBe(503);
    expect(outcome.message).toMatch(/isn't ready/i);
  });

  it("still resolves an ACTIVE workspace for everyone, token or not", async () => {
    expect(await resolveOutcome("ACTIVE")).toEqual({ statusCode: 200, message: "resolved" });
    expect(await resolveOutcome("ACTIVE", reqWithSessionFor(ORG_ID))).toEqual({ statusCode: 200, message: "resolved" });
  });
});

describe("the webhook receivers inherit it — they are the cheapest oracle", () => {
  /** SCIM stands in for all five path-param receivers: they share resolveActiveOrgBySlug. */
  const probe = async (status: string | null) => {
    mockOrgFindUnique.mockResolvedValue(status === null ? null : org(status));
    const res = await request(buildScimApp()).get("/api/scim/acme/v2/Users").set("Authorization", "Bearer whatever");
    return { status: res.status, body: res.body };
  };

  it("gives a suspended org's slug the same answer as a slug that does not exist", async () => {
    expect(await probe("SUSPENDED")).toEqual(await probe(null));
  });

  it("gives a provisioning org's slug the same answer too", async () => {
    expect(await probe("PROVISIONING")).toEqual(await probe(null));
  });
});
