/**
 * User Management's small decisions, each mirroring a rule the server enforces — the screen should
 * never offer what the API will refuse, and should say why when it holds something back.
 *  - an ADMIN is not offered SUPER_ADMIN in a role picker (only a super admin may grant it);
 *  - an ADMIN's row actions on a super admin's account are locked, with the reason;
 *  - nobody is offered "deactivate" or "delete" on their own row;
 *  - the manager picker offers only ACTIVE people (an inactive manager is refused);
 *  - `?tab=requests` drives the tab, so the bell's "asked to join" link works while already on Users.
 */
import { describe, expect, it } from "vitest";
import { assignableRoles, eligibleManagers, rowActionLocks, usersTabFrom } from "../../src/utils/user-admin";

describe("assignableRoles", () => {
  it("offers a super admin every role", () => {
    expect(assignableRoles("SUPER_ADMIN")).toContain("SUPER_ADMIN");
  });

  it("never offers an ADMIN (or anyone else) SUPER_ADMIN, and keeps every other grant", () => {
    expect(assignableRoles("ADMIN")).toEqual(["ADMIN", "MANAGER", "TEAM_LEAD", "EMPLOYEE"]);
    expect(assignableRoles(undefined)).not.toContain("SUPER_ADMIN");
  });
});

describe("rowActionLocks", () => {
  const admin = { id: "me", role: "ADMIN" };
  const superAdmin = { id: "me", role: "SUPER_ADMIN" };

  it("locks every access-changing action an ADMIN has on a super admin, and says why", () => {
    const locks = rowActionLocks(admin, { id: "sa", status: "ACTIVE", role: { name: "SUPER_ADMIN" }, heldRoles: ["SUPER_ADMIN"] });
    expect(locks).toEqual({
      reason: expect.stringMatching(/only a super admin/i),
      edit: true,
      toggleStatus: true,
      resetPassword: true,
      signOut: true,
      remove: true
    });
  });

  it("counts someone who HOLDS super admin while switched into another role", () => {
    const locks = rowActionLocks(admin, { id: "dormant", status: "ACTIVE", role: { name: "EMPLOYEE" }, heldRoles: ["SUPER_ADMIN", "EMPLOYEE"] });
    expect(locks.resetPassword).toBe(true);
  });

  it("leaves a super admin free to act on another super admin", () => {
    const locks = rowActionLocks(superAdmin, { id: "sa", status: "ACTIVE", role: { name: "SUPER_ADMIN" }, heldRoles: ["SUPER_ADMIN"] });
    expect(locks.reason).toBeNull();
    expect(locks.resetPassword).toBe(false);
  });

  it("on your own row, locks deactivate and delete only", () => {
    const locks = rowActionLocks(admin, { id: "me", status: "ACTIVE", role: { name: "ADMIN" }, heldRoles: ["ADMIN"] });
    expect(locks).toEqual({
      reason: expect.stringMatching(/your own account/i),
      edit: false,
      toggleStatus: true,
      resetPassword: false,
      signOut: false,
      remove: true
    });
  });

  it("locks nothing for an ADMIN acting on an employee", () => {
    const locks = rowActionLocks(admin, { id: "emp", status: "ACTIVE", role: { name: "EMPLOYEE" }, heldRoles: ["EMPLOYEE"] });
    expect(locks).toEqual({ reason: null, edit: false, toggleStatus: false, resetPassword: false, signOut: false, remove: false });
  });
});

describe("eligibleManagers", () => {
  it("offers active managers, leads and admins — not inactive ones, and not employees", () => {
    const people = [
      { id: "m", status: "ACTIVE", role: { name: "MANAGER" } },
      { id: "gone", status: "INACTIVE", role: { name: "MANAGER" } },
      { id: "pending", status: "PENDING_VERIFICATION", role: { name: "TEAM_LEAD" } },
      { id: "e", status: "ACTIVE", role: { name: "EMPLOYEE" } },
      { id: "sa", status: "ACTIVE", role: { name: "SUPER_ADMIN" } }
    ];
    expect(eligibleManagers(people).map((p) => p.id)).toEqual(["m", "sa"]);
  });
});

describe("usersTabFrom", () => {
  it("opens Requests when the link says so", () => {
    expect(usersTabFrom(new URLSearchParams("?tab=requests"))).toBe("requests");
    expect(usersTabFrom(new URLSearchParams("?search=ann&tab=requests"))).toBe("requests");
  });

  it("falls back to People for anything else", () => {
    expect(usersTabFrom(new URLSearchParams(""))).toBe("people");
    expect(usersTabFrom(new URLSearchParams("?tab=billing"))).toBe("people");
  });
});
