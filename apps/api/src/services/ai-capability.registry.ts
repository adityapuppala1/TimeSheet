/**
 * WHAT: every AI capability in this product, and the most authority each one is ever allowed to
 * hold — regardless of what a workspace asks for.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE:
 *
 *   AN AUTONOMY LEVEL IS A CEILING THE CODE SETS AND AN ADMINISTRATOR LOWERS,
 *   NEVER ONE AN ADMINISTRATOR RAISES.
 *
 * `AiCapabilityPolicy.level` is what the workspace asked for. `maxLevel` below is what the product
 * permits. The effective level is the minimum of the two, recomputed on every read — so a row
 * written by an older release, or edited by hand in MySQL, cannot outrank the code that has to
 * defend it.
 *
 * WHY THE CEILINGS ARE HERE AND NOT IN THE DATABASE: a ceiling that a workspace can edit is not a
 * ceiling. These are product decisions about what this software will do unattended, and they
 * belong in a file that ships and is reviewed, next to the reason for each one.
 *
 * WHY EVERY CEILING CARRIES A `ceilingReason`: the settings UI renders the higher rungs greyed out
 * with that sentence underneath, rather than hiding them. The absence of an option is worth far
 * more when you can point an auditor at it and it explains itself. "This product will never
 * approve a timesheet unattended, and here is the screen that says so" is the single most valuable
 * thing this ladder produces.
 *
 * WHO READS THIS: `ai-autonomy.service.ts` (resolution + clamping), the settings routes, and — for
 * the tool allowlist — the agent runtime.
 */
import type { AiAutonomyLevel } from "@prisma/client";
import type { AIFeatureToggle } from "./ai.service.js";

/** Ordered weakest to strongest. Comparison is by index, so the order here IS the ladder. */
export const AUTONOMY_LADDER: readonly AiAutonomyLevel[] = ["SUGGEST", "AUTO_APPLY", "AUTONOMOUS"] as const;

export function levelRank(level: AiAutonomyLevel): number {
  const i = AUTONOMY_LADDER.indexOf(level);
  // An unrecognised level is treated as the floor rather than throwing. A capability whose stored
  // level this build does not understand must degrade to "propose only", never to "do anything".
  return i === -1 ? 0 : i;
}

export interface AiCapabilitySpec {
  /** Stable id, stored in AiCapabilityPolicy.capability. Matches the `feature` string the
   *  capability logs to AIUsageLog wherever one exists, so usage and policy can be joined. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /**
   * The existing GlobalAISettings boolean that must already be on. Reusing it rather than adding a
   * second switch is deliberate — see the schema comment on aiAutonomyEnabled.
   *
   * NULL for a capability that reaches no model. Not every entry here is AI: the rebalance
   * producer is pure arithmetic over the workload figures, so gating it on an AI toggle would mean
   * switching off AI stopped a feature that never used any. It still sits in this registry, because
   * "how much may this act on its own" is the same question whatever computes the answer.
   */
  readonly featureToggle: AIFeatureToggle | null;
  /** THE CEILING. The highest level a SUPER_ADMIN may select for this capability. */
  readonly maxLevel: AiAutonomyLevel;
  /** Rendered next to the disabled rungs. Null only when maxLevel is AUTONOMOUS. */
  readonly ceilingReason: string | null;
  /** True when this capability's INPUT is authored outside the workspace — inbound email, a chat
   *  message, a PR body, a scanner finding, a CI log. Everything so marked is capped below
   *  AUTONOMOUS, and the agent runtime additionally clamps a run that has touched such content. */
  readonly actsOnUntrustedInput: boolean;
  /** MCP tool names this capability may call, enforced through the same `isToolEnabled` predicate
   *  that already backs both `tools/list` and `tools/call`. Empty means it calls no tools. */
  readonly tools: readonly string[];
}

/**
 * WHY SO MANY CEILINGS ARE `SUGGEST`, stated once rather than repeated twenty times:
 *
 * This database holds the hours people are paid for. The blast radius of a wrong autonomous action
 * is not a bad suggestion someone ignores — it is a payroll record, an approval somebody is deemed
 * to have given, or an email that has already left the building. None of those have an undo, and
 * a product that cannot undo an action should not take it without being asked.
 */
