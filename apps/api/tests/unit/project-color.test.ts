/**
 * A project's stored colour is an ID from the shared identity palette, never a free value: the
 * web owns the HSL per theme and measured its contrast, so an arbitrary colour could not be
 * guaranteed legible. The PATCH schema is built from the same list the web renders from.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IDENTITY_COLOR_IDS, isIdentityColorId } from "@timesheet/shared";

const color = z.enum(IDENTITY_COLOR_IDS).nullable().optional();

describe("project colour", () => {
  it("accepts every palette id and null (back to the derived hue), refuses anything else", () => {
    for (const id of IDENTITY_COLOR_IDS) expect(color.safeParse(id).success).toBe(true);
    expect(color.safeParse(null).success).toBe(true);
    expect(color.safeParse("pink").success).toBe(false);
    expect(color.safeParse("#ff0000").success).toBe(false);
  });

  it("has eight distinct ids, matching the web palette's length", () => {
    expect(new Set(IDENTITY_COLOR_IDS).size).toBe(8);
    expect(isIdentityColorId("teal")).toBe(true);
    expect(isIdentityColorId("TEAL")).toBe(false);
  });
});
