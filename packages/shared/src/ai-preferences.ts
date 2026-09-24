export const AI_ANSWER_STYLES = ["default", "concise", "detailed", "checklist"] as const;
export type AiAnswerStyle = (typeof AI_ANSWER_STYLES)[number];
export const AI_ANSWER_STYLE_GUIDANCE: Record<AiAnswerStyle, string> = {
  default: "Use the normal answer style.",
  concise: "Prefer a concise answer while preserving caveats and source limitations.",
  detailed: "Prefer a detailed explanation grounded in the available records; do not invent details.",
  checklist: "Prefer an actionable checklist; distinguish suggestions from actions actually performed."
};
