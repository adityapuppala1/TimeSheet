#!/usr/bin/env node
/**
 * WHAT: a WCAG 2.1 contrast check over the colour pairs this app actually draws, read from the
 * source files that define them — `apps/web/src/index.css` (the `:root` and `.dark` token
 * blocks) and `apps/web/src/lib/identity-colors.ts` (the eight project-mark fills).
 *
 * WHY A SCRIPT AND NOT A NOTE: Phase 2 of the V12 work measured the seven accent palettes with a
 * throwaway validator and deleted it; the next time a tone was added the arithmetic had to be
 * re-derived. This is that validator, kept. It has no dependencies and no browser: contrast is
 * arithmetic over the tokens, and the tokens are text.
 *
 * WHAT COUNTS AS A PASS (WCAG 2.1):
 *  - normal text against its background: 4.5:1 (1.4.3 AA)
 *  - large text (>= 18.66px bold or 24px) and NON-TEXT user-interface components — a status dot,
 *    a column's coloured border, a bar — against the adjacent surface: 3:1 (1.4.11)
 *
 * Usage: `node scripts/contrast-check.mjs` (or `npm run check:contrast`). Prints every pair and
 * exits 1 when any pair is below its threshold.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../apps/web/src/index.css"), "utf8");
const identitySource = readFileSync(resolve(here, "../apps/web/src/lib/identity-colors.ts"), "utf8");
const accentSource = readFileSync(resolve(here, "../packages/shared/src/appearance.ts"), "utf8");

/* ---------------------------------------------------------------- colour maths */

/** "204 80% 40%" → [r, g, b] in 0..1 */
export function hslTripletToRgb(triplet) {
  const m = /^\s*(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(triplet);
  if (!m) throw new Error(`not an HSL triplet: "${triplet}"`);
  const h = ((Number(m[1]) % 360) + 360) % 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m0 = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m0, g + m0, b + m0];
}

