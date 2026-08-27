#!/usr/bin/env node
/**
 * Screenshot pages of a PDF, so a generated document can actually be LOOKED at rather than assumed
 * correct.
 *
 * Chromium's built-in PDF viewer renders it; there is no poppler/ghostscript/ImageMagick on this
 * machine and adding a rasteriser dependency just to check a layout is not worth it. Lives beside
 * driver.mjs for the module-resolution reason in that file's header.
 *
 * Two things that cost time to find, so they are written down:
 *  - HEADLESS Chromium DOWNLOADS a PDF instead of rendering it — the viewer is a plugin that
 *    headless does not load. Real Chrome (`channel: "chrome"`) has it.
 *  - `PageDown` does nothing: the key goes to the page, not to the viewer's embedded document, so
 *    every screenshot came back as page 1. The `#page=N` fragment works — but ONLY on a fresh load
 *    of the URL, and changing just the fragment is not a fresh load, so it silently kept showing
 *    page 1 too. Hence the `about:blank` between pages.
 *
 *   node .claude/skills/run-timesphere/pdf-shot.mjs <file.pdf> <out-prefix> [pages]
 */
import { chromium } from "@playwright/test";
import path from "node:path";
import { mkdirSync } from "node:fs";

const [file, prefix = "pdf", pages = "2"] = process.argv.slice(2);
if (!file) {
  console.error("usage: pdf-shot.mjs <file.pdf> <out-prefix> [pages]");
  process.exit(1);
}

const OUT = process.env.TS_OUT ?? "test-results/run-shots";
mkdirSync(OUT, { recursive: true });

let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
} catch {
  browser = await chromium.launch({ headless: false });
}
const page = await browser.newPage({ viewport: { width: 1000, height: 1350 } });
const url = `file:///${path.resolve(file).replace(/\\/g, "/")}`;

for (let i = 1; i <= Number(pages); i++) {
  await page.goto("about:blank");
  await page.goto(`${url}#page=${i}&zoom=page-fit`, { waitUntil: "load" });
  await page.waitForTimeout(1800);
  const out = path.join(OUT, `${prefix}-p${i}.png`);
  // Crop past the viewer's toolbar and thumbnail rail — they are 40% of the frame and none of the
  // document. What is being checked is the page.
  await page.screenshot({ path: out, clip: { x: 260, y: 56, width: 740, height: 1280 } });
  console.log(out);
}

await browser.close();
