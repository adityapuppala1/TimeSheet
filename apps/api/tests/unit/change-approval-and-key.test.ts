/**
 * The three rules the requirement was most specific about, and one that would be silent if it broke.
 *
 * THE NUMBER: `HICS-TS-20260812-0001`. It goes into approval mail and audit exports, so a wrong
 * format is wrong in every record ever produced.
 *
 * WHO APPROVES: the requester's own manager, or a super admin. Anything looser is the flaw the whole
 * module exists to close.
 *
 * WHO MAY DECIDE: holding `changes:approve` is necessary and never sufficient — the row has to be
 * theirs, or they have to be a super admin.
 *
 * THE RISK SCORE: normalised against active weights, so adding a parameter cannot silently deflate
 * every score in the workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindFirst = vi.fn().mockResolvedValue(null);
const userFindMany = vi.fn().mockResolvedValue([]);
const projectFindFirst = vi.fn().mockResolvedValue({ code: "HICS-TS" });
const changeCount = vi.fn().mockResolvedValue(0);
const changeFindFirst = vi.fn().mockResolvedValue(null);

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: { findFirst: (...a: unknown[]) => userFindFirst(...a), findMany: (...a: unknown[]) => userFindMany(...a) },
    globalChangeSettings: { upsert: vi.fn().mockResolvedValue({ enableChangeManagement: true }) },
    blackoutPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    changeRequest: { findMany: vi.fn().mockResolvedValue([]) }
  }
}));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));

const { resolveChangeApprovers, canDecideChange, computeRiskScore, bandForScore } = await import(
  "../../src/services/change.service.js"
);
const { issueChangeKey, formatChangeKey, changeKeyDatePart } = await import("../../src/services/change-key.service.js");

/** A stand-in for the transaction client `issueChangeKey` is handed. */
const tx = {
  project: { findFirst: (...a: unknown[]) => projectFindFirst(...a) },
  changeRequest: { count: (...a: unknown[]) => changeCount(...a), findFirst: (...a: unknown[]) => changeFindFirst(...a) }
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  userFindFirst.mockResolvedValue(null);
  userFindMany.mockResolvedValue([]);
  projectFindFirst.mockResolvedValue({ code: "HICS-TS" });
  changeCount.mockResolvedValue(0);
  changeFindFirst.mockResolvedValue(null);
});

describe("the change number", () => {
  it("is PROJECTCODE-YYYYMMDD-NNNN, zero padded to four", () => {
    expect(formatChangeKey("HICS-TS", "20260812", 1)).toBe("HICS-TS-20260812-0001");
    expect(formatChangeKey("HICS-TS", "20260812", 42)).toBe("HICS-TS-20260812-0042");
    // Beyond four digits it grows rather than truncating — a wrong number is worse than a long one.
    expect(formatChangeKey("HICS-TS", "20260812", 12345)).toBe("HICS-TS-20260812-12345");
  });

  it("dates in UTC, so two offices raising at the same moment get the same day", () => {
    expect(changeKeyDatePart(new Date("2026-08-12T23:30:00.000Z"))).toBe("20260812");
    expect(changeKeyDatePart(new Date("2026-01-05T00:00:00.000Z"))).toBe("20260105");
  });

  it("starts each project's day at 0001", async () => {
    const key = await issueChangeKey(tx, "p-1", new Date("2026-08-12T10:00:00.000Z"));
    expect(key).toBe("HICS-TS-20260812-0001");
  });

  it("continues the day's sequence", async () => {
    changeCount.mockResolvedValue(7);
    expect(await issueChangeKey(tx, "p-1", new Date("2026-08-12T10:00:00.000Z"))).toBe("HICS-TS-20260812-0008");
  });

  it("counts on the KEY PREFIX, so a project's numbering is its own", async () => {
    await issueChangeKey(tx, "p-1", new Date("2026-08-12T10:00:00.000Z"));
    expect(changeCount.mock.calls[0][0].where.changeKey.startsWith).toBe("HICS-TS-20260812-");
  });

  it("steps past a number somebody else just took", async () => {
    changeCount.mockResolvedValue(0);
    changeFindFirst.mockResolvedValueOnce({ id: "taken" }).mockResolvedValueOnce(null);
    expect(await issueChangeKey(tx, "p-1", new Date("2026-08-12T10:00:00.000Z"))).toBe("HICS-TS-20260812-0002");
  });

  it("refuses rather than inventing one when the project has no code", async () => {
    projectFindFirst.mockResolvedValue({ code: null });
    await expect(issueChangeKey(tx, "p-1")).rejects.toThrow(/no code/i);
  });
});

