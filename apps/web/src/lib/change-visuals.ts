/**
 * WHAT: the one place a change's state, risk band or kind becomes a colour and a word.
 *
 * WHY IT IS NOT INSIDE THE PAGE: the list, the detail panel, the metric cards and the settings
 * screen all render the same vocabulary, and a second hand-maintained colour table is a drift
 * waiting to happen — the day HIGH risk is recoloured, anything keeping its own copy silently
 * disagrees with the row next to it. Everything resolves through the same semantic tokens the rest
 * of the app uses, so light and dark are handled by the token, not by this file.
 */
import type { BadgeProps } from "../components/ui/badge";
import type { ChangeBand, ChangeKind, ChangeOutcome, ChangeState } from "@timesheet/shared";

export type Tone = NonNullable<BadgeProps["variant"]>;

/**
 * State colour follows what the state MEANS for the reader, not where it sits in the sequence:
 * anything waiting on a person is amber, anything moving is blue, anything settled well is green,
 * and anything that stopped is muted or red. A gradient from grey to green would have made
 * "waiting on you" indistinguishable from "in progress", which is the one distinction the board
 * cares about.
 */
export const CHANGE_STATE_TONE: Record<ChangeState, Tone> = {
  DRAFT: "muted",
  SUBMITTED: "info",
  RISK_ASSESSMENT: "info",
  AWAITING_APPROVAL: "warning",
  APPROVED: "success",
  SCHEDULED: "info",
  IMPLEMENTING: "warning",
  VALIDATION: "warning",
  PIR: "warning",
  CLOSED: "success",
  REJECTED: "destructive",
  CANCELLED: "muted"
};

export const CHANGE_RISK_TONE: Record<ChangeBand, Tone> = {
  LOW: "muted",
  MEDIUM: "warning",
  HIGH: "destructive"
};

/** Kind is about urgency and ceremony, so EMERGENCY reads red and STANDARD reads quiet. */
export const CHANGE_KIND_TONE: Record<ChangeKind, Tone> = {
  STANDARD: "muted",
  NORMAL: "info",
  EMERGENCY: "destructive",
  MAJOR: "warning"
};

export const CHANGE_OUTCOME_TONE: Record<ChangeOutcome, Tone> = {
  SUCCESSFUL: "success",
  SUCCESSFUL_WITH_ISSUES: "warning",
  FAILED: "destructive",
  ROLLED_BACK: "destructive"
};

/** "AWAITING_APPROVAL" → "Awaiting approval". SHOUTING CASE in a table reads as an error state. */
export function humanizeChange(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Short, human labels for the lifecycle buttons — "Send for approval" rather than "Submitted". */
export const CHANGE_ACTION_LABEL: Partial<Record<ChangeState, string>> = {
  AWAITING_APPROVAL: "Submit for approval",
  SUBMITTED: "Submit",
  RISK_ASSESSMENT: "Start risk assessment",
  SCHEDULED: "Schedule",
  IMPLEMENTING: "Start implementing",
  VALIDATION: "Finish implementing",
  PIR: "Send for review",
  CLOSED: "Close",
  CANCELLED: "Cancel change",
  DRAFT: "Reopen as draft"
};
