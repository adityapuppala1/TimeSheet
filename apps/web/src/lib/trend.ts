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
  /** The baseline was zero. Any figure over nothing is an infinite increase, so there is no
   *  percentage to print — the badge says "new" instead of a fake "+100%". */
  isNew?: boolean;
}

/** Null when both sides are zero — there is nothing to compare. A zero baseline with something now is
 *  `isNew` rather than "+100%". */
export function computeTrend(value: number, baseline: number, higherIsBetter: boolean | null): Trend | null {
  if (baseline <= 0) return value > 0 ? { pct: 0, direction: "up", good: higherIsBetter, isNew: true } : null;
  const pct = Math.round(((value - baseline) / baseline) * 100);
  const direction = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const good = higherIsBetter === null ? null : direction === "flat" ? true : (direction === "up") === higherIsBetter;
  return { pct, direction, good };
}

/** The badge text: "new", "flat", or a signed percentage. */
export function trendText(trend: Trend): string {
  if (trend.isNew) return "new";
  if (trend.direction === "flat") return "flat";
  return `${trend.pct > 0 ? "+" : ""}${trend.pct}%`;
}
