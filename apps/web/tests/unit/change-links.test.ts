/**
 * Links to a change that are already sitting in inboxes still open the change.
 *
 * The approval email and the bell used to link to `/app/changes?open=<id>`, and the change list
 * never read `?open=` — the approver landed on the unfiltered list. New links go to the change's
 * own route; the old form is redirected there, because those emails are not getting re-sent.
 *
 * The id goes into a path, so only something shaped like an id is followed: `?open=../users` must
 * not become a navigation somewhere else in the app.
 */
import { describe, expect, it } from "vitest";
import { changeRedirectFor } from "../../src/utils/change-links";

const ID = "11111111-1111-4111-8111-111111111111";

describe("changeRedirectFor", () => {
  it("sends an old ?open= link to the change's own page", () => {
    expect(changeRedirectFor(`?open=${ID}`)).toBe(`/app/changes/${ID}`);
  });

  it("finds the id among other parameters", () => {
    expect(changeRedirectFor(`?utm_source=email&open=${ID}`)).toBe(`/app/changes/${ID}`);
  });

  it("leaves the list alone when there is nothing to open", () => {
    expect(changeRedirectFor("")).toBeNull();
    expect(changeRedirectFor("?state=DRAFT")).toBeNull();
    expect(changeRedirectFor("?open=")).toBeNull();
  });

  it("refuses anything that is not shaped like an id, rather than navigating to it", () => {
    expect(changeRedirectFor("?open=../users")).toBeNull();
    expect(changeRedirectFor("?open=%2F%2Fevil.example")).toBeNull();
    expect(changeRedirectFor(`?open=${ID}/../../admin`)).toBeNull();
  });
});
