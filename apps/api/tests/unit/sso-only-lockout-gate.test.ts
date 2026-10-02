/**
 * The "require SSO only" lockout gate, from the other side (audit M6, first point).
 *
 * Turning `requireSsoOnly` ON is already gated on a provider somebody has actually signed in through.
 * But the gate could be walked around afterwards: switch SSO-only on with Google proven, then switch
 * Google OFF (or clear its client secret) — and now password sign-in is refused for everybody and the
 * only SSO route in is gone. The workspace is locked out, its super admin included, and only a
 * platform operator can get it back.
 *
 * So while SSO-only is on, the LAST enabled provider with a recorded sign-in cannot be disabled or
 * stripped of a required credential: 409, telling the admin to turn SSO-only off first. Turning
 * SSO-only off stays ungated, which is what keeps this from ever being a trap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

type Row = Record<string, unknown> & { providerType: string };
const { rows, authMethod } = vi.hoisted(() => ({
  rows: [] as Row[],
  authMethod: { current: { requireSsoOnly: true, passwordLoginEnabled: true } as Record<string, unknown> | null }
}));

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
vi.mock("../../src/services/plan-limits.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/plan-limits.service.js")>("../../src/services/plan-limits.service.js");
  return { ...actual, getAllowedSsoProviders: async () => ["GOOGLE", "MICROSOFT", "SAML", "LDAP"] };
});
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    orgAuthMethod: { findUnique: async () => authMethod.current },
    orgSsoConfig: {
      findUnique: async ({ where }: { where: { organizationId_providerType: { providerType: string } } }) =>
        rows.find((r) => r.providerType === where.organizationId_providerType.providerType) ?? null,
      findMany: async () => rows,
      upsert: async ({ where, update }: { where: { organizationId_providerType: { providerType: string } }; update: Record<string, unknown> }) => {
        const row = rows.find((r) => r.providerType === where.organizationId_providerType.providerType)!;
        Object.assign(row, update);
        return row;
      }
    },
    orgEmailDomain: { findMany: async () => [] },
    orgSsoObservedTenant: { findMany: async () => [] }
  }
}));

const { settingsRouter } = await import("../../src/controllers/settings.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { encryptSecret } = await import("../../src/utils/encryption.js");

let client: PrismaClient;
function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  a.use("/api/settings", settingsRouter);
  a.use(errorHandler);
  return a;
}

const google = (over: Record<string, unknown> = {}): Row => ({
  id: "g",
  providerType: "GOOGLE",
  isEnabled: true,
  clientId: "client",
  encryptedClientSecret: encryptSecret("secret"),
  lastSuccessfulLoginAt: new Date("2026-09-01"),
  ...over
});

beforeEach(() => {
  client = createFakeTenantClient();
  rows.length = 0;
  authMethod.current = { requireSsoOnly: true, passwordLoginEnabled: true };
});

describe("while SSO-only is on, the last proven provider cannot be taken away", () => {
  it("refuses switching it off, with 409 and the way out", async () => {
    rows.push(google());
    const res = await request(app()).patch("/api/settings/sso/google").send({ isEnabled: false });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/turn off .*SSO only/i);
    expect(rows[0].isEnabled).toBe(true);
  });

  it("refuses clearing its client secret, which breaks it just as surely", async () => {
    rows.push(google());
    const res = await request(app()).patch("/api/settings/sso/google").send({ clientSecret: "" });
    expect(res.status).toBe(409);
  });

  it("allows it when ANOTHER enabled provider has a recorded sign-in", async () => {
    rows.push(google(), { id: "s", providerType: "SAML", isEnabled: true, idpEntityId: "e", idpSsoUrl: "https://i", idpCertificate: "c", lastSuccessfulLoginAt: new Date() });
    const res = await request(app()).patch("/api/settings/sso/google").send({ isEnabled: false });
    expect(res.status).toBe(200);
  });

  it("does not count an enabled provider nobody has ever signed in through", async () => {
    rows.push(google(), { id: "s", providerType: "SAML", isEnabled: true, idpEntityId: "e", idpSsoUrl: "https://i", idpCertificate: "c", lastSuccessfulLoginAt: null });
    const res = await request(app()).patch("/api/settings/sso/google").send({ isEnabled: false });
    expect(res.status).toBe(409);
  });

  it("allows it once SSO-only is off — the gate never traps anyone", async () => {
    authMethod.current = { requireSsoOnly: false, passwordLoginEnabled: true };
    rows.push(google());
    const res = await request(app()).patch("/api/settings/sso/google").send({ isEnabled: false });
    expect(res.status).toBe(200);
  });

  it("still allows ordinary edits to the proven provider", async () => {
    rows.push(google());
    const res = await request(app()).patch("/api/settings/sso/google").send({ clientId: "a-new-client-id" });
    expect(res.status).toBe(200);
  });
});
