/**
 * A guard on one prop, because that prop is the difference between a working dropdown and one that
 * silently refuses to scroll.
 *
 * THE BUG IT PROTECTS AGAINST. `SearchableSelect` is a Radix Popover. Inside a Dialog — which is
 * where it is used on the AI providers screen, the change form and the timesheet entry dialog — a
 * NON-modal Popover cannot be scrolled at all. The Dialog mounts `react-remove-scroll`, which adds
 * a document-level non-passive wheel/touchmove listener and cancels any event that is not inside
 * the lock or inside a registered "shard". The Dialog registers exactly one shard: its own
 * DialogContent. Radix portals popover content to `document.body`, a SIBLING of the dialog, so the
 * `contains()` check fails and the wheel is `preventDefault()`-ed.
 *
 * The list still draws a scrollbar, because `CommandList` really does overflow its `max-h-[300px]`,
 * and clicking still works. So it presents as "the scrollbar is there and the mouse does nothing",
 * which is why it survived this long — and why a reviewer deleting an unfamiliar `modal` prop as
 * redundant would not notice they had broken eight call sites.
 *
 * This cannot assert the scroll itself: jsdom has no layout, so nothing overflows and
 * `react-remove-scroll`'s listener has no real wheel to cancel. Asserting the prop is what is
 * actually checkable, so it is checked, with the reason attached.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("SearchableSelect stays scrollable inside a Dialog", () => {
  it("opens its Popover in modal mode", () => {
    const source = read("../../src/components/ui/searchable-select.tsx");
    const opening = /<Popover\b[^>]*>/.exec(source)?.[0] ?? "";

    expect(opening, "no <Popover> found — this guard is looking at the wrong element").not.toBe("");
    expect(
      /\bmodal\b(?!\s*=\s*\{?\s*false)/.test(opening),
      "SearchableSelect's Popover lost its `modal` prop. Inside a Dialog its option list stops " +
        "responding to the wheel while still rendering a scrollbar — see this file's header."
    ).toBe(true);
  });

  it("still explains why, so the prop is not deleted as noise", () => {
    const source = read("../../src/components/ui/searchable-select.tsx");
    expect(source).toMatch(/react-remove-scroll/);
    expect(source).toMatch(/shard/i);
  });

  it("keeps the bounded, scrollable list the fix depends on", () => {
    // If CommandList ever loses its own height cap, `modal` alone stops being enough: there would
    // be nothing to scroll inside, and the popover would grow past the viewport instead.
    const command = read("../../src/components/ui/command.tsx");
    expect(command).toMatch(/max-h-\[300px\][^"]*overflow-y-auto|overflow-y-auto[^"]*max-h-\[300px\]/);
  });
});
