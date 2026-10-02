/**
 * Microsoft sign-in with no tenant ID accepts ANY directory (audit C1) — the staged fix, which must not
 * lock anybody out:
 *
 *  (a) a NEW Microsoft configuration cannot be saved without a real tenant ID, and a pinned tenant cannot
 *      be un-pinned; an EXISTING blank one can still be edited, and is told why it should not stay so;
 *  (b) every successful Microsoft sign-in records the directory (`tid`) and email domain it came from;
 *  (c) the settings card is given those directories, and a "Restrict to my directory" suggestion — the
 *      directory of the admin's OWN latest Microsoft sign-in, else the most frequent one.
 *
 * Existing sign-ins are untouched by all three: nothing here refuses a token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

type Row = Record<string, unknown> & { providerType: string };
interface Observed {
  id: string;
  organizationId: string;
  tenantId: string;
  emailDomain: string;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}
const { rows, upserts, observed } = vi.hoisted(() => ({
  rows: [] as Row[],
  upserts: [] as Array<{ update: Record<string, unknown>; create: Record<string, unknown> }>,
  observed: [] as Observed[]
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
vi.mock("../../src/config/control-prisma.js", () => {
  let nextId = 0;
  const key = (w: { organizationId: string; tenantId: string; emailDomain: string }) => `${w.organizationId}|${w.tenantId}|${w.emailDomain}`;
  return {
    controlPrisma: {
      orgAuthMethod: { findUnique: async () => null },
      orgEmailDomain: { findMany: async () => [] },
      orgSsoConfig: {
        findMany: async () => rows,
        findUnique: async ({ where }: { where: { organizationId_providerType: { providerType: string } } }) =>
          rows.find((r) => r.providerType === where.organizationId_providerType.providerType) ?? null,
        upsert: async (args: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
          upserts.push(args);
          return { providerType: "MICROSOFT", isEnabled: false, ...args.update };
        }
      },
      orgSsoObservedTenant: {
        findMany: async ({ where }: { where: { organizationId: string } }) => observed.filter((o) => o.organizationId === where.organizationId),
        upsert: async (args: {
          where: { organizationId_tenantId_emailDomain: { organizationId: string; tenantId: string; emailDomain: string } };
          create: Omit<Observed, "id" | "count" | "firstSeenAt" | "lastSeenAt">;
        }) => {
          const k = key(args.where.organizationId_tenantId_emailDomain);
          const hit = observed.find((o) => key(o) === k);
          if (hit) {
            hit.count += 1;
            hit.lastSeenAt = new Date();
            return hit;
          }
          const row = { id: `o-${++nextId}`, count: 1, firstSeenAt: new Date(), lastSeenAt: new Date(), ...args.create };
          observed.push(row);
          return row;
        }
      }
    }
  };
});

const { settingsRouter } = await import("../../src/controllers/settings.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { recordMicrosoftDirectory, observedMicrosoftDirectories } = await import("../../src/services/sso-microsoft-directory.service.js");

const HOME = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";

let client: PrismaClient;
let ownSignIns: Array<{ metadata: unknown }>;
function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  a.use("/api/settings", settingsRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  rows.length = 0;
  upserts.length = 0;
  observed.length = 0;
  ownSignIns = [];
  client = createFakeTenantClient();
  (client as unknown as { auditLog: unknown }).auditLog = {
    findMany: vi.fn().mockImplementation(() => Promise.resolve(ownSignIns))
  };
});

describe("(b) every Microsoft sign-in records its directory", () => {
  it("counts sign-ins per directory and email domain", async () => {
    await recordMicrosoftDirectory("org-1", HOME, "sam@acme.example");
    await recordMicrosoftDirectory("org-1", HOME, "kim@acme.example");
    await recordMicrosoftDirectory("org-1", OTHER, "eve@elsewhere.example");

    const directories = await observedMicrosoftDirectories("org-1");
    expect(directories[0]).toMatchObject({ tenantId: HOME, count: 2, emailDomains: [{ domain: "acme.example", count: 2 }] });
    expect(directories[1]).toMatchObject({ tenantId: OTHER, count: 1, emailDomains: [{ domain: "elsewhere.example", count: 1 }] });
  });

  it("stores the domain, never the address", async () => {
    await recordMicrosoftDirectory("org-1", HOME, "sam@acme.example");
    expect(JSON.stringify(observed)).not.toContain("sam@");
  });
});

describe("(a) saving a Microsoft configuration", () => {
  it.each(["", "common", "organizations", "consumers", "  Common "])("refuses a NEW configuration whose tenant is %j", async (tenantHint) => {
    const res = await request(app()).patch("/api/settings/sso/microsoft").send({ clientId: "client", clientSecret: "s", tenantHint });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Directory \(tenant\) ID/);
    expect(upserts).toHaveLength(0);
  });

  it("accepts a new configuration pinned to a directory", async () => {
    const res = await request(app()).patch("/api/settings/sso/microsoft").send({ clientId: "client", clientSecret: "s", tenantHint: HOME });
    expect(res.status).toBe(200);
  });

  it("refuses un-pinning a pinned configuration", async () => {
    rows.push({ providerType: "MICROSOFT", clientId: "client", tenantHint: HOME });
    const res = await request(app()).patch("/api/settings/sso/microsoft").send({ tenantHint: null });
    expect(res.status).toBe(422);
  });

  it("still lets an EXISTING blank configuration be edited — and says why it should not stay blank", async () => {
    rows.push({ providerType: "MICROSOFT", clientId: "client", tenantHint: null, isEnabled: true });
    const res = await request(app()).patch("/api/settings/sso/microsoft").send({ clientSecret: "rotated", tenantHint: null });
    expect(res.status).toBe(200);
    expect(res.body.warnings?.[0]).toMatch(/any Microsoft/i);
  });

  it("leaves Google alone — it has no tenant", async () => {
    const res = await request(app()).patch("/api/settings/sso/google").send({ clientId: "client", clientSecret: "s" });
    expect(res.status).toBe(200);
  });
});

describe("(c) the directories the card is given", () => {
  beforeEach(async () => {
    rows.push({ providerType: "MICROSOFT", clientId: "client", tenantHint: null, isEnabled: true });
    for (let i = 0; i < 3; i++) await recordMicrosoftDirectory("org-1", OTHER, `p${i}@elsewhere.example`);
    await recordMicrosoftDirectory("org-1", HOME, "sa@x.io");
  });

  it("suggests the directory of the admin's OWN latest Microsoft sign-in", async () => {
    ownSignIns = [{ metadata: { provider: "GOOGLE" } }, { metadata: { provider: "MICROSOFT", directory: HOME } }];
    const res = await request(app()).get("/api/settings/sso");
    expect(res.body.microsoftDirectories).toMatchObject({ suggestedTenantId: HOME, suggestedFrom: "your-sign-in" });
    expect(res.body.microsoftDirectories.observed.map((d: { tenantId: string }) => d.tenantId)).toEqual([OTHER, HOME]);
  });

  it("falls back to the most frequent directory when the admin has never signed in with Microsoft", async () => {
    const res = await request(app()).get("/api/settings/sso");
    expect(res.body.microsoftDirectories).toMatchObject({ suggestedTenantId: OTHER, suggestedFrom: "most-frequent" });
  });
});
