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
    // `role` is a RELATION on this endpoint — `{ id, name, description }` — not a string. The
    // original `user.role === "SUPER_ADMIN"` compared an object to a string, so it matched nobody
    // and the fixture threw on every machine; it only looked like a CI-only failure because CI is
    // where the suite actually ran. Status is checked too, which is what the message below claims:
    // a deactivated approver would be accepted by the fixture and then rejected by the human gate.
    const users = (await (await ctx.get("/api/users", { headers })).json()) as Array<{
      id: string;
      status: string;
      role: { name: string } | null;
    }>;
    const approver = users.find((user) => user.role?.name === "SUPER_ADMIN" && user.status === "ACTIVE");
    if (!approver) throw new Error("Workflow activation fixture needs an active superadmin approver");
    flowName = `Replay gate ${Date.now()}`;
    const created = await ctx.post("/api/flows", {
      headers,
      // A GATE MUST HAVE SOMETHING AFTER IT. The fixture used to be a lone HUMAN_GATE, which the
      // validator rejects on its own terms — "a gate is the last step, so there is nothing left for
      // anyone to approve" — so the flow was never activatable, "Switch on" was correctly disabled,
      // and the test clicked a dead button until it timed out. The product was right; the fixture
      // was not. A notify action after the gate is the smallest thing that gives it a purpose.
      data: {
        name: flowName,
        trigger: "MANUAL",
        steps: [
          { kind: "HUMAN_GATE", config: { approverId: approver.id } },
          { kind: "ACTION", config: { action: "notify", notifyUserId: approver.id } }
        ]
      }
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
  // Two controls share the name "Close": Radix's icon button (absolutely positioned, its label in
  // an sr-only span) and the footer's explicit one. Excluding the positioned one picks the footer
  // button without depending on DOM order — the same fix marketing.spec.ts documents for the
  // pricing dialog.
  await replay.locator("button:not(.absolute)").filter({ hasText: /^Close$/ }).click();
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
