/**
 * EVAL RUNNER SELF-TEST.
 *
 * Checks the eval plumbing against real tenant databases — the failure mode a mocked Prisma client
 * cannot catch is a query that doesn't match the schema, and that's exactly what this exercises:
 * writing an AIEvalRun, cascading its results, and having the worker pick it up.
 *
 * DELIBERATELY SPENDS NOTHING. The probe dataset uses a capability with no replayer, so the run
 * fails on the first check and never reaches a model. That also makes it safe if a dev server is
 * running: its eval worker ticks every minute, and if it grabs this run first the outcome is the
 * same — a clean failure with zero calls.
 *
 * NOT COVERED HERE: the enqueue-time budget refusal, because exercising it would mean writing a
 * monthlyBudgetUsd onto the workspace's real settings. That path is pinned by unit tests instead
 * (tests/unit/ai-eval.service.test.ts).
 *
 * SAFETY: creates its own dataset, item and run, and deletes all three in a `finally` — including
 * when an assertion fails. Touches nothing it didn't make.
 *
 * Run from apps/api:  npx tsx scripts/verify-eval-runner.ts
 */
import { prisma } from "../src/config/prisma.js";
import { requireTenantContext } from "../src/config/tenant-context.js";
import { enqueueEvalRun, isReplayable } from "../src/services/ai-eval.service.js";
import { processNextEvalRun } from "../src/workers/ai-eval.worker.js";
import { runForEveryOrg } from "../src/workers/run-for-every-org.js";

/** On the content-capture denylist, so it can never have a replayer — a permanently safe probe. */
const PROBE_FEATURE = "face_review_summary";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function run() {
  check("the probe capability has no replayer", !isReplayable(PROBE_FEATURE));

  let datasetId: string | null = null;
  try {
    const dataset = await prisma.aIDataset.create({
      data: { name: "__verify_eval_runner", feature: PROBE_FEATURE, description: "temporary probe" }
    });
    datasetId = dataset.id;
    await prisma.aIDatasetItem.create({
      data: { datasetId: dataset.id, inputParamsJson: { probe: true }, expectedOutput: "anything", expectedKind: "CONTAINS" }
    });

    // Enqueue must refuse a capability it can't replay, before any run row exists.
    let refused = false;
    try {
      await enqueueEvalRun({ datasetId: dataset.id, userId: "verify-script" });
    } catch (error) {
      refused = (error as { statusCode?: number }).statusCode === 422;
    }
    check("enqueue refuses a non-replayable capability", refused);
    check("no run row was created by the refusal", (await prisma.aIEvalRun.count({ where: { datasetId: dataset.id } })) === 0);

    // Now write the run directly, which is the state the worker would find, and let the worker
    // process it. This is the part that proves the schema and the queries agree.
    const queued = await prisma.aIEvalRun.create({
      data: { datasetId: dataset.id, model: "probe-model", itemCount: 1, status: "QUEUED" }
    });
    const { ranId } = await processNextEvalRun();
    check("the worker picked up the queued run", ranId === queued.id, ranId ?? "none");

    const after = await prisma.aIEvalRun.findUnique({ where: { id: queued.id } });
    check("it finished in a terminal state, not stuck QUEUED", after?.status === "FAILED", after?.status ?? "missing");
    check("it recorded why", Boolean(after?.error), after?.error ?? "");
    check("it stamped a finish time", after?.finishedAt != null);
    check("it spent nothing", (await prisma.aIEvalResult.count({ where: { runId: queued.id } })) === 0);

    // A second tick must find nothing — otherwise a failed run would be retried forever, paying
    // for the same failure every minute.
    check("a second tick finds nothing to do", (await processNextEvalRun()).ranId === null);
  } finally {
    if (datasetId) {
      // Cascades to items, runs and results — all of them rows this script created.
      await prisma.aIDataset.delete({ where: { id: datasetId } }).catch((error) => {
        console.error(`  CLEANUP FAILED — remove AIDataset ${datasetId} by hand: ${(error as Error).message}`);
        failures++;
      });
    }
  }
}

async function main() {
  await runForEveryOrg("verify-eval-runner", async () => {
    console.log(`\n[${requireTenantContext().orgSlug}]`);
    await run();
  });

  console.log(failures === 0 ? "\nAll eval runner checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
