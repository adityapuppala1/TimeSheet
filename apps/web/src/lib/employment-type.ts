/** 7.0.0 leave policies: employment types, in the order people pick them, with their words. */
export type EmploymentType = "FULL_TIME" | "PART_TIME" | "CONTRACT" | "INTERN";

export const EMPLOYMENT_TYPE_OPTIONS: ReadonlyArray<readonly [EmploymentType, string]> = [
  ["FULL_TIME", "Full time"],
  ["PART_TIME", "Part time"],
  ["CONTRACT", "Contract"],
  ["INTERN", "Intern"]
];

/** "Everyone" / "Full time, Contract · 2 sites" — a policy scope in words. Pure. */
export function scopeSummary(types: readonly string[] | undefined, siteIds: readonly string[] | undefined, siteName?: (id: string) => string | undefined): string {
  const parts: string[] = [];
  if (types?.length) parts.push(types.map((t) => EMPLOYMENT_TYPE_OPTIONS.find(([v]) => v === t)?.[1] ?? t).join(", "));
  if (siteIds?.length) {
    const names = siteIds.map((id) => siteName?.(id)).filter((n): n is string => Boolean(n));
    parts.push(names.length === siteIds.length ? names.join(", ") : `${siteIds.length} site${siteIds.length === 1 ? "" : "s"}`);
  }
  return parts.length ? parts.join(" · ") : "Everyone";
}
