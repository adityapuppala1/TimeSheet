/**
 * Builds a real .pptx of the pitch deck.
 *
 * A REAL POWERPOINT, not an HTML file renamed. `pptxgenjs` writes actual OOXML, so every slide
 * opens editable in PowerPoint, Keynote and Google Slides — someone can fix a number in the room
 * without coming back to a developer, which is the only reason a PPTX is worth generating at all
 * when an HTML deck already exists.
 *
 * WHAT IS DELIBERATELY NOT ATTEMPTED: the web deck's animations, the three.js backdrop and the
 * live sliders on the market slide. A slide deck is a static medium, so the market slide ships as
 * the numbers plus their sources and a printed note that the assumptions are adjustable in the web
 * version. Faking interactivity with a screenshot of a slider would be worse than saying so.
 *
 * LAYOUT IS 16:9 (LAYOUT_16x9 = 10in × 5.625in). Every coordinate below is inches; the constants at
 * the top are the margins so a nudge is one edit rather than forty.
 *
 * Run: node scripts/pitch-export/build-pptx.mjs
 * Out: dist-pitch/timesphere-pitch.pptx
 */
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import PptxGenJS from "pptxgenjs";
import { ASK, DECK, GALLERY, MARKET, SLIDES, TEAM } from "./content.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const IMAGES = path.join(ROOT, "apps/web/public/product");
const OUT_DIR = path.join(ROOT, "dist-pitch");

const W = 10;
const H = 5.625;
const M = 0.55;

const INK = "E8EEF8";
const MUTED = "93A4BF";
const BG = "0B1220";
const PANEL = "111A2B";
const PRIMARY = "14B8C4";
const OK = "22C55E";
const WARN = "F59E0B";

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_16x9";
pptx.author = "TimeSphere";
pptx.company = "TimeSphere";
pptx.title = "TimeSphere — Pitch";

/** Every slide starts the same way, so the deck reads as one document rather than twelve. */
function newSlide(number, label) {
  const s = pptx.addSlide();
  s.background = { color: BG };
  if (number != null) {
    s.addText(
      [
        { text: String(number).padStart(2, "0"), options: { color: PRIMARY, bold: true } },
        { text: `   ${label.toUpperCase()}`, options: { color: MUTED, bold: true } }
      ],
      { x: M, y: 0.32, w: W - M * 2, h: 0.3, fontSize: 10, charSpacing: 2 }
    );
  }
  // A hairline under the eyebrow, doing the job the web deck's border does.
  s.addShape(pptx.ShapeType.rect, { x: M, y: 0.68, w: W - M * 2, h: 0.012, fill: { color: "22304A" }, line: { color: "22304A" } });
  return s;
}

const title = (s, text, y = 0.85) =>
  s.addText(text, { x: M, y, w: W - M * 2, h: 0.72, fontSize: 26, bold: true, color: INK, valign: "top" });

/** Bullets as a heading plus a body line, which is how every point in this deck is written. */
function bullets(s, items, { x = M, y = 1.7, w = W - M * 2, max = 6, size = 11 } = {}) {
  const rows = items.slice(0, max);
  const gap = Math.min(0.62, (H - y - 0.45) / Math.max(rows.length, 1));
  rows.forEach(([head, body], i) => {
    const top = y + i * gap;
    s.addShape(pptx.ShapeType.rect, { x, y: top + 0.04, w: 0.028, h: gap - 0.14, fill: { color: PRIMARY }, line: { color: PRIMARY } });
    s.addText(
      [
        { text: `${head}\n`, options: { bold: true, color: INK, fontSize: size + 1 } },
        { text: body, options: { color: MUTED, fontSize: size - 0.5 } }
      ],
      { x: x + 0.14, y: top, w: w - 0.14, h: gap - 0.06, valign: "top", lineSpacingMultiple: 0.92 }
    );
  });
}

const logo = (name) => {
  const full = path.join(HERE, "assets", `${name}.png`);
  if (!existsSync(full)) throw new Error(`Missing ${full} — run scripts/pitch-export/make-logo.mjs first`);
  return full;
};

const shot = (file) => {
  const full = path.join(IMAGES, file);
  if (!existsSync(full)) throw new Error(`Missing screenshot: ${full}`);
  return full;
};