describe("who is asked to approve", () => {
  it("is the requester's own manager", async () => {
    userFindFirst.mockResolvedValue({ manager: { id: "boss", status: "ACTIVE", deletedAt: null } });
    expect(await resolveChangeApprovers("me")).toEqual([{ approverId: "boss", reason: "MANAGER_OF_REQUESTER" }]);
    // No need to go looking for super admins when there is a manager.
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it("falls back to every super admin when the requester has no manager", async () => {
    userFindFirst.mockResolvedValue({ manager: null });
    userFindMany.mockResolvedValue([{ id: "sa1" }, { id: "sa2" }]);
    const approvers = await resolveChangeApprovers("me");
    expect(approvers).toEqual([
      { approverId: "sa1", reason: "SUPER_ADMIN" },
      { approverId: "sa2", reason: "SUPER_ADMIN" }
    ]);
    // Asked together so any one of them can clear it, rather than the request waiting on a tie-break.
    expect(userFindMany.mock.calls[0][0].where).toMatchObject({ status: "ACTIVE", isAgent: false });
  });

  it("falls back when the manager is deactivated or deleted", async () => {
    userFindMany.mockResolvedValue([{ id: "sa1" }]);
    for (const manager of [
      { id: "boss", status: "INACTIVE", deletedAt: null },
      { id: "boss", status: "ACTIVE", deletedAt: new Date() }
    ]) {
      userFindFirst.mockResolvedValue({ manager });
      const approvers = await resolveChangeApprovers("me");
      expect(approvers[0].reason).toBe("SUPER_ADMIN");
    }
  });

  it("never asks somebody to approve their own change", async () => {
    // The one thing an approval gate exists to prevent. Guarded here rather than left to the hope
    // that nobody is recorded as their own manager.
    userFindFirst.mockResolvedValue({ manager: { id: "me", status: "ACTIVE", deletedAt: null } });
    userFindMany.mockResolvedValue([{ id: "sa1" }]);
    const approvers = await resolveChangeApprovers("me");
    expect(approvers.map((a) => a.approverId)).not.toContain("me");
    expect(userFindMany.mock.calls[0][0].where.id).toEqual({ not: "me" });
  });
});

describe("who may decide", () => {
  const pending = [{ approverId: "boss", status: "PENDING" }];
  const asUser = (id: string, role: string, perms: string[] = ["changes:approve"]) => ({
    user: { id, role, permissions: perms }
  });

  it("lets the named approver decide", () => {
    expect(canDecideChange(asUser("boss", "MANAGER"), pending)).toBe(true);
  });

  it("lets a super admin decide anything — the requirement, and the escape hatch when an approver leaves", () => {
    expect(canDecideChange(asUser("root", "SUPER_ADMIN", []), pending)).toBe(true);
  });

  it("REFUSES a manager who is not the named approver", () => {
    // Holding changes:approve is necessary and never sufficient. Without this, any team lead could
    // sign off any change.
    expect(canDecideChange(asUser("other-boss", "MANAGER"), pending)).toBe(false);
  });

  it("refuses somebody without the permission, even if named", () => {
    expect(canDecideChange(asUser("boss", "EMPLOYEE", []), pending)).toBe(false);
  });

  it("refuses once the row is already decided", () => {
    expect(canDecideChange(asUser("boss", "MANAGER"), [{ approverId: "boss", status: "APPROVED" }])).toBe(false);
  });
});

describe("the risk score", () => {
  const params = [
    { key: "a", weight: 10 },
    { key: "b", weight: 10 }
  ];

  it("is 100 when everything is at its worst", () => {
    expect(computeRiskScore({ a: "HIGH", b: "HIGH" }, params).riskScore).toBe(100);
  });

  it("is NORMALISED, so adding a parameter cannot deflate an unchanged answer", () => {
    // The failure this guards: an admin adds a twelfth parameter and every score in the workspace
    // silently drops, with no edit to any change to explain it.
    const two = computeRiskScore({ a: "HIGH", b: "HIGH" }, params).riskScore;
    const three = computeRiskScore({ a: "HIGH", b: "HIGH", c: "HIGH" }, [...params, { key: "c", weight: 10 }]).riskScore;
    expect(three).toBe(two);
  });

  it("scores an unanswered parameter as nothing, not as low", () => {
    // Otherwise somebody could lower a change's risk by leaving fields blank.
    expect(computeRiskScore({ a: "HIGH" }, params).riskScore).toBe(50);
    expect(computeRiskScore({ a: "HIGH", b: "LOW" }, params).riskScore).toBe(60);
  });

  it("weights parameters against each other", () => {
    const weighted = [
      { key: "big", weight: 30 },
      { key: "small", weight: 10 }
    ];
    expect(computeRiskScore({ big: "HIGH" }, weighted).riskScore).toBe(75);
    expect(computeRiskScore({ small: "HIGH" }, weighted).riskScore).toBe(25);
  });

  it("cannot divide by zero when every parameter is switched off", () => {
    expect(computeRiskScore({ a: "HIGH" }, [])).toEqual({ riskScore: 0, riskLevel: "LOW" });
  });

  it("bands low enough that an ordinary change still owes a backout plan", () => {
    // MEDIUM starting at 30 is deliberate: the band decides whether a backout plan is mandatory.
    expect(bandForScore(29)).toBe("LOW");
    expect(bandForScore(30)).toBe("MEDIUM");
    expect(bandForScore(64)).toBe("MEDIUM");
    expect(bandForScore(65)).toBe("HIGH");
  });
});
