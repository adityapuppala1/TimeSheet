/**
 * Builds a single self-contained HTML file of the pitch deck.
 *
 * SELF-CONTAINED IS THE WHOLE POINT. This file gets emailed, dropped in a data room, and opened
 * from a downloads folder with no server and often no network. So every screenshot is inlined as a
 * data URI and there is not one external request in the output — no CDN, no web font, no image
 * path. It is ~2.5 MB and opens from a USB stick, which is the correct trade for a document whose
 * failure mode is a row of broken-image icons in front of an investor.
 *
 * IT IS ALSO A PRINT TARGET. The @media print rules put one slide per page with backgrounds intact,
 * so "save as PDF" from the browser produces the same deck. That is deliberately how a PDF is made
 * here rather than adding a third generator to maintain.
 *
 * Run: node scripts/pitch-export/build-html.mjs
 * Out: dist-pitch/timesphere-pitch.html
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DECK, SLIDES, MARKET, GALLERY } from "./content.mjs";

// fileURLToPath, not a string edit on the href: stripping "file:///" yields "C:/x/y" on Windows and
// "home/runner/x" on Linux, where the leading slash IS the root. That bug has shipped in this repo
// before — see the note in tests/unit/ask-ai-chat.test.ts.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const IMAGES = path.join(ROOT, "apps/web/public/product");
const OUT_DIR = path.join(ROOT, "dist-pitch");

const dataUri = (file) => {
  const full = path.join(IMAGES, file);
  if (!existsSync(full)) throw new Error(`Missing screenshot: ${full}`);
  return `data:image/png;base64,${readFileSync(full).toString("base64")}`;
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const points = (list) =>
  `<ul class="points">${list
    .map(([t, b]) => `<li><strong>${esc(t)}</strong><span>${esc(b)}</span></li>`)
    .join("")}</ul>`;

function slideHtml(slide, index) {
  const number = String(index + 1).padStart(2, "0");
  const head = `<p class="eyebrow"><span class="num">${number}</span>${esc(slide.label)}</p><h2>${esc(slide.title)}</h2>`;

  if (slide.kind === "cover") {
    return `<section class="slide cover" id="${slide.id}">
      <p class="badge">${esc(DECK.tagline)}</p>
      <h1>The work happened. <em>Prove it.</em></h1>
      <p class="lede">${esc(DECK.standfirst)}</p>
      <div class="pillars">${DECK.pillars
        .map(([t, b]) => `<div class="pillar"><strong>${esc(t)}</strong><span>${esc(b)}</span></div>`)
        .join("")}</div>
    </section>`;
  }

  if (slide.kind === "close") {
    return `<section class="slide close" id="${slide.id}">${head}<p class="lede">${esc(slide.body)}</p></section>`;
  }

  if (slide.kind === "market") {
    return `<section class="slide" id="${slide.id}">${head}
      <div class="market">
        <div>
          <h3>What makes up the TAM <span class="tag sourced">Sourced</span></h3>
          <table>
            <thead><tr><th>Category</th><th>2025 estimate</th><th>CAGR</th></tr></thead>
            <tbody>${MARKET.categories
              .map((c) => `<tr><td>${esc(c.name)}<br><small>${esc(c.sources)}</small></td><td class="num-cell">${esc(c.range)}</td><td class="num-cell">${esc(c.cagr)}</td></tr>`)
              .join("")}</tbody>
          </table>
          <p class="caveat">${esc(MARKET.caveat)}</p>
        </div>
        <div>
          <h3>Our assumptions <span class="tag assumption">Assumption</span></h3>
          <ul class="points">${MARKET.assumptions
            .map(([l, v, h]) => `<li><strong>${esc(l)} — ${esc(v)}</strong><span>${esc(h)}</span></li>`)
            .join("")}</ul>
          <div class="arith">${MARKET.arithmetic.map((line) => `<code>${esc(line)}</code>`).join("")}</div>
        </div>
      </div>
    </section>`;
  }

  const figure = slide.image
    ? `<figure><img src="${dataUri(slide.image)}" alt="${esc(slide.imageCaption ?? slide.title)}"><figcaption>${esc(slide.imageCaption ?? "")}</figcaption></figure>`
    : "";

  return `<section class="slide" id="${slide.id}">${head}
    <div class="${slide.image ? "split" : ""}">
      <div>${points(slide.points ?? [])}</div>
      ${figure}
    </div>
  </section>`;
}

const galleryHtml = `<section class="slide" id="gallery">
  <p class="eyebrow"><span class="num">${String(SLIDES.length + 1).padStart(2, "0")}</span>The product</p>
  <h2>Twelve screens, captured from the running application</h2>
  <div class="gallery">${GALLERY.map(
    ([file, caption]) => `<figure><img src="${dataUri(file)}" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption></figure>`
  ).join("")}</div>
</section>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(DECK.title)} — Pitch</title>
<style>
  /* Dark by default: the deck is presented far more often than it is printed, and the print rules
     below flip it to ink-on-white so a browser "save as PDF" is not a page of black toner. */
  :root {
    --bg: #0b1220; --panel: #111a2b; --line: #22304a; --ink: #e8eef8; --muted: #93a4bf;
    --primary: #14b8c4; --info: #3b82f6; --ok: #22c55e; --warn: #f59e0b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.65 -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 28px; }
  nav.toc {
    position: sticky; top: 0; z-index: 5; background: rgba(11,18,32,.92);
    backdrop-filter: blur(10px); border-bottom: 1px solid var(--line);
  }
  nav.toc ul { display: flex; gap: 6px; overflow-x: auto; list-style: none; margin: 0; padding: 10px 28px; max-width: 1080px; margin-inline: auto; }
  nav.toc a { white-space: nowrap; text-decoration: none; color: var(--muted); font-size: 12px; font-weight: 700; padding: 5px 11px; border-radius: 99px; border: 1px solid transparent; }
  nav.toc a:hover { color: var(--ink); border-color: var(--line); }
  .slide { padding: 64px 0; border-bottom: 1px solid var(--line); }
  .slide:last-child { border-bottom: 0; }
  .eyebrow { display: flex; align-items: center; gap: 12px; text-transform: uppercase; letter-spacing: .18em; font-size: 11px; font-weight: 800; color: var(--muted); margin: 0 0 10px; }
  .num { color: var(--primary); }
  h1 { font-size: clamp(30px, 5vw, 52px); line-height: 1.08; letter-spacing: -.02em; margin: 14px 0 0; font-weight: 900; }
  h1 em { font-style: normal; background: linear-gradient(90deg, var(--primary), var(--info)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  h2 { font-size: clamp(22px, 3.2vw, 34px); line-height: 1.2; letter-spacing: -.015em; margin: 0 0 20px; font-weight: 900; }
  h3 { font-size: 15px; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
  .badge { display: inline-block; font-size: 12px; font-weight: 700; color: var(--info); background: rgba(59,130,246,.12); border: 1px solid rgba(59,130,246,.3); border-radius: 99px; padding: 5px 12px; margin: 0; }
  .lede { color: var(--muted); font-size: 17px; line-height: 1.8; max-width: 68ch; margin: 18px 0 0; }
  .pillars { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); margin-top: 30px; }
  .pillar { border: 1px solid var(--line); background: var(--panel); border-radius: 12px; padding: 16px; }
  .pillar strong { display: block; font-size: 14px; }
  .pillar span { display: block; color: var(--muted); font-size: 13px; margin-top: 5px; line-height: 1.6; }
  .split { display: grid; gap: 34px; grid-template-columns: 1fr; }
  @media (min-width: 900px) { .split { grid-template-columns: 1fr 1.15fr; align-items: center; } }
  ul.points { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
  ul.points li { border-left: 2px solid var(--primary); padding-left: 14px; }
  ul.points strong { display: block; font-size: 15px; }
  ul.points span { display: block; color: var(--muted); font-size: 14px; margin-top: 4px; line-height: 1.7; }
  figure { margin: 0; }
  figure img { width: 100%; display: block; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
  figcaption { color: var(--muted); font-size: 12px; margin-top: 8px; }
  .market { display: grid; gap: 30px; grid-template-columns: 1fr; }
  @media (min-width: 900px) { .market { grid-template-columns: 1fr 1fr; } }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); text-transform: uppercase; letter-spacing: .08em; font-size: 10px; }
  td small { color: var(--muted); font-size: 11px; }
  .num-cell { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 700; }
  .tag { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; padding: 3px 8px; border-radius: 99px; }
  .tag.sourced { color: var(--ok); background: rgba(34,197,94,.12); border: 1px solid rgba(34,197,94,.3); }
  .tag.assumption { color: var(--warn); background: rgba(245,158,11,.12); border: 1px solid rgba(245,158,11,.3); }
  .caveat { color: var(--muted); font-size: 12px; line-height: 1.7; margin-top: 14px; }
  .arith { margin-top: 16px; display: grid; gap: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
  .arith code { font-size: 12px; color: var(--ink); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  .gallery { display: grid; gap: 22px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  footer { color: var(--muted); font-size: 12px; padding: 34px 0 60px; }

  @media print {
    /* One slide per sheet, in ink rather than in toner. */
    :root { --bg: #fff; --panel: #f6f8fb; --line: #d6deea; --ink: #0b1220; --muted: #4a5a75; }
    body { background: #fff; }
    nav.toc { display: none; }
    .slide { break-after: page; border-bottom: 0; padding: 26px 0; }
    .slide:last-child { break-after: auto; }
    figure img { break-inside: avoid; }
    h1 em { color: #0f766e; -webkit-text-fill-color: #0f766e; }
    @page { size: A4 landscape; margin: 14mm; }
  }
</style>
</head>
<body>
<nav class="toc"><ul>${SLIDES.map((s, i) => `<li><a href="#${s.id}"><span class="num">${String(i + 1).padStart(2, "0")}</span> ${esc(s.label)}</a></li>`).join("")}<li><a href="#gallery">Screens</a></li></ul></nav>
<div class="wrap">
${SLIDES.map(slideHtml).join("\n")}
${galleryHtml}
<footer>${esc(DECK.title)} — generated from the live pitch deck. Market figures carry their sources; the four sizing assumptions are ours and are labelled as such.</footer>
</div>
</body>
</html>`;

mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, "timesphere-pitch.html");
writeFileSync(out, html, "utf8");
console.log(`HTML deck: ${out} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB, ${SLIDES.length + 1} sections, 0 external requests)`);