/* ── Cover ──────────────────────────────────────────────────────────────────────────────────── */
{
  const s = pptx.addSlide();
  s.background = { color: BG };
  // The lockup, PNG at 4x density. 5160x1320 source → 2.6in wide keeps it crisp on a projector.
  s.addImage({ path: logo("logo-on-dark"), x: M, y: 0.45, w: 2.6, h: 0.665 });
  s.addText(DECK.tagline.toUpperCase(), { x: M, y: 1.25, w: W - M * 2, h: 0.3, fontSize: 11, bold: true, color: PRIMARY, charSpacing: 2 });
  s.addText(
    [
      { text: "The work happened. ", options: { color: INK } },
      { text: "Prove it.", options: { color: PRIMARY } }
    ],
    { x: M, y: 1.62, w: W - M * 2, h: 0.9, fontSize: 38, bold: true }
  );
  s.addText(DECK.standfirst, { x: M, y: 2.58, w: 8.2, h: 1.0, fontSize: 11.5, color: MUTED, lineSpacingMultiple: 1.15 });
  DECK.pillars.forEach(([t, b], i) => {
    const x = M + i * 3.02;
    s.addShape(pptx.ShapeType.roundRect, { x, y: 3.75, w: 2.85, h: 1.15, fill: { color: PANEL }, line: { color: "22304A" }, rectRadius: 0.06 });
    s.addText([{ text: `${t}\n`, options: { bold: true, fontSize: 11.5, color: INK } }, { text: b, options: { fontSize: 9.5, color: MUTED } }], {
      x: x + 0.16,
      y: 3.9,
      w: 2.55,
      h: 0.9,
      valign: "top",
      lineSpacingMultiple: 0.92
    });
  });
}

