/**
 * Where an old-style change link should land.
 *
 * WHY IT EXISTS: approval emails and bell notifications linked to `/app/changes?open=<id>`, and the
 * change list never read `?open=` — so an approver clicking "Approval needed" landed on the
 * unfiltered list. New links go straight to `/app/changes/:id`. The ones already in inboxes and in
 * the bell's history are not going to be re-sent, so the list redirects them here.
 *
 * Its own module rather than a line inside Changes.tsx for the reason `return-to.ts` is: it is a
 * routing decision worth testing, and importing a page into a unit test drags in the router, the
 * query client and the API layer for the sake of one pure function.
 *
 * ONLY AN ID-SHAPED VALUE IS FOLLOWED. The value is put into a path, so `?open=../users` must not
 * become a navigation elsewhere in the app; anything else leaves the person on the list.
 */
const CHANGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function changeRedirectFor(search: string): string | null {
  const id = new URLSearchParams(search).get("open");
  return id && CHANGE_ID.test(id) ? `/app/changes/${id}` : null;
}
