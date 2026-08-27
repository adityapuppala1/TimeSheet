/**
 * Captures the product screenshots used by the public marketing pages (Landing, PitchDeck).
 *
 * WHY this is a Playwright spec rather than someone taking screenshots by hand: marketing shots go
 * stale silently. A hand-taken PNG of a screen that has since been redesigned keeps selling a
 * product that no longer exists, and nobody notices until a prospect does. Re-running this
 * regenerates every image from the app as it actually is today.
 *
 * SKIPPED BY DEFAULT — it writes files into apps/web/public and adds ~30s, neither of which
 * belongs in a normal test run. To refresh the images:
 *
 *   CAPTURE_SCREENSHOTS=1 npx playwright test screenshots --project=desktop
 *
 * It also fails on console errors while it walks the app, so a refresh doubles as a smoke test of
 * every major screen.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ENABLED = Boolean(process.env.CAPTURE_SCREENSHOTS);
const OUT_DIR = path.join("apps", "web", "public", "product");
/** Matches how the images are actually laid out: full-bleed hero, ~2/3 column in the tour, and a
 *  phone. Anything finer just multiplies files for bytes nobody notices. */
const VARIANT_WIDTHS = [1280, 800, 480];

test.use({ storageState: "tests/e2e/.auth/superadmin-settings.json" });
test.describe.configure({ mode: "serial" });

/** Screens worth showing a prospect, in the order the marketing pages use them. */
const SHOTS: { slug: string; url: string; label: string; focus?: string; tab?: string; press?: string }[] = [
  { slug: "dashboard", url: "/app", label: "Dashboard" },
  { slug: "tickets", url: "/app/tickets", label: "Tickets" },
  { slug: "insights", url: "/app/insights", label: "Insights" },
  { slug: "timesheet", url: "/app/timesheet", label: "Timesheet" },
  { slug: "security", url: "/app/security-insights", label: "Security insights" },
  // `tab` clicks into a settings tab before capturing. Without it this shot was the settings
  // page's DEFAULT tab (Reminders & schedule) published under an "AI controls" heading — the
  // exact silent drift this spec exists to prevent.
  { slug: "settings-ai", url: "/app/settings", label: "AI settings", tab: "AI" },
  // The V8 surfaces the marketing pages now show. The Studio is captured from the top on
  // purpose: the first card's quoted activation errors are the activation gate doing its job,
  // which is exactly the claim the marketing copy makes about it.
  { slug: "goals", url: "/app/goals", label: "Goals" },
  { slug: "agents", url: "/app/agents", label: "AI teammates" },
  { slug: "studio", url: "/app/studio", label: "Workflow Studio" },
  // The V10 surfaces. All three are captured as the super admin the rest of this spec signs in as:
  // the practice update is SUPER_ADMIN-only by route, and the other two are simply richer with an
  // admin's visibility — a screenshot of an empty-for-this-role page sells nothing.
  // `press` because this page holds no saved draft — the update is generated on demand into
  // component state. Captured without it, the "screenshot" was an empty form with two date inputs,
  // which shows a prospect nothing about the one thing the feature does.
  {
    slug: "practice-update",
    url: "/app/practice-update",
    label: "Weekly practice update",
    press: "Generate update",
    // Past the recipient and period cards, to the counted figures and the initiative tables —
    // the half of the page that is the actual document.
    focus: "Tickets closed"
  },
  { slug: "requirements", url: "/app/requirements", label: "Requirements Studio" },
  { slug: "changes", url: "/app/changes", label: "Change management" }
];

