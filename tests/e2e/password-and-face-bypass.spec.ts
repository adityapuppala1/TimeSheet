/**
 * Two security-posture features, tested at the API surface where their guarantees actually live:
 *
 * 1. Admin password resets generate a RANDOM one-time password (the old default was the fixed
 *    "Admin@12345" — documented in this repo's README, so effectively public) and flag the
 *    account to prompt a change; choosing your own password clears the flag.
 *
 * 2. The insecure-context face bypass: POST /face/skip mints a consumable "skipped" verification
 *    ONLY while the super-admin toggle is on, and the skip is visible in the review log rather
 *    than silent. The toggle is restored to its original value even on failure — this spec runs
 *    against a live demo workspace and must not change its posture.
 */
import { expect, request as playwrightRequest, test } from "@playwright/test";
import { withAdminRequest } from "./helpers/admin-request";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

test.describe("admin password resets", () => {
  test("a reset with no password generates a one-time password and prompts a change", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const email = `e2e-pwreset-${Date.now()}@timesheet.local`;
      const created = await ctx.post("/api/users", {
        headers,
        data: { name: "PW Reset Drill", email, role: "EMPLOYEE", password: "Original@123" }
      });
      expect(created.ok(), `could not create the drill user (${created.status()})`).toBe(true);
      const userId = (await created.json()).id as string;

      try {
        const reset = await ctx.post(`/api/users/${userId}/reset-password`, { headers, data: {} });
        expect(reset.ok(), `reset failed (${reset.status()})`).toBe(true);
        const { generatedPassword } = await reset.json();
        // The generator's contract: 12 unambiguous alphanumerics + the fixed complexity tail.
        expect(generatedPassword).toMatch(/^[a-zA-Z0-9]{12}!7a$/);

        // The generated password actually signs in, and the profile carries the prompt flag.
        const userCtx = await playwrightRequest.newContext({ baseURL: BASE_URL });
        try {
          const login = await userCtx.post("/api/auth/login", { data: { email, password: generatedPassword } });
          expect(login.ok(), `generated password was refused at login (${login.status()})`).toBe(true);
          const loginBody = await login.json();
          expect(loginBody.user.mustChangePassword, "an admin-reset account must be prompted to change").toBe(true);

          // Choosing their own password clears the prompt.
          const bearer = { Authorization: `Bearer ${loginBody.accessToken}`, "Content-Type": "application/json" };
          const change = await userCtx.post("/api/auth/change-password", {
            headers: bearer,
            data: { currentPassword: generatedPassword, nextPassword: "MyOwnChoice@99" }
          });
          expect(change.ok(), `change-password failed (${change.status()})`).toBe(true);

          const relogin = await userCtx.post("/api/auth/login", { data: { email, password: "MyOwnChoice@99" } });
          expect(relogin.ok()).toBe(true);
          expect((await relogin.json()).user.mustChangePassword, "choosing your own password must clear the prompt").toBe(false);
        } finally {
          await userCtx.dispose();
        }
      } finally {
        // Asserted cleanup, per the admin-request helper's own lesson.
        const del = await ctx.delete(`/api/users/${userId}`, { headers });
        expect(del.status(), "drill-user cleanup failed").toBeLessThan(300);
      }
    });
  });
});

test.describe("insecure-context face bypass", () => {
  test("POST /face/skip works only while the toggle is on, and the skip is visible in the log", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const settings = await (await ctx.get("/api/settings/face-verification", { headers })).json();
      // The bypass is meaningless with the whole feature off, and this spec must not be the
      // thing that turns face verification on in a live workspace.
      test.skip(!settings.enabled, "face verification is not enabled in this workspace");
      const original = Boolean(settings.insecureContextBypass);

      try {
        await ctx.patch("/api/settings/face-verification", { headers, data: { insecureContextBypass: true } });
        const allowed = await ctx.post("/api/face/skip", { headers, data: { context: "TIMESHEET" } });
        expect(allowed.status(), "skip must be granted while the toggle is on").toBe(201);
        const { verificationId } = await allowed.json();
        expect(verificationId).toBeTruthy();

        // The paper trail: the skip appears in the review log as its own outcome — the whole
        // design is "bypass with visibility", so this row missing would defeat the feature.
        const log = await (
          await ctx.get("/api/face/attempts?outcome=SKIPPED_INSECURE&pageSize=5", { headers })
        ).json();
        expect(
          (log.rows as Array<{ id: string }>).some((row) => row.id === verificationId),
          "the skipped attempt must be visible in the verification log"
        ).toBe(true);

        await ctx.patch("/api/settings/face-verification", { headers, data: { insecureContextBypass: false } });
        const refused = await ctx.post("/api/face/skip", { headers, data: { context: "TIMESHEET" } });
        expect(refused.status(), "skip must be refused while the toggle is off").toBe(403);
      } finally {
        const restore = await ctx.patch("/api/settings/face-verification", {
          headers,
          data: { insecureContextBypass: original }
        });
        expect(restore.ok(), "failed to restore the bypass toggle to its original value").toBe(true);
      }
    });
  });
});
