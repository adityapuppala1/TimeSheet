/**
 * GET/PATCH /settings/sso — what the Single sign-on tab is given to show, and what it may save.
 *
 * M4: the values an admin must register with their IdP were missing or wrong. The Google and
 * Microsoft redirect URIs were never shown, the SAML ACS appeared as a RELATIVE path, and the default
 * SP entity ID was not shown at all. The settings response now carries every one of them, absolute, as
 * the flows actually send them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

type Row = Record<string, unknown> & { providerType: string };
const { rows } = vi.hoisted(() => ({ rows: [] as Row[] }));

const actor = { id: "sa-1", name: "Root", email: "sa@x.io", role: "SUPER_ADMIN", permissions: [] as string[] };
vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] };
      next();
    }
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    orgAuthMethod: { findUnique: async () => null },
    orgSsoConfig: { findMany: async () => rows }
  }
}));

const { settingsRouter } = await import("../../src/controllers/settings.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

let client: PrismaClient;
function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  a.use("/api/settings", settingsRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  client = createFakeTenantClient();
  rows.length = 0;
});

describe("the values an admin registers with their IdP (M4)", () => {
  it("are all present and absolute — vitest's APP_BASE_URL is http://localhost:5173", async () => {
    const res = await request(app()).get("/api/settings/sso");
    expect(res.status).toBe(200);
    expect(res.body.registration).toEqual({
      googleRedirectUri: "http://localhost:5173/api/auth/sso/google/callback",
      microsoftRedirectUri: "http://localhost:5173/api/auth/sso/microsoft/callback",
      samlAcsUrl: "http://localhost:5173/api/auth/sso/saml/acs",
      samlSpEntityId: "http://localhost:5173/api/auth/sso/saml/metadata",
      samlMetadataUrl: "http://localhost:5173/api/auth/sso/saml/metadata"
    });
  });

  it("shows a workspace's OWN SP entity ID when it set one — the value its IdP already has", async () => {
    rows.push({ providerType: "SAML", isEnabled: true, spEntityId: "urn:acme:timesphere" });
    const res = await request(app()).get("/api/settings/sso");
    expect(res.body.registration.samlSpEntityId).toBe("urn:acme:timesphere");
  });
});