const CAPABILITIES: ReadonlyArray<AiCapabilitySpec> = [
  // ── Reads and writes nothing. Already unattended today (cron-driven), so naming them
  //    AUTONOMOUS costs nothing and is what makes the ladder truthful rather than decorative.
  {
    id: "weekly_digest",
    title: "Weekly digest",
    description: "Writes each person a recap of their week. Sends email; changes no records.",
    featureToggle: "weeklyDigestEnabled",
    maxLevel: "AUTONOMOUS",
    ceilingReason: null,
    actsOnUntrustedInput: false,
    tools: []
  },
  {
    id: "security_weekly_digest",
    title: "Security weekly digest",
    description: "Org-wide security recap to admins. Sends email; changes no records.",
    featureToggle: "securityWeeklyDigestEnabled",
    maxLevel: "AUTONOMOUS",
    ceilingReason: null,
    actsOnUntrustedInput: false,
    tools: []
  },
  {
    id: "bug_pattern_digest",
    title: "Bug pattern digest",
    description: "Monthly \"what keeps breaking\" correlation. Sends email; changes no records.",
    featureToggle: "bugPatternDigestEnabled",
    maxLevel: "AUTONOMOUS",
    ceilingReason: null,
    actsOnUntrustedInput: false,
    tools: []
  },
  {
    id: "status_report",
    title: "Stakeholder status report",
    description: "Turns project counts into a written update. Produces text on request only.",
    featureToggle: "statusReportEnabled",
    maxLevel: "AUTONOMOUS",
    ceilingReason: null,
    actsOnUntrustedInput: false,
    tools: []
  },
  {
    id: "project_risk_narrative",
    title: "Project risk narrative",
    description: "Explains a risk score that was computed arithmetically. Never sets the score.",
    featureToggle: "projectRiskAgentEnabled",
    maxLevel: "AUTONOMOUS",
    ceilingReason: null,
    actsOnUntrustedInput: false,
    tools: []
  },

  // ── Plan-shaped changes. Reversible, scoped to a project, and reviewed row by row — the
  //    capabilities the proposal envelope was actually built for.
  {
    id: "assignment_rebalance",
    title: "Rebalance workload",
    description: "Moves bookings off people over capacity and onto people with room. Uses no AI — the figures are arithmetic.",
    featureToggle: null,
    maxLevel: "AUTO_APPLY",
    ceilingReason:
      "Moving somebody's work to somebody else is a management act. It can apply its own moves when you allow it, but it will not run unattended on a schedule.",
    actsOnUntrustedInput: false,
    tools: []
  },
  {
    id: "plan_breakdown",
    title: "Break work down",
    description: "Proposes child tasks for an epic, with estimates and dependencies.",
    featureToggle: "planBreakdownEnabled",
    maxLevel: "AUTO_APPLY",
    ceilingReason:
      "Creates real work items people are assigned to. It can apply its own change set when you allow it, but it will not run unattended on a schedule.",
    actsOnUntrustedInput: false,
    tools: []
  },
  {
    id: "duplicate_detection",
    title: "Duplicate detection",
    description: "Flags tickets that look like ones already open.",
    featureToggle: "duplicateDetectionEnabled",
    maxLevel: "AUTO_APPLY",
    ceilingReason: "Linking two tickets as duplicates changes what people think is already handled.",
    actsOnUntrustedInput: true,
    tools: []
  },
  {
    id: "assignee_suggestion_explanation",
    title: "Assignee suggestion",
    description: "Explains a ranking that was computed from open and resolved counts.",
    featureToggle: "assigneeSuggestionAiEnabled",
    maxLevel: "AUTO_APPLY",
    ceilingReason: "Assigning work to a named person is a decision with an owner.",
    actsOnUntrustedInput: false,
    tools: []
  },

  // ── Reads text somebody outside this workspace wrote. Capped below AUTONOMOUS on principle.
  {
    id: "triage",
    title: "Ticket triage",
    description: "Sets type, priority and module on a new ticket.",
    featureToggle: "autoTriageEnabled",
    maxLevel: "AUTO_APPLY",
    ceilingReason:
      "Triage reads whatever the reporter wrote, and tickets arrive by email from outside the workspace. Text a stranger authored should buy as little authority as possible.",
    actsOnUntrustedInput: true,
    tools: []
  },
  {
    id: "ci_failure_triage",
    title: "CI failure triage",
    description: "Reads a failing build's log and posts a severity and likely root cause.",
    featureToggle: "ciFailureTriageEnabled",
    maxLevel: "AUTO_APPLY",
    ceilingReason: "CI logs are attacker-reachable text — anything printed by a test run ends up in the prompt.",
    actsOnUntrustedInput: true,
    tools: []
  },
  {
    id: "security_finding_triage",
    title: "Security finding triage",
    description: "Judges an ingested scanner finding as real or a false positive.",
    featureToggle: "findingTriageEnabled",
    maxLevel: "AUTO_APPLY",
    ceilingReason: "A finding's title and body come from an external scanner and can contain anything, including a leaked secret.",
    actsOnUntrustedInput: true,
    tools: []
  },
  {
    id: "pr_review_summary",
    title: "Pull request summary",
    description: "Summarises an opened PR and posts it as a ticket comment.",
    featureToggle: "aiPrReviewSummaryEnabled",
    maxLevel: "AUTO_APPLY",
    ceilingReason: "A pull request body and diff are authored outside this workspace.",
    actsOnUntrustedInput: true,
    tools: []
  },
  {
    id: "pr_inline_review",
    title: "Pull request inline review",
    description: "Posts line-level review comments on a PR.",
    featureToggle: "aiPrInlineReviewEnabled",
    maxLevel: "SUGGEST",
    ceilingReason:
      "Review comments are published to GitHub, outside this workspace. Nothing that leaves the building can be taken back, so it is never applied unattended.",
    actsOnUntrustedInput: true,
    tools: []
  },
  {
    id: "chat_triage",
    title: "Chat message triage",
    description: "Turns a Slack/Teams/Chat message into a titled, classified ticket.",
    featureToggle: "chatIngestionEnabled",
    maxLevel: "AUTO_APPLY",
    ceilingReason: "Chat messages are authored outside the workspace by whoever can post in the channel.",
    actsOnUntrustedInput: true,
    tools: []
  },
  {
    id: "comment_summary",
    title: "Comment thread summary",
    description: "Condenses a long ticket discussion.",
    featureToggle: "commentSummaryEnabled",
    maxLevel: "AUTO_APPLY",
    ceilingReason: "Ticket comments can include text forwarded from outside the workspace.",
    actsOnUntrustedInput: true,
    tools: []
  },

  // ── Text a person is about to put their name on. Suggestion only, always.
  {
    id: "text_refine",
    title: "Refine with AI",
    description: "Tidies grammar and clarity in something you are writing.",
    featureToggle: "writingAssistantEnabled",
    maxLevel: "SUGGEST",
    ceilingReason:
      "This edits words somebody is about to sign their name to — a timesheet description an approver reads, or a comment attributed to you. Replacing them without being asked is the one thing it must never do.",
    actsOnUntrustedInput: false,
    tools: []
  },
  {
    id: "writing_assistant",
    title: "Writing assistant",
    description: "Rewrites a passage on request.",
    featureToggle: "writingAssistantEnabled",
    maxLevel: "SUGGEST",
    ceilingReason: "Same reason as Refine with AI: these are your words, under your name.",
    actsOnUntrustedInput: false,
    tools: []
  },
  {
    id: "ask_ai",
    title: "Ask AI",
    description: "Answers a question about the workspace from tickets you can already see.",
    featureToggle: "workspaceSearchEnabled",
    maxLevel: "SUGGEST",
    ceilingReason: "It answers questions and takes no action, so there is nothing above this rung for it to do.",
    actsOnUntrustedInput: true,
    tools: []
  },
  {
    id: "email_intake",
    title: "Email intake",
    description: "Turns an inbound email into a ticket.",
    featureToggle: "emailIngestionEnabled",
    maxLevel: "SUGGEST",
    ceilingReason:
      "This is the front door for text written by strangers. It already caps how much a model's own confidence can suppress human review, and raising its authority would undo that.",
    actsOnUntrustedInput: true,
    tools: []
  },
  {
    id: "stale_ticket_nudge",
    title: "Stale ticket nudge",
    description: "Suggests a next action on a ticket nobody has touched.",
    featureToggle: "staleTicketNudgeEnabled",
    maxLevel: "SUGGEST",
    ceilingReason: "The nudge is delivered by email and notification. Anything that leaves the workspace cannot be taken back.",
    actsOnUntrustedInput: true,
    tools: []
  },

  // ── Identity. Deliberately the most constrained thing in the product.
  {
    id: "face_review_summary",
    title: "Identity review summary",
    description: "Assesses a flagged verification attempt for an administrator.",
    featureToggle: "faceReviewSummaryEnabled",
    maxLevel: "SUGGEST",
    ceilingReason:
      "This concerns whether a specific person is who they say they are. A machine may lay out the evidence; it does not get to decide, and it never acts on the conclusion.",
    actsOnUntrustedInput: false,
    tools: []
  },
  {
    id: "face_policy_copilot",
    title: "Identity policy copilot",
    description: "Explains a recommended match threshold that was computed from real scores.",
    featureToggle: "facePolicyCopilotEnabled",
    maxLevel: "SUGGEST",
    ceilingReason:
      "The match threshold is the bar identity verification has to clear. Anything that could lower it unattended could lower the bar on its own audit.",
    actsOnUntrustedInput: false,
    tools: []
  },

  // ── The measuring stick.
  {
    id: "eval_judge",
    title: "Evaluation judge",
    description: "Decides whether a replayed answer matches the expected one.",
    featureToggle: "aiEvalJudgeEnabled",
    maxLevel: "SUGGEST",
    ceilingReason:
      "This grades the other capabilities. Giving it authority of its own would move the measuring stick along with the thing being measured.",
    actsOnUntrustedInput: false,
    tools: []
  }
];

/** The public, immutable view. */
export const AI_CAPABILITIES: ReadonlyArray<AiCapabilitySpec> = CAPABILITIES;

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** Undefined for an id this build does not know — callers treat that as SUGGEST, never as a throw:
 *  an unrecognised policy row is a stale row, not a reason to fail a request. */
export function findCapability(id: string): AiCapabilitySpec | undefined {
  return BY_ID.get(id);
}
