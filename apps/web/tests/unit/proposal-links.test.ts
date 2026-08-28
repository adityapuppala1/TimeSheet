/**
 * The routing decision behind a real blank screen.
 *
 * Clicking the "open this" chevron on the AI suggestions page opened an empty white panel for most
 * rows. Every target was sent to `/app/tickets?open=<id>` regardless of what it was, so a change
 * request's id was fetched as a ticket, the API answered 404, and the sheet — which had only a
 * loading branch and a ticket branch — rendered nothing at all.
 *
 * On the workspace where it was reported, 11 of 13 targets were not tickets. That ratio is the
 * reason this is tested rather than eyeballed: the two rows that happened to work were the ones a
 * developer would click first.
 *
 * The last test is the important one. It walks the shared list rather than a list written here, so
 * it fails when a new target type is added without a decision being made about it — the same
 * failure the `never` floor in the function produces at compile time, restated at runtime for
 * anyone reading the suite.
 */
import { describe, expect, it } from "vitest";
import { aiProposalTargetTypes, type AiProposalTargetType } from "@timesheet/shared";
import { destinationFor } from "../../src/utils/proposal-links";

const target = (targetType: AiProposalTargetType, targetId: string | null = "abc-123") => ({ targetType, targetId });

describe("destinationFor — the types that have somewhere to go", () => {
  it("sends a ticket to the ticket sheet", () => {
    expect(destinationFor(target("TICKET"))).toBe("/app/tickets?open=abc-123");
  });

  it("sends a change to the change page, NOT the ticket sheet", () => {
    // The exact bug. A change id is not a ticket id — `GET /tickets/<change id>` is a 404, and the
    // 404 is what rendered blank.
    expect(destinationFor(target("CHANGE"))).toBe("/app/changes/abc-123");
  });
});

describe("destinationFor — the types that do not", () => {
  it.each(["PROJECT", "BOOKING", "LINK", "TICKET_LABEL"] as const)("offers no link for %s", (kind) => {
    // Null, not a best-effort URL. None of these has a page of its own, and a chevron that lands
    // somewhere useless reads as a broken app rather than as a feature that isn't there.
    expect(destinationFor(target(kind))).toBeNull();
  });

  it("offers no link when the row has no target yet", () => {
    // A CREATE row names something that does not exist until the proposal is applied.
    expect(destinationFor(target("TICKET", null))).toBeNull();
  });
});

describe("every target type the API can send is accounted for", () => {
  it("never invents a destination, and never throws, for any member of the shared list", () => {
    for (const kind of aiProposalTargetTypes) {
      const result = destinationFor(target(kind));
      // Either a real in-app path or an honest null — never a relative fragment, never undefined,
      // and never an absolute URL that would leave the app.
      expect(result === null || result.startsWith("/app/")).toBe(true);
    }
  });

  it("covers the list the API actually writes", () => {
    // Pinned deliberately. The blank panel happened because the browser's copy of this list was
    // missing CHANGE, so if this assertion ever needs updating, the update belongs in
    // @timesheet/shared and the switch above — not here alone.
    expect([...aiProposalTargetTypes].sort()).toEqual(
      ["BOOKING", "CHANGE", "LINK", "PROJECT", "TICKET", "TICKET_LABEL"].sort()
    );
  });
});
