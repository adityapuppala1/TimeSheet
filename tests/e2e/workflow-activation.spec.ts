import { expect, test, type Page } from "@playwright/test";
import { expectCleanupOk, withAdminRequest } from "./helpers/admin-request";

let flowId: string | null = null;
let flowName = "";
let enabled = false;
let studioAvailable = false;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await withAdminRequest(async (ctx, headers) => {
    const catalogue = await ctx.get("/api/flows/catalogue", { headers });
    if (!catalogue.ok()) return;
    studioAvailable = true;
    const users = (await (await ctx.get("/api/users", { headers })).json()) as Array<{ id: string; role: string }>;
    const approver = users.find((user) => user.role === "SUPER_ADMIN");
    if (!approver) throw new Error("Workflow activation fixture needs an active superadmin approver");
    flowName = `Replay gate ${Date.now()}`;
    const created = await ctx.post("/api/flows", {
      headers,
      data: { name: flowName, trigger: "MANUAL", steps: [{ kind: "HUMAN_GATE", config: { approverId: approver.id } }] }
    });
    expect(created.status(), `fixture creation: ${await created.text()}`).toBe(201);
    flowId = (await created.json()).id;
  });
});

test.afterAll(async () => {
  if (!flowId) return;
  await withAdminRequest(async (ctx, headers) => {
    if (enabled) {
      const off = await ctx.post(`/api/flows/${flowId}/enabled`, { headers, data: { enabled: false } });
      expect([200, 204], `deactivate fixture returned ${off.status()}`).toContain(off.status());
    }
    const removed = await ctx.delete(`/api/flows/${flowId}`, { headers });
    expectCleanupOk(removed.status(), `workflow ${flowName}`);
  });
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("superadmin@timesheet.local");
  await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
}

test("a flow requires a loaded replay and explicit review before activation", async ({ page }) => {
  test.skip(!studioAvailable || !flowId, "Workflow Studio is unavailable on this plan");
  await signIn(page);
  await page.goto("/app/studio");
  const card = page.locator("[data-tour='flow-list'] > *").filter({ hasText: flowName });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole("button", { name: "Switch on" }).click();
  const replay = page.getByRole("dialog", { name: new RegExp(`${flowName}.*replay`) });
  await expect(replay.getByText("This replay wrote nothing and called no model.")).toBeVisible({ timeout: 15_000 });
  await replay.getByRole("button", { name: "Close" }).click();
  await expect(card.getByText("Draft")).toBeVisible();

  await card.getByRole("button", { name: "Switch on" }).click();
  const confirm = page.getByRole("dialog", { name: new RegExp(`${flowName}.*replay`) });
  await confirm.getByRole("button", { name: "I reviewed the replay — switch on" }).click();
  await expect(card.getByText("Live")).toBeVisible({ timeout: 15_000 });
  enabled = true;
  await withAdminRequest(async (ctx, headers) => {
    const row = await (await ctx.get(`/api/flows/${flowId}`, { headers })).json();
    expect(row.enabled).toBe(true);
  });
});
