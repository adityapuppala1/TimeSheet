/**
 * The strict AI-settings schema and the capability registry must never drift.
 *
 * The AI tab renders one switch per capability, and each switch PATCHes /settings/ai with the
 * registry's `featureToggle` key. The schema is `.strict()` ON PURPOSE (an unknown key is a
 * typo'd write silently doing nothing), which means a toggle the registry knows and the schema
 * does not is a 400 the admin reads as "Unrecognized key(s)" with no obvious cause. Exactly that
 * shipped: projectRiskAgentEnabled, planBreakdownEnabled and chatIngestionEnabled all 400'd from
 * the very card built to manage them. This test makes the drift a build failure instead of a
 * screenshot from a confused administrator.
 */
import { describe, expect, it } from "vitest";
import { aiSettingsSchema } from "../../src/controllers/settings.controller.js";
import { AI_CAPABILITIES } from "../../src/services/ai-capability.registry.js";

describe("aiSettingsSchema accepts every registry featureToggle", () => {
  const toggles = [...new Set(AI_CAPABILITIES.map((c) => c.featureToggle).filter((t): t is string => t !== null))];

  it("covers all of them", () => {
    const rejected = toggles.filter((key) => !aiSettingsSchema.safeParse({ body: { [key]: true } }).success);
    // Empty or the schema lost a key the AI tab actively sends.
    expect(rejected).toEqual([]);
  });

  it("is still strict about keys nobody declared", () => {
    expect(aiSettingsSchema.safeParse({ body: { totallyMadeUpToggle: true } }).success).toBe(false);
  });
});
