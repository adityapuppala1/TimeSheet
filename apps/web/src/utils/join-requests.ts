/**
 * WHAT: the small decisions behind Users → Requests (signup Phase 1) — what approving costs, when a
 * request lapses, which roles may be granted, and how a refusal is told. Pure, so
 * tests/unit/join-requests.test.ts pins each one.
 */
import { roles, UNLIMITED_SEATS, type RoleName } from "@timesheet/shared";

/** The line under the role picker: what one approval uses. `full` disables Approve. */
export function seatLine(limit: number, active: number): { text: string; full: boolean } {
  // A self-hosted or enterprise plan carries a sentinel, not a count; "1 of 1000000" reads as a bug.
  if (limit >= UNLIMITED_SEATS) return { text: "Uses 1 seat — this plan has no seat limit", full: false };
  const free = limit - active;
  if (free <= 0) return { text: "Your plan is out of seats — upgrade or free one first", full: true };
  if (free === 1) return { text: `Uses 1 of ${limit} seats (the last free one)`, full: false };
  return { text: `Uses 1 of ${limit} seats (${free} free)`, full: false };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** "in 13 days" … "within the hour" … "expired". The server writes EXPIRED lazily; this only reads. */
export function expiresInLabel(expiresAt: string, now = new Date()): string {
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (left <= 0) return "expired";
  if (left >= DAY) {
    const days = Math.floor(left / DAY);
    return `in ${days} day${days === 1 ? "" : "s"}`;
  }
  if (left >= HOUR) {
    const hours = Math.floor(left / HOUR);
    return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return "within the hour";
}

/** EMPLOYEE first, because it is the default and almost always the answer. More than EMPLOYEE is a
 *  super admin's call — the server refuses it from anyone else; this only keeps the picker honest. */
export function grantableRoles(viewerRole: string | undefined): RoleName[] {
  if (viewerRole !== "SUPER_ADMIN") return ["EMPLOYEE"];
  return ["EMPLOYEE", ...roles.filter((role) => role !== "EMPLOYEE").reverse()];
}

/** A 402 is the seat limit, which the admin fixes in Billing — said as that, with the way there. */
export function approveErrorMessage(error: unknown): { text: string; billing: boolean } {
  const response = (error as { response?: { status?: number; data?: { message?: string } } })?.response;
  if (response?.status === 402) return { text: "Your plan is out of seats — upgrade or free one.", billing: true };
  return { text: response?.data?.message ?? "Couldn't approve the request. Try again.", billing: false };
}
