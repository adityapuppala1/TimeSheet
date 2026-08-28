/**
 * Where an AI proposal's "open this" chevron goes, per target type — and `null` when the honest
 * answer is nowhere.
 *
 * WHY THIS IS ITS OWN MODULE rather than a helper inside Proposals.tsx: it encodes a routing
 * decision that was wrong in production, so it is worth testing directly, and importing a page
 * component into a unit test drags in react-query, the router and the whole API client for the
 * sake of one pure function. Same reasoning as utils/return-to.ts, which exists for the same shape
 * of problem.
 *
 * WHAT WENT WRONG. Every target used to be routed to `/app/tickets?open=<id>`, but a proposal
 * targets whatever the feature that produced it works on: CHANGE_DRAFT targets change requests,
 * RISK_MITIGATION targets projects, and only PLAN_BREAKDOWN and REQUIREMENTS_DOC target tickets. On
 * a real workspace 11 of 13 targets were not tickets, so the chevron handed a change or project id
 * to `GET /tickets/:id`, which 404s — and the ticket sheet had no error branch, so it opened blank.
 * Two bugs stacked into one silent white panel.
 *
 * WHY A SWITCH WITH A `never` FLOOR. The root cause was a type that had drifted from what the API
 * actually sends, so the guard has to be one the compiler enforces rather than one a reviewer has
 * to notice. The list lives in @timesheet/shared now, and this switch must handle every member of
 * it: add a seventh target type and the `exhaustive` assignment stops compiling until somebody
 * decides where its chevron should go. That is better than this function quietly picking a default
 * on their behalf, which is precisely how the original bug behaved.
 *
 * BOOKING, LINK and TICKET_LABEL return null deliberately, not by omission. None of them has a page
 * of its own, and a chevron that lands on a list the viewer may not even have permission for reads
 * as a broken link rather than as an absent feature. PROJECT is the same today — if a per-project
 * view ever gains a deep link, it belongs here.
 */
import type { AiProposalTargetType } from "@timesheet/shared";

export function destinationFor(change: { targetType: AiProposalTargetType; targetId: string | null }): string | null {
  // A CREATE row has no target yet — there is nothing to open until it has been applied.
  if (!change.targetId) return null;

  switch (change.targetType) {
    case "TICKET":
      return `/app/tickets?open=${change.targetId}`;
    case "CHANGE":
      return `/app/changes/${change.targetId}`;
    case "PROJECT":
    case "BOOKING":
    case "LINK":
    case "TICKET_LABEL":
      return null;
    default: {
      const exhaustive: never = change.targetType;
      return exhaustive;
    }
  }
}
