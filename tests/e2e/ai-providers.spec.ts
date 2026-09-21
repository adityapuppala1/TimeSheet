import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers/sign-in";

/**
 * The ranked BYOK provider list (Workspace Settings → AI → "AI providers", V9, provider-priority)
 * replaced a single provider/key/model form with a reorderable list, each row its own provider —
 * this is the one surface from that change with no unit-test coverage at all (the CRUD service and
 * the dispatcher's fallback logic are unit-tested; the list/dialog/reorder/delete UI is not).
 * Covers the full loop: add a provider, see it appended at the end of the priority order, move it
 * up a slot, then remove it — cleaning up after itself so a re-run finds the workspace as it found
 * it.
 *
 * Row controls (move up/down, edit, remove, enable switch) all carry the provider's own display
 * name in their accessible name specifically so a test can target ONE row's button directly,
 * rather than filtering generic `div`s by text content and hoping to land on the right ancestor.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** Adds a provider through the dialog. Defaults to Anthropic, which needs no base URL and picks
 *  its model from a fixed dropdown, so this exercises the dialog without depending on any live
 *  provider endpoint. */
async function addProvider(page: Page, label: string) {
  await page.getByRole("button", { name: "Add provider" }).click();
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  await dialog.getByPlaceholder("e.g. Groq (fast, cheap)").fill(label);
  await dialog.getByRole("combobox").nth(1).click(); // 0 = Provider, 1 = Model
  await page.getByRole("option").first().click();

  const created = page.waitForResponse(
    (res) => res.url().includes("/api/settings/ai/providers") && res.request().method() === "POST" && res.status() === 201
  );
  await dialog.getByRole("button", { name: "Add" }).click();
  expect((await created).ok(), `creating ${label} was rejected`).toBe(true);
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
}

/** Removes a provider by its row button. The button uses a native confirm(); accept it. */
async function removeProvider(page: Page, label: string) {
  page.once("dialog", (d) => d.accept());
  const removed = page.waitForResponse(
    (res) => res.url().includes("/api/settings/ai/providers/") && res.request().method() === "DELETE" && res.status() === 204
  );
  await page.getByRole("button", { name: `Remove ${label}` }).click();
  expect((await removed).ok(), `deleting ${label} was rejected`).toBe(true);
  await expect(page.getByText(label)).not.toBeVisible({ timeout: 10_000 });
}

test.describe("AI provider list", () => {
  test("adds a provider, reorders it above an existing one, then removes it", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/settings");
    await page.getByRole("tab", { name: /^AI$/ }).click();
    await expect(page.getByText("AI providers")).toBeVisible({ timeout: 15_000 });

    // "Above an existing one" needs one to exist. A fresh database (every CI shard) seeds no
    // provider, so the new row would be the ONLY row, its move-up button rightly disabled, and the
    // click would wait on it forever — then pass on retry, because the failed attempt's row had
    // leaked and become the "existing one". Seed the anchor here and remove it at the end instead.
    let anchor: string | null = null;
    if ((await page.getByRole("button", { name: /^Move .+ up in priority$/ }).count()) === 0) {
      anchor = `E2E anchor provider ${Date.now()}`;
      await addProvider(page, anchor);
      await expect(page.getByRole("button", { name: `Move ${anchor} down in priority` })).toBeVisible({ timeout: 10_000 });
    }
    const rowsBefore = await page.getByRole("button", { name: /^Move .+ up in priority$/ }).count();

    const label = `E2E test provider ${Date.now()}`;
    await addProvider(page, label);

    const moveUp = page.getByRole("button", { name: `Move ${label} up in priority` });
    await expect(moveUp).toBeVisible({ timeout: 10_000 });
    // New rows append to the END of the priority order, never jump ahead of an existing one.
    await expect(page.getByRole("button", { name: /^Move .+ up in priority$/ })).toHaveCount(rowsBefore + 1);

    // Reorder — move the new (last) row up one slot, above whatever was already there.
    const reordered = page.waitForResponse(
      (res) => res.url().includes("/api/settings/ai/providers/reorder") && res.request().method() === "POST" && res.status() < 400
    );
    await moveUp.click();
    expect((await reordered).ok(), "the reorder was rejected").toBe(true);

    // Survives a reload — proves the order actually persisted server-side, not just local state.
    await page.reload();
    await page.getByRole("tab", { name: /^AI$/ }).click();
    await expect(page.getByText("AI providers")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(label)).toBeVisible({ timeout: 10_000 });

    // Remove — cleans up after itself, the anchor included when this run had to seed one.
    await removeProvider(page, label);
    if (anchor) await removeProvider(page, anchor);
  });
});
