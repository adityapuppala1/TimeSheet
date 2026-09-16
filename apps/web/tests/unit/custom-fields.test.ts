/**
 * The form must show exactly the fields the server will keep — a field the API's normaliser skips
 * for this ticket type must not be offered, or a value typed into it vanishes on save.
 */
import { describe, expect, it } from "vitest";
import { displayValue, editorValue, fieldsForTicket } from "../../src/lib/custom-fields";
import type { CustomFieldRow } from "../../src/services/api";

const def = (over: Partial<CustomFieldRow>): CustomFieldRow => ({
  id: over.key ?? "id",
  key: "k",
  label: "Field",
  type: "TEXT",
  description: null,
  options: null,
  isRequired: false,
  appliesTo: "TICKET",
  ticketTypeFilter: null,
  showOnRequestForm: false,
  order: 0,
  isActive: true,
  ...over
});

describe("fieldsForTicket", () => {
  const defs = [
    def({ key: "z", label: "Zed", order: 2 }),
    def({ key: "a", label: "Alpha", order: 1 }),
    def({ key: "bug-only", label: "Repro", ticketTypeFilter: "BUG" }),
    def({ key: "retired", isActive: false }),
    def({ key: "proj", appliesTo: "PROJECT" })
  ];

  it("keeps active TICKET fields, in the admin's order", () => {
    expect(fieldsForTicket(defs, "TASK").map((d) => d.key)).toEqual(["a", "z"]);
  });

  it("includes a type-scoped field only for its type — mirroring the server's skip rule", () => {
    expect(fieldsForTicket(defs, "BUG").map((d) => d.key)).toContain("bug-only");
    expect(fieldsForTicket(defs, "TASK").map((d) => d.key)).not.toContain("bug-only");
  });

  it("is empty for no definitions", () => {
    expect(fieldsForTicket(undefined, "BUG")).toEqual([]);
  });
});

describe("displayValue", () => {
  it("renders each type as a person reads it", () => {
    expect(displayValue({ type: "CHECKBOX" }, true)).toBe("Yes");
    expect(displayValue({ type: "MULTI_SELECT" }, ["A", "B"])).toBe("A, B");
    expect(displayValue({ type: "MULTI_SELECT" }, [])).toBe("—");
    expect(displayValue({ type: "USER" }, "u1", [{ id: "u1", name: "Ana" }])).toBe("Ana");
    expect(displayValue({ type: "NUMBER" }, 12000)).toBe((12000).toLocaleString());
    expect(displayValue({ type: "TEXT" }, null)).toBe("—");
  });
});

describe("editorValue", () => {
  it("gives every editor the shape it binds to", () => {
    expect(editorValue({ type: "CHECKBOX" }, null)).toBe(false);
    expect(editorValue({ type: "MULTI_SELECT" }, ["x"])).toEqual(["x"]);
    expect(editorValue({ type: "MULTI_SELECT" }, null)).toEqual([]);
    expect(editorValue({ type: "NUMBER" }, 3)).toBe("3");
    expect(editorValue({ type: "TEXT" }, undefined)).toBe("");
  });
});
