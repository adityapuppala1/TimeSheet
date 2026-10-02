/**
 * WHAT: the two things every user-lifecycle path owes the seat count — check it before an account
 * BECOMES active, and tell Stripe after the count changes.
 *
 * WHY ONE MODULE. Both were done in a few places and missed in the rest:
 *  - the limit was checked on creation only, so deactivating someone and reactivating them (or
 *    anyone else) walked straight past a full plan, and bulk ACTIVATE could do it for a department;
 *  - the Stripe quantity followed single create, single delete and join approval, and nothing else,
 *    so a bulk deactivate, a CSV import or a SCIM deprovision left the next invoice on the old
 *    headcount.
 * "Becomes active" is one predicate (`takesASeat`) for the same reason `countActiveSeats` is one
 * function: the population checked and the population billed must never disagree.
 *
 * NOT A LOCK. The check and the write are separate statements, so two simultaneous activations of
 * the last seat can both pass — exactly as the creation checks always could. The nightly quantity
 * sweep (billing-sync.service.ts#reconcileSubscriptionSeats) bills what is really active either way.
 */
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { syncSubscriptionSeats } from "./billing-sync.service.js";
import { getEffectiveSeatLimit } from "./plan-limits.service.js";
import { countActiveSeats } from "./seat-count.service.js";

export interface SeatHeadroom {
  limit: number;
  used: number;
}

/** The plan's seat limit and the seats in use, read fresh — a limit lowered a minute ago applies. */
export async function seatHeadroom(): Promise<SeatHeadroom> {
  const { orgId } = requireTenantContext();
  const [limit, used] = await Promise.all([getEffectiveSeatLimit(orgId), countActiveSeats()]);
  return { limit, used };
}

export function hasRoomFor(headroom: SeatHeadroom, seats: number): boolean {
  return headroom.used + seats <= headroom.limit;
}

function defaultRefusal(seats: number, { limit, used }: SeatHeadroom): string {
  if (seats === 1) {
    return `Seat limit reached (${limit} seats on the current plan, all in use). Free a seat, or contact your platform administrator to add more.`;
  }
  return `Activating ${seats} people would exceed the seat limit (${limit} seats, ${used} already used). Free some seats first, or contact your platform administrator to add more.`;
}

/**
 * 402 when `seats` more active accounts would not fit. `message` lets a caller keep the wording its
 * users already know (the create and CSV routes have their own).
 */
export async function assertSeatAvailable(seats = 1, message?: (headroom: SeatHeadroom) => string): Promise<void> {
  if (seats <= 0) return;
  const headroom = await seatHeadroom();
  if (!hasRoomFor(headroom, seats)) throw new AppError(402, message ? message(headroom) : defaultRefusal(seats, headroom));
}

/**
 * Whether moving this account to `nextStatus` makes it take a seat it does not hold now — the same
 * population `countActiveSeats` counts: ACTIVE, not deleted, not an agent identity.
 */
export function takesASeat(before: { status: string; deletedAt?: Date | null; isAgent?: boolean }, nextStatus: string | undefined): boolean {
  return nextStatus === "ACTIVE" && before.status !== "ACTIVE" && !before.deletedAt && !before.isAgent;
}

/**
 * Brings the Stripe subscription quantity to the active-seat count, after a change to it. Awaited
 * the way the original callers awaited `syncSubscriptionSeats`, and as safe to: that function never
 * throws, and returns at once for a workspace with no Stripe subscription — most of them.
 */
export async function syncSeatsAfterChange(): Promise<void> {
  await syncSubscriptionSeats(requireTenantContext().orgId);
}
