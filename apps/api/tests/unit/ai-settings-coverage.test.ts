/**
 * NO AI FLAG MAY ARRIVE ORPHANED.
 *
 * `GlobalAISettings` carries a boolean per AI capability, and every one of them is supposed to be
 * reachable by an administrator: either through the autonomy ladder (a registry entry whose
 * `featureToggle` names the column, rendered as a switch by AIAutonomyCard) or through one of the
 * handful of switches WorkspaceSettings' AI tab drives directly.
 *
 * `practiceUpdateEnabled` was neither. No registry entry, no switch, and — the part that made it
 * unfixable — no key in the `.strict()` AI settings schema, so no route on this server would accept
 * a write to it. It was false on every workspace that ever installed this product, the feature
 * refused itself with "This AI feature is disabled for this workspace", and the page it belonged to
 * told people to turn it on under a Workspace Settings switch that did not exist. A customer found
 * that, not us.
 *
 * SO THE COLUMN LIST IS READ FROM THE SCHEMA, NOT TYPED HERE. A hand-copied list would have been
 * complete on the day it was written and silently behind ever after, which is exactly the failure
 * this test exists to make impossible. Same argument, and the same shape, as the `UncoveredEmailKey`
 * compile guard in WorkspaceSettings.tsx: the backend already enforces the flag, so a flag with no
 * control is an invisible setting rather than a cosmetic gap.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aiSettingsSchema } from "../../src/controllers/settings.controller.js";
import { AI_CAPABILITIES } from "../../src/services/ai-capability.registry.js";

const repoFile = (relative: string) => fileURLToPath(new URL(`../../../../${relative}`, import.meta.url));

const SCHEMA_PATH = "apps/api/prisma/schema.prisma";

/**
 * The AI-tab sources that may legitimately own a switch of their own. Deliberately a short, named
 * list rather than "anything under apps/web": `practiceUpdateEnabled` is ALSO a PlanTierLimit
 * column, and the platform console renders a row for that one — scanning the whole web tree would
 * have found it and called this bug covered.
 */
const UI_SOURCES = [
  "apps/web/src/pages/WorkspaceSettings.tsx",
  "apps/web/src/pages/settings/AIAutonomyCard.tsx",
  "apps/web/src/pages/settings/AIProviderListCard.tsx"
];

/** Every `<name>Enabled Boolean` column of the GlobalAISettings model, straight from the schema. */
function globalAiEnabledColumns(): string[] {
  const source = readFileSync(repoFile(SCHEMA_PATH), "utf8");
  const start = source.indexOf("model GlobalAISettings {");
  expect(start, `${SCHEMA_PATH} no longer declares model GlobalAISettings`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s{2}(\w+Enabled)\s+Boolean\b/gm)].map((m) => m[1]);
}

/**
 * Whether an AI-tab source WRITES this column. Reads are everywhere (`settings.data?.aiEnabled`),
 * so only the two shapes that actually change it count: an object-literal property
 * (`update.mutate({ aiEnabled: v })`, `{ key: "aiCaptureEnabled", ... }`) and the shorthand
 * (`updateAI({ aiAutonomyEnabled })`).
 */
function hasDirectSwitch(column: string, sources: ReadonlyArray<string>): boolean {
  const patterns = [
    new RegExp(`\\b${column}\\s*:`),
    new RegExp(`key:\\s*["']${column}["']`),
    new RegExp(`\\{\\s*${column}\\s*[,}]`)
  ];
  return sources.some((text) => patterns.some((re) => re.test(text)));
}

describe("every GlobalAISettings *Enabled column has a control", () => {
  const columns = globalAiEnabledColumns();
  const registryToggles = new Set(AI_CAPABILITIES.map((c) => c.featureToggle).filter((t): t is string => t !== null));
  const uiSources = UI_SOURCES.map((path) => readFileSync(repoFile(path), "utf8"));

  it("found the columns at all", () => {
    // A schema refactor that breaks the parse above must fail loudly, not pass an empty list.
    expect(columns.length).toBeGreaterThan(20);
    expect(columns).toContain("practiceUpdateEnabled");
  });

  it("leaves none of them orphaned", () => {
    const orphaned = columns.filter((column) => !registryToggles.has(column) && !hasDirectSwitch(column, uiSources));
    expect(
      orphaned,
      `No administrator can switch these on. Add a capability entry to ai-capability.registry.ts (preferred — it comes with an autonomy level and a switch) or a deliberate switch to the AI tab: ${orphaned.join(", ")}`
    ).toEqual([]);
  });

  it("lets an administrator actually write every one of them", () => {
    // The other half of the same promise. A control that PATCHes a key this `.strict()` schema
    // rejects is a switch that 400s — see ai-settings-schema.test.ts for the three that did.
    const rejected = columns.filter((column) => !aiSettingsSchema.safeParse({ body: { [column]: true } }).success);
    expect(rejected).toEqual([]);
  });
});
