import { describe, expect, it } from "vitest";
import { feedUrls } from "../../src/components/CalendarFeedCard";

describe("feedUrls", () => {
  it("builds the personal and team URLs on this origin, token in the path", () => {
    const t = "ab".repeat(32);
    expect(feedUrls("https://acme.example.com/", t)).toEqual({
      mine: `https://acme.example.com/api/calendar/feed/${t}.ics`,
      team: `https://acme.example.com/api/calendar/feed/${t}-team.ics`
    });
  });
});
