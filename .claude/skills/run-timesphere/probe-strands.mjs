/**
 * Verifies the Strands loader actually renders, rather than merely compiling.
 *
 * Mounts components/ui/app-loader.tsx into the running Vite dev server's own module graph (so the
 * real source is used, not a copy), then SCREENSHOTS it. The screenshot is the assertion: a shader
 * that fails to compile draws nothing, and a blank box is obvious in the PNG.
 *
 * Deliberately not `gl.readPixels`: without `preserveDrawingBuffer` the backbuffer is cleared once
 * the frame is composited, so reading it from outside the render loop reports an empty canvas for
 * a perfectly working effect. That false negative cost real time once already.
 *
 * Run:  node .claude/skills/run-timesphere/probe-strands.mjs [dark|light]
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { chromium } from "@playwright/test";

const WEB = process.env.TS_WEB || "https://localhost:5173";
const theme = process.argv[2] === "dark" ? "dark" : "light";

const browser = await chromium.launch();
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 560 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.text().includes("[strands]")) errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });

const mounted = await page.evaluate(async (wantDark) => {
  document.documentElement.classList.toggle("dark", wantDark);
  document.body.style.margin = "0";

  const host = document.createElement("div");
  host.id = "probe-host";
  host.style.cssText = "position:fixed;inset:0;";
  document.body.appendChild(host);

  const [React, ReactDOM, mod] = await Promise.all([
    // Vite's pre-bundled dep URLs: a bare "react" specifier does not resolve in a browser.
    import("/node_modules/.vite/deps/react.js"),
    import("/node_modules/.vite/deps/react-dom_client.js"),
    import("/src/components/ui/app-loader.tsx")
  ]);

  const createRoot = ReactDOM.createRoot ?? ReactDOM.default?.createRoot;
  const createElement = React.createElement ?? React.default?.createElement;
  createRoot(host).render(createElement(mod.AppLoader, { label: "Loading TimeSphere…", variant: "screen" }));

  await new Promise((r) => setTimeout(r, 1200));

  const canvas = host.querySelector("canvas");
  const gl = canvas?.getContext("webgl2");
  return {
    canvasMounted: Boolean(canvas),
    size: canvas ? `${canvas.width}x${canvas.height}` : null,
    contextLost: gl ? gl.isContextLost() : null,
    text: host.innerText.trim()
  };
}, theme === "dark");

mkdirSync("test-results/run-shots", { recursive: true });
const out = `test-results/run-shots/strands-${theme}.png`;
writeFileSync(out, await page.screenshot());

console.log(`theme: ${theme}`);
console.log(JSON.stringify(mounted, null, 2));
console.log("screenshot:", out);
console.log(errors.length ? `console errors:\n  ${errors.join("\n  ")}` : "console errors: none");

await browser.close();
