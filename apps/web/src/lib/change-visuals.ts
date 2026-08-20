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

/**
 * What picking each type actually commits you to.
 *
 * WHY THIS EXISTS: two of these choices silently add obligations. MAJOR forces a backout plan even
 * when the risk matrix bands the change LOW, and forces a post-implementation review even when it
 * succeeds — see `changeKinds` in @timesheet/shared. A picker that renders four bare words lets
 * somebody take on both without knowing, and then meet them as a 422 at submission time. The rule is
 * the same one the risk section follows: say what a field will demand before it demands it.
 */
export const CHANGE_KIND_MEANING: Record<ChangeKind, string> = {
  STANDARD: "Pre-approved routine work. Low ceremony.",
  NORMAL: "Planned work that earns a decision. The default.",
  EMERGENCY: "Cannot wait for the usual decision. Expect scrutiny after the fact.",
  MAJOR: "Normal, escalated. Always needs a backout plan and a post-implementation review, whatever the risk score says."
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

/**
 * Which tab holds the field a submission requirement is complaining about.
 *
 * WHY IT EXISTS: `blockingForSubmit` comes back as a list of human phrases — "Backout plan",
 * "Planned window" — and the form has thirteen tabs. Telling somebody what is missing without
 * telling them where it lives is most of the way to not telling them. The server owns the phrases,
 * so this map is keyed on them and falls back to no marker rather than guessing.
 *
 * Keep it in step with `missingForSubmit` / `missingForClose` in change.service.ts.
 */
export const CHANGE_REQUIREMENT_TAB: Record<string, string> = {
  Justification: "business",
  "Risk assessment": "risk",
  "Implementation plan": "implementation",
  "Planned window": "schedule",
  "Backout plan": "rollback",
  "Test plan": "testing",
  "Communication plan": "comms",
  "Expected downtime": "impact",
  Outcome: "outcome",
  "Post-implementation review": "outcome"
};

/** The risk requirement arrives counted — "Risk assessment (3 of 11 unanswered)" — so an exact key
 *  lookup misses it. Prefix matching is enough because no two requirements share a prefix. */
export function tabForRequirement(requirement: string): string | undefined {
  const exact = CHANGE_REQUIREMENT_TAB[requirement];
  if (exact) return exact;
  const key = Object.keys(CHANGE_REQUIREMENT_TAB).find((k) => requirement.startsWith(k));
  return key ? CHANGE_REQUIREMENT_TAB[key] : undefined;
}

/** The three phases the thirteen tabs actually fall into. Rendered as separators in the strip so a
 *  long row of equal-weight tabs reads as a sequence rather than a list. */
export const CHANGE_TAB_GROUPS: Array<{ label: string; tabs: Array<{ value: string; label: string }> }> = [
  {
    label: "Define",
    tabs: [
      { value: "basics", label: "Basics" },
      { value: "business", label: "Business case" },
      { value: "impact", label: "Impact" },
      { value: "risk", label: "Risk" }
    ]
  },
  {
    label: "Plan",
    tabs: [
      { value: "implementation", label: "Implementation" },
      { value: "testing", label: "Testing" },
      { value: "rollback", label: "Rollback" },
      { value: "release", label: "Release" },
      { value: "schedule", label: "Schedule" },
      { value: "comms", label: "Comms" }
    ]
  },
  {
    label: "Deliver",
    tabs: [
      { value: "context", label: "Context" },
      { value: "runbook", label: "Runbook" },
      { value: "tagging", label: "Tickets & team" },
      { value: "outcome", label: "Outcome" }
    ]
  }
];
