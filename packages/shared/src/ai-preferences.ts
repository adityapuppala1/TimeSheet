export const AI_ANSWER_STYLES = ["default", "concise", "detailed", "checklist"] as const;
export type AiAnswerStyle = (typeof AI_ANSWER_STYLES)[number];
export const AI_ANSWER_STYLE_GUIDANCE: Record<AiAnswerStyle, string> = {
  default: "Use the normal answer style.",
  concise: "Prefer a concise answer while preserving caveats and source limitations.",
  detailed: "Prefer a detailed explanation grounded in the available records; do not invent details.",
  checklist: "Prefer an actionable checklist; distinguish suggestions from actions actually performed."
};

/**
 * What the user row may carry about how they want to be answered — and deliberately nothing else.
 *
 * ONE OPTIONAL ENUM MEMBER, not a bag. This is the boundary C11 draws: an explicit formatting
 * choice the person made and can delete, never anything inferred from what they asked. A key that
 * held free text here would be a prompt the person never sees and cannot audit.
 */
export interface AiPreferences {
  /** Absent or null means "never chose", which is the same thing the default style means. */
  answerStyle?: AiAnswerStyle | null;
}

/**
 * A stored answer style, checked rather than cast.
 *
 * WHY THE API NEEDS THIS AND NOT JUST THE ENUM: the preference is kept in a JSON column on the
 * user row (C11), so what comes back may have been written by an older build, edited by hand, or
 * name a style since withdrawn. Any of those must read as "never chose" and fall back to the
 * default answer — never as a key `AI_ANSWER_STYLE_GUIDANCE` is then asked for and does not have.
 */
export function isAiAnswerStyle(value: unknown): value is AiAnswerStyle {
  return typeof value === "string" && (AI_ANSWER_STYLES as readonly string[]).includes(value);
}
