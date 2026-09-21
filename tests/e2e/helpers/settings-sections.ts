/**
 * The long Workspace Settings tabs fold their sections behind a board (see
 * components/settings/settings-sections.tsx). A test that used to find a card's text on the page
 * now has to open the section first — and a folded section's controls are genuinely not visible,
 * so a locator that waits for one is waiting for a person to click. This is that click.
 */
import { expect, type Page } from "@playwright/test";

/** Opens the named section if it is folded; leaves it alone if it is already open. */
export async function openSettingsSection(page: Page, name: string | RegExp): Promise<void> {
  const heading = page.getByRole("heading", { name });
  await expect(heading).toBeVisible({ timeout: 15_000 });
  const toggle = heading.getByRole("button").first();
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}
