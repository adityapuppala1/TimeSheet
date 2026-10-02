/**
 * WHAT: the workspace's metric DEFINITIONS — one per metric, here, and imported by every page that
 * shows it: the home page, Reports, Insights, Workload, Portfolio, the custom-dashboard widgets and
 * Ask AI's admin tools.
 *
 * WHY ONE MODULE: before it, "hours", "open", "SLA breached" and "resolution time" each had three to
 * five definitions across those pages. The home page counted draft and rejected hours as logged, the
 * Workload board counted only approved ones, a STATUS_MIX widget called RESOLVED tickets open while
 * the OPEN_ITEMS widget beside it did not, and the Reports SLA tile read a column that is only
 * written while an optional sweep is switched on. Every one of those was correct by its own lights
 * and the page was still wrong, because two figures that should agree did not.
 *
 * THE DEFINITIONS (the integrator's docs quote these; change them here or nowhere):
 *   - logged hours   = SUBMITTED + APPROVED. Drafts are unfinished, rejected hours were turned down;
 *                      neither is work anybody has vouched for. A view that is explicitly about
 *                      drafts shows them as drafts, never inside "logged".
 *   - approved hours = APPROVED.
 *   - open ticket    = not RESOLVED and not CLOSED. REOPENED is open.
 *   - SLA breached   = (resolvedAt ?? now) > dueAt. Computed from `dueAt`, so it holds whether or not
 *                      the TICKET_SLA_ENABLED sweep that stamps `slaBreachAt` is running.
 *   - resolution / MTTR / first response = the MEDIAN over a stated window, null when the window is
 *                      empty. A mean lets one ancient ticket set the figure; a zero claims a
 *                      measurement of nothing.
 *   - first response = the first comment by someone other than the reporter, an AI agent, or a
 *                      system account (the intake and integration identities). Comments have no
 *                      internal/public split in this schema, so every comment is public.
 *   - people         = not deactivated, and not an AI agent identity (see people-visibility.service.ts).
 *   - capacity       = working days in the window up to today (platform calendar), minus time off,
 *                      times the person's daily capacity. Target utilisation is reported beside it,
 *                      never multiplied into it.
 */
import type { Prisma, TicketStatus, TimesheetStatus } from "@prisma/client";

/* ------------------------------------------------------------------ hours */

export const LOGGED_TIMESHEET_STATUSES: TimesheetStatus[] = ["SUBMITTED", "APPROVED"];

/** `where` fragment for logged hours. Spread into a timesheet `where`. */
export const LOGGED_HOURS_WHERE = { status: { in: LOGGED_TIMESHEET_STATUSES } } satisfies Prisma.TimesheetWhereInput;

export const isLoggedStatus = (status: string): boolean => (LOGGED_TIMESHEET_STATUSES as string[]).includes(status);

/* ------------------------------------------------------------------ tickets */

export const CLOSED_TICKET_STATUSES: TicketStatus[] = ["RESOLVED", "CLOSED"];

/** `status` filter for an open ticket. */
export const OPEN_TICKET_STATUS: Prisma.EnumTicketStatusFilter = { notIn: CLOSED_TICKET_STATUSES };

export const isOpenTicketStatus = (status: string): boolean => !(CLOSED_TICKET_STATUSES as string[]).includes(status);

/** SLA breached: past due when it was resolved, or — still unresolved — past due now. */
export function isSlaBreached(ticket: { dueAt: Date | null; resolvedAt: Date | null }, now: Date): boolean {
  if (!ticket.dueAt) return false;
  return (ticket.resolvedAt ?? now).getTime() > ticket.dueAt.getTime();
}

/** `where` for tickets breaching their SLA right now: open, and past due. The SQL form of
 *  `isSlaBreached` for the unresolved case — the one a "breached" count on a live screen means. */
export function openBreachedWhere(now: Date): Prisma.TicketWhereInput {
  return { status: OPEN_TICKET_STATUS, dueAt: { lt: now } };
}

/* ------------------------------------------------------------------ statistics */

/** The median, or null for an empty sample. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** A ratio as a whole percentage, or null when the denominator is empty. Never 0 for "nothing". */
export function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/* ------------------------------------------------------------------ first response */

/** Every intake and integration identity lives under this domain (chat-intake, email-intake,
 *  git-integration, security-ingestion, ai-agent — see each service's own constant). */
export const SYSTEM_ACCOUNT_DOMAIN = "@system.local";

/**
 * Whether a comment counts as a FIRST RESPONSE: written by somebody other than the reporter, and
 * by a person — not an AI agent identity and not a system account. A reporter adding detail to
 * their own ticket, or an intake bot echoing the email it came from, is not anybody answering it.
 */
export function isResponseComment(
  comment: { authorId: string; author: { email: string; isAgent: boolean } },
  ticket: { reporterId: string }
): boolean {
  if (comment.authorId === ticket.reporterId) return false;
  if (comment.author.isAgent) return false;
  return !comment.author.email.toLowerCase().endsWith(SYSTEM_ACCOUNT_DOMAIN);
}
