/**
 * Which preset names the range on the picker's button. Several presets can describe the SAME range
 * — on the 1st, "This month" is just today; on a Monday, "This week" is just today; on 1 January,
 * four of them are — and the button used to name whichever came first, so choosing "This month" on
 * the 1st read back "Today". The preset the person chose wins while it still describes the range.
 */
import { describe, expect, it } from "vitest";
import { activePresetFor } from "../../src/utils/date-presets";

const firstOfOctober = { from: "2026-10-01", to: "2026-10-01" };
const presets = [
  { label: "Today", range: () => firstOfOctober },
  { label: "This week", range: () => ({ from: "2026-09-28", to: "2026-10-01" }) },
  { label: "This month", range: () => firstOfOctober },
  { label: "This year", range: () => ({ from: "2026-01-01", to: "2026-10-01" }) }
];

describe("activePresetFor", () => {
  it("names the preset the person chose when two describe the same range", () => {
    expect(activePresetFor(presets, firstOfOctober, "This month")?.label).toBe("This month");
  });

  it("falls back to the first match when nobody chose one — a range set by the page or a link", () => {
    expect(activePresetFor(presets, firstOfOctober, null)?.label).toBe("Today");
  });

  it("drops a chosen preset that no longer describes the range", () => {
    expect(activePresetFor(presets, firstOfOctober, "This year")?.label).toBe("Today");
  });

  it("names nothing for a range no preset describes", () => {
    expect(activePresetFor(presets, { from: "2026-09-03", to: "2026-09-17" }, "This month")).toBeUndefined();
  });
});
