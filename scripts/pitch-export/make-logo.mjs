/**
 * Generates the TimeSphere lockup for the deck exports, in both variants, as SVG and PNG.
 *
 * WHY GENERATED RATHER THAN THE ATTACHED BITMAP: the supplied logo image arrived on a dark
 * background with no transparency, and chroma-keying a screenshot leaves fringed edges at slide
 * resolution. The lockup is pure geometry — a rounded teal square, a navy "T", two lines of type —
 * so it is rebuilt here as vectors that are genuinely transparent, then rasterised at 4x for the
 * PPTX (which wants PNG). Colours are read off the app's own palette so the deck and the product
 * cannot drift apart.
 *
 * Two variants because a transparent logo is only half the job:
 *   - `logo-on-dark`  — white wordmark, for the deck's dark slides.
 *   - `logo-on-light` — navy wordmark, for printing and light backgrounds.
 * The icon stays identical in both; it is the type that has to flip.
 *
 * Run: node scripts/pitch-export/make-logo.mjs
 * Out: scripts/pitch-export/assets/logo-on-{dark,light}.{svg,png} + icon.png
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "assets");
mkdirSync(OUT, { recursive: true });

// sharp lives in apps/api's tree; resolve it from there rather than adding a root dependency.
const require = createRequire(path.join(ROOT, "apps/api/package.json"));
const sharp = require("sharp");

const TEAL = "#22B5C4";
const NAVY = "#0E1526";
const SUB = "#94A3B8";

/** The icon: rounded teal square with the navy T. Shared by both variants. */
const icon = (x = 0, y = 0, s = 300) => `
  <g transform="translate(${x} ${y}) scale(${s / 300})">
    <rect x="10" y="10" width="280" height="280" rx="64" fill="${TEAL}" stroke="${NAVY}" stroke-width="14"/>
    <path d="M88 96 h124 v44 h-40 v118 h-44 V140 h-40 z" fill="${NAVY}"/>
  </g>`;

const lockup = (wordColor) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1290" height="330" viewBox="0 0 1290 330">
  ${icon(15, 15, 300)}
  <text x="375" y="160" font-family="Segoe UI, Arial, sans-serif" font-size="118" font-weight="800" fill="${wordColor}">TimeSphere</text>
  <text x="378" y="272" font-family="Segoe UI, Arial, sans-serif" font-size="86" font-weight="400" fill="${SUB}">Enterprise Timesheets</text>
</svg>`;

const files = [
  ["logo-on-dark", lockup("#F3F6FB")],
  ["logo-on-light", lockup(NAVY)],
  ["icon", `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">${icon()}</svg>`]
];

for (const [name, svg] of files) {
  writeFileSync(path.join(OUT, `${name}.svg`), svg, "utf8");
  // density 4x so the PNG stays crisp when PowerPoint scales it on a projector.
  const png = await sharp(Buffer.from(svg), { density: 288 }).png().toBuffer();
  writeFileSync(path.join(OUT, `${name}.png`), png);
  console.log(`${name}.svg + .png (${(png.length / 1024).toFixed(0)} KB)`);
}
