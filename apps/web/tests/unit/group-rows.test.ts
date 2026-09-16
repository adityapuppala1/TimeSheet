/**
 * Grouping must never re-order what it is handed, must count honestly across pages, and must
 * turn an enum token into a heading a person would write.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_GROUP_LABEL, formatGroupLabel, groupCounts, groupRuns } from "../../src/lib/group-rows";

const rows = [
  { id: 1, status: "OPEN", assignee: "Ana" },
  { id: 2, status: "OPEN", assignee: null },
  { id: 3, status: "IN_PROGRESS", assignee: "Ana" },
  { id: 4, status: "OPEN", assignee: "Bo" }
];

describe("groupRuns", () => {
  it("preserves the caller's order and splits only where the key changes", () => {
    const runs = groupRuns(rows, (r) => r.status);
    expect(runs.map((r) => [r.key, r.count])).toEqual([
      ["OPEN", 2],
      ["IN_PROGRESS", 1],
      ["OPEN", 1] // not merged back: re-ordering is the caller's job, and honesty is ours
    ]);
    expect(runs[0].rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("gives null keys one shared, labelled run", () => {
    const runs = groupRuns([rows[1], { id: 5, status: "OPEN", assignee: undefined }], (r) => r.assignee);
    expect(runs).toHaveLength(1);
    expect(runs[0].key).toBe("");
    expect(runs[0].label).toBe(EMPTY_GROUP_LABEL);
  });

  it("is empty for no rows", () => {
    expect(groupRuns([], () => "x")).toEqual([]);
  });
});

describe("groupCounts", () => {
  it("counts over the whole set, so a header can say the true size while one page shows", () => {
    const counts = groupCounts(rows, (r) => r.status);
    expect(counts.get("OPEN")).toBe(3);
    expect(counts.get("IN_PROGRESS")).toBe(1);
  });
});

describe("formatGroupLabel", () => {
  it("turns enum tokens into sentences and leaves names alone", () => {
    expect(formatGroupLabel("IN_PROGRESS")).toBe("In progress");
    expect(formatGroupLabel("OPEN")).toBe("Open");
    expect(formatGroupLabel("HIGH")).toBe("High");
    expect(formatGroupLabel("PropTech_ERP")).toBe("PropTech_ERP"); // mixed case: a name, not a token
    expect(formatGroupLabel("Ana Lopez")).toBe("Ana Lopez");
    expect(formatGroupLabel("QA")).toBe("Qa"); // known cost of the rule; statuses matter more than acronyms
  });

  it("labels the absent", () => {
    expect(formatGroupLabel(null)).toBe(EMPTY_GROUP_LABEL);
    expect(formatGroupLabel("  ")).toBe(EMPTY_GROUP_LABEL);
  });
});
