/**
 * The public marketing surface: landing page, pitch deck, and the split sign-in screen.
 *
 * WHY these need tests at all — they have no business logic, so the instinct is to skip them. But
 * they are the only pages an unauthenticated visitor ever sees, and they break in ways the app
 * pages don't: a screenshot filename typo renders a broken image with no error, an anchor link
 * lands under the sticky nav, and a marketing page is exactly where an overflow bug ships
 * unnoticed because nobody on the team opens `/` after logging in once.
 *
 * Runs unauthenticated on purpose — no storageState — because that's the visitor these pages are
 * for, and it also proves they don't quietly depend on a session.
 */
import { test, expect } from "@playwright/test";

/** Every product image the marketing pages reference. A 404 here is invisible to the eye at a
 *  glance but obvious to a prospect. */
const PRODUCT_IMAGES = [
  "/product/dashboard.png",
  "/product/tickets.png",
  "/product/insights.png",
  "/product/timesheet.png",
  "/product/security.png",
  "/product/settings-ai.png",
  "/product/goals.png",
  "/product/agents.png",
  "/product/studio.png"
];

test.describe("marketing pages", () => {
  test("the landing page renders, and every product screenshot actually loads", async ({ page }) => {
    const failed: string[] = [];
    page.on("response", (res) => {
      const path = new URL(res.url()).pathname;
      if (res.status() < 400) return;
      // Both session probes 401 for a signed-out visitor BY DESIGN — App.tsx's two auth bootstraps
      // ask the server whether a session exists, and "no" is the expected answer on a public page.
      // Nothing else is excused: /favicon.ico used to land here and fail the test for a reason
      // unrelated to anything it checks, and the fix was to ship a favicon, not to widen this list.
      if (path.includes("/auth/refresh") || path.includes("/auth/me")) return;
      failed.push(`${res.status()} ${path}`);
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/what actually happened/i);

    // The hero shot is above the fold and eager-loaded, so it must be decoded by now. Checking
    // naturalWidth rather than visibility catches the case that matters: the <img> is present and
    // laid out, but the file behind it 404'd.
    const hero = page.locator('img[src="/product/dashboard.png"]').first();
    await expect(hero).toBeVisible();
    expect(await hero.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    expect(failed, "no request on the landing page should fail").toEqual([]);
  });

  test("every product screenshot and its responsive variants exist on disk", async ({ request }) => {
    // Fetched directly rather than clicked through the tour: this asserts the ASSET exists,
    // independently of whether the UI happens to render it, so a rename fails loudly here.
    //
    // The .webp variants are checked too. A missing one is invisible in a browser — <picture>
    // silently falls back to the PNG — so without this the whole responsive-image path could rot
    // while every page still looked correct and only the bytes got worse.
    for (const png of PRODUCT_IMAGES) {
      const res = await request.get(png);
      expect(res.status(), `${png} should be served`).toBe(200);

      for (const width of [480, 800, 1280]) {
        const variant = png.replace(/\.png$/, `-${width}.webp`);
        expect((await request.get(variant)).status(), `${variant} should be served`).toBe(200);
      }
    }
  });

  test("the product tour swaps the screenshot when a tab is chosen", async ({ page }) => {
    await page.goto("/#tour");
    const insightsTab = page.getByRole("button", { name: "Insights", exact: true });
    await insightsTab.click();
    await expect(insightsTab).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('img[src="/product/insights.png"]')).toBeVisible();
  });

  test("the pricing comparison modal opens and closes", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /compare plans/i }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: /compare plans/i })).toBeVisible();
    // A row that only exists in the modal, proving the full table rendered rather than an empty shell.
    await expect(dialog.getByText(/dedicated database, never shared/i)).toBeVisible();

    // Two controls legitimately share the name "Close": Radix's icon button (absolutely positioned
    // top-right, label in an sr-only span) and the footer's explicit one. Excluding the positioned
    // one targets the footer button without depending on DOM order.
    await dialog.locator("button:not(.absolute)", { hasText: /^Close$/ }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // The icon button is the other way out, and it's the one keyboard users reach first.
    await page.getByRole("button", { name: /compare plans/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("the pitch deck renders end to end", async ({ page }) => {
    const failed: string[] = [];
    page.on("response", (res) => {
      const path = new URL(res.url()).pathname;
      if (res.status() < 400) return;
      // Both session probes 401 for a signed-out visitor BY DESIGN — App.tsx's two auth bootstraps
      // ask the server whether a session exists, and "no" is the expected answer on a public page.
      // Nothing else is excused: /favicon.ico used to land here and fail the test for a reason
      // unrelated to anything it checks, and the fix was to ship a favicon, not to widen this list.
      if (path.includes("/auth/refresh") || path.includes("/auth/me")) return;
      failed.push(`${res.status()} ${path}`);
    });

    await page.goto("/pitch");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Prove it/i);
    // The closing slide — if this is visible, every slide between rendered without throwing.
    await expect(page.getByRole("heading", { name: /whose AI you can prove is getting better/i })).toBeVisible();
    expect(failed, "no request on the pitch page should fail").toEqual([]);
  });

  test("the landing and pitch pages link to each other and to sign-in", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /read the full story/i }).click();
    await expect(page).toHaveURL(/\/pitch/);

    await page.getByRole("link", { name: /back to the product page/i }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole("link", { name: /^sign in$/i }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("the capability filter narrows the grid and can be cleared", async ({ page }) => {
    // The grid is the longest section on the page, so the filter is the only thing making it
    // navigable. It is also the one control here that changes what a visitor believes ships:
    // a chip that silently matches nothing would read as "that capability doesn't exist".
    await page.goto("/#features");
    // The route is lazy-loaded, so counting before the chunk resolves measures an empty document.
    const allChip = page.getByRole("button", { name: /^Everything/ });
    await expect(allChip).toBeVisible();

    // Every capability card titles itself with an h3; the section's own heading is an h2.
    const cards = page.locator("#features h3");
    const total = await cards.count();
    expect(total).toBeGreaterThan(10);

    const aiChip = page.getByRole("button", { name: /^AI, governed/ });
    await aiChip.click();
    await expect(aiChip).toHaveAttribute("aria-pressed", "true");
    const filtered = await cards.count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(total);

    await allChip.click();
    await expect(cards).toHaveCount(total);
  });

  test("the phone menu opens, navigates, and closes behind it", async ({ page }) => {
    // Below md the section links collapse into this menu, so without it a phone visitor has no
    // way to reach pricing except by scrolling the entire page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const toggle = page.getByRole("button", { name: /open the menu/i });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole("button", { name: /close the menu/i })).toBeVisible();

    await page.locator("#mobile-nav").getByRole("link", { name: "Pricing" }).click();
    await expect(page).toHaveURL(/#pricing/);
    // Choosing a destination has to dismiss the menu, or it covers the section just jumped to.
    await expect(page.getByRole("button", { name: /open the menu/i })).toBeVisible();
  });

  test("the pitch deck's slide rail jumps to a slide", async ({ page }) => {
    await page.goto("/pitch");
    await page.getByRole("navigation", { name: "Slides" }).getByRole("link", { name: /Revenue/ }).click();
    await expect(page).toHaveURL(/#revenue/);
    await expect(page.getByRole("heading", { name: /AI markup deliberately left on the table/i })).toBeInViewport();
  });

  test("sign-in shows the brand panel on desktop and hides it on a phone", async ({ page }) => {
    await page.goto("/login");
    // The form is what matters at any width, so it's asserted first and unconditionally.
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();

    const brandHeading = page.getByRole("heading", { name: /the hours, the tickets, and the proof/i });
    await expect(brandHeading).toBeVisible();

    // Below lg the decorative half must disappear entirely rather than stacking above the form
    // and pushing the email field off-screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(brandHeading).toBeHidden();
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  });

  test("no element overflows the viewport on the public pages at phone width", async ({ page }) => {
    // MEASURED PER ELEMENT, deliberately. The obvious version of this test —
    // `documentElement.scrollWidth - clientWidth` — CANNOT FAIL in this app: index.css sets
    // `overflow-x: clip` on both html and body, so the document has no horizontal scroll area and
    // the delta is always 0 no matter how far a child overflows. responsive.spec.ts documents the
    // same trap. A section that blows past 390px would be silently clipped and unreachable while
    // the page-level check stayed green.
    await page.setViewportSize({ width: 390, height: 844 });

    for (const path of ["/", "/pitch", "/login"]) {
      await page.goto(path);
      // Wait for the lazy route chunk to resolve, otherwise this measures the Suspense skeleton.
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");

      const offenders = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth;

        /** True when some ancestor clips horizontally, so this element cannot widen the page.
         *  Without this the hero's decorative blur orbs — deliberately positioned at -left-32
         *  inside a `relative overflow-hidden` section — read as overflow when they're clipped
         *  and invisible. */
        const isClippedByAncestor = (el: HTMLElement) => {
          for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
            if (getComputedStyle(node).overflowX !== "visible") return true;
          }
          return false;
        };

        return [...document.querySelectorAll<HTMLElement>("body *")]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            // 1px of slack absorbs sub-pixel rounding on fractional layouts.
            return rect.right > limit + 1 || rect.left < -1;
          })
          .filter((el) => {
            const style = getComputedStyle(el);
            // `position: fixed` elements are viewport-anchored and can't scroll the document;
            // hidden and unrendered ones (the closed mobile drawer, sr-only text) are parked
            // off-screen on purpose.
            if (style.position === "fixed" || style.visibility === "hidden" || el.offsetParent === null) return false;
            return !isClippedByAncestor(el);
          })
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${el.className?.toString().split(" ").slice(0, 3).join(".")}`);
      });

      expect(offenders, `${path} has elements wider than a 390px viewport`).toEqual([]);
    }
  });
});
