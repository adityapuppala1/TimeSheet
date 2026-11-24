/**
 * PATCH /settings/notifications takes a PARTIAL emailRoleMutes map (only categories that have a
 * muted role). Under zod 4 z.record(z.enum(...)) is exhaustive and 422'd that; partialRecord fixes it.
 */
import { describe, expect, it } from "vitest";
import { notificationsUpdateSchema } from "../../src/controllers/settings.controller.js";

describe("notificationsUpdateSchema emailRoleMutes", () => {
  it("accepts a partial map", () => {
    const r = notificationsUpdateSchema.safeParse({ body: { emailRoleMutes: { emailPunchInReminder: ["EMPLOYEE"] } } });
    expect(r.success).toBe(true);
  });
  it("accepts an empty map", () => {
    expect(notificationsUpdateSchema.safeParse({ body: { emailRoleMutes: {} } }).success).toBe(true);
  });
  it("still rejects unknown keys and unknown roles", () => {
    expect(notificationsUpdateSchema.safeParse({ body: { emailRoleMutes: { nope: ["EMPLOYEE"] } } }).success).toBe(false);
    expect(notificationsUpdateSchema.safeParse({ body: { emailRoleMutes: { emailPunchInReminder: ["WIZARD"] } } }).success).toBe(false);
  });
});
