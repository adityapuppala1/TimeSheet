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
  "/product/settings-ai.png"
];

test.describe("marketing pages", () => {
  test("the landing page renders, and every product screenshot actually loads", async ({ page }) => {
    const failed: string[] = [];
    page.on("response", (res) => {
      const path = new URL(res.url()).pathname;
      // Both session probes 401 for a signed-out visitor BY DESIGN — App.tsx's two auth
      // bootstraps ask the server whether a session exists, and "no" is the expected answer on a
      // public page. Anything else failing is a real problem.
      if (res.status() >= 400 && !path.includes("/auth/refresh") && !path.includes("/auth/me")) {
        failed.push(`${res.status()} ${path}`);
      }
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/AI that earns your trust/i);

    // The hero shot is above the fold and eager-loaded, so it must be decoded by now. Checking
    // naturalWidth rather than visibility catches the case that matters: the <img> is present and
    // laid out, but the file behind it 404'd.
    const hero = page.locator('img[src="/product/dashboard.png"]').first();
    await expect(hero).toBeVisible();
    expect(await hero.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    expect(failed, "no request on the landing page should fail").toEqual([]);
  });

  test("every product screenshot referenced by the tour exists on disk", async ({ request }) => {
    // Fetched directly rather than clicked through the tour: this asserts the ASSET exists,
    // independently of whether the UI happens to render it, so a rename fails loudly here.
    for (const path of PRODUCT_IMAGES) {
      const res = await request.get(path);
      expect(res.status(), `${path} should be served`).toBe(200);
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
      // Both session probes 401 for a signed-out visitor BY DESIGN — App.tsx's two auth
      // bootstraps ask the server whether a session exists, and "no" is the expected answer on a
      // public page. Anything else failing is a real problem.
      if (res.status() >= 400 && !path.includes("/auth/refresh") && !path.includes("/auth/me")) {
        failed.push(`${res.status()} ${path}`);
      }
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

  test("no horizontal overflow on the public pages at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/", "/pitch", "/login"]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `${path} should not scroll sideways`).toBeLessThanOrEqual(1);
    }
  });
});
