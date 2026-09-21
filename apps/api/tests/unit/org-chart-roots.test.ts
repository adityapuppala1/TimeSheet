/**
 * Whose org chart a person sees.
 *
 * THE BUG: a non-privileged caller was rooted at themselves, so an employee with no reports got a
 * diagram of exactly one box — themselves. An org chart that cannot show you your own manager, or
 * the people sitting either side of you, is not answering either question it exists for.
 */
import { describe, expect, it } from "vitest";
import { orgChartRoots } from "../../src/controllers/team.controller.js";

const ceo = { id: "ceo", managerId: null };
const manager = { id: "mgr", managerId: "ceo" };
const me = { id: "me", managerId: "mgr" };
const peer = { id: "peer", managerId: "mgr" };
const myReport = { id: "mine", managerId: "me" };
const stranger = { id: "other", managerId: "ceo" };
const ALL = [ceo, manager, me, peer, myReport, stranger];

describe("orgChartRoots", () => {
  it("roots an employee at their MANAGER, so the manager and every peer are in the tree", () => {
    expect(orgChartRoots(ALL, "me", false)).toEqual([manager]);
  });

  it("roots a person with no manager at themselves — there is nothing above them to show", () => {
    expect(orgChartRoots(ALL, "ceo", false)).toEqual([ceo]);
  });

  it("gives an admin every top-level person, not just one branch", () => {
    expect(orgChartRoots(ALL, "me", true)).toEqual([ceo]);
    // Two people with no manager means two roots — a company that is not one tree still renders.
    const withSecondRoot = [...ALL, { id: "founder2", managerId: null }];
    expect(orgChartRoots(withSecondRoot, "me", true).map((u) => u.id)).toEqual(["ceo", "founder2"]);
  });

  it("returns nothing for a viewer who is not in the list at all", () => {
    // Deactivated mid-session, or filtered out as a system account: an empty chart is correct, and
    // is not the same as falling back to the whole company.
    expect(orgChartRoots(ALL, "ghost", false)).toEqual([]);
  });

  it("does not root at a manager who is missing from the list", () => {
    // The manager is deactivated, so they were filtered out upstream. Falling back to the person
    // themselves keeps their own reports visible rather than emptying the chart.
    const withoutManager = ALL.filter((u) => u.id !== "mgr");
    expect(orgChartRoots(withoutManager, "me", false)).toEqual([me]);
  });
});