test.describe("product screenshots", () => {
  test.skip(!ENABLED, "Set CAPTURE_SCREENSHOTS=1 to regenerate marketing images.");

  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  });

  /**
   * Writes the responsive WebP variants the marketing pages actually serve.
   *
   * WHY: a 390px phone was downloading and decoding the full 1920px PNG (~163KB for the hero) to
   * display it at ~350px wide, and every tour tab click pulled another full-size one — about 1MB
   * of screenshots on a page whose job is to load fast enough to be read. Screenshots are exactly
   * the content class where WebP wins big.
   *
   * The PNG stays as the `<img src>` fallback, so nothing breaks if a browser has no WebP support
   * and the assets remain viewable directly in the repo.
   */
  async function emitWebpVariants(pngPath: string, slug: string) {
    for (const width of VARIANT_WIDTHS) {
      await sharp(pngPath)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(path.join(OUT_DIR, `${slug}-${width}.webp`));
    }
  }

  for (const shot of SHOTS) {
    test(`capture ${shot.slug}`, async ({ page }) => {
      // Records the failing URL, not just "401" — a bare status tells you nothing about which
      // request broke, and the auth bootstraps 401 by design on every load (see below).
      const failed: string[] = [];
      page.on("response", (res) => {
        if (res.status() >= 400) failed.push(`${res.status()} ${new URL(res.url()).pathname}`);
      });
      const consoleErrors: string[] = [];
      page.on("pageerror", (err) => consoleErrors.push(err.message));

      // Light theme: a screenshot shrunk into a marketing card reads far better light-on-dark
      // than the reverse, and the app defaults to the OS preference which we can't rely on here.
      await page.addInitScript(() => window.localStorage.setItem("timesheet:theme", "light"));
      await page.goto(shot.url);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

      await page.waitForLoadState("networkidle");
      // A fixed wait, deliberately, and the one place in this suite where it's the right tool:
      // Recharts' entry animation exposes no completion event and no DOM state to synchronise on,
      // and the failure mode here is cosmetic (a half-drawn graph in a marketing image) rather
      // than a flaky assertion. Nothing is asserted against this delay.
      await page.waitForTimeout(1200); // NOSONAR — S2925: no observable end-of-animation signal exists.

      if (shot.tab) {
        const tab = page.getByRole("tab", { name: shot.tab, exact: true });
        await ((await tab.count()) ? tab : page.getByRole("button", { name: shot.tab, exact: true })).first().click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(600); // NOSONAR — S2925: same Recharts/entry-animation reasoning as above.
      }

      if (shot.press) {
        // Clicking a button and waiting for the RESULT, not for a fixed delay. The button relabels
        // itself while the work is in flight ("Generating…"), so waiting for its original name to
        // come back is a real completion signal rather than a guess at how long a model takes.
        //
        // The timeout is deliberately long: this is a live AI call against whatever provider the
        // workspace is configured with, and a local model on a loaded machine is minutes, not
        // seconds. This spec is opt-in and run by a person, so waiting is free; capturing a
        // half-rendered page is not.
        const trigger = page.getByRole("button", { name: shot.press, exact: true });
        await trigger.click();
        // Wait for the button to LEAVE the busy state, which means waiting for it to enter one
        // first. Asserting "enabled" straight after the click passed on the frame before React had
        // re-rendered the label, and the first capture of this page came out mid-generation with
        // the spinner still in shot. `press` therefore only works on a button that relabels while
        // it works — which is the app's convention for every long-running action.
        await expect(trigger, `${shot.press} should enter a busy state`).toBeHidden({ timeout: 30_000 });
        await expect(trigger, `${shot.press} should finish`).toBeVisible({ timeout: 300_000 });
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(1200); // NOSONAR — S2925: same Recharts/entry-animation reasoning as above.
      }

      if (shot.focus) {
        // Plain DOM scroll rather than a locator: the text also appears in run-history rows, and
        // Playwright's strict/stability checks have nothing useful to add to "scroll a card into
        // view for a photograph".
        await page.evaluate((needle) => {
          const all = Array.from(document.querySelectorAll("h1,h2,h3,h4,p,span,div"));
          const hit = all.find((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() === needle);
          if (hit) {
            // behavior:"instant" matters: the app sets CSS smooth scrolling, and the default
            // (smooth) animation would still be mid-flight when the screenshot is taken.
            hit.scrollIntoView({ block: "start", behavior: "instant" });
            // 100px back out gives headroom under the sticky bar without pulling the previous
            // card's tail into frame.
            document.scrollingElement?.scrollBy({ top: -100, behavior: "instant" });
          }
        }, shot.focus);
        await page.waitForTimeout(300); // NOSONAR — S2925: scroll settling has no completion event either.
      }

      // Optional, gitignored: tests/e2e/.screenshot-anonymise.json maps text that must never
      // appear in a public marketing image (real names, a real company identifier) to fictional
      // replacements. The file stays out of the repo on purpose — committing a list of real
      // employee names to anonymise would itself publish the thing it exists to hide. When the
      // file is absent this is a no-op, so CI and fresh checkouts capture unmodified.
      const anonPath = path.join("tests", "e2e", ".screenshot-anonymise.json");
      if (fs.existsSync(anonPath)) {
        const map: Record<string, string> = JSON.parse(fs.readFileSync(anonPath, "utf8"));
        await page.evaluate((entries) => {
          const swap = (text: string) => {
            let out = text;
            for (const [find, replace] of entries) out = out.split(find).join(replace);
            return out;
          };

          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = swap(node.nodeValue ?? "");
            if (text !== node.nodeValue) node.nodeValue = text;
          }

          // FORM VALUES TOO. A TreeWalker sees the text nodes inside a <textarea>, which are its
          // DEFAULT value — React sets the live one as a property, so everything a user (or a
          // model) typed was invisible to the pass above. That is not a theoretical gap: the first
          // capture of the practice update anonymised a real company name in the table above the
          // editor and published it verbatim in the AI-drafted paragraph below it.
          //
          // Writing `.value` directly is safe HERE and nowhere else: this is the last step before a
          // photograph, and React only overwrites it on a re-render this page will not do.
          for (const field of Array.from(document.querySelectorAll("input, textarea"))) {
            const el = field as HTMLInputElement | HTMLTextAreaElement;
            const next = swap(el.value);
            if (next !== el.value) el.value = next;
            const placeholder = swap(el.placeholder ?? "");
            if (placeholder !== el.placeholder) el.placeholder = placeholder;
          }
        }, Object.entries(map));
      }

      const png = path.join(OUT_DIR, `${shot.slug}.png`);
      await page.screenshot({ path: png, fullPage: false });
      await emitWebpVariants(png, shot.slug);

      // Uncaught exceptions only — this is what makes a refresh double as a smoke test.
      expect(consoleErrors, `page errors on ${shot.url}`).toEqual([]);

      // The platform-admin session probe 401s on every tenant page by design (App.tsx's
      // PlatformAdminAuthBootstrap — "not logged in" is the expected path, not an error).
      // Anything ELSE failing is a real problem worth failing the capture over.
      const unexpected = failed.filter((f) => !f.includes("/platform-admin/auth/"));
      expect(unexpected, `failed requests on ${shot.url}`).toEqual([]);
    });
  }

  // A dark-mode capture used to live here "for the hero", but nothing ever referenced the file —
  // 152KB of generated asset shipped to every visitor's origin and ~5s added to each refresh, for
  // an image no page rendered. Removed rather than left as a plausible-looking artefact. If a
  // dark hero is wanted later, add it here AND to Landing.tsx's <picture>, and to PRODUCT_IMAGES
  // in marketing.spec.ts so something asserts it is actually served.
});
