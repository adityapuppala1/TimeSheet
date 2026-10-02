/**
 * WHAT: the caches that hold a person's notifications — the bell's (`components/NotificationsBell.tsx`)
 * and the Inbox's (`pages/Inbox.tsx`) — and the one way to refresh them after a change.
 *
 * WHY ONE HELPER: the two read the same rows through different queries, and each used to refresh
 * only its own. Mark everything read in the bell while the Inbox was open, and the Inbox kept its
 * unread dots until the page remounted (it does not refetch on focus). Refreshing both, from both
 * places, through this function is what keeps them telling the same story.
 *
 * It returns the promise, so a mutation's `onSuccess` can return or await it: the mutation then
 * settles once the lists are fresh, and nothing is left floating (Sonar S9383).
 */
import type { QueryKey } from "@tanstack/react-query";

export const NOTIFICATION_QUERY_KEYS: readonly QueryKey[] = [["notifications"], ["inbox"]];

export function refreshNotificationQueries(client: { invalidateQueries: (filters: { queryKey: QueryKey }) => Promise<unknown> }): Promise<unknown> {
  return Promise.all(NOTIFICATION_QUERY_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
}
