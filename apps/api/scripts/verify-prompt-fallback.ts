/**
 * PROMPT FALLBACK SELF-TEST.
 *
 * The safety claim behind prompt versioning is that `resolvePrompt` CANNOT break a capability: a
 * missing, invalid or unrenderable override degrades to the built-in prompt and records why. The
 * unit tests pin that against a fake Prisma client; this runs it against a real tenant database,
 * because the failure mode that would actually reach production is a schema/query mismatch, and a
 * mocked client can't catch that.
 *
 * SAFETY: this only ever touches rows it created itself. If a template row already exists for the
 * probe feature it aborts rather than modifying it, and it deletes what it made in a `finally` —
 * including when an assertion fails.
 *
 * Run from apps/api:  npx tsx scripts/verify-prompt-fallback.ts
 */
import { prisma } from "../src/config/prisma.js";
import { requireTenantContext } from "../src/config/tenant-context.js";
import { getPromptSpec, renderTemplate, resolvePrompt } from "../src/services/ai-prompt.service.js";
import { runForEveryOrg } from "../src/workers/run-for-every-org.js";

/** Free-text and low-traffic, so a stray row would be harmless even if cleanup somehow failed. */
const PROBE_FEATURE = "comment_summary";
const VALUES = { ticketTitle: "Probe ticket", thread: "Ana: reproduced on 17.4." };

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function run() {
  const spec = getPromptSpec(PROBE_FEATURE);
  if (!spec) throw new Error(`${PROBE_FEATURE} is not on the editable allowlist.`);
  const builtIn = renderTemplate(spec.defaultTemplate, VALUES);

  const existing = await prisma.aIPromptTemplate.findUnique({ where: { feature: PROBE_FEATURE } });
  if (existing) {
    console.log(`  SKIP  a ${PROBE_FEATURE} template already exists — not touching a real configuration.`);
    return;
  }

  let templateId: string | null = null;
  try {
    // 1. No override at all: built-in prompt, and NO fallback reason (this is the normal state,
    //    not a degradation — reporting one here would make every call look broken).
    const none = await resolvePrompt(PROBE_FEATURE, VALUES);
    check("no override → built-in prompt", none.text === builtIn);
    check("no override → no fallback reason", none.fallbackReason === undefined, none.fallbackReason ?? "");

    const template = await prisma.aIPromptTemplate.create({ data: { feature: PROBE_FEATURE } });
    templateId = template.id;

    // 2. A valid override is used, and its id is stamped so the interaction log can answer
    //    "what was the AI told when it wrote that?" months later.
    const good = await prisma.aIPromptVersion.create({
      data: { templateId: template.id, version: 1, body: "Recap {{ticketTitle}}:\n{{thread}}", note: "probe" }
    });
    await prisma.aIPromptTemplate.update({ where: { id: template.id }, data: { activeVersionId: good.id } });
    const custom = await resolvePrompt(PROBE_FEATURE, VALUES);
    check("valid override → used", custom.text === "Recap Probe ticket:\nAna: reproduced on 17.4.");
    check("valid override → version id stamped", custom.promptVersionId === good.id);

    // 3. A version written directly with an unknown placeholder. The save endpoint rejects this,
    //    so it stands in for the real-world case: a release changes a capability's placeholders
    //    under a version that was already saved and activated.
    const broken = await prisma.aIPromptVersion.create({
      data: { templateId: template.id, version: 2, body: "Recap {{noSuchPlaceholder}}", note: "probe-broken" }
    });
    await prisma.aIPromptTemplate.update({ where: { id: template.id }, data: { activeVersionId: broken.id } });
    const fellBack = await resolvePrompt(PROBE_FEATURE, VALUES);
    check("broken override → built-in prompt, not an error", fellBack.text === builtIn);
    check("broken override → reason recorded", fellBack.fallbackReason === "invalid_template:unknown_placeholder", fellBack.fallbackReason ?? "none");
    check("broken override → no version id stamped", fellBack.promptVersionId === undefined);

    // 4. Dangling pointer — the version row is gone but the template still references it.
    await prisma.aIPromptVersion.delete({ where: { id: broken.id } });
    const dangling = await resolvePrompt(PROBE_FEATURE, VALUES);
    check("missing version row → built-in prompt", dangling.text === builtIn);
    check("missing version row → reason recorded", dangling.fallbackReason === "active_version_missing", dangling.fallbackReason ?? "none");

    // 5. Revert-to-built-in is a real state, not a deletion.
    await prisma.aIPromptTemplate.update({ where: { id: template.id }, data: { activeVersionId: null } });
    const reverted = await resolvePrompt(PROBE_FEATURE, VALUES);
    check("reverted → built-in prompt with no reason", reverted.text === builtIn && reverted.fallbackReason === undefined);
  } finally {
    if (templateId) {
      // Cascades to the probe versions. Only ever removes rows this script created.
      await prisma.aIPromptTemplate.delete({ where: { id: templateId } }).catch((error) => {
        console.error(`  CLEANUP FAILED — remove AIPromptTemplate ${templateId} by hand: ${(error as Error).message}`);
        failures++;
      });
    }
  }
}

async function main() {
  await runForEveryOrg("verify-prompt-fallback", async () => {
    console.log(`\n[${requireTenantContext().orgSlug}]`);
    await run();
  });

  console.log(failures === 0 ? "\nAll prompt fallback checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
