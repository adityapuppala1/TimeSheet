/**
 * The Inbox's `unread` count means what the bell's badge means.
 *
 * The bell, its badge, "Mark all read" and the daily brief all count unread rows through ONE
 * predicate (`shownInBell`): a row marked done, or still snoozed, is not "unread" anywhere. The Inbox
 * API's own `counts.unread` was the last place still counting every unread row, so the two numbers
 * disagreed for anybody who had handled or snoozed something without opening it.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const { inboxCounts, shownInBell } = await import("../../src/services/inbox.service.js");

describe("inboxCounts", () => {
  it("counts unread rows with the bell's own predicate", async () => {
    const count = vi.fn().mockResolvedValue(0);
    const client = { notification: { count } } as unknown as PrismaClient;
    const now = new Date("2026-10-02T10:00:00Z");

    await runInTenant(client, () => inboxCounts("u1", now));

    const unreadQuery = count.mock.calls.map((call) => call[0].where).find((where) => "readAt" in where);
    expect(unreadQuery).toEqual({ ...shownInBell("u1", now), readAt: null });
  });
});
