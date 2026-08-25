/**
 * Reproduces the CI condition that broke every Firefox e2e test: a browser with NO WebGL.
 *
 * CI runners have no GPU, and the app's route-level Suspense fallback (components/ui/app-loader
 * .tsx) draws a WebGL animation. When that failed under headless Firefox the fallback took the
 * whole render down with it, so `/login` never painted an Email field and all 30-odd Firefox tests
 * timed out at `page.goto("/login")` — a browser-wide failure that looked like a dozen unrelated
 * feature bugs.
 *
 * `webgl.disabled` is the honest local stand-in for "no GPU": it makes every WebGL context request
 * fail, which is the worst case the loader has to survive. The assertion is simply that the login
 * form renders anyway.
 *
 * Run:  node .claude/skills/run-timesphere/probe-nowebgl.mjs
 */
import { firefox } from "@playwright/test";

const WEB = process.env.TS_WEB || "https://localhost:5173";

const browser = await firefox.launch({
  firefoxUserPrefs: {
    "webgl.disabled": true,
    "webgl.force-enabled": false,
    "layers.acceleration.disabled": true
  }
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});

let ok = false;
let detail = "";
try {
  await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
  // The exact locator the failing CI tests waited on.
  await page.getByLabel("Email", { exact: true }).waitFor({ timeout: 15_000 });
  ok = true;
} catch (e) {
  detail = String(e).split("\n")[0];
}

const webglAvailable = await page.evaluate(() => {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
});

console.log("webgl available in this browser:", webglAvailable, "(false = CI condition reproduced)");
console.log(ok ? "PASS — /login rendered its Email field without WebGL" : `FAIL — ${detail}`);
console.log(errors.length ? `page errors:\n  ${errors.slice(0, 6).join("\n  ")}` : "page errors: none");

await browser.close();
process.exit(ok ? 0 : 1);
