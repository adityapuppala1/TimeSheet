/**
 * V17 A4 — the client half of the mandatory missed-day reason. The rule itself lives on the server
 * (services/missed-day-reason.service.ts); the form only needs to (a) ask before Save when the
 * server says the chosen date needs a reason, (b) validate the two fields the same way the server
 * does, and (c) turn a 422 MISSED_DAY_REASON_* refusal back into that same prompt.
 */
export interface MissedReasonOption {
  code: string;
  label: string;
  requiresNote: boolean;
}

export const MISSED_DAY_CODES = ["MISSED_DAY_REASON_REQUIRED", "MISSED_DAY_REASON_INVALID"] as const;

/** The same check the server makes, so the form can refuse before a round trip. */
export function missedReasonProblem(
  options: readonly MissedReasonOption[],
  code: string | undefined,
  note: string | undefined
): { field: "missedReasonCode" | "missedReasonNote"; message: string } | null {
  if (!code) return { field: "missedReasonCode", message: "Choose why this day was missed." };
  const option = options.find((o) => o.code === code);
  if (!option) return { field: "missedReasonCode", message: "Choose one of the listed reasons." };
  if (option.requiresNote && !note?.trim()) return { field: "missedReasonNote", message: `Add a note for "${option.label}".` };
  return null;
}

/** A 422 from any timesheet create, read as "open the reason prompt with these options". */
export function readMissedDayRefusal(
  error: unknown
): { options: MissedReasonOption[]; field: "missedReasonCode" | "missedReasonNote"; message: string } | null {
  const data = (error as { response?: { status?: number; data?: { code?: string; message?: string; details?: { field?: string; options?: unknown } } } })
    ?.response;
  if (data?.status !== 422 || !data.data?.code || !(MISSED_DAY_CODES as readonly string[]).includes(data.data.code)) return null;
  const raw = Array.isArray(data.data.details?.options) ? data.data.details.options : [];
  const options = raw.filter(
    (o): o is MissedReasonOption => typeof o?.code === "string" && typeof o?.label === "string" && typeof o?.requiresNote === "boolean"
  );
  // REQUIRED's server text is written for API/MCP callers ("send missedReasonCode…"); a person on the
  // form gets plain words. INVALID's text is already about the field they filled in.
  const required = data.data.code === "MISSED_DAY_REASON_REQUIRED";
  return {
    options,
    field: data.data.details?.field === "missedReasonNote" ? "missedReasonNote" : "missedReasonCode",
    message: required || !data.data.message ? "Choose why this day was missed." : data.data.message
  };
}
