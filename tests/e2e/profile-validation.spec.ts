/**
 * PATCH /auth/profile's phone and timezone validation, at the HTTP surface — the client's
 * country-aware picker is convenience; THIS is the boundary, so this is what gets tested.
 * The final PATCH restores the original values: this runs against a live demo workspace.
 */
import { expect, request as playwrightRequest, test } from "@playwright/test";
import { E2E_BASE_URL as BASE_URL } from "./helpers/base-url";

test.describe("profile validation", () => {
  test("phone must be a real international number, timezone a real zone — both normalized", async () => {
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
    try {
      const login = await ctx.post("/api/auth/login", {
        data: { email: "employee@timesheet.local", password: "Admin@12345" }
      });
      expect(login.ok()).toBe(true);
      const body = await login.json();
      const headers = { Authorization: `Bearer ${body.accessToken}`, "Content-Type": "application/json" };
      const original = { phoneNumber: body.user.phoneNumber ?? null, timezone: body.user.timezone ?? null };

      try {
        // Text is not a phone number, and a number without a country code has no country to be
        // valid IN — both refused with a message that says what to do.
        for (const bad of ["hello there", "9876543210", "+91 12345"]) {
          const res = await ctx.patch("/api/auth/profile", { headers, data: { phoneNumber: bad } });
          expect(res.status(), `"${bad}" must be refused`).toBe(422);
        }

        // A valid Indian mobile, messy formatting and all, saves as canonical E.164.
        const good = await ctx.patch("/api/auth/profile", { headers, data: { phoneNumber: "+91 98765-43210" } });
        expect(good.status()).toBe(200);
        expect((await good.json()).phoneNumber).toBe("+919876543210");

        // Timezones: lookalikes refused; both spellings of the same real zone accepted,
        // because which one a browser reports depends on its ICU build.
        expect((await ctx.patch("/api/auth/profile", { headers, data: { timezone: "Asia/Kolkataa" } })).status()).toBe(422);
        expect((await ctx.patch("/api/auth/profile", { headers, data: { timezone: "Asia/Kolkata" } })).status()).toBe(200);
        expect((await ctx.patch("/api/auth/profile", { headers, data: { timezone: "Asia/Calcutta" } })).status()).toBe(200);
      } finally {
        const restore = await ctx.patch("/api/auth/profile", { headers, data: original });
        expect(restore.ok(), "restoring the original profile values failed").toBe(true);
      }
    } finally {
      await ctx.dispose();
    }
  });
});
