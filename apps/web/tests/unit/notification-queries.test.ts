/**
 * The bell and the Inbox read the same notifications through two caches. Marking read in one used
 * to refresh only its own — mark everything read in the bell while the Inbox is open, and the Inbox
 * kept its unread dots. One helper refreshes both, and hands back the promise so a mutation's
 * `onSuccess` can wait for it (nothing left floating — Sonar S9383).
 */
import { describe, expect, it } from "vitest";
import { NOTIFICATION_QUERY_KEYS, refreshNotificationQueries } from "../../src/lib/notification-queries";

describe("refreshNotificationQueries", () => {
  it("refreshes both the bell's and the Inbox's caches, and resolves once both have", async () => {
    const refreshed: string[] = [];
    let settled = false;
    const client = {
      invalidateQueries: ({ queryKey }: { queryKey: readonly string[] }) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            refreshed.push(queryKey[0]);
            resolve();
          }, 1)
        )
    };
    const pending = refreshNotificationQueries(client).then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    await pending;
    expect(refreshed.sort()).toEqual(["inbox", "notifications"]);
    expect(NOTIFICATION_QUERY_KEYS.map((key) => key[0]).sort()).toEqual(["inbox", "notifications"]);
  });
});
