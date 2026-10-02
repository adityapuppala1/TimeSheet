/**
 * Just-in-time account creation on SSO sign-in (audit H5), through the REAL completeSsoLogin.
 *
 * It was unrestricted and silent: any identity a provider authenticated with no matching account got
 * an EMPLOYEE account — no switch, no domain limit, no audit row, nobody told. It is now:
 *
 *  - a per-provider switch (`jitEnabled`, DEFAULT ON so every existing workspace is unchanged);
 *  - an optional allowed-domain list (`jitAllowedDomains`, NULL = any, again what exists today);
 *  - for Google, a non-gmail.com domain also needs the token's `hd` claim in that list — Google is
 *    authoritative for an address only at gmail.com or when it vouches with `hd`;
 *  - audited (`user.sso_provisioned`), announced to the super admins in-app, given its UserRole row,
 *    its workspace-directory row and a Stripe seat sync like every other way an account is created.
 *
 * What does NOT change, and is pinned last: an EXISTING account is matched exactly as before, whatever
 * the switch says — moving identity matching off email is the identity-binding proposal, not this.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const { ssoRow, mocks } = vi.hoisted(() => ({
  ssoRow: { current: null as Record<string, unknown> | null },
  mocks: {
    syncSubscriptionSeats: vi.fn(),
    rememberWorkspaceMembership: vi.fn(),
    dispatchInAppToMany: vi.fn()
  }
}));

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    orgSsoConfig: { findUnique: async () => ssoRow.current },
    orgAuthMethod: { findUnique: async () => null }
  }
}));
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: async () => false }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit: async () => 100 }));
vi.mock("../../src/services/seat-count.service.js", () => ({ countActiveSeats: async () => 3 }));
vi.mock("../../src/services/billing-sync.service.js", () => ({ syncSubscriptionSeats: mocks.syncSubscriptionSeats }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchInAppToMany: mocks.dispatchInAppToMany }));
vi.mock("../../src/services/workspace-directory.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/workspace-directory.service.js")>("../../src/services/workspace-directory.service.js");
  return { ...actual, rememberWorkspaceMembership: mocks.rememberWorkspaceMembership };
});

const { completeSsoLogin } = await import("../../src/services/auth.service.js");

const NEW_USER_ID = "77777777-7777-4777-8777-777777777777";
const EXISTING_ID = "55555555-5555-4555-8555-555555555555";

let client: PrismaClient;
let existing: Record<string, unknown> | null;
let auditRows: Array<{ action: string; actorId?: string; metadata?: Record<string, unknown> }>;

function profileRow(id: string, email: string) {
  return { id, name: "Sam", email, status: "ACTIVE", deletedAt: null, role: { name: "EMPLOYEE", permissions: [] }, userRoles: [{ role: { name: "EMPLOYEE" } }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  ssoRow.current = null;
  existing = null;
  auditRows = [];
  client = {
    user: {
      findUnique: vi.fn().mockImplementation((args: { where: { email?: string; id?: string } }) =>
        Promise.resolve(args.where.email ? existing : { firstLoginAt: null, isAgent: false, email: "x", role: { name: "EMPLOYEE" } })
      ),
      findMany: vi.fn().mockResolvedValue([{ id: "sa-1" }, { id: "sa-2" }]),
      create: vi.fn().mockImplementation((args: { data: { email: string } }) => Promise.resolve(profileRow(NEW_USER_ID, args.data.email))),
      update: vi.fn().mockResolvedValue({})
    },
    role: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "role-employee" }) },
    session: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "s-1" }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0)
    },
    auditLog: {
      create: vi.fn().mockImplementation((args: { data: { action: string; actorId?: string; metadata?: Record<string, unknown> } }) => {
        auditRows.push(args.data);
        return Promise.resolve({});
      })
    }
  } as unknown as PrismaClient;
});

type Identity = Parameters<typeof completeSsoLogin>[1];
const signIn = (identity: Partial<Identity> & { email: string }) =>
  runInTenant(client, () => completeSsoLogin("org-1", { name: "Sam", ...identity }, "UA", "203.0.113.9"), "org-1");

describe("just-in-time creation, unchanged by default", () => {
  it("still creates the account when nothing has been configured — every existing workspace", async () => {
    await expect(signIn({ email: "sam@acme.example", provider: "SAML" })).resolves.toMatchObject({ user: { id: NEW_USER_ID } });
  });

  it("gives the new account its UserRole row, so it holds the role it was given", async () => {
    await signIn({ email: "sam@acme.example", provider: "SAML" });
    const data = vi.mocked(client.user.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(data.userRoles).toEqual({ create: { roleId: "role-employee" } });
    expect(data.notificationPreference).toEqual({ create: {} });
  });

  it("writes the workspace-directory row and syncs the billed seats, like every other create path", async () => {
    await signIn({ email: "sam@acme.example", provider: "SAML" });
    expect(mocks.rememberWorkspaceMembership).toHaveBeenCalledWith("org-1", "sam@acme.example");
    expect(mocks.syncSubscriptionSeats).toHaveBeenCalledWith("org-1");
  });

  it("audits the creation with the provider and the email DOMAIN — never the address", async () => {
    await signIn({ email: "sam@acme.example", provider: "GOOGLE", hostedDomain: "acme.example" });
    const row = auditRows.find((r) => r.action === "user.sso_provisioned");
    expect(row?.metadata).toEqual({ provider: "GOOGLE", emailDomain: "acme.example" });
  });

  it("tells the super admins in-app, through the notification dispatch", async () => {
    await signIn({ email: "sam@acme.example", provider: "MICROSOFT" });
    expect(mocks.dispatchInAppToMany).toHaveBeenCalledWith(expect.objectContaining({ userIds: ["sa-1", "sa-2"], category: "sso.user_provisioned" }));
  });
});

describe("when the workspace has said no", () => {
  it("refuses with not_provisioned when automatic creation is switched off", async () => {
    ssoRow.current = { jitEnabled: false, jitAllowedDomains: null };
    await expect(signIn({ email: "sam@acme.example", provider: "SAML" })).rejects.toMatchObject({ code: "SSO_NOT_PROVISIONED" });
    expect(client.user.create).not.toHaveBeenCalled();
  });

  it("refuses an address outside the allowed domains", async () => {
    ssoRow.current = { jitEnabled: true, jitAllowedDomains: ["acme.example"] };
    await expect(signIn({ email: "stranger@elsewhere.example", provider: "MICROSOFT" })).rejects.toMatchObject({ code: "SSO_NOT_PROVISIONED" });
    expect(client.user.create).not.toHaveBeenCalled();
  });

  it("creates an account for an allowed domain, whatever its letter case", async () => {
    ssoRow.current = { jitEnabled: true, jitAllowedDomains: ["acme.example"] };
    await expect(signIn({ email: "Sam@ACME.example", provider: "MICROSOFT" })).resolves.toBeTruthy();
  });
});

describe("Google: the address counts only at gmail.com or with a matching hd", () => {
  beforeEach(() => {
    ssoRow.current = { jitEnabled: true, jitAllowedDomains: ["acme.example", "gmail.com"] };
  });

  it("refuses an allowed-looking domain that Google did not vouch for with hd", async () => {
    await expect(signIn({ email: "sam@acme.example", provider: "GOOGLE", hostedDomain: null })).rejects.toMatchObject({ code: "SSO_NOT_PROVISIONED" });
  });

  it("refuses an hd outside the list even when the address is inside it", async () => {
    await expect(signIn({ email: "sam@acme.example", provider: "GOOGLE", hostedDomain: "evil.example" })).rejects.toMatchObject({
      code: "SSO_NOT_PROVISIONED"
    });
  });

  it("accepts the address when hd is in the list", async () => {
    await expect(signIn({ email: "sam@acme.example", provider: "GOOGLE", hostedDomain: "acme.example" })).resolves.toBeTruthy();
  });

  it("accepts a gmail.com address without hd, when gmail.com is allowed", async () => {
    await expect(signIn({ email: "someone@gmail.com", provider: "GOOGLE", hostedDomain: null })).resolves.toBeTruthy();
  });
});

describe("existing accounts are matched exactly as before", () => {
  beforeEach(() => {
    existing = profileRow(EXISTING_ID, "sam@acme.example");
  });

  it("signs an existing user in even with automatic creation off and a domain list that excludes them", async () => {
    ssoRow.current = { jitEnabled: false, jitAllowedDomains: ["other.example"] };
    await expect(signIn({ email: "sam@acme.example", provider: "GOOGLE" })).resolves.toMatchObject({ user: { id: EXISTING_ID } });
    expect(client.user.create).not.toHaveBeenCalled();
  });

  it("writes one sign-in audit row naming the provider, and no address", async () => {
    await signIn({ email: "sam@acme.example", provider: "SAML" });
    const row = auditRows.find((r) => r.action === "auth.sso_login");
    expect(row).toMatchObject({ actorId: EXISTING_ID, metadata: { provider: "SAML" } });
    expect(JSON.stringify(row)).not.toContain("sam@acme.example");
  });

  it("does not let a failing audit write cost the person their session", async () => {
    vi.mocked(client.auditLog.create).mockRejectedValue(new Error("audit table locked"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(signIn({ email: "sam@acme.example", provider: "SAML" })).resolves.toMatchObject({ user: { id: EXISTING_ID } });
  });
});
