/**
 * Null means defaults; a list means exactly that list; the un-hideable are always on; ids the
 * table no longer knows are ignored. Every saved view from before columns existed relies on the
 * first rule; a deleted custom field relies on the last.
 */
import { describe, expect, it } from "vitest";
import { isDefaultColumns, resolveVisibleColumns, type ColumnSpec } from "../../src/lib/table-columns";

const ALL: ColumnSpec[] = [
  { id: "serial", label: "S.NO", canHide: false },
  { id: "title", label: "Title", canHide: false },
  { id: "status", label: "Status" },
  { id: "assignee", label: "Assignee" },
  { id: "cf_client", label: "Client", defaultHidden: true }
];

describe("resolveVisibleColumns", () => {
  it("null is the defaults: built-ins on, custom fields off", () => {
    expect(resolveVisibleColumns(ALL, null)).toEqual(["serial", "title", "status", "assignee"]);
  });

  it("a saved list is exactly that list — plus the columns that cannot be hidden", () => {
    expect(resolveVisibleColumns(ALL, ["cf_client"])).toEqual(["serial", "title", "cf_client"]);
    expect(resolveVisibleColumns(ALL, ["status", "cf_client"])).toEqual(["serial", "title", "status", "cf_client"]);
  });

  it("ignores an id the table no longer has, in table order", () => {
    expect(resolveVisibleColumns(ALL, ["assignee", "cf_deleted", "status"])).toEqual(["serial", "title", "status", "assignee"]);
  });

  it("an empty saved list still shows the un-hideable", () => {
    expect(resolveVisibleColumns(ALL, [])).toEqual(["serial", "title"]);
  });
});

describe("isDefaultColumns", () => {
  it("is order-insensitive and false the moment anything differs", () => {
    expect(isDefaultColumns(ALL, ["assignee", "status", "title", "serial"])).toBe(true);
    expect(isDefaultColumns(ALL, ["serial", "title", "status"])).toBe(false);
    expect(isDefaultColumns(ALL, ["serial", "title", "status", "assignee", "cf_client"])).toBe(false);
  });
});
