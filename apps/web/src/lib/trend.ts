/**
 * WHAT: the one trend-math function every stat card with a "vs yesterday" / "vs last week"
 * badge uses — shared so Dashboard/History/Team/Reports can't drift on what "+12%" means.
 * WHY `higherIsBetter` exists: the same +12% reads as good news for "filled today" but bad news
 * for "escalations sent" — the caller decides which direction is good, this function just does
 * the arithmetic and hands back a `good` boolean the UI colors green/red from.
 */
export interface Trend {
  pct: number;
  direction: "up" | "down" | "flat";
  /** NULL means the direction carries no judgement, and the badge renders grey rather than green or
   *  red. Some counts genuinely have no good direction — more tickets RAISED today is neither good
   *  news nor bad, and colouring it asserts something the number does not support. Same reasoning as
   *  `PRIORITY_HIGHER_IS_BETTER` on the ticket metric cards. */
  good: boolean | null;
}

/** Returns null when there's no meaningful baseline to compare against (avoids a misleading
 *  "+∞%" when yesterday was zero) — callers should simply omit the badge in that case. */
export function computeTrend(value: number, baseline: number, higherIsBetter: boolean | null): Trend | null {
  if (baseline <= 0) return value > 0 ? { pct: 100, direction: "up", good: higherIsBetter } : null;
  const pct = Math.round(((value - baseline) / baseline) * 100);
  const direction = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const good = higherIsBetter === null ? null : direction === "flat" ? true : (direction === "up") === higherIsBetter;
  return { pct, direction, good };
}
