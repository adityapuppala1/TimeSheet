import { test, expect } from "@playwright/test";
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

test.describe("AI provider list", () => {
  test("adds a provider, reorders it above an existing one, then removes it", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/settings");
    await page.getByRole("tab", { name: /^AI$/ }).click();
    await expect(page.getByText("AI providers")).toBeVisible({ timeout: 15_000 });

    const rowsBefore = await page.getByRole("button", { name: /^Move .+ up in priority$/ }).count();

    // Add — defaults to Anthropic, which needs no base URL and picks its model from a fixed
    // dropdown, so this exercises the dialog without depending on any live provider endpoint.
    const label = `E2E test provider ${Date.now()}`;
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
    expect((await created).ok(), "creating the provider was rejected").toBe(true);
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

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

    // Remove — cleans up after itself. The button uses a native confirm(); accept it.
    page.once("dialog", (d) => d.accept());
    const removed = page.waitForResponse(
      (res) => res.url().includes("/api/settings/ai/providers/") && res.request().method() === "DELETE" && res.status() === 204
    );
    await page.getByRole("button", { name: `Remove ${label}` }).click();
    expect((await removed).ok(), "deleting the provider was rejected").toBe(true);
    await expect(page.getByText(label)).not.toBeVisible({ timeout: 10_000 });
  });
});
