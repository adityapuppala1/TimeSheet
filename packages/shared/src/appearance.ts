/**
 * WHAT: the appearance preference a person can save — a theme MODE and an ACCENT — as one shared
 * definition both apps compile against.
 *
 * WHY IT LIVES IN `packages/shared`: the API validates the value on the way in and the web renders
 * it on the way out, and this is the file that stops those two disagreeing about what is allowed.
 * A palette name accepted by the PATCH schema but unknown to the renderer would save fine and then
 * paint nothing.
 *
 * MODE. Three, not two. "system" is what everyone has by default and what the previous unit made
 * work — it follows the OS and never persists an inferred value. "light"/"dark" are explicit
 * choices. Absent (`null`) means "never chose", which renders as system; the two are kept distinct
 * so a later "reset to default" is a real state change and not a no-op.
 *
 * ACCENT. Every entry below was MEASURED for WCAG 2.1 AA before it was allowed in — against both
 * page surfaces from index.css, as a fill with text on it AND as text on the page. The measurement
 * decided the shape of this file:
 *
 *   No hue at all passes AA with WHITE text on a dark-theme fill. Not one of eight candidates, and
 *   not the existing brand teal either (2.41:1). The dark palette in index.css already solves this
 *   for the brand hue by pairing a lighter fill with `--primary-foreground`; so every accent here
 *   carries its own per-theme FOREGROUND, and on dark themes that foreground is dark text. With
 *   that pairing every accent clears 4.5:1 on both surfaces in both roles.
 *
 * Values are HSL triplets in the same `H S% L%` form index.css uses, so they drop straight into
 * `--primary` / `--ring` / `--primary-foreground` without conversion. The brand teal is the first
 * entry and the default, and it is the EXISTING primary values copied exactly — choosing "teal"
 * must render pixel-identically to never having chosen anything.
 *
 * Original hues, deliberately. These replicate the *capability* of user-selectable accents and
 * nothing of any other product's palette.
 */

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/**
 * DENSITY. Two, not three. "comfortable" is exactly today's rendering — index.css sets a 14px
 * root and every rem-based size follows it — so choosing it changes nothing for anyone.
 * "compact" moves that one lever to 13px, which is how this app has ALWAYS done density (the
 * comment on `html { font-size }` in index.css records that 16 → 14 was the fix behind "it only
 * looks right at 80% zoom"). Touch targets are absolute pixels since the V12 44px unit and do not
 * move. A third, roomier step was left out: nothing here was measured for it, and a setting nobody
 * asked for is a setting nobody tests.
 */
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];
export const DEFAULT_DENSITY: Density = "comfortable";

export interface AccentTheme {
  /** HSL triplet for `--primary` and `--ring`. */
  primary: string;
  /** HSL triplet for `--primary-foreground` — the text that sits ON the primary fill. */
  foreground: string;
}

export interface AccentPalette {
  label: string;
  light: AccentTheme;
  dark: AccentTheme;
}

/**
 * Keyed by a stable id that is what gets persisted. Labels can be reworded; ids cannot, because a
 * saved row carries them.
 *
 * Contrast (measured, WCAG 2.1, text on fill / text on page):
 *   teal    light 4.27* / 4.08*   dark 8.9 / 7.65    * see note below
 *   indigo  light 8.73  / 8.35    dark 5.3 / 5.31
 *   violet  light 7.72  / 7.38    dark 6.8 / 6.81
 *   rose    light 6.40  / 6.12    dark 6.3 / 6.34
 *   amber   light 5.31  / 5.08    dark 9.6 / 9.59
 *   emerald light 5.36  / 5.12    dark 9.6 / 9.57
 *   sky     light 5.65  / 5.40    dark 8.4 / 8.37
 *
 * The teal light values are the app's EXISTING primary and sit just under 4.5:1 for white-on-fill.
 * That is a pre-existing property of the brand colour, not something this file introduced, and it
 * is left exactly as it was: changing the default hue is a brand decision, not an accent feature.
 * It is recorded here so the next person does not think the measurement was skipped.
 */
export const ACCENT_PALETTES = {
  teal: {
    label: "Teal",
    light: { primary: "186 82% 32%", foreground: "0 0% 100%" },
    dark: { primary: "184 74% 44%", foreground: "224 38% 8%" }
  },
  indigo: {
    label: "Indigo",
    light: { primary: "243 60% 48%", foreground: "0 0% 100%" },
    dark: { primary: "243 70% 70%", foreground: "224 38% 8%" }
  },
  violet: {
    label: "Violet",
    light: { primary: "270 60% 44%", foreground: "0 0% 100%" },
    dark: { primary: "270 65% 72%", foreground: "224 38% 8%" }
  },
  rose: {
    label: "Rose",
    light: { primary: "346 70% 42%", foreground: "0 0% 100%" },
    dark: { primary: "346 75% 68%", foreground: "224 38% 8%" }
  },
  amber: {
    label: "Amber",
    light: { primary: "30 90% 34%", foreground: "0 0% 100%" },
    dark: { primary: "38 90% 58%", foreground: "224 38% 8%" }
  },
  emerald: {
    label: "Emerald",
    light: { primary: "158 70% 28%", foreground: "0 0% 100%" },
    dark: { primary: "158 60% 55%", foreground: "224 38% 8%" }
  },
  sky: {
    label: "Sky",
    light: { primary: "204 85% 36%", foreground: "0 0% 100%" },
    dark: { primary: "204 85% 66%", foreground: "224 38% 8%" }
  }
} as const satisfies Record<string, AccentPalette>;

export type AccentId = keyof typeof ACCENT_PALETTES;
export const ACCENT_IDS = Object.keys(ACCENT_PALETTES) as AccentId[];
export const DEFAULT_ACCENT: AccentId = "teal";

/** What a User row stores. All optional: a row that predates the column has none of them. */
export interface AppearancePreference {
  mode?: ThemeMode | null;
  accent?: AccentId | null;
  density?: Density | null;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === "string" && value in ACCENT_PALETTES;
}

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value);
}
