/**
 * 7.0.0 — optional holidays a person opts into (PUT/DELETE /api/attendance/me/optional-holidays/:id).
 * An optional holiday counts as a day off only for people who opted in; the calendar may cap how
 * many one person takes per calendar year (maxOptionalPerYear, null = no limit). Pure, so the
 * "why is this disabled?" reasons are unit-tested rather than eyeballed.
 */
export interface OptionalHolidayLike {
  date: string;
  isOptional: boolean;
  optedIn?: boolean;
}

export interface OptionalChoice {
  action: "in" | "out";
  disabled: boolean;
  /** Shown next to a disabled control. */
  reason: string | null;
}

export function optionalTaken(byYear: Record<string, number> | undefined, year: string): number {
  return byYear?.[year] ?? 0;
}

/** null for a public holiday: nothing to choose. */
export function optionalChoice(h: OptionalHolidayLike, cap: number | null, takenThisYear: number, today: string): OptionalChoice | null {
  if (!h.isOptional) return null;
  const action = h.optedIn ? "out" : "in";
  if (h.date < today) return { action, disabled: true, reason: "This day has passed." };
  if (action === "in" && cap !== null && takenThisYear >= cap) {
    return { action, disabled: true, reason: cap === 0 ? "Your calendar allows no optional holidays." : `You have taken all ${cap} optional ${cap === 1 ? "holiday" : "holidays"} for ${h.date.slice(0, 4)}.` };
  }
  return { action, disabled: false, reason: null };
}

export function optionalSummary(cap: number | null, taken: number, year: string): string {
  return cap === null
    ? `Optional holidays: ${taken} taken in ${year}, no limit. They count as a day off only if you opt in.`
    : `Optional holidays: ${taken} of ${cap} taken in ${year}. They count as a day off only if you opt in.`;
}