function channel(v) {
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function luminance(rgb) {
  const [r, g, b] = rgb.map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const la = luminance(hslTripletToRgb(a));
  const lb = luminance(hslTripletToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-blend `over` onto `under` (both HSL triplets) and return the result as an rgb array. */
function blend(overTriplet, alpha, underTriplet) {
  const o = hslTripletToRgb(overTriplet);
  const u = hslTripletToRgb(underTriplet);
  return o.map((v, i) => v * alpha + u[i] * (1 - alpha));
}
function contrastRgbVsTriplet(rgb, triplet) {
  const la = luminance(rgb);
  const lb = luminance(hslTripletToRgb(triplet));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
/** Must match IDENTITY_WASH_ALPHA in apps/web/src/lib/identity-colors.ts. */
const WASH_ALPHA = Number((identitySource.match(/IDENTITY_WASH_ALPHA = ([\d.]+)/) ?? [])[1] ?? 0.12);

/* ---------------------------------------------------------------- token parsing */

/** The `--name: h s% l%;` declarations inside the first block whose selector matches. */
function tokens(selector) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`selector not found in index.css: ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = css.slice(open + 1, end);
  const out = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([\d.]+\s+[\d.]+%\s+[\d.]+%)/g)) out[m[1]] = m[2];
  return out;
}

const light = tokens(":root");
const dark = tokens(".dark");

const identity = [...identitySource.matchAll(/\{\s*id:\s*"(\w+)",\s*light:\s*"([^"]+)",\s*dark:\s*"([^"]+)"\s*\}/g)].map((m) => ({
  id: m[1],
  light: m[2],
  dark: m[3]
}));
if (identity.length === 0) throw new Error("no identity colours parsed");

/** The seven accent palettes a person can choose (packages/shared): `id: { light: {primary, foreground}, dark: {…} }`. */
const accents = [...accentSource.matchAll(/(\w+):\s*\{\s*label:[^{]*?light:\s*\{\s*primary:\s*"([^"]+)",\s*foreground:\s*"([^"]+)"\s*\},[^{]*?dark:\s*\{\s*primary:\s*"([^"]+)",\s*foreground:\s*"([^"]+)"\s*\}/gs)].map((m) => ({
  id: m[1],
  light: { primary: m[2], foreground: m[3] },
  dark: { primary: m[4], foreground: m[5] }
}));
if (accents.length === 0) throw new Error("no accent palettes parsed");

/* ---------------------------------------------------------------- the pairs */

const TEXT = 4.5;
const UI = 3;
const WHITE = "0 0% 100%";
/** ProjectMark's initial in the dark theme (components/ProjectMark.tsx). */
const MARK_DARK_INK = "224 38% 8%";

const checks = [];
function check(theme, label, ratio, threshold, { gating = true } = {}) {
  checks.push({ theme, label, ratio, threshold, gating, pass: ratio >= threshold });
}
/** Reported, not gating: an indicator that repeats information given by adjacent text (a status
 *  dot beside its label, a column border under its heading, the today line among dated bars) is
 *  not a component a person must perceive to use the page (1.4.11's "required to identify"). */
const REPORT_ONLY = { gating: false };

for (const [theme, t, ink] of [
  ["light", light, WHITE],
  ["dark", dark, MARK_DARK_INK]
]) {
  // Identity marks: the initial on its fill. Marks are 11–14px bold on a 20–32px tile: TEXT.
  for (const c of identity) check(theme, `identity ${c.id}: initial on fill`, contrast(c[theme], ink), TEXT);
  // Identity marks against the surfaces they sit on (a non-text component, 1.4.11).
  for (const c of identity) check(theme, `identity ${c.id}: fill vs background`, contrast(c[theme], t.background), UI);
  // The ticket sheet's header wash (7.5): body and muted text over the card tinted by each identity colour.
  for (const c of identity) {
    const washed = blend(c[theme], WASH_ALPHA, t.card);
    check(theme, `wash ${c.id}: foreground over tinted card`, contrastRgbVsTriplet(washed, t.foreground), TEXT);
    check(theme, `wash ${c.id}: muted-foreground over tinted card`, contrastRgbVsTriplet(washed, t["muted-foreground"]), TEXT);
  }

  // Status / priority tone dots on group headings and Board column top borders (non-text UI).
  for (const tone of ["success", "warning", "destructive", "info", "primary"]) {
    check(theme, `tone ${tone}: dot/border vs card`, contrast(t[tone], t.card), UI, REPORT_ONLY);
  }

  /*
   * A BADGE'S TEXT ON ITS OWN TINT, and this one GATES.
   *
   * The dot check above is a 3:1 non-text rule and report-only, and for two years it was the only
   * thing looking at these tones. It cannot see the case that actually matters: `Badge` fills with
   * `bg-<tone>/15` and writes on it at 10.5px, where 4.5:1 applies. Measured on the running app on
   * 2026-09-24, before `--<tone>-ink` existed: "HIGH" 2.09:1, "MEDIUM" 3.63. Both shipped, because
   * nothing here asked.
   *
   * Checked at 15%, the tint `Badge` actually paints, because that is the HARDER case — and the
   * first version of this check got that backwards and used 10%. A stronger tint is a DARKER
   * background on a light theme, so dark text has LESS contrast against it, not more. The gate
   * said 4.75 while the browser measured 4.44 on the same badge. Measure the tint that ships.
   */
  for (const tone of ["success", "warning", "destructive", "info"]) {
    const chip = blend(t[tone], 0.15, t.card);
    check(theme, `tone ${tone}: badge text on its own tint`, contrastRgbVsTriplet(chip, t[`${tone}-ink`]), TEXT);
  }
  check(theme, "tone muted: dot vs card", contrast(t["muted-foreground"], t.card), UI, REPORT_ONLY);

  // Plan marks on the chart surface.
  check(theme, "plan-today line vs card", contrast(t["plan-today"], t.card), UI, REPORT_ONLY);
  check(theme, "plan-critical bar vs card", contrast(t["plan-critical"], t.card), UI, REPORT_ONLY);

  // Capacity ramp: the 11px cell figure on each step, coloured by `--capacity-N-foreground`.
  for (const step of [0, 1, 2, 3, 4]) {
    check(theme, `capacity-${step}: cell text`, contrast(t[`capacity-${step}-foreground`], t[`capacity-${step}`]), TEXT);
  }

  // Body and muted text on the two surfaces the V12 components use.
  check(theme, "foreground on background", contrast(t.foreground, t.background), TEXT);
  check(theme, "muted-foreground on card", contrast(t["muted-foreground"], t.card), TEXT);
  check(theme, "primary-foreground on primary (buttons)", contrast(t["primary-foreground"], t.primary), TEXT);

  // Every chosen accent replaces --primary/--primary-foreground at runtime: button text on each.
  for (const a of accents) check(theme, `accent ${a.id}: button text on primary`, contrast(a[theme].foreground, a[theme].primary), TEXT);
}

/* ---------------------------------------------------------------- report */

let failures = 0;
let notes = 0;
for (const c of checks) {
  let mark = "ok  ";
  if (!c.pass) {
    if (c.gating) {
      failures++;
      mark = "FAIL";
    } else {
      notes++;
      mark = "note";
    }
  }
  const suffix = c.gating ? "" : "  (redundant indicator; reported only)";
  console.log(`${mark} ${c.theme.padEnd(5)} ${c.ratio.toFixed(2).padStart(5)} >= ${c.threshold}  ${c.label}${suffix}`);
}
console.log(`
${checks.length - failures - notes}/${checks.length} pairs meet WCAG 2.1 AA; ${failures} gating failure(s), ${notes} note(s)`);
process.exit(failures ? 1 : 0);
