/**
 * Company-domain claims (signup Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.4).
 *
 * A claim decides which workspace a stranger from a company is pointed at, so the properties pinned
 * here are the ones whose failure sends somebody into the wrong company's workspace — or lets one
 * company open two:
 *  - an ARCHIVED workspace holds nothing, so its company can start again;
 *  - a sub-domain address finds its company's claim;
 *  - the unique index is the arbiter of a race, and the loser is told it lost;
 *  - backfill never picks between two workspaces that share a domain — it names the conflict;
 *  - personal-mail domains are never anybody's company.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Claim = { id: string; domain: string; organizationId: string; status: string; source: string; createdAt: Date };
type Org = { id: string; name: string; slug: string; status: string; ownerEmail: string | null };

const claims = new Map<string, Claim>();
const orgs = new Map<string, Org>();

const orgEmailDomain = {
  findUnique: vi.fn(async ({ where, include }: { where: { domain: string }; include?: unknown }) => {
    const claim = claims.get(where.domain);
    if (!claim) return null;
    return include ? { ...claim, organization: orgs.get(claim.organizationId) ?? null } : { ...claim };
  }),
  findMany: vi.fn(async ({ where, include }: { where?: { organizationId?: string }; include?: unknown } = {}) =>
    [...claims.values()]
      .filter((c) => !where?.organizationId || c.organizationId === where.organizationId)
      .map((c) => (include ? { ...c, organization: orgs.get(c.organizationId) ?? null } : c))
  ),
  create: vi.fn(async ({ data }: { data: Omit<Claim, "id" | "createdAt" | "status"> & { status?: string } }) => {
    if (claims.has(data.domain)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const row = { id: `c-${claims.size + 1}`, status: "UNVERIFIED", createdAt: new Date(), ...data };
    claims.set(data.domain, row);
    return row;
  }),
  upsert: vi.fn(async ({ where, create, update }: { where: { domain: string }; create: Claim; update: Partial<Claim> }) => {
    const existing = claims.get(where.domain);
    const row = existing ? { ...existing, ...update } : { id: `c-${claims.size + 1}`, status: "UNVERIFIED", createdAt: new Date(), ...create };
    claims.set(where.domain, row as Claim);
    return row;
  }),
  deleteMany: vi.fn(async ({ where }: { where: { domain?: string; organizationId?: string } }) => {
    let count = 0;
    for (const [domain, claim] of claims) {
      if ((where.domain && domain === where.domain) || (where.organizationId && claim.organizationId === where.organizationId)) {
        claims.delete(domain);
        count += 1;
      }
    }
    return { count };
  })
};
const organization = {
  findUnique: vi.fn(async ({ where }: { where: { id: string } }) => orgs.get(where.id) ?? null),
  findMany: vi.fn(async () => [...orgs.values()].filter((o) => o.status !== "ARCHIVED" && o.ownerEmail))
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { orgEmailDomain, organization } }));
const platformAudit = vi.fn(async () => undefined);
vi.mock("../../src/services/platform-audit.service.js", () => ({ platformAudit }));

const {
  DomainAlreadyClaimedError,
  applyBackfill,
  assignClaim,
  claimDomainInTransaction,
  claimsForOrg,
  findClaimForEmail,
  listClaims,
  planBackfill,
  reclaimAfterRestore,
  releaseClaim
} = await import("../../src/services/company-domain-claims.service.js");

const addOrg = (org: Partial<Org> & { id: string }) => orgs.set(org.id, { name: org.id, slug: org.id, status: "ACTIVE", ownerEmail: null, ...org });

beforeEach(() => {
  claims.clear();
  orgs.clear();
  vi.clearAllMocks();
});

describe("finding the workspace a company already has", () => {
  it("rolls a sub-domain address up before looking — eng.acme.com finds acme.com's workspace", async () => {
    addOrg({ id: "acme", name: "Acme" });
    claims.set("acme.com", { id: "c1", domain: "acme.com", organizationId: "acme", status: "UNVERIFIED", source: "SIGNUP", createdAt: new Date() });
    const found = await findClaimForEmail("dev@eng.acme.com");
    expect(found).toEqual({ domain: "acme.com", organization: expect.objectContaining({ id: "acme", name: "Acme", status: "ACTIVE" }) });
  });

  it("treats an ARCHIVED workspace's leftover claim as no claim, so the company can start again", async () => {
    addOrg({ id: "old", status: "ARCHIVED" });
    claims.set("acme.com", { id: "c1", domain: "acme.com", organizationId: "old", status: "UNVERIFIED", source: "SIGNUP", createdAt: new Date() });
    expect(await findClaimForEmail("a@acme.com")).toBeNull();
  });

  it("has nothing to find for an address with no company domain", async () => {
    expect(await findClaimForEmail("a@localhost")).toBeNull();
    expect(orgEmailDomain.findUnique).not.toHaveBeenCalled();
  });
});

describe("claiming, and the race", () => {
  it("turns a unique violation into DomainAlreadyClaimedError — the race loser learns it lost", async () => {
    claims.set("acme.com", { id: "c1", domain: "acme.com", organizationId: "first", status: "UNVERIFIED", source: "SIGNUP", createdAt: new Date() });
    await expect(claimDomainInTransaction({ orgEmailDomain } as never, "acme.com", "second", "SIGNUP")).rejects.toBeInstanceOf(
      DomainAlreadyClaimedError
    );
    expect(claims.get("acme.com")?.organizationId).toBe("first");
  });

  it("lets any other failure through untouched — only the unique key means 'somebody else won'", async () => {
    const tx = { orgEmailDomain: { create: vi.fn().mockRejectedValue(new Error("connection lost")) } };
    await expect(claimDomainInTransaction(tx as never, "acme.com", "o", "SIGNUP")).rejects.toThrow("connection lost");
  });

  it("lists a workspace's own claims", async () => {
    claims.set("acme.com", { id: "c1", domain: "acme.com", organizationId: "acme", status: "UNVERIFIED", source: "SIGNUP", createdAt: new Date() });
    claims.set("other.com", { id: "c2", domain: "other.com", organizationId: "else", status: "UNVERIFIED", source: "SIGNUP", createdAt: new Date() });
    expect((await claimsForOrg("acme")).map((c) => c.domain)).toEqual(["acme.com"]);
  });
});

describe("backfill — existing workspaces get their claims, conflicts are named, never decided", () => {
  beforeEach(() => {
    addOrg({ id: "A", ownerEmail: "a@acme.com" });
    addOrg({ id: "B", ownerEmail: "b@eng.acme.com" });
    addOrg({ id: "C", ownerEmail: "c@globex.com" });
    addOrg({ id: "D", ownerEmail: "d@gmail.com" });
    addOrg({ id: "E", ownerEmail: "e@initech.com" });
    claims.set("initech.com", { id: "c0", domain: "initech.com", organizationId: "E", status: "UNVERIFIED", source: "SIGNUP", createdAt: new Date() });
  });

  it("claims a domain only one workspace has, and names two sharing a domain as a CONFLICT", async () => {
    const plan = await planBackfill();
    expect(plan.toClaim).toEqual([expect.objectContaining({ domain: "globex.com", organizationId: "C" })]);
    expect(plan.conflicts).toEqual([{ domain: "acme.com", orgs: [expect.objectContaining({ id: "A" }), expect.objectContaining({ id: "B" })] }]);
  });

  it("skips personal-mail domains and domains already claimed", async () => {
    const plan = await planBackfill();
    const planned = [...plan.toClaim.map((c) => c.domain), ...plan.conflicts.map((c) => c.domain)];
    expect(planned).not.toContain("gmail.com");
    expect(planned).not.toContain("initech.com");
    expect(plan.skipped).toBe(2);
  });

  it("applies only the unambiguous claims, and audits what it did and what it left", async () => {
    const result = await applyBackfill("ops@timesphere.test");
    expect(result).toEqual({ claimed: 1, conflicts: 1 });
    expect(claims.get("globex.com")).toMatchObject({ organizationId: "C", source: "BACKFILL" });
    expect(claims.has("acme.com")).toBe(false);
    expect(platformAudit).toHaveBeenCalledWith(
      "PLATFORM_ADMIN",
      "ops@timesphere.test",
      "company_domain.backfilled",
      "OrgEmailDomain",
      null,
      expect.objectContaining({ claimed: ["globex.com"], conflicts: ["acme.com"] })
    );
  });
});

describe("operator actions", () => {
  it("assigns a domain to a workspace — and reassigns one already held, with the old owner in the audit", async () => {
    addOrg({ id: "A" });
    addOrg({ id: "B" });
    claims.set("acme.com", { id: "c1", domain: "acme.com", organizationId: "A", status: "UNVERIFIED", source: "SIGNUP", createdAt: new Date() });
    await assignClaim("ACME.com", "B", "ops@timesphere.test");
    expect(claims.get("acme.com")).toMatchObject({ organizationId: "B", source: "ADMIN" });
    expect(platformAudit).toHaveBeenCalledWith(
      "PLATFORM_ADMIN",
      "ops@timesphere.test",
      "company_domain.assigned",
      "OrgEmailDomain",
      "acme.com",
      expect.objectContaining({ organizationId: "B", previousOrganizationId: "A" }),
      undefined
    );
  });

  it.each(["gmail.com", "rediffmail.com", "mailinator.com"])("refuses to assign the personal domain %s to anybody", async (domain) => {
    addOrg({ id: "A" });
    await expect(assignClaim(domain, "A", "ops")).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses a sub-domain or a non-domain, and says which domain it would accept", async () => {
    addOrg({ id: "A" });
    await expect(assignClaim("eng.acme.com", "A", "ops")).rejects.toThrow(/acme\.com/);
    await expect(assignClaim("not a domain", "A", "ops")).rejects.toMatchObject({ statusCode: 422 });
  });

  it("lists every claim with the workspace it points at, by domain", async () => {
    addOrg({ id: "A", name: "Acme", slug: "acme" });
    addOrg({ id: "B", name: "Globex", slug: "globex", status: "SUSPENDED" });
    await assignClaim("globex.com", "B", "ops");
    await assignClaim("acme.com", "A", "ops");
    const rows = await listClaims();
    expect(rows.map((r) => r.domain)).toEqual(["acme.com", "globex.com"]);
    expect(rows[1]).toMatchObject({ domain: "globex.com", source: "ADMIN", organization: { id: "B", name: "Globex", slug: "globex", status: "SUSPENDED" } });
  });

  it("records the operator's reason and address with an assignment and a release", async () => {
    addOrg({ id: "A" });
    const provenance = { reason: "TS-4192 — customer moved to the parent company", ipAddress: "10.0.0.9" };
    await assignClaim("acme.com", "A", "ops", provenance);
    expect(platformAudit).toHaveBeenLastCalledWith("PLATFORM_ADMIN", "ops", "company_domain.assigned", "OrgEmailDomain", "acme.com", expect.anything(), provenance);
    await releaseClaim("acme.com", "ops", provenance);
    expect(platformAudit).toHaveBeenLastCalledWith("PLATFORM_ADMIN", "ops", "company_domain.released", "OrgEmailDomain", "acme.com", expect.anything(), provenance);
  });

  it("refuses to give a domain to an ARCHIVED workspace", async () => {
    addOrg({ id: "old", status: "ARCHIVED" });
    await expect(assignClaim("acme.com", "old", "ops")).rejects.toMatchObject({ statusCode: 422 });
  });

  it("releases a claim, audited", async () => {
    claims.set("acme.com", { id: "c1", domain: "acme.com", organizationId: "A", status: "UNVERIFIED", source: "SIGNUP", createdAt: new Date() });
    await releaseClaim("acme.com", "ops@timesphere.test");
    expect(claims.has("acme.com")).toBe(false);
    expect(platformAudit).toHaveBeenCalledWith("PLATFORM_ADMIN", "ops@timesphere.test", "company_domain.released", "OrgEmailDomain", "acme.com", {
      organizationId: "A"
    }, undefined);
  });
});

describe("after a snapshot restore", () => {
  it("re-claims the owner's domain when it is still free", async () => {
    expect(await reclaimAfterRestore({ id: "R", ownerEmail: "o@acme.com" })).toBe("claimed");
    expect(claims.get("acme.com")).toMatchObject({ organizationId: "R", source: "SIGNUP" });
  });

  it("never takes a domain another workspace now holds", async () => {
    claims.set("acme.com", { id: "c1", domain: "acme.com", organizationId: "NEW", status: "UNVERIFIED", source: "SIGNUP", createdAt: new Date() });
    expect(await reclaimAfterRestore({ id: "R", ownerEmail: "o@acme.com" })).toBe("taken");
    expect(claims.get("acme.com")?.organizationId).toBe("NEW");
  });

  it("does nothing for a personal or missing owner address", async () => {
    expect(await reclaimAfterRestore({ id: "R", ownerEmail: "o@gmail.com" })).toBe("none");
    expect(await reclaimAfterRestore({ id: "R", ownerEmail: null })).toBe("none");
  });
});
