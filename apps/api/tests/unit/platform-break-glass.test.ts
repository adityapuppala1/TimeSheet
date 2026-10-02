/**
 * H5 (b) — a fresh install has exactly one OWNER, and every two-person action, including creating a
 * second owner, needs a DIFFERENT owner to approve it. So the console could never approve anything,
 * and the queue itself said "create a second owner first". The only way out was SQL.
 *
 * `npm run control:create-owner` is the documented way out, and it is deliberately narrow:
 *  - it runs only while the deployment has FEWER THAN TWO active owners — the one state in which the
 *    console's two-person rule cannot be satisfied. With two, the console is the way, and this
 *    refuses rather than becoming a second door around the rule;
 *  - it needs a reason, and writes an audit row naming the host user who ran it;
 *  - the password is generated, printed once, and the account starts behind the rotation gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

let owners = 1;
let existing: Record<string, unknown> | null = null;
const created: Record<string, unknown>[] = [];
const audits: Record<string, unknown>[] = [];
const control = {
  platformAdminUser: {
    count: vi.fn(async () => owners),
    findUnique: vi.fn(async () => existing),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: "new-owner", ...data };
      created.push(row);
      return row;
    })
  },
  platformAuditLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      audits.push(data);
      return data;
    })
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const { createBreakGlassOwner } = await import("../../src/services/platform-break-glass.service.js");

const input = { email: "Second.Owner@Acme.test", name: "Second Owner", reason: "Single-owner install; need a countersigner for the queue", actor: "root@api-host" };

beforeEach(() => {
  vi.clearAllMocks();
  owners = 1;
  existing = null;
  created.length = 0;
  audits.length = 0;
});

describe("createBreakGlassOwner", () => {
  it("creates an OWNER behind the rotation gate with a generated password, and returns it once", async () => {
    const result = await createBreakGlassOwner(input);
    expect(result.email).toBe("second.owner@acme.test");
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(12);
    expect(created[0]).toMatchObject({ email: "second.owner@acme.test", role: "OWNER", status: "ACTIVE", mustChangePassword: true });
    // Stored hashed, never as the value that was printed.
    expect(created[0].passwordHash).not.toBe(result.temporaryPassword);
  });

  it("writes an audit row with the reason and the host user who ran it", async () => {
    await createBreakGlassOwner(input);
    expect(audits[0]).toMatchObject({ actorType: "SYSTEM", action: "platform_admin.created_break_glass", reason: input.reason });
    expect(String(audits[0].actorLabel)).toContain("root@api-host");
  });

  it("refuses once the deployment has two owners — then the console's two-person rule can be met", async () => {
    owners = 2;
    await expect(createBreakGlassOwner(input)).rejects.toThrow(/already has 2 active owners/i);
    expect(created).toHaveLength(0);
  });

  it("refuses without a real reason, and an address that is already an account", async () => {
    await expect(createBreakGlassOwner({ ...input, reason: "because" })).rejects.toThrow(/reason/i);
    existing = { id: "taken" };
    await expect(createBreakGlassOwner(input)).rejects.toThrow(/already/i);
    expect(created).toHaveLength(0);
  });
});
