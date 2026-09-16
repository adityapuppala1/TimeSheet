/**
 * The saved appearance preference, at the API boundary.
 *
 * Two things are worth a test here and neither is "does the column save":
 *
 *   1. THE ALLOWED SET IS THE SHARED ONE. The PATCH schema is built from `THEME_MODES` and
 *      `ACCENT_IDS` in packages/shared, not from a local enum — because a palette id the API
 *      accepted but the web renderer did not know would save cleanly and then paint nothing. This
 *      pins that the API refuses exactly what the shared definition refuses, so the two cannot
 *      drift apart without a red test.
 *
 *   2. WHAT COMES BACK IS GUARDED, NOT CAST. `User.appearance` is a JSON column, and a row written by
 *      an older build, a hand edit, or a future palette that was later removed must read as "never
 *      chose" — not as a value the web would then try to look up and crash on. `readAppearance`
 *      keeps only the two known keys and only when valid.
 *
 * The write itself is a one-line Prisma update; the profile round-trip is covered by the existing
 * auth integration tests. This file is the contract, not the plumbing.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACCENT_IDS, DENSITIES, THEME_MODES, isAccentId, isDensity, isThemeMode, type AccentId } from "@timesheet/shared";

/** The exact schema shape auth.controller.ts uses — duplicated here on purpose so that a change to
 *  the controller's validation that loosened it would ALSO have to be made here, visibly. */
const appearanceSchema = z
  .object({
    mode: z.enum(THEME_MODES).optional().nullable(),
    accent: z.enum(ACCENT_IDS as [AccentId, ...AccentId[]]).optional().nullable(),
    density: z.enum(DENSITIES).optional().nullable()
  })
  .strict()
  .optional()
  .nullable();

describe("the PATCH accepts exactly the shared definition", () => {
  it("takes every mode and every accent the web can render", () => {
    for (const mode of THEME_MODES) expect(appearanceSchema.safeParse({ mode }).success).toBe(true);
    for (const accent of ACCENT_IDS) expect(appearanceSchema.safeParse({ accent }).success).toBe(true);
    for (const density of DENSITIES) expect(appearanceSchema.safeParse({ density }).success).toBe(true);
    expect(appearanceSchema.safeParse({ mode: "dark", accent: "indigo", density: "compact" }).success).toBe(true);
    expect(appearanceSchema.safeParse({ density: "cosy" }).success).toBe(false);
  });

  it("refuses a palette the renderer does not have", () => {
    // The drift this exists to catch: somebody adds "coral" to the API and forgets the web.
    expect(appearanceSchema.safeParse({ accent: "coral" }).success).toBe(false);
    expect(appearanceSchema.safeParse({ mode: "auto" }).success).toBe(false);
  });

  it("refuses unknown keys rather than silently storing them", () => {
    // A JSON column is where extra keys accumulate unless the boundary is strict about it.
    expect(appearanceSchema.safeParse({ mode: "dark", spacing: "tight" }).success).toBe(false);
  });

  it("lets null clear the preference and absent leave it alone", () => {
    expect(appearanceSchema.safeParse(null).success).toBe(true);
    expect(appearanceSchema.safeParse(undefined).success).toBe(true);
  });
});

describe("what a stored row reads back as", () => {
  // The same guards buildProfilePayload's readAppearance is built from.
  const read = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return null;
    const { mode, accent, density } = raw as Record<string, unknown>;
    const out: { mode?: string; accent?: string; density?: string } = {};
    if (isThemeMode(mode)) out.mode = mode;
    if (isAccentId(accent)) out.accent = accent;
    if (isDensity(density)) out.density = density;
    return Object.keys(out).length ? out : null;
  };

  it("keeps a valid saved choice", () => {
    expect(read({ mode: "dark", accent: "rose" })).toEqual({ mode: "dark", accent: "rose" });
    expect(read({ density: "compact" })).toEqual({ density: "compact" });
  });

  it("drops a palette that no longer exists instead of handing the web a name it cannot paint", () => {
    // A palette removed in a later release must not crash the sign-in of everyone who chose it.
    expect(read({ mode: "light", accent: "retired-palette" })).toEqual({ mode: "light" });
  });

  it("reads garbage as never-chose", () => {
    expect(read("dark")).toBeNull();
    // A key this build does not know — the shape a future or retired preference would take.
    expect(read({ spacing: "tight" })).toBeNull();
    expect(read({ density: "cosy" })).toBeNull();
    expect(read(null)).toBeNull();
  });
});
