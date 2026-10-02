import { formatHours } from "./format";
import type { TimesheetAnalytics } from "../services/api";

/**
 * The one sentence that explains why the Analytics panel's hours are lower than the grouped report
 * above it on the Reports page.
 *
 * Both totals are right; they answer different questions. The grouped report is a filterable
 * listing whose status filter defaults to "any status". Analytics is a utilisation measure and
 * counts LOGGED hours only (submitted + approved). The difference is exactly the draft and rejected
 * hours the server reports as excluded, so the caption names that figure rather than leaving the
 * reader to discover two totals that disagree.
 *
 * `excluded` is optional so an older server that does not send it reads as "nothing left out".
 */
export function loggedHoursCaption(excluded: TimesheetAnalytics["totals"]["excluded"] | undefined): string {
  const left = (excluded?.draftHours ?? 0) + (excluded?.rejectedHours ?? 0);
  if (left <= 0) return "Logged = submitted + approved.";
  return `Logged = submitted + approved; ${formatHours(left)} in drafts or rejected not counted.`;
}