/* ── Content slides ─────────────────────────────────────────────────────────────────────────── */
SLIDES.forEach((slide, index) => {
  if (slide.kind === "cover") return;
  const n = index + 1;

  if (slide.kind === "close") {
    const s = newSlide(n, slide.label);
    s.addText(slide.title, { x: M, y: 1.9, w: W - M * 2, h: 1.2, fontSize: 28, bold: true, color: INK });
    s.addText(slide.body, { x: M, y: 3.1, w: 8.4, h: 0.9, fontSize: 13, color: MUTED, lineSpacingMultiple: 1.2 });
    return;
  }

  if (slide.kind === "market") {
    const s = newSlide(n, slide.label);
    title(s, slide.title);
    s.addText([{ text: "SOURCED", options: { color: OK, bold: true, fontSize: 9 } }], { x: M, y: 1.6, w: 1.2, h: 0.22 });
    s.addTable(
      [
        [
          { text: "Category", options: { bold: true, color: MUTED, fontSize: 9 } },
          { text: "2025 estimate", options: { bold: true, color: MUTED, fontSize: 9 } },
          { text: "CAGR", options: { bold: true, color: MUTED, fontSize: 9 } }
        ],
        ...MARKET.categories.map((c) => [
          { text: `${c.name}\n${c.sources}`, options: { color: INK, fontSize: 9 } },
          { text: c.range, options: { color: INK, bold: true, fontSize: 9 } },
          { text: c.cagr, options: { color: MUTED, fontSize: 9 } }
        ])
      ],
      { x: M, y: 1.85, w: 5.1, colW: [3.1, 1.25, 0.75], border: { pt: 0.5, color: "22304A" }, fill: { color: PANEL } }
    );
    s.addText([{ text: "ASSUMPTION — adjustable in the web deck", options: { color: WARN, bold: true, fontSize: 9 } }], {
      x: 5.9,
      y: 1.6,
      w: 3.6,
      h: 0.22
    });
    bullets(
      s,
      MARKET.assumptions.map(([l, v, h]) => [`${l} — ${v}`, h]),
      { x: 5.9, y: 1.85, w: 3.55, max: 4, size: 9.5 }
    );
    s.addText(MARKET.arithmetic.join("\n"), {
      x: M,
      y: 3.95,
      w: 5.1,
      h: 0.7,
      fontSize: 9,
      color: INK,
      fontFace: "Consolas",
      lineSpacingMultiple: 1.1
    });
    s.addText(MARKET.caveat, { x: M, y: 4.7, w: 8.9, h: 0.6, fontSize: 8, color: MUTED, lineSpacingMultiple: 1.05 });
    return;
  }

  if (slide.kind === "ask") {
    const s = newSlide(n, slide.label);
    title(s, slide.title);
    s.addText(
      [
        { text: `Raising ${ASK.amount} for ${ASK.equity}`, options: { bold: true, color: INK, fontSize: 13 } },
        { text: `  —  implied ${ASK.impliedPost}`, options: { color: MUTED, fontSize: 12 } }
      ],
      { x: M, y: 1.5, w: W - M * 2, h: 0.3 }
    );

    /* NATIVE charts, not screenshots of charts — the whole reason this file exists is that a
       partner can double-click and fix a number in the room. */
    s.addChart(pptx.ChartType.doughnut, [{ name: "Use of funds", labels: ASK.useOfFunds.map((u) => `${u.label} ${u.pct}%`), values: ASK.useOfFunds.map((u) => u.pct) }], {
      x: 5.35, y: 1.85, w: 4.1, h: 2.35,
      holeSize: 62,
      showLegend: true, legendPos: "r", legendColor: MUTED, legendFontSize: 8.5,
      chartColors: ["14B8C4", "3B82F6", "8B5CF6", "F59E0B", "64748B"],
      dataLabelColor: "FFFFFF", showValue: false,
      title: "Use of funds", showTitle: true, titleColor: INK, titleFontSize: 11
    });

    s.addChart(pptx.ChartType.bar, [{ name: "Post-money $M", labels: ASK.sensitivity.map((r) => r.equity), values: ASK.sensitivity.map((r) => r.post) }], {
      x: M, y: 1.85, w: 4.55, h: 2.0,
      barDir: "bar",
      chartColors: ["14B8C4"],
      catAxisLabelColor: MUTED, valAxisLabelColor: MUTED, catAxisLabelFontSize: 9, valAxisLabelFontSize: 8,
      showValue: true, dataLabelColor: INK, dataLabelFontSize: 8.5, dataLabelFormatCode: "$#,##0.0,,\"M\"",
      valGridLine: { style: "none" },
      title: "The same $1M at different dilution (post-money)", showTitle: true, titleColor: INK, titleFontSize: 11
    });

    s.addTable(
      [
        [
          { text: "Market benchmark", options: { bold: true, color: MUTED, fontSize: 8.5 } },
          { text: "Value", options: { bold: true, color: MUTED, fontSize: 8.5 } }
        ],
        ...ASK.context.map((c) => [
          { text: `${c[0]}  (${c[2]})`, options: { color: INK, fontSize: 8.5 } },
          { text: c[1], options: { color: INK, bold: true, fontSize: 8.5 } }
        ])
      ],
      { x: M, y: 4.0, w: 4.55, colW: [3.2, 1.35], border: { pt: 0.5, color: "22304A" }, fill: { color: PANEL } }
    );
    s.addText(ASK.contextNote, { x: 5.35, y: 4.28, w: 4.1, h: 1.1, fontSize: 8, color: MUTED, lineSpacingMultiple: 1.05 });
    return;
  }

  if (slide.kind === "team") {
    const s = newSlide(n, slide.label);
    title(s, slide.title);
    s.addText("Every box is an editable placeholder — put real names in before this deck leaves the building.", {
      x: M, y: 1.5, w: W - M * 2, h: 0.3, fontSize: 10.5, color: MUTED, italic: true
    });
    TEAM.forEach((t, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = M + col * 3.04;
      const y = 2.0 + row * 1.62;
      s.addShape(pptx.ShapeType.roundRect, { x, y, w: 2.85, h: 1.45, fill: { color: PANEL }, line: { color: "22304A" }, rectRadius: 0.05 });
      s.addShape(pptx.ShapeType.ellipse, { x: x + 0.18, y: y + 0.18, w: 0.5, h: 0.5, fill: { color: "153B41" }, line: { color: PRIMARY, dashType: "dash" } });
      s.addText("+", { x: x + 0.18, y: y + 0.18, w: 0.5, h: 0.5, align: "center", fontSize: 18, bold: true, color: PRIMARY });
      s.addText(
        [
          { text: `${t.name}
`, options: { bold: true, fontSize: 11, color: INK } },
          { text: `${t.role}
`, options: { fontSize: 9, color: PRIMARY } },
          { text: t.note, options: { fontSize: 8, color: MUTED } }
        ],
        { x: x + 0.78, y: y + 0.14, w: 2.0, h: 1.25, valign: "top", lineSpacingMultiple: 1.0 }
      );
    });
    return;
  }

  const s = newSlide(n, slide.label);
  title(s, slide.title);
  if (slide.image) {
    // Text left, screenshot right. The image is sized by WIDTH with `sizing: contain` so a shot of
    // a different aspect ratio letterboxes rather than stretching — a squashed product screenshot
    // is the kind of detail that reads as carelessness in a deck.
    bullets(s, slide.points ?? [], { w: 5.0, max: 5 });
    s.addImage({ path: shot(slide.image), x: 5.75, y: 1.7, w: 3.7, h: 2.9, sizing: { type: "contain", w: 3.7, h: 2.9 } });
    if (slide.imageCaption) {
      s.addText(slide.imageCaption, { x: 5.75, y: 4.62, w: 3.7, h: 0.35, fontSize: 8.5, color: MUTED });
    }
  } else {
    bullets(s, slide.points ?? [], { max: 6 });
  }
});

/* ── The screens ────────────────────────────────────────────────────────────────────────────── */
{
  // Four slides of three shots each: twelve on one slide is unreadable projected, and one per slide
  // is twelve slides nobody reaches the end of.
  for (let page = 0; page < 4; page++) {
    const group = GALLERY.slice(page * 3, page * 3 + 3);
    if (!group.length) continue;
    const s = newSlide(SLIDES.length + 1 + page, `The product · ${page + 1} of 4`);
    title(s, page === 0 ? "Twelve screens, captured from the running application" : "Twelve screens, continued");
    group.forEach(([file, caption], i) => {
      const x = M + i * 3.05;
      s.addImage({ path: shot(file), x, y: 1.75, w: 2.85, h: 2.1, sizing: { type: "contain", w: 2.85, h: 2.1 } });
      s.addText(caption, { x, y: 3.95, w: 2.85, h: 0.6, fontSize: 8.5, color: MUTED, lineSpacingMultiple: 0.95 });
    });
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, "timesphere-pitch.pptx");
await pptx.writeFile({ fileName: out });
console.log(`PPTX deck: ${out}`);
