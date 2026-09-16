/**
 * WHAT: a stable colour for a thing that has none of its own — a project, today — so it reads the
 * same everywhere it appears: the sidebar tree, the tickets table, the phone cards.
 *
 * WHY DETERMINISTIC FROM THE ID: the alternative is a stored colour per project, which is an
 * additive column and a settings control — the right end state (ClickUp lets a person set a
 * Folder colour, help.clickup.com/hc/en-us/articles/6311584413079), and the follow-up once this
 * pattern has proved itself on screen. Hashing the id gives every project a colour today, with no
 * migration, and the same colour on every device; when stored colours arrive they simply override.
 *
 * WHY THESE EIGHT HUES: they are spaced around the wheel so neighbours differ, and each is written
 * as an HSL pair — a saturated FILL for the mark (white or near-black initial on it, chosen per
 * theme) and a TEXT tone that clears WCAG AA against both page surfaces from index.css. The
 * marks are identity, not state: no hue here is reserved for a status, so a red project cannot be
 * mistaken for a failing one. Original values, not any other product's palette.
 */

export interface IdentityColor {
  /** A short stable name, for `data-` attributes and tests. */
  id: string;
  /** HSL triplet for the mark's fill in the light theme. */
  light: string;
  /** HSL triplet for the mark's fill in the dark theme (lighter, so the dark initial stays legible). */
  dark: string;
}

export const IDENTITY_COLORS: readonly IdentityColor[] = [
  { id: "sky", light: "204 80% 40%", dark: "204 80% 62%" },
  { id: "violet", light: "268 60% 48%", dark: "268 65% 70%" },
  { id: "rose", light: "340 65% 45%", dark: "340 70% 68%" },
  { id: "amber", light: "32 85% 38%", dark: "36 85% 58%" },
  { id: "emerald", light: "156 60% 32%", dark: "156 55% 52%" },
  { id: "indigo", light: "232 58% 50%", dark: "232 65% 72%" },
  { id: "teal", light: "186 70% 34%", dark: "184 65% 52%" },
  { id: "plum", light: "300 45% 42%", dark: "300 50% 68%" }
];

/** FNV-1a over the id — tiny, stable across engines, spreads similar uuids apart. */
export function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function identityColorFor(key: string, palette: readonly IdentityColor[] = IDENTITY_COLORS): IdentityColor {
  return palette[hashKey(key) % palette.length];
}

/** "PropTech_ERP" → "P"; "HICS Operations Platform" → "HO"; empty → "•". Two letters when the
 *  name has two words, one otherwise — a mark, not an abbreviation contest. */
export function initialsFor(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return "•";
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}
