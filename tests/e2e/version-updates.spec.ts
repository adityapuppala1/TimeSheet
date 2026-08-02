/**
 * The version identity and update surface (V5's B1–B3).
 *
 * What these pin: the health payload carries the version (the everyone-gets-a-refresh flow rides
 * on that field — see use-backend-health.ts), /api/system/version agrees with the repo's VERSION
 * file (update.sh trusts that agreement to verify an upgrade landed), the updates endpoint never
 * errors even with no releases published, and the What's-new page renders for a non-admin without
 * showing them the admin-only update card.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";

const EXPECTED_VERSION = fs.readFileSync("VERSION", "utf8").trim();

test.describe("version identity", () => {
  test("health carries the version the bundle can compare against", async ({ request }) => {
    const health = await (await request.get("/api/health")).json();
    expect(health.ok).toBe(true);
    // The exact field name is load-bearing: use-backend-health.ts reads `version` to detect a
    // server upgraded underneath an open tab. Renaming it silently kills that flow.
    expect(health.version).toBe(EXPECTED_VERSION);
  });

  test("/api/system/version matches the VERSION file", async ({ request }) => {
    const identity = await (await request.get("/api/system/version")).json();
    // update.sh greps for exactly this pairing after an upgrade — the agreement IS the contract.
    expect(identity.version).toBe(EXPECTED_VERSION);
    expect(identity).toHaveProperty("gitSha");
    expect(identity).toHaveProperty("builtAt");
  });

  test("/api/system/updates degrades to 'no information', never an error", async ({ request }) => {
    const res = await request.get("/api/system/updates");
    expect(res.status()).toBe(200);
    const status = await res.json();
    expect(status.currentVersion).toBe(EXPECTED_VERSION);
    // With no GitHub releases published (or GitHub unreachable from CI), the contract is silence:
    expect(Array.isArray(status.releases)).toBe(true);
    expect(typeof status.updateAvailable).toBe("boolean");
  });
});

test.describe("what's-new page", () => {
  // Signs in for itself. The first version borrowed `.auth/employee-health.json` — a snapshot
  // backend-health.spec OWNS and, sorting earlier alphabetically, had already rotated by the time
  // this ran. That is the exact one-owner-per-snapshot trap documented in auth.setup.ts, walked
  // into by the person who wrote the warning. Passed standalone, failed in the full suite —
  // which is the trap's signature.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("renders for a non-admin, without the admin-only update card", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("employee@timesheet.local");
    await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });

    await page.goto("/app/whats-new");
    await expect(page.getByRole("heading", { name: /what's new/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`v${EXPECTED_VERSION}`).first()).toBeVisible();
    // The update command is an action only admins can take; an employee must never see it.
    await expect(page.getByText(/update\.sh/)).toBeHidden();
  });
});
