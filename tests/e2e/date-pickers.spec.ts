/**
 * The date/time pickers: behaviour, layout at every width, and both themes.
 *
 * WHY A THEME TEST EXISTS HERE AND NOWHERE ELSE IN THE SUITE: these are the first components in the
 * app built on a third-party primitive (React Aria). Everything else styles elements this codebase
 * wrote, so a token that fails in dark mode would have been noticed while building it. React Aria
 * renders its own DOM — cells, segments, popovers — and it is genuinely easy to leave one of those
 * with a hard-coded colour that looks fine in light mode and vanishes in dark. Contrast is checked
 * by reading computed colours rather than by eye.
 *
 * WHY IT DRIVES THE CONTROLS RATHER THAN ASSERTING MARKUP: the point of replacing native inputs was
 * that a person can pick a range in one gesture. A test that only checks a popover opens would pass
 * against a picker whose Apply button does nothing.
 */
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers/sign-in";

test.use({ storageState: { cookies: [], origins: [] } });

/** Reads the app's own theme switch. The class lives on <html>, matching tailwind's darkMode. */
async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((mode) => {
    document.documentElement.classList.toggle("dark", mode === "dark");
    localStorage.setItem("theme", mode);
  }, theme);
}

function parseRgb(value: string): [number, number, number] {
  const nums = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return [nums[0], nums[1], nums[2]];
}

/** WCAG relative luminance, used to prove text and background are actually distinguishable. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg: string, bg: string): number {
  const a = luminance(parseRgb(fg));
  const b = luminance(parseRgb(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test.describe("date pickers", () => {
  test("the range picker applies a preset and the report follows it", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/reports");

    const trigger = page.locator("#report-range");
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Presets are the main event: almost every range anyone wants is one of these, and making them
    // one click is what stops people hand-picking the 1st and the 30th and missing the 31st.
    await expect(dialog.getByRole("button", { name: "This month", exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "This month", exact: true }).click();
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // The trigger now names the preset rather than echoing two dates back.
    await expect(trigger).toContainText("This month");
  });

  test("Cancel discards the draft rather than committing it", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/reports");

    const trigger = page.locator("#report-range");
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    const before = (await trigger.textContent())?.trim();

    await trigger.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Last year", exact: true }).click();
    // THE ASSERTION: a range is two values, and between the first click and Apply it is briefly
    // nonsense. Committing on every click would fire a query against that intermediate state.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await expect(trigger).toHaveText(before ?? "");
  });

  test("the timesheet time field accepts a time that is not on any slot grid", async ({ page }) => {
    await signIn(page, "employee");
    await page.goto("/app/timesheet");

    const hour = page.getByRole("spinbutton", { name: "hour, Start time" });
    await expect(hour).toBeVisible({ timeout: 15_000 });

    // 09:15 is deliberately off every half-hour grid. Timesheet times accept any HH:mm, and a slot
    // picker here would have made a currently-valid entry impossible — a data-entry regression
    // dressed as a design improvement.
    await hour.click();
    await page.keyboard.type("09");
    await page.getByRole("spinbutton", { name: "minute, Start time" }).click();
    await page.keyboard.type("15");
    await page.getByRole("spinbutton", { name: "AM/PM, Start time" }).click();
    await page.keyboard.type("a");

    await expect(page.getByRole("spinbutton", { name: "minute, Start time" })).toHaveText("15");
  });

  for (const [label, width, height] of [
    ["phone", 390, 844],
    ["tablet", 768, 1024],
    ["laptop", 1366, 768]
  ] as const) {
    test(`the range picker fits a ${label} without pushing the page sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await signIn(page, "superadmin");
      await page.goto("/app/reports");

      const trigger = page.locator("#report-range");
      await expect(trigger).toBeVisible({ timeout: 15_000 });
      await trigger.click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // The popover is allowed to scroll inside itself; the PAGE is not allowed to grow. That
      // distinction is the documented rule in index.css — `body { overflow-x: clip }` hides page
      // overflow, so the symptom of getting this wrong is a header dragged off screen rather than
      // a scrollbar.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `the ${label} viewport scrolled horizontally by ${overflow}px`).toBeLessThanOrEqual(1);

      // And it must be reachable, not clipped off the edge.
      const box = await page.getByRole("dialog").boundingBox();
      expect(box, "the popover has no box").not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`calendar text is readable against its own background in ${theme} mode`, async ({ page }) => {
      await signIn(page, "superadmin");
      await page.goto("/app/reports");
      await setTheme(page, theme);

      await page.locator("#report-range").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      const popoverBg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);

      // A day cell that inherits a light-mode colour in dark mode is invisible rather than ugly,
      // and no snapshot test would catch it because the DOM is identical.
      const cell = dialog.getByRole("button", { name: /day|,/ }).first();
      const cellColor = await cell.evaluate((el) => getComputedStyle(el).color);
      expect(
        contrastRatio(cellColor, popoverBg),
        `day cells are ${contrastRatio(cellColor, popoverBg).toFixed(2)}:1 against the popover in ${theme} mode`
      ).toBeGreaterThan(3);

      const preset = dialog.getByRole("button", { name: "This month", exact: true });
      const presetColor = await preset.evaluate((el) => getComputedStyle(el).color);
      expect(contrastRatio(presetColor, popoverBg)).toBeGreaterThan(3);
    });
  }
});
