/**
 * The three fences around an agent identity, each tested separately because each fails in a
 * different direction and a shared test would let one of them quietly stop being true.
 *
 *   1. NO SEAT — a BILLING rule. Failure charges a customer for robots.
 *   2. NO LOGIN — a SECURITY rule. Failure is an account nobody owns that can hold a session.
 *   3. NO MAILBOX — an OPERATIONAL rule. Failure books permanent bounces against the sending
 *      domain, which is how a domain's reputation dies.
 *
 * Decision 2 in docs/AGENTIC_WORK_MANAGEMENT.md §7 is explicit that these are two invariants
 * needing two tests, "not a shared one". The third emerged from making the identity a real `User`
 * row: every "all active users" recipient query in the codebase picks it up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ *
 * 1. NO SEAT
 * ------------------------------------------------------------------ */
describe("an agent never consumes a seat", () => {
  it("excludes isAgent from the one seat-count definition", async () => {
    const count = vi.fn().mockResolvedValue(7);
    vi.doMock("../../src/config/prisma.js", () => ({ prisma: { user: { count } } }));
    const { countActiveSeats } = await import("../../src/services/seat-count.service.js");

    await expect(countActiveSeats()).resolves.toBe(7);
    // `isAgent: false` rather than a truthiness check, so the column default does the work on every
    // row that predates V8.
    expect(count).toHaveBeenCalledWith({ where: { status: "ACTIVE", deletedAt: null, isAgent: false } });
    vi.doUnmock("../../src/config/prisma.js");
  });

  it("is the only seat predicate left in the codebase", async () => {
    // The predicate used to be copied into five call sites. A sixth copy is how the next exclusion
    // gets missed, so this asserts the copies are gone rather than trusting a comment.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
      });

    const offenders = walk("src")
      .filter((file) => !file.endsWith("seat-count.service.ts"))
      .filter((file) => {
        const code = readFileSync(file, "utf8");
        // A bare active-user count with no further predicate is a seat count wearing a disguise.
        return /user\.count\(\{\s*where:\s*\{\s*status:\s*"ACTIVE",\s*deletedAt:\s*null\s*\}\s*\}\)/.test(code);
      });
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. NO LOGIN
 * ------------------------------------------------------------------ */
describe("an agent can never authenticate", () => {
  const findUnique = vi.fn();
  const sessionCreate = vi.fn().mockResolvedValue({ id: "s-1" });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  /** Drives the REAL `login` through to `establishSession`, which is the funnel every login method
   *  terminates in — password, Google, Microsoft, SAML and LDAP. Guarding there is what stops the
   *  next auth path from becoming a side door, so that is what this exercises. */
  async function loadAuth(userRow: Record<string, unknown>) {
    vi.doMock("../../src/config/prisma.js", () => ({
      prisma: {
        user: {
          findUnique: findUnique.mockResolvedValue(userRow),
          update: vi.fn().mockResolvedValue({})
        },
        session: { create: sessionCreate, updateMany: vi.fn().mockResolvedValue({ count: 0 }), findFirst: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        auditLog: { create: vi.fn().mockResolvedValue({}) }
      }
    }));
    vi.doMock("../../src/config/control-prisma.js", () => ({
      controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } }
    }));
    vi.doMock("../../src/config/tenant-context.js", () => ({
      requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }),
      tenantContext: { getStore: () => ({ orgId: "org-1" }) }
    }));
    vi.doMock("../../src/utils/security.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/utils/security.js")>("../../src/utils/security.js");
      // The password is not what is under test here, and a real bcrypt round per case is slow.
      return { ...actual, verifyPassword: vi.fn().mockResolvedValue(true) };
    });
    vi.doMock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));
    return import("../../src/services/auth.service.js");
  }

  const agentRow = {
    id: "agent-1",
    name: "Triage",
    email: "triage@agents.invalid",
    passwordHash: "x",
    status: "ACTIVE",
    deletedAt: null,
    isAgent: true,
    role: { name: "EMPLOYEE", permissions: [] },
    userRoles: [],
    firstLoginAt: null
  };

  it("refuses a password login for an agent identity, with 403 rather than 401", async () => {
    const auth = await loadAuth(agentRow);
    // 403, not 401: the credential is not the problem and retrying will never help.
    await expect(auth.login("triage@agents.invalid", "anything")).rejects.toMatchObject({
      statusCode: 403
    });
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  it("refuses at establishSession, so SSO cannot become the side door", async () => {
    // completeSsoLogin funnels into the same function with an already-verified identity — no
    // password is involved, which is precisely why the guard cannot live in `login()`.
    const auth = await loadAuth(agentRow);
    await expect(
      auth.completeSsoLogin("org-1", { email: "triage@agents.invalid", name: "Triage" })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  it("still lets an ordinary user in, so the guard is not simply refusing everybody", async () => {
    const auth = await loadAuth({ ...agentRow, id: "u-1", email: "real@x.io", isAgent: false });
    await expect(auth.login("real@x.io", "anything")).resolves.toBeTruthy();
    expect(sessionCreate).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * 3. NO MAILBOX
 * ------------------------------------------------------------------ */
describe("an agent has no mailbox", () => {
  it("uses a domain RFC 2606 reserves so it can never resolve", async () => {
    const { AGENT_MAIL_DOMAIN } = await import("../../src/services/agent-identity.js");
    expect(AGENT_MAIL_DOMAIN.endsWith(".invalid")).toBe(true);
  });

  it("skips a send addressed only to agent identities, without calling a transport", async () => {
    const emailLogCreate = vi.fn();
    vi.resetModules();
    vi.doMock("../../src/config/prisma.js", () => ({
      prisma: { emailLog: { create: emailLogCreate }, globalMailSettings: { findUnique: vi.fn().mockResolvedValue(null) } }
    }));
    vi.doMock("../../src/config/tenant-context.js", () => ({
      requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" })
    }));
    const { sendMail } = await import("../../src/services/mail.service.js");

    const result = await sendMail({
      to: "triage@agents.invalid",
      subject: "Weekly digest",
      html: "<p>hi</p>",
      template: "digest.weekly"
    } as never);

    expect(result.status).toBe("SKIPPED");
    // Nothing is written to EmailLog either: there is no delivery to account for, and a QUEUED row
    // would be retried forever by the send worker.
    expect(emailLogCreate).not.toHaveBeenCalled();
    vi.doUnmock("../../src/config/prisma.js");
  });

  it("still sends when a real person is among the recipients", async () => {
    const emailLogCreate = vi.fn().mockResolvedValue({ id: "log-1" });
    vi.resetModules();
    vi.doMock("../../src/config/prisma.js", () => ({
      prisma: {
        emailLog: { create: emailLogCreate, update: vi.fn().mockResolvedValue({}) },
        globalMailSettings: { findUnique: vi.fn().mockResolvedValue(null) },
        globalNotificationSettings: { findUnique: vi.fn().mockResolvedValue(null) },
        user: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) }
      }
    }));
    vi.doMock("../../src/config/tenant-context.js", () => ({
      requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" })
    }));
    const { sendMail } = await import("../../src/services/mail.service.js");

    // A mixed digest must not be dropped because one recipient happens to be an agent.
    await sendMail({
      to: "real@person.io,triage@agents.invalid",
      subject: "Weekly digest",
      html: "<p>hi</p>",
      template: "digest.weekly"
    } as never);

    expect(emailLogCreate).toHaveBeenCalled();
    vi.doUnmock("../../src/config/prisma.js");
  });
});
